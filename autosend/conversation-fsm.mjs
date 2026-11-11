/**
 * Persistent per-conversation finite-state model derived from tasks.json.
 * Individual task records remain the authoritative durable source across
 * restarts; there is no second database to drift out of sync.
 *
 * One conversation may be UNKNOWN while 3 other conversations remain free.
 * The personal Chrome MCP proxy still serializes access to its active tab.
 */
export const STATES=Object.freeze({
 READY:'READY',WORKING:'WORKING',RECOVERING:'RECOVERING',
 VERIFYING_SEND:'VERIFYING_SEND',UNKNOWN:'UNKNOWN',
 PAUSED:'PAUSED'
});
const UNCERTAIN=new Set(['unknown']);
const IN_FLIGHT=new Set(['checking','sending','verifying']);

export function conversationState(tasks,url,now=Date.now()) {
 const group=tasks.filter(t=>t.url===url);
 if(!group.length)return {state:STATES.PAUSED,blocked:false,task_ids:[],reason:'NO_TASKS'};
 const ids=group.map(t=>t.id);
 const uncertain=group.find(t=>UNCERTAIN.has(t.status));
 if(uncertain)return {state:STATES.UNKNOWN,blocked:true,
   task_ids:ids,owner_task_id:uncertain.id,reason:'UNRESOLVED_SEND'};
 const ongoing=group.find(t=>IN_FLIGHT.has(t.status));
 if(ongoing)return {state:STATES.VERIFYING_SEND,blocked:true,
   task_ids:ids,owner_task_id:ongoing.id,reason:'SEND_OR_VERIFY_IN_PROGRESS'};
 if(group.some(t=>t.watchdog?.mode==='recovering'||t.watchdog?.mode==='refresh-deferred'))
  return {state:STATES.RECOVERING,blocked:true,task_ids:ids,reason:'BROWSER_RECOVERY'};
 if(group.some(t=>t.watchdog?.mode==='busy'||t.watchdog?.mode==='stalled'))
  return {state:STATES.WORKING,blocked:false,task_ids:ids,reason:'AGENT_BUSY'};
 const active=group.some(t=>t.enabled||t.manual_once);
 return {state:active?STATES.READY:STATES.PAUSED,
  blocked:false,task_ids:ids,reason:active?'CHECK_BEFORE_SEND':'DISABLED'};
}
export function conversationStates(tasks,now=Date.now()){
 const urls=[...new Set(tasks.map(t=>t.url))];
 return Object.fromEntries(urls.map(url=>[url,conversationState(tasks,url,now)]));
}
export function eligibleToSend(task,tasks,now=Date.now()) {
 if(task.status!=='scheduled'||!(task.enabled||task.manual_once)||
    !Number.isFinite(Date.parse(task.next_at))||Date.parse(task.next_at)>now)
   return false;
 // This task is scheduled; a conflict must arise from a DIFFERENT task in
 // the same conversation. No global lock on unrelated chats.
 const other=tasks.filter(t=>t.id!==task.id&&t.url===task.url);
 return !other.some(t=>UNCERTAIN.has(t.status)||IN_FLIGHT.has(t.status)||
   t.watchdog?.mode==='recovering'||t.watchdog?.mode==='refresh-deferred') &&
   task.watchdog?.mode!=='recovering'&&task.watchdog?.mode!=='refresh-deferred';
}
export function nextDue(tasks,now=Date.now(),lastId=null){
 const eligible=tasks.filter(t=>eligibleToSend(t,tasks,now));
 // Stable ordering prevents one chat starving another on a single Chrome
 // session, while preserving the due time for scheduled work.
 eligible.sort((a,b)=>Date.parse(a.next_at)-Date.parse(b.next_at)||
   String(a.id).localeCompare(String(b.id)));
 if(lastId&&eligible.length>1) {
  const prior=eligible.findIndex(t=>t.id===lastId);
  if(prior>=0)return eligible[(prior+1)%eligible.length];
 }
 return eligible[0]||null;
}
export function canObserveTask(task,tasks) {
 if(!task.enabled||task.status!=='scheduled')return false;
 return !tasks.some(t=>t.id!==task.id&&t.url===task.url&&
   (UNCERTAIN.has(t.status)||IN_FLIGHT.has(t.status)));
}
