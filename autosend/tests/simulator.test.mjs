import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SimulatedChat,SimulatedMcp} from '../simulated-browser.mjs';
import {pageInspection,deliverViaPlaywright,reconcileViaPlaywright,parsePageResult}
 from '../cdp-delivery.mjs';
import {buildGuardedClick} from '../guarded-send.mjs';
import {buildEventWait} from '../browser-events.mjs';
import {conversationState,eligibleToSend,nextDue} from '../conversation-fsm.mjs';
import {verificationReceipt} from '../reconciliation.mjs';

const url=n=>'https://chatgpt.com/c/00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const task=(n=1)=>({id:'task-'+n,url:url(n),message:'TEST MESSAGE '+n});
const actionId=n=>'autosend:00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const noWait=async()=>{};
const inspect=async chat=>await chat.evaluate(pageInspection.replace(
 "'SCHEDULER_SENTINEL_NOT_PRESENT'",JSON.stringify('TEST MESSAGE 1')));

test('simulator: idle chat is sent exactly once and user bubble proves delivery',async()=>{
 const chat=new SimulatedChat(url(1));
 const mcp=new SimulatedMcp([chat]);
 let claimed=0;
 const result=await deliverViaPlaywright(task(),async()=>{
  claimed++;return actionId(1);
 },{client:mcp,wait:noWait});
 assert.equal(result.status,'verified');
 assert.equal(claimed,1);
 assert.equal(chat.clicks,1);
 assert.equal(chat.userMessages.at(-1),'TEST MESSAGE 1');
 assert.equal(mcp.calls.filter(x=>x.guarded).length,1);
 assert.equal(mcp.calls.filter(x=>x.name==='browser_click').length,0);
});

test('simulator: busy agent and visible Stop never type, click or claim',async()=>{
 const chat=new SimulatedChat(url(1),{busy:true});
 const mcp=new SimulatedMcp([chat]);
 const result=await deliverViaPlaywright(task(),()=>{throw Error('must not claim')},
  {client:mcp,wait:noWait});
 assert.equal(result.status,'deferred');
 assert.equal(chat.clicks,0);
 assert.equal(chat.editorText,'');
 assert.equal(mcp.calls.filter(x=>x.name==='browser_type').length,0);
});

test('simulator: assistant rerenders after final preflight; guarded click refuses',async()=>{
 const chat=new SimulatedChat(url(1));
 const mcp=new SimulatedMcp([chat]);
 mcp.onBeforeTool=async(name,args)=>{
  if(name==='browser_evaluate'&&args.function.includes('function guardedClickInPage'))
    chat.emitMutation('assistant');
 };
 const result=await deliverViaPlaywright(task(),async()=>actionId(2),
  {client:mcp,wait:noWait});
 assert.equal(result.status,'refused');
 assert.equal(result.code,'ASSISTANT_CHANGED');
 assert.equal(chat.clicks,0);
 assert.equal(chat.editorText,'','our own draft cleared safely');
});

test('simulator: active Chrome tab changes just before dispatch; outcome unknown, no wrong-tab click',async()=>{
 const chat1=new SimulatedChat(url(1));
 const chat2=new SimulatedChat(url(2));
 const mcp=new SimulatedMcp([chat1,chat2]);
 mcp.onBeforeTool=async(name,args,options,transport)=>{
  if(options.actionId)transport.active=1;
 };
 const result=await deliverViaPlaywright(task(),async()=>actionId(3),
  {client:mcp,wait:noWait});
 assert.equal(result.status,'pending','lost guarded dispatch is ambiguous');
 assert.equal(chat1.clicks+chat2.clicks,0);
 assert.ok(!chat2.editorText);
 assert.equal(mcp.calls.filter(x=>x.guarded).length,1);
});

test('simulator: transport drops AFTER Send, recovery verifies previous click without replay',async()=>{
 const chat=new SimulatedChat(url(1));
 const mcp=new SimulatedMcp([chat]);mcp.lostAfterClick=true;
 let receipt;
 const first=await deliverViaPlaywright(task(),async baseline=>{
  receipt=verificationReceipt(baseline);return actionId(4);
 },{client:mcp,wait:noWait});
 assert.equal(first.status,'pending');
 assert.equal(chat.clicks,1);
 const check=await reconcileViaPlaywright(task(),receipt,{client:mcp});
 assert.equal(check.status,'verified');
 assert.equal(chat.clicks,1,'reconciliation is strictly read-only');
 assert.equal(mcp.calls.filter(x=>x.guarded).length,1);
});

