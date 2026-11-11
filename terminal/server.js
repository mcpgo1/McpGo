'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');
const jobs=require('./job_runtime.js');
const platform=require('./platform.js');
const MCP_VERSION=require('./mcp-version.json').version;
const APP = __dirname;
const CONFIG_PATH = process.env.MCPGO_TERMINAL_CONFIG || path.join(platform.dataRoot(),'terminal','config.json');
fs.mkdirSync(path.dirname(CONFIG_PATH),{recursive:true,mode:0o700});
const PORT = 12847;
const HOST = '127.0.0.1';
const MAX_SESSIONS = 12;
const MAX_TEXT = 262144;
const MAX_BODY = 70000;
const sessions = new Map();

function secret() { return crypto.randomBytes(32).toString('hex'); }
function config() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({adminKey:secret(), mcpPath:'mcp/'+secret()},null,2)+'\n',{mode:0o600,flag:'wx'});
  }
  const v=JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8'));
  if (!/^[a-f0-9]{64}$/.test(v.adminKey) || !/^mcp\/[a-f0-9]{64}$/.test(v.mcpPath)) throw Error('Invalid private config');
  return v;
}
const conf=config();
const equal=(a,b)=> typeof a==='string' && typeof b==='string' && a.length===b.length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function isAdmin(req) {return equal(req.headers['x-hub-key'],conf.adminKey);}
function hasAccess(req,s) {return isAdmin(req) || equal(req.headers['x-session-key'],s.key);}
function info(s) {return {id:s.id,name:s.name,status:s.status,created:s.created,pid:s.pid,offset:s.base+s.output.length};}
function createSession(name) {
  if (sessions.size>=MAX_SESSIONS) throw Error('SESSION_LIMIT');
  const id=crypto.randomUUID();
  const s={id,key:secret(),name:(typeof name==='string'?name:'Chat').trim().slice(0,60)||'Chat',created:new Date().toISOString(),status:'starting',pid:null,output:'',base:0,worker:null};
  const user=os.userInfo().username;
  const env=platform.isWindows()?{...process.env,HOME:os.homedir(),USER:user,LOGNAME:user,TERM:'xterm-256color'}:
    {HOME:os.homedir(),USER:user,LOGNAME:user,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',TERM:'xterm-256color',LANG:'en_US.UTF-8'};
  const cmd=platform.isWindows()?process.execPath:(process.env.MCPGO_PYTHON_BIN||'/usr/bin/python3');
  const args=platform.isWindows()?[path.join(APP,'pty_worker_win.js')]:['-u',path.join(APP,'pty_worker.py')];
  const child=spawn(cmd,args,{cwd:os.homedir(),env,stdio:['pipe','pipe','pipe']});
  s.worker=child;
  const decoder=new StringDecoder('utf8');
  function push(v){
    s.output+=v;
    if(s.output.length>MAX_TEXT){const over=s.output.length-MAX_TEXT;s.output=s.output.slice(over);s.base+=over;}
  }
  let lines='';
  child.stdout.on('data',chunk=>{
    lines+=chunk.toString('utf8');
    let i;
    while((i=lines.indexOf('\n'))>=0){
      const line=lines.slice(0,i);lines=lines.slice(i+1);
      try {
        const v=JSON.parse(line);
        if(v.event==='ready'){s.pid=v.pid;s.status='running';}
        if(v.event==='data')push(decoder.write(Buffer.from(v.base64,'base64')));
        if(v.event==='exit'){s.status='exited';s.exitCode=v.code;push('\n[Сессия завершена]\n');}
        if(v.event==='error')push('\n[PTY error: '+v.message+']\n');
      }catch(e){push('\n[Decode error]\n');}
    }
  });
  child.stderr.on('data',v=>push('\n[PTY stderr: '+v.toString('utf8').slice(0,2000)+']\n'));
  child.on('error',e=>{s.status='error';push('\n[Worker error: '+e.message+']\n');});
  child.on('exit',(code)=>{push(decoder.end());s.status='exited';s.exitCode=code;});
  sessions.set(id,s);
  return {session_id:id,session_key:s.key,name:s.name,status:s.status};
}
function send(s,action,text,enter=true){
  if(s.status==='exited'||s.status==='error')throw Error('SESSION_CLOSED');
  const v={action};
  if(action==='write'){
    if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>60000)throw Error('INVALID_TEXT');
    v.text=text;v.enter=enter!==false;
  }
  if(!s.worker.stdin.writable)throw Error('SESSION_CLOSED');
  s.worker.stdin.write(JSON.stringify(v)+'\n');
  return {accepted:true,session_id:s.id,status:s.status};
}
function read(s,since){
  const n=Math.floor(Number(since)||0);
  const start=Math.max(s.base,Math.min(n,s.base+s.output.length));
  return {...info(s),truncated:n<s.base,from:start,text:s.output.slice(start-s.base),next:s.base+s.output.length,exit_code:s.exitCode===undefined?null:s.exitCode};
}
function close(s){
  try{if(s.worker.stdin.writable)s.worker.stdin.write('{"action":"close"}\n');}catch(_){}
  const c=s.worker;
  const watchdog=setTimeout(()=>{if(c.exitCode===null&&!c.killed)c.kill('SIGTERM');},2000);
  watchdog.unref();
  sessions.delete(s.id);
  return {closed:true,session_id:s.id};
}
function json(res,status,obj){
  const body=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"});
  res.end(body);
}
function body(req){
  return new Promise((resolve,reject)=>{
    let size=0,parts=[];
    req.on('data',c=>{size+=c.length;if(size>MAX_BODY){reject(Error('BODY_TOO_LARGE'));req.destroy();}else parts.push(c);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'));}catch(e){reject(Error('INVALID_JSON'));}});
    req.on('error',reject);
  });
}
function toolSchemas(){
  const sessionFields={session_id:{type:'string',description:'UUID returned by terminal_create'},session_key:{type:'string',description:'Private per-session capability returned by terminal_create'}};
  return [
    {name:'terminal_create',description:'Create an independent, persistent interactive terminal (ConPTY PowerShell on Windows, zsh on macOS). Save the session_id and session_key in this chat; do not reuse another chat session.',inputSchema:{type:'object',properties:{name:{type:'string',description:'Friendly tab name, for example Chat 1'}},additionalProperties:false}},
    {name:'terminal_send',description:'Queue an input or command on this chat terminal and return IMMEDIATELY, without waiting for completion. Then call terminal_read for output. enter=false sends raw text without newline.',inputSchema:{type:'object',properties:{...sessionFields,text:{type:'string'},enter:{type:'boolean',default:true}},required:['session_id','session_key','text'],additionalProperties:false}},
    {name:'terminal_read',description:'Read new output and state from this chat terminal, passing next as since in follow-up reads.',inputSchema:{type:'object',properties:{...sessionFields,since:{type:'integer',default:0}},required:['session_id','session_key'],additionalProperties:false}},
    {name:'terminal_interrupt',description:'Send Ctrl+C to the interactive terminal (foreground job).',inputSchema:{type:'object',properties:sessionFields,required:['session_id','session_key'],additionalProperties:false}},
    {name:'terminal_close',description:'Close only this terminal, ending its shell and foreground processes.',inputSchema:{type:'object',properties:sessionFields,required:['session_id','session_key'],additionalProperties:false}},
    ...jobs.tools
  ];
}
async function performTool(name,a){
  // Job registry is shared with one-shot MCP; no PTY session key needed for
  // tools that manage independent detached jobs.
  if(jobs.tools.some(t=>t.name===name)) {
    if(name==='job_start')return jobs.startJob(a);
    if(name==='job_status')return jobs.getStatus(a);
    if(name==='job_logs')return jobs.logs(a);
    if(name==='job_recent')return jobs.recent(a);
    if(name==='job_cancel')return jobs.cancel(a);
    if(name==='job_result')return jobs.result(a);
    if(name==='job_watch')return await jobs.watch(a);
    if(name==='job_output')return jobs.output(a);
    if(name==='mcpgo_recover')return jobs.recover(a);
    if(name==='resource_lock_status')return jobs.lockStatus(a);
  }
  if(name==='terminal_create')return createSession(a.name);
  const s=sessions.get(a.session_id);
  if(!s||!equal(a.session_key,s.key))throw Error('SESSION_NOT_FOUND_OR_FORBIDDEN');
  if(name==='terminal_send')return send(s,'write',a.text,a.enter);
  if(name==='terminal_read')return read(s,a.since||0);
  if(name==='terminal_interrupt')return send(s,'interrupt');
  if(name==='terminal_close')return close(s);
  throw Error('UNKNOWN_TOOL');
}
async function rpc(req,res){
  const p=await body(req);
  if(p.jsonrpc!=='2.0'||typeof p.method!=='string')return json(res,400,{jsonrpc:'2.0',id:p.id??null,error:{code:-32600,message:'Invalid JSON-RPC request'}});
  if(p.id===undefined){res.writeHead(202,{'Cache-Control':'no-store'});return res.end();}
  try{
    let result;
    if(p.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'ChatTerminalHub',version:MCP_VERSION},instructions:'For interactive PTY, each conversation must use its own terminal_create/session_key; terminal_send is an interactive write, NOT a durable job receipt. For recoverable commands use job_start and job_status. After an interrupted response call mcpgo_recover BEFORE repeating any command. Never replay unknown shell or browser actions.'};
    else if(p.method==='ping')result={};
    else if(p.method==='tools/list')result={tools:toolSchemas()};
    else if(p.method==='tools/call'){
      const args=p.params?.arguments||{};
      try {result={content:[{type:'text',text:JSON.stringify(await performTool(p.params?.name,args))}]};}
      catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}
    }else return json(res,200,{jsonrpc:'2.0',id:p.id,error:{code:-32601,message:'Method not found'}});
    return json(res,200,{jsonrpc:'2.0',id:p.id,result});
  }catch(e){return json(res,200,{jsonrpc:'2.0',id:p.id??null,error:{code:-32603,message:'Internal error'}});}
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1:'+PORT);
  const origin=req.headers.origin;
  if(origin && origin!=='http://127.0.0.1:'+PORT&&origin!=='http://localhost:'+PORT)return json(res,403,{error:'BAD_ORIGIN'});
  if(req.method==='GET'&&url.pathname==='/'){
    const html=fs.readFileSync(path.join(APP,'dashboard.html'));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; object-src 'none'; frame-ancestors 'none'"});
    return res.end(html);
  }
  if(req.method==='GET'&&url.pathname==='/dashboard.css'){
    res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    return res.end(fs.readFileSync(path.join(APP,'dashboard.css')));
  }
  if(req.method==='GET'&&url.pathname==='/dashboard.js'){
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    return res.end(fs.readFileSync(path.join(APP,'dashboard.js')));
  }
  if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,uptime:Math.floor(process.uptime())});
  if(url.pathname==='/'+conf.mcpPath){if(req.method!=='POST'){res.writeHead(405,{'Allow':'POST'});return res.end();}return rpc(req,res);}
  if(!url.pathname.startsWith('/api/'))return json(res,404,{error:'NOT_FOUND'});
  try{
    if(url.pathname==='/api/sessions'){
      if(!isAdmin(req))return json(res,401,{error:'UNAUTHORIZED'});
      if(req.method==='GET')return json(res,200,{sessions:Array.from(sessions.values(),info)});
      if(req.method==='POST')return json(res,201,createSession((await body(req)).name));
    }
    const match=url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\/(output|input|interrupt))?$/);
    if(!match)return json(res,404,{error:'NOT_FOUND'});
    const s=sessions.get(match[1]);
    if(!s||!hasAccess(req,s))return json(res,404,{error:'SESSION_NOT_FOUND_OR_FORBIDDEN'});
    if(req.method==='GET'&&match[2]==='output')return json(res,200,read(s,url.searchParams.get('since')||0));
    if(req.method==='POST'&&match[2]==='input'){const p=await body(req);return json(res,200,send(s,'write',p.text,p.enter));}
    if(req.method==='POST'&&match[2]==='interrupt')return json(res,200,send(s,'interrupt'));
    if(req.method==='DELETE'&&!match[2])return json(res,200,close(s));
    return json(res,405,{error:'METHOD_NOT_ALLOWED'});
  }catch(e){return json(res,e.message==='SESSION_LIMIT'?429:400,{error:e.message});}
});
server.listen(PORT,HOST,()=>console.log('ChatTerminalHub local-only http://'+HOST+':'+PORT));
function shutdown(){
  for(const s of sessions.values()){try{s.worker.stdin.write('{"action":"close"}\n');}catch(_){}}
  server.close();setTimeout(()=>process.exit(0),1000).unref();
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
