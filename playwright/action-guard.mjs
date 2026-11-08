/**
 * Durable receipt for potentially mutating Playwright MCP actions.
 * Records only tool name, fingerprints, status, timestamps: never DOM text,
 * arguments, URLs, screenshots, secrets, or cookies.
 *
 * An explicit x-mcpgo-action-id grants at-most-one DISPATCH ATTEMPT, not
 * exactly-once completion. Unknown outcomes are never automatically replayed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DEFAULT_ACTION_ROOT=path.join(os.homedir(),'Library','Application Support','McpGo','browser-actions');
export const ACTION_ID_RE=/^[a-zA-Z0-9._:-]{8,128}$/;

export function isMutatingTool(name,args={}){
 if(name==='browser_tabs')return args?.action!=='list';
 return !new Set([
  'browser_snapshot','browser_take_screenshot',
  'browser_console_messages','browser_network_requests',
 ]).has(name);
}
export function actionDigest(tool,args){
 return crypto.createHash('sha256').update(JSON.stringify([tool,args||{}])).digest('hex');
}
export class ActionGuard {
 constructor(root=process.env.MCPGO_ACTION_ROOT||DEFAULT_ACTION_ROOT){this.root=root;}
 filepath(id){
  if(typeof id!=='string'||!ACTION_ID_RE.test(id))throw Error('INVALID_ACTION_ID');
  const hash=crypto.createHash('sha256').update(id).digest('hex');
  return path.join(this.root,hash+'.json');
 }
 lookup(id){
  const file=this.filepath(id);
  try{
   const record=JSON.parse(fs.readFileSync(file,'utf8'));
   return {found:true,state:record.state,tool:record.tool,possible_commit:record.possible_commit,
    started_at:record.started_at,finished_at:record.finished_at??null,
    upstream_status:record.upstream_status??null};
  }catch(e){
   if(e.code==='ENOENT')return {found:false,state:'not_found',possible_commit:false};
   return {found:true,state:'unknown',possible_commit:true,reason:'RECEIPT_UNREADABLE'};
  }
 }
 claim(id,tool,args){
  const file=this.filepath(id);
  const digest=actionDigest(tool,args);
  fs.mkdirSync(this.root,{recursive:true,mode:0o700});
  const receipt={version:1,state:'dispatched',tool,digest,started_at:new Date().toISOString(),
   possible_commit:true};
  try{
   const fd=fs.openSync(file,'wx',0o600);
   try{fs.writeSync(fd,JSON.stringify(receipt));fs.fsyncSync(fd)}
   finally{fs.closeSync(fd)}
   return {claimed:true,state:'dispatched'};
  }catch(e){
   if(e.code!=='EEXIST')throw e;
   let previous;
   try{previous=JSON.parse(fs.readFileSync(file,'utf8'))}
   catch{return {claimed:false,state:'unknown',reason:'RECEIPT_UNREADABLE'};}
   if(previous.digest!==digest||previous.tool!==tool)
    return {claimed:false,state:'conflict',reason:'ACTION_ID_CONFLICT'};
   return {claimed:false,state:previous.state,reason:'ALREADY_DISPATCHED'};
  }
 }
 finish(id,state,status){
  const file=this.filepath(id);
  // A write after a crash must never re-create the receipt or alter an
  // already finalized one; keep the original operation fingerprint.
  let old;
  try{old=JSON.parse(fs.readFileSync(file,'utf8'))}catch{return}
  if(old.state!=='dispatched')return;
  const final={...old,state,upstream_status:status??null,
   possible_commit:state!=='refused',finished_at:new Date().toISOString()};
  const temp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  let fd=null;
  try{
   fd=fs.openSync(temp,'wx',0o600);
   fs.writeSync(fd,JSON.stringify(final));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
   fs.renameSync(temp,file);
  }finally{
   if(fd!==null)fs.closeSync(fd);
   try{fs.unlinkSync(temp)}catch{}
  }
 }
}
export const ACTION_STATUS_TOOL={
 name:'mcpgo_action_status',
 description:'Read-only recovery of a durable browser action receipt using its x-mcpgo-action-id. Reports completed/dispatched/unknown without replaying any action; completed means the browser MCP returned a response, not that a site-side write committed.',
 inputSchema:{type:'object',properties:{
  request_id:{type:'string',minLength:8,maxLength:128}
 },required:['request_id'],additionalProperties:false}
};
