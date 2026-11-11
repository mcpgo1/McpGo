'use strict';
// Cross-process, on-disk exclusive resource leases. This is cooperation
// between McpGo-managed jobs, not OS sandboxing of arbitrary shell commands.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const os=require('node:os');
const ROOT=require('./platform.js').jobRoot();
const LOCKROOT=path.join(ROOT,'.locks');
const KEY=/^(?:deploy|release|git|browser|file|custom):[a-zA-Z0-9._:/-]{1,110}$/;
const JOB=/^[a-f0-9]{48}$/;
function validateKey(key) {
 if(typeof key!=='string'||key.length>128||!KEY.test(key)||key.includes('..'))throw Error('INVALID_RESOURCE_KEY');
 return key;
}
function location(key) {
 return path.join(LOCKROOT,crypto.createHash('sha256').update(validateKey(key)).digest('hex'));
}
function readOwner(dir) {
 try {
  const s=JSON.parse(fs.readFileSync(path.join(dir,'owner.json'),'utf8'));
  if(!JOB.test(s.job_id)||typeof s.resource_key!=='string'||!KEY.test(s.resource_key))throw Error('INVALID_LOCK_OWNER');
  return s;
 }catch {return null}
}
function isCompleted(job_id) {
 try {
  const r=JSON.parse(fs.readFileSync(path.join(ROOT,job_id,'result.json'),'utf8'));
  return r.version===1 && r.job_id===job_id && ['exited','cancelled','launch_error'].includes(r.state)
    && typeof r.finished_at==='string';
 }catch {return false}
}
function removeOwned(dir,job_id) {
 // Only a matching owner with a durable completion receipt may be recycled.
 const owner=readOwner(dir);
 if(!owner || owner.job_id!==job_id || !isCompleted(job_id))return false;
 const shifted=dir+'.retired-'+crypto.randomBytes(8).toString('hex');
 try {fs.renameSync(dir,shifted)}
 catch(e){if(e.code==='ENOENT')return false;throw e}
 // Verify after rename before removal. If not the same owner, preserve it.
 const next=readOwner(shifted);
 if(!next||next.job_id!==job_id)throw Error('RESOURCE_LOCK_OWNER_CHANGED');
 fs.rmSync(shifted,{recursive:true,force:true});
 return true;
}
function acquire(resource_key,job_id) {
 validateKey(resource_key);
 if(!JOB.test(job_id))throw Error('INVALID_JOB_ID');
 fs.mkdirSync(LOCKROOT,{recursive:true,mode:0o700});
 const dir=location(resource_key);
 for(let tries=0;tries<3;tries++){
  try{
   fs.mkdirSync(dir,{mode:0o700});
   try{
    fs.writeFileSync(path.join(dir,'owner.json'),JSON.stringify({
      resource_key,job_id,created_at:new Date().toISOString()
    })+'\n',{flag:'wx',mode:0o600});
   }catch(e){
    // Do not remove an unknown claim if another process could have seen it.
    throw Error('RESOURCE_LOCK_CLAIM_UNCERTAIN');
   }
   return {resource_key,job_id,acquired:true};
  }catch(e){
   if(e.code!=='EEXIST')throw e;
   const current=readOwner(dir);
   if(!current)throw Error('RESOURCE_LOCK_UNCERTAIN; inspect before retry');
   if(current.resource_key!==resource_key)throw Error('RESOURCE_HASH_MISMATCH');
   if(current.job_id===job_id)return {resource_key,job_id,acquired:true};
   if(!removeOwned(dir,current.job_id))
     throw Error('RESOURCE_BUSY:'+current.job_id);
  }
 }
 throw Error('RESOURCE_LOCK_CONTENTION');
}
function abandon(resource_key,job_id) {
 // Safe only before request claim/job folder creation, e.g. a concurrent
 // client won the same idempotency key after our resource acquisition.
 const dir=location(resource_key),owner=readOwner(dir);
 if(!owner||owner.job_id!==job_id||fs.existsSync(path.join(ROOT,job_id)))return false;
 const retired=dir+'.abandoned-'+crypto.randomBytes(8).toString('hex');
 try{fs.renameSync(dir,retired)}catch(e){if(e.code==='ENOENT')return false;throw e}
 fs.rmSync(retired,{recursive:true,force:true});
 return true;
}
function release(resource_key,job_id) {
 const dir=location(resource_key);
 // Never release an active worker's lock; require a committed result.
 return removeOwned(dir,job_id);
}
function inspect(resource_key) {
 const dir=location(resource_key);
 const owner=readOwner(dir);
 if(!owner) {
  if(fs.existsSync(dir))return {resource_key,locked:true,state:'unknown'};
  return {resource_key,locked:false};
 }
 return {resource_key,locked:true,owner_job_id:owner.job_id,
   state:isCompleted(owner.job_id)?'completed_needs_cleanup':'active_or_uncertain'};
}
function list({limit=30}={}) {
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('INVALID_LIMIT');
 let names=[];
 try{names=fs.readdirSync(LOCKROOT)}catch(e){if(e.code!=='ENOENT')throw e}
 const locks=[];
 for(const name of names) {
  if(!/^[a-f0-9]{64}$/.test(name))continue;
  const owner=readOwner(path.join(LOCKROOT,name));
  if(!owner)continue;
  locks.push(inspect(owner.resource_key));
  if(locks.length>=limit)break;
 }
 return {locks,count:locks.length,
   note:'Locks affect only explicitly labeled McpGo jobs; arbitrary shell changes are not automatically sandboxed.'};
}
module.exports={acquire,abandon,release,inspect,list,validateKey};
