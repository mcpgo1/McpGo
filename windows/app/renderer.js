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


const wizard=$('wizard-status');
async function runWizard(action,data){
 const buttons=[$('create-tunnels'),$('create-runtime')];
 buttons.forEach(b=>b.disabled=true);
 try{return await window.mcpgo.onboard(action,data)}
 catch(e){wizard.textContent=e.message;throw e}
 finally{buttons.forEach(b=>b.disabled=false)}
}
$('create-tunnels').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 if(!$('organization-id').value.trim()&&!$('workspace-id').value.trim())
  return wizard.textContent='Укажите Organization ID либо Workspace ID';
 wizard.textContent='Создание туннелей...';
 try{
  const r=await runWizard('provision',{adminKey:$('admin-key').value,confirmed:true,
   organizationId:$('organization-id').value.trim(),workspaceId:$('workspace-id').value.trim()});
  $('terminal-id').value=r.tunnels.terminal;
  $('browser-id').value=r.tunnels.browser;
  wizard.textContent='Туннели созданы. Можно выдать Runtime Key.';
 }catch{}
};
$('create-runtime').onclick=async()=>{
 if(!$('admin-key').value)return wizard.textContent='Введите ключ администратора';
 wizard.textContent='Выпуск Runtime Key...';
 try{
  await runWizard('runtime-auto',{adminKey:$('admin-key').value,confirmed:true,createProject:true});
  $('admin-key').value='';
  const r=await window.mcpgo.status();
  $('terminal-id').value=r.terminal.id;$('browser-id').value=r.browserTunnel.id;
  render(r);wizard.textContent='Туннели подключаются. Ключ сохранён.';
 }catch{}
};
function element(tag,text){
 const node=document.createElement(tag);node.textContent=String(text);return node;
}
function item(title,lines,buttons=[]){
 const box=element('div','');box.className='item';box.append(element('strong',title));
 for(const line of lines)box.append(element('small',line));
 if(buttons.length){
  const bar=element('div','');bar.className='actions';
  for(const {label,run} of buttons){
   const btn=element('button',label);btn.type='button';btn.className='minor';
   btn.onclick=run;bar.append(btn);
  }box.append(bar);
 }
 return box;
}
async function doTask(action,id){
 try{
  await window.mcpgo.serviceAction('autosend','/api/tasks',{action,id});
  await refreshTasks();
 }catch(e){message(e.message,true)}
}
async function refreshTasks(){
 const list=$('tasks-list');list.replaceChildren();
 try{
  const {tasks=[]}=await window.mcpgo.serviceRead('autosend','/api/status');
  for(const t of tasks){
   const pending=['sending','checking','verifying'].includes(t.status);
   const buttons=pending||t.status==='unknown'?[]:
     t.enabled?[{label:'Пауза',run:()=>doTask('pause',t.id)}]:
     [{label:'Включить',run:()=>doTask('start',t.id)},
      {label:'Удалить',run:()=>{if(confirm('Удалить расписание?'))doTask('remove',t.id)}}];
   list.append(item(t.url,[
    'Статус: '+t.status+'; '+(t.enabled?'Включено':'Выключено'),
    String(t.message||'').slice(0,150),
    'Интервал: '+t.interval_seconds+' сек.; следующий: '+(t.next_at||'нет'),
    t.last_error||''
   ].filter(Boolean),buttons));
  }
  if(!tasks.length)list.append(item('Расписания отсутствуют',[]));
 }catch(e){list.append(item('Планировщик недоступен',[e.message]))}
}
$('refresh-tasks').onclick=refreshTasks;
$('task-create').onsubmit=async event=>{
 event.preventDefault();const btn=event.submitter;btn.disabled=true;
 try{
  await window.mcpgo.serviceAction('autosend','/api/tasks',{
   action:'create',url:$('task-url').value.trim(),message:$('task-message').value,
   interval_seconds:Number($('task-interval').value)*60});
  $('task-create').reset();message('Расписание создано выключенным');await refreshTasks();
 }catch(e){message(e.message,true)}finally{btn.disabled=false}
};
async function refreshAgents(){
 const list=$('agents-list');list.replaceChildren();
 try{
  const {agents=[]}=await window.mcpgo.serviceRead('messaging','/api/agents');
  for(const a of agents)list.append(item(a.label||a.id,
   ['ID: '+a.id+'; '+a.role]));
  if(!agents.length)list.append(item('Нет зарегистрированных агентов',[]));
 }catch(e){list.append(item('Сервис агентов недоступен',[e.message]))}
}
$('refresh-agents').onclick=refreshAgents;
$('agent-create').onsubmit=async event=>{
 event.preventDefault();const btn=event.submitter;btn.disabled=true;
 try{
  await window.mcpgo.serviceAction('messaging','/api/agents',{
   id:$('agent-id').value.trim(),label:$('agent-label').value.trim(),role:'agent'});
  $('agent-create').reset();message('Агент зарегистрирован');await refreshAgents();
 }catch(e){message(e.message,true)}finally{btn.disabled=false}
};
void refreshTasks();void refreshAgents();
setInterval(()=>{if(!document.hidden){void refreshTasks();void refreshAgents()}},15000);


async function refreshHistory(){
 const list=$('agent-history');list.replaceChildren();
 try{
  const {messages=[]}=await window.mcpgo.serviceRead('messaging','/api/history');
  for(const m of messages.slice(-40).reverse())
   list.append(item(m.sender+' → '+m.recipient+' · '+(m.created_at||''),
     [String(m.body||'')]));
  if(!messages.length)list.append(item('Пока нет сообщений',[]));
 }catch(e){list.append(item('История недоступна',[e.message]))}
}
$('refresh-history').onclick=refreshHistory;
$('agent-message').onsubmit=async event=>{
 event.preventDefault();
 const button=event.submitter;button.disabled=true;
 try{
  await window.mcpgo.serviceAction('messaging','/api/messages',{
   sender:'hub',recipient:$('message-target').value.trim(),
   body:$('message-body').value,kind:'message'});
  $('message-body').value='';message('Сообщение сохранено в очереди агента');
  await refreshHistory();
 }catch(e){message(e.message,true)}finally{button.disabled=false}
};
void refreshHistory();
