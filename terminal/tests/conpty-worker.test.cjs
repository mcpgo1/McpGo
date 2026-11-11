'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
test('ConPTY worker keeps macOS-compatible ready/data/exit NDJSON protocol',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-pty-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const moduleFile=path.join(dir,'fake-pty.js');
 fs.writeFileSync(moduleFile,
  "exports.spawn=()=>({pid:12345,onData(cb){this.data=cb},onExit(cb){this.exit=cb},write(x){this.data(x)},resize(){},kill(){this.exit({exitCode:0})}});\n");
 const worker=path.resolve(__dirname,'../pty_worker_win.js');
 const child=spawn(process.execPath,[worker],{env:{...process.env,
  MCPGO_NODE_PTY_MODULE:moduleFile,MCPGO_PTY_SHELL:'powershell.exe'},stdio:['pipe','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill()});
 let output='',lines=[];
 const done=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('TIMEOUT')),2500);
  child.stdout.on('data',chunk=>{
   output+=chunk.toString('utf8');
   let index;
   while((index=output.indexOf('\n'))>=0){
    const row=JSON.parse(output.slice(0,index));output=output.slice(index+1);
    lines.push(row);
    if(row.event==='ready')child.stdin.write(JSON.stringify({action:'write',text:'hello',enter:true})+'\n');
    if(row.event==='data')child.stdin.write(JSON.stringify({action:'close'})+'\n');
    if(row.event==='exit'){clearTimeout(timer);resolve()}
   }
  });
  child.on('error',reject);
 });
 await done;
 assert.equal(lines[0].event,'ready');
 assert.equal(lines[0].pid,12345);
 assert.equal(Buffer.from(lines[1].base64,'base64').toString('utf8'),'hello\r');
 assert.equal(lines.at(-1).event,'exit');
});
