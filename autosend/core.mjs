import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const root = path.join(os.homedir(), 'Library/Application Support/McpGo/AutoSend');
export const stateFile = process.env.MCPHUB_AUTOSEND_STATE || path.join(root,'tasks.json');
export const profileDir = path.join(root,'chrome-profile');
export const MIN_INTERVAL = 60;
export const MAX_INTERVAL = 604800;
export function normalizeTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 1000) throw Error('Укажи URL существующего разговора ChatGPT.');
  let u;
  try { u=new URL(raw.trim()); }
  catch { throw Error('Некорректная ссылка. Используй https://chatgpt.com/c/<ID>.'); }
  if (u.protocol!=='https:' || u.hostname!=='chatgpt.com' || u.port || u.username || u.password || u.hash)
    throw Error('Поддерживается только ссылка HTTPS на chatgpt.com.');
  if (u.pathname.startsWith('/share/'))
    throw Error('Ссылка /share/ — опубликованная копия. Нужна исходная ссылка /c/ на этот разговор.');
  // Both ordinary and project-scoped ChatGPT conversations are supported.
  // A project uses /g/g-p-<project-slug>/c/<conversation-uuid>.
  const chatPath=/^(?:\/g\/g-p-[a-zA-Z0-9][a-zA-Z0-9-]{2,160})?\/c\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/;
  if(!chatPath.test(u.pathname))
    throw Error('Нужен URL разговора ChatGPT: /c/UUID или /g/g-p-<проект>/c/UUID.');
  // no_universal_links, refresh_account, startup_account_refresh are client hints,
  // not part of the conversation identity. Drop ALL query parameters.
  return 'https://chatgpt.com'+u.pathname.replace(/\/$/,'').toLowerCase();
}
export const DIRECT_WEB_CHAT_DELIVERY_SUPPORTED=true;
export const DIRECT_WEB_CHAT_REASON='Отправка выполняется через Playwright CDP в личном Chrome после проверки точной ссылки и готовности агента; при занятости попытка откладывается.';

export function validateInput(body){
  if (!body || typeof body !== 'object') throw Error('Недопустимые параметры.');
  const url=normalizeTarget(body.url);
  if(typeof body.message!=='string' || body.message.trim().length<1 || body.message.length>8000)
    throw Error('Текст должен быть от 1 до 8000 символов.');
  const seconds=Number(body.interval_seconds);
  if(!Number.isInteger(seconds) || seconds<MIN_INTERVAL || seconds>MAX_INTERVAL) throw Error('Интервал должен быть от 1 минуты до 7 дней.');
  return {url,message:body.message,interval_seconds:seconds};
}
export function newTask(data, now=Date.now()) {
  const d=validateInput(data);
  return {id:crypto.randomUUID(),...d,enabled:false,next_at:null,status:'paused',last_error:'',
    last_attempt_at:null,last_success_at:null,delivery_count:0,created_at:new Date(now).toISOString()};
}
export function sanitize(t){
  return {...t,message:t.message}; // Owner-only native endpoint: text is needed for editing/review.
}
export function ensurePrivateDir(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.chmodSync(dir,0o700);
}
export function readState(file=stateFile){
  ensurePrivateDir(path.dirname(file));
  if(!fs.existsSync(file)) return {version:1,tasks:[],attempts:[]};
  if(fs.lstatSync(file).isSymbolicLink()) throw Error('Refusing symlink task store');
  const obj=JSON.parse(fs.readFileSync(file,'utf8'));
  if(obj.version!==1 || !Array.isArray(obj.tasks) || !Array.isArray(obj.attempts)) throw Error('Unexpected task store format');
  return obj;
}
export function writeState(state,file=stateFile){
  const dir=path.dirname(file);ensurePrivateDir(dir);
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink()) throw Error('Refusing symlink task store');
  const tmp=path.join(dir,'.tasks-'+crypto.randomUUID()+'.tmp');
  try {
    fs.writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});
    fs.chmodSync(tmp,0o600);
    fs.renameSync(tmp,file);
  } finally {try{fs.unlinkSync(tmp);}catch{}}
}
export function arm(task,now=Date.now()) {
  task.enabled=true;task.status='scheduled';task.last_error='';task.next_at=new Date(now+task.interval_seconds*1000).toISOString();
}
export function pause(task){task.enabled=false;task.next_at=null;task.status='paused'}
export function markUnknownOnBoot(state){
  for(const t of state.tasks){
    if(t.manual_once && !t.enabled && t.status==='scheduled'){
      pause(t);t.manual_once=false;
      t.last_error='Однократная отправка отменена при перезапуске. Она не будет запущена без нового подтверждения.';
    }
    if(t.status==='checking'){
      // No click was committed: re-arm safely after one full interval.
      t.status='scheduled';t.next_at=new Date(Date.now()+t.interval_seconds*1000).toISOString();
      t.last_error='Проверка прервана перезапуском. Сообщение не отправлялось; следующая попытка по расписанию.';
    }
    if(t.status==='sending' && Number.isInteger(t.verification?.baselineUserCount)){
      // A persisted click receipt survives process restart; reconciliation is
      // read-only and cannot dispatch the message a second time.
      t.status='verifying';t.next_at=null;t.delivery_stage='verifying';
      t.verification.nextCheckAt=new Date().toISOString();
      t.last_error='Восстанавливаем проверку ранее нажатой отправки без повторного Send.';
    } else if(t.status==='sending' || (t.status==='verifying' && !t.verification)){
      t.enabled=false;t.status='unknown';t.next_at=null;t.manual_once=false;
      t.last_error='Неизвестно, была ли отправка завершена до перезапуска. Проверь чат вручную; повтор запрещён.';
    }
    if(t.status==='verifying' && t.verification){
      t.next_at=null;
      t.verification.nextCheckAt=new Date().toISOString();
    }
    if(t.url?.startsWith('codex://') || (t.enabled && !t.url?.startsWith('https://chatgpt.com/c/') && !t.url?.startsWith('https://chatgpt.com/g/g-p-'))){
      t.enabled=false;t.status='blocked';t.next_at=null;t.manual_once=false;
      t.last_error='Устаревший адрес Codex. Для Playwright CDP необходим URL /c/.';
    }
  }
}

export function dueTasks(state,now=Date.now()) {
  return state.tasks.filter(t=>t.enabled && t.status==='scheduled' && t.next_at && Date.parse(t.next_at)<=now);
}
