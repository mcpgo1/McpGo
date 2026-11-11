import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkHealthFile} from '../tunnel-health.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-health-tests-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
function file(name,value){
 const f=path.join(root,name);fs.writeFileSync(f,value,{mode:0o600});return f;
}
test('checks only loopback health and readiness; unready is not a crash',async()=>{
 const p=file('valid','http://127.0.0.1:47001\n');let urls=[];
 const fetchFn=async u=>{urls.push(u);return {status:u.endsWith('/healthz')?200:503}};
 assert.equal((await checkHealthFile(p,{fetchFn})).health,'starting');
 assert.deepEqual(urls,['http://127.0.0.1:47001/healthz','http://127.0.0.1:47001/readyz']);
 assert.equal((await checkHealthFile(p,{fetchFn:async()=>({status:200})})).health,'ready');
});
test('untrusted URL cannot access outside localhost or leak credentials',async()=>{
 let calls=0;const fake=async()=>{calls++;return {status:200}};
 for(const [i,v] of ['https://example.com','http://127.0.0.1:3000/secret','http://localhost:8080',
   'http://127.0.0.1:8080@evil.com','http://127.0.0.1:8080?q=1',
   'http://127.0.0.1:8080#fragment'].entries())
   assert.equal((await checkHealthFile(file('wrong'+i,v),{fetchFn:fake})).health,'unmonitored',v);
 assert.equal(calls,0);
});
test('missing/untrusted file is never used for recovery health',async()=>{
 assert.equal((await checkHealthFile(path.join(root,'missing'))).health,'unmonitored');
 const bad=file('unsafe','http://127.0.0.1:3000');fs.chmodSync(bad,0o644);
 assert.equal((await checkHealthFile(bad)).health,'unmonitored');
});
test('connection error is down, auth response fails closed',async()=>{
 const p=file('errors','http://127.0.0.1:4000');
 assert.equal((await checkHealthFile(p,{fetchFn:async()=>{throw Error('socket closed')}})).health,'down');
 assert.equal((await checkHealthFile(p,{fetchFn:async u=>({status:u.endsWith('/healthz')?200:403})})).health,'auth');
});
