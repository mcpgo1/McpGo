'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const locks=require('./resource_locks.js');
const {classifyCommand}=require('./resource_policy.js');

const ROOT=process.env.MCPGO_JOB_ROOT||path.join(os.homedir(),'Library','Application Support','ChatTerminalHub','OneShotJobs');
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
 let fd;
 try{
  fd=fs.openSync(temp,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify(data)+'\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);fd=null;
  fs.renameSync(temp,file);
  try{const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}}catch{}
 }finally{
  if(fd!==undefined&&fd!==null)fs.closeSync(fd);
  try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}
 }
}
function isRunningPid(pid){
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true}
 catch(e){return e.code==='EPERM'}
}
function summarize(job_id){
 const m=readMeta(job_id);
 let state=m.state, reason=null;
 if(['queued','starting','running','cancelling'].includes(state)){
  // The runner may have written result.json but died before the final
  // status.json rename. The result receipt is an earlier durable commit.
  try{
   const receipt=JSON.parse(fs.readFileSync(path.join(dir(job_id),'result.json'),'utf8'));
   if(receipt.version===1 && receipt.job_id===job_id &&
     ['exited','cancelled'].includes(receipt.state) &&
     typeof receipt.finished_at==='string' &&
     (Number.isInteger(receipt.exit_code)||receipt.exit_code===null)){
    state=receipt.state;
    reason='RECOVERED_FROM_DURABLE_RESULT';
    Object.assign(m,{state,finished_at:receipt.finished_at,
      exit_code:receipt.exit_code,signal:receipt.signal||null,
      timed_out:!!receipt.timed_out,interrupted:!!receipt.interrupted,
      spawn_error:receipt.spawn_error||null,
      stdout_bytes:receipt.stdout_bytes,stderr_bytes:receipt.stderr_bytes,
      stdout_truncated:receipt.stdout_truncated,stderr_truncated:receipt.stderr_truncated});
   }
  }catch(e){
   // A missing result is normal while running. Corrupt is uncertain, never PASS.
   if(e.code!=='ENOENT'){state='unknown';reason='RESULT_RECEIPT_UNREADABLE'}
  }
  if(state===m.state && ['queued','starting','running','cancelling'].includes(state)){
   const p=m.runner_pid;
   const age=Date.now()-Date.parse(m.created_at);
   if(p && !isRunningPid(p)){state='unknown';reason='RUNNER_GONE_WITHOUT_COMPLETION_RECEIPT'}
   else if(!p && age>10000){state='unknown';reason='RUNNER_NEVER_REPORTED_START'}
   else if(['running','cancelling'].includes(state) && m.heartbeat_at &&
     Date.now()-Date.parse(m.heartbeat_at)>30000){
    // A living PID might be an unrelated recycled process or frozen runner.
    // Don't report a perpetual 'running' state if its heartbeat stopped.
    state='stalled';reason='RUNNER_HEARTBEAT_STALE';
   }
  }
 }
 return {
  job_id,operation_id:job_id,resource_key:m.resource_key??null,state,reason,created_at:m.created_at,started_at:m.started_at??null,
  finished_at:m.finished_at??null,runner_pid:m.runner_pid??null,
  pid:m.pid??null,exit_code:m.exit_code??null,signal:m.signal??null,
  timed_out:m.timed_out??false,spawn_error:m.spawn_error??null,
  duration_ms:m.duration_ms??null,heartbeat_at:m.heartbeat_at??null,
  progress:m.progress??null, last_progress_at:m.last_progress_at??null,
  cancellation_requested_at:m.cancellation_requested_at??null,
  last_output_at:m.last_output_at??null,
  heartbeat_age_ms:m.heartbeat_at?Math.max(0,Date.now()-Date.parse(m.heartbeat_at)):null,
  output_idle_ms:m.last_output_at?Math.max(0,Date.now()-Date.parse(m.last_output_at)):null,
  heartbeat_stale:state==='stalled' || (['starting','running','cancelling'].includes(state) && !!m.heartbeat_at && Date.now()-Date.parse(m.heartbeat_at)>30000),
  stdout_bytes:m.stdout_bytes??null,
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
 const resource_key=args.resource_key===undefined?
   classifyCommand(args.command,cwd):locks.validateKey(args.resource_key);
 ensureRoot();
 const request_id=args.request_id;
 if(request_id!==undefined && (typeof request_id!=='string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(request_id)))
   throw Error('INVALID_REQUEST_ID');
 // Preserve the old digest format for jobs created before resource keys.
 const parts=[args.command,cwd,timeout_ms];
 if(args.resource_key!==undefined)parts.push(resource_key);
 const digest=crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
 const job_id=crypto.randomBytes(24).toString('hex');
 let claim=null;
 function existingRequest(){
   let existing;
   try{existing=JSON.parse(fs.readFileSync(claim,'utf8'))}
   catch{throw Error('REQUEST_ID_PENDING_OR_UNREADABLE; check job_recent, never retry blindly')}
   if(existing.digest!==digest)throw Error('REQUEST_ID_CONFLICT');
   try{return {...summarize(existing.job_id),operation_id:existing.job_id,deduplicated:true}}
   catch{return {job_id:existing.job_id,operation_id:existing.job_id,state:'unknown',deduplicated:true,
     reason:'CLAIMED_BUT_JOB_NOT_VISIBLE; do not execute request again'}}
 }
 if(request_id){
   const requests=path.join(ROOT,'.requests');
   fs.mkdirSync(requests,{mode:0o700,recursive:true});
   claim=path.join(requests,crypto.createHash('sha256').update(request_id).digest('hex')+'.json');
   if(fs.existsSync(claim))return existingRequest();
 }
 // A busy resource fails before request_id is committed: no command has run,
 // and this request_id may safely be submitted again when the lock clears.
 if(resource_key!==null)locks.acquire(resource_key,job_id);
 if(claim){
  const record={job_id,digest,created_at:new Date().toISOString()};
  try{
   const fd=fs.openSync(claim,'wx',0o600);
   try{fs.writeSync(fd,JSON.stringify(record));fs.fsyncSync(fd)}
   finally{fs.closeSync(fd)}
  }catch(e){
   if(resource_key!==null)locks.abandon(resource_key,job_id);
   if(e.code!=='EEXIST')throw e;
   return existingRequest();
  }
 }
 const folder=dir(job_id);
 // Fail closed if a post-claim disk error occurs. Never retry blindly.
 fs.mkdirSync(folder,{mode:0o700});
 const created_at=new Date().toISOString();
 atomicWrite(path.join(folder,'status.json'),{state:'queued',created_at,resource_key});
 atomicWrite(path.join(folder,'request.json'),{command:args.command,cwd,timeout_ms,resource_key});
 for(const name of ['stdout.log','stderr.log'])fs.writeFileSync(path.join(folder,name),'',{mode:0o600,flag:'wx'});
 const child=spawn(process.execPath,[WORKER,job_id],{
   cwd:__dirname,detached:true,stdio:'ignore',
   env:{MCPGO_JOB_ROOT:ROOT,HOME:os.homedir(),USER:os.userInfo().username,LOGNAME:os.userInfo().username,
     PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',TMPDIR:os.tmpdir()}
 });
 child.on('error',e=>{
  try {
   const m=readMeta(job_id);
   if(m.state==='queued') {
    const finished_at=new Date().toISOString();
    // The detached runner was never started: receipt is durable before
    // declaring failure and releasing its resource lock.
    atomicWrite(path.join(folder,'result.json'),
      {version:1,job_id,state:'launch_error',exit_code:null,finished_at});
    atomicWrite(path.join(folder,'status.json'),
      {...m,state:'launch_error',spawn_error:e.code||'RUNNER_SPAWN_FAILED',finished_at});
    if(resource_key!==null)locks.release(resource_key,job_id);
   }
  }catch{} // Unknown failure keeps resource locked; no blind retry.
 });
 child.unref();
 return {job_id,operation_id:job_id,resource_key,state:'queued',runner_pid:child.pid??null,created_at,timeout_ms,
   deduplicated:false,note:'Use job_status for confirmed completion; job_start does not mean PASS'};
}
/** Recover opaque job IDs after a disconnected ChatGPT response.
 * Read-only, metadata only. No command text, cwd, stdout, or private logs.
 */
function recent(args={}){
 const limit=args.limit===undefined?10:args.limit;
 if(!Number.isInteger(limit)||limit<1||limit>30)throw Error('INVALID_LIMIT');
 let entries=[];
 try{entries=fs.readdirSync(ROOT,{withFileTypes:true})}
 catch(e){if(e.code==='ENOENT')return {jobs:[],count:0};throw e}
 const candidates=[];
 for(const e of entries){
  if(!e.isDirectory()||!JOB_ID_PATTERN.test(e.name))continue;
  try{
   const meta=fs.statSync(path.join(ROOT,e.name,'status.json'));
   if(!meta.isFile())continue;
   candidates.push({id:e.name,mtime:meta.mtimeMs});
  }catch{}
 }
 candidates.sort((a,b)=>b.mtime-a.mtime);
 const jobs=[];
 for(const row of candidates.slice(0,Math.min(candidates.length,Math.max(limit*3,limit)))){
  try{
   const item=summarize(row.id);
   jobs.push(item);
  }catch{}
  if(jobs.length>=limit)break;
 }
 return {jobs,count:jobs.length,limit,
  note:'Read-only registry. Recover job_id here, then use job_status/job_logs; never rerun an uncertain command.'};
}
function cancel(args){
 const job_id=validateId(args?.job_id);
 const m=summarize(job_id);
 if(!['queued','starting','running','cancelling'].includes(m.state))
   return {...m,cancel_accepted:false,note:'Already terminal or uncertain; never claim a process was stopped'};
 const f=path.join(dir(job_id),'cancel.json');
 if(!fs.existsSync(f))atomicWrite(f,{requested_at:new Date().toISOString()});
 return {...m,cancel_accepted:true,note:'Cancellation requested. Poll job_status for final state; external side effects may already exist'};
}
function result(args){
 const job_id=validateId(args?.job_id), m=summarize(job_id);
 const terminal=['exited','cancelled','launch_error'].includes(m.state);
 if(!terminal)return {...m,result_ready:false,possible_commit:['unknown','stalled'].includes(m.state),
  note:['unknown','stalled'].includes(m.state)?'Runner may still have side effects. Inspect retained logs and external state; never rerun blindly':'Still executing; use job_status'};
 let summary=null;
 try{summary=JSON.parse(fs.readFileSync(path.join(dir(job_id),'result.json'),'utf8'))}
 catch(e){if(e.code!=='ENOENT')throw Error('JOB_RESULT_UNREADABLE')}
 // Legacy jobs did not write result.json; the receipt remains recoverable
 // from status and durable bounded log files.
 return {...m,result_ready:true,summary:summary||{legacy:true},...logs({job_id,tail_lines:120,max_chars:12000})};
}
/** Get an exact byte range from a retained log, Base64 encoded to preserve UTF-8
 * byte boundaries across pages. Reading does not modify or restart the job.
 */
function output(args){
 const job_id=validateId(args?.job_id);
 const stream=args?.stream??'stdout';
 const offset=args?.offset??0;
 const max_bytes=args?.max_bytes??16000;
 if(!['stdout','stderr'].includes(stream))throw Error('INVALID_STREAM');
 if(!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_OFFSET');
 if(!Number.isInteger(max_bytes)||max_bytes<1||max_bytes>32000)throw Error('INVALID_MAX_BYTES');
 // Protect the job registry from directory traversal.
 const filename=path.join(dir(job_id),stream+'.log');
 let fd;let size;
 try{
  size=fs.statSync(filename).size;
  const start=Math.min(offset,size);
  const count=Math.min(max_bytes,size-start);
  const buf=Buffer.alloc(count);
  fd=fs.openSync(filename,'r');
  const read=fs.readSync(fd,buf,0,count,start);
  const m=summarize(job_id);
  return {job_id,stream,offset:start,next_offset:start+read,retained_bytes:size,
   data_base64:buf.subarray(0,read).toString('base64'),
   has_more:start+read<size,complete:['exited','cancelled','unknown','stalled','launch_error'].includes(m.state),
   truncated_by_retention:stream==='stdout'?m.stdout_truncated:m.stderr_truncated,
   note:'Base64 binary chunk; next_offset is byte-accurate. Never repeat the command to retrieve logs.'};
 }catch(e){if(e.code==='ENOENT')throw Error('JOB_OUTPUT_NOT_FOUND');throw e}
 finally{if(fd!==undefined)fs.closeSync(fd)}
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function watch(args){
 const job_id=validateId(args?.job_id);
 const wait_ms=args?.wait_ms??15000;
 if(!Number.isInteger(wait_ms)||wait_ms<0||wait_ms>25000)throw Error('INVALID_WAIT_MS');
 let current=summarize(job_id);
 const snapshot=JSON.stringify([current.state,current.exit_code,
  current.progress,current.stdout_bytes,current.stderr_bytes,current.reason]);
 if(['exited','cancelled','unknown','launch_error'].includes(current.state)||wait_ms===0)
  return {...current,changed:false,waited_ms:0};
 const start=Date.now();
 while(Date.now()-start<wait_ms){
  await wait(Math.min(500,wait_ms-(Date.now()-start)));
  current=summarize(job_id);
  const after=JSON.stringify([current.state,current.exit_code,current.progress,
   current.stdout_bytes,current.stderr_bytes,current.reason]);
  if(after!==snapshot)return {...current,changed:true,waited_ms:Date.now()-start};
 }
 return {...current,changed:false,waited_ms:Date.now()-start};
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
  const filename=path.join(dir(job_id),name+'.log');
  let fd,bytes=0,retained_bytes=0;
  try{
   const st=fs.statSync(filename);retained_bytes=st.size;
   const readLength=Math.min(st.size,512*1024);
   const buffer=Buffer.alloc(readLength);
   fd=fs.openSync(filename,'r');
   bytes=fs.readSync(fd,buffer,0,readLength,st.size-readLength);
   const raw=buffer.subarray(0,bytes).toString('utf8');
   const lines=raw.split(/\r?\n/);
   if(lines.length>0 && lines[lines.length-1]==='')lines.pop();
   const selected=lines.slice(-tail_lines).join('\n');
   return {text:selected.slice(-max_chars),retained_bytes,
    tail_truncated:st.size>readLength || selected.length>max_chars || lines.length>tail_lines};
  }catch(e){
   if(e.code==='ENOENT')return {text:'',retained_bytes:0,tail_truncated:false};
   throw e;
  }finally{if(fd!==undefined)fs.closeSync(fd)}
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
 {name:'mcpgo_recover',description:'FIRST read-only tool after MCP reconnect or lost response. Lists recent persistent operations and currently locked resources, without rerunning ANY command. Use job_status or job_logs to inspect an existing operation.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:30}},additionalProperties:false}},
 {name:'resource_lock_status',description:'Read-only inspect a known resource_key or list locks. Locks only apply to explicitly labeled McpGo jobs; never releases a running or uncertain operation.',inputSchema:{type:'object',properties:{resource_key:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
 {name:'job_start',description:'Start a durable detached macOS command for long-running tests (up to 4 hours). Each command gets a persistent job_id/operation_id. After disconnection use mcpgo_recover and job_status; NEVER rerun an uncertain operation. Use optional request_id for exact idempotency and resource_key only for known conflicting resources. Four independent tasks can run concurrently.',
 inputSchema:{type:'object',properties:{
 command:{type:'string',description:'Noninteractive /bin/zsh -lc command'},
 cwd:{type:'string',description:'Absolute cwd; use an existing absolute directory under your control'},
 timeout_ms:{type:'integer',minimum:1000,maximum:14400000,description:'Max runtime in ms; default 1200000 (20 minutes)'},
 request_id:{type:'string',minLength:8,maxLength:128,description:'Optional stable client-generated key. Repeating same key never executes again; if omitted, recover generated job_id via mcpgo_recover before reissuing.'},
 resource_key:{type:'string',description:'Optional lock label for known conflicting operations, e.g. deploy:gafus-prod, git:repo-main, release:mcpgo. Direct simple Git writes/deploys are conservatively auto-classified; arbitrary shell scripts cannot be reliably classified.'}
 },required:['command'],additionalProperties:false}},
 {name:'job_recent',description:'Read-only recovery of up to 30 most recently updated jobs after a ChatGPT response disconnect. Returns opaque job_id, status, heartbeat/exit metadata only. Never reruns a command or exposes command text/log contents.',
 inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:30,description:'Max recent jobs; default 10'}},additionalProperties:false}},
 {name:'job_cancel',description:'Request cancellation of a durable job. No automatic retry. Already executed side effects may persist; confirm final status.',
 inputSchema:{type:'object',properties:{job_id:{type:'string'}},required:['job_id'],additionalProperties:false}},
 {name:'job_result',description:'Read-only durable result for a completed job (including bounded stdout/stderr tails); never reruns a command. Returns result_ready=false while running.',
 inputSchema:{type:'object',properties:{job_id:{type:'string'}},required:['job_id'],additionalProperties:false}},
 {name:'job_watch',description:'Read-only wait up to 25 seconds for progress, output count or final job state change; never restarts work. Prefer this over repeated short polls.',
 inputSchema:{type:'object',properties:{job_id:{type:'string'},
 wait_ms:{type:'integer',minimum:0,maximum:25000}},required:['job_id'],additionalProperties:false}},
 {name:'job_output',description:'Fetch a byte-exact page (Base64) of persisted stdout/stderr at offset; next_offset supports reliable pagination through large test logs.',
 inputSchema:{type:'object',properties:{job_id:{type:'string'},
 stream:{type:'string',enum:['stdout','stderr']},
 offset:{type:'integer',minimum:0},
 max_bytes:{type:'integer',minimum:1,maximum:32000}},required:['job_id'],additionalProperties:false}},
 {name:'job_status',description:'Check durable job status and reliable exit_code by opaque job_id. PASS only when state exited, exit_code 0, timed_out false. Unknown is never PASS.',
 inputSchema:{type:'object',properties:{job_id:{type:'string',description:'Opaque ID from job_start'}},required:['job_id'],additionalProperties:false}},
 {name:'job_logs',description:'Read a bounded tail of stdout and stderr for a durable job. No full endless terminal transcript. Outputs may be truncated and do not replace exit_code from job_status.',
 inputSchema:{type:'object',properties:{job_id:{type:'string'},
 tail_lines:{type:'integer',minimum:1,maximum:200,description:'Most recent lines per stream (default 40)'},
 max_chars:{type:'integer',minimum:100,maximum:12000,description:'Most recent characters per stream (default 4000)'}
 },required:['job_id'],additionalProperties:false}}
];
function uncertainClaims(limit=30){
 const folder=path.join(ROOT,'.requests');
 let entries=[];
 try{entries=fs.readdirSync(folder).filter(f=>/^[a-f0-9]{64}\\.json$/.test(f))}
 catch(e){if(e.code!=='ENOENT')throw e}
 const items=[];
 let unreadable=0;
 for(const name of entries){
  try {
   const r=JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));
   if(!JOB_ID_PATTERN.test(r.job_id))throw Error('INVALID_ID');
   if(fs.existsSync(path.join(ROOT,r.job_id,'status.json')))continue;
   items.push({job_id:r.job_id,operation_id:r.job_id,state:'unknown',
     reason:'REQUEST_CLAIM_WITHOUT_STATUS; do not replay',
     created_at:r.created_at??null});
  }catch{unreadable++}
 }
 items.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
 return {unknown_jobs:items.slice(0,limit),unreadable_claims:unreadable,
   note:'Claimed operation may have started. Inspect external state; never silently resend.'};
}
function recover(args={}){
 const operations=recent(args);
 return {operations,uncertain:uncertainClaims(operations.limit||30),resources:locks.list({limit:30}),
 note:'Only registered McpGo operations are recoverable. Never replay an unknown shell command or browser action.'}
}
function lockStatus(args={}){return args.resource_key!==undefined?locks.inspect(args.resource_key):locks.list(args)}
module.exports={tools,startJob,getStatus,recent,cancel,result,output,watch,logs,recover,lockStatus,atomicWrite,dir,ensureRoot,readMeta};
