'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const app=require('../package.json');
const repo=path.resolve(__dirname,'../..');
test('unsigned Windows NSIS preview is per-user and has no auto-publish',()=>{
 const cfg=app.build;
 assert.equal(cfg.nsis.perMachine,false);
 assert.equal(cfg.nsis.oneClick,false);
 assert.equal(cfg.win.requestedExecutionLevel,'asInvoker');
 assert.equal(cfg.publish,undefined);
 assert.equal(cfg.win.target[0].target,'nsis');
});
test('bundle allowlists exact runtime files and not private local configuration',()=>{
 const resources=app.build.extraResources;
 const terminal=resources.find(x=>x.to==='mcpgo-runtime/terminal');
 const playwright=resources.find(x=>x.to==='mcpgo-runtime/playwright');
 assert.ok(terminal&&playwright);
 const expected=['stateless_server.js','job_runtime.js','job_worker.js','platform.js',
  'resource_locks.js','resource_policy.js','mcp-version.json','server.js','pty_worker_win.js','stateful_bridge.cjs','files_tools.cjs','dashboard.html','dashboard.js','dashboard.css'];
 for(const file of expected){
  assert.ok(terminal.filter.includes(file),file+' missing');
  assert.ok(fs.existsSync(path.join(repo,'terminal',file)),file+' absent');
 }
 assert.ok(resources.some(x=>x.from==='../playwright/node_modules'&&x.to==='mcpgo-runtime/playwright/node_modules'&&x.filter.includes('**/*')));
 for(const file of ['restricted-proxy.mjs','action-guard.mjs'])
  assert.ok(playwright.filter.includes(file));
 for(const name of ['config.json','stateless-config.json','.env','tunnel.key','settings.json'])
  assert.equal(terminal.filter.includes(name)||playwright.filter.includes(name),false);
 assert.ok(app.build.files.every(x=>!x.includes('**/*')));
});
test('Windows Electron window denies untrusted code execution and remote navigation',()=>{
 const main=fs.readFileSync(path.join(repo,'windows/app/main.cjs'),'utf8');
 const html=fs.readFileSync(path.join(repo,'windows/app/index.html'),'utf8');
 assert.match(main,/sandbox:true/);
 assert.match(main,/contextIsolation:true/);
 assert.match(main,/nodeIntegration:false/);
 assert.match(main,/setWindowOpenHandler/);
 assert.match(html,/Content-Security-Policy/);
 assert.doesNotMatch(html,/<script[^>]+src="https?:/);
});
