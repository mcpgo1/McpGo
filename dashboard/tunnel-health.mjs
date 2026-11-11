import fs from 'node:fs';

export async function checkHealthFile(file,{fetchFn=fetch,timeoutMs=2500}={}) {
  let urlString;
  try {
    const stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0)return {health:'unmonitored',reason:'UNSAFE_HEALTH_FILE'};
    urlString=fs.readFileSync(file,'utf8').trim();
  } catch(e) {
    if(e.code==='ENOENT')return {health:'unmonitored',reason:'NO_HEALTH_URL'};
    return {health:'unmonitored',reason:'HEALTH_FILE_UNREADABLE'};
  }
  let url;
  try {url=new URL(urlString)}
  catch{return {health:'unmonitored',reason:'INVALID_HEALTH_URL'}}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||
    !Number.isInteger(Number(url.port))||url.username||url.password||
    !['/',''].includes(url.pathname)||url.search||url.hash)
    return {health:'unmonitored',reason:'UNSAFE_HEALTH_URL'};
  const base='http://127.0.0.1:'+url.port;
  try {
    const live=await fetchFn(base+'/healthz',{signal:AbortSignal.timeout(timeoutMs)});
    if(live.status!==200)return {health:'down',reason:'HEALTHZ_UNAVAILABLE'};
    const ready=await fetchFn(base+'/readyz',{signal:AbortSignal.timeout(timeoutMs)});
    if(ready.status===200)return {health:'ready'};
    if(ready.status===401||ready.status===403)return {health:'auth'};
    // During startup or network failure, the process is live: never restart
    // immediately. The controller provides a lengthy grace period.
    return {health:'starting',reason:'READYZ_NOT_READY'};
  } catch {return {health:'down',reason:'HEALTH_REQUEST_FAILED'}}
}
