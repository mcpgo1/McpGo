import process from 'node:process';
import {modernHeaders,modernParams,MODERN_PROTOCOL} from './mcp-modern-protocol.mjs';

const base = process.env.PLAYWRIGHT_MCP_URL || 'http://127.0.0.1:8931/mcp';
let sessionId = '';
// Direct Playwright trials may use custom ports; retain legacy defaults for proxy callers.
const mode=process.env.PLAYWRIGHT_MCP_PROBE_MODE || (new URL(base).port==='8931'?'direct':'proxy');
const external=mode==='proxy';
const accept = 'application/json, text/event-stream';
const parse = text => {
  if (!text.trim()) return null;
  if (text.trim().startsWith('{')) return JSON.parse(text);
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch { /* other event */ }
    }
  }
  throw Error('Unexpected MCP response: ' + text.slice(0, 240));
};
async function send(id, method, params) {
  const body = { jsonrpc: '2.0', method };
  if (id !== null) body.id = id;
  if (params !== undefined) body.params = external?modernParams(params,'McpGo-Browser-Probe'):params;
  else if(external)body.params=modernParams({},'McpGo-Browser-Probe');
  const headers=external?modernHeaders(method,body.params):
    { accept, 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' };
  if (!external&&sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const newSessionId = response.headers.get('mcp-session-id');
  if (!external&&newSessionId) sessionId = newSessionId;
  const raw = await response.text();
  if (!response.ok) throw Error(method + ': HTTP ' + response.status + ' ' + raw.slice(0, 350));
  return parse(raw);
}
try {
  if(!['direct','proxy'].includes(mode))throw Error('Invalid PLAYWRIGHT_MCP_PROBE_MODE: expected direct or proxy');
  if(external){
    const discover=await send(1,'server/discover');
    if(!discover?.result?.supportedVersions?.includes(MODERN_PROTOCOL))
      throw Error('MCP modern discovery rejected');
    console.log('MCP_2026_DISCOVER=PASS');
  }else{
    const init=await send(1,'initialize',{protocolVersion:'2025-03-26',
      capabilities:{},clientInfo:{name:'mcpgo-private-backend-probe',version:'1.0.0'}});
    if(!init?.result?.serverInfo)throw Error('Private Playwright MCP initialize response lacks serverInfo');
    console.log('PRIVATE_PLAYWRIGHT_INITIALIZE=PASS');
    await send(null,'notifications/initialized');
  }
  const listed = await send(2, 'tools/list');
  const names = listed?.result?.tools?.map(t => t.name) ?? [];
  console.log('TOOLS_COUNT=' + names.length);
  if (!names.includes('browser_navigate') || !names.includes('browser_snapshot')) throw Error('Missing browser tools');
  console.log('TOOL_DISCOVERY=PASS');
  if (process.env.PLAYWRIGHT_MCP_REJECT_UNSAFE === '1') {
    if (names.includes('browser_run_code_unsafe')) throw Error('Unsafe tool is exposed in public MCP tool list');
    let rejected = false;
    try {
      const denied = await send(5, 'tools/call', {name:'browser_run_code_unsafe', arguments:{code:'async () => 1'}});
      rejected = Boolean(denied?.error);
    } catch (err) {
      rejected = /tools\/call: HTTP 403/.test(err.message);
    }
    if (!rejected) throw Error('Unsafe tool invocation was not rejected');
    console.log('UNSAFE_TOOL_FILTER=PASS');
    console.log('EXTERNAL_NAVIGATION_FILTER=DISABLED');
  }
  if (process.env.PLAYWRIGHT_MCP_VERIFY_TABS === '1') {
    const scope=external?await send(72,'tools/call',{name:'mcpgo_workspace',arguments:{}}):null;
    const workspaceId=scope?.result?.structuredContent?.workspace_id;
    if(external&&!workspaceId)throw Error('MCP workspace was not created');
    const tabs=await send(73,'tools/call',{name:'browser_tabs',
      arguments:{action:'list',...(external?{workspace_id:workspaceId}:{})}});
    const content=(tabs?.result?.content||[]).map(x=>x.text||'').join(' ');
    if (tabs?.error || tabs?.result?.isError || /extension did not connect|Invalid token|timed out/i.test(content))
      throw Error('CDP Playwright не подключился к вкладкам личного Chrome');
    if (!content.includes('### Result')) throw Error('Browser tab list missing');
    console.log('CHROME_CDP_TABS=PASS');
  }
  console.log('MCP_CONNECTIVITY_PROBE=PASS');
} catch (err) {
  console.error('MCP_CONNECTIVITY_PROBE=FAIL:',err.message);
  process.exitCode=1;
}
