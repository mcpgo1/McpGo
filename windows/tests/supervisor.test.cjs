'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Runtime}=require('../app/runtime.cjs');
function directory(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-supervisor-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return dir;
}
async function waitFor(fn,timeout=2500){
 const start=Date.now();
 while(Date.now()-start<timeout){
  if(fn())return;
  await new Promise(r=>setTimeout(r,25));
 }
 throw Error('WAIT_TIMEOUT');
}
test('supervisor starts existing JS service, exposes status and cleans process tree',async t=>{
 const dir=directory(t),script=path.join(dir,'playwright/node_modules/@playwright/mcp/cli.js');
 fs.mkdirSync(path.dirname(script),{recursive:true});
 fs.writeFileSync(script,"setInterval(()=>{},1000);\n");
 const agent=new Runtime({resourceRoot:dir,userData:path.join(dir,'user'),
   nodeExecutable:process.execPath,credentials:async()=>null});
 t.after(()=>agent.stop());
 agent.running=true;
 await agent.launch('browser');
 await waitFor(()=>agent.state().browser==='running');
 const pid=agent.entries.get('browser').child.pid;
 assert.equal(typeof pid,'number');
 agent.stop();
 assert.equal(agent.state().browser,'stopped');
 assert.equal(agent.running,false);
});
test('missing executable does not masquerade as a connected service',async t=>{
 const dir=directory(t);
 const agent=new Runtime({resourceRoot:dir,userData:path.join(dir,'user'),
   nodeExecutable:path.join(dir,'missing-node'),credentials:async()=>null});
 t.after(()=>agent.stop());
 agent.running=true;
 await agent.launch('terminal');
 await waitFor(()=>agent.state().terminal.startsWith('error:'));
 assert.ok(agent.entries.get('terminal').timer);
 agent.stop();
 assert.equal(agent.entries.get('terminal'),undefined);
});
