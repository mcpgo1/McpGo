import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {probeMcp} from './mcp-health.mjs';
import {TunnelRecovery} from './tunnel-recovery.mjs';
import {checkHealthFile} from './tunnel-health.mjs';
import {mcpVersions} from './mcp-versions.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const PORT = 8969;
const DOMAIN = `gui/${process.getuid()}`;
const AGENTS = path.join(os.homedir(), 'Library/LaunchAgents');
const groups = {
  terminal: ['com.chatterminalhub.server','com.chatterminalhub.oneshot','com.chatterminalhub.tunnel'],
  'terminal-tunnel': ['com.chatterminalhub.tunnel'],
  playwright: ['com.mcphub.playwright.browser','com.mcphub.playwright.proxy','com.mcphub.playwright.tunnel'],
};
const ports = {browser: 8931, proxy: 8940};

const TUNNEL_LABEL = 'com.chatterminalhub.tunnel';
const TUNNEL_DIR = path.join(process.env.HOME, 'Library/Application Support/ChatTerminalHub');
const TUNNEL_SCRIPT = path.join(TUNNEL_DIR, 'run-tunnel.sh');
const TUNNEL_SOURCE = path.join(ROOT, 'terminal/run-tunnel.sh');
const TUNNEL_PLIST = path.join(AGENTS, TUNNEL_LABEL + '.plist');

const RECOVERY_FILE=path.join(os.homedir(),'Library','Application Support','McpGo','tunnel-recovery-state.json');
const RECOVERY_URL_FILES={
  terminal:path.join(os.homedir(),'Library','Application Support','McpGo','terminal','tunnel-health.url'),
  playwright:path.join(os.homedir(),'Library','Application Support','McpGo','playwright','tunnel-health.url')
};
const RECOVERY_LABELS={terminal:TUNNEL_LABEL,playwright:'com.mcphub.playwright.tunnel'};
function agentOwned(label){
  const plist=path.join(AGENTS,label+'.plist');
  try {
    const owner=execFileSync('/usr/libexec/PlistBuddy',
      ['-c','Print :EnvironmentVariables:MCPGO_INSTALL_ROOT',plist],
      {encoding:'utf8',timeout:3500,stdio:['ignore','pipe','ignore']}).trim();
    return owner===ROOT;
  }catch{return false}
}
const recovery=new TunnelRecovery({
  file:RECOVERY_FILE,
  canAct:()=>!busy,
  probe:async target=>{
    const label=RECOVERY_LABELS[target],j=job(label);
    if(!j.running)return {health:'down',reason:'TUNNEL_PROCESS_STOPPED',pid:null};
    // Do not touch the browser itself. A stopped proxy is not a reason
    // to repeatedly restart the outbound tunnel.
    if(target==='playwright' && !(await alive(ports.proxy)))
      return {health:'offline',reason:'LOCAL_MCP_BACKEND_UNAVAILABLE',pid:j.pid};
    return {...await checkHealthFile(RECOVERY_URL_FILES[target]),pid:j.pid};
  },
  restart:async(target,observed)=>{
    if(busy)return false;
    const label=RECOVERY_LABELS[target],j=job(label);
    if(!j.loaded||!agentOwned(label))return false;
    if(observed?.pid && j.pid!==observed.pid)return false;
    if(target==='playwright' && !(await alive(ports.proxy)))return false;
    // Never restart terminal/server, job_worker, Chrome or MCP proxy here.
    call(['kickstart',...(j.running?['-k']:[]),DOMAIN+'/'+label]);
    return true;
  }
});


