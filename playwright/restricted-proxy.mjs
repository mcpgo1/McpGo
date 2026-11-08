import http from 'node:http';
import {ActionGuard,isMutatingTool,ACTION_STATUS_TOOL} from './action-guard.mjs';

const MODE = process.argv[2] || 'shared';
if (MODE !== 'shared') throw Error('Only the shared personal Chrome CDP mode is supported');
const [LISTEN_PORT,BACKEND_PORT] = [Number(process.env.MCPGO_PROXY_PORT||8940),Number(process.env.MCPGO_BACKEND_PORT||8931)];
const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
// Reuse one backend MCP session for all short-lived client connections.
// Chrome requires user confirmation on each new CDP attach, so preserving
// the backend browser session prevents repeated security prompts.
let sharedSessionId = null;
let cachedInit = null;
let initPayload = null;
let initVersion = '2025-03-26';
let initInFlight = null;
const actionGuard=new ActionGuard();
// A shared Chrome context is not safe for simultaneous browser tool calls:
// one client can otherwise change the active tab while another is clicking.
let callTail=Promise.resolve(),queuedCalls=0;
async function acquireBrowserLock(){
 if(queuedCalls>=16)throw Error('BROWSER_QUEUE_FULL');
 queuedCalls++;
 let release;
 const turn=new Promise(resolve=>{release=resolve});
 const predecessor=callTail;
 callTail=turn;
 try{await predecessor}finally{queuedCalls--}
 return release;
}


// Always scope requests to the upstream session. Do not leak downstream
// session IDs from different MCP clients into the shared Chrome backend.
function upstreamRequest(payload, headers={}, method='POST', timeout=12000) {
  return new Promise((resolve,reject) => {
    const data=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));
    const request=http.request({hostname:'127.0.0.1',port:BACKEND_PORT,path:'/mcp',
      method,timeout,headers:{host:'localhost:'+BACKEND_PORT,
        accept:'application/json, text/event-stream','content-type':'application/json',
        'mcp-protocol-version':initVersion,...headers,
        ...(method==='POST'?{'content-length':String(data.length)}:{})}},up=>{
      const parts=[];let size=0;
      up.on('data',chunk=>{size+=chunk.length;if(size>MAX_RESPONSE){up.destroy(Error('MCP response too large'));return;}parts.push(chunk);});
      up.on('end',()=>resolve({status:up.statusCode||502,headers:up.headers,body:Buffer.concat(parts)}));
    });
    request.on('timeout',()=>request.destroy(Error('MCP backend timeout')));
    request.on('error',reject);
    request.end(method==='POST'?data:undefined);
  });
}
function expireSession(expected=sharedSessionId){
  // Do not erase a newer session while another concurrent request finishes.
  if (expected!==sharedSessionId) return;
  sharedSessionId=null;
  cachedInit=null;
}
async function initializeOnce(payload,protocolVersion){
  if(cachedInit && sharedSessionId)return cachedInit;
  if(initInFlight)return initInFlight;
  initPayload=payload;
  initVersion=protocolVersion||'2025-03-26';
  const pending=(async()=>{
    const response=await upstreamRequest(payload,{},'POST',16000);
    const sid=response.headers['mcp-session-id'];
    if(response.status!==200||typeof sid!=='string'||!sid.length)
      throw Error('MCP initialize unsuccessful ('+response.status+')');
    sharedSessionId=sid;
    cachedInit=response.body.toString('utf8');
    return cachedInit;
  })();
  initInFlight=pending;
  try{return await pending;}finally{if(initInFlight===pending)initInFlight=null;}
}
function isExpired(response){
  return response.status===404 && /Session not found/i.test(response.body.toString('utf8'));
}
// Revalidate on each downstream initialize, because backend can restart while
// this proxy remains alive. One tools/list is a read-only liveness probe.
async function ensureValidInitialize(payload,protocolVersion){
  if(sharedSessionId&&cachedInit){
    const previous=sharedSessionId;
    try{
      const check=await upstreamRequest({jsonrpc:'2.0',id:'session-health',method:'tools/list'},
        {'mcp-session-id':previous});
      if(check.status===200)return cachedInit;
      if(!isExpired(check))throw Error('MCP health failed ('+check.status+')');
      expireSession(previous);
    }catch(e){
      if(sharedSessionId===previous&&!/Session not found/.test(e.message))throw e;
    }
  }
  return initializeOnce(payload,protocolVersion);
}
function safeToRetry(payload){
  // Never re-run a potentially modifying browser tool after an unknown outcome.
  return payload?.method==='notifications/initialized'||payload?.method==='tools/list'||
    (payload?.method==='tools/call' && payload?.params?.name==='browser_tabs' &&
      payload?.params?.arguments?.action==='list');
}
async function ensureSessionAfterExpiry(payload,oldSession){
  expireSession(oldSession);
  if(!initPayload)throw Error('No initialization payload available');
  await initializeOnce(initPayload,initVersion);
  const newSession=sharedSessionId;
  if(payload?.method!=='notifications/initialized'){
    const ready=await upstreamRequest({jsonrpc:'2.0',method:'notifications/initialized'},
      {'mcp-session-id':newSession});
    if(ready.status!==200&&ready.status!==202&&ready.status!==204)throw Error('MCP session initialization notification failed');
  }
  return newSession;
}
const rewriteJsonRpcId = (raw,id) => {
  const text=raw.trim();
  if (text.startsWith('{')) { const obj=JSON.parse(text);obj.id=id;return JSON.stringify(obj); }
  return text.replace(/^data: (.+)$/gm,(line,json)=>{
    try {const obj=JSON.parse(json);if ('id' in obj)obj.id=id;return 'data: '+JSON.stringify(obj);}
    catch{return line;}
  });
};

