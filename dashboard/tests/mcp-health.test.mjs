import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeMcp} from '../mcp-health.mjs';
function fakeFetch({listStatus=200,unsafe=false,expired=false}={}){
 let sid='test-session',step=0;
 return async (_url,{body})=>{
   const payload=JSON.parse(body);step++;
   if(payload.method==='initialize')return new Response(JSON.stringify({jsonrpc:'2.0',id:payload.id,
     result:{serverInfo:{name:'Fake'},capabilities:{}}}),{status:200,headers:{'mcp-session-id':sid}});
   if(payload.method==='notifications/initialized')return new Response('',{status:202});
   if(payload.method==='tools/call'){
     return new Response(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{content:[{type:'text',text:'### Result\nTabs'}]}}),{status:200});
   }
   if(payload.method==='tools/list'){
     if(expired)return new Response('Session not found',{status:404});
     return new Response(JSON.stringify({jsonrpc:'2.0',id:payload.id,
       result:{tools:[{name:'browser_tabs'},{name:'browser_snapshot'},...(unsafe?[{name:'browser_run_code_unsafe'}]:[])]}}),
       {status:listStatus});
   }
   throw Error('Unexpected call');
 };
}
test('healthy MCP tools list is accepted',async()=>assert.equal(await probeMcp('http://test.local',fakeFetch()),true));
test('expired MCP session must not look healthy',async()=>await assert.rejects(probeMcp('http://test.local',fakeFetch({expired:true})),/404/));
test('exposed unsafe browser tool makes status unhealthy',async()=>await assert.rejects(probeMcp('http://test.local',fakeFetch({unsafe:true})),/invalid/));

test('background status does not request Chrome debugging consent',async()=>{
 const calls=[];
 const delegate=fakeFetch();
 const fetchWithoutChrome=async(url,options)=>{
   const method=JSON.parse(options.body).method;
   calls.push(method);
   if(method==='tools/call')throw Error('background check must not attach Chrome');
   return delegate(url,options);
 };
 assert.equal(await probeMcp('http://test.local',fetchWithoutChrome,{verifyBrowser:false}),true);
 assert.deepEqual(calls,['initialize','notifications/initialized','tools/list']);
});
test('background status still rejects expired or unsafe MCP sessions',async()=>{
 await assert.rejects(probeMcp('http://test.local',fakeFetch({expired:true}),{verifyBrowser:false}),/404/);
 await assert.rejects(probeMcp('http://test.local',fakeFetch({unsafe:true}),{verifyBrowser:false}),/invalid/);
});
test('explicit browser diagnostic still reports denied Chrome access',async()=>{
 const delegate=fakeFetch();
 const denied=async(url,options)=>JSON.parse(options.body).method==='tools/call'
   ?new Response(JSON.stringify({result:{isError:true,content:[{type:'text',text:'Access denied'}]}}))
   :delegate(url,options);
 await assert.rejects(probeMcp('http://test.local',denied),/Chrome CDP/);
});
