'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-job-regression-'));
process.env.MCPGO_JOB_ROOT=root;
const jobs=require('../job_runtime.js');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(job_id,predicate,deadline=8000){
 const limit=Date.now()+deadline;
 while(Date.now()<limit){
  const s=jobs.getStatus({job_id});
  if(predicate(s))return s;
  await delay(80);
 }
 throw Error('Job timeout: '+JSON.stringify(jobs.getStatus({job_id})));
}
test('idempotency request_id prevents a duplicate, even for a completed job',async()=>{
 const args={command:"printf 'one\n'",cwd:os.tmpdir(),request_id:'idempotent-000001'};
 const a=jobs.startJob(args);
 const b=jobs.startJob(args);
 assert.equal(a.deduplicated,false);
 assert.equal(b.deduplicated,true);
 assert.equal(b.job_id,a.job_id);
 const done=await until(a.job_id,s=>s.state==='exited');
 assert.equal(done.exit_code,0);
 const c=jobs.startJob(args);
 assert.equal(c.job_id,a.job_id);
 assert.equal(c.deduplicated,true);
 assert.equal(fs.readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^[a-f0-9]{48}$/.test(d.name)).length,1);
 const result=jobs.result({job_id:a.job_id});
 assert.equal(result.result_ready,true);
 assert.equal(result.summary.version,1);
 assert.match(result.stdout,/one/);
 assert.match(result.summary.stdout_sha256,/^[a-f0-9]{64}$/);
});
test('same key, different command refuses replay',()=>{
 assert.throws(()=>jobs.startJob({command:'true',request_id:'idempotent-000001'}),/REQUEST_ID_CONFLICT/);
});
test('progress and live heartbeat are observable before completion',async()=>{
 const script="printf '[MCPGO_PROGRESS] {\"percent\":42,\"stage\":\"running tests\"}\\n'; sleep 2; printf 'complete\\n'";
 const a=jobs.startJob({command:script,request_id:'progress-000002'});
 const observed=await until(a.job_id,s=>s.progress?.percent===42,4000);
 assert.equal(observed.progress.stage,'running tests');
 assert.ok(observed.heartbeat_at);
 assert.ok(observed.heartbeat_age_ms>=0);
 assert.ok(observed.last_output_at);
 const done=await until(a.job_id,s=>s.state==='exited');
 assert.equal(done.exit_code,0);
 assert.equal(jobs.result({job_id:a.job_id}).result_ready,true);
});
test('cancel is an acknowledged request; child is not claimed stopped before receipt',async()=>{
 const job=jobs.startJob({command:'sleep 40',request_id:'cancel-000003'});
 await until(job.job_id,s=>s.state==='running');
 const requested=jobs.cancel({job_id:job.job_id});
 assert.equal(requested.cancel_accepted,true);
 const done=await until(job.job_id,s=>s.state==='cancelled',7000);
 assert.equal(done.state,'cancelled');
 assert.equal(done.timed_out,false);
 assert.equal(jobs.result({job_id:job.job_id}).result_ready,true);
 assert.equal(jobs.cancel({job_id:job.job_id}).cancel_accepted,false);
});
test('metadata-only recovery returns job IDs but never command text',()=>{
 const value=jobs.recent({limit:10});
 assert.ok(value.jobs.length>=3);
 assert.ok(value.jobs.every(j=>/^[a-f0-9]{48}$/.test(j.job_id)));
 assert.doesNotMatch(JSON.stringify(value),/sleep 40|printf '\[MCPGO_PROGRESS\]/);
});
test('crash between exclusive claim and process spawn fails closed',()=>{
 const request_id='crash-claim-000004';
 const claim=path.join(root,'.requests',require('node:crypto').createHash('sha256').update(request_id).digest('hex')+'.json');
 fs.writeFileSync(claim,'{');
 assert.throws(()=>jobs.startJob({command:'echo should-not-run',request_id}),/REQUEST_ID_PENDING_OR_UNREADABLE/);
});
test('input and lookup validation',()=>{
 assert.throws(()=>jobs.startJob({command:'true',request_id:'x'}),/INVALID_REQUEST_ID/);
 assert.throws(()=>jobs.result({job_id:'../../etc/passwd'}),/INVALID_JOB_ID/);
 assert.throws(()=>jobs.recent({limit:31}),/INVALID_LIMIT/);
});

test('paged Base64 output reconstructs a large binary-exact test report',async()=>{
 const expected='Анализ тестов '+('Z'.repeat(110000))+'\n';
 // Use Node as the child to avoid shell quote and printf locale ambiguity.
 const script="node -e 'process.stdout.write(\"Анализ тестов \"+\"Z\".repeat(110000)+\"\\n\")'";
 const job=jobs.startJob({command:script,request_id:'large-output-000005'});
 const done=await until(job.job_id,s=>s.state==='exited',6000);
 assert.equal(done.exit_code,0);
 const pieces=[];let offset=0;
 for(let n=0;n<20;n++){
  const part=jobs.output({job_id:job.job_id,stream:'stdout',offset,max_bytes:16000});
  assert.equal(part.offset,offset);
  pieces.push(Buffer.from(part.data_base64,'base64'));
  offset=part.next_offset;
  if(!part.has_more)break;
 }
 assert.equal(Buffer.concat(pieces).toString('utf8'),expected);
 const result=jobs.result({job_id:job.job_id});
 assert.equal(result.summary.stdout_retained_bytes,Buffer.byteLength(expected));
 assert.equal(result.stdout_tail_truncated,true);
});
test('job_watch waits for actual state or byte/progress changes and does not run commands',async()=>{
 const started=jobs.startJob({command:'sleep 1; printf ready',request_id:'watch-000006'});
 await until(started.job_id,s=>s.state==='running');
 const first=await jobs.watch({job_id:started.job_id,wait_ms:2500});
 assert.ok(first.changed,'watch should observe change');
 assert.ok(first.waited_ms>=0 && first.waited_ms<=2600);
 const final=await until(started.job_id,s=>s.state==='exited');
 assert.equal(final.exit_code,0);
 const immediately=await jobs.watch({job_id:started.job_id,wait_ms:25000});
 assert.equal(immediately.changed,false);
 assert.equal(immediately.waited_ms,0);
});
test('missing job_output stream rejects traversal and invalid offset',async()=>{
 assert.throws(()=>jobs.output({job_id:'../../etc',stream:'stdout'}),/INVALID_JOB_ID/);
 assert.throws(()=>jobs.output({job_id:'f'.repeat(48),stream:'../../secret'}),/INVALID_STREAM/);
 assert.throws(()=>jobs.output({job_id:'f'.repeat(48),offset:-1}),/INVALID_OFFSET/);
 await assert.rejects(()=>jobs.watch({job_id:'f'.repeat(48),wait_ms:25001}),/INVALID_WAIT_MS/);
});

test('stale runner heartbeat is not misreported as productive running',()=>{
 const id='e'.repeat(48);
 const folder=jobs.dir(id);fs.mkdirSync(folder,{mode:0o700});
 jobs.atomicWrite(path.join(folder,'status.json'),{
  state:'running',created_at:new Date(Date.now()-60000).toISOString(),
  started_at:new Date(Date.now()-60000).toISOString(),
  heartbeat_at:new Date(Date.now()-40000).toISOString(),
  runner_pid:process.pid,pid:process.pid
 });
 for(const stream of ['stdout','stderr'])fs.writeFileSync(path.join(folder,stream+'.log'),'');
 const report=jobs.getStatus({job_id:id});
 assert.equal(report.state,'stalled');
 assert.equal(report.reason,'RUNNER_HEARTBEAT_STALE');
 assert.equal(report.heartbeat_stale,true);
 assert.equal(jobs.result({job_id:id}).result_ready,false);
 assert.equal(jobs.result({job_id:id}).possible_commit,true);
 assert.equal(jobs.cancel({job_id:id}).cancel_accepted,false,'uncertain/stalled task must not be reinterpreted as a normal running process');
});
test('result receipt recovers crash between result.json and status.json',()=>{
 const id='d'.repeat(48);
 const folder=jobs.dir(id);fs.mkdirSync(folder,{mode:0o700});
 jobs.atomicWrite(path.join(folder,'status.json'),{
  state:'running',created_at:new Date(Date.now()-120000).toISOString(),runner_pid:999999});
 jobs.atomicWrite(path.join(folder,'result.json'),{
  version:1,job_id:id,state:'exited',exit_code:0,signal:null,timed_out:false,
  finished_at:new Date().toISOString(),stdout_bytes:5,stderr_bytes:0,
  stdout_truncated:false,stderr_truncated:false
 });
 fs.writeFileSync(path.join(folder,'stdout.log'),'hello');
 fs.writeFileSync(path.join(folder,'stderr.log'),'');
 const status=jobs.getStatus({job_id:id});
 assert.equal(status.state,'exited');
 assert.equal(status.reason,'RECOVERED_FROM_DURABLE_RESULT');
 assert.equal(status.exit_code,0);
 assert.equal(jobs.result({job_id:id}).result_ready,true);
});
test('broken result receipt never fabricates completion',()=>{
 const id='c'.repeat(48);
 const folder=jobs.dir(id);fs.mkdirSync(folder,{mode:0o700});
 jobs.atomicWrite(path.join(folder,'status.json'),{
  state:'running',created_at:new Date(Date.now()-120000).toISOString(),runner_pid:999999});
 fs.writeFileSync(path.join(folder,'result.json'),'{');
 const outcome=jobs.getStatus({job_id:id});
 assert.equal(outcome.state,'unknown');
 assert.equal(outcome.reason,'RESULT_RECEIPT_UNREADABLE');
 assert.equal(jobs.result({job_id:id}).result_ready,false);
});
