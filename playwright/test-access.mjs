import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
for(const name of ['start.sh','start-tunnel.sh','configure-tunnel.sh','restricted-proxy.mjs']) {
 const file=path.join(root,name);
 try{console.log('accessible',name,fs.readFileSync(file).length)}
 catch(e){console.error('access_failed',name,e.code);process.exitCode=1;}
}
