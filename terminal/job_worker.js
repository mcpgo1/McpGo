'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const runtime=require('./job_runtime.js');

const job_id=process.argv[2];
const folder=runtime.dir(job_id);
const statusPath=path.join(folder,'status.json');
const request=JSON.parse(fs.readFileSync(path.join(folder,'request.json'),'utf8'));
let state=runtime.readMeta(job_id);
let child=null, finished=false, timed_out=false, interrupted=false, spawn_error=null;
let stdout_bytes=0,stderr_bytes=0,stdout_truncated=false,stderr_truncated=false;
let last_output_at=null;
let heartbeatTimer=null,cancelTimer=null;
let progressBuffer='',progress=null,last_progress_at=null;
const CANCEL_FILE=path.join(folder,'cancel.json');
function readProgress(chunk){
 progressBuffer=(progressBuffer+chunk.toString('utf8')).slice(-8192);
 let newline;
 while((newline=progressBuffer.indexOf('\n'))!==-1){
  const line=progressBuffer.slice(0,newline).trimEnd();
  progressBuffer=progressBuffer.slice(newline+1);
  if(!line.startsWith('[MCPGO_PROGRESS] '))continue;
  try{
   const value=JSON.parse(line.slice('[MCPGO_PROGRESS] '.length));
   if(typeof value.stage!=='string'||value.stage.length>120||
      !Number.isFinite(value.percent)||value.percent<0||value.percent>100)continue;
   progress={percent:Math.round(value.percent*10)/10,
     stage:value.stage.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120)};
   last_progress_at=new Date().toISOString();
  }catch{}
 }
}
function applyCancellation(){
 if(finished||interrupted||!fs.existsSync(CANCEL_FILE))return;
 interrupted=true;
 try{update({state:'cancelling',cancellation_requested_at:new Date().toISOString()})}catch{}
 killJob('SIGTERM');
 killTimer=setTimeout(()=>{if(!finished)killJob('SIGKILL')},1500);
 killTimer.unref();
}
// Keep up to 64 MiB per stream for later paged download; report truncation.
const MAX_LOG=64*1024*1024;
const retained={stdout:0,stderr:0};
const begun=Date.now();

