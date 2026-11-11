'use strict';
// Windows ConPTY worker. Isolated process with the same NDJSON protocol as
// pty_worker.py on macOS. Run under bundled Node, NOT Electron's main process.
const readline=require('node:readline');
const path=require('node:path');
const fs=require('node:fs');
function emit(message){
  process.stdout.write(JSON.stringify(message)+'\n');
}
let pty;
try{
  const modulePath=process.env.MCPGO_NODE_PTY_MODULE;
  if(!modulePath||!path.isAbsolute(modulePath)||!fs.existsSync(modulePath))
    throw Error('WINDOWS_PTY_MODULE_NOT_INSTALLED');
  pty=require(modulePath);
}catch(error){
  emit({event:'error',message:'ConPTY unavailable: '+String(error.code||error.message).slice(0,100)});
  process.exit(1);
}
const size={cols:100,rows:32};
const shell=process.env.MCPGO_PTY_SHELL || 'powershell.exe';
if(!['powershell.exe','pwsh.exe','cmd.exe'].includes(path.win32.basename(shell).toLowerCase())){
  emit({event:'error',message:'UNSUPPORTED_PTY_SHELL'});process.exit(2);
}
let child;
try{
  child=pty.spawn(shell,
    shell.toLowerCase().includes('powershell')?['-NoLogo','-NoProfile']:[],
    {name:'xterm-256color',...size,cwd:process.env.USERPROFILE||process.env.HOME||process.cwd(),
    env:{...process.env,TERM:'xterm-256color'}});
}catch(error){emit({event:'error',message:'ConPTY spawn failed: '+String(error.message).slice(0,120)});process.exit(3)}
let closed=false;
function finish(code){
 if(closed)return;closed=true;
 emit({event:'exit',code:Number.isInteger(code)?code:null});
 process.exit(0);
}
emit({event:'ready',pid:child.pid});
child.onData(value=>emit({event:'data',base64:Buffer.from(value,'utf8').toString('base64')}));
child.onExit(({exitCode})=>finish(exitCode));
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line',line=>{
  if(line.length>80000)return;
  let msg;try{msg=JSON.parse(line)}catch{return}
  try{
    if(msg.action==='write'&&typeof msg.text==='string'&&
      Buffer.byteLength(msg.text,'utf8')<=60000){
      child.write(msg.text+(msg.enter?'\r':''));
    }else if(msg.action==='interrupt')child.write('\x03');
    else if(msg.action==='resize'){
      const cols=Math.max(20,Math.min(300,Number(msg.cols)||100));
      const rows=Math.max(8,Math.min(100,Number(msg.rows)||32));
      child.resize(Math.floor(cols),Math.floor(rows));
    }else if(msg.action==='close'){child.kill();finish(null)}
  }catch(error){emit({event:'error',message:String(error.message).slice(0,120)})}
});
rl.once('close',()=>{if(!closed){child.kill();finish(null)}});
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{if(!closed){child.kill();finish(null)}});
