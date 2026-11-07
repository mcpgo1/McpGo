// Scheduled ChatGPT delivery over the already-running local PlaywrightHub CDP MCP.
// Deliberately does not create a Chromium/profile, interact with the old extension,
// or auto-retry after the Send button could have been clicked.
const MCP_URL=process.env.MCPHUB_PLAYWRIGHT_MCP_URL||'http://127.0.0.1:8940/mcp';
const ACCEPT='application/json, text/event-stream';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function decodeMcp(text){
 if(text.trimStart().startsWith('{'))return JSON.parse(text);
 for(const line of text.split(/\r?\n/))if(line.startsWith('data: ')){
  try{return JSON.parse(line.slice(6));}catch{}
 }
 throw Error('Playwright MCP returned an unreadable response');
}
function contentOf(result){
 if(result?.error)throw Error('MCP: '+String(result.error.message||'error'));
 if(result?.result?.isError)throw Error('Playwright: '+(result.result.content||[]).map(c=>c.text||'').join(' ').slice(0,400));
 return (result?.result?.content||[]).map(c=>c.text||'').join('\n');
}
export function parsePageResult(text){
 // Playwright includes "### Result" followed by "### Ran Playwright code".
 // Only the first section is data; the subsequent section contains JS source
 // (often with braces), and must NEVER be included in JSON.parse.
 const resultHeader=/^### Result\s*$/m;
 const match=resultHeader.exec(text);
 const section=match?text.slice(match.index+match[0].length).split(/^### /m,1)[0]:text;
 const fenced=section.match(/```(?:json)?\s*([\s\S]*?)```/);
 const candidate=(fenced?.[1]||section).trim();
 // parse the value, not a JavaScript object literal or the echoed source code.
 try { return JSON.parse(candidate); }
 catch { throw Error('Playwright MCP: некорректный JSON в разделе Result'); }
}
export class LocalMcp {
 constructor(url=MCP_URL, fetcher=fetch){this.url=url;this.fetcher=fetcher;this.session='';this.id=0;}
 async request(method,params){
  const body={jsonrpc:'2.0',method};if(params!==undefined)body.params=params;
  if(method!=='notifications/initialized')body.id=++this.id;
  const headers={accept:ACCEPT,'content-type':'application/json','mcp-protocol-version':'2025-03-26'};
  if(this.session)headers['mcp-session-id']=this.session;
  const response=await this.fetcher(this.url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
  this.session=response.headers.get('mcp-session-id')||this.session;
  const text=await response.text();
  if(!response.ok)throw Error('Playwright MCP HTTP '+response.status+': '+text.slice(0,200));
  return method==='notifications/initialized'?null:decodeMcp(text);
 }
 async connect(){
  const init=await this.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'MCPHub-AutoSend-CDP',version:'1.0.0'}});
  if(!init?.result?.serverInfo)throw Error('Playwright MCP initialization failed');
  await this.request('notifications/initialized');
 }
 async tool(name,args){return contentOf(await this.request('tools/call',{name,arguments:args}));}
}