function plistEdit(args) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', args, TUNNEL_PLIST], {stdio:'pipe', timeout:5000});
}
function plistRead(key) {
  try {return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, TUNNEL_PLIST], {encoding:'utf8',timeout:5000}).trim();}
  catch {return null;}
}
function ensureTerminalTunnel() {
  fs.mkdirSync(TUNNEL_DIR, {recursive:true,mode:0o700});
  const source=fs.existsSync(TUNNEL_SOURCE) ? TUNNEL_SOURCE : TUNNEL_SCRIPT;
  if(!fs.existsSync(source)) throw Error('Не найден run-tunnel.sh — переустановите терминальный компонент');
  if(source !== TUNNEL_SCRIPT) {
    const content=fs.readFileSync(source);
    if(!fs.existsSync(TUNNEL_SCRIPT) || !fs.readFileSync(TUNNEL_SCRIPT).equals(content)) {
      const temp=TUNNEL_SCRIPT + '.tmp-' + process.pid;
      try {fs.writeFileSync(temp,content,{mode:0o700,flag:'wx'});fs.renameSync(temp,TUNNEL_SCRIPT);}
      finally {try {fs.unlinkSync(temp);}catch {}}
    }
  }
  fs.chmodSync(TUNNEL_SCRIPT,0o700);
  if(!fs.existsSync(TUNNEL_PLIST)) {
    const template=path.join(ROOT,'launchagents',TUNNEL_LABEL+'.plist');
    if(!fs.existsSync(template)) throw Error('Не найден шаблон LaunchAgent терминального туннеля');
    fs.copyFileSync(template,TUNNEL_PLIST);
  }
  let changed=false;
  if(plistRead('ProgramArguments:0')!==TUNNEL_SCRIPT) {
    // ProgramArguments contains only index 0; use it rather than creating index 1.
    plistEdit('Set :ProgramArguments:0 ' + TUNNEL_SCRIPT);
    changed=true;
  }
  if(plistRead('WorkingDirectory')!==null) {plistEdit('Delete :WorkingDirectory');changed=true;}
  if(changed) {
    execFileSync('/usr/bin/plutil',['-lint',TUNNEL_PLIST],{stdio:'pipe',timeout:5000});
    if(job(TUNNEL_LABEL).loaded) call(['bootout',DOMAIN+'/'+TUNNEL_LABEL]);
    call(['bootstrap',DOMAIN,TUNNEL_PLIST]);
  }
  return changed;
}

