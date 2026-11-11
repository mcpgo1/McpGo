'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const files=require('../files_tools.cjs');
test('file operations are bounded and require optimistic concurrency',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-file-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 process.env.MCPGO_FILES_ROOTS=JSON.stringify([dir]);
 const file=path.join(dir,'example.txt');
 const first=files.call('files_write',{path:file,text:'hello world'});
 assert.equal(first.bytes,11);
 const read=files.call('files_read',{path:file});
 assert.equal(read.sha256,first.sha256);
 assert.equal(read.text,'hello world');
 assert.throws(()=>files.call('files_write',{path:file,text:'stale'}),/EXPECTED_SHA256_REQUIRED/);
 assert.throws(()=>files.call('files_write',{path:file,text:'stale',expected_sha256:'0'.repeat(64)}),/FILE_CHANGED/);
 const next=files.call('files_edit',{path:file,old:'world',replacement:'McpGo',expected_sha256:read.sha256});
 assert.notEqual(next.sha256,first.sha256);
 assert.equal(files.call('files_read',{path:file}).text,'hello McpGo');
 assert.throws(()=>files.call('files_edit',{path:file,old:'hello',replacement:'bad',
    expected_sha256:read.sha256}),/FILE_CHANGED/);
 const listing=files.call('files_list',{path:dir});
 assert.equal(listing.entries[0].name,'example.txt');
 assert.equal(files.call('files_search',{path:dir,needle:'McpGo'}).matches.length,1);
});
test('blocks relative, external and symlink output paths',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-safe-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 process.env.MCPGO_FILES_ROOTS=JSON.stringify([dir]);
 assert.throws(()=>files.allowed('./relative'),/ABSOLUTE_PATH_REQUIRED/);
 const outside=path.join(os.tmpdir(),'outside-root-for-test');
 if(!outside.startsWith(os.homedir()))
  assert.throws(()=>files.allowed(outside,{create:true}),/PATH_NOT_ALLOWED|ENOENT/);
 const victim=path.join(dir,'victim.txt'),alias=path.join(dir,'alias.txt');
 fs.writeFileSync(victim,'private');
 fs.symlinkSync(victim,alias);
 assert.throws(()=>files.call('files_write',{path:alias,text:'attack',expected_sha256:files.sha('private')}),/REFUSE_SYMLINK/);
 assert.equal(fs.readFileSync(victim,'utf8'),'private');
});
test('rejects binary, ambiguous edits and too-large content',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-size-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 process.env.MCPGO_FILES_ROOTS=JSON.stringify([dir]);
 const file=path.join(dir,'readme.txt');
 assert.throws(()=>files.call('files_write',{path:file,text:'x'.repeat(64001)}),/INVALID_TEXT_SIZE/);
 const result=files.call('files_write',{path:file,text:'a a a'});
 assert.throws(()=>files.call('files_edit',{path:file,old:'a',replacement:'b',expected_sha256:result.sha256}),/SEARCH_NOT_UNIQUE/);
 fs.writeFileSync(path.join(dir,'binary'),Buffer.from([0,1,2]));
 assert.throws(()=>files.call('files_read',{path:path.join(dir,'binary')}),/BINARY_FILE/);
});
