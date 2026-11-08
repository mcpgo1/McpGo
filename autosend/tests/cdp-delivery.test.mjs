import {test} from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {classifyAgent,parsePageResult,extractTabs,pageInspection,deliverViaPlaywright,confirmsNewUserMessage} from '../cdp-delivery.mjs';
const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const task={url,message:'Test scheduler CDP'};
const page={url,ready:'complete',editorCount:1,editorText:'',editorSelector:'#prompt-textarea',
 sendCount:1,sendSelector:'[data-testid="send-button"]',sendEnabled:false,turnCount:5,genericTitle:false,stop:false,busyText:false,userCount:5,assistantCount:5,
 lastUserText:'Old',mainLength:1250,title:'Previous Chat',login:false};
function fake(initial={}){
 const calls=[];const state={...page,...initial};let committed=false;
 const client={async tool(name,args){
  calls.push({name,args});
  if(name==='browser_tabs' && args.action==='new')return '### Result\n- 9: '+url;
  if(name==='browser_tabs' && args.action==='list')return '- 9: '+url;
  if(name==='browser_tabs' && args.action==='select')return 'selected';
  if(name==='browser_tabs' && args.action==='close')return 'closed';
  if(name==='browser_evaluate')return '### Result\n```json\n'+JSON.stringify(state)+'\n```';
  if(name==='browser_type'){state.editorText=args.text;state.sendEnabled=!!args.text;return 'typed';}
  if(name==='browser_click'){assert.equal(args.target,'[data-testid="send-button"]');assert.ok(committed);state.userCount++;state.lastUserText=task.message;return 'clicked';}
  throw Error('unexpected '+name);
 }};
 return {client,calls,state,commit:()=>{committed=true;}};
}
test('readiness fails closed for busy agent, draft, wrong conversation and ambiguous page',()=>{
 for (const p of [{stop:true},{busyText:true},{editorText:'human draft'}])assert.equal(classifyAgent({...page,...p},url).kind,'busy');
 for (const p of [{url:'https://chatgpt.com/'},{editorCount:0},{mainLength:5,turnCount:0},{genericTitle:true},{login:true}])assert.equal(classifyAgent({...page,...p},url).kind,'deferred');
 assert.equal(classifyAgent(page,url).kind,'ready');
});
test('CDP browser tab indexes are parsed conservatively',()=>{
 assert.deepEqual(extractTabs('### Result\n- 2: Chat (https://chatgpt.com/c/aaa)\n3: cloud (https://console.cloud.ru/)'),[{index:2,url:'https://chatgpt.com/c/aaa'},{index:3,url:'https://console.cloud.ru'}]);
});
test('MCP results parse fenced and plain JSON',()=>{
 assert.equal(parsePageResult('### Result\n```json\n{"stop":true}\n```').stop,true);
 assert.equal(parsePageResult('### Result\n{"stop":false}').stop,false);
});
test('MCP result parser ignores echoed Playwright JavaScript with braces',()=>{
 const response = [
  '### Result',
  JSON.stringify({stop:false,title:'quoted "brace}"'}),
  '### Ran Playwright code',
  '```js',
  "await page.evaluate('() => { const x = {stop: true}; return x; }');",
  '```',
 ].join('\n');
 const obj=parsePageResult(response);
 assert.equal(obj.stop,false);
 assert.ok(obj.title.includes('brace}'));
});
test('MCP result parser rejects invalid JSON instead of parsing echoed source',()=>{
 const response=['### Result','{stop:false}','### Ran Playwright code','```js','({stop:true})','```'].join('\n');
 assert.throws(()=>parsePageResult(response),/некорректный JSON/);
});
test('busy chat never types or clicks and skips current slot',async()=>{
 const f=fake({stop:true});const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},{client:f.client});
 assert.equal(result.status,'deferred');assert.equal(result.reason,'busy');
 assert.ok(!f.calls.some(c=>c.name==='browser_type'||c.name==='browser_click'));
});
test('wrong destination never types or clicks',async()=>{
 const f=fake({url:'https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});
 const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},{client:f.client});
 assert.equal(result.status,'deferred');
 assert.ok(!f.calls.some(c=>c.name==='browser_click'));
});
test('successful send persists before click and verifies new user message',async()=>{
 const f=fake();let persisted=false;
 const result=await deliverViaPlaywright(task,async()=>{persisted=true;f.commit();},{client:f.client});
 assert.equal(result.status,'verified');assert.ok(persisted);
 assert.equal(f.calls.filter(x=>x.name==='browser_click').length,1);
 assert.equal(f.calls.filter(x=>x.name==='browser_type').length,1);
 assert.ok(!f.calls.some(x=>x.name==='browser_tabs' && x.args.action==='new'),'reuse opened personal Chrome tab');
});
test('failure before click does not send or commit, and clears own draft',async()=>{
 const f=fake();const original=f.client.tool;
 f.client.tool=async(name,args)=>{
  if(name==='browser_evaluate' && f.calls.some(x=>x.name==='browser_type'))f.state.stop=true;
  return original(name,args);
 };
 const result=await deliverViaPlaywright(task,()=>{throw Error('must not click')},{client:f.client});
 assert.equal(result.status,'deferred');assert.ok(!f.calls.some(x=>x.name==='browser_click'));
});

