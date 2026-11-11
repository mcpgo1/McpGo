/**
 * Deterministic, entirely offline ChatGPT DOM fixture.
 * Runs the REAL pageInspection and guardedClickInPage JS in a sandboxed VM.
 * No Chrome, network, real conversations or send actions are involved.
 */
import vm from 'node:vm';

const makeElement=(state,kind,text='')=>{
 const value={
  nodeType:1,kind,innerText:text,textContent:text,disabled:false,children:[],
  getClientRects(){return this.hidden?[]:[{}]},
  closest(){return null},
  getAttribute(name){
   if(name==='data-testid')return kind==='send'?'send-button':null;
   if(name==='data-message-id')return this.messageId||null;
   if(name==='aria-disabled')return this.disabled?'true':null;
   return null;
  },
  matches(sel){
   if(kind==='send')return sel==='[data-testid="send-button"]';
   if(kind==='user')return sel.includes('[data-message-author-role="user"]')||
     sel.includes('[class~="bg-user-message"]');
   return false;
  },
  click(){
   if(kind!=='send')throw Error('Not a send button');
   state.clicks++;
   state.pendingMessage=state.editorText;
   state.editorText='';
   state.send.disabled=true;
   if(!state.delayBubble)state.flushMessage();
  }
 };
 return value;
};
export class SimulatedChat {
 constructor(url,{busy=false,interrupted=false,delayBubble=false,userMessages=['Earlier user message']}={}){
  this.url=url;
  this.busy=busy;this.interrupted=interrupted;
  this.delayBubble=delayBubble;
  this.userMessages=[...userMessages];
  this.editorText='';
  this.clicks=0;this.pendingMessage=null;
  this.send=makeElement(this,'send');
  this.editor=makeElement(this,'editor');
  this.main=makeElement(this,'main');
  this.stop=makeElement(this,'stop');
  this.streaming=makeElement(this,'streaming');
  this.alert=makeElement(this,'alert','Connection interrupted');
  this.assistant=makeElement(this,'assistant','Earlier answer');
  this.assistant.closest=selector=>
   selector.includes('[data-message-author-role="assistant"]')?this.assistant:null;
  const state=this;
  const doc={
   readyState:'complete',title:'Conversation',
   querySelector(sel) {
    if(sel==='main')return state.main;
    if(sel==='input[type="password"]')return null;
    return null;
   },
   querySelectorAll(sel){
    if(sel==='#prompt-textarea,[contenteditable="true"][role="textbox"]'||
       sel==='#prompt-textarea')return [state.editor];
    if(sel.startsWith('[data-testid="stop-button"]'))return state.busy?[state.stop]:[];
    if(sel.startsWith('[data-testid="streaming-indicator"]'))return state.busy?[state.streaming]:[];
    if(sel.startsWith('[role="alert"],'))return state.interrupted?[state.alert]:[];
    if(sel==='button')return [];
    if(sel==='[data-message-author-role="user"]')return state.userMessages.map((message,i)=>{
     const el=makeElement(state,'user',message);
     el.messageId='user-'+(i+1);return el;
    });
    if(sel==='[class~="bg-user-message"]'||sel==='[data-testid="user-message"]')return [];
    if(sel==='[data-message-author-role="assistant"]')return [state.assistant];
    if(sel.startsWith('[data-testid="conversation-turn"]'))return [state.assistant];
    if(sel.startsWith('[data-testid="send-button"]'))return [state.send];
    return [];
   }
  };
  this.document=doc;
  const window={};
  const location=new URL(url);
  this.observers=[];
  const client=this;
  class FakeObserver {
   constructor(cb){this.callback=cb;client.observers.push(this)}
   observe(){}
   disconnect(){}
  }
  this.context=vm.createContext({
   document:doc,window,location,MutationObserver:FakeObserver,
   Date,Set,Promise,setTimeout,clearTimeout
  });
  Object.defineProperties(this.editor,{
   innerText:{get:()=>state.editorText},
   textContent:{get:()=>state.editorText}
  });
  Object.defineProperties(this.main,{
   innerText:{get:()=>('Earlier user and assistant messages. '.repeat(12)+state.userMessages.join(' '))},
   textContent:{get:()=>('Earlier user and assistant messages. '.repeat(12)+state.userMessages.join(' '))}
  });
  this.editor.id='prompt-textarea';
  this.editor.ownerDocument=doc;
  this.send.ownerDocument=doc;
  this.stop.ownerDocument=doc;
  this.streaming.ownerDocument=doc;
  this.assistant.ownerDocument=doc;
  this.main.ownerDocument=doc;
  this.alert.ownerDocument=doc;
  doc.defaultView={getComputedStyle:()=>({visibility:'visible',display:'block'})};
 }
 flushMessage(){
  if(!this.pendingMessage)return;
  this.userMessages.push(this.pendingMessage);
  this.pendingMessage=null;
  this.emitMutation('user');
 }
 emitMutation(kind='assistant'){
  const target=kind==='assistant'?this.assistant:
    kind==='user'?makeElement(this,'user',this.userMessages.at(-1)):this.main;
  if(kind==='assistant'){
   this.assistant.innerText='Assistant response revised';
   this.assistant.textContent=this.assistant.innerText;
  }
  for(const obs of this.observers)obs.callback([{
   target,addedNodes:kind==='user'?[target]:[]
  }]);
 }
 async evaluate(source) {
  return await vm.runInContext('('+source+')()',this.context,{timeout:1500});
 }
}
export class SimulatedMcp {
 constructor(chats){
  this.chats=[...chats];
  this.active=0;
  this.calls=[];
  this.dispatched=new Set();
  this.lostAfterClick=false;
  this.onBeforeTool=null;
 }
 get chat(){return this.chats[this.active]}
 async tool(name,args={},options={}){
  this.calls.push({name,action:args.action||null, guarded:!!args.function?.includes('function guardedClickInPage')});
  if(this.onBeforeTool)await this.onBeforeTool(name,args,options,this);
  if(name==='browser_tabs') {
   if(args.action==='list')return this.chats.map((c,i)=>'- '+i+': Chat ('+c.url+')').join('\n');
   if(args.action==='select'){
    if(!this.chats[args.index])throw Error('TAB_MISSING');
    this.active=args.index;return 'selected';
   }
   if(args.action==='new')throw Error('No browser navigation during offline simulator');
  }
  if(options.expectedUrl&&options.expectedUrl!==this.chat.url)
   throw Error('ACTIVE_TAB_SCOPE_MISMATCH');
  if(name==='browser_type') {
   this.chat.editorText=args.text;
   this.chat.send.disabled=!args.text;
   return 'typed';
  }
  if(name==='browser_evaluate') {
   if(options.actionId) {
    if(this.dispatched.has(options.actionId))throw Error('ALREADY_DISPATCHED');
    this.dispatched.add(options.actionId); // Durable proxy claim BEFORE dispatch.
   }
   const value=await this.chat.evaluate(args.function);
   if(options.actionId && this.lostAfterClick && value?.status==='clicked')
    throw Error('TRANSPORT_LOST_AFTER_CLICK');
   return '### Result\n'+JSON.stringify(value);
  }
  throw Error('Unexpected simulator tool '+name);
 }
}
