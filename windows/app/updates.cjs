'use strict';
// Unsigned distributions do NOT support unattended installation. This module
// only discovers the next *GitHub-hosted prerelease* and opens its official page
// after an explicit user click. No remote executable or updater code is run.
const OWNER='mcpgo1';
const REPO='McpGo';
const RELEASES_API='https://api.github.com/repos/'+OWNER+'/'+REPO+'/releases?per_page=20';
const VERSION=/^v(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/;
const ASSET=/^McpGo Setup \d+\.\d+\.\d+-preview\.\d+\.exe$/;

function parseVersion(version){
 const value=VERSION.exec('v'+String(version).replace(/^v/,''));
 return value?value.slice(1).map(Number):null;
}
function cmp(left,right){
 for(let i=0;i<4;i++)if(left[i]!==right[i])return left[i]-right[i];
 return 0;
}
function latestWindowsPreview(rows,current){
 const base=parseVersion(current);
 if(!base||!Array.isArray(rows))throw Error('RELEASE_DATA_INVALID');
 const valid=rows.filter(row=>{
  if(!row||!row.prerelease||row.draft)return false;
  const tag=parseVersion(row.tag_name);
  if(!tag||cmp(tag,base)<=0)return false;
  if(row.tag_name!=='v'+tag.slice(0,3).join('.')+'-preview.'+tag[3])return false;
  return Array.isArray(row.assets)&&row.assets.some(asset=>
   typeof asset?.name==='string'&&ASSET.test(asset.name)&&
   asset.name==='McpGo Setup '+row.tag_name.slice(1)+'.exe'&&asset.size>10000000);
 });
 valid.sort((a,b)=>cmp(parseVersion(b.tag_name),parseVersion(a.tag_name)));
 const tag=valid[0]?.tag_name;
 if(!tag)return {current,available:false};
 return {current,available:true,version:tag.slice(1),
  url:'https://github.com/'+OWNER+'/'+REPO+'/releases/tag/'+tag};
}
async function checkUpdates(version,{fetcher=fetch}={}){
 const response=await fetcher(RELEASES_API,{headers:{
  'Accept':'application/vnd.github+json','User-Agent':'McpGo-Desktop'},
  signal:AbortSignal.timeout(8500)});
 if(!response.ok)throw Error('RELEASE_CHECK_HTTP_'+response.status);
 const raw=await response.text();
 if(raw.length>1024*1024)throw Error('RELEASES_RESPONSE_TOO_LARGE');
 return latestWindowsPreview(JSON.parse(raw),version);
}
function safeReleaseUrl(url){
 if(typeof url!=='string')throw Error('INVALID_RELEASE_URL');
 const parsed=new URL(url);
 if(parsed.origin!=='https://github.com'||parsed.username||parsed.password||
   !/^\/mcpgo1\/McpGo\/releases\/tag\/v\d+\.\d+\.\d+-preview\.\d+$/.test(parsed.pathname)||
   parsed.search||parsed.hash)throw Error('UNTRUSTED_RELEASE_URL');
 return parsed.href;
}
module.exports={parseVersion,latestWindowsPreview,checkUpdates,safeReleaseUrl,RELEASES_API};
