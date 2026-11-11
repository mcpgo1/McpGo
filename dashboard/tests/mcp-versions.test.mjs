import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mcpVersions} from '../mcp-versions.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-versions-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('displays installed local MCP versions only, never an invented ChatGPT plugin version',()=>{
 assert.deepEqual(mcpVersions(root),{terminal:null,playwright:null});
 for(const [name,version] of [
   ['terminal/mcp-version.json','1.3.0'],
   ['playwright/node_modules/@playwright/mcp/package.json','0.0.83']
 ]) {
  const p=path.join(root,name);
  fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.writeFileSync(p,JSON.stringify({version}));
 }
 assert.deepEqual(mcpVersions(root),{terminal:'1.3.0',playwright:'0.0.83'});
});
test('invalid package metadata fails closed instead of guessing a version',()=>{
 const p=path.join(root,'terminal/mcp-version.json');
 fs.writeFileSync(p,JSON.stringify({version:'../../fake'}));
 assert.equal(mcpVersions(root).terminal,null);
});
