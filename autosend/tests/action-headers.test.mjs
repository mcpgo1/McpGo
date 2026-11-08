import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalMcp} from '../cdp-delivery.mjs';

test('AutoSend sends durable action and exact URL guards with its click request',async()=>{
 const seen=[];
 const fetcher=async(url,request)=>{
  seen.push({url,headers:request.headers,body:JSON.parse(request.body)});
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,
   result:{content:[{type:'text',text:'clicked'}]}}),
   {status:200,headers:{'content-type':'application/json','mcp-session-id':'fake-session'}});
 };
 const client=new LocalMcp('http://127.0.0.1:8940/mcp',fetcher);
 const actionId='autosend:00000000-0000-4000-8000-000000000001';
 const chatUrl='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
 const result=await client.tool('browser_click',{target:'[data-testid="send-button"]'},
  {actionId,expectedUrl:chatUrl});
 assert.equal(result,'clicked');
 assert.equal(seen[0].headers['x-mcpgo-action-id'],actionId);
 assert.equal(seen[0].headers['x-mcpgo-expected-url'],chatUrl);
 assert.equal(seen[0].body.params.name,'browser_click');
});
test('read-only calls have no write receipt headers',async()=>{
 let headers=null;
 const fetcher=async(_url,request)=>{
  headers=request.headers;
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{
   content:[{type:'text',text:'read'}]}}),{status:200});
 };
 const client=new LocalMcp('http://127.0.0.1:8940/mcp',fetcher);
 await client.tool('browser_tabs',{action:'list'});
 assert.equal(headers['x-mcpgo-action-id'],undefined);
 assert.equal(headers['x-mcpgo-expected-url'],undefined);
});
