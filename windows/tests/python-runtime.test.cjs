'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..');
const enabled=process.platform==='win32'&&process.env.MCPGO_WINDOWS_RUNTIME_TEST==='1';
test('embedded Windows Python supports tunnel onboarding journal and SQLite agent hub',
 {skip:!enabled,timeout:60000},async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-win-python-'));
 const python=path.join(repo,'windows/vendor/python/python.exe');
 const tunnel=path.join(repo,'windows/vendor/tunnel/tunnel-client.exe');
 assert.ok(fs.existsSync(python));assert.ok(fs.existsSync(tunnel));
 const env={...process.env,MCPGO_USER_DATA:temp,MCPGO_RESOURCE_ROOT:repo,
  MCPGO_TUNNEL_CLIENT:tunnel,MCPHUB_MESSAGE_DB:path.join(temp,'Messaging','messages.sqlite3')};
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200}));
 const imported=spawnSync(python,[path.join(repo,'windows/onboarding_cli.py'),'import'],
  {env,cwd:repo,input:JSON.stringify({confirmed:true,terminalId:'tunnel_'+'a'.repeat(32),
   browserId:'tunnel_'+'b'.repeat(32)}),encoding:'utf8',windowsHide:true,timeout:12000});
 assert.equal(imported.status,0,JSON.stringify({stdout:imported.stdout,stderr:imported.stderr,error:imported.error?.message,signal:imported.signal}));
 const response=JSON.parse(imported.stdout);
 assert.equal(response.result.tunnels.terminal,'tunnel_'+'a'.repeat(32));
 assert.ok(fs.existsSync(path.join(temp,'Onboarding','state.json')));
 const processHub=spawn(python,[path.join(repo,'messaging','hub.py'),'serve'],{
  env,cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(processHub.pid)spawnSync('taskkill.exe',
  ['/PID',String(processHub.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000})});
 let ready=false;
 for(let i=0;i<60;i++){
  try{
   const r=await fetch('http://127.0.0.1:8971/api/status',
    {headers:{'X-MCPHub-Client':'native'}});
   if(r.ok){ready=true;break}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 assert.ok(ready,'SQLite hub did not start');
 const register=await fetch('http://127.0.0.1:8971/api/agents',{
  method:'POST',headers:{'X-MCPHub-Client':'native','Content-Type':'application/json'},
  body:JSON.stringify({id:'windowsci',label:'Windows CI',role:'agent'})});
 assert.equal(register.status,201);
 const responseAgents=await fetch('http://127.0.0.1:8971/api/agents',
  {headers:{'X-MCPHub-Client':'native'}});
 assert.equal(responseAgents.status,200);
 assert.ok((await responseAgents.json()).agents.some(x=>x.id==='windowsci'));
});
