'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const runtime=require('./job_runtime.js');

const job_id=process.argv[2];
const folder=runtime.dir(job_id);
const statusPath=path.join(folder,'status.json');
const request=JSON.parse(fs.readFileSync(path.join(folder,'request.json'),'utf8'));
let state=runtime.readMeta(job_id);
let child=null, finished=false, timed_out=false, interrupted=false, spawn_error=null;
let stdout_bytes=0,stderr_bytes=0,stdout_truncated=false,stderr_truncated=false;
const MAX_LOG=1024*1024;
const RETAIN_LOG=512*1024;
const begun=Date.now();

function update(fields){
 state={...state,...fields};
 runtime.atomicWrite(statusPath,state);
}
function boundedAppend(name,chunk){
 const file=path.join(folder,name+'.log');
 try {
  fs.appendFileSync(file,chunk);
  const stat=fs.statSync(file);
  if(stat.size>MAX_LOG){
   const fd=fs.openSync(file,'r');
   try {
    const keep=Buffer.alloc(Math.min(RETAIN_LOG,stat.size));
    fs.readSync(fd,keep,0,keep.length,stat.size-keep.length);
    fs.writeFileSync(file,keep,{mode:0o600});
   }finally{fs.closeSync(fd)}
   if(name==='stdout')stdout_truncated=true;
   else stderr_truncated=true;
  }
 }catch(e){
  // Preserve process result even if log append fails; do not fabricate an exit code.
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
 update({
  state:'exited',finished_at:new Date().toISOString(),exit_code:typeof code==='number'?code:null,
  signal:signal||null,timed_out,interrupted,spawn_error,
  duration_ms:Date.now()-begun,stdout_bytes,stderr_bytes,
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
 update({state:'running',pid:child.pid??null});
 timeoutTimer=setTimeout(()=>{
  if(finished)return;
  timed_out=true;
  killJob('SIGTERM');
  killTimer=setTimeout(()=>{if(!finished)killJob('SIGKILL')},1500);
  killTimer.unref();
 },request.timeout_ms);
 child.stdout.on('data',buf=>{stdout_bytes+=buf.length;boundedAppend('stdout',buf)});
 child.stderr.on('data',buf=>{stderr_bytes+=buf.length;boundedAppend('stderr',buf)});
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
