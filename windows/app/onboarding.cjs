'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const ACTIONS=new Set(['discover','provision','import','runtime-projects',
  'runtime-inspect','runtime-auto','runtime-recover-key','verify-remote','doctor']);
async function onboarding({action,payload,root,userData,python}){
 if(!ACTIONS.has(action))throw Error('UNSUPPORTED_ONBOARDING_ACTION');
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('INVALID_ONBOARDING_INPUT');
 const serialized=JSON.stringify(payload);
 if(Buffer.byteLength(serialized,'utf8')>16384)throw Error('ONBOARDING_INPUT_TOO_LARGE');
 const script=path.join(root,'onboarding_cli.py');
 const command=python||path.join(root,'python','python.exe');
 return new Promise((resolve,reject)=>{
  const child=spawn(command,[script,action],{cwd:root,windowsHide:true,
   stdio:['pipe','pipe','pipe'],env:{
    ...process.env,MCPGO_USER_DATA:userData,MCPGO_RESOURCE_ROOT:root,
    MCPGO_TUNNEL_CLIENT:path.join(root,'tunnel','tunnel-client.exe'),
    PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'
   }});
  let stdout='',size=0,done=false;
  const fail=error=>{if(done)return;done=true;reject(error)};
  const timer=setTimeout(()=>{child.kill();fail(Error('ONBOARDING_TIMEOUT'))},145000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{size+=Buffer.byteLength(chunk);
    if(size>131072){child.kill();fail(Error('ONBOARDING_OUTPUT_TOO_LARGE'))}
    else stdout+=chunk;
  });
  // stderr intentionally discarded: the admin key never enters a log.
  child.stderr.on('data',()=>{});
  child.on('error',error=>{clearTimeout(timer);fail(Error('ONBOARDING_START_FAILED_'+(error.code||'')))});
  child.on('close',()=>{
    clearTimeout(timer);if(done)return;
    let reply;
    try{reply=JSON.parse(stdout)}catch{return fail(Error('ONBOARDING_INVALID_RESPONSE'))}
    if(!reply?.ok)return fail(Error(String(reply?.error||'ONBOARDING_FAILED').slice(0,180)));
    done=true;resolve(reply.result);
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(serialized);
 });
}
module.exports={onboarding,ACTIONS};
