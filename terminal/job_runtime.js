'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

const ROOT=path.join(os.homedir(),'Library','Application Support','ChatTerminalHub','OneShotJobs');
const WORKER=path.join(__dirname,'job_worker.js');
const MAX_DURATION_MS=4*60*60*1000;
const JOB_ID_PATTERN=/^[a-f0-9]{48}$/;
function ensureRoot(){fs.mkdirSync(ROOT,{recursive:true,mode:0o700});fs.chmodSync(ROOT,0o700)}
function validateId(job_id){if(typeof job_id!=='string'||!JOB_ID_PATTERN.test(job_id))throw Error('INVALID_JOB_ID');return job_id}
function dir(job_id){return path.join(ROOT,validateId(job_id))}
function readMeta(job_id){
 const p=path.join(dir(job_id),'status.json');
 try{return JSON.parse(fs.readFileSync(p,'utf8'))}
 catch(e){if(e.code==='ENOENT')throw Error('JOB_NOT_FOUND');throw Error('JOB_STATUS_UNREADABLE')}
}
function atomicWrite(file,data){
 const temp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(data)+'\n',{mode:0o600,flag:'wx'});
 fs.renameSync(temp,file);
}
function isRunningPid(pid){
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true}
 catch(e){return e.code==='EPERM'}
}
function summarize(job_id){
 const m=readMeta(job_id);
 let state=m.state, reason=null;
 if(['queued','starting','running'].includes(state)){
  const p=m.runner_pid;
  const age=Date.now()-Date.parse(m.created_at);
  if(p && !isRunningPid(p)){state='unknown';reason='RUNNER_GONE_WITHOUT_COMPLETION_RECEIPT'}
  else if(!p && age>10000){state='unknown';reason='RUNNER_NEVER_REPORTED_START'}
 }
 return {
  job_id,state,reason,created_at:m.created_at,started_at:m.started_at??null,
  finished_at:m.finished_at??null,runner_pid:m.runner_pid??null,
  pid:m.pid??null,exit_code:m.exit_code??null,signal:m.signal??null,
  timed_out:m.timed_out??false,spawn_error:m.spawn_error??null,
  duration_ms:m.duration_ms??null,stdout_bytes:m.stdout_bytes??null,
  stderr_bytes:m.stderr_bytes??null,
  stdout_truncated:m.stdout_truncated??false,
  stderr_truncated:m.stderr_truncated??false
 };
}
function startJob(args){
 if(!args||typeof args.command!=='string'||!args.command.trim()||Buffer.byteLength(args.command,'utf8')>16000)throw Error('INVALID_COMMAND');
 const cwd=args.cwd===undefined?os.homedir():args.cwd;
 if(typeof cwd!=='string'||!path.isAbsolute(cwd)||!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory())throw Error('INVALID_CWD');
 const timeout_ms=args.timeout_ms===undefined?1200000:args.timeout_ms;
 if(!Number.isInteger(timeout_ms)||timeout_ms<1000||timeout_ms>MAX_DURATION_MS)throw Error('INVALID_TIMEOUT');
 const job_id=crypto.randomBytes(24).toString('hex');
 const folder=dir(job_id);
 fs.mkdirSync(folder,{mode:0o700});
 const created_at=new Date().toISOString();
 atomicWrite(path.join(folder,'status.json'),{state:'queued',created_at});
 atomicWrite(path.join(folder,'request.json'),{command:args.command,cwd,timeout_ms});
 for(const name of ['stdout.log','stderr.log'])fs.writeFileSync(path.join(folder,name),'',{mode:0o600,flag:'wx'});
 const child=spawn(process.execPath,[WORKER,job_id],{
   cwd:__dirname,detached:true,stdio:'ignore',
   env:{HOME:os.homedir(),USER:os.userInfo().username,LOGNAME:os.userInfo().username,
     PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',TMPDIR:os.tmpdir()}
 });
 child.on('error',e=>{
  try{const m=readMeta(job_id);if(m.state==='queued')atomicWrite(path.join(folder,'status.json'),
    {...m,state:'launch_error',spawn_error:e.message,finished_at:new Date().toISOString()})}catch{}
 });
 child.unref();
 return {job_id,state:'queued',runner_pid:child.pid??null,created_at,timeout_ms,
   note:'Use job_status for confirmed completion; job_start does not mean PASS'};
}
function getStatus(args){return summarize(validateId(args?.job_id))}
function logs(args){
 const job_id=validateId(args?.job_id);
 const tail_lines=args?.tail_lines===undefined?40:args.tail_lines;
 const max_chars=args?.max_chars===undefined?4000:args.max_chars;
 if(!Number.isInteger(tail_lines)||tail_lines<1||tail_lines>200)throw Error('INVALID_TAIL_LINES');
 if(!Number.isInteger(max_chars)||max_chars<100||max_chars>12000)throw Error('INVALID_MAX_CHARS');
 const meta=summarize(job_id);
 function read(name){
  const log=path.join(dir(job_id),name+'.log');
  let raw;
  try{raw=fs.readFileSync(log,'utf8')}catch(e){if(e.code==='ENOENT')raw='';else throw e}
  const lines=raw.split(/\r?\n/);
  if(lines.length>0&&lines[lines.length-1]==='')lines.pop();
  const selected=lines.slice(-tail_lines).join('\n');
  return {text:selected.slice(-max_chars),retained_bytes:Buffer.byteLength(raw),
   tail_truncated:selected.length>max_chars||lines.length>tail_lines};
 }
 const stdout=read('stdout'),stderr=read('stderr');
 return {job_id,state:meta.state,exit_code:meta.exit_code,timed_out:meta.timed_out,
   stdout:stdout.text,stderr:stderr.text,
   stdout_tail_truncated:stdout.tail_truncated,stderr_tail_truncated:stderr.tail_truncated,
   stdout_retained_bytes:stdout.retained_bytes,stderr_retained_bytes:stderr.retained_bytes,
   stdout_bytes:meta.stdout_bytes,stderr_bytes:meta.stderr_bytes,
   stdout_truncated:meta.stdout_truncated,stderr_truncated:meta.stderr_truncated,
   note:'Shows last requested lines/characters only. Use job_status for definitive exit_code.'};
}
const tools=[
 {name:'job_start',description:'Start a durable detached macOS command for long-running tests (up to 4 hours). No terminal session. Returns opaque job_id (keep it privately for job_status and job_logs). A queued start is NOT a successful test. No fixed concurrent-job cap; check job_status before retrying an unknown operation.',
 inputSchema:{type:'object',properties:{
 command:{type:'string',description:'Noninteractive /bin/zsh -lc command'},
 cwd:{type:'string',description:'Absolute cwd; use an existing absolute directory under your control'},
 timeout_ms:{type:'integer',minimum:1000,maximum:14400000,description:'Max runtime in ms; default 1200000 (20 minutes)'}
 },required:['command'],additionalProperties:false}},
 {name:'job_status',description:'Check durable job status and reliable exit_code by opaque job_id. PASS only when state exited, exit_code 0, timed_out false. Unknown is never PASS.',
 inputSchema:{type:'object',properties:{job_id:{type:'string',description:'Opaque ID from job_start'}},required:['job_id'],additionalProperties:false}},
 {name:'job_logs',description:'Read a bounded tail of stdout and stderr for a durable job. No full endless terminal transcript. Outputs may be truncated and do not replace exit_code from job_status.',
 inputSchema:{type:'object',properties:{job_id:{type:'string'},
 tail_lines:{type:'integer',minimum:1,maximum:200,description:'Most recent lines per stream (default 40)'},
 max_chars:{type:'integer',minimum:100,maximum:12000,description:'Most recent characters per stream (default 4000)'}
 },required:['job_id'],additionalProperties:false}}
];
module.exports={tools,startJob,getStatus,logs,atomicWrite,dir,ensureRoot,readMeta};
