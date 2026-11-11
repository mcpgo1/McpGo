'use strict';
const $=id=>document.getElementById(id);
const message=(value,failed=false)=>{const m=$('message');m.textContent=value;m.style.color=failed?'#f7a5a5':'#8cbea4'};
let initialized=false;
function render(data) {
 if(!initialized){
  $('terminal-id').value=data.terminal.id||'';
  $('browser-id').value=data.browserTunnel.id||'';
  $('browser').value=data.browser;
  $('autoStart').checked=data.autoStart;
  initialized=true;
 }
 for(const [key,value] of Object.entries(data.status||{})){
  const el=$('state-'+key);if(!el)continue;
  const messages={running:'Запущен',stopped:'Остановлен',starting:'Запуск',unconfigured:'Не настроен'};
  el.textContent=messages[value]||value;
  el.className=value==='running'?'ok':(value==='stopped'||value==='unconfigured'?'':'warn');
 }
}
window.mcpgo.onStatus(render);
window.mcpgo.status().then(data=>{render(data);message('Локальные сервисы запускаются автоматически.')})
  .catch(e=>message(e.message,true));
$('settings').addEventListener('submit',async event=>{
 event.preventDefault();
 const button=document.querySelector('button[type=submit]');button.disabled=true;
 try{
  const terminalId=$('terminal-id').value.trim(),browserId=$('browser-id').value.trim();
  const data={browser:$('browser').value,autoStart:$('autoStart').checked,
    terminal:terminalId?{id:terminalId,key:$('terminal-key').value}:undefined,
    browserTunnel:browserId?{id:browserId,key:$('browser-key').value}:undefined};
  const result=await window.mcpgo.save(data);
  $('terminal-key').value='';$('browser-key').value='';
  render(result);message('Настройки сохранены. Сервисы переподключены.');
 }catch(e){message(e.message,true)}finally{button.disabled=false}
});
$('restart').addEventListener('click',async()=>{
 try{message('Перезапуск компонентов...');render(await window.mcpgo.restart());message('Запрос на перезапуск выполнен.')}
 catch(e){message(e.message,true)}
});
$('browser-docs').addEventListener('click',()=>window.mcpgo.docs().catch(e=>message(e.message,true)));
