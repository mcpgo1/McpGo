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
