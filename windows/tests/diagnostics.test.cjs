'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {record,register,scrub}=require('../app/diagnostics.cjs');

test('Windows native diagnostics: stable attempt and safe local-only JSONL',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-onboarding-test-'));
 try{
  const password='not-standard-password-123456789';
  const key='sk-1234567890abcdefghijklmnop';
  register({adminKey:key,password});
  record(home,'windows.onboard.start',{adminKey:key,answer:'failed: '+password,
    nested:{token:'Bearer '+key}});
  record(home,'windows.onboard.finish',{exitCode:0});
  const log=fs.readFileSync(path.join(home,'Onboarding','Logs','onboarding.log'),'utf8');
  assert.ok(!log.includes(password));
  assert.ok(!log.includes(key));
  const lines=log.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,2);
  assert.equal(lines[0].attempt,lines[1].attempt);
  assert.equal(lines[1].details.exitCode,0);
  assert.match(lines[0].time,/\.\d{3}Z$/);
 }finally{fs.rmSync(home,{recursive:true,force:true})}
});
test('Windows diagnostics redact runtime keys in errors',()=>{
 const value=scrub('Authorization: Bearer sk-abcdef123456789');
 assert.ok(!value.includes('abcdef123456789'));
 assert.ok(value.includes('[REDACTED]'));
});
test('Windows native diagnostics rotates large logs and preserves history',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-onboarding-rotate-'));
 try{
  record(home,'before-rotation');
  const folder=path.join(home,'Onboarding','Logs'),file=path.join(folder,'onboarding.log');
  fs.truncateSync(file,8*1024*1024);
  record(home,'after-rotation');
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].event,'after-rotation');
  assert.ok(fs.readdirSync(path.join(folder,'archive')).some(n=>n.endsWith('.log')));
 }finally{fs.rmSync(home,{recursive:true,force:true})}
});
