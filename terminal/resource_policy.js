'use strict';
// Conservative automatic lock classification: only simple, well-known
// mutating CLI commands. Complex shell scripts are NEVER guessed.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const GIT_WRITES=new Set(['add','commit','push','pull','merge','rebase','checkout','switch',
  'reset','clean','cherry-pick','revert','stash','tag','am','apply','restore']);
const DEPLOY={
  npm:new Set(['publish']),
  pnpm:new Set(['publish','deploy']),
  vercel:new Set(['deploy']),
  eas:new Set(['build','submit','update'])
};
function repoRoot(cwd) {
 try {
  let here=fs.realpathSync(cwd);
  while(true) {
   if(fs.existsSync(path.join(here,'.git')))return here;
   const parent=path.dirname(here);
   if(parent===here)return null;
   here=parent;
  }
 }catch{return null}
}
function classifyCommand(command,cwd) {
 if(typeof command!=='string'||typeof cwd!=='string')return null;
 // Anything with shell chaining, substitution or multiple commands is too
 // ambiguous. The caller can explicitly provide a resource_key instead.
 if(/[\n\r;&|$<>]/.test(command))return null;
 const match=command.trim().match(/^(git|npm|pnpm|vercel|eas)\s+([a-z][a-z-]*)\b/);
 if(!match)return null;
 const [_,bin,verb]=match;
 const kind=bin==='git'&&GIT_WRITES.has(verb)?'git':
   DEPLOY[bin]?.has(verb)?(verb==='publish'?'release':'deploy'):null;
 if(!kind)return null;
 const root=repoRoot(cwd);
 if(!root)return null;
 return kind+':'+crypto.createHash('sha256').update(root).digest('hex').slice(0,24);
}
module.exports={classifyCommand,repoRoot};
