import {fingerprint} from './reconciliation.mjs';
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
 async request(method,params,options={}){
  const body={jsonrpc:'2.0',method};if(params!==undefined)body.params=params;
  if(method!=='notifications/initialized')body.id=++this.id;
  const headers={accept:ACCEPT,'content-type':'application/json','mcp-protocol-version':'2025-03-26'};
  if(this.session)headers['mcp-session-id']=this.session;
  if(options.actionId)headers['x-mcpgo-action-id']=options.actionId;
  if(options.expectedUrl)headers['x-mcpgo-expected-url']=options.expectedUrl;
  const response=await this.fetcher(this.url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
  this.session=response.headers.get('mcp-session-id')||this.session;
  const text=await response.text();
  if(!response.ok)throw Error('Playwright MCP HTTP '+response.status+': '+text.slice(0,200));
  return method==='notifications/initialized'?null:decodeMcp(text);
 }
 async connect(){
  const init=await this.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'McpGo-AutoSend-CDP',version:'1.1.0'}});
  if(!init?.result?.serverInfo)throw Error('Playwright MCP initialization failed');
  await this.request('notifications/initialized');
 }
 async tool(name,args,options={}){return contentOf(await this.request('tools/call',{name,arguments:args},options));}
}

export const pageInspection=`() => {
 const vis=e=>!!e && e.getClientRects().length>0;
 const url=location.origin+location.pathname.replace(/\\/$/,'');
 const prompt=[...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][role="textbox"]')].filter(vis);
 const editor=prompt.length===1?prompt[0]:null;
 const stop=[...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="Stop response"],button[aria-label="Stop"],button[aria-label="Остановить генерацию"],button[aria-label="Остановить"]')].some(vis);
 const busyText=!!document.querySelector('[data-testid="streaming-indicator"],[data-is-streaming="true"]');
 // Explicit failure signal is distinct from a legitimate long-running tool.
 // The banner may be outside <main>; read DOM text only in-memory.
 const interruptionPattern=/(?:соединени[ея] прерван[оа]|ожидание полного ответа|ответ прерван|ответ остановлен|connection interrupted|waiting for full response|response interrupted|generation stopped)/i;
 // Detect a short visible status label, NOT phrases quoted by the human in
 // their chat bubble or text editor. Never act on global document.body text.
 const errorNodes=[...document.querySelectorAll('[role="alert"],[role="status"],p,span,div')].filter(el=>{
  // Cheap DOM text check before expensive layout/visibility checks.
  const text=(el.textContent||'').trim();
  if(text.length===0 || text.length>220 || !interruptionPattern.test(text))return false;
  if(!vis(el) || el.closest?.('[data-message-author-role="user"],[class~="bg-user-message"],[contenteditable="true"]'))return false;
  return true;
 });
 const continuationButtons=[...document.querySelectorAll('button')].filter(el=>{
  const label=(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim();
  return /^(?:продолжить генерацию|продолжить ответ|continue generating|continue response)$/i.test(label)&&vis(el)&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true';
 });
 const connectionInterrupted=errorNodes.some(el=>
  ![...el.children].some(child=>{
   const text=(child.innerText||child.textContent||'').trim();
   return text.length>0 && text.length<=220 && interruptionPattern.test(text);
  })
 );
 const responseText=[...document.querySelectorAll('[data-message-author-role="assistant"],[data-testid="conversation-turn"]')].at(-1)?.innerText||document.querySelector('main')?.innerText||'';

 // ChatGPT's current UI no longer provides data-message-author-role or
 // conversation-turn for every message. The bg-user-message token identifies
 // the actual user bubble (one per message), unlike nested group/user-message
 // wrappers (two per message). Never count main text or assistant echoes here.
 const legacyUsers=[...document.querySelectorAll('[data-message-author-role="user"]')];
 const modernUsers=[...document.querySelectorAll('[class~="bg-user-message"]')];
 // Extra explicit user-author markers, never count assistant/main text.
 const testidUsers=[...document.querySelectorAll('[data-testid="user-message"]')];
 const users=legacyUsers.length?legacyUsers:modernUsers.length?modernUsers:testidUsers;
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
  stop,busyText,connectionInterrupted,continuationAvailable:continuationButtons.length>0,progressText:responseText.slice(-1500),userCount:users.length,assistantCount:assistants.length,
  lastUserText:users.length?(users.at(-1).innerText||users.at(-1).textContent||'').trim():null,
  lastUserId:users.length?(users.at(-1).getAttribute?.('data-message-id')||users.at(-1).closest?.('[data-message-id]')?.getAttribute?.('data-message-id')||null):null,
  lastUserTexts:users.slice(-2).map(e=>(e.innerText||e.textContent||'').trim()),
  mainLength:mainText.length,mainOccurrences:mainText.split('SCHEDULER_SENTINEL_NOT_PRESENT').length-1,title:document.title,login:!!document.querySelector('input[type="password"]')};
}`;
export function classifyAgent(page,expectedUrl){
 if(!page||page.url!==expectedUrl)return {kind:'deferred',reason:'Нужный разговор не открыт или произошла переадресация'};
 if(page.connectionInterrupted)return {kind:'busy',reason:'В ChatGPT прерван поток ответа; ждём восстановления соединения'};
 if(page.stop||page.busyText)return {kind:'busy',reason:'Агент ещё генерирует ответ'};
 if(page.ready!=='complete'||page.login||page.editorCount!==1||page.sendCount>1||(page.mainLength<80&&page.turnCount<1)||page.genericTitle)
  return {kind:'deferred',reason:'Страница разговора не готова или её состояние неоднозначно'};
 if(String(page.editorText||'').trim())return {kind:'busy',reason:'В чате уже есть неотправленный черновик'};
 if(!page.editorSelector)return {kind:'deferred',reason:'Не удалось определить поле ввода'};
 return {kind:'ready'};
}
// A post-click acknowledgement must be a NEW user-authored message. Main-page
// text is insufficient: the editor or an assistant quotation may echo the text.
export function normalizedMessage(value) {
 return String(value||'').replace(/[\u200b-\u200d\ufeff]/g,'')
   .replace(/\s+/g,' ').trim();
}
export function confirmsNewUserMessage(before,after,message){
 const target=normalizedMessage(message);
 if(!target || !after || !before || !Number.isInteger(after.userCount))return false;
 if(normalizedMessage(after.lastUserText)!==target)return false;
 if(after.userCount>before.userCount)return true;
 // A changed DOM ID alone is insufficient when the previous user message
 // had the exact same text: a re-render may have changed a generated ID.
 // In that case prefer a safe unknown over falsely verifying a duplicate.
 if(before.lastUserId && after.lastUserId && before.lastUserId!==after.lastUserId &&
    (before.lastUserHash||fingerprint(before.lastUserText))!==fingerprint(target))
   return true;
 // A virtualized list may keep the visible user-bubble count constant. In that
 // case, verify that the previously observed last user bubble is now the
 // penultimate actual user bubble, and reject repeated identical messages.
 const oldHash=before.lastUserHash||fingerprint(before.lastUserText);
 return Boolean(after.userCount===before.userCount && oldHash &&
   oldHash!==fingerprint(target) && after.userCount>=2 &&
   Array.isArray(after.lastUserTexts) &&
   fingerprint(after.lastUserTexts.at(-2))===oldHash);
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
  const baselineProof={userCount:baseline,lastUserHash:fingerprint(page.lastUserText),lastUserId:page.lastUserId||''};
  const actionId=await aboutToClick(baselineProof);
  clicked=true;
  await mcp.tool('browser_click',{target:filled.sendSelector},
    actionId?{actionId,expectedUrl:task.url}:{expectedUrl:task.url});
  for(let i=0;i<8;i++){
   await wait(700);
   const after=await inspect(mcp,task.message);
   if(after.url!==task.url)break;
   if(confirmsNewUserMessage(baselineProof,after,task.message))return {status:'verified'};
  }
  return {status:'pending',error:'Ожидаем появления сообщения в чате; Send повторно не нажимаем'};
 }catch(e){return {status:clicked?'pending':'deferred',reason:'error',error:String(e.message||e).slice(0,400)};}
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

