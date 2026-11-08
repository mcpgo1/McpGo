import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const path=fileURLToPath(new URL('./hub.py',import.meta.url));
// launchd may not grant interpreter direct access to Desktop. Load the trusted
// local script in the parent process, and execute from a Python -c argument.
const source=fs.readFileSync(path,'utf8');
const script=`__file__=${JSON.stringify(path)}\nimport sys\nsys.argv=[__file__,'serve']\nexec(compile(${JSON.stringify(source)},__file__,'exec'),{'__name__':'__main__','__file__':__file__})`;
const child=spawn(process.env.MCPGO_PYTHON_BIN || '/usr/bin/python3',['-c',script],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:'inherit'});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill(sig));
child.on('exit',(code,sig)=>process.exit(code ?? (sig ? 1 : 0)));
child.on('error',e=>{console.error('Messaging launch failed:',e.message);process.exit(1);});
