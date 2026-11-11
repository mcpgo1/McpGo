import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileViaPlaywright,confirmsNewUserMessage,deliveryEvidence} from '../cdp-delivery.mjs';
import {
  verificationReceipt,canReconcile,expired,scheduleNextCheck,finishVerified,finishUnknown,recheckUnknown,
  VERIFY_WINDOW_MS,restoreAttemptEvidence,fingerprint,combinedEvidence
} from '../reconciliation.mjs';
import {markUnknownOnBoot} from '../core.mjs';

const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const message='Продолжи реализацию плана до конца!';
const task=()=>({url,message,status:'sending',enabled:true,manual_once:false,
 interval_seconds:900,delivery_count:6,last_error:'',next_at:null,delivery_stage:'click-committed'});

function observer(states,tabPresent=true){
 const calls=[];
 let i=0;
 const client={async tool(name,args){
  calls.push({name,args});
  if(name==='browser_tabs' && args.action==='list')return tabPresent?'- 7: '+url:'- 3: https://example.org/';
  if(name==='browser_tabs' && args.action==='select')return 'selected';
  if(name==='browser_evaluate'){
   const state=states[Math.min(i++,states.length-1)];
   return '### Result\n```json\n'+JSON.stringify(state)+'\n```';
  }
  throw Error('A reconciliation must never call '+name);
 }};
 return {client,calls};
}
function page(userCount,lastUserText,extra={}){
 return {url,userCount,lastUserText,lastUserTexts:['Old message',lastUserText],...extra};
}

test('click proof is durable, records prior user message and a bounded deadline',()=>{
 const proof=verificationReceipt({userCount:6,lastUserText:'Old message'},1000);
 assert.equal(proof.baselineUserCount,6);
 assert.match(proof.baselineLastUserHash,/^[0-9a-f]{64}$/);
 assert.equal('baselineLastUserText' in proof,false,'never persist previous private chat text');
 assert.equal(Date.parse(proof.deadlineAt)-Date.parse(proof.startedAt),VERIFY_WINDOW_MS);
 const t=task();t.verification=proof;t.status='verifying';
 assert.equal(canReconcile(t,1000),true);
 scheduleNextCheck(t,'DOM not yet updated',1000);
 assert.equal(t.status,'verifying');
 assert.equal(canReconcile(t,1000),false);
 assert.equal(canReconcile(t,13000),true);
});
test('a new user bubble is recognized in a later read-only poll',async()=>{
 const proof=verificationReceipt({userCount:6,lastUserText:'Old message'},1000);
 const ob=observer([page(6,'Old message'),page(7,message)]);
 const first=await reconcileViaPlaywright(task(),proof,{client:ob.client});
 const second=await reconcileViaPlaywright(task(),proof,{client:ob.client});
 assert.equal(first.status,'deferred');
 assert.equal(second.status,'verified');
 assert.equal(ob.calls.filter(x=>x.name==='browser_evaluate').length,2);
 assert.equal(ob.calls.filter(x=>x.name==='browser_click').length,0);
 assert.equal(ob.calls.filter(x=>x.name==='browser_type').length,0);
 assert.equal(ob.calls.filter(x=>x.name==='browser_tabs'&&x.args.action==='new').length,0);
});
test('closed or wrong tab is never opened or modified for verification',async()=>{
 const proof=verificationReceipt({userCount:6,lastUserText:'Old message'},1000);
 const ob=observer([],false);
 const result=await reconcileViaPlaywright(task(),proof,{client:ob.client});
 assert.equal(result.status,'deferred');
 assert.deepEqual(ob.calls.map(x=>x.name),['browser_tabs']);
});
test('unchanged editor, assistant echo and pre-existing identical text cannot prove delivery',()=>{
 const before={userCount:6,lastUserText:message};
 assert.equal(confirmsNewUserMessage(before,page(6,message,{mainOccurrences:99}),message),false);
 assert.equal(confirmsNewUserMessage(before,page(7,'Some other message'),message),false);
 assert.equal(confirmsNewUserMessage(before,page(6,'Some other message'),message),false);
});
test('virtualized list confirms only when previous last user message is now penultimate',()=>{
 const before={userCount:6,lastUserText:'Old message'};
 const after=page(6,message,{lastUserTexts:['Old message',message]});
 assert.equal(confirmsNewUserMessage(before,after,message),true);
 assert.equal(confirmsNewUserMessage(before,page(6,message,{lastUserTexts:['Unrelated',message]}),message),false);
});
test('restart preserves committed proof and switches to read-only verification',()=>{
 const t=task();
 t.verification=verificationReceipt({userCount:6,lastUserText:'Old message'},Date.now());
 const state={tasks:[t]};
 markUnknownOnBoot(state);
 assert.equal(t.status,'verifying');
 assert.equal(t.enabled,true);
 assert.equal(t.next_at,null);
 assert.equal(canReconcile(t,Date.now()+1000),true);
});
test('legacy sending without baseline goes unknown instead of replay',()=>{
 const t=task();
 markUnknownOnBoot({tasks:[t]});
 assert.equal(t.status,'unknown');
 assert.equal(t.enabled,false);
});
test('confirmed delayed message increments count once and schedules next interval',()=>{
 const t=task();t.status='verifying';
 t.verification=verificationReceipt({userCount:6,lastUserText:'Old message'},1000);
 finishVerified(t,4000);
 assert.equal(t.delivery_count,7);
 assert.equal(t.status,'scheduled');
 assert.equal(t.next_at,new Date(4000+900000).toISOString());
 assert.equal(t.verification,undefined);
});
test('one-shot confirmation returns to paused and never re-arms itself',()=>{
 const t=task();t.enabled=false;t.manual_once=true;t.status='verifying';
 t.verification=verificationReceipt({userCount:6,lastUserText:'Old message'},1000);
 finishVerified(t,4000);
 assert.equal(t.status,'paused');
 assert.equal(t.delivery_count,7);
 assert.equal(t.next_at,null);
});
test('verification expiry keeps proof for read-only manual recheck',()=>{
 const t=task();t.status='verifying';
 t.verification=verificationReceipt({userCount:6,lastUserText:'Old message'},1000);
 assert.equal(expired(t,1000+VERIFY_WINDOW_MS-1),false);
 assert.equal(expired(t,1000+VERIFY_WINDOW_MS),true);
 finishUnknown(t,'Not confirmed',null,1000+VERIFY_WINDOW_MS);
 assert.equal(t.status,'unknown');assert.equal(t.enabled,false);
 assert.ok(t.verification);assert.equal(t.next_at,null);
 recheckUnknown(t,1000+VERIFY_WINDOW_MS+1000);
 assert.equal(t.status,'verifying');assert.equal(t.enabled,false);
 assert.equal(t.verification.manualRechecks,1);
 assert.equal(canReconcile(t,1000+VERIFY_WINDOW_MS+1000),true);
});

