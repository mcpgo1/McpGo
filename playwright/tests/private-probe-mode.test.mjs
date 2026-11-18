import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const probe=fileURLToPath(new URL('../probe.mjs',import.meta.url));
async function runProbe({modern=false,explicit=false}={}){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let body='';
    for await (const chunk of req) body+=chunk;
    const message=JSON.parse(body);
    requests.push(message.method);
    const respond=result=>{
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    };
    if(message.method==='notifications/initialized'){
      res.writeHead(202);res.end();return;
    }
    if(message.method==='server/discover'){
      if(modern)respond({supportedVersions:['2026-07-28']});
      else {res.writeHead(404);res.end('No modern proxy');}
      return;
    }
    if(message.method==='initialize'){
      if(modern){res.writeHead(404);res.end('No private backend');}
      else respond({serverInfo:{name:'private-playwright',version:'1.0'},capabilities:{tools:{}}});
      return;
    }
    if(message.method==='tools/list'){
      respond({tools:[{name:'browser_navigate'},{name:'browser_snapshot'},{name:'browser_tabs'}]});return;
    }
    if(message.method==='tools/call'&&message.params?.name==='browser_tabs'){
      respond({content:[{type:'text',text:'### Result\nNo tabs available'}]});return;
    }
    respond({});
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=server.address().port;
  const output=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[probe],{
      env:{...process.env,PLAYWRIGHT_MCP_URL:`http://127.0.0.1:${port}/mcp`,
        PLAYWRIGHT_MCP_VERIFY_TABS:modern?'0':'1',
        PLAYWRIGHT_MCP_PRIVATE_BACKEND:explicit?'1':'0'},
      stdio:['ignore','pipe','pipe']
    });
    let stdout='',stderr='';
    child.stdout.on('data',data=>{stdout+=data.toString()});
    child.stderr.on('data',data=>{stderr+=data.toString()});
    child.on('error',reject);
    child.on('exit',code=>resolve({code,stdout,stderr}));
  });
  await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  return {...output,requests};
}
test('private backend trial uses legacy initialize on arbitrary loopback port when marked private',async()=>{
  const r=await runProbe({explicit:true});
  assert.equal(r.code,0,r.stderr);
  assert.ok(r.requests.includes('initialize'),r.requests.join(', '));
  assert.ok(r.requests.includes('tools/call'));
  assert.ok(!r.requests.includes('server/discover'));
});
test('modern public proxy still uses discover protocol',async()=>{
  const r=await runProbe({modern:true});
  assert.equal(r.code,0,r.stderr);
  assert.deepEqual(r.requests,['server/discover','tools/list']);
});
test('without private selection, nonstandard port mismatches private Playwright protocol',async()=>{
  const r=await runProbe();
  assert.equal(r.code,1);
  assert.deepEqual(r.requests,['server/discover']);
});
