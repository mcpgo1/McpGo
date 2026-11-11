'use strict';
// Confined loopback delegation from OneShot MCP to a separate stateful server.
const fs=require('node:fs');
const STATEFUL=new Set(['terminal_create','terminal_send','terminal_read','terminal_interrupt','terminal_close']);
function endpoint(configPath,port=12847){
 const v=JSON.parse(fs.readFileSync(configPath,'utf8'));
 if(!/^mcp\/[a-f0-9]{64}$/.test(v.mcpPath))throw Error('STATEFUL_CONFIG_INVALID');
 return 'http://127.0.0.1:'+port+'/'+v.mcpPath;
}
async function request(config,method,params,port=12847){
 const response=await fetch(endpoint(config,port),{method:'POST',headers:{
   'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('STATEFUL_UNAVAILABLE_'+response.status);
 const value=await response.json();
 if(value.error)throw Error('STATEFUL_RPC_ERROR_'+value.error.code);
 return value.result;
}
async function list(config,port=12847){
 return (await request(config,'tools/list',undefined,port)).tools.filter(t=>STATEFUL.has(t.name));
}
async function call(config,name,args,port=12847){
 if(!STATEFUL.has(name))throw Error('UNSUPPORTED_STATEFUL_TOOL');
 return request(config,'tools/call',{name,arguments:args||{}},port);
}
module.exports={endpoint,request,list,call,STATEFUL};