const UNSAFE = new Set(['browser_run_code_unsafe']);

const inspectCall = payload => {
  const entries = Array.isArray(payload) ? payload : [payload];
  for (const entry of entries) {
    if (entry?.method !== 'tools/call') continue;
    const name = entry?.params?.name;
    if (typeof name !== 'string' || UNSAFE.has(name)) return 'Unsafe or missing tool name';
    const args = entry.params?.arguments || {};
    if(entries.length>1 && isMutatingTool(name,args))
      return 'Mutating browser actions must be submitted one at a time';
  }
  return null;
};
const isToolsList = payload => (Array.isArray(payload) ? payload : [payload]).some(x => x?.method === 'tools/list');
const stripTools = message => {
  if (!message || typeof message !== 'object') return message;
  if (Array.isArray(message)) return message.map(stripTools);
  if (Array.isArray(message.result?.tools)) {
    message.result.tools = message.result.tools.filter(t => !UNSAFE.has(t.name));
    if(!message.result.tools.some(t=>t.name===ACTION_STATUS_TOOL.name))message.result.tools.push(ACTION_STATUS_TOOL);
  }
  return message;
};
const filterResponse = (raw, contentType) => {
  const source = raw.toString('utf8');
  if (contentType.includes('text/event-stream')) {
    return Buffer.from(source.replace(/^data:\s*(\{[^\r\n]*\})\r?$/gm, (line, obj) => {
      try { return 'data: ' + JSON.stringify(stripTools(JSON.parse(obj))); }
      catch { return line; }
    }), 'utf8');
  }
  return Buffer.from(JSON.stringify(stripTools(JSON.parse(source))), 'utf8');
};
const error = (res, status, reason, id = null) => {
  const body = JSON.stringify({jsonrpc:'2.0', id, error:{code:status === 403 ? -32601 : -32600,message:reason}});
  res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'});
  res.end(body);
};
// The remote ChatGPT connector may create a fresh MCP session for each tool call.
// Populate the tab index table in the same session immediately before select/close.
async function warmupTabIndices(headers) {
  const payload=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:'tab-index-sync',method:'tools/call',
    params:{name:'browser_tabs',arguments:{action:'list'}}}));
  return await new Promise(resolve => {
    const backend=http.request({hostname:'127.0.0.1',port:BACKEND_PORT,path:'/mcp',method:'POST',
      headers:{...headers,'content-length':String(payload.length)},timeout:12000},up=>{
        up.resume();up.on('end',()=>resolve(up.statusCode===200));
      });
    backend.on('timeout',()=>{backend.destroy();resolve(false);});
    backend.on('error',()=>resolve(false));
    backend.end(payload);
  });
}


