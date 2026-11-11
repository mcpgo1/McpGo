import {readFileSync,statSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const mcp=fileURLToPath(new URL('../playwright/', import.meta.url));
const dataDir=path.join(os.homedir(),'Library','Application Support','McpGo','playwright');
function secret(name) {
 const file=path.join(dataDir,name);
 if((statSync(file).mode&0o777)!==0o600)throw Error('Unsafe permissions for '+name);
 const value=readFileSync(file,'utf8').trim();
 if(!value)throw Error('Missing '+name);
 return value;
}
let id,key;
try {
 id=secret('tunnel.id');
 try {
   key=execFileSync('/usr/bin/security', ['find-generic-password','-a',os.userInfo().username,
     '-s','com.mcphub.playwright.openai.tunnel','-w'],
     {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:7000}).trim();
 } catch { key=secret('tunnel.key'); }
 if(!key)throw Error('Playwright API key is unavailable');
} catch(e){console.error('Tunnel prerequisites failed:',e.message);process.exit(2);}
const env={...process.env,CONTROL_PLANE_API_KEY:key,HOME:os.homedir(),TMPDIR:mcp+'/.cache/tmp/'};
const run=(exe,args)=>new Promise(resolve=>{
 const child=spawn(exe,args,{cwd:mcp,env:{...env,PLAYWRIGHT_MCP_URL:'http://127.0.0.1:8940/mcp',PLAYWRIGHT_MCP_REJECT_UNSAFE:'1'},stdio:'inherit'});
 child.on('error',e=>{console.error('Tunnel prerequisite failed:',e.code);resolve(false);});
 child.on('exit',code=>resolve(code===0));
});
let mcpReady=false;
for (let attempt=0;attempt<12;attempt++) {
  if (await run(process.execPath,[mcp+'/probe.mjs'])) {mcpReady=true;break;}
  await new Promise(resolve=>setTimeout(resolve,1500));
}
if(!mcpReady) {console.error('MCP backend not ready after retries');process.exit(3);}
process.umask(0o077);
mkdirSync(dataDir,{recursive:true,mode:0o700});
const config=path.join(dataDir,'tunnel-empty-config.yaml');
writeFileSync(config,'{}\n',{mode:0o600});
const healthFile=path.join(dataDir,'tunnel-health.url');
try{unlinkSync(healthFile)}catch(e){if(e.code!=='ENOENT')throw e}
const args=['run','--config',config,'--control-plane.tunnel-id',id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--mcp.server-url','http://127.0.0.1:8940/mcp','--health.listen-addr','127.0.0.1:0','--health.url-file',healthFile];
console.log('Starting secure outbound-only Playwright tunnel');
const child=spawn('tunnel-client',args,{cwd:mcp,env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',e=>{console.error('Secure tunnel failed:',e.code);process.exit(1);});
child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
