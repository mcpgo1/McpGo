'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-lock-tests-'));
process.env.MCPGO_JOB_ROOT=root;
const locks=require('../resource_locks.js');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const a='a'.repeat(48),b='b'.repeat(48);
function receipt(job_id) {
 const dir=path.join(root,job_id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({
  version:1,job_id,state:'exited',finished_at:new Date().toISOString()
 }));
}
test('same known resource is exclusive across independent agents',()=>{
 locks.acquire('deploy:gafus-prod',a);
 assert.throws(()=>locks.acquire('deploy:gafus-prod',b),/RESOURCE_BUSY/);
 assert.equal(locks.inspect('deploy:gafus-prod').owner_job_id,a);
 assert.equal(locks.release('deploy:gafus-prod',a),false,'never release without proof of completion');
 locks.acquire('git:another-project',b);
 assert.equal(locks.inspect('git:another-project').owner_job_id,b);
});
test('completed job can be safely reclaimed; duplicate ownership stays safe',()=>{
 receipt(a);
 locks.acquire('deploy:gafus-prod',b);
 assert.equal(locks.inspect('deploy:gafus-prod').owner_job_id,b);
 receipt(b);
 assert.equal(locks.release('deploy:gafus-prod',b),true);
 assert.equal(locks.inspect('deploy:gafus-prod').locked,false);
});
test('unknown owner fails closed and cannot silently expire',()=>{
 const job_id='c'.repeat(48);
 locks.acquire('release:shared',job_id);
 assert.throws(()=>locks.acquire('release:shared',a),/RESOURCE_BUSY/);
 assert.equal(locks.inspect('release:shared').state,'active_or_uncertain');
 const listed=locks.list();
 assert.ok(listed.locks.some(x=>x.resource_key==='release:shared'));
});
test('paths/invalid identifiers cannot escape lock root',()=>{
 for(const key of ['file:../../etc','file:with space','/tmp/test','git:','deploy:()']){
  assert.throws(()=>locks.acquire(key,a),/INVALID_RESOURCE_KEY/,key);
 }
 assert.throws(()=>locks.acquire('git:valid','wrong'),/INVALID_JOB_ID/);
});
