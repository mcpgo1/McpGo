/**
 * Read-only MCP readiness check through the actual safe proxy.
 * TCP connect is NOT sufficient: a cached MCP session can have expired.
 * Never calls browser mutation tools or opens a ChatGPT conversation.
 */
export async function probeMcp(url='http://127.0.0.1:8940/mcp',fetchImpl=fetch){
  let sid='';
  let id=0;
  async function send(method,params){
    const body={jsonrpc:'2.0',method};
    if(method!=='notifications/initialized')body.id=++id;
    if(params!==undefined)body.params=params;
    const headers={'content-type':'application/json',accept:'application/json, text/event-stream',
      'mcp-protocol-version':'2025-03-26'};
    if(sid)headers['mcp-session-id']=sid;
    const response=await fetchImpl(url,{method:'POST',headers,
      body:JSON.stringify(body),signal:AbortSignal.timeout(method==='tools/call'?6500:5000)});
    sid=response.headers.get('mcp-session-id')||sid;
    const text=await response.text();
    if(!response.ok)throw Error(method+' HTTP '+response.status);
    if(method==='notifications/initialized')return null;
    const first=text.trim().startsWith('{')?text: text.split(/\r?\n/).find(x=>x.startsWith('data: '))?.slice(6);
    if(!first)throw Error('No MCP response');
    return JSON.parse(first);
  }
  const init=await send('initialize',{protocolVersion:'2025-03-26',
    capabilities:{},clientInfo:{name:'McpGo-Dashboard-Health',version:'1.0'}});
  if(!init?.result?.serverInfo)throw Error('MCP initialize invalid');
  await send('notifications/initialized');
  const list=await send('tools/list');
  const names=list?.result?.tools?.map(x=>x.name)||[];
  if(!names.includes('browser_tabs')||!names.includes('browser_snapshot')||
    names.includes('browser_run_code_unsafe'))throw Error('MCP tools/list invalid');
  // Tools can be advertised while Chrome CDP is disconnected.
  // A read-only tab listing verifies the actual browser connection.
  const tabs=await send('tools/call',{name:'browser_tabs',arguments:{action:'list'}});
  if(tabs?.error||tabs?.result?.isError)throw Error('Chrome CDP tab listing failed');
  const content=(tabs?.result?.content||[]).map(x=>x.text||'').join('\n');
  if(!content.includes('### Result'))throw Error('Chrome CDP tabs unavailable');
  return true;
}