test('stable user message ID confirms identical repeated text in virtualized chat',()=>{
 const before={userCount:6,lastUserHash:'a'.repeat(64),lastUserId:'old-abc'};
 const after=page(6,message,{lastUserId:'new-def',lastUserTexts:[message,message]});
 assert.equal(confirmsNewUserMessage(before,after,message),true);
 assert.equal(confirmsNewUserMessage(before,{...after,lastUserId:'old-abc'},message),false);
});
test('malformed receipt fails closed without stalling verification forever',()=>{
 const t=task();t.status='verifying';t.verification=verificationReceipt({userCount:6},1000);
 t.verification.deadlineAt='malformed';
 t.verification.nextCheckAt='malformed';
 assert.equal(canReconcile(t,1000),true);
 assert.equal(expired(t,1000),true);
});

test('changed DOM ID with identical pre-existing message cannot falsely verify',()=>{
 const before={userCount:6,lastUserHash:verificationReceipt({userCount:6,lastUserText:message}).baselineLastUserHash,lastUserId:'id-1'};
 const after=page(6,message,{lastUserId:'id-2',lastUserTexts:[message,message]});
 assert.equal(confirmsNewUserMessage(before,after,message),false);
});

test('manual recheck fails closed without a stored baseline',()=>{
 const t=task();t.status='unknown';t.enabled=false;
 assert.throws(()=>recheckUnknown(t),/нет сохранённого подтверждения/);
 assert.equal(t.status,'unknown');
});
test('read-only reconciliation evidence does not store message text',async()=>{
 const receipt=verificationReceipt({userCount:4,lastUserText:'Private previous chat'});
 const ob=observer([page(5,message,{editorText:''})]);
 const result=await reconcileViaPlaywright(task(),receipt,{client:ob.client});
 assert.equal(result.status,'verified');
 assert.equal(result.evidence.code,'USER_BUBBLE_VERIFIED');
 assert.equal(result.evidence.messageFound,true);
 assert.equal(JSON.stringify(result.evidence).includes(message),false);
 assert.ok(!ob.calls.some(c=>c.name==='browser_click'||c.name==='browser_type'));
});