let busy = false;
function call(args) {
  return execFileSync('/bin/launchctl', args, {encoding:'utf8', timeout: 7000, stdio:['ignore','pipe','pipe']});
}
function job(label) {
  try {
    const out = call(['print', `${DOMAIN}/${label}`]);
    const pid = out.match(/(?:^|\n)\s*pid = (\d+)/)?.[1];
    return {loaded:true, running:!!pid, pid:pid ? Number(pid) : null};
  } catch {return {loaded:false, running:false, pid:null};}
}
function alive(port) {
  return new Promise(resolve => {
    const s = net.connect({host:'127.0.0.1',port});
    s.setTimeout(450);
    s.once('connect',()=>{s.destroy(); resolve(true);});
    s.once('error',()=>{s.destroy(); resolve(false);});
    s.once('timeout',()=>{s.destroy(); resolve(false);});
  });
}
async function waitPort(port, ms=16000) {
  const until=Date.now()+ms;
  do {if (await alive(port)) return true; await new Promise(r=>setTimeout(r,320));} while(Date.now()<until);
  return false;
}
let mcpHealthCache={value:false,validUntil:0};
let mcpHealthFlight=null;
async function mcpReadiness(){
  if(Date.now()<mcpHealthCache.validUntil)return mcpHealthCache.value;
  if(mcpHealthFlight)return mcpHealthFlight;
  mcpHealthFlight=(async()=>{
    let ready=false;
    try{ready=await probeMcp();}catch{}
    mcpHealthCache={value:ready,validUntil:Date.now()+15000};
    return ready;
  })();
  try{return await mcpHealthFlight;}
  finally{mcpHealthFlight=null;}
}
async function status() {
  const terminal = groups.terminal.map(job);
  const browser = groups.playwright.map(job);
  const [backend,proxy] = await Promise.all([alive(ports.browser),alive(ports.proxy)]);
  // Keep the status endpoint fast; Chrome can wait for user CDP consent.
  if(backend&&proxy)void mcpReadiness();
  const mcpReady=backend&&proxy?mcpHealthCache.value:false;
  const keyDir=path.join(os.homedir(),'Library','Application Support','McpGo','playwright');
  const hasFile = n => {try {return fs.statSync(`${keyDir}/${n}`).size>0;}catch{return false;}};
  const hasKeychain = (() => {try {execFileSync('/usr/bin/security',['find-generic-password','-a',os.userInfo().username,'-s','com.mcphub.playwright.openai.tunnel'],{stdio:'ignore',timeout:2500});return true;}catch{return false;}})();
  const configured=hasFile('tunnel.id') && (hasFile('tunnel.key') || hasKeychain);
  return {installationRoot:ROOT,busy,mcpVersions:mcpVersions(ROOT),recovery:recovery.snapshot(),terminal:{server:terminal[0],oneshot:terminal[1],tunnel:terminal[2]},playwright:{browser:browser[0],proxy:browser[1],tunnel:browser[2],backend,proxyReady:proxy,mcpReady,configured},updatedAt:new Date().toISOString()};
}
function load(label) {
  if(label===TUNNEL_LABEL) ensureTerminalTunnel();
  if (!job(label).loaded) call(['bootstrap',DOMAIN,`${AGENTS}/${label}.plist`]);
  if (!job(label).running) call(['kickstart',`${DOMAIN}/${label}`]);
}
function unload(label) {
  if (job(label).loaded) call(['bootout',`${DOMAIN}/${label}`]);
}
async function waitFor(predicate, timeout=25000) {
  const until=Date.now()+timeout;
  do {if(await predicate()) return true; await new Promise(r=>setTimeout(r,350));} while(Date.now()<until);
  return false;
}
async function action(group,verb) {
  if (!Object.hasOwn(groups,group) || !['start','stop','restart'].includes(verb)) throw Error('Неизвестное действие');
  if (verb==='stop' || verb==='restart') {
    for (const label of [...groups[group]].reverse()) unload(label);
    // launchd bootout is asynchronous: do not re-bootstrap while the old ports are still open.
    if (group==='playwright') {
      const stopped=await waitFor(async()=>
        groups.playwright.every(label=>!job(label).loaded) &&
        !(await alive(ports.browser)) && !(await alive(ports.proxy)),25000);
      if (!stopped) throw Error('Playwright не остановился полностью — новый запуск отменён');
    }
  }
  if (verb==='start' || verb==='restart') {
    if(group==='terminal' || group==='terminal-tunnel') ensureTerminalTunnel();
    if(group==='playwright') {
      load(groups[group][0]);
      if(!await waitFor(async()=>job(groups[group][0]).running && await alive(ports.browser),35000))
        throw Error('Playwright не открыл порт 8931 — проверьте logs/playwright/browser.err.log');
      load(groups[group][1]);
      if(!await waitFor(async()=>job(groups[group][1]).running && await alive(ports.proxy),15000))
        throw Error('MCP proxy не открыл порт 8940 — проверьте logs/playwright/proxy.err.log');
      // Wait for a working MCP initialize before starting the outbound tunnel.
      let mcpInitialized=false;
      for(let retry=0;retry<10;retry++) {
        try {
          execFileSync(process.execPath,[`${ROOT}/playwright/probe.mjs`],{
            env:{...process.env,PLAYWRIGHT_MCP_URL:'http://127.0.0.1:8940/mcp',PLAYWRIGHT_MCP_REJECT_UNSAFE:'1'},
            timeout:12000,stdio:['ignore','pipe','pipe']});
          mcpInitialized=true;break;
        } catch {await new Promise(r=>setTimeout(r,900));}
      }
      if(!mcpInitialized) throw Error('Браузер открыл порт, но MCP не готов — запуск туннеля отменён');
      load(groups[group][2]);
      if(!await waitFor(async()=>job(groups[group][2]).running,12000))
        throw Error('Туннель не запустился — проверьте logs/playwright/tunnel.err.log');
      // Verify an actual MCP handshake, not merely a transient PID or listening socket.
      await new Promise(r=>setTimeout(r,3500));
      const final=await status();
      if (!final.playwright.browser.running || !final.playwright.proxy.running || !final.playwright.tunnel.running || !final.playwright.backend || !final.playwright.proxyReady)
        throw Error('Playwright не прошёл проверку готовности после запуска');
      try {
        execFileSync(process.execPath,[`${ROOT}/playwright/probe.mjs`],{
          env:{...process.env,PLAYWRIGHT_MCP_URL:'http://127.0.0.1:8940/mcp',PLAYWRIGHT_MCP_REJECT_UNSAFE:'1',PLAYWRIGHT_MCP_VERIFY_TABS:'1'},
          timeout:44000,stdio:['ignore','pipe','pipe']});
      } catch {throw Error('Playwright CDP не видит вкладки Chrome. Проверь включение Chrome Remote Debugging и перезапусти Playwright.');}
    } else {
      for(const label of groups[group]) load(label);
      if(!await waitFor(async()=>groups[group].every(label=>job(label).running),12000))
        throw Error('Не все службы запустились — проверьте журнал туннеля');
      await new Promise(r=>setTimeout(r,1800));
      if(!groups[group].every(label=>job(label).running))
        throw Error('Служба завершилась сразу после запуска — проверьте журнал туннеля');
    }
  }
}

