import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const proxyFile=path.resolve(here,'../restricted-proxy.mjs');
const backend=http.createServer();
let generation=1;
let currentSession='session-1';
let initialized=0, toolCalls=0, badToolCalls=0;
const payload=(id,result)=>'event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id,result})+'\n\n';
backend.on('request',async(req,res)=>{
 const parts=[];for await(const b of req)parts.push(b);
 const data=parts.length?JSON.parse(Buffer.concat(parts).toString()):{};
 const sid=req.headers['mcp-session-id'];
 if(data.method==='initialize'){
   initialized++;currentSession='session-'+generation;
   res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':currentSession});
   return res.end(payload(data.id,{protocolVersion:'2025-03-26',serverInfo:{name:'Fake Playwright',version:'1'},capabilities:{tools:{}}}));
 }
 if(sid!==currentSession){badToolCalls++;res.writeHead(404);return res.end('Session not found');}
 if(data.method==='notifications/initialized'){res.writeHead(202);return res.end();}
 if(data.method==='tools/list'){
   res.writeHead(200,{'content-type':'text/event-stream'});
   return res.end(payload(data.id,{tools:[{name:'browser_tabs'},{name:'browser_run_code_unsafe'}]}));
 }
 if(data.method==='tools/call'){
   toolCalls++;
   res.writeHead(200,{'content-type':'text/event-stream'});
   return res.end(payload(data.id,{content:[{type:'text',text:'### Result\nTabs'}]}));
 }
 res.writeHead(200);res.end('{}');
});
async function listen(server){server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));return server.address().port;}
const backPort=await listen(backend);
const reserved=http.createServer();const proxyPort=await listen(reserved);await new Promise(r=>reserved.close(r));
const proxy=spawn(process.execPath,[proxyFile,'shared'],{env:{...process.env,MCPGO_PROXY_PORT:String(proxyPort),MCPGO_BACKEND_PORT:String(backPort)},stdio:['ignore','pipe','pipe']});
let err='';
proxy.stderr.on('data',b=>err+=b.toString());
async function waitReady(){
 for(let n=0;n<50;n++){
  if(proxy.exitCode!==null)throw Error('Proxy exited: '+err);
  try{await fetch('http://127.0.0.1:'+proxyPort+'/mcp',{signal:AbortSignal.timeout(300)});return;}catch{}
  await new Promise(r=>setTimeout(r,80));
 }
 throw Error('Proxy did not start: '+err);
}
await waitReady();
after(async()=>{proxy.kill('SIGTERM');await new Promise(resolve=>backend.close(resolve));});
let id=1;
async function post(method,params){
 const body={jsonrpc:'2.0',method};if(method!=='notifications/initialized')body.id=id++;if(params)body.params=params;
 const result=await fetch('http://127.0.0.1:'+proxyPort+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(body)});
 const text=await result.text();
 return {status:result.status,session:result.headers.get('mcp-session-id'),text};
}
const initialize=()=>post('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
test('fresh initialize, initialized notification and filtered list',async()=>{
 const init=await initialize();assert.equal(init.status,200);
 assert.equal((await post('notifications/initialized')).status,202);
 const list=await post('tools/list');assert.equal(list.status,200);
 assert.match(list.text,/browser_tabs/);assert.doesNotMatch(list.text,/browser_run_code_unsafe/);
});
test('dead shared session is reinitialized for the next new client',async()=>{
 generation++;currentSession='session-'+generation;
 const init=await initialize();assert.equal(init.status,200);
 assert.equal(init.session,'session-'+generation);
 assert.equal((await post('notifications/initialized')).status,202);
 assert.equal((await post('tools/list')).status,200);
});
test('safe tools/list recovers after backend session is invalidated',async()=>{
 generation++;currentSession='session-'+generation;
 const list=await post('tools/list');
 assert.equal(list.status,200);assert.match(list.text,/browser_tabs/);
});
test('mutating browser action after expired session is not replayed',async()=>{
 generation++;currentSession='session-'+generation;
 const before=toolCalls;
 const r=await post('tools/call',{name:'browser_navigate',arguments:{url:'https://example.org'}});
 assert.equal(r.status,409);assert.equal(toolCalls,before);
 assert.match(r.text,/not replayed/);
});
test('fresh initialization restores functionality after a refused mutation',async()=>{
 const init=await initialize();assert.equal(init.status,200);
 assert.equal((await post('notifications/initialized')).status,202);
 assert.equal((await post('tools/list')).status,200);
});
