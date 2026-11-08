import {createHash} from 'node:crypto';
/**
 * Crash-safe, read-only post-click verification.
 *
 * Verification is NOT a second delivery attempt. The original click is
 * committed durably before it can occur, and no reconciliation operation
 * has access to browser_type or browser_click.
 */
export const VERIFY_WINDOW_MS = 180_000;
export const VERIFY_INTERVAL_MS = 12_000;
// Never persist the content of the previous unrelated user message.
// A hash is sufficient to check whether the previous last bubble is now
// the penultimate one, without recording its private text in tasks.json.
export function fingerprint(value){
 const normalized=String(value||'').replace(/[\u200b-\u200d\ufeff]/g,'')
   .replace(/\s+/g,' ').trim();
 return createHash('sha256').update(normalized,'utf8').digest('hex');
}

export function verificationReceipt(baseline, now=Date.now()) {
  if (!baseline || !Number.isSafeInteger(baseline.userCount) || baseline.userCount<0) {
    throw Error('Невозможно сохранить исходное состояние сообщений перед нажатием Send');
  }
  return {
    baselineUserCount: baseline.userCount,
    baselineLastUserHash: baseline.lastUserHash||fingerprint(baseline.lastUserText),
    baselineLastUserId: String(baseline.lastUserId||'').slice(0,160),
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now+VERIFY_WINDOW_MS).toISOString(),
    nextCheckAt: new Date(now).toISOString(),
    checks: 0,
    lastObservation: ''
  };
}
export function canReconcile(t, now=Date.now()) {
  return t.status==='verifying' && !!t.verification &&
    (!Number.isFinite(Date.parse(t.verification.nextCheckAt)) ||
     Date.parse(t.verification.nextCheckAt)<=now);
}
export function expired(t,now=Date.now()){
  return !!t.verification &&
    (!Number.isFinite(Date.parse(t.verification.deadlineAt)) ||
     now>=Date.parse(t.verification.deadlineAt));
}
export function scheduleNextCheck(t,reason='',now=Date.now()){
  if(!t.verification)throw Error('Missing verification receipt');
  t.status='verifying';
  t.delivery_stage='verifying';
  t.next_at=null;
  t.verification.checks++;
  t.verification.lastObservation=String(reason||'').slice(0,180);
  t.verification.nextCheckAt=new Date(now+VERIFY_INTERVAL_MS).toISOString();
  t.last_error='Проверяем отправку в чате без повторного нажатия Send'+
    (reason?': '+String(reason).slice(0,120):'');
}
export function finishUnknown(t,reason=''){
  t.enabled=false;
  t.manual_once=false;
  t.status='unknown';
  t.next_at=null;
  t.delivery_stage='verification-expired';
  t.last_error='Отправка не подтверждена после повторных проверок. '+String(reason).slice(0,170)+
    ' Проверь чат вручную; повторного нажатия не было.';
  delete t.verification;
}
export function finishVerified(t,now=Date.now()){
  t.delivery_count=(t.delivery_count||0)+1;
  t.last_success_at=new Date(now).toISOString();
  t.last_error='';
  t.safe_retry_count=0;
  t.delivery_stage='verified';
  const once=!t.enabled;
  delete t.verification;
  if(once){
    t.manual_once=false;
    t.enabled=false;
    t.next_at=null;
    t.status='paused';
  }else{
    t.manual_once=false;
    t.status='scheduled';
    t.next_at=new Date(now+t.interval_seconds*1000).toISOString();
  }
}