function update(fields){
 state={...state,...fields};
 runtime.atomicWrite(statusPath,state);
}
function boundedAppend(name,chunk){
 const file=path.join(folder,name+'.log');
 try{
  if(retained[name]>=MAX_LOG){
   if(name==='stdout')stdout_truncated=true;else stderr_truncated=true;
   return;
  }
  const count=Math.min(chunk.length,MAX_LOG-retained[name]);
  fs.appendFileSync(file,chunk.subarray(0,count));
  retained[name]+=count;
  if(count<chunk.length){
   if(name==='stdout')stdout_truncated=true;else stderr_truncated=true;
  }
 }catch(e){
  // Do not manufacture process success if logging fails.
  if(name==='stdout')stdout_truncated=true;else stderr_truncated=true;
  try{fs.appendFileSync(path.join(folder,'stderr.log'),Buffer.from('\n[JOB_LOG_IO_ERROR]\n'))}catch{}
 }
}
function killJob(signal){
 if(child?.pid){try{process.kill(-child.pid,signal)}catch{}}
}
function finalize(code,signal){
 if(finished)return;
 finished=true;
 if(timeoutTimer)clearTimeout(timeoutTimer);
 if(killTimer)clearTimeout(killTimer);
 if(heartbeatTimer)clearInterval(heartbeatTimer);
 if(cancelTimer)clearInterval(cancelTimer);
 const finished_at=new Date().toISOString();
 const finalState=interrupted?'cancelled':'exited';
 const result={version:1,job_id,state:finalState,exit_code:typeof code==='number'?code:null,
  signal:signal||null,timed_out,interrupted,spawn_error,finished_at,
  stdout_bytes,stderr_bytes,stdout_truncated,stderr_truncated,progress,last_progress_at};
 try{
  // Commit a durable completion receipt before publishing terminal state.
  for(const stream of ['stdout','stderr']){
   const filename=path.join(folder,stream+'.log');
   const stat=fs.statSync(filename);
   const hash=crypto.createHash('sha256');
   const fd=fs.openSync(filename,'r');
   try{
    const scratch=Buffer.alloc(65536);
    let offset=0;
    while(offset<stat.size){
     const n=fs.readSync(fd,scratch,0,Math.min(scratch.length,stat.size-offset),offset);
     if(n<=0)break;
     hash.update(scratch.subarray(0,n));offset+=n;
    }
   }finally{fs.closeSync(fd)}
   result[stream+'_retained_bytes']=stat.size;
   result[stream+'_sha256']=hash.digest('hex');
  }
  runtime.atomicWrite(path.join(folder,'result.json'),result);
 }catch(e){result.result_write_error=e.code||'UNKNOWN'}
 update({
  state:finalState,finished_at,exit_code:typeof code==='number'?code:null,
  signal:signal||null,timed_out,interrupted,spawn_error,
  duration_ms:Date.now()-begun,stdout_bytes,stderr_bytes,
  last_output_at,heartbeat_at:new Date().toISOString(),progress,last_progress_at,
  result_write_error:result.result_write_error||null,
  stdout_truncated,stderr_truncated
 });
}
update({state:'starting',runner_pid:process.pid,created_at:state.created_at,started_at:new Date().toISOString()});
const env={
 HOME:os.homedir(),USER:os.userInfo().username,LOGNAME:os.userInfo().username,
 PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
 LANG:'en_US.UTF-8',TMPDIR:os.tmpdir()
};
let timeoutTimer=null,killTimer=null;
try {
 child=spawn('/bin/zsh',['-lc',request.command],{
  cwd:request.cwd,env,detached:true,stdio:['ignore','pipe','pipe']
 });
 update({state:'running',pid:child.pid??null,heartbeat_at:new Date().toISOString(),last_output_at:null});
 // Durable process heartbeat survives dropped ChatGPT response streams.
 // Every 5 sec publish counters but never log private stdout/stderr in status.
 heartbeatTimer=setInterval(()=>{
  if(finished)return;
  try{update({heartbeat_at:new Date().toISOString(),last_output_at,
    stdout_bytes,stderr_bytes,progress,last_progress_at});}
  catch{} // A transient status-write error must not kill the running child.
 },5000);
 heartbeatTimer.unref();
 cancelTimer=setInterval(applyCancellation,1000);
 cancelTimer.unref();
 applyCancellation();
 timeoutTimer=setTimeout(()=>{
  if(finished)return;
  timed_out=true;
  killJob('SIGTERM');
  killTimer=setTimeout(()=>{if(!finished)killJob('SIGKILL')},1500);
  killTimer.unref();
 },request.timeout_ms);
 child.stdout.on('data',buf=>{stdout_bytes+=buf.length;last_output_at=new Date().toISOString();readProgress(buf);boundedAppend('stdout',buf)});
 child.stderr.on('data',buf=>{stderr_bytes+=buf.length;last_output_at=new Date().toISOString();boundedAppend('stderr',buf)});
 child.on('error',error=>{spawn_error=error.code||error.message});
 child.on('close',(code,signal)=>{finalize(code,signal)});
} catch(e){
 spawn_error=e.code||e.message;
 finalize(null,null);
}
for(const sig of ['SIGTERM','SIGINT']){
 process.on(sig,()=>{
  if(finished)return;
  interrupted=true;
  killJob('SIGTERM');
  killTimer=setTimeout(()=>{if(!finished)killJob('SIGKILL')},1500);
  killTimer.unref();
 });
}
process.on('uncaughtException',e=>{
 try{
  update({state:'unknown',finished_at:new Date().toISOString(),spawn_error:'RUNNER_EXCEPTION',exit_code:null});
 }catch{}
 killJob('SIGTERM');
 process.exit(1);
});
