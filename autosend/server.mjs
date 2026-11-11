import http from 'node:http';
import crypto from 'node:crypto';
import {deliverViaPlaywright,reconcileViaPlaywright,observeExistingChat,reloadStalledChat,LocalMcp} from './cdp-delivery.mjs';
import {POLL_MS,updateWatchdog,noteReload,recoveryObservation,continuationOpportunity} from './stall-watchdog.mjs';
import {safeEvidence,explainEvidence} from './chat-state.mjs';
import {verificationReceipt,canReconcile,expired,scheduleNextCheck,finishUnknown,finishVerified,recheckUnknown,restoreAttemptEvidence} from './reconciliation.mjs';
import {readState,writeState,newTask,arm,pause,dueTasks,markUnknownOnBoot,validateInput} from './core.mjs';
import {conversationState,conversationStates,eligibleToSend,nextDue,canObserveTask} from './conversation-fsm.mjs';

const PORT=Number(process.env.MCPHUB_AUTOSEND_PORT || 8972);
let cdpOnline=false;let cdpLastError='';let workerBusy=false;
const CHECK_MS=Number(process.env.MCPHUB_AUTOSEND_CHECK_MS||10000);
const db=readState();
markUnknownOnBoot(db);
writeState(db);
const MAX_IN_FLIGHT=240000;
function persist(){writeState(db)}
function now(){return new Date().toISOString()}
function find(id){const t=db.tasks.find(t=>t.id===id);if(!t)throw Error('Расписание не найдено.');return t}
function reply(res,code,obj,origin=null){
 const out=Buffer.from(JSON.stringify(obj));
 const headers={'Content-Type':'application/json; charset=utf-8','Content-Length':out.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'};
 if(origin){headers['Access-Control-Allow-Origin']=origin;headers.Vary='Origin';}
 res.writeHead(code,headers);res.end(out);
}
function view(){return {ok:true,tasks:db.tasks,attempts:db.attempts.slice(-30).reverse(),
 conversations:conversationStates(db.tasks),
 deliverySupported:true,deliveryReason:cdpOnline?'Playwright CDP подключён к личному Chrome.':'Ожидание Playwright CDP: '+(cdpLastError||'проверяем подключение'),
 extensionConnected:cdpOnline,extensionTransport:'Playwright CDP',extensionDiagnostic:null,extensionLastSeen:null,
 extensionVersion:'CDP',requiredExtensionVersion:'CDP',busyTask:db.tasks.find(t=>['checking','sending','verifying'].includes(t.status))?.id||'',serverTime:now()};}
function operation(action,body){
 switch(action){
  case 'create':{
   const t=newTask(body);db.tasks.push(t);persist();return {task:t};
  }
  case 'update':{
   const t=find(body.id);if(['checking','sending','verifying'].includes(t.status))throw Error('Идёт отправка: сначала дождись результата.');
   Object.assign(t,validateInput(body));delete t.watchdog;delete t.verification;pause(t);t.manual_once=false;t.safe_retry_count=0;t.last_error='';persist();return {task:t};
  }
  case 'start':{
   const t=find(body.id);if(['checking','sending','verifying'].includes(t.status))throw Error('Идёт отправка.');
   if(t.status==='unknown')throw Error('Неизвестная отправка: проверь чат вручную и измени расписание для сброса статуса.');
   const other=conversationState(db.tasks.filter(x=>x.id!==t.id),t.url);
   if(other.blocked)throw Error('В этом чате уже есть незавершённая или неизвестная отправка. Проверь её прежде, чем включать новую.');
   delete t.watchdog;arm(t);t.manual_once=false;t.safe_retry_count=0;persist();return {task:t};
  }
  case 'pause':{
   const t=find(body.id);if(['checking','sending','verifying'].includes(t.status))throw Error('Идёт отправка: безопасная отмена в этот момент недоступна.');
   delete t.watchdog;pause(t);t.manual_once=false;persist();return {task:t};
  }
  case 'remove':{
   const t=find(body.id);if(['checking','sending','verifying'].includes(t.status))throw Error('Идёт отправка.');
   db.tasks=db.tasks.filter(x=>x.id!==body.id);persist();return {removed:body.id};
  }
  case 'recheck_unknown':{
   const t=find(body.id);
   if(workerBusy || db.tasks.some(x=>x.url===t.url && x.id!==t.id &&
      ['checking','sending','verifying'].includes(x.status)))
    throw Error('Дождись окончания проверки в этом разговоре.');
   recheckUnknown(t);persist();
   return {checking:true,sendBlocked:true};
  }
  case 'confirm_received':{
   // Explicit user attestation ONLY after checking ChatGPT personally.
   // This operation NEVER types/clicks/navigates and NEVER rearms a schedule.
   const t=find(body.id);
   if(t.status!=='unknown')throw Error('Подтвердить вручную можно только неизвестную попытку.');
   if(db.tasks.some(x=>x.id!==t.id && x.url===t.url &&
      ['checking','sending','verifying'].includes(x.status)))
    throw Error('В этом разговоре сейчас проверяется другая отправка.');
   const evidence=t.verification?.lastEvidence||null;
   t.enabled=false;t.manual_once=false;
   finishVerified(t);
   t.status='paused';t.next_at=null;t.delivery_stage='manual-confirmed';
   t.last_error='Подтверждено пользователем вручную. Расписание осталось на паузе.';
   recordAttempt(t,'verified_manual',
     'Пользователь подтвердил, что сообщение присутствует в чате; автоматического доказательства не было.',
     evidence);
   persist();
   return {confirmed:true,sendBlocked:true,paused:true};
  }
  case 'clear_history':{
   const cleared=db.attempts.length;
   db.attempts=[];
   persist();
   return {cleared};
  }
  case 'send_once':{
   const t=find(body.id);if(['checking','sending','verifying'].includes(t.status))throw Error('Идёт отправка.');
   if(t.status==='unknown')throw Error('Неизвестная доставка. Проверь чат и измени задание перед новой попыткой.');
   if(t.manual_once && t.status==='scheduled')throw Error('Однократная отправка уже ожидает выполнения.');
   const other=conversationState(db.tasks.filter(x=>x.id!==t.id),t.url);
   if(other.blocked)throw Error('В этом разговоре уже есть неподтверждённое действие; отправка другого задания блокирована.');
   t.manual_once=!t.enabled;t.status='scheduled';t.next_at=now();t.last_error='';persist();return {queued:true};
  }
  default:throw Error('Неизвестное действие.');
 }
}
function expireAmbiguous(){
 let changed=false;
 for(const t of db.tasks){
  // A prior non-proof sending record cannot be replayed. Fresh click receipts
  // are always reconciled read-only; none may trigger another Send.
  if(t.status==='sending' && Date.now()-Date.parse(t.last_attempt_at||0)>240000){
   if(t.verification){
    t.status='verifying';t.next_at=null;changed=true;
   }else{
    finishUnknown(t,'Сохранённая попытка не содержит baseline.');
    changed=true;
   }
  }
 }
 if(changed)persist();
}
// Watchdog observes only already-open ChatGPT conversations with scheduled tasks.
// An explicit, stable connection-error banner is required for automatic reload.
// Busy without such a banner is reported, but never interrupted automatically.
let lastWatchdogCheck=0;
let watchdogCursor=0;
async function monitorStalledChats(){
 if(workerBusy)return false;
 const candidates=db.tasks.filter(t=>canObserveTask(t,db.tasks));
 if(!candidates.length)return false;
 const t=candidates[watchdogCursor++%candidates.length];
 workerBusy=true;
 try{
  // Wait for a real MutationObserver event briefly before falling back to
  // the regular health probe. Holding the shared Chrome lock is capped at
  // 1000 ms, even while another agent is performing long-running work.
  const probe=await observeExistingChat(t,{eventWaitMs:1000});
  if(probe.status!=='ok'){
   // Do not reset existing evidence or perform any navigation if we cannot
   // observe the exact destination conversation.
   return false;
  }
  const observed=probe.observation;
  const continuationMarker=continuationOpportunity(t,observed);
  if(continuationMarker){
   t.continuationMarker=continuationMarker;
   delete t.watchdog;
   t.next_at=now();
   t.last_error='Ответ остановлен: ChatGPT предлагает продолжение. Отправим заданное сообщение после проверки готовности.';
   persist();
   return true;
  }
  // A previously handled CTA must not be triggered again while the same
  // user message remains visible. A new last user ID/receipt is a new event.
  if(t.watchdog?.mode==='recovering'){
   const check=recoveryObservation(t.watchdog,observed);
   t.watchdog=check.next;
   if(check.ready){
    delete t.watchdog;
    t.last_error='Соединение восстановлено; чат дважды подтвердил готовность.';
    // A deferred busy slot has never clicked Send. The separate delivery
    // preflight will require two fresh stable observations as well.
    t.next_at=now();
   }else{
    t.last_error='Проверяем восстановление после обрыва; новые сообщения пока не отправляем.';
   }
   persist();
   return true;
  }
  const decision=updateWatchdog(t.watchdog,observed);
  if(decision.action==='ready'){
   if(t.watchdog){
    delete t.watchdog;
    // If the chat became ready naturally, do not wait another full interval.
    t.next_at=now();
    t.last_error='';
    persist();
   }
   return true;
  }
  if(decision.next)t.watchdog=decision.next;
  if(decision.action==='reload'){
   // Persist an attempt BEFORE navigation; crash must not cause an
   // unbounded refresh loop. Navigation never types or sends messages.
   t.watchdog=noteReload(t.watchdog);
   persist();
   const result=await reloadStalledChat(t);
   t.watchdog.mode=result.status==='reloaded'?'recovering':'refresh-deferred';
   t.last_error=result.status==='reloaded'
     ?'Обнаружен устойчивый обрыв ChatGPT: обновили вкладку один раз, проверяем состояние.'
     :'Перезагрузка отложена: '+(result.reason||'неподтверждённая ошибка');
   persist();
   return true;
  }
  const age=Math.floor((Date.now()-Date.parse(t.watchdog.lastProgressAt))/60000);
  if(decision.action==='interrupted')
   t.last_error='ChatGPT явно прервал ответ. Перепроверяем состояние и затем восстановим разговор, не нажимая Send до готовности.';
  else if(decision.action==='suspected-stall')
   t.last_error='Возможное зависание: '+age+' мин без видимого прогресса. Действующий ответ не прерываем без явной ошибки.';
  // Rate-limit disk writes to meaningful state changes; hashes only, not DOM.
  persist();
 }catch(e){
  t.last_error='Наблюдение ChatGPT недоступно: '+String(e.message||e).slice(0,120);
  persist();
 }finally{workerBusy=false;}
 return true;
}
function recordAttempt(t,result,error='',evidence=null){
 const proof=evidence||t.verification?.lastEvidence||null;
 db.attempts.push({id:crypto.randomUUID(),task_id:t.id,time:now(),
   result,error,stage:t.delivery_stage||null,
   diagnostic:proof?safeEvidence(proof):null});
 db.attempts=db.attempts.slice(-120);
}
async function reconcilePending(){
 const t=db.tasks.find(x=>canReconcile(x));
 if(!t)return false;
 if(workerBusy)return true;
 workerBusy=true;
 try{
  // Older builds overwrote positive DOM insertion evidence on the next
  // unsuccessful poll. Recover it from THIS click's timestamped journal;
  // still require a fresh exact user bubble and assistant activity.
  if(restoreAttemptEvidence(t,db.attempts))persist();
  const result=await reconcileViaPlaywright(t,t.verification);
  if(result.status==='verified'){
   const proof=result.evidence;
   finishVerified(t);
   recordAttempt(t,'verified','',proof);
  }else if(expired(t)){
   finishUnknown(t,'Интерфейс чата не показал однозначное подтверждение.',result.evidence);
   recordAttempt(t,'unknown',t.last_error);
  }else{
   scheduleNextCheck(t,result.reason,Date.now(),result.evidence);
  }
  persist();
 }catch(e){
  if(expired(t)){
   finishUnknown(t,'Нет достоверной информации после браузерной ошибки',
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
   recordAttempt(t,'unknown',t.last_error);
  }else{
   scheduleNextCheck(t,'Ошибка чтения состояния страницы',Date.now(),
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
  }
  persist();
 }finally{workerBusy=false;}
 return true;
}
async function checkCdp(){
 try {const client=new LocalMcp();await client.connect();await client.tool('browser_tabs',{action:'list'});cdpOnline=true;cdpLastError='';}
 catch(e){cdpOnline=false;cdpLastError=String(e.message||e).slice(0,140);}
}
let lastScheduledTaskId=null;
async function runScheduled(){
 if(workerBusy)return false;
 // A pending proof in chat A never blocks independent chat B. Browser tool
 // calls themselves remain serialized by the shared Chrome MCP proxy.
 const t=nextDue(db.tasks,Date.now(),lastScheduledTaskId);
 if(!t)return false;
 lastScheduledTaskId=t.id;
 workerBusy=true;
 t.status='checking';t.last_attempt_at=now();t.next_at=null;t.delivery_stage='preflight';persist();
 try {
  const result=await deliverViaPlaywright(t,async baseline=>{
   t.verification=verificationReceipt(baseline);
   // ID is durable BEFORE click, and the proxy records the same operation
   // before forwarding it to Playwright. Lost HTTP responses cannot replay it.
   const actionId='autosend:'+crypto.randomUUID();
   t.verification.actionId=actionId;
   t.status='sending';t.delivery_stage='click-committed';t.last_stage_at=now();persist();
   return actionId;
  });
  if(result.status==='verified'){
   finishVerified(t);
  } else if(result.status==='refused'&&result.reason==='guard-refused'&&t.verification){
   // The page-side guard positively confirmed that no click happened. Only
   // this definitive response allows us to retire a reserved operation ID;
   // network errors and ambiguous responses ALWAYS remain in verification.
   const oldActionId=t.verification.actionId;
   t.verification=null;
   t.status='scheduled';
   t.delivery_stage='guard-refused';
   t.next_at=new Date(Date.now()+t.interval_seconds*1000).toISOString();
   t.last_error=result.error||'Send отклонён проверкой; безопасно отложен.';
   t.last_action_id=oldActionId;
  } else if(t.verification || t.status==='sending' || result.status==='pending'){
   // The click may have happened. Never retry it: schedule read-only DOM
   // reconciliation, even if an MCP error interrupted the first observation.
   if(t.verification){
    scheduleNextCheck(t,result.error,Date.now(),result.evidence);
   }else{
    finishUnknown(t,'Невозможно восстановить baseline исходной попытки.');
   }
  } else {
   // Busy or uncertain page: no click occurred. Skip this slot, check next interval.
   t.status='scheduled';t.next_at=new Date(Date.now()+t.interval_seconds*1000).toISOString();
   t.last_error=(
    result.reason==='busy'?'Агент занят · ':
    result.reason==='interrupted'?'Соединение прервано · ':
    result.reason==='stalled'?'Возможное зависание · ':'Проверка отложена · '
   )+(result.error||'следующая проверка по расписанию');
  }
  recordAttempt(t,t.status==='verifying'?'verifying':
    result.status==='deferred'?(result.reason==='busy'?'busy':'deferred'):result.status,
    t.last_error,result.evidence);
  persist();
 }catch(e){
  if(t.verification){
   scheduleNextCheck(t,'Проверка прервана',Date.now(),
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
  }else if(t.status==='checking'){
   t.status='scheduled';t.next_at=new Date(Date.now()+t.interval_seconds*1000).toISOString();
   t.last_error='Сбой до нажатия Send; новая попытка при следующем интервале.';
  }else{
   finishUnknown(t,'Нельзя безопасно определить исход попытки',
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
  }
  persist();
 }finally{workerBusy=false;}
}

const server=http.createServer(async(req,res)=>{
 const host=req.headers.host;
 if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(host))
  return reply(res,403,{error:'Only local host'});
 if(req.headers['x-mcphub-client']!=='native' || req.headers.origin)
  return reply(res,403,{error:'Only native client permitted'});
 if(req.method==='GET' && req.url==='/api/status') return reply(res,200,view());
 if(req.method!=='POST' || req.url!=='/api/tasks')
  return reply(res,404,{error:'Not found'});
 if(!String(req.headers['content-type']||'').startsWith('application/json'))
  return reply(res,415,{error:'JSON only'});
 try {
  let bytes=0;const chunks=[];
  for await(const chunk of req){
   bytes+=chunk.length;
   if(bytes>30000)throw Error('Слишком большой запрос.');
   chunks.push(chunk);
  }
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return reply(res,200,{ok:true,...operation(body.action,body)});
 } catch(e) {
  return reply(res,400,{error:String(e.message||e).slice(0,500)});
 }
});
server.listen(PORT,'127.0.0.1',()=>console.log('McpGo AutoSend Playwright CDP API on 127.0.0.1:'+PORT));
let schedulerTickRunning=false;
async function schedulerTick(){
 if(schedulerTickRunning)return;
 schedulerTickRunning=true;
 try{
  expireAmbiguous();
  // One read-only confirmation and one independent scheduled task may run
  // during the same tick. Verifying chat A does NOT starve ready chat B.
  await reconcilePending();
  await runScheduled();
  if(Date.now()-lastWatchdogCheck>=POLL_MS){
   lastWatchdogCheck=Date.now();
   await monitorStalledChats();
  }
 } finally{schedulerTickRunning=false}
}
const timer=setInterval(()=>{
 void schedulerTick().catch(()=>{
   // Do not force an operation retry after an unhandled scheduler error.
   // Durable task/verification receipts are recovered by markUnknownOnBoot.
 });
},CHECK_MS);timer.unref();
const healthTimer=setInterval(()=>{void checkCdp();},30000);healthTimer.unref();void checkCdp();
process.on('SIGTERM',()=>{clearInterval(timer);clearInterval(healthTimer);server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref()});
