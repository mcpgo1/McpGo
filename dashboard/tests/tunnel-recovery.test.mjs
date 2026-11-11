import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TunnelRecovery} from '../tunnel-recovery.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-recovery-tests-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
function env(label='normal') {
 let time=1000000,health={terminal:'ready',playwright:'ready'};
 const calls=[];
 const recovery=new TunnelRecovery({
  file:path.join(root,label+'.json'),
  now:()=>time,random:()=>0,
  probe:async t=>({health:health[t]}),
  restart:async t=>{calls.push(t);return true}
 });
 return {recovery,calls,health,advance:ms=>{time+=ms},now:()=>time};
}
test('disabled by default; explicit start and stop persist across restart',async()=>{
 const e=env('desired');await e.recovery.tick();
 assert.deepEqual(e.calls,[]);assert.equal(e.recovery.snapshot().terminal.desired,false);
 e.recovery.setDesired('terminal',true);await e.recovery.tick();
 assert.equal(e.recovery.snapshot().terminal.status,'CONNECTED');
 let h=new TunnelRecovery({file:path.join(root,'desired.json'),probe:async()=>({health:'ready'}),restart:async()=>{throw Error('unexpected')}});
 assert.equal(h.snapshot().terminal.desired,true);
 h.setDesired('terminal',false);await h.tick();
 assert.equal(h.snapshot().terminal.status,'STOPPED_BY_USER');
 assert.equal(fs.statSync(path.join(root,'desired.json')).mode&0o777,0o600);
});
test('transient health failures do not restart; unrelated tunnel stays independent',async()=>{
 const e=env('transient');e.recovery.setDesired('terminal',true);e.recovery.setDesired('playwright',true);
 await e.recovery.tick();e.health.terminal='down';
 e.advance(15000);await e.recovery.tick();
 e.advance(15000);await e.recovery.tick();
 assert.deepEqual(e.calls,[]);assert.equal(e.recovery.snapshot().playwright.status,'CONNECTED');
 e.health.terminal='ready';e.advance(15000);await e.recovery.tick();
 assert.equal(e.recovery.snapshot().terminal.status,'CONNECTED');
});
test('3 confirmed failures restart only failing tunnel, and use backoff',async()=>{
 const e=env('backoff');e.recovery.setDesired('terminal',true);
 e.health.terminal='down';
 for(let n=0;n<3;n++){await e.recovery.tick();e.advance(15000)}
 assert.deepEqual(e.calls,['terminal']);assert.equal(e.recovery.snapshot().terminal.status,'RECOVERING');
 for(let n=0;n<2;n++){await e.recovery.tick();e.advance(5000)}
 assert.equal(e.calls.length,1);
});
test('live unready tunnel gets grace; unmonitored process is not killed',async()=>{
 const e=env('grace');e.recovery.setDesired('playwright',true);
 e.health.playwright='unmonitored';await e.recovery.tick();
 assert.equal(e.recovery.snapshot().playwright.status,'UNMONITORED');
 e.health.playwright='starting';
 for(let n=0;n<6;n++){e.advance(15000);await e.recovery.tick()}
 assert.deepEqual(e.calls,[]);
 e.advance(180000);for(let n=0;n<3;n++){await e.recovery.tick();e.advance(16000)}
 assert.deepEqual(e.calls,[],'Live but nonready tunnel is diagnosed, never killed just for /readyz 503');
 assert.equal(e.recovery.snapshot().playwright.lastProblem,'PROLONGED_NOT_READY');
});
test('authorization error and unknown persisted state are fail-closed',async()=>{
 const e=env('auth');e.recovery.setDesired('terminal',true);
 e.health.terminal='auth';for(let n=0;n<10;n++){e.advance(15000);await e.recovery.tick()}
 assert.deepEqual(e.calls,[]);assert.equal(e.recovery.snapshot().terminal.status,'AUTH_REQUIRED');
 fs.writeFileSync(path.join(root,'corrupt.json'),'{');
 const bad=new TunnelRecovery({file:path.join(root,'corrupt.json'),probe:async()=>({health:'down'}),restart:async()=>{throw Error('should not run')}});
 await bad.tick();assert.equal(bad.snapshot().terminal.desired,false);
});
test('circuit breaker stops after 6 attempts, without blocking other tunnel',async()=>{
 const e=env('breaker');e.recovery.setDesired('terminal',true);
 e.recovery.setDesired('playwright',true);e.health.terminal='down';
 for(let i=0;i<72;i++){await e.recovery.tick();e.advance(15000)}
 assert.equal(e.calls.length,6);
 assert.equal(e.recovery.snapshot().terminal.status,'NEEDS_ATTENTION');
 assert.equal(e.recovery.snapshot().playwright.status,'CONNECTED');
});
test('sleep/resume grace prevents immediate killing of slow reconnected tunnel',async()=>{
 const e=env('wakeup');e.recovery.setDesired('terminal',true);e.health.terminal='down';
 await e.recovery.tick();e.advance(90000);await e.recovery.tick();
 assert.equal(e.calls.length,0);assert.equal(e.recovery.snapshot().terminal.lastProblem,'TUNNEL_UNHEALTHY');
});
