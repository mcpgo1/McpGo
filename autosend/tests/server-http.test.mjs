import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {verificationReceipt} from '../reconciliation.mjs';

const CHAT_URL='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
async function sparePort(){
 const listener=net.createServer();
 await new Promise((resolve,reject)=>listener.listen(0,'127.0.0.1',e=>e?reject(e):resolve()));
 const port=listener.address().port;
 await new Promise(resolve=>listener.close(resolve));
 return port;
}
async function startIsolated(state){
 const folder=await mkdtemp(path.join(os.tmpdir(),'mcpgo-autosend-test-'));
 const stateFile=path.join(folder,'state.json');
 if(state)await writeFile(stateFile,JSON.stringify(state));
 const port=await sparePort();
 const env={...process.env,
  MCPHUB_AUTOSEND_PORT:String(port),
  MCPHUB_AUTOSEND_STATE:stateFile,
  MCPHUB_PLAYWRIGHT_MCP_URL:'http://127.0.0.1:1/mcp',
  MCPHUB_AUTOSEND_CHECK_MS:'50',
  NODE_ENV:'test'
 };
 const child=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],
  {env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',v=>stdout+=v.toString().slice(0,1000));
 child.stderr.on('data',v=>stderr+=v.toString().slice(0,1000));
 const base='http://127.0.0.1:'+port;
 let started=false;
 for(let i=0;i<50;i++){
  if(child.exitCode!==null)break;
  try{
   const response=await fetch(base+'/api/status',{headers:{'X-MCPHub-Client':'native'}});
   if(response.ok){started=true;break;}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,30));
 }
 if(!started){
  child.kill('SIGTERM');
  await rm(folder,{recursive:true,force:true});
  throw Error('Isolated AutoSend failed to start: '+stdout+' '+stderr);
 }
 return {child,folder,stateFile,base};
}
async function shutdown(s){
 s.child.kill('SIGTERM');
 await Promise.race([
  new Promise(resolve=>s.child.once('close',resolve)),
  new Promise(resolve=>setTimeout(resolve,2000))
 ]);
 if(s.child.exitCode===null)s.child.kill('SIGKILL');
 await rm(s.folder,{recursive:true,force:true});
}
const headers={'X-MCPHub-Client':'native','Content-Type':'application/json'};
test('isolated HTTP server creates a paused schedule without sending or touching other installations',async()=>{
 const instance=await startIsolated();
 try{
  const posted=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers,body:JSON.stringify({action:'create',url:CHAT_URL,message:'test',interval_seconds:900})
  });
  assert.equal(posted.status,200);
  const created=await posted.json();
  assert.equal(created.task.status,'paused');
  assert.equal(created.task.enabled,false);
  const response=await fetch(instance.base+'/api/status',{headers:{'X-MCPHub-Client':'native'}});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.tasks.length,1);
  assert.equal(result.tasks[0].delivery_count,0);
  assert.deepEqual(result.attempts,[]);
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].status,'paused');
  const forbidden=await fetch(instance.base+'/api/status');
  assert.equal(forbidden.status,403);
 }finally{await shutdown(instance);}
});
test('server restart preserves pending click proof and never dispatches automatically',async()=>{
 const task={
  id:'fake-schedule-1',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:true,status:'sending',manual_once:false,next_at:null,
  last_attempt_at:new Date().toISOString(),last_error:'',
  delivery_count:0,delivery_stage:'click-committed',
  verification:verificationReceipt({userCount:3,lastUserText:'Old user text'}),
 };
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/status',{headers:{'X-MCPHub-Client':'native'}});
  const result=await response.json();
  assert.equal(result.tasks[0].status,'verifying');
  assert.equal(result.tasks[0].delivery_count,0);
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].status,'verifying');
  assert.equal(disk.tasks[0].verification.baselineUserCount,3);
  assert.equal(disk.tasks[0].verification.baselineLastUserText,undefined);
 }finally{await shutdown(instance);}
});

test('manual unknown verification via HTTP only rechecks saved receipt; never queues Send',async()=>{
 const task={id:'unknown-1',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:false,status:'unknown',manual_once:false,next_at:null,
  last_error:'Unknown result',delivery_count:0,delivery_stage:'verification-expired',
  verification:verificationReceipt({userCount:3,lastUserText:'Older message'},Date.now()-500000)};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers,body:JSON.stringify({action:'recheck_unknown',id:task.id})
  });
  assert.equal(response.status,200);
  const started=await response.json();
  assert.equal(started.checking,true);
  assert.equal(started.sendBlocked,true);
  const result=await (await fetch(instance.base+'/api/status',{
   headers:{'X-MCPHub-Client':'native'}
  })).json();
  const updated=result.tasks[0];
  assert.equal(updated.enabled,false);
  assert.equal(updated.manual_once,false);
  assert.equal(updated.status,'verifying');
  assert.equal(updated.verification.manualRechecks,1);
  assert.equal(updated.verification.baselineUserCount,3);
  const forbidden=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers,body:JSON.stringify({action:'send_once',id:task.id})
  });
  assert.equal(forbidden.status,400,'manual recheck cannot be turned into new send');
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].enabled,false);
  assert.equal(disk.attempts.length,0);
 }finally{await shutdown(instance)}
});
test('manual unknown recheck without a baseline returns an error, never creates a job',async()=>{
 const task={id:'missing-receipt',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:false,status:'unknown',manual_once:false,next_at:null,delivery_count:0,last_error:'Unknown'};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers,body:JSON.stringify({action:'recheck_unknown',id:task.id})
  });
  assert.equal(response.status,400);
  const result=await (await fetch(instance.base+'/api/status',{
   headers:{'X-MCPHub-Client':'native'}
  })).json();
  assert.equal(result.tasks[0].status,'unknown');
 }finally{await shutdown(instance)}
});

