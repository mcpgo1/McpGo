'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {classifyCommand}=require('../resource_policy.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-policy-test-'));
fs.mkdirSync(path.join(root,'.git'));
fs.mkdirSync(path.join(root,'packages'));const nested=path.join(root,'packages');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('direct Git mutation in nested dirs serializes on same repo',()=>{
 assert.equal(classifyCommand('git push origin main',root),classifyCommand('git commit -am fix',nested));
 assert.match(classifyCommand('git push',root),/^git:[a-f0-9]{24}$/);
 assert.equal(classifyCommand('git status',root),null);
});
test('known direct deploy and publish commands are scoped',()=>{
 assert.match(classifyCommand('vercel deploy --prod',root),/^deploy:[a-f0-9]{24}$/);
 assert.match(classifyCommand('npm publish',root),/^release:[a-f0-9]{24}$/);
 assert.equal(classifyCommand('pnpm test',root),null);
});
test('complex commands cannot be automatically classified',()=>{
 for(const s of ['cd /tmp && git push','git push; curl something','git push | tee log',
  'git push\nrm -rf directory','git push > /tmp/log','./release.sh'])
  assert.equal(classifyCommand(s,root),null,s);
});
test('outside git repository no implicit resource is invented',()=>{
 assert.equal(classifyCommand('git push',os.tmpdir()),null);
});
