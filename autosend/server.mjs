import http from 'node:http';
import crypto from 'node:crypto';
import {deliverViaPlaywright,LocalMcp} from './cdp-delivery.mjs';
import {readState,writeState,newTask,arm,pause,dueTasks,markUnknownOnBoot,validateInput} from './core.mjs';

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
 deliverySupported:true,deliveryReason:cdpOnline?'Playwright CDP подключён к личному Chrome.':'Ожидание Playwright CDP: '+(cdpLastError||'проверяем подключение'),
 extensionConnected:cdpOnline,extensionTransport:'Playwright CDP',extensionDiagnostic:null,extensionLastSeen:null,
 extensionVersion:'CDP',requiredExtensionVersion:'CDP',busyTask:db.tasks.find(t=>['checking','sending'].includes(t.status))?.id||'',serverTime:now()};}
function operation(action,body){
 switch(action){
  case 'create':{
   const t=newTask(body);db.tasks.push(t);persist();return {task:t};
  }
  case 'update':{
   const t=find(body.id);if(['checking','sending'].includes(t.status))throw Error('Идёт отправка: сначала дождись результата.');
   Object.assign(t,validateInput(body));pause(t);t.manual_once=false;t.safe_retry_count=0;t.last_error='';persist();return {task:t};
  }
  case 'start':{
   const t=find(body.id);if(['checking','sending'].includes(t.status))throw Error('Идёт отправка.');
   if(t.status==='unknown')throw Error('Неизвестная отправка: проверь чат вручную и измени расписание для сброса статуса.');
   arm(t);t.manual_once=false;t.safe_retry_count=0;persist();return {task:t};
  }
  case 'pause':{
   const t=find(body.id);if(['checking','sending'].includes(t.status))throw Error('Идёт отправка: безопасная отмена в этот момент недоступна.');
   pause(t);t.manual_once=false;persist();return {task:t};
  }
  case 'remove':{
   const t=find(body.id);if(['checking','sending'].includes(t.status))throw Error('Идёт отправка.');
   db.tasks=db.tasks.filter(x=>x.id!==body.id);persist();return {removed:body.id};
  }
  case 'clear_history':{
   const cleared=db.attempts.length;
   db.attempts=[];
   persist();
   return {cleared};
  }
  case 'send_once':{
   const t=find(body.id);if(['checking','sending'].includes(t.status))throw Error('Идёт отправка.');
   if(t.status==='unknown')throw Error('Неизвестная доставка. Проверь чат и измени задание перед новой попыткой.');
   if(t.manual_once && t.status==='scheduled')throw Error('Однократная отправка уже ожидает выполнения.');
   t.manual_once=!t.enabled;t.status='scheduled';t.next_at=now();t.last_error='';persist();return {queued:true};
  }
  default:throw Error('Неизвестное действие.');
 }
}
function expireAmbiguous(){
 let changed=false;
 for(const t of db.tasks){
  if(t.status==='sending'&&Date.now()-Date.parse(t.claimed_at||t.last_attempt_at||0)>MAX_IN_FLIGHT){
   t.enabled=false;t.manual_once=false;t.status='unknown';t.next_at=null;
   t.last_error='Срок ожидания подтверждения истёк. Проверь чат вручную, повтор запрещён.';
   db.attempts.push({id:crypto.randomUUID(),task_id:t.id,time:now(),result:'unknown',error:t.last_error});
   delete t.claim_id;delete t.claimed_at;changed=true;
  }
 }
 if(changed){db.attempts=db.attempts.slice(-120);persist()}
}
async function checkCdp(){
 try {const client=new LocalMcp();await client.connect();await client.tool('browser_tabs',{action:'list'});cdpOnline=true;cdpLastError='';}
 catch(e){cdpOnline=false;cdpLastError=String(e.message||e).slice(0,140);}
}
async function runScheduled(){
 if(workerBusy)return;
 const t=db.tasks.find(x=>(x.enabled||x.manual_once)&&x.status==='scheduled'&&x.next_at&&Date.parse(x.next_at)<=Date.now()&&!db.tasks.some(y=>['checking','sending'].includes(y.status)));
 if(!t)return;
 workerBusy=true;
 t.status='checking';t.last_attempt_at=now();t.next_at=null;t.delivery_stage='preflight';persist();
 try {
  const result=await deliverViaPlaywright(t,async()=>{
   t.status='sending';t.delivery_stage='click-committed';t.last_stage_at=now();persist();
  });
  const stamp=now();
  if(result.status==='verified'){
   t.delivery_count++;t.last_success_at=stamp;t.last_error='';t.safe_retry_count=0;
   if(t.enabled)arm(t,Date.now());else pause(t);t.manual_once=false;
  } else if(result.status==='unknown'||t.status==='sending'){
   t.enabled=false;t.status='unknown';t.next_at=null;t.manual_once=false;
   t.last_error=result.error||'Возможно, сообщение было отправлено. Автоматические повторы запрещены.';
  } else {
   // Busy or uncertain page: no click occurred. Skip this slot, check next interval.
   t.status='scheduled';t.next_at=new Date(Date.now()+t.interval_seconds*1000).toISOString();
   t.last_error=(result.reason==='busy'?'Агент занят · ':'Проверка отложена · ')+(result.error||'повтор при следующем интервале');
  }
  db.attempts.push({id:crypto.randomUUID(),task_id:t.id,time:stamp,
   result:result.status==='deferred'?(result.reason==='busy'?'busy':'deferred'):result.status,
   error:t.last_error,stage:t.delivery_stage});
  db.attempts=db.attempts.slice(-120);persist();
 }catch(e){
  t.enabled=false;t.status='unknown';t.next_at=null;
  t.last_error='Ошибка планировщика во время выполнения: '+String(e.message||e).slice(0,300);persist();
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
const timer=setInterval(()=>{expireAmbiguous();void runScheduled();},CHECK_MS);timer.unref();
const healthTimer=setInterval(()=>{void checkCdp();},30000);healthTimer.unref();void checkCdp();
process.on('SIGTERM',()=>{clearInterval(timer);clearInterval(healthTimer);server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref()});
