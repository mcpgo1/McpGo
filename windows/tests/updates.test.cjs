'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {latestWindowsPreview,checkUpdates,safeReleaseUrl}=require('../app/updates.cjs');
const item=(version,extra={})=>({
 tag_name:'v'+version,prerelease:true,draft:false,
 assets:[{name:'McpGo Setup '+version+'.exe',size:160000000}],...extra
});
test('picks only newer, actual Windows prerelease with installer',()=>{
 const r=latestWindowsPreview([
  item('2.1.0-preview.2'),item('2.1.0-preview.6',{draft:true}),
  item('2.1.0-preview.3',{prerelease:false}),
  item('2.2.0-preview.1',{assets:[]}),
  item('2.1.0-preview.1')
 ],'2.1.0-preview.1');
 assert.equal(r.version,'2.1.0-preview.2');
 assert.equal(r.url,'https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2');
 assert.equal(latestWindowsPreview([item('2.1.0-preview.1')],'2.1.0-preview.1').available,false);
});
test('rejects alien websites and incorrect tags',()=>{
 assert.throws(()=>safeReleaseUrl('https://evil.example/next.exe'),/UNTRUSTED/);
 assert.throws(()=>safeReleaseUrl('https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2?test=true'),/UNTRUSTED/);
 assert.throws(()=>safeReleaseUrl('https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2.exe'),/UNTRUSTED/);
 assert.equal(safeReleaseUrl('https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2'),
 'https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2');
});
test('verifies response boundary and never auto-installs anything',async()=>{
 const r=await checkUpdates('2.1.0-preview.1',{fetcher:async()=>({
  ok:true,text:async()=>JSON.stringify([item('2.1.0-preview.4')])
 })});
 assert.equal(r.version,'2.1.0-preview.4');
 await assert.rejects(checkUpdates('2.1.0-preview.1',{fetcher:async()=>({
  ok:false,status:500
 })}),/RELEASE_CHECK_HTTP_500/);
});