/** Read-only reconciliation of a persisted click; never navigates, types or clicks.
 * A response can be delayed, a tab can disappear, or a snapshot can be stale.
 * Only a positively identified new user bubble can change status to verified.
 */
export async function reconcileViaPlaywright(task,receipt,deps={}){
 const mcp=deps.client||new LocalMcp();
 if(!Number.isInteger(receipt?.baselineUserCount))return {status:'deferred',reason:'Нет подтверждённого baseline'};
 try{
  if(!deps.client)await mcp.connect();
  const tabs=extractTabs(await mcp.tool('browser_tabs',{action:'list'}));
  const tab=tabs.find(t=>t.url===task.url);
  if(!tab)return {status:'deferred',reason:'Вкладка разговора сейчас недоступна'};
  await mcp.tool('browser_tabs',{action:'select',index:tab.index});
  const after=await inspect(mcp,task.message);
  if(after.url!==task.url)return {status:'deferred',reason:'Вкладка изменила адрес'};
  const before={userCount:receipt.baselineUserCount,lastUserHash:receipt.baselineLastUserHash,lastUserId:receipt.baselineLastUserId};
  if(confirmsNewUserMessage(before,after,task.message))return {status:'verified'};
  return {status:'deferred',reason:'Новая реплика пока не обнаружена'};
 }catch(e){return {status:'deferred',reason:String(e.message||e).slice(0,170)};}
}

