import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeTarget,validateInput,newTask,arm,pause,dueTasks,markUnknownOnBoot,writeState,readState,DIRECT_WEB_CHAT_DELIVERY_SUPPORTED,DIRECT_WEB_CHAT_REASON} from '../core.mjs';
const id='00000000-0000-4000-8000-000000000001';
const target='https://chatgpt.com/c/'+id;
const project='https://chatgpt.com/g/g-p-11111111111111111111111111111111-demo-project/c/'+id;
test('normal ChatGPT conversation URL remains the exact recipient',()=>{
 assert.equal(normalizeTarget(target),target);
 assert.equal(normalizeTarget(target+'?no_universal_links=1&refresh_account=true&startup_account_refresh=true'),target);
 assert.equal(normalizeTarget(target+'/'),target);
 assert.equal(DIRECT_WEB_CHAT_DELIVERY_SUPPORTED,true);
 assert.match(DIRECT_WEB_CHAT_REASON,/Playwright CDP/);
});
test('project-scoped conversation URL is preserved, query params dropped',()=>{
 assert.equal(normalizeTarget(project),project);
 assert.equal(normalizeTarget(project+'?refresh_account=true&no_universal_links=1'),project);
 assert.equal(validateInput({url:project,message:'Проверить сборку',interval_seconds:60}).url,project);
});
test('project chat URI is not accepted for arbitrary subpaths or different sites',()=>{
 for(const url of [
  'https://chatgpt.com/g/g-p-11111111111111111111111111111111-demo-project/c/not-uuid',
  project+'/more',project+'#fragment',
  'https://chatgpt.com/g/other/c/'+id,
  'https://chatgpt.com/g/g-p-project/share/'+id,
  'https://example.com/g/g-p-abc/c/'+id
 ]) assert.throws(()=>normalizeTarget(url));
});
test('wrong targets share, Codex, foreign domains and manipulated URLs rejected',()=>{
 for(const url of [
  'https://chatgpt.com/share/00000000-0000-4000-8000-000000000002',
  'codex://threads/'+id,'https://chatgpt.com.evil.org/c/'+id,
  'https://evil.com/c/'+id,'http://chatgpt.com/c/'+id,
  'https://foo@chatgpt.com/c/'+id,target+'#bad','https://chatgpt.com/c/no-id'
 ]) assert.throws(()=>normalizeTarget(url));
});
test('interval and text validation',()=>{
 assert.throws(()=>validateInput({url:target,message:'x',interval_seconds:10}),/Интервал/);
 assert.throws(()=>validateInput({url:target,message:'',interval_seconds:60}));
 assert.equal(validateInput({url:target,message:'test',interval_seconds:60}).message,'test');
});
test('drafts are always created paused, scheduler low-level clock math unchanged',()=>{
 const t=newTask({url:target,message:'ping',interval_seconds:60},1000);
 assert.equal(t.enabled,false);assert.equal(t.next_at,null);
 arm(t,1000);assert.equal(t.next_at,new Date(61000).toISOString());
 assert.deepEqual(dueTasks({tasks:[t]},60000),[]);
 assert.equal(dueTasks({tasks:[t]},61000).length,1);
 pause(t);assert.equal(dueTasks({tasks:[t]},100000).length,0);
});
test('existing normal ChatGPT schedule survives restart; invalid Codex task is blocked',()=>{
 for (const url of [target,'codex://threads/'+id]){
  const t={id:'old',url,enabled:true,status:'scheduled',next_at:new Date().toISOString(),last_error:''};
  markUnknownOnBoot({tasks:[t]});
  if(url===target){
   assert.equal(t.enabled,true);assert.equal(t.status,'scheduled');assert.ok(t.next_at);
  } else {
   assert.equal(t.enabled,false);assert.equal(t.status,'blocked');assert.equal(t.next_at,null);
   assert.match(t.last_error,/Codex/);
  }
 }
});
test('unknown in-flight deliveries require manual inspection, even after restart',()=>{
 const t=newTask({url:target,message:'ping',interval_seconds:60});
 arm(t);t.status='sending';markUnknownOnBoot({tasks:[t]});
 assert.equal(t.enabled,false);assert.equal(t.status,'unknown');
});
test('atomic local store roundtrip, private file permissions',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'autosend-test-'));
 try {
  const file=path.join(folder,'tasks.json');
  const state={version:1,tasks:[],attempts:[]};writeState(state,file);
  assert.deepEqual(readState(file),state);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('pending manual one-shot is not delivered unexpectedly after scheduler reboot',()=>{
 const t=newTask({url:target,message:'manual pending',interval_seconds:60});
 t.status='scheduled';t.next_at=new Date(Date.now()-1000).toISOString();t.manual_once=true;
 markUnknownOnBoot({tasks:[t]});
 assert.equal(t.enabled,false);assert.equal(t.status,'paused');assert.equal(t.manual_once,false);
 assert.equal(t.next_at,null);
 assert.match(t.last_error,/отменена при перезапуске/);
});
