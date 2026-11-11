'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');

const ENDPOINTS=Object.freeze({stateful:12847,terminal:12848,browser:8931,proxy:8940,autosend:8972,messaging:8971});
function assertTunnelId(id) {
  if(typeof id!=='string'||!/^tunnel_[a-z0-9_]{3,128}$/.test(id))throw Error('INVALID_TUNNEL_ID');
  return id;
}
function runtimePaths(resourceRoot,userData) {
  return {
    terminal:path.join(resourceRoot,'terminal','stateless_server.js'),
    stateful:path.join(resourceRoot,'terminal','server.js'),
    ptyModule:path.join(resourceRoot,'pty','node_modules','@lydell','node-pty'),
    python:path.join(resourceRoot,'python','python.exe'),
    tunnelClient:path.join(resourceRoot,'tunnel','tunnel-client.exe'),
    autosend:path.join(resourceRoot,'autosend','server.mjs'),
    messaging:path.join(resourceRoot,'messaging','hub.py'),
    browser:path.join(resourceRoot,'playwright','node_modules','@playwright','mcp','cli.js'),
    proxy:path.join(resourceRoot,'playwright','restricted-proxy.mjs'),
    config:path.join(userData,'terminal','stateless-config.json'),
    tunnels:path.join(userData,'tunnels'),
    artifacts:path.join(userData,'browser-artifacts')
  };
}
function terminalEndpoint(configPath) {
  const value=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if(!/^exec\/[a-f0-9]{64}$/.test(value.mcpPath))throw Error('INVALID_LOCAL_MCP_CONFIG');
  return 'http://127.0.0.1:12848/'+value.mcpPath;
}
function clientArgs({tunnelId,url,config,healthFile}) {
  assertTunnelId(tunnelId);
  if(!/^http:\/\/127\.0\.0\.1:(12848|8940)\/(?:mcp|exec\/[a-f0-9]{64})$/.test(url))
    throw Error('INVALID_LOCAL_MCP_URL');
  return ['run','--config',config,'--control-plane.tunnel-id',tunnelId,
    '--control-plane.api-key','env:CONTROL_PLANE_API_KEY',
    '--mcp.server-url',url,'--health.listen-addr','127.0.0.1:0',
    '--health.url-file',healthFile];
}
function listening(port,timeout=900) {
  return new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    const done=value=>{socket.destroy();resolve(value)};
    socket.once('connect',()=>done(true));
    socket.once('error',()=>done(false));
    socket.setTimeout(timeout,()=>done(false));
  });
}
function killOwnedTree(pid) {
  if(!Number.isInteger(pid)||pid<=0)return;
  if(process.platform==='win32')
    spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'});
  else {try{process.kill(-pid,'SIGTERM')}catch{}}
}
class Runtime {
  constructor({resourceRoot,userData,nodeExecutable,credentials,onChange=()=>{},browser='chrome'}) {
    this.paths=runtimePaths(resourceRoot,userData);
    this.resourceRoot=resourceRoot;
    this.userData=userData;
    this.nodeExecutable=nodeExecutable;
    this.credentials=credentials;
    this.onChange=onChange;
    this.browser=browser==='msedge'?'msedge':'chrome';
    this.entries=new Map();
    this.running=false;
    this.generation=0;
  }
  report() {
    const state={};
    for(const name of ['terminal','stateful','browser','proxy','autosend','messaging','terminalTunnel','browserTunnel']){
      const item=this.entries.get(name);
      state[name]=item?.state||'stopped';
    }
    this.onChange(state);
    return state;
  }
  state(){const snapshot={};for(const name of ['terminal','stateful','browser','proxy','autosend','messaging','terminalTunnel','browserTunnel']){
    snapshot[name]=this.entries.get(name)?.state||'stopped';
  }return snapshot}
  node(script,args=[],env={}) {
    return {file:this.nodeExecutable,args:[script,...args],cwd:path.dirname(script),
      env:{...process.env,...env,ELECTRON_RUN_AS_NODE:'1'}};
  }
  async plan(name){
    const p=this.paths;
    if(name==='terminal')return this.node(p.terminal,[],{
      MCPGO_ONESHOT_CONFIG:p.config,MCPGO_JOB_ROOT:path.join(this.userData,'OneShotJobs'),
      MCPGO_TERMINAL_CONFIG:path.join(this.userData,'terminal','config.json'),MCPGO_ENABLE_STATEFUL:'1',MCPGO_ENABLE_FILES:'1'});
    if(name==='stateful')return this.node(p.stateful,[],{
      MCPGO_TERMINAL_CONFIG:path.join(this.userData,'terminal','config.json'),
      MCPGO_JOB_ROOT:path.join(this.userData,'OneShotJobs'),MCPGO_NODE_PTY_MODULE:p.ptyModule});
    if(name==='autosend')return this.node(p.autosend,[],{
      MCPHUB_AUTOSEND_STATE:path.join(this.userData,'AutoSend','tasks.json')});
    if(name==='messaging')return {file:p.python,args:[p.messaging,'serve'],cwd:path.dirname(p.messaging),
      env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',MCPHUB_MESSAGE_DB:path.join(this.userData,'Messaging','messages.sqlite3')}};
    if(name==='browser'){
      if(!fs.existsSync(p.browser))throw Error('PLAYWRIGHT_DEPENDENCIES_MISSING');
      fs.mkdirSync(p.artifacts,{recursive:true});
      return this.node(p.browser,['--host','127.0.0.1','--port','8931',
        '--extension','--browser',this.browser,'--shared-browser-context',
        '--caps','vision,devtools','--block-service-workers','--no-webmcp',
        '--output-dir',p.artifacts,'--timeout-navigation','45000'],{PLAYWRIGHT_MCP_REJECT_UNSAFE:'1'});
    }
    if(name==='proxy')return this.node(p.proxy,['shared']);
    if(name==='terminalTunnel'||name==='browserTunnel'){
      const target=name==='terminalTunnel'?'terminal':'browser';
      const cred=await this.credentials(target);
      if(!cred?.id||!cred?.key) return null;
      const url=target==='terminal'?terminalEndpoint(p.config):'http://127.0.0.1:8940/mcp';
      fs.mkdirSync(p.tunnels,{recursive:true});
      const prefix=path.join(p.tunnels,target);
      const cfg=prefix+'.yaml',health=prefix+'-health.url';
      if(!fs.existsSync(cfg))fs.writeFileSync(cfg,'{}\n',{flag:'wx',mode:0o600});
      try{fs.unlinkSync(health)}catch(e){if(e.code!=='ENOENT')throw e}
      return {file:process.env.MCPGO_TUNNEL_CLIENT||p.tunnelClient,
        args:clientArgs({tunnelId:cred.id,url,config:cfg,healthFile:health}),
        env:{...process.env,CONTROL_PLANE_API_KEY:cred.key},cwd:this.userData};
    }
    throw Error('UNKNOWN_SERVICE');
  }
  async launch(name){
    if(!this.running)return;
    const old=this.entries.get(name);
    if(old?.child)return;
    if(old?.timer)clearTimeout(old.timer);
    const record={state:'starting',attempts:old?.attempts||0,child:null,timer:null};
    this.entries.set(name,record);
    let p;
    try {
      p=await this.plan(name);
      if(!this.running||this.entries.get(name)!==record)return;
      if(!p){record.state='unconfigured';this.report();return}
    }catch(e){
      record.state=e.message==='ENOENT'?'waiting':'error: '+e.message;
      this.schedule(name,record);return;
    }
    try{
      const child=spawn(p.file,p.args,{cwd:p.cwd,env:p.env,windowsHide:true,detached:true,
        stdio:['ignore','ignore','pipe']});
      record.child=child;
      child.stderr.on('data',()=>{}); // do not log tunnel credentials or private output
      child.once('spawn',()=>{if(this.entries.get(name)!==record)return;
        record.state='running';record.startedAt=Date.now();this.report()});
      child.once('error',e=>{if(this.entries.get(name)!==record)return;
        record.state='error: '+(e.code||'SPAWN_FAILED');record.child=null;
        this.schedule(name,record)});
      child.once('exit',(code)=>{if(this.entries.get(name)!==record)return;
        record.child=null;record.state='exited: '+String(code);
        if(Date.now()-(record.startedAt||Date.now())>30000)record.attempts=0;
        this.schedule(name,record)});
    }catch(e){record.state='error: '+e.message;this.schedule(name,record)}
    this.report();
  }
  schedule(name,record){
    if(!this.running||this.entries.get(name)!==record||record.timer)return;
    const wait=Math.min(60000,1500*2**Math.min(record.attempts++,5));
    record.timer=setTimeout(()=>this.launch(name),wait);
    this.report();
  }
  async start(){
    if(this.running)return;
    this.running=true;
    const generation=++this.generation;
    fs.mkdirSync(this.userData,{recursive:true});
    await Promise.all(['stateful','terminal','browser','proxy','autosend','messaging'].map(name=>this.launch(name)));
    // Wait for the real local listeners, not just a spawned process.
    const pump=async()=>{
      if(!this.running||generation!==this.generation)return;
      const [t,pty]=await Promise.all([listening(ENDPOINTS.terminal),listening(ENDPOINTS.stateful)]);
      const b=await listening(ENDPOINTS.proxy);
      if(!this.running||generation!==this.generation)return;
      if(t&&pty&&this.entries.get('terminal')?.child?.exitCode===null &&
         !this.entries.get('terminalTunnel')?.child && !this.entries.get('terminalTunnel')?.timer)
        this.launch('terminalTunnel');
      if(b&&this.entries.get('proxy')?.child?.exitCode===null &&
         this.entries.get('browser')?.child?.exitCode===null &&
         !this.entries.get('browserTunnel')?.child && !this.entries.get('browserTunnel')?.timer)
        this.launch('browserTunnel');
      this.healthTimer=setTimeout(pump,2500);
    };
    await pump();
  }
  restart(){
    this.stop();
    return this.start();
  }
  stop(){
    this.running=false;
    this.generation=(this.generation||0)+1;
    if(this.healthTimer)clearTimeout(this.healthTimer);
    for(const item of this.entries.values()){
      if(item.timer)clearTimeout(item.timer);
      if(item.child&&item.child.exitCode===null)killOwnedTree(item.child.pid);
    }
    this.entries.clear();
    this.report();
  }
}
module.exports={Runtime,assertTunnelId,clientArgs,terminalEndpoint,runtimePaths,listening,killOwnedTree};
