import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {POLL_MS,ERROR_STABLE_MS,SUSPECT_STABLE_MS,updateWatchdog,noteReload,canRetryAfterReload,recoveryObservation,continuationOpportunity} from '../stall-watchdog.mjs';
import {observeExistingChat,reloadStalledChat,pageInspection,classifyAgent} from '../cdp-delivery.mjs';

const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const busy={urlValid:true,stop:true,busyText:false,connectionInterrupted:false,progressText:'responding step one',editorText:'',editorCount:1};
const broken={...busy,connectionInterrupted:true};
const clean={...busy,stop:false,busyText:false,connectionInterrupted:false};
function drive(samples){
 let state=null,result;
 for(const [time,observation] of samples){
  result=updateWatchdog(state,observation,time);
  state=result.next;
 }
 return result;
}
test('legitimate long task with progress must never be reloaded',()=>{
 const sequence=[[0,busy],[70_000,{...busy,progressText:'progressed'}],[700_000,{...busy,progressText:'new log output'}],[1_500_000,{...busy,progressText:'done part'}]];
 assert.equal(drive(sequence).action,'busy');
});
test('no visible progress but NO explicit connection error is suspected, never interrupted',()=>{
 const result=drive([[0,busy],[30_000,busy],[SUSPECT_STABLE_MS+1000,busy]]);
 assert.equal(result.action,'suspected-stall');
 assert.equal(result.next.reloadCount,0);
});
test('explicit interrupted banner: after two independent polls, recover once',()=>{
 const result=drive([[0,broken],[ERROR_STABLE_MS+1,broken]]);
 assert.equal(result.action,'reload');
 const committed=noteReload(result.next,ERROR_STABLE_MS+1);
 assert.equal(committed.reloadCount,1);
 assert.equal(committed.mode,'recovering');
 const after=updateWatchdog(committed,broken,ERROR_STABLE_MS+80_000);
 assert.notEqual(after.action,'reload');
});
test('moving response text resets interruption stability window',()=>{
 const result=drive([[0,broken],[5_000,{...broken,progressText:'progressed'}],[10_000,{...broken,progressText:'progressed'}]]);
 assert.equal(result.action,'interrupted');
});
test('normal busy no button, explicit error still tracked even after button disappears',()=>{
 const result=drive([[0,{...broken,stop:false}],[ERROR_STABLE_MS+1,{...broken,stop:false}]]);
 assert.equal(result.action,'reload');
});
test('refresh requires two stable clean observations before rearming',()=>{
 const s=noteReload(drive([[0,broken],[ERROR_STABLE_MS+1,broken]]).next,ERROR_STABLE_MS+1);
 const observed={...clean,pageReady:'complete'};
 const first=recoveryObservation(s,observed,20000);
 assert.equal(first.ready,false);
 assert.equal(canRetryAfterReload(first.next,observed,20001),false);
 const second=recoveryObservation(first.next,observed,21001);
 assert.equal(second.ready,true);
 assert.equal(canRetryAfterReload(s,busy),false);
 assert.equal(canRetryAfterReload(s,broken),false);
});
test('watchdog does not persist actual assistant response text',()=>{
 const result=updateWatchdog(null,{...broken,progressText:'PRIVATE CHAT CONTENT'},0);
 assert.equal(JSON.stringify(result.next).includes('PRIVATE CHAT CONTENT'),false);
 assert.match(result.next.signature,/^[a-f0-9]{64}$/);
});
function fake(observation){
 const calls=[];
 const client={async tool(name,args){
  calls.push({name,args});
  if(name==='browser_tabs' && args.action==='list')return '- 8: '+url;
  if(name==='browser_tabs' && args.action==='select')return 'selected';
  if(name==='browser_evaluate')return '### Result\n```json\n'+JSON.stringify({url,ready:'complete',editorCount:1,editorText:'',stop:false,busyText:false,...observation})+'\n```';
  if(name==='browser_navigate')return 'Navigated';
  throw Error('Unexpected operation: '+name);
 }};
 return {client,calls};
}
test('read-only existing conversation probe never opens, clicks or types',async()=>{
 const f=fake({connectionInterrupted:true,progressText:'frozen'});
 const result=await observeExistingChat({url}, {client:f.client});
 assert.equal(result.status,'ok');
 assert.equal(result.observation.connectionInterrupted,true);
 assert.deepEqual(f.calls.map(c=>c.name),['browser_tabs','browser_tabs','browser_evaluate']);
});
test('refresh requires the explicit error to still be visible immediately before navigation',async()=>{
 const f=fake({connectionInterrupted:false});
 const result=await reloadStalledChat({url},{client:f.client});
 assert.equal(result.status,'changed');
 assert.ok(!f.calls.some(c=>c.name==='browser_navigate'));
});
test('explicit connection error navigates EXACT current chat URL once, never Send/Stop',async()=>{
 const f=fake({connectionInterrupted:true});
 const result=await reloadStalledChat({url},{client:f.client});
 assert.equal(result.status,'reloaded');
 assert.deepEqual(f.calls.filter(c=>c.name==='browser_navigate').map(c=>c.args.url),[url]);
 assert.ok(!f.calls.some(c=>c.name==='browser_click'||c.name==='browser_type'));
});
test('existing draft blocks reload to avoid losing the user text',async()=>{
 const f=fake({connectionInterrupted:true,editorText:'User draft'});
 const result=await reloadStalledChat({url},{client:f.client});
 assert.equal(result.status,'deferred');
 assert.ok(!f.calls.some(c=>c.name==='browser_navigate'));
});
test('DOM inspection recognizes connection-interrupted banner',()=>{
 const banner={innerText:'Соединение прервано. Ожидание полного ответа',
  textContent:'Соединение прервано. Ожидание полного ответа',
  getClientRects(){return [{width:200}]},children:[],closest(){return null}};
 const document={
  readyState:'complete',title:'Chat',
  querySelectorAll(selector){
   if(selector.includes('[role="alert"]'))return [banner];
   return [];
  },
  querySelector(s){return s==='main'?{innerText:'Response'}:null}
 };
 const location={origin:'https://chatgpt.com',pathname:'/c/00000000-0000-4000-8000-000000000001'};
 const snapshot=vm.runInNewContext('('+pageInspection+')()',{document,location});
 assert.equal(snapshot.connectionInterrupted,true);
 assert.equal(classifyAgent(snapshot,url).kind,'interrupted');
});

