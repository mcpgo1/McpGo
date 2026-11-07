import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchSource} from '../patch-playwright.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const upstream=path.resolve(root,'../node_modules/playwright-core/lib/coreBundle.js');
test('metadata patch is applied and repeatable',()=>{
 const source=fs.readFileSync(upstream,'utf8');
 const result=patchSource(source);
 assert.equal(result.modified,false);
 assert.match(source,/metadataTimer = setTimeout\(resolve, 2500\)/);
 assert.match(source,/consoleTimer = setTimeout\(\(\) => resolve\(consoleCounts\), 1200\)/);
});
test('fail closed on unexpected upstream signature',()=>{
 assert.throws(()=>patchSource('unrelated source'),/Unsupported Playwright/);
});

test('a hung page title does not block browser-tabs metadata forever',async()=>{
 const bundle=fs.readFileSync(upstream,'utf8');
 const begin=bundle.indexOf('      async headerSnapshot() {');
 const end=bundle.indexOf('\n      isCurrentTab() {',begin);
 assert.ok(begin>=0&&end>begin,'headerSnapshot implementation found');
 const method=bundle.slice(begin,end);
 const fakeFactory=new Function('tabHeaderEquals',`return ({${method}});`);
 const behavior=fakeFactory(()=>false);
 let titleCalls=0;
 const fake={
   ...behavior,
   crashed:false,
   page:{title:()=>{titleCalls++;return new Promise(()=>{});},url:()=>'chrome://unresponsive'},
   _raceAgainstModalStates:fn=>fn(),
   consoleMessageCount:async()=>({total:0,errors:0,warnings:0}),
   isCurrentTab:()=>true,
   _lastHeader:null,
   _mainDocumentStatus:null,
 };
 const start=Date.now();
 const header=await fake.headerSnapshot();
 const elapsed=Date.now()-start;
 assert.ok(elapsed>=2400 && elapsed<4800,`bounded timeout, got ${elapsed} ms`);
 assert.equal(header.title,'');
 assert.equal(header.url,'chrome://unresponsive');
 await fake.headerSnapshot();
 assert.equal(titleCalls,1,'reused pending title request; no repeated modal listeners');
});