/** A page-scoped modifying action must target the exact active tab.
 * Read the current URL inside the same serialized critical section immediately
 * before dispatching a browser action. Fail closed if Playwright cannot prove it.
 */
function extractMcpToolText(response){
 const raw=response.body.toString('utf8');
 let obj=null;
 if(raw.trimStart().startsWith('{'))obj=JSON.parse(raw);
 else for(const line of raw.split(/\r?\n/)){
  if(line.startsWith('data: ')){
   try{const candidate=JSON.parse(line.slice(6));if(candidate?.result){obj=candidate;break}}
   catch{}
  }
 }
 return (obj?.result?.content||[]).filter(c=>c?.type==='text').map(c=>c.text||'').join('\n');
}
function parseActiveUrl(response){
 if(response.status!==200)return null;
 try{
  const content=extractMcpToolText(response);
  const section=content.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
  const raw=(section?.[1]||content).trim();
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const value=JSON.parse((fenced?.[1]||raw).trim());
  return typeof value?.url==='string'?value.url:null;
 }catch{return null}
}
async function verifyActiveUrl(headers,expected){
 const answer=await upstreamRequest({jsonrpc:'2.0',id:'mcpgo-scope-check',method:'tools/call',
  params:{name:'browser_evaluate',arguments:{function:'() => ({url: location.href})'}}},headers,'POST',12000);
 return parseActiveUrl(answer)===expected;
}

