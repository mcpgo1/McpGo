'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const bridge=require('../stateful_bridge.cjs');
test('stateful bridge forwards only allowed tools to a private loopback MCP endpoint',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-bridge-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const privatePath='mcp/'+'f'.repeat(64);
 const config=path.join(dir,'config.json');
 fs.writeFileSync(config,JSON.stringify({mcpPath:privatePath}));
 const observed=[];
 const server=http.createServer(async(req,res)=>{
  observed.push(req.url);
  const parts=[];for await(const chunk of req)parts.push(chunk);
  const body=JSON.parse(Buffer.concat(parts).toString());
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,
   result:body.method==='tools/list'?{
    tools:[{name:'terminal_create'},{name:'terminal_read'},{name:'job_start'}]}:
    {content:[{type:'text',text:'ok'}]}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>server.close());
 const port=server.address().port;
 assert.equal(bridge.endpoint(config,port),'http://127.0.0.1:'+port+'/'+privatePath);
 assert.deepEqual((await bridge.list(config,port)).map(x=>x.name),
  ['terminal_create','terminal_read']);
 const response=await bridge.call(config,'terminal_read',{session_id:'x'},port);
 assert.equal(response.content[0].text,'ok');
 assert.deepEqual(observed,['/'+privatePath,'/'+privatePath]);
 await assert.rejects(bridge.call(config,'job_start',{},port),/UNSUPPORTED_STATEFUL_TOOL/);
});
test('malformed stateful capability never becomes a publicly reachable path',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-bridge-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config=path.join(dir,'state.json');
 fs.writeFileSync(config,'{"mcpPath":"../../admin"}');
 assert.throws(()=>bridge.endpoint(config),/STATEFUL_CONFIG_INVALID/);
});
