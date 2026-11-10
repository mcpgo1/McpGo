import {readFileSync,realpathSync,mkdirSync,lstatSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const mcp=fileURLToPath(new URL('../playwright/',import.meta.url)).replace(/\/$/,'');
// Unix-domain socket paths must fit macOS limits, including the generated name.
// The Application Support path is too long for Playwright's bound browser socket.
const socketDir='/private/tmp/mcpgo-playwright-'+process.getuid();
mkdirSync(socketDir,{recursive:true,mode:0o700});
const socketStat=lstatSync(socketDir);
if(!socketStat.isDirectory()||socketStat.isSymbolicLink()||socketStat.uid!==process.getuid()||(socketStat.mode&0o777)!==0o700)
  throw Error('Unsafe Playwright socket directory');
const env={...process.env,TMPDIR:mcp+'/.cache/tmp/',PWTEST_SOCKETS_DIR:socketDir};
const args=[mcp+'/node_modules/@playwright/mcp/cli.js', '--host','127.0.0.1','--port','8931','--cdp-endpoint','chrome','--shared-browser-context','--caps','vision,devtools','--block-service-workers','--no-webmcp','--output-dir',mcp+'/artifacts/shared','--timeout-navigation','45000'];
console.log('Playwright CDP connecting to existing personal Chrome on 127.0.0.1:8931 (shared)');
const child=spawn(process.execPath,args,{cwd:mcp,env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',e=>{console.error('Browser launch failed:',e.code);process.exit(1);});
child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
