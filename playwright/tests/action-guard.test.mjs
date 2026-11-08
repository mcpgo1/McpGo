import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ActionGuard,isMutatingTool} from '../action-guard.mjs';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-action-guard-'));
after(()=>fs.rmSync(folder,{recursive:true,force:true}));

test('durable action receipt deduplicates, survives restart, contains no user URL or text',()=>{
 const a=new ActionGuard(path.join(folder,'unit'));
 const id='browser-action-test-00001';
 const args={url:'https://example.test/private',text:'PRIVATE_MESSAGE'};
 assert.equal(a.claim(id,'browser_type',args).claimed,true);
 assert.equal(a.claim(id,'browser_type',args).claimed,false);
 assert.equal(a.claim(id,'browser_click',args).state,'conflict');
 const b=new ActionGuard(path.join(folder,'unit'));
 assert.equal(b.lookup(id).state,'dispatched');
 a.finish(id,'completed',200);
 assert.equal(b.lookup(id).state,'completed');
 const contents=fs.readFileSync(a.filepath(id),'utf8');
 assert.doesNotMatch(contents,/PRIVATE_MESSAGE|example\.test/);
 assert.throws(()=>a.claim('bad','browser_click',args),/INVALID_ACTION_ID/);
});
test('browser_evaluate is potentially modifying, tabs:list is read only',()=>{
 assert.equal(isMutatingTool('browser_evaluate',{}),true);
 assert.equal(isMutatingTool('browser_click',{}),true);
 assert.equal(isMutatingTool('browser_tabs',{action:'list'}),false);
 assert.equal(isMutatingTool('browser_tabs',{action:'select',index:1}),true);
 assert.equal(isMutatingTool('browser_snapshot',{}),false);
});
const payload=(id,result)=>'event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id,result})+'\n\n';
let sid='test-browser-session',active=0,maxActive=0,clickCount=0;
const backend=http.createServer(async(req,res)=>{
 const chunks=[];for await(const part of req)chunks.push(part);
 const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
 if(body.method==='initialize'){
  res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':sid});
  return res.end(payload(body.id,{protocolVersion:'2025-03-26',serverInfo:{name:'fake',version:'1'},capabilities:{tools:{}}}));
 }
 if(body.method==='notifications/initialized'){res.writeHead(202);return res.end();}
 if(body.method==='tools/list'){
  res.writeHead(200,{'content-type':'text/event-stream'});
  return res.end(payload(body.id,{tools:[{name:'browser_click'},{name:'browser_tabs'}]}));
 }
 if(body.method==='tools/call'){
  active++;maxActive=Math.max(maxActive,active);
  const name=body.params.name;
  if(name==='browser_click')clickCount++;
  if(name==='browser_evaluate'){
   active--;
   res.writeHead(200,{'content-type':'text/event-stream'});
   return res.end(payload(body.id,{content:[{type:'text',
    text:'### Result\n'+JSON.stringify({url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001'})+
      '\n### Ran Playwright code\n() => ({url: location.href})'}]}));
  }
  if(name==='browser_click' && body.params.arguments?.target==='abort'){
   active--;res.destroy();return;
  }
  await new Promise(resolve=>setTimeout(resolve,110));
  active--;
  res.writeHead(200,{'content-type':'text/event-stream'});
  return res.end(payload(body.id,{content:[{type:'text',text:'done'}]}));
 }
 res.writeHead(400);res.end();
});
const listen=async server=>{
 server.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 return server.address().port;
};
const backendPort=await listen(backend);
const reserved=http.createServer(),proxyPort=await listen(reserved);
await new Promise(resolve=>reserved.close(resolve));
const proxy=spawn(process.execPath,[fileURLToPath(new URL('../restricted-proxy.mjs',import.meta.url)),'shared'],
 {env:{...process.env,MCPGO_PROXY_PORT:String(proxyPort),
  MCPGO_BACKEND_PORT:String(backendPort),
  MCPGO_ACTION_ROOT:path.join(folder,'integration')},stdio:['ignore','pipe','pipe']});
let proxyStderr='';
proxy.stderr.on('data',b=>proxyStderr+=b.toString());
after(async()=>{
 proxy.kill('SIGTERM');
 await new Promise(resolve=>backend.close(resolve));
});
const base='http://127.0.0.1:'+proxyPort+'/mcp';
async function waitReady(){
 for(let i=0;i<50;i++){
  if(proxy.exitCode!==null)throw Error('Proxy died: '+proxyStderr);
  try{await fetch(base,{signal:AbortSignal.timeout(150)});return}
  catch{await new Promise(r=>setTimeout(r,40))}
 }
 throw Error('Proxy not ready: '+proxyStderr);
}
await waitReady();
let sequence=0;
async function call(method,params,actionId,expectedUrl){
 const body={jsonrpc:'2.0',id:++sequence,method,params};
 const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
 if(actionId)headers['x-mcpgo-action-id']=actionId;
 if(expectedUrl)headers['x-mcpgo-expected-url']=expectedUrl;
 const res=await fetch(base,{method:'POST',headers,body:JSON.stringify(body)});
 const text=await res.text();
 return {status:res.status,text};
}
await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
await call('notifications/initialized');
test('proxy exposes read-only action status and blocks duplicate POST',async()=>{
 const list=await call('tools/list');
 assert.equal(list.status,200);
 assert.match(list.text,/mcpgo_action_status/);
 const id='browser-idempotency-000001';
 const first=await call('tools/call',{name:'browser_click',arguments:{target:'send'}},id);
 assert.equal(first.status,200);
 const prior=clickCount;
 const repeated=await call('tools/call',{name:'browser_click',arguments:{target:'send'}},id);
 assert.equal(repeated.status,409);
 assert.equal(clickCount,prior);
 const status=await call('tools/call',{name:'mcpgo_action_status',arguments:{request_id:id}});
 assert.equal(status.status,200);
 assert.match(status.text,/completed/);
});
test('a lost backend response stays unknown and does not dispatch again',async()=>{
 const id='browser-action-unknown-000002';
 const response=await call('tools/call',{name:'browser_click',arguments:{target:'abort'}},id);
 assert.equal(response.status,502);
 const prior=clickCount;
 const duplicate=await call('tools/call',{name:'browser_click',arguments:{target:'abort'}},id);
 assert.equal(duplicate.status,409);
 assert.equal(clickCount,prior);
 const receipt=await call('tools/call',{name:'mcpgo_action_status',arguments:{request_id:id}});
 assert.match(receipt.text,/unknown/);
});
test('shared browser tool calls are serialized across concurrent clients',async()=>{
 maxActive=0;
 const requests=Array.from({length:4},(_,i)=>
  call('tools/call',{name:'browser_click',arguments:{target:'item-'+i}},'serial-action-0000'+i));
 const results=await Promise.all(requests);
 assert.ok(results.every(x=>x.status===200),JSON.stringify(results));
 assert.equal(maxActive,1);
});
test('mutating JSON-RPC batch is refused without forwarding',async()=>{
 const before=clickCount;
 const response=await fetch(base,{method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify([
   {jsonrpc:'2.0',id:1000,method:'tools/call',params:{name:'browser_click',arguments:{target:'x'}}},
   {jsonrpc:'2.0',id:1001,method:'tools/call',params:{name:'browser_tabs',arguments:{action:'list'}}}
  ])});
 assert.equal(response.status,403);
 assert.equal(clickCount,before);
});

test('expected URL scope protects browser click from another client switching tabs',async()=>{
 const before=clickCount;
 const correct='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
 const wrong='https://chatgpt.com/c/00000000-0000-4000-8000-000000000099';
 const denied=await call('tools/call',{name:'browser_click',arguments:{target:'send'}},
  'url-guard-wrong-0001',wrong);
 assert.equal(denied.status,409);
 assert.equal(clickCount,before);
 const receipt=await call('tools/call',{name:'mcpgo_action_status',arguments:{request_id:'url-guard-wrong-0001'}});
 assert.match(receipt.text,/not_found/,'refused URL must not consume action ID');
 const accepted=await call('tools/call',{name:'browser_click',arguments:{target:'send'}},
  'url-guard-correct-0001',correct);
 assert.equal(accepted.status,200,accepted.text);
 assert.equal(clickCount,before+1);
});