test('simulator: duplicate action ID is refused even if same page source is invoked again',async()=>{
 const chat=new SimulatedChat(url(1));
 await inspect(chat);
 chat.editorText='TEST MESSAGE 1';chat.send.disabled=false;
 const cfg={url:url(1),message:'TEST MESSAGE 1',editorSelector:'#prompt-textarea',
  sendSelector:'[data-testid="send-button"]',baselineUserCount:1,
  assistantRevision:0,actionId:actionId(5)};
 const fn=buildGuardedClick(cfg);
 const first=await chat.evaluate(fn);
 assert.equal(first.status,'clicked');
 const again=await chat.evaluate(fn);
 assert.equal(again.status,'refused');
 assert.equal(chat.clicks,1);
});

test('simulator: user bubble appears after a delayed response; confirmation is read-only',async()=>{
 const chat=new SimulatedChat(url(1),{delayBubble:true});
 const mcp=new SimulatedMcp([chat]);
 let checks=0;
 const result=await deliverViaPlaywright(task(),async()=>actionId(6),{
  client:mcp,wait:async()=>{
   checks++;
   if(checks===7)chat.flushMessage();
  }
 });
 assert.equal(result.status,'verified');
 assert.equal(chat.clicks,1);
});

test('simulator: event waiter wakes on MutationObserver, then times out without events',async()=>{
 const chat=new SimulatedChat(url(1));
 const snapshot=await inspect(chat);
 assert.equal(snapshot.assistantRevision,0);
 const source=buildEventWait({url:url(1),assistantRevision:0,userInsertions:0,timeoutMs:130});
 const pending=chat.evaluate(source);
 setTimeout(()=>chat.emitMutation('assistant'),25);
 const changed=await pending;
 assert.equal(changed.kind,'changed');
 assert.equal(changed.assistantRevision,1);
 const waiting=buildEventWait({url:url(1),assistantRevision:1,userInsertions:0,timeoutMs:110});
 const timeout=await chat.evaluate(waiting);
 assert.equal(timeout.kind,'timeout');
 assert.equal(chat.context.window.__mcpgoAutoSendObserver.listeners.size,0,
  'event listeners are cleaned up even after timeout');
});

test('simulator: four independent chats continue while one conversation is unknown',()=>{
 const now=Date.now();
 const chats=Array.from({length:4},(_,i)=>({
  ...task(i+1),enabled:true,status:i===0?'unknown':'scheduled',
  next_at:new Date(now-5000).toISOString()
 }));
 assert.equal(conversationState(chats,url(1)).state,'UNKNOWN');
 assert.equal(conversationState(chats,url(2)).state,'READY');
 assert.equal(eligibleToSend(chats[1],chats,now),true);
 assert.equal(nextDue(chats,now).id,'task-2');
 const sameUrl={...task(5),url:url(1),enabled:true,status:'scheduled',
  next_at:new Date(now-5000).toISOString()};
 assert.equal(eligibleToSend(sameUrl,[...chats,sameUrl],now),false);
 assert.equal(eligibleToSend(chats[2],[...chats,sameUrl],now),true);
});

test('simulator: hostile draft or untrusted selector cannot submit',async()=>{
 const chat=new SimulatedChat(url(1));
 await inspect(chat);
 chat.editorText='somebody else draft';chat.send.disabled=false;
 assert.throws(()=>buildGuardedClick({url:url(1),message:'TEST MESSAGE 1',
  editorSelector:'#prompt-textarea',sendSelector:'button.fake',
  baselineUserCount:1,actionId:actionId(7)}),/UNTRUSTED_CHAT_SELECTOR/);
 const guarded=buildGuardedClick({url:url(1),message:'TEST MESSAGE 1',
  editorSelector:'#prompt-textarea',sendSelector:'[data-testid="send-button"]',
  baselineUserCount:1,actionId:actionId(8)});
 assert.equal((await chat.evaluate(guarded)).code,'EDITOR_TEXT_CHANGED');
 assert.equal(chat.clicks,0);
});

test('simulator: repeated latest user text and shrinking virtualized history still confirm a fresh Send',async()=>{
 const message='TEST MESSAGE 1';
 const chat=new SimulatedChat(url(1),{
  userMessages:Array(6).fill(message)
 });
 const actualClick=chat.send.click.bind(chat.send);
 chat.send.click=()=>{
  actualClick();
  // Large conversations virtualize two older bubbles immediately after
  // inserting the new user bubble, so 6 before becomes only 5 visible after.
  chat.userMessages.splice(0,2);
  chat.busy=true;
 };
 const mcp=new SimulatedMcp([chat]);
 const result=await deliverViaPlaywright(task(),async()=>actionId(10),
  {client:mcp,wait:noWait});
 assert.equal(chat.clicks,1);
 assert.equal(chat.userMessages.length,5);
 assert.equal(result.status,'verified');
 assert.equal(result.evidence.code,'USER_BUBBLE_VERIFIED_VIRTUALIZED');
 assert.equal(result.evidence.newUserCount,false);
 assert.equal(mcp.calls.filter(x=>x.guarded).length,1);
});
