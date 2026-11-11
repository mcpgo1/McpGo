'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const p=require('../platform.js');
test('original macOS paths and shell remain compatible',()=>{
 assert.equal(p.dataRoot('darwin',{},'/Users/demo'),'/Users/demo/Library/Application Support/McpGo');
 assert.equal(p.jobRoot('darwin',{},'/Users/demo'),'/Users/demo/Library/Application Support/ChatTerminalHub/OneShotJobs');
 assert.deepEqual(p.commandSpec('echo hello','darwin'),{file:'/bin/zsh',args:['-lc','echo hello']});
});
test('Windows paths are native and respect LOCALAPPDATA',()=>{
 assert.equal(p.dataRoot('win32',{LOCALAPPDATA:'C:\\Users\\demo\\AppData\\Local'},'C:\\Users\\demo'),
 'C:\\Users\\demo\\AppData\\Local\\McpGo');
 assert.equal(p.jobRoot('win32',{MCPGO_JOB_ROOT:'D:\\Work\\jobs'},'C:\\Users\\demo'),'D:\\Work\\jobs');
 assert.equal(p.jobRoot('win32',{LOCALAPPDATA:'C:\\User\\Local'},'C:\\User'),'C:\\User\\Local\\McpGo\\OneShotJobs');
});
test('Windows commands roundtrip Unicode, quotes and metacharacters',()=>{
 const original='Write-Output "Привет & | $(echo hello)"; $x = 2';
 const spec=p.commandSpec(original,'win32');
 assert.equal(spec.file,'powershell.exe');
 const decoded=Buffer.from(spec.args.at(-1),'base64').toString('utf16le');
 assert.match(decoded,/OutputEncoding/);
 assert.ok(decoded.includes('\nWrite-Output '),'PowerShell setup must end with a real newline, not literal backslash+n');
 assert.equal(decoded.includes('\\nWrite-Output'),false);
 assert.ok(decoded.endsWith(original));
 assert.throws(()=>p.commandSpec('a'.repeat(10000),'win32'),/WINDOWS_COMMAND_TOO_LONG/);
});
test('Windows workers inherit OS environment, macOS jobs retain restricted path',()=>{
 const win=p.childEnv('win32',{SystemRoot:'C:\\Windows',PATH:'C:\\bin',ELECTRON_RUN_AS_NODE:'1'},'/tmp');
 assert.equal(win.SystemRoot,'C:\\Windows');
 assert.equal(win.ELECTRON_RUN_AS_NODE,'1');
 const mac=p.childEnv('darwin',{TOKEN:'secret'},'/Users/demo');
 assert.equal(mac.TOKEN,undefined);
 assert.match(mac.PATH,/homebrew/);
});
test('process tree terminator fails closed on invalid PID',()=>{
 assert.equal(p.killTree(0),false);
 assert.equal(p.killTree(-1),false);
});
