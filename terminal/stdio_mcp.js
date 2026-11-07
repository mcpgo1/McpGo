#!/usr/bin/env node
'use strict';
// Standard local MCP stdio adapter. Shares the persistent server across chat clients.
// All secrets stay on this Mac; never print config.json to stdout.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const conf=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
const route='/'+conf.mcpPath;
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
function post(request){
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(request);
    const r=http.request({host:'127.0.0.1',port:12847,path:route,method:'POST',headers:{
      'Content-Type':'application/json','Accept':'application/json, text/event-stream',
      'Content-Length':Buffer.byteLength(data),'Origin':''
    }},res=>{
      const chunks=[];
      res.on('data',v=>chunks.push(v));
      res.on('end',()=>{
        if(res.statusCode===202)return resolve(null);
        const raw=Buffer.concat(chunks).toString('utf8');
        try{resolve(JSON.parse(raw));}catch(e){reject(Error('Invalid MCP response'));}
      });
    });
    r.setTimeout(5000,()=>r.destroy(Error('Local service did not respond')));
    r.on('error',reject);r.end(data);
  });
}
rl.on('line',async line=>{
  let request;
  try{
    request=JSON.parse(line);
    const response=await post(request);
    if(response!==null)process.stdout.write(JSON.stringify(response)+'\n');
  }catch(err){
    if(request&&request.id!==undefined){
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Local ChatTerminalHub unavailable: '+err.message}})+'\n');
    }
  }
});