const json=(res,code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
const server = http.createServer(async (req,res)=>{
  const host=req.headers.host || '';
  if(host!==`127.0.0.1:${PORT}` && host!==`localhost:${PORT}`){res.writeHead(403);return res.end('forbidden');}
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const url=new URL(req.url,`http://${host}`);
  if(req.method==='GET' && url.pathname==='/api/status') return json(res,200,await status());
  if(req.method==='POST' && url.pathname==='/api/action') {
    const origin=req.headers.origin || '';
    if(!['http://127.0.0.1:8969','http://localhost:8969'].includes(origin) || req.headers['x-mcp-hub']!=='dashboard' || !String(req.headers['content-type']).startsWith('application/json')) return json(res,403,{error:'Недопустимый запрос'});
    if(busy) return json(res,409,{error:'Другое действие уже выполняется'});
    busy=true;
    try {
      let body='';
      for await (const chunk of req) {body+=chunk; if(body.length>2000) throw Error('Слишком длинный запрос');}
      const {group,action:verb}=JSON.parse(body);
      if(group==='system' && verb==='logs') execFileSync('/usr/bin/open',[`${ROOT}/logs`],{timeout:4000});
      else if(group==='system' && verb==='folder') execFileSync('/usr/bin/open',[ROOT],{timeout:4000});
      else {
        if(verb==='stop' && ['terminal','terminal-tunnel','playwright'].includes(group))
          recovery.setDesired(group==='playwright'?'playwright':'terminal',false);
        await action(group,verb);
        if((verb==='start'||verb==='restart') &&
           ['terminal','terminal-tunnel','playwright'].includes(group))
          recovery.setDesired(group==='playwright'?'playwright':'terminal',true);
      }
      return json(res,200,{ok:true,status:await status()});
    } catch(e) {return json(res,500,{error:String(e.message||'Ошибка').slice(0,280),status:await status()});}
    finally {busy=false;}
  }
  if(req.method!=='GET') {res.writeHead(405);return res.end('Method not allowed');}
  const pages={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
  const name=pages[url.pathname];
  if(!name) {res.writeHead(404);return res.end('Not found');}
  const mime=name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html';
  res.writeHead(200,{'content-type':mime+'; charset=utf-8','cache-control':'no-store'});
  fs.createReadStream(path.join(DIR,name)).pipe(res);
});
try { ensureTerminalTunnel(); } catch(e) { console.error('Tunnel agent setup:', e.message); }
server.listen(PORT,'127.0.0.1',()=>console.log(`McpGo ready: http://127.0.0.1:${PORT}`));
// Recovery is opt-in through the explicit Dashboard Start action. No legacy
// tunnel, browser or terminal job is restarted when this code is installed.
setInterval(()=>{if(!busy)void recovery.tick().catch(e=>
  console.error('Tunnel recovery check failed:',e.code||'UNKNOWN'))},15000).unref();