test('HTTP conversation FSM blocks only the same chat, while other chats stay runnable',async()=>{
 const u2='https://chatgpt.com/c/00000000-0000-4000-8000-000000000002';
 const unknown={id:'u1',url:CHAT_URL,message:'first',interval_seconds:900,
  enabled:false,status:'unknown',manual_once:false,next_at:null,
  delivery_count:0,last_error:'Lost reply'};
 const sibling={id:'s1',url:CHAT_URL,message:'second',interval_seconds:900,
  enabled:false,status:'paused',manual_once:false,next_at:null,
  delivery_count:0,last_error:''};
 const independent={id:'i1',url:u2,message:'other chat',interval_seconds:900,
  enabled:false,status:'paused',manual_once:false,next_at:null,
  delivery_count:0,last_error:''};
 const instance=await startIsolated({version:1,tasks:[unknown,sibling,independent],attempts:[]});
 try {
  const same=await fetch(instance.base+'/api/tasks',{method:'POST',headers,
    body:JSON.stringify({action:'start',id:'s1'})});
  assert.equal(same.status,400,'unresolved receipt forbids a second schedule in the same chat');
  const other=await fetch(instance.base+'/api/tasks',{method:'POST',headers,
    body:JSON.stringify({action:'start',id:'i1'})});
  assert.equal(other.status,200,'another conversation remains schedulable');
  const status=await (await fetch(instance.base+'/api/status',{
   headers:{'X-MCPHub-Client':'native'}})).json();
  assert.equal(status.conversations[CHAT_URL].state,'UNKNOWN');
  assert.equal(status.conversations[CHAT_URL].blocked,true);
  assert.equal(status.conversations[u2].state,'READY');
  assert.equal(status.conversations[u2].blocked,false);
  assert.equal(status.tasks.find(x=>x.id==='i1').enabled,true);
  assert.equal(status.tasks.find(x=>x.id==='s1').enabled,false);
  assert.equal(status.attempts.length,0,'no browser actions occurred');
 }finally{await shutdown(instance)}
});

test('user can explicitly confirm already-sent unknown without a new Send or rearming the timer',async()=>{
 const task={id:'manual-confirm-1',url:CHAT_URL,message:'repeated test',
  interval_seconds:900,enabled:false,status:'unknown',manual_once:false,
  next_at:null,last_error:'Unconfirmed',delivery_count:3,delivery_stage:'verification-expired',
  verification:verificationReceipt({userCount:6,lastUserText:'repeated test'},Date.now()-600000)};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers,body:JSON.stringify({action:'confirm_received',id:task.id})
  });
  assert.equal(response.status,200);
  const confirmed=await response.json();
  assert.equal(confirmed.confirmed,true);
  assert.equal(confirmed.sendBlocked,true);
  assert.equal(confirmed.paused,true);
  const status=await (await fetch(instance.base+'/api/status',{
   headers:{'X-MCPHub-Client':'native'}})).json();
  const updated=status.tasks[0];
  assert.equal(updated.enabled,false);
  assert.equal(updated.manual_once,false);
  assert.equal(updated.status,'paused');
  assert.equal(updated.next_at,null);
  assert.equal(updated.delivery_count,4);
  assert.equal(updated.delivery_stage,'manual-confirmed');
  assert.equal(updated.verification,undefined);
  assert.equal(status.attempts.length,1);
  assert.equal(status.attempts[0].result,'verified_manual');
  const duplicate=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers,body:JSON.stringify({action:'confirm_received',id:task.id})
  });
  assert.equal(duplicate.status,400,'manual confirmation must not be counted twice');
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].enabled,false);
  assert.equal(disk.attempts.length,1);
 }finally{await shutdown(instance)}
});
test('manual confirmation is refused for a scheduled task with no attempted Send',async()=>{
 const task={id:'not-sent',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:false,status:'paused',manual_once:false,next_at:null,
  delivery_count:0,last_error:''};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers,body:JSON.stringify({action:'confirm_received',id:task.id})
  });
  assert.equal(response.status,400);
  const status=await (await fetch(instance.base+'/api/status',{
   headers:{'X-MCPHub-Client':'native'}})).json();
  assert.equal(status.tasks[0].delivery_count,0);
  assert.equal(status.attempts.length,0);
 }finally{await shutdown(instance)}
});