const server = http.createServer(async (req,res) => {
  const reqHost = String(req.headers.host || '').toLowerCase();
  if (!['localhost:'+LISTEN_PORT,'127.0.0.1:'+LISTEN_PORT].includes(reqHost)) return error(res,403,'Host forbidden');
  if (req.url !== '/mcp') return error(res,404,'Only /mcp is exposed');
  if (!['GET','POST','DELETE'].includes(req.method)) return error(res,405,'Method forbidden');

  const chunks = [];
  let count = 0;
  try {
    for await (const part of req) {
      count += part.length;
      if (count > MAX_BODY) return error(res,413,'MCP request too large');
      chunks.push(part);
    }
    const body = Buffer.concat(chunks);
    let data = null;
    if (req.method === 'POST') {
      try { data = JSON.parse(body.toString('utf8')); }
      catch { return error(res,400,'Invalid MCP JSON'); }
      const reason = inspectCall(data);
      if (reason) return error(res,403,reason,data?.id ?? null);
    }
    // A fresh ChatGPT connection may share an upstream Chrome session, but
    // we must verify it actually still exists before advertising readiness.
    if(req.method==='POST'&&data?.method==='initialize'){
      try{
        const initial=await ensureValidInitialize(data,req.headers['mcp-protocol-version']);
        const result=rewriteJsonRpcId(initial,data.id);
        res.writeHead(200,{'content-type':initial.trim().startsWith('{')?'application/json':'text/event-stream',
          'mcp-session-id':sharedSessionId,'cache-control':'no-store'});
        return res.end(result);
      }catch{
        return error(res,502,'Shared MCP initialization failed');
      }
    }
    if(req.method==='DELETE'){
      // Do not tear down the shared browser session on client disconnect.
      res.writeHead(200,{'cache-control':'no-store'});return res.end();
    }
    if(!sharedSessionId)return error(res,503,'MCP session not initialized');
    if(req.method==='POST'&&data?.method==='tools/call'&&data.params?.name===ACTION_STATUS_TOOL.name){
      try{
       const value=actionGuard.lookup(data.params.arguments?.request_id);
       const reply=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:data.id,
        result:{content:[{type:'text',text:JSON.stringify(value)}]}}));
       res.writeHead(200,{'content-type':'application/json','cache-control':'no-store',
        'mcp-session-id':sharedSessionId,'content-length':String(reply.length)});
       return res.end(reply);
      }catch{return error(res,400,'Invalid browser action receipt ID',data?.id??null);}
    }
    const isBrowserCall=req.method==='POST'&&data?.method==='tools/call';
    let unlock=null;
    try{
     if(isBrowserCall)unlock=await acquireBrowserLock();
    }catch{return error(res,429,'Browser action queue full',data?.id??null);}
    try {
     // Never dispatch queued actions after the requesting client vanished.
     if(res.destroyed)return;
     const name=data?.params?.name,args=data?.params?.arguments||{};
     const mutating=isBrowserCall&&isMutatingTool(name,args);
     const actionId=req.headers['x-mcpgo-action-id'];
     if(actionId && !mutating)return error(res,400,'Action ID is only valid for a modifying browser tool',data?.id??null);
    const oldSession=sharedSessionId;
    const headers={'mcp-session-id':oldSession,'mcp-protocol-version':req.headers['mcp-protocol-version']||initVersion};
    const tabs=data?.method==='tools/call'&&data?.params?.name==='browser_tabs' ? data.params.arguments : null;
    if(req.method==='POST'&&['select','close'].includes(tabs?.action)&&Number.isInteger(tabs?.index)){
      const warmup=await warmupTabIndices({...headers,host:'localhost:'+BACKEND_PORT,accept:'application/json, text/event-stream','content-type':'application/json'});
      if(!warmup)return error(res,503,'Browser tab index synchronization failed; not executing action',data?.id??null);
    }
    const expected=req.headers['x-mcpgo-expected-url'];
    if(expected){
     if(!mutating||typeof expected!=='string'||expected.length>2048)
      return error(res,400,'Invalid browser action URL guard',data?.id??null);
     let url;
     try{url=new URL(expected)}catch{return error(res,400,'Invalid expected URL',data?.id??null)}
     if(!['https:','http:'].includes(url.protocol) || url.href!==expected)
      return error(res,400,'Expected URL must be a canonical HTTP(S) URL',data?.id??null);
     let same=false;
     try{same=await verifyActiveUrl(headers,expected)}catch{}
     if(!same)return error(res,409,'Active Chrome tab does not match expected URL. No action dispatched.',data?.id??null);
    }
     if(actionId){
      if(typeof actionId!=='string')return error(res,400,'Invalid action ID',data?.id??null);
      let receipt;
      try{receipt=actionGuard.claim(actionId,name,args)}
      catch{return error(res,400,'Invalid browser action ID or receipt store',data?.id??null)}
      if(!receipt.claimed)
       return error(res,409,'Browser action already dispatched or unknown. Use mcpgo_action_status; never replay.',data?.id??null);
     }
    let upstream;
    try{upstream=await upstreamRequest(body,headers,req.method,data?.method==='tools/call'?40000:12000)}
    catch(e){
      if(actionId)actionGuard.finish(actionId,'unknown',null);
      throw e;
    }
    if(actionId)actionGuard.finish(actionId,upstream.status===200?'completed':'unknown',upstream.status);
    if(isExpired(upstream)){
      expireSession(oldSession);
      if(req.method!=='POST'||!safeToRetry(data))
        return error(res,409,'MCP session expired; action not replayed. Reconnect and verify outcome.',data?.id??null);
      try{
        const sid=await ensureSessionAfterExpiry(data,oldSession);
        upstream=await upstreamRequest(body,{'mcp-session-id':sid},req.method,data?.method==='tools/call'?40000:12000);
      }catch{return error(res,502,'MCP session recovery failed',data?.id??null);}
    }
    if(isExpired(upstream)){
      expireSession(sharedSessionId);
      return error(res,503,'MCP session expired during recovery',data?.id??null);
    }
    if(isToolsList(data)&&upstream.status===200){
      try{
        const filtered=filterResponse(upstream.body,String(upstream.headers['content-type']||''));
        res.writeHead(200,{'content-type':upstream.headers['content-type']||'application/json',
          'mcp-session-id':sharedSessionId,'content-length':String(filtered.length),'cache-control':'no-store'});
        return res.end(filtered);
      }catch{return error(res,502,'Failed to sanitize tools/list response',data?.id??null);}
    }
    const responseHeaders={...upstream.headers,'content-length':String(upstream.body.length),'cache-control':'no-store'};
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders['content-encoding'];
    res.writeHead(upstream.status,responseHeaders);
    res.end(upstream.body);
    }finally{if(unlock)unlock()}
  } catch {
    if (!res.writableEnded) error(res,502,'MCP backend request failed or timed out');
  }
});
server.listen(LISTEN_PORT,'127.0.0.1',()=>{
  console.log('Safe Playwright MCP proxy at http://localhost:' + LISTEN_PORT + '/mcp');
  console.log('Serializes shared-browser tool calls; optional durable write receipts; unsafe arbitrary code blocked');
});
