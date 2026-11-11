'use strict';
let working=false;
let last=null;
const $=id=>document.getElementById(id);
const mark=(id,on,label,warn=false)=>{const el=$(id); el.className='dotline'+(on?' on':warn?' warn':'');el.textContent=label;};
function render(data){
  last=data;
  const t=data.terminal,p=data.playwright;
  const rec=data.recovery||{};
  const textFor={CONNECTED:'Туннель готов',DEGRADED:'Подключение не готово',
    RECOVERING:'Восстановление соединения',OFFLINE:'Локальный MCP недоступен',
    AUTH_REQUIRED:'Нужна авторизация',NEEDS_ATTENTION:'Нужна проверка',
    STOPPED_BY_USER:'Процесс запускается вручную',
    UNMONITORED:'Мониторинг после следующего запуска',CHECKING:'Проверка подключения'};
  const tunnelLabel=(target,running)=>!running?'Не запущен':
    textFor[rec[target]?.status]||'Процесс запущен';

  const terminalOn=t.server.running&&t.oneshot.running&&t.tunnel.running;
  const browserOn=p.browser.running&&p.backend&&p.proxy.running&&p.proxyReady&&p.mcpReady===true&&p.tunnel.running;
  for(const [group,on,any] of [['terminal',terminalOn,t.server.running||t.oneshot.running||t.tunnel.running],['playwright',browserOn,p.browser.running||p.proxy.running||p.tunnel.running]]){
    const el=$(group+'-state'); el.textContent=on?'Локально запущен':any?'Частично включён':'Остановлен';el.className='state'+(on?' on':any?' partial':'');
    const block=document.querySelector('[data-group="'+group+'"]');
    for(const btn of block.querySelectorAll('[data-action]'))btn.disabled=working||data.busy||(btn.dataset.action==='start'&&on)||(btn.dataset.action==='stop'&&!any)||(btn.dataset.action==='restart'&&!any);
  }
  mark('terminal-server',t.server.running,' '+(t.server.running?'Работает':'Не запущен'));
  mark('terminal-oneshot',t.oneshot.running,' '+(t.oneshot.running?'Работает':'Не запущен'));
  mark('terminal-tunnel',t.tunnel.running&&rec.terminal?.status==='CONNECTED',
    tunnelLabel('terminal',t.tunnel.running),t.tunnel.running&&rec.terminal?.status==='NEEDS_ATTENTION');
  mark('playwright-browser',p.browser.running&&p.backend,p.backend?'Порт открыт':'Не запущен',p.browser.running&&!p.backend);
  mark('playwright-proxy',p.proxy.running&&p.proxyReady&&p.mcpReady===true,p.proxyReady?(p.mcpReady===true?'MCP работает':'MCP недоступен'):'Не запущен',p.proxy.running&&p.mcpReady!==true);
  mark('playwright-tunnel',p.tunnel.running&&rec.playwright?.status==='CONNECTED',
    p.configured?tunnelLabel('playwright',p.tunnel.running):'Не настроен',
    !p.configured||rec.playwright?.status==='NEEDS_ATTENTION');
  $('playwright-hint').textContent=!p.configured?
    'Для туннеля не хватает сохранённой конфигурации. Подробности в README.':
    rec.playwright?.desired?
    'Автовосстановление туннеля включено. Chrome, активные задачи и действия не перезапускаются.':
    'Нажмите «Запустить», чтобы включить автоматический контроль туннеля после успешного запуска.';
  $('updated').textContent='Статус: '+new Date(data.updatedAt).toLocaleTimeString('ru-RU');
}
async function refresh(){try{const response=await fetch('/api/status',{cache:'no-store'});if(!response.ok)throw Error('Ошибка связи с панелью');render(await response.json());}catch(e){flash(e.message,true);}}
let noticeTimeout;
function flash(msg,error=false){const n=$('notice');n.textContent=msg;n.className='notice'+(error?' error':'');n.hidden=false;clearTimeout(noticeTimeout);noticeTimeout=setTimeout(()=>n.hidden=true,error?9000:3500);}
async function act(group,action){if(working)return;working=true;if(last)render(last);
  try{const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-mcp-hub':'dashboard'},body:JSON.stringify({group,action})});const obj=await response.json();if(!response.ok)throw Error(obj.error||'Действие не выполнено');if(obj.status)render(obj.status);flash(action==='start'?'Запуск выполнен':action==='stop'?'Остановлено':action==='restart'?'Перезапущено':'Открыто');}
  catch(e){flash(e.message,true);}finally{working=false;await refresh();}
}
document.querySelectorAll('.service').forEach(el=>el.querySelectorAll('button[data-action]').forEach(btn=>btn.addEventListener('click',()=>act(el.dataset.group,btn.dataset.action))));
$('refresh').addEventListener('click',refresh);$('folder').addEventListener('click',()=>act('system','folder'));$('logs').addEventListener('click',()=>act('system','logs'));
refresh();setInterval(()=>{if(!working)refresh();},3500);
