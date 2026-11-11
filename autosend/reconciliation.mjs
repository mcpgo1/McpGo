import {createHash} from 'node:crypto';
import {safeEvidence,explainEvidence} from './chat-state.mjs';
/**
 * Crash-safe, read-only post-click verification.
 *
 * Verification is NOT a second delivery attempt. The original click is
 * committed durably before it can occur, and no reconciliation operation
 * has access to browser_type or browser_click.
 */
export const VERIFY_WINDOW_MS = 8*60_000;
export const VERIFY_INTERVAL_MS = 10_000;
export const MANUAL_VERIFY_WINDOW_MS = 120_000;
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
    baselineAssistantRevision: Number.isInteger(baseline.assistantRevision)
      ?baseline.assistantRevision:null,
    baselineUserInsertionRevision: Number.isInteger(baseline.userInsertionRevision)
      ?baseline.userInsertionRevision:null,
    baselineAssistantHash: typeof baseline.assistantText==='string'
      ? fingerprint(baseline.assistantText) : null,
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now+VERIFY_WINDOW_MS).toISOString(),
    nextCheckAt: new Date(now).toISOString(),
    checks: 0,
    lastObservation: '',
    lastEvidence:safeEvidence({code:'USER_BUBBLE_NOT_FOUND',clickCommitted:true,messageFound:false}),
    manualRechecks:0
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
/** Remember positive proof across React rerenders and repeated Playwright checks.
 * Counts and false booleans are NOT definitive on their own: the live,
 * exact-matching user bubble is still required at verification time.
 */
export function combinedEvidence(previous={},incoming={}) {
 const a=safeEvidence(previous),b=safeEvidence(incoming);
 const merged={...a,...b};
 merged.editorCleared=a.editorCleared===true||b.editorCleared===true;
 merged.assistantActivitySeen=a.assistantActivitySeen===true||b.assistantActivitySeen===true;
 merged.userInsertionDelta=Math.max(0,a.userInsertionDelta||0,b.userInsertionDelta||0);
 return safeEvidence(merged);
}
/** Recover positive observations from a prior in-flight attempt journal.
 * This repairs old 2.0.6 receipts where a later poll overwrote insertion=1
 * with insertion=0. Timestamps + task ID prevent cross-attempt reuse.
 * Restoring evidence alone NEVER changes status or invokes Send.
 */
export function restoreAttemptEvidence(task,attempts=[]) {
 const receipt=task?.verification;
 if(!receipt || !Number.isInteger(receipt.baselineUserCount))return false;
 const started=Date.parse(receipt.startedAt);
 if(!Number.isFinite(started))return false;
 const original=JSON.stringify(receipt.lastEvidence||{});
 let evidence=receipt.lastEvidence||{};
 for(const entry of attempts) {
  if(entry.task_id!==task.id||entry.result!=='verifying'||
     !entry.diagnostic?.clickCommitted)continue;
  const time=Date.parse(entry.time);
  if(!Number.isFinite(time)||time<started||
     time>started+VERIFY_WINDOW_MS+MANUAL_VERIFY_WINDOW_MS)continue;
  evidence=combinedEvidence(evidence,entry.diagnostic);
 }
 if(JSON.stringify(evidence)===original)return false;
 receipt.lastEvidence=evidence;
 return true;
}
export function scheduleNextCheck(t,reason='',now=Date.now(),evidence=null){
 if(!t.verification)throw Error('Missing verification receipt');
 t.status='verifying';
 t.delivery_stage='verifying';
 t.next_at=null;
 t.verification.checks++;
 const e=combinedEvidence(t.verification.lastEvidence,evidence||{});
 e.clickCommitted=true;
 e.checks=t.verification.checks;
 t.verification.lastEvidence=e;
 t.verification.lastObservation=e.code;
 const age=now-Date.parse(t.verification.startedAt);
 const delay=age>180000?30000:age>60000?18000:VERIFY_INTERVAL_MS;
 t.verification.nextCheckAt=new Date(now+delay).toISOString();
 t.last_error=explainEvidence(e);
}
export function finishUnknown(t,reason='',evidence=null,now=Date.now()){
 t.enabled=false;
 t.manual_once=false;
 t.status='unknown';
 t.next_at=null;
 t.delivery_stage='verification-expired';
 if(t.verification){
  t.verification.lastEvidence=combinedEvidence(t.verification.lastEvidence,evidence||{});
  t.verification.lastEvidence.clickCommitted=true;
  t.verification.lastEvidence.messageFound=false;
  t.verification.lastObservation=t.verification.lastEvidence.code;
  t.verification.unknownAt=new Date(now).toISOString();
 }
 t.last_error=t.verification?
  explainEvidence(t.verification.lastEvidence)+'. Проверь чат вручную; повтор Send запрещён.':
  'Не удалось восстановить подтверждение. Проверь чат вручную; повтор Send запрещён.';
 // Do NOT delete the hash/ID receipt: an explicit read-only manual recheck
 // must remain possible even after the automatic window has expired.
}
export function recheckUnknown(t,now=Date.now()){
 if(t.status!=='unknown'||!Number.isInteger(t.verification?.baselineUserCount))
  throw Error('Для этой попытки нет сохранённого подтверждения Send; доступна только ручная проверка чата.');
 const old=t.verification;
 t.enabled=false;t.manual_once=false;
 t.status='verifying';t.next_at=null;
 t.delivery_stage='manual-readonly-check';
 old.manualRechecks=(old.manualRechecks||0)+1;
 old.deadlineAt=new Date(now+MANUAL_VERIFY_WINDOW_MS).toISOString();
 old.nextCheckAt=new Date(now).toISOString();
 old.lastObservation='MANUAL_RECHECK_PENDING';
 t.last_error='Повторно проверяем уже нажатый Send. Новых сообщений McpGo НЕ отправляет.';
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
