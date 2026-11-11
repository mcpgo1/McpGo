/**
 * Page-scoped guarded Send. The last safety check and one Send click happen
 * synchronously in ONE browser_evaluate invocation, under the proxy's shared
 * Chrome lock. The proxy claims x-mcpgo-action-id before dispatch.
 *
 * The function source is serialized rather than evaluated by McpGo itself.
 */
export const SAFE_EDITORS=new Set([
 '#prompt-textarea','[contenteditable="true"][role="textbox"]'
]);
export const SAFE_SENDS=new Set([
 '[data-testid="send-button"]',
 'button[aria-label="Send prompt"]',
 'button[aria-label="Send message"]',
 'button[aria-label="Send"]',
 'button[aria-label="Отправить"]',
 'button[aria-label="Отправить сообщение"]'
]);

export function guardedClickInPage(cfg) {
 const refuse=code=>({status:'refused',code});
 const normalize=s=>String(s||'').replace(/[\u200b-\u200d\ufeff]/g,'')
   .replace(/\s+/g,' ').trim();
 const visible=e=>!!e&&e.getClientRects().length>0&&
   !e.closest?.('[inert]') &&
   (!e.ownerDocument?.defaultView?.getComputedStyle ||
    (e.ownerDocument.defaultView.getComputedStyle(e).visibility!=='hidden' &&
     e.ownerDocument.defaultView.getComputedStyle(e).display!=='none'));
 const current=location.origin+location.pathname.replace(/\/$/,'');
 if(current!==cfg.url)return refuse('WRONG_CONVERSATION');
 if(document.readyState!=='complete')return refuse('PAGE_NOT_READY');
 const edits=[...document.querySelectorAll(cfg.editorSelector)].filter(visible);
 if(edits.length!==1)return refuse('EDITOR_NOT_UNIQUE');
 if(normalize(edits[0].innerText||edits[0].textContent)!==normalize(cfg.message))
   return refuse('EDITOR_TEXT_CHANGED');
 const stop=[...document.querySelectorAll(
   '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="Stop response"],button[aria-label="Stop"],button[aria-label="Остановить генерацию"],button[aria-label="Остановить"]'
 )].some(visible);
 const streaming=[...document.querySelectorAll('[data-testid="streaming-indicator"],[data-is-streaming="true"]')].some(visible);
 if(stop||streaming)return refuse('GENERATION_ACTIVE');
 const observation=window.__mcpgoAutoSendObserver;
 if(cfg.assistantRevision!==null && observation?.revision!==cfg.assistantRevision)
   return refuse('ASSISTANT_CHANGED');
 const legacy=[...document.querySelectorAll('[data-message-author-role="user"]')];
 const modern=[...document.querySelectorAll('[class~="bg-user-message"]')];
 const testids=[...document.querySelectorAll('[data-testid="user-message"]')];
 const count=(legacy.length?legacy:modern.length?modern:testids).length;
 if(count!==cfg.baselineUserCount)return refuse('USER_MESSAGES_CHANGED');
 const buttons=[...document.querySelectorAll(
   '[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"],button[aria-label="Отправить"],button[aria-label="Отправить сообщение"]'
 )].filter(visible);
 if(buttons.length!==1||!buttons[0].matches?.(cfg.sendSelector))
   return refuse('SEND_NOT_UNIQUE');
 const send=buttons[0];
 if(send.disabled||send.getAttribute?.('aria-disabled')==='true')
   return refuse('SEND_DISABLED');
 const sent=window.__mcpgoAutoSendClickedIds||
   (window.__mcpgoAutoSendClickedIds=new Set());
 if(sent.has(cfg.actionId))return refuse('DUPLICATE_ACTION');
 sent.add(cfg.actionId);
 // The one and only mutating step. A lost response must NOT replay this.
 send.click();
 return {status:'clicked',code:'CLICK_DISPATCHED'};
}

export function buildGuardedClick({url,message,editorSelector,sendSelector,
                                   baselineUserCount,assistantRevision,actionId}) {
 if(typeof url!=='string'||!/^https:\/\/chatgpt\.com\/(?:g\/g-p-[a-zA-Z0-9-]+\/)?c\/[0-9a-fA-F-]{36}$/.test(url))
  throw Error('INVALID_GUARDED_CHAT_URL');
 if(typeof message!=='string'||!message.trim()||message.length>8000)
  throw Error('INVALID_GUARDED_MESSAGE');
 if(!SAFE_EDITORS.has(editorSelector)||!SAFE_SENDS.has(sendSelector))
  throw Error('UNTRUSTED_CHAT_SELECTOR');
 if(!Number.isInteger(baselineUserCount)||baselineUserCount<0)
  throw Error('INVALID_GUARDED_BASELINE');
 if(typeof actionId!=='string'||!/^autosend:[a-f0-9-]{36}$/.test(actionId))
  throw Error('INVALID_GUARDED_ACTION_ID');
 const config={url,message:message.trim(),editorSelector,sendSelector,
   baselineUserCount,assistantRevision:Number.isInteger(assistantRevision)?assistantRevision:null,
   actionId};
 // No dynamic eval in the local server. browser_evaluate evaluates the
 // serialized function in the selected personal Chrome tab only.
 return '() => ('+guardedClickInPage.toString()+')('+JSON.stringify(config)+')';
}
export function parseGuardedResult(text,parsePageResult) {
 const result=parsePageResult(text);
 if(result?.status==='clicked'&&result.code==='CLICK_DISPATCHED')
   return {clicked:true,code:result.code};
 if(result?.status==='refused'&&typeof result.code==='string'&&/^[A-Z_]+$/.test(result.code))
   return {clicked:false,refused:true,code:result.code};
 throw Error('GUARDED_CLICK_OUTCOME_UNCERTAIN');
}
