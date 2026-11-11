import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TARGETS=['terminal','playwright'];
const BACKOFF=[5000,10000,20000,40000,80000,120000];
const WINDOW=15*60*1000;
const NOT_READY_GRACE=180000;
const FAILURES_REQUIRED=3;
function blank(desired=false) {
  return {desired,status:desired?'CHECKING':'STOPPED_BY_USER',
    failures:0,attempts:[],nextRetryAt:null,lastHealthyAt:null,notReadySince:null,
    lastProblem:null,successes:0};
}
function readRecord(file) {
  try {
    const disk=JSON.parse(fs.readFileSync(file,'utf8'));
    if(disk.version!==1 || !disk.targets || typeof disk.targets!=='object')throw Error('BAD_VERSION');
    return Object.fromEntries(TARGETS.map(t=>{
      const a=disk.targets[t];
      if(!a||typeof a.desired!=='boolean'||!Array.isArray(a.attempts))throw Error('BAD_STATE');
      return [t,{...blank(a.desired),...a,attempts:a.attempts.filter(x=>Number.isFinite(x))}];
    }));
  } catch(e) {
    if(e.code==='ENOENT')return Object.fromEntries(TARGETS.map(t=>[t,blank()]));
    // Corrupt records must not trigger automated restarts.
    return Object.fromEntries(TARGETS.map(t=>[t,{...blank(),status:'NEEDS_ATTENTION',lastProblem:'STATE_UNREADABLE'}]));
  }
}
function persist(file,targets) {
  const folder=path.dirname(file);
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const temp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  try {
    fs.writeFileSync(temp,JSON.stringify({version:1,targets})+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temp,file);
    fs.chmodSync(file,0o600);
  } finally {
    try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}
  }
}
export class TunnelRecovery {
  constructor({file,probe,restart,now=()=>Date.now(),random=Math.random,canAct=()=>true}) {
    this.file=file;this.probe=probe;this.restart=restart;this.now=now;
    this.random=random;this.canAct=canAct;
    this.targets=readRecord(file);this.active=false;
    this.lastTick=null;
  }
  snapshot() {
    return Object.fromEntries(TARGETS.map(t=>[t,{
      ...this.targets[t],attempts:this.targets[t].attempts.length
    }]));
  }
  setDesired(target,desired) {
    if(!TARGETS.includes(target)||typeof desired!=='boolean')throw Error('INVALID_TARGET');
    const next={...this.targets,[target]:blank(desired)};
    persist(this.file,next);
    this.targets=next;
  }
  async tick() {
    if(this.active||!this.canAct())return this.snapshot();
    this.active=true;
    try {
      const now=this.now();
      // Sleep/resume or a suspended event loop: allow the client's own reconnect.
      const resumed=this.lastTick!==null && now-this.lastTick>60000;
      this.lastTick=now;
      if(resumed) {
        for(const t of TARGETS)if(this.targets[t].desired) {
          this.targets[t].failures=0;
          this.targets[t].nextRetryAt=now+30000;
          this.targets[t].status='DEGRADED';
          this.targets[t].lastProblem='WAKE_GRACE';
        }
      }
      await Promise.all(TARGETS.filter(t=>this.targets[t].desired).map(t=>this.check(t)));
      persist(this.file,this.targets);
      return this.snapshot();
    } finally {this.active=false}
  }
  async check(target) {
    const s=this.targets[target], now=this.now();
    let p;
    try {p=await this.probe(target)}
    catch {p={health:'down',reason:'HEALTH_CHECK_FAILED'}}
    if(!s.desired)return;
    if(p.health==='auth') {
      s.status='AUTH_REQUIRED';s.lastProblem='AUTH_REQUIRED';
      s.failures=0;s.nextRetryAt=null;return;
    }
    if(s.status==='AUTH_REQUIRED'||s.status==='NEEDS_ATTENTION')return;
    if(p.health==='ready') {
      s.status='CONNECTED';s.lastHealthyAt=now;s.failures=0;
      s.notReadySince=null;s.nextRetryAt=null;s.lastProblem=null;
      s.successes=Math.min(s.successes+1,2);
      if(s.successes===2)s.attempts=[];return;
    }
    s.successes=0;
    if(p.health==='unmonitored') {
      // Existing tunnel from a previous release, with no health URL yet.
      // Don't kill a healthy-looking process just to upgrade monitoring.
      s.status='UNMONITORED';s.lastProblem='NO_HEALTH_URL';return;
    }
    if(p.health==='offline') {
      s.status='OFFLINE';s.lastProblem='NETWORK_OFFLINE';return;
    }
    if(p.health==='starting') {
      // /readyz is startup readiness, not liveness. The official tunnel-client
      // can self-retry OAuth discovery and network polling for a long time.
      // Restarting a live process on 503 risks interrupting in-flight work.
      s.notReadySince??=now;
      s.status='DEGRADED';
      s.lastProblem=now-s.notReadySince>NOT_READY_GRACE?
        'PROLONGED_NOT_READY':'TUNNEL_NOT_READY';
      return;
    }
    s.notReadySince=null;
    s.failures++;
    s.lastProblem=String(p.reason||'TUNNEL_UNHEALTHY').slice(0,64);
    s.status='DEGRADED';
    if(s.failures<FAILURES_REQUIRED || !this.canAct())return;
    if(s.nextRetryAt!==null && now<s.nextRetryAt) {
      s.status='RECOVERING';return;
    }
    s.attempts=s.attempts.filter(x=>now-x<WINDOW);
    if(s.attempts.length>=BACKOFF.length) {
      s.status='NEEDS_ATTENTION';s.nextRetryAt=null;s.lastProblem='RETRY_BUDGET_EXHAUSTED';
      return;
    }
    // The restart callback must check the service ownership and recheck state
    // immediately before kicking ONLY the selected tunnel process.
    try {
      const acted=await this.restart(target,p);
      if(!acted) {s.status='DEGRADED';s.lastProblem='RESTART_DEFERRED';return}
    } catch {
      s.lastProblem='RESTART_FAILED';
    }
    s.attempts.push(now);
    s.failures=0;
    const delay=BACKOFF[Math.min(s.attempts.length-1,BACKOFF.length-1)];
    s.nextRetryAt=now+Math.round(delay*(1+0.2*this.random()));
    s.status='RECOVERING';
  }
}
export const recoveryConstants={BACKOFF,WINDOW,NOT_READY_GRACE,FAILURES_REQUIRED};
