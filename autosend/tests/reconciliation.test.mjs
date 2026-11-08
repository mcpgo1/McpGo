import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileViaPlaywright,confirmsNewUserMessage} from '../cdp-delivery.mjs';
import {
  verificationReceipt,canReconcile,expired,scheduleNextCheck,finishVerified,finishUnknown,
  VERIFY_WINDOW_MS
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
test('verification window expiry becomes manual unknown, never a retry',()=>{
 const t=task();t.status='verifying';
 t.verification=verificationReceipt({userCount:6,lastUserText:'Old message'},1000);
 assert.equal(expired(t,1000+VERIFY_WINDOW_MS-1),false);
 assert.equal(expired(t,1000+VERIFY_WINDOW_MS),true);
 finishUnknown(t,'Unable to see new bubble');
 assert.equal(t.status,'unknown');
 assert.equal(t.enabled,false);
 assert.equal(t.verification,undefined);
 assert.equal(t.next_at,null);
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
