'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Runtime,assertTunnelId,clientArgs,terminalEndpoint,runtimePaths}=require('../app/runtime.cjs');
test('tunnel keys never appear in command arguments',()=>{
 const args=clientArgs({tunnelId:'tunnel_secure_4',url:'http://127.0.0.1:8940/mcp',
   config:'C:\\tunnel.yaml',healthFile:'C:\\health.url'});
 assert.equal(args.includes('super-secret'),false);
 assert.deepEqual(args.slice(0,2),['run','--config']);
 assert.equal(args[args.indexOf('--control-plane.api-key')+1],'env:CONTROL_PLANE_API_KEY');
 for(const unsafe of ['http://evil/mcp','http://0.0.0.0:8940/mcp','http://127.0.0.1:8940/secret'])
   assert.throws(()=>clientArgs({tunnelId:'tunnel_valid',url:unsafe}),/INVALID_LOCAL_MCP_URL/);
 assert.throws(()=>assertTunnelId('tunnel_../bad'),/INVALID_TUNNEL_ID/);
});
test('private terminal endpoint is validated and never hardcoded',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-win-test-'));
 try{
  const config=path.join(root,'config.json');
  assert.throws(()=>terminalEndpoint(config),/ENOENT/);
  fs.writeFileSync(config,JSON.stringify({mcpPath:'exec/'+'a'.repeat(64)}));
  assert.equal(terminalEndpoint(config),'http://127.0.0.1:12848/exec/'+'a'.repeat(64));
  fs.writeFileSync(config,JSON.stringify({mcpPath:'../../secrets'}));
  assert.throws(()=>terminalEndpoint(config),/INVALID_LOCAL_MCP_CONFIG/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('Windows plans reuse existing MCP source rather than a second fork',async()=>{
 const root='C:\\McpGo';
 const p=runtimePaths(root,'C:\\User\\McpGo');
 assert.match(p.terminal,/stateless_server.js$/);
 assert.match(p.browser,/cli.js$/);
 const runtime=new Runtime({resourceRoot:root,userData:'C:\\User\\McpGo',
   nodeExecutable:'McpGo.exe',credentials:()=>null,browser:'msedge'});
 assert.deepEqual((await runtime.plan('terminal')).args.slice(0,1),[p.terminal]);
 assert.equal((await runtime.plan('terminal')).env.ELECTRON_RUN_AS_NODE,'1');
 assert.equal(await runtime.plan('terminalTunnel'),null);
});
