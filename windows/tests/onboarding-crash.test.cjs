'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {nativeExitCode,decodeReply,withNativeRetry}=require('../app/onboarding.cjs');
const {runBrowserProbe}=require('../app/runtime.cjs');

test('Windows access violation is not a malformed JSON response',()=>{
 for(const code of [3221225477,-1073741819]){
  assert.equal(nativeExitCode(code),'0xC0000005');
  assert.throws(()=>decodeReply('',code,null),/ONBOARDING_NATIVE_CRASH 0xC0000005/);
  assert.throws(()=>decodeReply('{"ok":true,"result":42}',code,null),/ONBOARDING_NATIVE_CRASH/);
 }
 assert.equal(nativeExitCode(2),null);
});
test('structured CLI errors remain actionable; abnormal exit never reports success',()=>{
 assert.equal(decodeReply('{"ok":true,"result":42}',0,null),42);
 assert.throws(()=>decodeReply('{"ok":false,"error":"specific failure"}',2,null),/specific failure/);
 assert.throws(()=>decodeReply('{"ok":true}',1,null),/ONBOARDING_PROCESS_FAILED/);
 assert.throws(()=>decodeReply('',0,null),/ONBOARDING_INVALID_RESPONSE/);
 assert.throws(()=>decodeReply('',null,'SIGTERM'),/ONBOARDING_TERMINATED/);
});
const probe=code=>({file:process.execPath,args:['-e',code],cwd:process.cwd(),env:process.env});
test('browser probe needs explicit success and never records arbitrary output',async()=>{
 const good=await runBrowserProbe(probe("console.log('PRIVATE_PLAYWRIGHT_INITIALIZE=PASS');console.log('secret token or tab title');console.log('MCP_CONNECTIVITY_PROBE=PASS')"),5000);
 assert.equal(good.ok,true);
 assert.deepEqual(good.phases,['PRIVATE_PLAYWRIGHT_INITIALIZE=PASS','MCP_CONNECTIVITY_PROBE=PASS']);
 const missing=await runBrowserProbe(probe("console.log('TOOL_DISCOVERY=PASS')"),5000);
 assert.equal(missing.ok,false);
 const bad=await runBrowserProbe(probe("console.log('MCP_CONNECTIVITY_PROBE=PASS');process.exitCode=1"),5000);
 assert.equal(bad.ok,false);
});
test('browser probe timeouts and launch failures are distinguished',async()=>{
 const timed=await runBrowserProbe(probe('setTimeout(()=>{},5000)'),50);
 assert.equal(timed.reason,'timeout');
 assert.equal(timed.ok,false);
 const missing=await runBrowserProbe({...probe(''),file:process.execPath+'-missing'},5000);
 assert.equal(missing.reason,'spawn');
 assert.equal(missing.ok,false);
});

test('one retry only for idempotent verification, never for creation or import',async()=>{
 const crash=()=>decodeReply('',3221225477,null);
 for(const action of ['status','browser-check','verify-remote','provision','runtime-auto','runtime-recover-key','import']){
  let calls=0,retries=0;
  const attempt=async()=>{if(++calls===1)crash();return 'confirmed'};
  if(['status','browser-check','verify-remote'].includes(action)){
   assert.equal(await withNativeRetry(action,attempt,()=>retries++),'confirmed');
   assert.equal(calls,2);assert.equal(retries,1);
  }else{
   await assert.rejects(withNativeRetry(action,attempt,()=>retries++),/ONBOARDING_NATIVE_CRASH/);
   assert.equal(calls,1);assert.equal(retries,0);
  }
 }
 let calls=0;
 await assert.rejects(withNativeRetry('status',async()=>{calls++;crash()}),/ONBOARDING_NATIVE_CRASH/);
 assert.equal(calls,2);
});

test('saving only unchanged connection settings or login preference does not need restart',()=>{
 const {runtimeConfigChanged}=require('../app/settings.cjs');
 const base={browser:'chrome',autoStart:false,terminal:{id:'tunnel_a',ciphertext:'x'},playwrightExtension:{ciphertext:'y'}};
 assert.equal(runtimeConfigChanged(base,{...base,autoStart:true}),false);
 assert.equal(runtimeConfigChanged(base,{...base}),false);
 assert.equal(runtimeConfigChanged(base,{...base,browser:'msedge'}),true);
 assert.equal(runtimeConfigChanged(base,{...base,terminal:{...base.terminal,ciphertext:'z'}}),true);
 assert.equal(runtimeConfigChanged(base,{...base,playwrightExtension:undefined}),true);
});
