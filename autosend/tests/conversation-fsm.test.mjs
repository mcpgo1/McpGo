import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STATES,conversationState,conversationStates,eligibleToSend,nextDue,canObserveTask}
 from '../conversation-fsm.mjs';

const now=Date.parse('2026-11-09T12:00:00Z');
const url=n=>'https://chatgpt.com/c/00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const task=(n,status='scheduled')=>({id:'task-'+n,url:url(n),status,
 enabled:true,interval_seconds:60,next_at:new Date(now-60000).toISOString()});

test('four agents have independently derived durable states',()=>{
 const tasks=[task(1,'unknown'),task(2,'verifying'),task(3),task(4)];
 const status=conversationStates(tasks,now);
 assert.equal(status[url(1)].state,STATES.UNKNOWN);
 assert.equal(status[url(2)].state,STATES.VERIFYING_SEND);
 assert.equal(status[url(3)].state,STATES.READY);
 assert.equal(status[url(4)].state,STATES.READY);
 assert.equal(eligibleToSend(tasks[2],tasks,now),true);
 assert.equal(eligibleToSend(tasks[3],tasks,now),true);
 assert.equal(nextDue(tasks,now).id,'task-3');
 assert.equal(nextDue(tasks,now,'task-3').id,'task-4');
});

test('unconfirmed click blocks ONLY other schedules sharing the same conversation',()=>{
 const unknown=task(1,'unknown');
 const sibling={...task(6),url:unknown.url};
 const separate=task(2);
 const tasks=[unknown,sibling,separate];
 assert.equal(conversationState(tasks,unknown.url).blocked,true);
 assert.equal(eligibleToSend(sibling,tasks,now),false);
 assert.equal(eligibleToSend(separate,tasks,now),true);
 assert.equal(canObserveTask(sibling,tasks),false);
 assert.equal(canObserveTask(separate,tasks),true);
});

test('reloaded tasks.json reconstructs same state without a second state store',()=>{
 const tasks=[
  {...task(1),watchdog:{mode:'recovering'}},
  {...task(2),watchdog:{mode:'busy'}},
  task(3,'verifying'),
  {...task(4,'paused'),enabled:false}
 ];
 const first=conversationStates(tasks,now);
 const afterRestart=conversationStates(JSON.parse(JSON.stringify(tasks)),now);
 assert.deepEqual(first,afterRestart);
 assert.equal(first[url(1)].state,STATES.RECOVERING);
 assert.equal(first[url(2)].state,STATES.WORKING);
 assert.equal(first[url(3)].state,STATES.VERIFYING_SEND);
 assert.equal(first[url(4)].state,STATES.PAUSED);
});

test('task marked recovering cannot send even if its due time passed',()=>{
 const t={...task(1),watchdog:{mode:'recovering'}};
 assert.equal(eligibleToSend(t,[t],now),false);
 assert.equal(nextDue([t],now),null);
});

test('verification finished in chat A cannot unlock an unresolved B state',()=>{
 const a=task(1,'verifying'),b=task(2,'unknown'),c=task(3);
 assert.equal(eligibleToSend(c,[a,b,c],now),true);
 a.status='scheduled';a.next_at=new Date(now-1000).toISOString();
 assert.equal(eligibleToSend(a,[a,b,c],now),true);
 assert.equal(conversationState([a,b,c],b.url).state,STATES.UNKNOWN);
});
