/**
 * Watchdog for a *stalled ChatGPT frontend*, not a server-side model heartbeat.
 * No remote/private conversation content is persisted. A page reload is
 * permitted only for an explicit visible connection-interruption banner
 * that has remained unchanged through multiple observations.
 */
import {createHash} from 'node:crypto';
export const POLL_MS=15_000;
export const ERROR_STABLE_MS=15_000;
export const SUSPECT_STABLE_MS=12*60_000;
export const RELOAD_COOLDOWN_MS=30*60_000;
export const RECOVERY_STABLE_MS=1000;
const iso=n=>new Date(n).toISOString();
export function signature(observation) {
 const value=String(observation?.progressText||'').replace(/\s+/g,' ').trim();
 const revision=Number.isInteger(observation?.assistantRevision)?
   ':'+observation.assistantRevision:'';
 return createHash('sha256').update(value+revision).digest('hex');
}
export function updateWatchdog(previous,observation,now=Date.now()){
 if(!observation || observation.urlValid===false)return {next:null,action:'no-target'};
 const busy=Boolean(observation.stop||observation.busyText);
 const explicit=Boolean(observation.connectionInterrupted);
 if(!busy && !explicit)return {next:null,action:'ready'};
 const digest=signature(observation);
 const changed=!previous || previous.signature!==digest || previous.lastBusy!==busy;
 const lastProgressAt=changed?iso(now):previous.lastProgressAt;
 const faultSince=explicit
   ? (!previous?.connectionInterrupted||changed?iso(now):previous.faultSince)
   : null;
 const startedAt=previous?.startedAt||iso(now);
 const lastReloadAt=previous?.lastReloadAt||null;
 const reloadCount=previous?.reloadCount||0;
 const observations=(previous?.observations||0)+1;
 const stagnantFor=Math.max(0,now-Date.parse(lastProgressAt));
 const interruptedFor=faultSince?Math.max(0,now-Date.parse(faultSince)):0;
 const allowReload=explicit && !changed && observations>=2 &&
   interruptedFor>=ERROR_STABLE_MS && reloadCount===0;
 const mode=allowReload?'reloading':
   explicit?'interrupted':
   stagnantFor>=SUSPECT_STABLE_MS?'suspected-stall':'busy';
 return {action:allowReload?'reload':mode,next:{
   signature:digest,startedAt,lastProgressAt,faultSince,
   connectionInterrupted:explicit,lastBusy:busy,observations,
   lastReloadAt,reloadCount,mode,checkedAt:iso(now),
   // Don't persist DOM text, screenshots, message content or URLs.
 }};
}
export function noteReload(state,now=Date.now()){
 if(!state)throw Error('No watchdog state');
 return {...state,reloadCount:state.reloadCount+1,lastReloadAt:iso(now),
  mode:'recovering',checkedAt:iso(now)};
}
export function recoveryObservation(state,observation,now=Date.now()){
 if(state?.mode!=='recovering')return {ready:false,next:state};
 const clean=observation?.urlValid!==false&&
  !observation?.connectionInterrupted&&!observation?.stop&&!observation?.busyText &&
  observation?.pageReady==='complete'&&observation?.editorCount===1 &&
  !String(observation?.editorText||'').trim();
 if(!clean)return {ready:false,next:{...state,recoveryCleanSince:null,
  recoveryCleanCount:0,recoverySignature:null,mode:'recovering'}};
 // Count two snapshots as stable only if message anchor and assistant DOM
 // revision stay unchanged. Save a digest, not conversation text or IDs.
 const marker=JSON.stringify({
  userCount:observation.userCount??null,
  lastUserHash:observation.lastUserHash??null,
  assistantRevision:observation.assistantRevision??null
 });
 const digest=createHash('sha256').update(marker).digest('hex');
 const changed=state.recoverySignature!==digest;
 const since=!changed && Number.isFinite(Date.parse(state.recoveryCleanSince))?
  Date.parse(state.recoveryCleanSince):now;
 const checks=changed?1:(state.recoveryCleanCount||0)+1;
 return {ready:checks>=2&&now-since>=RECOVERY_STABLE_MS,
  next:{...state,recoveryCleanSince:new Date(since).toISOString(),
   recoveryCleanCount:checks,recoverySignature:digest}};
}
// Kept for clients that only need an inexpensive boolean, but a single clean
// DOM snapshot MUST NOT trigger a scheduled Send after navigation.
export function canRetryAfterReload(state,observation,now=Date.now()){
 return recoveryObservation(state,observation,now).ready;
}


/** Explicit 'Continue generating' state: stopped + writable, not a transport
 * failure. Return one stable marker per observed last user message. This lets
 * the scheduler send its already-configured continuation prompt immediately,
 * while never triggering repeatedly from an unchanged CTA.
 */
export function continuationOpportunity(task,observation,now=Date.now()){
 if(!task?.enabled || task.status!=='scheduled')return null;
 if(!observation?.continuationAvailable || observation.connectionInterrupted ||
    observation.stop || observation.busyText || observation.urlValid===false ||
    observation.editorCount!==1 || String(observation.editorText||'').trim())return null;
 const id=String(observation.lastUserId||'').slice(0,160);
 const count=Number.isInteger(observation.userCount)?observation.userCount:-1;
 const hash=String(observation.lastUserHash||'').slice(0,64);
 const marker=[id,count,hash].join(':');
 if(task.continuationMarker===marker)return null;
 // A recent actual Send may not yet have updated the DOM. Never infer a
 // second action from the same lingering interface state.
 const last=Date.parse(task.last_success_at||task.last_attempt_at||'');
 if(Number.isFinite(last) && now-last<60_000)return null;
 return marker;
}