/** Read only observation of an EXISTING ChatGPT tab. Never opens a new tab. */
export async function observeExistingChat(task,deps={}){
 const mcp=deps.client||new LocalMcp();
 try{
  if(!deps.client)await mcp.connect();
  const tabs=extractTabs(await mcp.tool('browser_tabs',{action:'list'}));
  const tab=tabs.find(x=>x.url===task.url);
  if(!tab)return {status:'unavailable',reason:'Вкладка не открыта'};
  await mcp.tool('browser_tabs',{action:'select',index:tab.index});
  const page=await inspect(mcp,'');
  if(page.url!==task.url)return {status:'unavailable',reason:'Вкладка изменила URL'};
  return {status:'ok',observation:{
   urlValid:true,stop:page.stop,busyText:page.busyText,
   connectionInterrupted:page.connectionInterrupted,continuationAvailable:page.continuationAvailable,progressText:page.progressText,
   editorText:page.editorText||'',editorCount:page.editorCount,
   lastUserId:page.lastUserId||'',userCount:page.userCount,
   lastUserHash:fingerprint(page.lastUserText)
  }};
 }catch(e){return {status:'unavailable',reason:String(e.message||e).slice(0,180)};}
}
/** Only invoked after persistent explicit connection-error, once per incident. */
export async function reloadStalledChat(task,deps={}){
 const mcp=deps.client||new LocalMcp();
 try{
  if(!deps.client)await mcp.connect();
  const tabs=extractTabs(await mcp.tool('browser_tabs',{action:'list'}));
  const target=tabs.find(t=>t.url===task.url);
  if(!target)return {status:'unavailable',reason:'Нужная вкладка закрыта'};
  await mcp.tool('browser_tabs',{action:'select',index:target.index});
  const before=await inspect(mcp,'');
  if(before.url!==task.url||!before.connectionInterrupted)
   return {status:'changed',reason:'Явная ошибка соединения больше не видна'};
  if(String(before.editorText||'').trim())
   return {status:'deferred',reason:'В чате пользовательский черновик; не перезагружаем'};
  // Browser navigation to the exact current conversation URL is equivalent
  // to ordinary user refresh; never click Stop/Regenerate/Send.
  await mcp.tool('browser_navigate',{url:task.url});
  return {status:'reloaded'};
 }catch(e){return {status:'deferred',reason:String(e.message||e).slice(0,180)};}
}
