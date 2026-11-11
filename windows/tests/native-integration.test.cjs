'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const enabled=process.platform==='win32'&&process.env.MCPGO_WINDOWS_RUNTIME_TEST==='1';
test('native Windows Node.exe + ConPTY + OneShot MCP + Files', {skip:!enabled,timeout:90000},async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-win-e2e-'));
 const node=path.join(root,'windows','vendor','node','node.exe');
 const pty=path.join(root,'windows','node_modules','@lydell','node-pty');
 for(const file of [node,path.join(pty,'index.js')])assert.ok(fs.existsSync(file),file);
 const termCfg=path.join(temp,'terminal','config.json');
 const oneshotCfg=path.join(temp,'terminal','stateless-config.json');
 const env={...process.env,MCPGO_TERMINAL_CONFIG:termCfg,MCPGO_ONESHOT_CONFIG:oneshotCfg,
  MCPGO_NODE_PTY_MODULE:pty,MCPGO_FILES_ROOTS:JSON.stringify([temp]),
  MCPGO_JOB_ROOT:path.join(temp,'jobs'),MCPGO_ENABLE_STATEFUL:'1',MCPGO_ENABLE_FILES:'1'};
 const processes=[];
 function start(filename){
  const child=spawn(node,[path.join(root,'terminal',filename)],{env,cwd:temp,
   windowsHide:true,stdio:['ignore','pipe','pipe']});
  processes.push(child);return child;
 }
 t.after(()=>{
  for(const child of processes){
   if(child.pid)spawnSync('taskkill.exe',['/T','/F','/PID',String(child.pid)],
    {windowsHide:true,stdio:'ignore',timeout:5000});
  }
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 });
 async function wait(port){
  const start=Date.now();
  while(Date.now()-start<15000){
   try{const response=await fetch('http://127.0.0.1:'+port+'/health');
    if(response.ok)return}catch{}
   await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error('SERVICE_START_TIMEOUT_'+port);
 }
 async function call(port,config,method,params={}){
  const cfg=JSON.parse(fs.readFileSync(config,'utf8'));
  const response=await fetch('http://127.0.0.1:'+port+'/'+cfg.mcpPath,{
   method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:10,method,params})});
  assert.equal(response.status,200);
  const payload=await response.json();
  if(payload.error)throw Error(JSON.stringify(payload.error));
  return payload.result;
 }
 start('server.js');await wait(12847);
 start('stateless_server.js');await wait(12848);
 const all=await call(12848,oneshotCfg,'tools/list');
 for(const name of ['terminal_create','terminal_send','files_read','terminal_exec'])
  assert.ok(all.tools.some(x=>x.name===name),name+' not exposed');
 const create=await call(12848,oneshotCfg,'tools/call',{
  name:'terminal_create',arguments:{name:'ci-terminal'}});
 const session=JSON.parse(create.content[0].text);
 assert.ok(session.session_id&&session.session_key);
 await call(12848,oneshotCfg,'tools/call',{name:'terminal_send',arguments:{
  session_id:session.session_id,session_key:session.session_key,
  text:'Write-Output MCPGO_CONPTY_READY',enter:true}});
 let cursor=0,found=false;
 for(let i=0;i<30;i++){
  const result=await call(12848,oneshotCfg,'tools/call',{name:'terminal_read',arguments:{
   session_id:session.session_id,session_key:session.session_key,since:cursor}});
  const output=JSON.parse(result.content[0].text);
  cursor=output.next;found=found||output.text.includes('MCPGO_CONPTY_READY');
  if(found)break;
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 assert.ok(found,'ConPTY shell did not emit output');
 await call(12848,oneshotCfg,'tools/call',{name:'terminal_close',arguments:{
  session_id:session.session_id,session_key:session.session_key}});
 const exec=await call(12848,oneshotCfg,'tools/call',{name:'terminal_exec',arguments:{
  command:'Write-Output MCPGO_ONESHOT_READY',cwd:temp,timeout_ms:15000}});
 const result=JSON.parse(exec.content[0].text);
 assert.equal(result.exit_code,0);
 assert.match(result.stdout,/MCPGO_ONESHOT_READY/);
 const data=path.join(temp,'sample.txt');fs.writeFileSync(data,'native file service');
 const read=await call(12848,oneshotCfg,'tools/call',{name:'files_read',arguments:{path:data}});
 assert.match(JSON.parse(read.content[0].text).text,/native file service/);
});
