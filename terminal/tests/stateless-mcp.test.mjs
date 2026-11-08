import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp-test-'));
const config=path.join(root,'config.json'),data=path.join(root,'jobs');
const sparePort=()=>new Promise(resolve=>{
 const l=net.createServer().listen(0,'127.0.0.1',()=>{const p=l.address().port;l.close(()=>resolve(p))});
});
const port=await sparePort();
const binary=fileURLToPath(new URL('../stateless_server.js',import.meta.url));
const processMcp=spawn(process.execPath,[binary],{env:{...process.env,
 MCPGO_ONESHOT_PORT:String(port),MCPGO_ONESHOT_CONFIG:config,MCPGO_JOB_ROOT:data},
 stdio:['ignore','pipe','pipe']});
let stderr='';processMcp.stderr.on('data',b=>stderr+=b.toString().slice(-800));
for(let i=0;i<70;i++){
 if(processMcp.exitCode!==null)throw Error('Server exited: '+stderr);
 try{
  const status=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(100)});
  if(status.ok)break;
 }catch{}
 await new Promise(r=>setTimeout(r,50));
}
if(!fs.existsSync(config))throw Error('No isolated MCP configuration: '+stderr);
const endpoint='http://127.0.0.1:'+port+'/'+JSON.parse(fs.readFileSync(config,'utf8')).mcpPath;
after(async()=>{
 processMcp.kill('SIGTERM');
 if(processMcp.exitCode===null)await new Promise(resolve=>processMcp.once('close',resolve));
 fs.rmSync(root,{recursive:true,force:true});
});
let sequence=0;
async function tool(method,params){
 const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:
  JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})});
 const response=await res.json();
 assert.equal(res.status,200,JSON.stringify(response));
 assert.notEqual(response.result?.isError,true,JSON.stringify(response));
 return method==='tools/call'?JSON.parse(response.result.content[0].text):response.result;
}
test('MCP advertises durability, watch, pagination and cancel tools',async()=>{
 const names=(await tool('tools/list')).tools.map(x=>x.name);
 for(const n of ['job_start','job_recent','job_status','job_watch','job_logs','job_result','job_output','job_cancel'])
  assert.ok(names.includes(n),n);
});
test('MCP calls preserve job identity and return persisted completion',async()=>{
 const request={command:'printf hello',request_id:'mcp-recovery-0001'};
 const a=await tool('tools/call',{name:'job_start',arguments:request});
 const b=await tool('tools/call',{name:'job_start',arguments:request});
 assert.equal(a.job_id,b.job_id);assert.equal(b.deduplicated,true);
 let status=await tool('tools/call',{name:'job_watch',arguments:{job_id:a.job_id,wait_ms:2500}});
 for(let i=0;i<20&&status.state!=='exited';i++)
  status=await tool('tools/call',{name:'job_watch',arguments:{job_id:a.job_id,wait_ms:250}});
 assert.equal(status.state,'exited');assert.equal(status.exit_code,0);
 const final=await tool('tools/call',{name:'job_result',arguments:{job_id:a.job_id}});
 assert.equal(final.result_ready,true);assert.equal(final.summary.version,1);
 const chunk=await tool('tools/call',{name:'job_output',arguments:{job_id:a.job_id,max_bytes:100}});
 assert.equal(Buffer.from(chunk.data_base64,'base64').toString(),'hello');
 const recent=await tool('tools/call',{name:'job_recent',arguments:{limit:1}});
 assert.equal(recent.jobs[0].job_id,a.job_id);
});
