'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {record:diag,register,scrub}=require('./diagnostics.cjs');
const sourceHealth=path.resolve(__dirname,'../../dashboard/connection-health.cjs');
const connectionHealth=require(fs.existsSync(sourceHealth)?sourceHealth:path.join(process.resourcesPath,'mcpgo-runtime/dashboard/connection-health.cjs'));

const ENDPOINTS=Object.freeze({terminal:12848,browser:8931,autosendBrowser:8932,proxy:8940,autosend:8972,messaging:8971});
const CORE_SERVICES=Object.freeze(['terminal','browser','proxy','autosendBrowser','autosend','messaging']);
function snapshotMode(role,env=process.env){
  const mode=env[role==='autosendBrowser'?'MCPGO_AUTOSEND_SNAPSHOT_MODE':'MCPGO_BROWSER_SNAPSHOT_MODE']??'full';
  if(!['full','none'].includes(mode))throw Error('Invalid Playwright snapshot mode');
  return mode;
}
function settleTimeout(role,env=process.env){
  const val=Number(env[role==='autosendBrowser'?'MCPGO_AUTOSEND_SETTLE_MS':'MCPGO_BROWSER_SETTLE_MS']??(role==='autosendBrowser'?500:200));
  if(!Number.isInteger(val)||val<0||val>2000)throw Error('Invalid Playwright settle timeout');
  return String(val);
}
function extensionProfile(browser,localAppData=process.env.LOCALAPPDATA){
  if(!localAppData)return null;
  const root=path.join(localAppData,...(browser==='msedge'?['Microsoft','Edge','User Data']:['Google','Chrome','User Data']));
  try{
    const profiles=fs.readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^(Default|Profile \d+)$/.test(d.name));
    const matches=profiles.filter(d=>{
      try{
        const ext=path.join(root,d.name,'Extensions','mmlmfjhmonkocbjadbfplnigmagldckm');
        return fs.lstatSync(ext).isDirectory()&&fs.readdirSync(ext,{withFileTypes:true}).some(v=>v.isDirectory()&&/^\d+\.\d+/.test(v.name));
      }catch{return false}
    });
    return matches.length===1?matches[0].name:null;
  }catch{return null}
}
function extensionProfileArgs(browser){
  const profile=extensionProfile(browser);
  return profile?['--profile-dir-name',profile]:[];
}
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
// Record fixed milestones only; never browser content, URLs or credentials.
function runBrowserProbe(plan,timeout=120000){
 return new Promise(resolve=>{
  const started=Date.now(),phases=new Set();
  let child,timer,tail='',done=false;
  const finish=(reason,code=null,signal=null)=>{
   if(done)return;done=true;clearTimeout(timer);
   resolve({ok:reason==='exit'&&code===0&&phases.has('MCP_CONNECTIVITY_PROBE=PASS'),
    reason,code,signal,phases:[...phases],durationMs:Date.now()-started});
  };
  try{child=spawn(plan.file,plan.args,{cwd:plan.cwd,env:plan.env,windowsHide:true,stdio:['ignore','pipe','ignore']})}
  catch{return finish('spawn')}
  const parse=line=>{
   if(/^(MCP_2026_DISCOVER|PRIVATE_PLAYWRIGHT_INITIALIZE|TOOL_DISCOVERY|UNSAFE_TOOL_FILTER|CHROME_CDP_TABS|MCP_CONNECTIVITY_PROBE)=PASS$/.test(line))phases.add(line);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
   const lines=(tail+chunk).split(/\r?\n/);
   tail=(lines.pop()||'').slice(-128);
   for(const line of lines)parse(line);
  });
  timer=setTimeout(()=>{finish('timeout');child.kill()},timeout);
  child.once('error',()=>finish('spawn'));
  child.once('close',(code,signal)=>{parse(tail);finish('exit',code,signal)});
 });
}
const mcpReady=connectionHealth.probeMcp;
async function tunnelReady(file,fetchImpl=fetch){
  return (await connectionHealth.tunnelHealth(file,fetchImpl))==='ready';
}
function killOwnedTree(pid) {
  if(!Number.isInteger(pid)||pid<=0)return;
  if(process.platform==='win32')
    spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'});
  else {try{process.kill(-pid,'SIGTERM')}catch{}}
}
class Runtime {
  constructor({resourceRoot,userData,nodeExecutable,credentials,onChange=()=>{},browser='chrome',portProbe=listening}) {
    this.paths=runtimePaths(resourceRoot,userData);
    this.resourceRoot=resourceRoot;
    this.userData=userData;
    this.nodeExecutable=nodeExecutable;
    this.credentials=credentials;
    this.portProbe=portProbe;
    this.onChange=onChange;
    this.browser=browser==='msedge'?'msedge':'chrome';
    this.entries=new Map();
    this.running=false;
    this.generation=0;
    this.lastDiagnosticState='';
    this.readiness={terminalMcp:false,browserMcp:false,terminalTunnel:false,browserTunnel:false,chrome:null};
    this.browserProbePid=null;
    this.browserProbe=null;
    this.healthEvidence=null;
    this.browserVerificationFailure=null;
    this.healthHistory=new connectionHealth.HealthHistory(path.join(userData,'connection-health-history.json'));
    this.recoveryBudget={};
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
  connectionState(){
    const e=this.healthEvidence||{},now=Date.now(),running=name=>this.entries.get(name)?.child?.exitCode===null;
    const key=['terminal','terminalTunnel','browser','proxy','browserTunnel'].map(n=>this.entries.get(n)?.child?.pid||0).join(':');
    const data=e.key===key?e:{};
    const browserPid=this.entries.get('browser')?.child?.pid;
    const failure=this.browserVerificationFailure;
    const failureAt=Number.isInteger(browserPid)&&browserPid>0&&failure?.pid===browserPid?failure.at:null;
    return {
      terminal:connectionHealth.evaluate({running:running('terminal')&&running('terminalTunnel'),mcp:data.t,tunnel:data.tt,checkedAt:data.checkedAt,lastCallAt:data.th?.lastSuccessfulCallAt},now),
      browser:connectionHealth.evaluate({running:running('browser')&&running('proxy')&&running('browserTunnel'),mcp:data.b,tunnel:data.bt,checkedAt:data.checkedAt,browser:connectionHealth.browserEvidence(data.bh,now,failureAt)},now)
    };
  }
  readinessState(){
    const h=this.connectionState();
    return {...this.readiness,terminalMcp:h.terminal.mcp,terminalTunnel:h.terminal.tunnel==='ready',
      browserMcp:h.browser.mcp,browserTunnel:h.browser.tunnel==='ready',
      chrome:h.browser.browser==='ready'?true:h.browser.browser==='failed'?false:null,
      connectionHealth:h,history:this.healthHistory.snapshot()};
  }
  state(){const snapshot={};for(const name of ['terminal','browser','proxy','autosendBrowser','autosend','messaging','terminalTunnel','browserTunnel']){
    snapshot[name]=this.entries.get(name)?.state||'stopped';
  }return snapshot}
  node(script,args=[],env={}) {
    return {file:this.nodeExecutable,args:[script,...args],cwd:path.dirname(script),
      env:{...process.env,...env,ELECTRON_RUN_AS_NODE:'1'}};
  }
  async verifyBrowserConnection(force=false){
    if(this.browserProbe)return this.browserProbe;
    const generation=this.generation;
    const task=(async()=>{
      // The wizard may verify immediately after saving/restarting, before the
      // first health pump has observed both browser and proxy listeners.
      if(force){
        const until=Date.now()+15000;
        while(this.running&&generation===this.generation&&Date.now()<until&&
          (!this.entries.get('browser')?.child?.pid||!this.readiness.browserMcp))
          await new Promise(resolve=>setTimeout(resolve,200));
      }
      const pid=this.entries.get('browser')?.child?.pid;
      if(generation!==this.generation||!pid||!this.readiness.browserMcp){
        diag(this.userData,'windows.runtime.extension.probe.deferred',{reason:'LOCAL_MCP_NOT_READY'});
        return false;
      }
      if(!force&&this.browserProbePid===pid&&this.readiness.chrome===true)return true;
      this.browserProbePid=pid;
      const probe=path.join(this.resourceRoot,'playwright','probe.mjs');
      const plan=this.node(probe,[],{PLAYWRIGHT_MCP_URL:'http://127.0.0.1:8940/mcp',
        PLAYWRIGHT_MCP_PRIVATE_BACKEND:'0',PLAYWRIGHT_MCP_VERIFY_TABS:'1',PLAYWRIGHT_MCP_REJECT_UNSAFE:'1'});
      delete plan.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
      const evidence=await runBrowserProbe(plan);
      const ok=evidence.ok;
      diag(this.userData,'windows.runtime.extension.probe',evidence);
      if(generation===this.generation&&this.entries.get('browser')?.child?.pid===pid){
        const bh=await connectionHealth.readTelemetry('http://127.0.0.1:8940/healthz');
        if(generation===this.generation&&this.entries.get('browser')?.child?.pid===pid){
          if(this.healthEvidence)this.healthEvidence.bh=bh;
          this.browserVerificationFailure=ok?null:{pid,at:Date.now()};
          this.readiness.chrome=ok;diag(this.userData,'windows.runtime.extension.readiness',{ready:ok});this.report();
        }
      }
      return ok&&generation===this.generation&&this.entries.get('browser')?.child?.pid===pid;
    })();
    this.browserProbe=task;
    try{return await task}finally{if(this.browserProbe===task)this.browserProbe=null}
  }
  async verifyExtension(token,browser=this.browser){
    if(typeof token!=='string'||!/^[^\s\x00-\x1f]{16,2048}$/.test(token))
      throw Error('INVALID_EXTENSION_TOKEN');
    if(!['chrome','msedge'].includes(browser))throw Error('INVALID_BROWSER');
    const probe=path.join(this.resourceRoot,'playwright','probe.mjs');
    if(!fs.existsSync(this.paths.browser)||!fs.existsSync(probe))throw Error('PLAYWRIGHT_DEPENDENCIES_MISSING');
    if(await listening(8999))throw Error('EXTENSION_TRIAL_PORT_BUSY');
    register({token});
    const plan=this.node(this.paths.browser,['--host','127.0.0.1','--port','8999',
      '--extension','--background','--browser',browser,...extensionProfileArgs(browser),'--caps','vision,devtools',
      '--block-service-workers','--no-webmcp'],{
      PLAYWRIGHT_MCP_EXTENSION_TOKEN:token,PLAYWRIGHT_MCP_SESSION_NAME:'MCPGO Setup',
      PLAYWRIGHT_MCP_PING_TIMEOUT_MS:'0'});
    const trial=spawn(plan.file,plan.args,{cwd:plan.cwd,env:plan.env,windowsHide:true,stdio:'ignore'});
    let failed=false;
    trial.once('error',()=>{failed=true});
    try{
      const end=Date.now()+15000;
      let ready=false;
      while(!failed&&trial.exitCode===null&&Date.now()<end){
        if(await listening(8999,250)){ready=true;break}
        await new Promise(r=>setTimeout(r,150));
      }
      if(!ready||failed||trial.exitCode!==null)throw Error('EXTENSION_TRIAL_START_FAILED');
      const check=this.node(probe,[],{PLAYWRIGHT_MCP_URL:'http://127.0.0.1:8999/mcp',
        PLAYWRIGHT_MCP_PRIVATE_BACKEND:'1',PLAYWRIGHT_MCP_VERIFY_TABS:'1',PLAYWRIGHT_MCP_REJECT_UNSAFE:'0'});
      delete check.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
      const evidence=await runBrowserProbe(check);
      diag(this.userData,'windows.extension.trial.probe',{browser,...evidence,trialExitCode:trial.exitCode,trialFailed:failed});
      if(!evidence.ok||failed||trial.exitCode!==null)throw Error('EXTENSION_TRIAL_REJECTED');
      diag(this.userData,'windows.extension.trial.verified',{browser});
      return true;
    }finally{if(trial.exitCode===null)trial.kill()}
  }
  async extensionCredential(){
    let extension;
    try {extension=await this.credentials('playwrightExtension')}
    catch(e){
      const code=['SECURE_STORAGE_UNAVAILABLE','INVALID_ENCRYPTED_EXTENSION_TOKEN'].includes(e?.message)?e.message:'EXTENSION_CONFIG_UNREADABLE';
      throw Error(code);
    }
    if(!extension?.token)return null;
    if(typeof extension.token!=='string'||!/^[^\s\x00-\x1f]{16,2048}$/.test(extension.token))
      throw Error('INVALID_ENCRYPTED_EXTENSION_TOKEN');
    return extension;
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
      const extension=await this.extensionCredential();
      if(!extension?.token)return null;
      fs.mkdirSync(path.join(p.artifacts,'autosend'),{recursive:true});
      return this.node(p.browser,['--host','127.0.0.1','--port','8932',
        '--extension','--background','--browser',this.browser,...extensionProfileArgs(this.browser),'--shared-browser-context',
        '--caps','devtools','--block-service-workers','--no-webmcp',
        '--output-dir',path.join(p.artifacts,'autosend'),'--timeout-navigation','45000',
        '--timeout-settle',settleTimeout('autosendBrowser'),
        '--snapshot-mode',snapshotMode('autosendBrowser')],
        {PLAYWRIGHT_MCP_REJECT_UNSAFE:'1',PLAYWRIGHT_MCP_SESSION_NAME:'MCPGO AutoSend',
         PLAYWRIGHT_MCP_SESSION_COLOR:'blue',PLAYWRIGHT_MCP_EXTENSION_TOKEN:extension.token,
         PLAYWRIGHT_MCP_PING_TIMEOUT_MS:process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS??'0'});
    }
    if(name==='browser'){
      if(!fs.existsSync(p.browser))throw Error('PLAYWRIGHT_DEPENDENCIES_MISSING');
      const extension=await this.extensionCredential();
      if(!extension?.token)return null;
      fs.mkdirSync(p.artifacts,{recursive:true});
      return this.node(p.browser,['--host','127.0.0.1','--port','8931',
        '--extension','--background','--browser',this.browser,...extensionProfileArgs(this.browser),'--shared-browser-context',
        '--caps','vision,devtools','--block-service-workers','--no-webmcp',
        '--output-dir',p.artifacts,'--timeout-navigation','45000',
        '--timeout-settle',settleTimeout('browser'),
        '--snapshot-mode',snapshotMode('browser')],{PLAYWRIGHT_MCP_REJECT_UNSAFE:'1',
        PLAYWRIGHT_MCP_SESSION_NAME:'MCPGO',PLAYWRIGHT_MCP_SESSION_COLOR:'purple',
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
      if(ENDPOINTS[name]&&await this.portProbe(ENDPOINTS[name],350)){
        if(!this.running||this.entries.get(name)!==record)return;
        record.state='error: PORT_OCCUPIED';
        diag(this.userData,'windows.runtime.port.conflict',{service:name,port:ENDPOINTS[name]});
        this.report();return;
      }
      if(!this.running||this.entries.get(name)!==record)return;
    }catch(e){
      diag(this.userData,'windows.runtime.plan.failure',{service:name,error:e.message,stack:e.stack});
      record.state=e.message==='ENOENT'?'waiting':'error: '+e.message;
      if(['browser','autosendBrowser'].includes(name)&&['SECURE_STORAGE_UNAVAILABLE','INVALID_ENCRYPTED_EXTENSION_TOKEN','EXTENSION_CONFIG_UNREADABLE'].includes(e.message)){
        this.report();return;
      }
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
  async recoverTunnel(name,{manual=false}={}){
    if(!['terminalTunnel','browserTunnel'].includes(name)||!this.running)return false;
    const record=this.entries.get(name);
    if(!record?.child||record.child.exitCode!==null)return false;
    const pid=record.child.pid,e=this.healthEvidence||{};
    const local=name==='terminalTunnel'?e.t:e.b,health=name==='terminalTunnel'?e.tt:e.bt;
    const key=['terminal','terminalTunnel','browser','proxy','browserTunnel'].map(n=>this.entries.get(n)?.child?.pid||0).join(':');
    if(e.key!==key||!local||!connectionHealth.fresh(e.checkedAt,Date.now())||health==='auth'||health==='throttled')return false;
    if(!manual&&health!=='down')return false;
    const telemetry=await connectionHealth.readTelemetry(name==='terminalTunnel'?'http://127.0.0.1:12848/health':'http://127.0.0.1:8940/healthz');
    const busy=name==='terminalTunnel'?(telemetry?.active!==0||telemetry?.interactive_sessions!==0):
      (!telemetry?.browserQueue||telemetry.browserQueue.active||telemetry.browserQueue.waiting>0);
    if(busy)return false;
    if(this.entries.get(name)!==record||record.child?.pid!==pid)return false;
    diag(this.userData,'windows.runtime.tunnel.recover',{service:name,manual});
    killOwnedTree(pid);return true;
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
      const active=name=>this.entries.get(name)?.child?.exitCode===null;
      let terminalUrl;
      try{terminalUrl=terminalEndpoint(this.paths.config)}catch{}
      const key=['terminal','terminalTunnel','browser','proxy','browserTunnel'].map(n=>this.entries.get(n)?.child?.pid||0).join(':');
      const [t,b,tt,bt,th,bh]=await Promise.all([
        active('terminal')&&terminalUrl?mcpReady(terminalUrl,['terminal_exec']):false,
        active('browser')&&active('proxy')?mcpReady('http://127.0.0.1:8940/mcp',['browser_tabs','browser_snapshot']):false,
        active('terminalTunnel')?connectionHealth.tunnelHealth(path.join(this.paths.tunnels,'terminal-health.url')):'down',
        active('browserTunnel')?connectionHealth.tunnelHealth(path.join(this.paths.tunnels,'browser-health.url')):'down',
        active('terminal')?connectionHealth.readTelemetry('http://127.0.0.1:12848/health'):null,
        active('proxy')?connectionHealth.readTelemetry('http://127.0.0.1:8940/healthz'):null
      ]);
      if(!this.running||generation!==this.generation)return;
      this.healthEvidence={key,checkedAt:Date.now(),t,b,tt,bt,th,bh};
      const chrome=connectionHealth.browserEvidence(bh);
      const next={terminalMcp:t===true,browserMcp:b===true,terminalTunnel:tt==='ready',browserTunnel:bt==='ready',chrome:chrome.state==='ready'?true:chrome.state==='failed'?false:null};
      const health=this.connectionState();
      for(const [channel,value] of Object.entries(health))this.healthHistory.observe(channel,value);
      for(const [name,local,status] of [['terminalTunnel',t,tt],['browserTunnel',b,bt]]){
        const budget=this.recoveryBudget[name]??={failures:0,attempts:[],next:0,successes:0};
        if(status==='ready'){budget.failures=0;if(++budget.successes>=2){budget.attempts=[];budget.next=0}}
        else if(status==='down'&&local&&active(name)){
          budget.successes=0;budget.failures++;const now=Date.now();budget.attempts=budget.attempts.filter(at=>now-at<3600000);
          if(budget.failures>=3&&budget.attempts.length<3&&now>=budget.next){
            if(await this.recoverTunnel(name)){budget.attempts.push(now);budget.next=now+60000*budget.attempts.length;budget.failures=0}
          }
        }else {budget.failures=0;budget.successes=0}
      }
      if(JSON.stringify(next)!==JSON.stringify(this.readiness)){
        this.readiness=next;diag(this.userData,'windows.runtime.readiness',next);this.report();
      }
      if(t&&this.entries.get('terminal')?.child?.exitCode===null &&
         !this.entries.get('terminalTunnel')?.child && !this.entries.get('terminalTunnel')?.timer)
        this.launch('terminalTunnel');
      if(b&&this.entries.get('proxy')?.child?.exitCode===null &&
         this.entries.get('browser')?.child?.exitCode===null &&
         !this.entries.get('browserTunnel')?.child && !this.entries.get('browserTunnel')?.timer)
        this.launch('browserTunnel');
      // Passive monitoring: no periodic tab creation or session reset.
      this.report();
      if(this.running&&generation===this.generation)this.healthTimer=setTimeout(pump,5000);
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
    this.healthEvidence=null;
    this.browserVerificationFailure=null;
    this.recoveryBudget={};
    this.readiness={terminalMcp:false,browserMcp:false,terminalTunnel:false,browserTunnel:false,chrome:null};
    this.browserProbePid=null;
    this.browserProbe=null;
    this.report();
  }
}
module.exports={runBrowserProbe,mcpReady,tunnelReady,extensionProfile,Runtime,assertTunnelId,clientArgs,terminalEndpoint,runtimePaths,listening,killOwnedTree,CORE_SERVICES};
