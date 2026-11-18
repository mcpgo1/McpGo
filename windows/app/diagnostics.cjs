'use strict';
// Windows native events append to the same JSONL file as the shared Python engine.
// This file is local-only and must never contain credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const secrets=new Set();
const MAX_LOG=8*1024*1024,KEEP_ARCHIVES=12;
const sensitive=/secret|token|password|passwd|credential|api.?key|private.?key|authorization|cookie|session.?key|access.?key|refresh.?key|admin.?key|runtime.?key/i;
function register(value,key=''){
 if(Array.isArray(value))return value.forEach(item=>register(item,key));
 if(value&&typeof value==='object')return Object.entries(value).forEach(([k,v])=>register(v,k));
 if(sensitive.test(key)&&typeof value==='string'&&value.length>=5)secrets.add(value);
}
function scrub(value){
 const raw=String(value);
 let text=raw.slice(0,524288)+(raw.length>524288?'...[TRUNCATED]':'');
 for(const secret of [...secrets].sort((a,b)=>b.length-a.length))text=text.split(secret).join('[REDACTED]');
 return text
  .replace(/\bsk[-_][a-z0-9_-]{8,}\b/ig,'[REDACTED]')
  .replace(/(bearer\s+)\S+/ig,'$1[REDACTED]')
  .replace(/((?:password|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*["']?)[^\s,;"']+/ig,'$1[REDACTED]')
  .replace(/("(?:[^"]*(?:password|token|secret|api.?key|authorization|cookie)[^"]*)"\s*:\s*")[^"]*/ig,'$1[REDACTED]')
  .replace(/([?&](?:token|key|secret|password|code)=)[^&#\s]+/ig,'$1[REDACTED]');
}
function clean(v,k='',depth=0){
 if(sensitive.test(k))return '[REDACTED]';
 if(depth>10)return '[MAX_DEPTH]';
 if(Array.isArray(v))return v.slice(0,150).map(x=>clean(x,k,depth+1));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).slice(0,150).map(([a,b])=>[scrub(a),clean(b,a,depth+1)]));
 if(typeof v==='string')return scrub(v);
 return v===undefined?null:v;
}
function record(userData,event,details={}){
 try{
  const folder=path.join(userData,'Onboarding','Logs');
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const session=path.join(folder,'attempt.id'),target=path.join(folder,'onboarding.log');
  if(fs.existsSync(session)&&fs.lstatSync(session).isSymbolicLink())return;
  if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())return;
  if(fs.existsSync(target)&&fs.statSync(target).size>=MAX_LOG){
    const archive=path.join(folder,'archive');
    fs.mkdirSync(archive,{recursive:true,mode:0o700});
    const stamp=new Date().toISOString().replace(/[-:.]/g,'').replace('T','T');
    const archived=path.join(archive,stamp+'-'+crypto.randomBytes(4).toString('hex')+'.log');
    try{
      fs.renameSync(target,archived);
      for(const old of fs.readdirSync(archive).filter(name=>name.endsWith('.log')).sort().reverse().slice(KEEP_ARCHIVES)){
        const previous=path.join(archive,old);
        if(fs.statSync(previous).isFile()&&!fs.lstatSync(previous).isSymbolicLink())fs.unlinkSync(previous);
      }
    }catch(_){/* A concurrent writer may be holding the file on Windows. */}
  }
  if(!fs.existsSync(session)){
    try{fs.writeFileSync(session,crypto.randomBytes(16).toString('hex'),{flag:'wx',mode:0o600})}
    catch(e){if(e.code!=='EEXIST')throw e}
  }
  const id=fs.readFileSync(session,'ascii').trim();
  const row={time:new Date().toISOString(),attempt:/^[a-f0-9]{32}$/.test(id)?id:'unknown',
    pid:process.pid,platform:'win32',event:scrub(event),details:clean(details)};
  fs.appendFileSync(target,JSON.stringify(row)+'\n',{encoding:'utf8',flag:'a',mode:0o600});
 }catch(_){/* Never break first-run just because diagnostics are unavailable. */}
}
module.exports={record,register,scrub,clean};