test('regression: long ChatGPT chat virtualizes 6 old bubbles to 5 while repeating the exact same message',()=>{
 const before={userCount:6,lastUserHash:fingerprint(message),lastUserId:'',
   assistantRevision:0,userInsertionRevision:0};
 const after=page(5,message,{editorText:'',stop:true,userInsertionRevision:1,
   assistantRevision:0});
 const proof=deliveryEvidence(before,after,message,url);
 assert.equal(proof.code,'USER_BUBBLE_VERIFIED_VIRTUALIZED');
 assert.equal(proof.messageFound,true);
 assert.equal(proof.newUserCount,false);
 assert.equal(proof.userCountDelta,-1);
 assert.equal(proof.userInsertionDelta,1);
 assert.equal(proof.assistantActivitySeen,true);
 assert.equal(proof.editorCleared,true);
});
test('regression: evidence persists between React rerenders and after editor repopulates',()=>{
 const before={userCount:6,lastUserHash:fingerprint(message),userInsertionRevision:0,
   assistantRevision:0};
 const original=deliveryEvidence(before,page(5,message,{
   editorText:'',userInsertionRevision:1,stop:false}),message,url);
 assert.equal(original.messageFound,false,'insertion and empty editor alone are insufficient');
 const changed=deliveryEvidence(before,page(5,message,{
   editorText:'user typed a draft',userInsertionRevision:0,stop:true}),message,url,original);
 assert.equal(changed.code,'USER_BUBBLE_VERIFIED_VIRTUALIZED');
 assert.equal(changed.messageFound,true);
 assert.equal(changed.editorCleared,true,'a subsequent human draft does not erase earlier editor-clear proof');
 assert.equal(changed.userInsertionDelta,1,'late DOM virtualization cannot erase positive insertion event');
});
test('regression: identical old message plus assistant busy without insertion must stay unknown',()=>{
 const before={userCount:6,lastUserHash:fingerprint(message),userInsertionRevision:0};
 for(const extra of [
  {editorText:'',stop:true,userInsertionRevision:0},
  {editorText:'',stop:false,userInsertionRevision:1},
  {editorText:message,stop:true,userInsertionRevision:1},
  {editorText:'',stop:false,userInsertionRevision:0}
 ]) {
  const proof=deliveryEvidence(before,page(5,message,extra),message,url);
  assert.equal(proof.messageFound,false,JSON.stringify(extra));
 }
 const wrong=deliveryEvidence(before,page(5,message,{
  url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000002',
  editorText:'',stop:true,userInsertionRevision:1}),message,url);
 assert.equal(wrong.messageFound,false,'never verify another conversation');
 const otherText=deliveryEvidence(before,page(5,'a different user message',{
  editorText:'',stop:true,userInsertionRevision:1}),message,url);
 assert.equal(otherText.messageFound,false,'text must match the latest user-authored bubble');
});
test('regression: old event-positive journal is recovered for this click, never another attempt',()=>{
 const t=task();
 t.id='task-x';t.status='verifying';
 const start=Date.parse('2026-11-09T12:43:00.457Z');
 t.verification=verificationReceipt({userCount:6,lastUserText:message,userInsertionRevision:0},start);
 const observations=[
  {task_id:'task-x',result:'verifying',time:new Date(start-60000).toISOString(),
   diagnostic:{clickCommitted:true,userInsertionDelta:777,editorCleared:true}},
  {task_id:'other',result:'verifying',time:new Date(start+40000).toISOString(),
   diagnostic:{clickCommitted:true,userInsertionDelta:888,editorCleared:true}},
  {task_id:'task-x',result:'verifying',time:new Date(start+25000).toISOString(),
   diagnostic:{clickCommitted:true,lastTextMatched:true,userInsertionDelta:1,editorCleared:true}},
  {task_id:'task-x',result:'busy',time:new Date(start+35000).toISOString(),
   diagnostic:{clickCommitted:true,userInsertionDelta:999}}
 ];
 assert.equal(restoreAttemptEvidence(t,observations),true);
 assert.equal(t.verification.lastEvidence.userInsertionDelta,1);
 assert.equal(t.verification.lastEvidence.editorCleared,true);
 assert.equal(restoreAttemptEvidence(t,observations),false,'restore is idempotent');
 const result=deliveryEvidence({
  userCount:t.verification.baselineUserCount,lastUserHash:t.verification.baselineLastUserHash,
  userInsertionRevision:t.verification.baselineUserInsertionRevision},
  page(5,message,{editorText:'new draft',stop:true,userInsertionRevision:0}),
  message,url,t.verification.lastEvidence);
 assert.equal(result.code,'USER_BUBBLE_VERIFIED_VIRTUALIZED');
});
test('regression: scheduleNextCheck keeps positive evidence after later negative snapshots',()=>{
 const t=task();
 t.status='verifying';
 t.verification=verificationReceipt({userCount:6,lastUserText:message},1000);
 scheduleNextCheck(t,'',2000,{code:'USER_BUBBLE_NOT_FOUND',clickCommitted:true,
  userInsertionDelta:1,editorCleared:true});
 scheduleNextCheck(t,'',3000,{code:'USER_BUBBLE_NOT_FOUND',clickCommitted:true,
  userInsertionDelta:0,editorCleared:false,assistantActivitySeen:true});
 assert.equal(t.verification.lastEvidence.userInsertionDelta,1);
 assert.equal(t.verification.lastEvidence.editorCleared,true);
 assert.equal(t.verification.lastEvidence.assistantActivitySeen,true);
});
