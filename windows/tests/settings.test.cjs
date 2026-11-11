'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SettingsStore}=require('../app/settings.cjs');
const ID='tunnel_'+'a'.repeat(32);
const BROWSER_ID='tunnel_'+'b'.repeat(32);
function cryptoMock(){
 return {
  isAsyncEncryptionAvailable:async()=>true,
  encryptStringAsync:async value=>Buffer.from('cipher:'+Buffer.from(value).toString('base64'),'utf8'),
  decryptStringAsync:async blob=>({result:Buffer.from(blob.toString('utf8').slice(7),'base64').toString('utf8'),
    shouldReEncrypt:false})
 };
}
function fixture(t,safeStorage=cryptoMock()){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-cred-'));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 return {store:new SettingsStore({userData:()=>temp,safeStorage}),file:path.join(temp,'settings.json')};
}
test('stores encrypted tunnel keys, never discloses them in public status',async t=>{
 const {store,file}=fixture(t);
 await store.save({terminal:{id:ID,key:'a-very-secret-key'},browserTunnel:{id:BROWSER_ID,key:'other-password'},
   browser:'msedge',autoStart:true});
 assert.equal(fs.readFileSync(file,'utf8').includes('a-very-secret-key'),false);
 assert.equal(fs.readFileSync(file,'utf8').includes('other-password'),false);
 assert.equal(store.public().terminal.configured,true);
 assert.equal(store.public().browserTunnel.configured,true);
 assert.equal(store.public().browser,'msedge');
 assert.equal(store.public().autoStart,true);
 assert.equal(JSON.stringify(store.public()).includes('ciphertext'),false);
 assert.deepEqual(await store.credential('terminal'),{id:ID,key:'a-very-secret-key'});
 assert.deepEqual(await store.credential('browserTunnel'),{id:BROWSER_ID,key:'other-password'});
});
test('unchanged key and ID keep encrypted value; changing tunnel ID requires key',async t=>{
 const {store}=fixture(t);
 await store.save({terminal:{id:ID,key:'secure-first'}});
 const initial=store.load().terminal.ciphertext;
 await store.save({terminal:{id:ID,key:''}});
 assert.equal(store.load().terminal.ciphertext,initial);
 await assert.rejects(store.save({terminal:{id:BROWSER_ID,key:''}}),/KEY_REQUIRED/);
 assert.equal(store.load().terminal.id,ID);
 await store.save({terminal:{remove:true}});
 assert.equal(store.public().terminal.configured,false);
});
test('settings validation fails closed without overwriting last good state',async t=>{
 const {store}=fixture(t);
 await store.save({browser:'chrome'});
 for(const input of [{browser:'firefox'},{autoStart:'yes'},{terminal:{id:'../bad',key:'123456'}},
  {terminal:{id:ID,key:'bad\nkey'}}]){
  await assert.rejects(store.save(input));
  assert.equal(store.public().browser,'chrome');
 }
});
test('does not store plaintext when OS encryption is unavailable',async t=>{
 const {store,file}=fixture(t,{
  isAsyncEncryptionAvailable:async()=>false,
  encryptStringAsync:async()=>{throw Error('MUST_NOT_ENCRYPT')},
  decryptStringAsync:async()=>{throw Error('MUST_NOT_DECRYPT')}
 });
 await assert.rejects(store.save({terminal:{id:ID,key:'private-secret'}}),/SECURE_STORAGE_UNAVAILABLE/);
 assert.equal(fs.existsSync(file),false);
});
test('rotates encrypted blob only if original is still current',async t=>{
 const safe=cryptoMock(),{store}=fixture(t,safe);
 await store.save({terminal:{id:ID,key:'one-secret'}});
 safe.decryptStringAsync=async()=>({result:'one-secret',shouldReEncrypt:true});
 await store.credential('terminal');
 assert.deepEqual(await store.credential('terminal'),{id:ID,key:'one-secret'});
});
