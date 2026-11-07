'use strict';
const el=id=>document.getElementById(id);
let adminKey=sessionStorage.getItem('chatHubKey')||'';
let active=null;
let cache=new Map();
let list=[];
let busy=false;
function auth(){el('auth').hidden=false;el('connection').textContent='Требуется ключ';el('dot').className='dot';}
async function api(url,method='GET',data){
  const options={method,headers:{'X-Hub-Key':adminKey}};
  if(data!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(data);}
  const response=await fetch(url,options);
  const text=await response.text();
  let result;try{result=JSON.parse(text);}catch(_){throw Error('Invalid API response');}
  if(!response.ok)throw Error(result.error||'HTTP '+response.status);
  return result;
}
function friendly(s){
  return s.status==='running'?'●':s.status==='starting'?'◌':'○';
}
async function refreshList(){
  if(busy||!adminKey)return;
  busy=true;
  try{
    const data=await api('/api/sessions');
    list=data.sessions;
    el('auth').hidden=true;el('connection').textContent='Локальный сервис работает';el('dot').className='dot online';
    if(!list.find(s=>s.id===active))active=list[0]?.id||null;
    paintTabs();paintHeader();
  }catch(err){
    if(err.message==='UNAUTHORIZED'){adminKey='';sessionStorage.removeItem('chatHubKey');auth();}
    else{el('connection').textContent='Нет соединения: '+err.message;el('dot').className='dot';}
  }finally{busy=false;}
}
function paintTabs(){
  const tabs=el('tabs');tabs.replaceChildren();
  for(const s of list){
    const b=document.createElement('button');
    b.textContent=friendly(s)+'  '+s.name;
    if(s.id===active)b.className='selected';
    b.onclick=()=>{active=s.id;paintTabs();paintHeader();paintOutput();};
    tabs.appendChild(b);
  }
}
function paintHeader(){
  const s=list.find(v=>v.id===active);
  el('title').textContent=s?s.name:'Нет активного терминала';
  el('subtitle').textContent=s?'PID '+(s.pid||'—')+' · '+s.status+' · '+s.id.slice(0,8):'Создайте терминал кнопкой справа';
  for(const x of ['command','run','interrupt','close','copy'])el(x).disabled=!s;
}
function pretty(raw){
  // A compact plain-text console preview; the running shell itself is a real PTY.
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b[()][0-9A-Za-z]/g,'').replace(/\r(?!\n)/g,'').replace(/\x07/g,'');
}
function paintOutput(){
  const s=active&&cache.get(active);
  const screen=el('screen');
  if(!active){screen.textContent='Создайте новый терминал для начала работы.';return;}
  screen.textContent=pretty(s?.text||'Запускаем оболочку zsh…');
  screen.scrollTop=screen.scrollHeight;
}
async function poll(){
  if(!active||!adminKey)return;
  const id=active;
  const state=cache.get(id)||{next:0,text:''};
  try{
    const v=await api('/api/sessions/'+encodeURIComponent(id)+'/output?since='+state.next);
    if(v.truncated){state.text='[Предыдущая часть вывода удалена из памяти]\n';}
    if(v.text){state.text+=v.text;if(state.text.length>262144)state.text=state.text.slice(-262144);}
    state.next=v.next;cache.set(id,state);
    if(id===active&&v.text)paintOutput();
  }catch(_){}
}
async function create(){
  const name=prompt('Название терминала','Чат '+(list.length+1));
  if(name===null)return;
  try{
    const v=await api('/api/sessions','POST',{name});
    active=v.session_id;
    cache.set(active,{text:'',next:0});
    await refreshList();paintOutput();el('command').focus();
  }catch(err){alert(err.message);}
}
async function write(text,enter=true){
  if(!active||!text&&enter)return;
  await api('/api/sessions/'+encodeURIComponent(active)+'/input','POST',{text,enter});
}
el('add').onclick=create;
el('commandForm').onsubmit=async ev=>{
  ev.preventDefault();
  const input=el('command');const command=input.value;
  if(!command.trim())return;
  try{await write(command);input.value='';await poll();}catch(err){alert(err.message);}
};
el('command').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();el('commandForm').requestSubmit();}
  if(e.key==='c'&&e.ctrlKey){e.preventDefault();el('interrupt').click();}
});
el('interrupt').onclick=async()=>{try{await api('/api/sessions/'+active+'/interrupt','POST',{});await poll();}catch(err){alert(err.message);}};
el('close').onclick=async()=>{
  if(!active||!confirm('Закрыть терминал и его процессы?'))return;
  try{await api('/api/sessions/'+active,'DELETE');cache.delete(active);active=null;await refreshList();paintOutput();}catch(err){alert(err.message);}
};
el('copy').onclick=async()=>{if(active)await navigator.clipboard.writeText(pretty(cache.get(active)?.text||''));};
el('authForm').onsubmit=ev=>{
  ev.preventDefault();adminKey=el('key').value.trim();sessionStorage.setItem('chatHubKey',adminKey);
  refreshList().then(()=>{if(!adminKey)el('authError').textContent='Неверный ключ';else el('authError').textContent='';});
};
if(!adminKey)auth();
setInterval(async()=>{await refreshList();await poll();},800);
refreshList().then(()=>{paintOutput();});