test('quoted connection error in a user message is not treated as an actual UI failure',()=>{
 const quote={innerText:'Соединение прервано. Ожидание полного ответа',
  textContent:'Соединение прервано. Ожидание полного ответа',
  getClientRects(){return [{}]},children:[],closest(){return {id:'user-bubble'}}};
 const document={
  readyState:'complete',title:'Chat',
  querySelectorAll(selector){return selector.includes('[role="alert"]')?[quote]:[]},
  querySelector(s){return s==='main'?{innerText:'Response'}:null}
 };
 const location={origin:'https://chatgpt.com',pathname:'/c/00000000-0000-4000-8000-000000000001'};
 const snapshot=vm.runInNewContext('('+pageInspection+')()',{document,location});
 assert.equal(snapshot.connectionInterrupted,false);
});

test('explicit interruption is actionable quickly but a single transient frame is not',()=>{
 const first=updateWatchdog(null,broken,0);
 assert.equal(first.action,'interrupted');
 assert.notEqual(first.action,'reload');
 const second=updateWatchdog(first.next,broken,ERROR_STABLE_MS+1);
 assert.equal(second.action,'reload');
});

test('explicit Continue generating button is a terminal-state signal',()=>{
 const cta={innerText:'Continue generating',textContent:'Continue generating',
  getClientRects(){return [{}]},getAttribute(){return null}};
 const document={readyState:'complete',title:'Chat',
  querySelectorAll(selector){return selector==='button'?[cta]:[];},
  querySelector(selector){return selector==='main'?{innerText:'Existing response'}:null;}};
 const location={origin:'https://chatgpt.com',pathname:'/c/00000000-0000-4000-8000-000000000001'};
 const result=vm.runInNewContext('('+pageInspection+')()',{document,location});
 assert.equal(result.connectionInterrupted,false);
 assert.equal(result.continuationAvailable,true);
});

test('explicit continuation control makes the scheduled prompt actionable exactly once',()=>{
 const task={enabled:true,status:'scheduled',last_success_at:null,last_attempt_at:null};
 const observation={urlValid:true,connectionInterrupted:false,continuationAvailable:true,
  stop:false,busyText:false,editorCount:1,editorText:'',userCount:7,
  lastUserHash:'f'.repeat(64),lastUserId:'bubble-7'};
 const marker=continuationOpportunity(task,observation,1_000_000);
 assert.ok(marker);
 task.continuationMarker=marker;
 assert.equal(continuationOpportunity(task,observation,1_100_000),null);
 assert.ok(continuationOpportunity(task,{...observation,lastUserId:'bubble-8'},1_100_000));
});
test('never resume while streaming, draft, transport error or recent successful Send',()=>{
 const task={enabled:true,status:'scheduled',last_success_at:new Date(0).toISOString()};
 const page={urlValid:true,continuationAvailable:true,connectionInterrupted:false,
  stop:false,busyText:false,editorCount:1,editorText:'',userCount:3,lastUserHash:'a'};
 assert.equal(continuationOpportunity(task,page,30_000),null,'cooldown after actual Send');
 assert.equal(continuationOpportunity(task,{...page,stop:true},100_000),null);
 assert.equal(continuationOpportunity(task,{...page,busyText:true},100_000),null);
 assert.equal(continuationOpportunity(task,{...page,editorText:'draft'},100_000),null);
 assert.equal(continuationOpportunity(task,{...page,connectionInterrupted:true},100_000),null);
 assert.equal(continuationOpportunity({...task,status:'paused'},page,100_000),null);
 assert.ok(continuationOpportunity(task,page,100_000));
});

test('assistant mutation revision shows progress without writing response text',()=>{
 const a=updateWatchdog(null,{...busy,assistantRevision:2,progressText:'Secret answer'},1000);
 const b=updateWatchdog(a.next,{...busy,assistantRevision:3,progressText:'Secret answer'},5000);
 assert.equal(b.action,'busy');
 assert.equal(b.next.lastProgressAt,new Date(5000).toISOString());
 assert.ok(!JSON.stringify(b.next).includes('Secret answer'));
});

test('DOM changes after reconnect restart the stable-ready confirmation window',()=>{
 const initial=noteReload(updateWatchdog(null,broken,1000).next,1000);
 const cleanObs={...clean,pageReady:'complete',assistantRevision:3,userCount:8,lastUserHash:'a'};
 const a=recoveryObservation(initial,cleanObs,2000);
 const b=recoveryObservation(a.next,{...cleanObs,assistantRevision:4},3500);
 assert.equal(b.ready,false);
 assert.equal(b.next.recoveryCleanCount,1);
 const c=recoveryObservation(b.next,{...cleanObs,assistantRevision:4},4600);
 assert.equal(c.ready,true);
 assert.equal(JSON.stringify(c.next).includes('Private chat'),false);
});
