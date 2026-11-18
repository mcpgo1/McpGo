'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {record:diag,register,scrub}=require('./diagnostics.cjs');

const ENDPOINTS=Object.freeze({terminal:12848,browser:8931,proxy:8940,autosend:8972,messaging:8971});
const CORE_SERVICES=Object.freeze(['terminal','browser','proxy','autosendBrowser','autosend','messaging']);
function assertTunnelId(id) {
  if(typeof id!=='string'||!/^tunnel_[a-z0-9_]{3,128}$/.test(id))throw Error('INVALID_TUNNEL_ID');
  return id;
}
function runtimePaths(resourceRoot,userData) {
  return {
    terminal:path.join(resourceRoot,'terminal','stateless_server.js'),
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
    this.lastDiagnosticState='';
  }
  report() {
    const state={};
    for(const name of ['terminal','browser','proxy','autosendBrowser','autosend','messaging','terminalTunnel','browserTunnel']){
      const item=this.entries.get(name);
      state[name]=item?.state||'stopped';
    }
    const serialized=JSON.stringify(state);
    if(serialized!==this.lastDiagnosticState){
      diag(this.userData,'windows.runtime.state',{state});this.lastDiagnosticState=serialized;
    }
    this.onChange(state);
    return state;
  }
  state(){const snapshot={};for(const name of ['terminal','browser','proxy','autosendBrowser','autosend','messaging','terminalTunnel','browserTunnel']){
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
      MCPGO_TERMINAL_CONFIG:path.join(this.userData,'terminal','config.json'),MCPGO_NODE_PTY_MODULE:p.ptyModule,MCPGO_ENABLE_FILES:'1'});
    if(name==='autosend')return this.node(p.autosend,[],{
      MCPHUB_AUTOSEND_STATE:path.join(this.userData,'AutoSend','tasks.json')});
    if(name==='messaging')return {file:p.python,args:[p.messaging,'serve'],cwd:path.dirname(p.messaging),
      env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',MCPHUB_MESSAGE_DB:path.join(this.userData,'Messaging','messages.sqlite3')}};
    if(name==='autosendBrowser'){
      if(!fs.existsSync(p.browser))throw Error('PLAYWRIGHT_DEPENDENCIES_MISSING');
      const extension=await this.credentials('playwrightExtension');
      if(!extension?.token)return null;
      fs.mkdirSync(path.join(p.artifacts,'autosend'),{recursive:true});
      return this.node(p.browser,['--host','127.0.0.1','--port','8932',
        '--extension','--background','--browser',this.browser,'--shared-browser-context',
        '--caps','devtools','--block-service-workers','--no-webmcp',
        '--output-dir',path.join(p.artifacts,'autosend'),'--timeout-navigation','45000'],
        {PLAYWRIGHT_MCP_REJECT_UNSAFE:'1',PLAYWRIGHT_MCP_SESSION_NAME:'MCPGO AutoSend',
         PLAYWRIGHT_MCP_SESSION_COLOR:'blue',PLAYWRIGHT_MCP_EXTENSION_TOKEN:extension.token,
         PLAYWRIGHT_MCP_PING_TIMEOUT_MS:process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS??'0'});
    }
    if(name==='browser'){
      if(!fs.existsSync(p.browser))throw Error('PLAYWRIGHT_DEPENDENCIES_MISSING');
      const extension=await this.credentials('playwrightExtension');
      if(!extension?.token)return null;
      fs.mkdirSync(p.artifacts,{recursive:true});
      return this.node(p.browser,['--host','127.0.0.1','--port','8931',
        '--extension','--background','--browser',this.browser,'--shared-browser-context',
        '--caps','vision,devtools','--block-service-workers','--no-webmcp',
        '--output-dir',p.artifacts,'--timeout-navigation','45000'],{PLAYWRIGHT_MCP_REJECT_UNSAFE:'1',
        PLAYWRIGHT_MCP_EXTENSION_TOKEN:extension.token,
        PLAYWRIGHT_MCP_PING_TIMEOUT_MS:process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS??'0'});
    }
    if(name==='proxy')return this.node(p.proxy,['shared'],{MCPGO_ACTION_ROOT:path.join(this.userData,'BrowserActions')});
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
      diag(this.userData,'windows.runtime.plan.requested',{service:name,attempt:record.attempts});
      p=await this.plan(name);
      if(!this.running||this.entries.get(name)!==record)return;
      if(!p){record.state='unconfigured';diag(this.userData,'windows.runtime.unconfigured',{service:name});this.report();return}
    }catch(e){
      diag(this.userData,'windows.runtime.plan.failure',{service:name,error:e.message,stack:e.stack});
      record.state=e.message==='ENOENT'?'waiting':'error: '+e.message;
      this.schedule(name,record);return;
    }
    try{
      register(p.env); // Keep plaintext credentials in memory for redaction only.
      diag(this.userData,'windows.runtime.process.launch',{service:name,file:p.file,args:p.args,cwd:p.cwd,
        envNames:Object.keys(p.env||{}).filter(k=>/^MCPGO_|^CONTROL_|^PLAYWRIGHT_/i.test(k))});
      const child=spawn(p.file,p.args,{cwd:p.cwd,env:p.env,windowsHide:true,detached:true,
        stdio:['ignore','pipe','pipe']});
      record.child=child;
      // Decode complete UTF-8 lines before redaction: credential strings may
      // span operating-system stream chunks. Persist every complete line now,
      // not only when a long-running service eventually exits.
      let stdoutBytes=0,stderrBytes=0;
      const capture=(stream,kind)=>{
        let pending='',discardingOversizedLine=false,discarded=0;
        stream.setEncoding('utf8');
        stream.on('data',chunk=>{
          const bytes=Buffer.byteLength(chunk);
          if(kind==='stdout')stdoutBytes+=bytes;else stderrBytes+=bytes;
          for(const segment of chunk.split(/(?<=\n)/)){
            if(discardingOversizedLine){
              discarded+=Buffer.byteLength(segment);
              if(segment.endsWith('\n')){
                diag(this.userData,'windows.runtime.process.line.truncated',{
                  service:name,stream:kind,droppedBytes:discarded});
                discardingOversizedLine=false;discarded=0;
              }
              continue;
            }
            pending+=segment;
            if(pending.length>524288){
              // Never emit a fragment of an unbounded line: a token could be
              // split at that boundary and defeat key redaction.
              discarded=Buffer.byteLength(pending);
              const lineEnded=pending.endsWith('\n');
              pending='';discardingOversizedLine=!lineEnded;
              if(lineEnded){
                diag(this.userData,'windows.runtime.process.line.truncated',{
                  service:name,stream:kind,droppedBytes:discarded});
                discarded=0;
              }
              continue;
            }
            if(pending.endsWith('\n')){
              diag(this.userData,'windows.runtime.process.line',{
                service:name,stream:kind,text:scrub(pending)});
              pending='';
            }
          }
        });
        return reason=>{
          if(pending)diag(this.userData,'windows.runtime.process.line',{
            service:name,stream:kind,reason,text:scrub(pending)});
          if(discardingOversizedLine)diag(this.userData,'windows.runtime.process.line.truncated',{
            service:name,stream:kind,reason,droppedBytes:discarded});
        };
      };
      const flushStdout=capture(child.stdout,'stdout');
      const flushStderr=capture(child.stderr,'stderr');
      const flush=(reason)=>{
        flushStdout(reason);flushStderr(reason);
        diag(this.userData,'windows.runtime.process.output.summary',{
          service:name,reason,stdoutBytes,stderrBytes});
      };
      child.once('spawn',()=>{if(this.entries.get(name)!==record)return;
        record.state='running';record.startedAt=Date.now();
        diag(this.userData,'windows.runtime.process.started',{service:name,pid:child.pid});this.report()});
      child.once('error',e=>{if(this.entries.get(name)!==record)return;
        flush('spawn-error');diag(this.userData,'windows.runtime.process.error',{service:name,code:e.code,error:e.message});
        record.state='error: '+(e.code||'SPAWN_FAILED');record.child=null;
        this.schedule(name,record)});
      child.once('exit',(code,signal)=>{if(this.entries.get(name)!==record)return;
        flush('exit');diag(this.userData,'windows.runtime.process.exited',{service:name,code,signal});
        record.child=null;record.state='exited: '+String(code);
        if(Date.now()-(record.startedAt||Date.now())>30000)record.attempts=0;
        this.schedule(name,record)});
    }catch(e){diag(this.userData,'windows.runtime.process.exception',{service:name,error:e.message,stack:e.stack});
      record.state='error: '+e.message;this.schedule(name,record)}
    this.report();
  }
  schedule(name,record){
    if(!this.running||this.entries.get(name)!==record||record.timer)return;
    const wait=Math.min(60000,1500*2**Math.min(record.attempts++,5));
    diag(this.userData,'windows.runtime.retry.scheduled',{service:name,afterMs:wait,attempt:record.attempts});
    record.timer=setTimeout(()=>this.launch(name),wait);
    this.report();
  }
  async start(){
    diag(this.userData,'windows.runtime.start');
    if(this.running)return;
    this.running=true;
    const generation=++this.generation;
    fs.mkdirSync(this.userData,{recursive:true});
    await Promise.all(CORE_SERVICES.map(name=>this.launch(name)));
    // Wait for the real local listeners, not just a spawned process.
    const pump=async()=>{
      if(!this.running||generation!==this.generation)return;
      const t=await listening(ENDPOINTS.terminal);
      const b=await listening(ENDPOINTS.proxy);
      if(!this.running||generation!==this.generation)return;
      if(t&&this.entries.get('terminal')?.child?.exitCode===null &&
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
    diag(this.userData,'windows.runtime.stop');
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
module.exports={Runtime,assertTunnelId,clientArgs,terminalEndpoint,runtimePaths,listening,killOwnedTree,CORE_SERVICES};
