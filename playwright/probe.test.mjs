import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {MODERN_PROTOCOL,validateModernRequest} from './mcp-modern-protocol.mjs';

// Isolate each probe run and replace only fetch: no real Chrome, ports or tokens.
function runProbe({url,mode,tabs=false,unsafe=false}) {
  const env={...process.env,PLAYWRIGHT_MCP_URL:url};
  for(const key of ['PLAYWRIGHT_MCP_PROBE_MODE','PLAYWRIGHT_MCP_VERIFY_TABS',
    'PLAYWRIGHT_MCP_REJECT_UNSAFE']) delete env[key];
  if(mode!==undefined)env.PLAYWRIGHT_MCP_PROBE_MODE=mode;
  if(tabs)env.PLAYWRIGHT_MCP_VERIFY_TABS='1';
  if(unsafe)env.PLAYWRIGHT_MCP_REJECT_UNSAFE='1';
  const script=`
    const requests=[];
    globalThis.fetch=async (url,options)=>{
      const body=JSON.parse(options.body);
      requests.push({url,headers:options.headers,body});
      let result;
      if(body.method==='initialize')result={serverInfo:{name:'fixture',version:'1'}};
      else if(body.method==='notifications/initialized')return new Response(null,{status:202});
      else if(body.method==='server/discover')result={supportedVersions:['${MODERN_PROTOCOL}']};
      else if(body.method==='tools/list')result={tools:[{name:'browser_navigate'},{name:'browser_snapshot'}]};
      else if(body.params.name==='mcpgo_workspace')result={structuredContent:{workspace_id:'fixture-workspace'}};
      else if(body.params.name==='browser_tabs')result={content:[{type:'text',text:'### Result\\nFixture tabs'}]};
      else if(body.params.name==='browser_run_code_unsafe')
        return Response.json({jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Denied by fixture'}});
      else throw Error('Unexpected fixture request');
      return Response.json({jsonrpc:'2.0',id:body.id,result},{headers:{'mcp-session-id':'fixture-session'}});
    };
    await import(${JSON.stringify(new URL('./probe.mjs',import.meta.url).href)});
    console.log('REQUESTS='+JSON.stringify(requests));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',script],
    {env,encoding:'utf8',timeout:10000});
  assert.ifError(child.error);
  const marker=child.stdout.split('\n').find(line=>line.startsWith('REQUESTS='));
  assert.ok(marker,child.stdout+child.stderr);
  return {...child,requests:JSON.parse(marker.slice('REQUESTS='.length))};
}

function assertDirect(run,{tabs=false}={}) {
  assert.equal(run.status,0,run.stdout+run.stderr);
  const {requests}=run;
  assert.deepEqual(requests.map(r=>r.body.method),
    ['initialize','notifications/initialized','tools/list',...(tabs?['tools/call']:[])]);
  assert.equal(requests[0].body.params.protocolVersion,'2025-03-26');
  assert.equal(requests[0].headers['mcp-session-id'],undefined);
  assert.equal(requests[1].body.id,undefined);
  for(const request of requests){
    assert.equal(request.headers['mcp-protocol-version'],'2025-03-26');
    assert.equal(request.headers['mcp-method'],undefined);
    assert.equal(request.body.params?._meta,undefined);
  }
  for(const request of requests.slice(1))
    assert.equal(request.headers['mcp-session-id'],'fixture-session');
  if(tabs){
    assert.equal(requests[3].body.params.name,'browser_tabs');
    assert.deepEqual(requests[3].body.params.arguments,{action:'list'});
    assert.match(run.stdout,/CHROME_CDP_TABS=PASS/);
  }
  assert.match(run.stdout,/PRIVATE_PLAYWRIGHT_INITIALIZE=PASS/);
  assert.match(run.stdout,/MCP_CONNECTIVITY_PROBE=PASS/);
}

function assertProxy(run,{tabs=false}={}) {
  assert.equal(run.status,0,run.stdout+run.stderr);
  const {requests}=run;
  assert.equal(requests[0].body.method,'server/discover');
  assert.equal(requests[1].body.method,'tools/list');
  for(const request of requests){
    assert.equal(validateModernRequest(request.headers,request.body),null);
    assert.equal(request.headers['mcp-session-id'],undefined);
  }
  if(tabs){
    assert.deepEqual(requests.slice(2).map(r=>r.body.params.name),['mcpgo_workspace','browser_tabs']);
    assert.deepEqual(requests[3].body.params.arguments,{action:'list',workspace_id:'fixture-workspace'});
  }
  assert.match(run.stdout,/MCP_2026_DISCOVER=PASS/);
  assert.match(run.stdout,/MCP_CONNECTIVITY_PROBE=PASS/);
}

test('explicit direct onboarding port initializes and lists tabs without a proxy workspace',()=>{
  assertDirect(runProbe({url:'http://127.0.0.1:8999/mcp',mode:'direct',tabs:true}),{tabs:true});
});
test('explicit direct arbitrary port uses the standard session handshake',()=>{
  assertDirect(runProbe({url:'http://127.0.0.1:19099/mcp',mode:'direct'}));
});
test('legacy private port keeps direct mode without an override',()=>{
  assertDirect(runProbe({url:'http://127.0.0.1:8931/mcp',tabs:true}),{tabs:true});
});
test('legacy proxy port keeps modern discovery and workspace-scoped tabs',()=>{
  assertProxy(runProbe({url:'http://127.0.0.1:8940/mcp',tabs:true}),{tabs:true});
});
test('legacy non-private ports keep proxy mode',()=>{
  assertProxy(runProbe({url:'http://127.0.0.1:8999/mcp'}));
});
test('external HTTPS URL keeps proxy mode',()=>{
  assertProxy(runProbe({url:'https://fixture.invalid/mcp'}));
});
test('explicit proxy mode overrides the legacy private port',()=>{
  assertProxy(runProbe({url:'http://127.0.0.1:8931/mcp',mode:'proxy',tabs:true}),{tabs:true});
});
test('unsafe-tool proxy check is unchanged',()=>{
  const run=runProbe({url:'http://127.0.0.1:8940/mcp',unsafe:true});
  assertProxy(run);
  assert.match(run.stdout,/UNSAFE_TOOL_FILTER=PASS/);
  assert.equal(run.requests[2].body.params.name,'browser_run_code_unsafe');
});
test('unknown explicit mode fails before any request',()=>{
  const run=runProbe({url:'http://127.0.0.1:8999/mcp',mode:'typo'});
  assert.equal(run.status,1);
  assert.deepEqual(run.requests,[]);
  assert.match(run.stderr,/Invalid PLAYWRIGHT_MCP_PROBE_MODE/);
});
