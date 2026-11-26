'use strict';
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {record,register,scrub}=require('./diagnostics.cjs');
const ACTIONS=new Set(['status','connection-preflight','browser-check','discover','provision','import','runtime-projects',
  'runtime-inspect','runtime-auto','runtime-recover-key','verify-remote','chatgpt-instructions','dismiss','export-diagnostics']);
// Windows NTSTATUS may arrive as a signed or unsigned 32-bit integer.
function nativeExitCode(code){
 if(!Number.isInteger(code))return null;
 const unsigned=code>>>0;
 return unsigned>=0xc0000000?'0x'+unsigned.toString(16).toUpperCase().padStart(8,'0'):null;
}
function decodeReply(stdout,code,signal){
 const native=nativeExitCode(code);
 if(native)throw Object.assign(Error('ONBOARDING_NATIVE_CRASH '+native+': результат операции неизвестен; проверь сохранённое состояние перед повтором.'),{nativeExitCode:native});
 if(signal)throw Error('ONBOARDING_TERMINATED '+signal+': результат операции неизвестен.');
 let reply;
 try{reply=JSON.parse(stdout)}catch{throw Error(code===0?'ONBOARDING_INVALID_RESPONSE':'ONBOARDING_PROCESS_FAILED '+code)}
 if(reply?.ok!==true)throw Error(String(reply?.error||'ONBOARDING_FAILED').slice(0,180));
 if(code!==0)throw Error('ONBOARDING_PROCESS_FAILED '+code);
 return reply.result;
}
// These actions perform only reads or an idempotent verification of existing IDs.
const NATIVE_RETRY_SAFE=new Set(['status','browser-check','verify-remote']);
async function withNativeRetry(action,attempt,onRetry=()=>{}){
 try{return await attempt()}catch(error){
  if(!error?.nativeExitCode||!NATIVE_RETRY_SAFE.has(action))throw error;
  onRetry(error.nativeExitCode);
  return attempt();
 }
}
// Local best-effort WER lookup: correlate by PID and start time, retain only
// allowlisted fault metadata (no event message, user path or crash dump).
function collectWindowsNativeFault(pid,started){
 if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<=0||
    !Number.isSafeInteger(started)||!process.env.SystemRoot)return Promise.resolve(null);
 const exe=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const script=[
  '$ErrorActionPreference="Stop"',
  '$start=[DateTimeOffset]::FromUnixTimeMilliseconds('+started+').LocalDateTime',
  '$events=Get-WinEvent -FilterHashtable @{LogName="Application";Id=1000;StartTime=$start} -MaxEvents 30 -ErrorAction SilentlyContinue',
  'foreach($entry in $events){',
  ' $fields=@{}; foreach($field in ([xml]$entry.ToXml()).Event.EventData.Data){$fields[$field.Name]=[string]$field."#text"}',
  ' if($fields.AppName -ine "python.exe"){continue}',
  ' try{if($fields.ProcessId -match "^0x"){$faultPid=[Convert]::ToInt64($fields.ProcessId.Substring(2),16)}else{$faultPid=[long]$fields.ProcessId}}catch{continue}',
  ' if($faultPid -ne '+pid+'){continue}',
  ' @{module=$fields.ModuleName;exception=$fields.ExceptionCode;offset=$fields.FaultingOffset;version=$fields.ModuleVersion}|ConvertTo-Json -Compress;break',
  '}'
 ].join('\n');
 return new Promise(resolve=>{
  execFile(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
   {windowsHide:true,timeout:4000,maxBuffer:8192,encoding:'utf8'},(error,stdout)=>{
    if(error)return resolve(null);
    try{
     const raw=JSON.parse(stdout),safe={};
     for(const key of ['module','exception','offset','version']){
      const value=raw[key];
      if(typeof value==='string'&&/^[A-Za-z0-9_. -]{1,128}$/.test(value))safe[key]=value;
     }
     resolve(Object.keys(safe).length?safe:null);
    }catch{resolve(null)}
   });
 });
}
async function onboarding(options){
 return withNativeRetry(options.action,()=>onboardingOnce(options),code=>{
  record(options.userData,'windows.onboarding.native_retry',{action:options.action,code});
 });
}
async function onboardingOnce({action,payload,root,userData,python}){
 if(!ACTIONS.has(action))throw Error('UNSUPPORTED_ONBOARDING_ACTION');
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('INVALID_ONBOARDING_INPUT');
 register(payload);
 record(userData,'windows.onboarding.request',{action,payload});
 const serialized=JSON.stringify(payload);
 if(Buffer.byteLength(serialized,'utf8')>16384)throw Error('ONBOARDING_INPUT_TOO_LARGE');
 const script=path.join(root,'onboarding_cli.py');
 const command=python||path.join(root,'python','python.exe');
 return new Promise((resolve,reject)=>{
  const started=Date.now();
  record(userData,'windows.onboarding.spawn',{action,script,command});
  const child=spawn(command,['-E','-B','-X','utf8','-X','faulthandler',script,action],{cwd:root,windowsHide:true,
   stdio:['pipe','pipe','pipe'],env:{
    ...process.env,MCPGO_USER_DATA:userData,MCPGO_RESOURCE_ROOT:root,
    MCPGO_TUNNEL_CLIENT:path.join(root,'tunnel','tunnel-client.exe'),
    PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',MCPGO_ONBOARDING_PROGRESS:'1'
   }});
  let stdout='',size=0,done=false;
  const fail=error=>{if(done)return;done=true;clearInterval(timer);record(userData,'windows.onboarding.failure',{action,error:scrub(error?.message),durationMs:Date.now()-started});reject(error)};
  const deadline=['runtime-auto','runtime-recover-key','provision'].includes(action)?900000:240000;
  let lastProgress=Date.now();
  const timer=setInterval(()=>{
    if(Date.now()-started>=deadline||Date.now()-lastProgress>=120000){
      clearInterval(timer);child.kill();
      fail(Error('ONBOARDING_TIMEOUT: результат операции неизвестен; проверь сохранённое состояние перед повтором.'));
    }
  },5000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{size+=Buffer.byteLength(chunk);
    if(size>131072){child.kill();fail(Error('ONBOARDING_OUTPUT_TOO_LARGE'))}
    else stdout+=chunk;
  });
  let stderrBytes=0,stderr='',progressTail='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{
    stderrBytes+=Buffer.byteLength(chunk);
    const lines=(progressTail+chunk).split(/\r?\n/);
    progressTail=(lines.pop()||'').slice(-256);
    for(const line of lines)if(/^MCPGO_PROGRESS [A-Za-z0-9._:-]+$/.test(line))lastProgress=Date.now();
    if(stderr.length<131072)stderr+=chunk.slice(0,131072-stderr.length);
  });
  child.on('error',error=>{clearInterval(timer);fail(Error('ONBOARDING_START_FAILED_'+(error.code||'')))});
  child.on('close',async(code,signal)=>{
    record(userData,'windows.onboarding.exit',{action,code,signal,nativeExitCode:nativeExitCode(code),durationMs:Date.now()-started,stdoutBytes:size,stderrBytes,stderr:scrub(stderr),stderrTruncated:stderrBytes>131072});
    clearInterval(timer);if(done)return;
    let result;
    try{result=decodeReply(stdout,code,signal)}catch(error){
      if(error.nativeExitCode){
        const fault=await collectWindowsNativeFault(child.pid,started).catch(()=>null);
        record(userData,'windows.onboarding.native_fault',{action,code:error.nativeExitCode,pid:child.pid,fault});
      }
      return fail(error);
    }
    record(userData,'windows.onboarding.success',{action,result,durationMs:Date.now()-started});
    done=true;resolve(result);
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(serialized);
 });
}
module.exports={onboarding,ACTIONS,nativeExitCode,decodeReply,withNativeRetry};
