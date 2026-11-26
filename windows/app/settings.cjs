'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {assertTunnelId}=require('./runtime.cjs');
class SettingsStore {
 constructor({userData,safeStorage}) {
  this.userData=userData;
  this.safeStorage=safeStorage;
  this.writeTail=Promise.resolve();
 }
 file(){return path.join(this.userData(),'settings.json')}
 load(){
  const file=this.file();
  try{
   if(fs.lstatSync(file).isSymbolicLink())throw Error('UNSAFE_SETTINGS_LINK');
   return JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(e){if(e.code==='ENOENT')return {browser:'chrome',autoStart:false};throw e}
 }
 write(value){
  const file=this.file(),temporary=file+'.tmp-'+process.pid;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('UNSAFE_SETTINGS_LINK');
  try{
   fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
   fs.renameSync(temporary,file);
  }finally{try{fs.unlinkSync(temporary)}catch{}}
 }
 public(){
  const c=this.load();
  return {browser:c.browser==='msedge'?'msedge':'chrome',autoStart:!!c.autoStart,
   terminal:{id:c.terminal?.id||'',configured:!!c.terminal?.ciphertext},
   browserTunnel:{id:c.browserTunnel?.id||'',configured:!!c.browserTunnel?.ciphertext},
   playwrightExtension:{configured:!!c.playwrightExtension?.ciphertext}};
 }
 async cryptoReady(){
  if(!await this.safeStorage.isAsyncEncryptionAvailable())
   throw Error('SECURE_STORAGE_UNAVAILABLE');
 }
 async credential(field){
  const v=this.load()[field];
  if(!v?.id||!v?.ciphertext)return null;
  await this.cryptoReady();
  const decrypted=await this.safeStorage.decryptStringAsync(Buffer.from(v.ciphertext,'base64'));
  if(!decrypted||typeof decrypted.result!=='string')throw Error('INVALID_ENCRYPTED_CREDENTIAL');
  if(decrypted.shouldReEncrypt){
   const replacement=await this.safeStorage.encryptStringAsync(decrypted.result);
   // A concurrent UI save might have replaced this key: never overwrite it.
   await this.serial(async()=>{
    const current=this.load();
    if(current[field]?.ciphertext===v.ciphertext){
     current[field].ciphertext=replacement.toString('base64');
     this.write(current);
    }
   });
  }
  return {id:assertTunnelId(v.id),key:decrypted.result};
 }

 async extensionToken(){
  const value=this.load().playwrightExtension;
  if(!value?.ciphertext)return null;
  await this.cryptoReady();
  let decrypted;
  try {decrypted=await this.safeStorage.decryptStringAsync(Buffer.from(value.ciphertext,'base64'))}
  catch {throw Error('EXTENSION_CONFIG_UNREADABLE')}
  const token=decrypted?.result;
  if(typeof token!=='string'||!/^\S{16,2048}$/.test(token)||/[\x00-\x1f]/.test(token))
   throw Error('INVALID_ENCRYPTED_EXTENSION_TOKEN');
  if(decrypted.shouldReEncrypt){
   const replacement=await this.safeStorage.encryptStringAsync(token);
   await this.serial(async()=>{
    const current=this.load();
    if(current.playwrightExtension?.ciphertext===value.ciphertext){
     current.playwrightExtension.ciphertext=replacement.toString('base64');
     this.write(current);
    }
   });
  }
  return {token};
 }
 serial(fn){
  const action=this.writeTail.then(fn);
  this.writeTail=action.catch(()=>{});
  return action;
 }
 save(input){return this.serial(()=>this.saveNow(input))}
 async saveNow(input){
  if(!input||typeof input!=='object')throw Error('INVALID_SETTINGS');
  const c=this.load();
  if(input.browser!==undefined){
   if(!['chrome','msedge'].includes(input.browser))throw Error('INVALID_BROWSER');
   c.browser=input.browser;
  }
  if(input.autoStart!==undefined){
   if(typeof input.autoStart!=='boolean')throw Error('INVALID_AUTOSTART');
   c.autoStart=input.autoStart;
  }
  for(const field of ['terminal','browserTunnel']){
   const v=input[field];
   if(v===undefined)continue;
   if(!v||typeof v!=='object')throw Error('INVALID_TUNNEL_SETTINGS');
   if(v.remove===true){delete c[field];continue}
   const id=assertTunnelId(typeof v.id==='string'?v.id.trim():v.id);
   const updated=typeof v.key==='string'&&v.key.length>0;
   if(id!==c[field]?.id&&!updated)throw Error('KEY_REQUIRED_FOR_CHANGED_TUNNEL');
   if(updated){
    if(v.key.length<6||v.key.length>8192||/[\r\n]/.test(v.key))throw Error('INVALID_TUNNEL_KEY');
    await this.cryptoReady();
    c[field]={id,ciphertext:(await this.safeStorage.encryptStringAsync(v.key)).toString('base64')};
   }
  }
  if(input.playwrightExtension!==undefined){
   const v=input.playwrightExtension;
   if(!v||typeof v!=='object'||Array.isArray(v))throw Error('INVALID_EXTENSION_SETTINGS');
   if(v.remove===true)delete c.playwrightExtension;
   else if(v.token!==undefined&&v.token!==''){
    if(typeof v.token!=='string')throw Error('INVALID_EXTENSION_TOKEN');
    const token=v.token.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/,'');
    if(!/^\S{16,2048}$/.test(token)||/[\x00-\x1f]/.test(token))
     throw Error('INVALID_EXTENSION_TOKEN');
    await this.cryptoReady();
    c.playwrightExtension={ciphertext:(await this.safeStorage.encryptStringAsync(token)).toString('base64')};
   }
  }
  this.write(c);
  return this.public();
 }
}
// Auto-start is handled by Electron, and does not change an MCP runtime.
function runtimeConfigChanged(before,after){
 const comparable=c=>JSON.stringify([c.browser||'chrome',c.terminal||null,c.browserTunnel||null,c.playwrightExtension||null]);
 return comparable(before)!==comparable(after);
}
module.exports={SettingsStore,runtimeConfigChanged};
