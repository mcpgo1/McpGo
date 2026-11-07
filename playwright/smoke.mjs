import process from 'node:process';

const base = process.env.PLAYWRIGHT_MCP_URL || 'http://127.0.0.1:8931/mcp';
let sessionId = '';
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
  if (params !== undefined) body.params = params;
  const headers = { accept, 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const newSessionId = response.headers.get('mcp-session-id');
  if (newSessionId) sessionId = newSessionId;
  const raw = await response.text();
  if (!response.ok) throw Error(method + ': HTTP ' + response.status + ' ' + raw.slice(0, 350));
  return parse(raw);
}
try {
  const init = await send(1, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'mcpgo-playwright-smoke', version: '1.0.0' }
  });
  if (!init?.result?.serverInfo) throw Error('MCP initialize response lacks serverInfo');
  console.log('MCP_INITIALIZE=PASS');
  await send(null, 'notifications/initialized');
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
  const navigated = await send(3, 'tools/call', {name:'browser_navigate', arguments:{url:'about:blank'}});
  if (navigated?.error || navigated?.result?.isError) throw Error('Navigation failed: ' + JSON.stringify(navigated).slice(0, 400));
  console.log('CHROMIUM_NAVIGATE=PASS');
  const snapshot = await send(4, 'tools/call', {name:'browser_snapshot',arguments:{}});
  if (snapshot?.error || snapshot?.result?.isError) throw Error('Snapshot failed: ' + JSON.stringify(snapshot).slice(0, 400));
  console.log('CHROMIUM_SNAPSHOT=PASS');
  await send(6, 'tools/call', {name:'browser_close',arguments:{}});
  console.log('SMOKE_RESULT=PASS');
} catch (err) {
  console.error('SMOKE_RESULT=FAIL:',err.message);
  process.exitCode=1;
}