export const pageInspection=`() => {
 const vis=e=>!!e && e.getClientRects().length>0;
 const url=location.origin+location.pathname.replace(/\\/$/,'');
 const prompt=[...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][role="textbox"]')].filter(vis);
 const editor=prompt.length===1?prompt[0]:null;
 const stop=[...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="Stop response"],button[aria-label="Stop"],button[aria-label="Остановить генерацию"],button[aria-label="Остановить"]')].some(vis);
 const busyText=!!document.querySelector('[data-testid="streaming-indicator"],[data-is-streaming="true"]');
 // ChatGPT's current UI no longer provides data-message-author-role or
 // conversation-turn for every message. The bg-user-message token identifies
 // the actual user bubble (one per message), unlike nested group/user-message
 // wrappers (two per message). Never count main text or assistant echoes here.
 const legacyUsers=[...document.querySelectorAll('[data-message-author-role="user"]')];
 const modernUsers=[...document.querySelectorAll('[class~="bg-user-message"]')];
 const users=legacyUsers.length?legacyUsers:modernUsers;
 const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
 const turns=[...document.querySelectorAll('[data-testid="conversation-turn"],[data-message-id],[data-message-author-role],main article')];
 const send=[...document.querySelectorAll('[data-testid="send-button"]')].filter(vis);
 const main=document.querySelector('main');
 const mainText=main?.innerText||main?.textContent||'';
 const genericTitle=/^(chatgpt|new chat|новый чат)(\s*[-|].*)?$/i.test(document.title.trim());
 const sendButtons=[...document.querySelectorAll('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"],button[aria-label="Отправить"],button[aria-label="Отправить сообщение"]')].filter(vis);
 return {url,ready:document.readyState,editorCount:prompt.length,editorText:editor?.innerText||editor?.textContent||'',
  editorSelector:editor?.id==='prompt-textarea'?'#prompt-textarea':'[contenteditable="true"][role="textbox"]',
  sendCount:sendButtons.length,sendEnabled:sendButtons.length===1&&!sendButtons[0].disabled&&sendButtons[0].getAttribute('aria-disabled')!=='true',
  sendSelector:sendButtons.length===1?(sendButtons[0].getAttribute('data-testid')==='send-button'?'[data-testid="send-button"]':'button[aria-label="'+sendButtons[0].getAttribute('aria-label')+'"]'):null,
  turnCount:turns.length,genericTitle,
  stop,busyText,userCount:users.length,assistantCount:assistants.length,
  lastUserText:users.length?users.at(-1).innerText.trim():null,
  mainLength:mainText.length,mainOccurrences:mainText.split('SCHEDULER_SENTINEL_NOT_PRESENT').length-1,title:document.title,login:!!document.querySelector('input[type="password"]')};
}`;
export function classifyAgent(page,expectedUrl){
 if(!page||page.url!==expectedUrl)return {kind:'deferred',reason:'Нужный разговор не открыт или произошла переадресация'};
 if(page.stop||page.busyText)return {kind:'busy',reason:'Агент ещё генерирует ответ'};
 if(page.ready!=='complete'||page.login||page.editorCount!==1||page.sendCount>1||(page.mainLength<80&&page.turnCount<1)||page.genericTitle)
  return {kind:'deferred',reason:'Страница разговора не готова или её состояние неоднозначно'};
 if(String(page.editorText||'').trim())return {kind:'busy',reason:'В чате уже есть неотправленный черновик'};
 if(!page.editorSelector)return {kind:'deferred',reason:'Не удалось определить поле ввода'};
 return {kind:'ready'};
}
// A post-click acknowledgement must be a NEW user-authored message. Main-page
// text is insufficient: the editor or an assistant quotation may echo the text.
export function confirmsNewUserMessage(before,after,message){
 return after?.userCount>before?.userCount &&
   String(after.lastUserText||'').trim()===String(message||'').trim();
}
async function inspect(mcp,message=''){
 const statement=pageInspection.replace("'SCHEDULER_SENTINEL_NOT_PRESENT'",JSON.stringify(message.trim()));
 return parsePageResult(await mcp.tool('browser_evaluate',{function:statement}));
}
export function extractTabs(text){
 const out=[];
 for(const line of text.split('\n')){
  const match=line.match(/^\s*(?:-\s*)?(\d+):\s+(.+)$/);
  if(!match)continue;
  const u=match[2].match(/https?:\/\/[^\s)\]<>]+/);
  if(u)out.push({index:Number(match[1]),url:u[0].replace(/\/$/,'')});
 }
 return out;
}
export async function deliverViaPlaywright(task,aboutToClick=async()=>{},deps={}){
 const mcp=deps.client||new LocalMcp();const wait=deps.wait||pause;
 let index=null;let clicked=false;let typed=false;
 try{
  if(!deps.client)await mcp.connect();
  const tabList=extractTabs(await mcp.tool('browser_tabs',{action:'list'}));
  const existing=tabList.find(t=>t.url===task.url);
  if(existing){index=existing.index;await mcp.tool('browser_tabs',{action:'select',index});}
  else{
   const opened=await mcp.tool('browser_tabs',{action:'new',url:task.url});
   index=extractTabs(opened).find(t=>t.url===task.url)?.index??null;
  }
  let page;
  for(let i=0;i<6;i++){
   page=await inspect(mcp,task.message);
   const state=classifyAgent(page,task.url);
   if(state.kind==='ready'||state.kind==='busy')break;
   if(page.url!==task.url)break;
   await wait(1100);
  }
  const state=classifyAgent(page,task.url);
  if(state.kind!=='ready')return {status:'deferred',reason:state.kind,error:state.reason};
  const baseline=page.userCount;
  await mcp.tool('browser_type',{target:page.editorSelector,text:task.message,submit:false});
  typed=true;
  const filled=await inspect(mcp,task.message);
  if(filled.url!==task.url||filled.stop||filled.busyText||filled.userCount!==baseline||filled.editorCount!==1||
     String(filled.editorText||'').trim()!==task.message.trim()||!filled.sendEnabled||filled.sendCount!==1||!filled.sendSelector)
   return {status:'deferred',reason:'preclick',error:'Состояние страницы изменилось перед отправкой; сообщение не отправлено'};
  // Write crash-safe "sending" state before clicking. Ambiguous post-click results never retry.
  await aboutToClick();
  clicked=true;
  await mcp.tool('browser_click',{target:filled.sendSelector});
  for(let i=0;i<8;i++){
   await wait(700);
   const after=await inspect(mcp,task.message);
   if(after.url!==task.url)break;
   if(confirmsNewUserMessage({userCount:baseline},after,task.message))return {status:'verified'};
  }
  return {status:'unknown',error:'Кнопка отправки нажата, но новое сообщение не подтверждено'};
 }catch(e){return {status:clicked?'unknown':'deferred',reason:'error',error:String(e.message||e).slice(0,400)};}
 finally {
  // Never erase an existing draft: only clear our own pre-click text, and only if still exact.
  if(typed&&!clicked){
   try{const p=await inspect(mcp,task.message);if(p.url===task.url && String(p.editorText||'').trim()===task.message.trim())
    await mcp.tool('browser_type',{target:p.editorSelector,text:'',submit:false});}catch{}
  }
  // Keep the existing or newly opened conversation tab: closing it may interrupt
  // the assistant response, and the next interval should reuse the same tab.
 }
}