test('browser evaluation source parses as a real JavaScript function',()=>{
 assert.equal(typeof Function('return ('+pageInspection+')')(),'function');
});

test('current ChatGPT user bubbles are counted without legacy author attributes',()=>{
 const userBubbles=['Earlier message','Test scheduler CDP'].map(innerText=>({innerText}));
 const document={
  readyState:'complete',
  title:'A real conversation',
  querySelectorAll(selector){
   if(selector==='[class~="bg-user-message"]')return userBubbles;
   return [];
  },
  querySelector(selector){
   if(selector==='main')return {innerText:'Long conversation history with multiple messages and an editor on this page.'};
   return null;
  },
 };
 const location={origin:'https://chatgpt.com',pathname:'/c/00000000-0000-4000-8000-000000000001'};
 const result=vm.runInNewContext('('+pageInspection+')()', {document,location});
 assert.equal(result.userCount,2);
 assert.equal(result.lastUserText,'Test scheduler CDP');
 assert.equal(result.turnCount,0,'the modern DOM may have no conversation-turn nodes');
});

test('strict acknowledgement requires a new actual user bubble with exact text',()=>{
 const old={userCount:4,mainOccurrences:3};
 assert.equal(confirmsNewUserMessage(old,{userCount:5,lastUserText:'Test scheduler CDP'},'Test scheduler CDP'),true);
 assert.equal(confirmsNewUserMessage(old,{userCount:4,lastUserText:'Test scheduler CDP',mainOccurrences:4},'Test scheduler CDP'),false,'repeated text in assistant or editor is not evidence');
 assert.equal(confirmsNewUserMessage(old,{userCount:5,lastUserText:'Different message'},'Test scheduler CDP'),false);
 assert.equal(confirmsNewUserMessage(old,{userCount:3,lastUserText:'Test scheduler CDP'},'Test scheduler CDP'),false);
});

test('a repeated phrase in page text cannot falsely confirm a click',async()=>{
 const f=fake({mainOccurrences:2});
 const original=f.client.tool;
 f.client.tool=async(name,args)=>{
  const value=await original(name,args);
  if(name==='browser_click'){
    // New ChatGPT response quoted the same text, but there was no new
    // observed user-authored bubble, so the click outcome is ambiguous.
    f.state.userCount--;
    f.state.mainOccurrences=3;
    f.state.editorText='';
  }
  return value;
 };
 const result=await deliverViaPlaywright(task,async()=>f.commit(),{client:f.client,wait:async()=>{}});
 assert.equal(result.status,'pending');
 assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1,'never retry an ambiguous click');
});
