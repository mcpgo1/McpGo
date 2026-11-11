'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const MAX=64000;
function roots(){
 let configured=[];
 try{configured=JSON.parse(process.env.MCPGO_FILES_ROOTS||'[]')}catch{}
 return [os.homedir(),...configured].filter(x=>typeof x==='string'&&path.isAbsolute(x));
}
function inside(candidate,root){
 const relative=path.relative(root,candidate);
 return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));
}
function allowed(location,{create=false}={}){
 if(typeof location!=='string'||!path.isAbsolute(location)||location.length>2048)
  throw Error('ABSOLUTE_PATH_REQUIRED');
 const absolute=path.resolve(location);
 if(create&&fs.existsSync(absolute)&&fs.lstatSync(absolute).isSymbolicLink())
  throw Error('REFUSE_SYMLINK');
 const target=create?path.dirname(absolute):absolute;
 const real=fs.realpathSync(target);
 if(!roots().some(root=>{
  try{return inside(real,fs.realpathSync(root))}catch{return false}
 }))throw Error('PATH_NOT_ALLOWED');
 if(create)return path.join(real,path.basename(absolute));
 return real;
}
function sha(bytes){return crypto.createHash('sha256').update(bytes).digest('hex')}
function requireText(value){
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>MAX)
  throw Error('INVALID_TEXT_SIZE');
 return value;
}
function checkExpected(file,expected){
 if(fs.existsSync(file)){
  if(!/^[a-f0-9]{64}$/.test(expected||''))throw Error('EXPECTED_SHA256_REQUIRED');
  const current=fs.readFileSync(file);
  if(sha(current)!==expected)throw Error('FILE_CHANGED');
  return current;
 }
 if(expected)throw Error('FILE_NOT_FOUND');
 return null;
}
function atomic(file,bytes){
 const temporary=file+'.mcpgo-'+crypto.randomBytes(8).toString('hex');
 try{
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  // On Windows, renameSync can atomically replace an existing destination on
  // normal NTFS volumes. Source and target share the same parent folder.
  fs.renameSync(temporary,file);
 }finally{try{fs.unlinkSync(temporary)}catch(e){if(e.code!=='ENOENT')throw e}}
}
const schemas=[
 {name:'files_list',description:'List a directory under your home directory (max 200 entries).',
  inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
 {name:'files_read',description:'Read up to 64 KB of a UTF-8 file and return its SHA256 for safe edits.',
  inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
 {name:'files_write',description:'Create or replace a UTF-8 file atomically. Existing files REQUIRE expected_sha256 from files_read.',
  inputSchema:{type:'object',properties:{path:{type:'string'},text:{type:'string'},
   expected_sha256:{type:'string'}},required:['path','text'],additionalProperties:false}},
 {name:'files_edit',description:'Replace one exact UTF-8 span. Existing file requires expected_sha256 to prevent lost updates.',
  inputSchema:{type:'object',properties:{path:{type:'string'},old:{type:'string'},
   replacement:{type:'string'},expected_sha256:{type:'string'}},
   required:['path','old','replacement','expected_sha256'],additionalProperties:false}},
 {name:'files_search',description:'Search text in files under a directory; bounded at 1,000 files / 4 levels.',
  inputSchema:{type:'object',properties:{path:{type:'string'},needle:{type:'string'}},
   required:['path','needle'],additionalProperties:false}}
];
function call(name,args={}){
 switch(name){
  case 'files_list':{
   const dir=allowed(args.path);
   if(!fs.statSync(dir).isDirectory())throw Error('NOT_A_DIRECTORY');
   const names=fs.readdirSync(dir,{withFileTypes:true}).slice(0,200);
   return {path:args.path,entries:names.map(x=>({name:x.name,type:x.isDirectory()?'dir':
    x.isFile()?'file':'other'})),truncated:fs.readdirSync(dir).length>200};
  }
  case 'files_read':{
   const file=allowed(args.path),stat=fs.statSync(file);
   if(!stat.isFile())throw Error('NOT_A_FILE');
   if(stat.size>MAX)throw Error('FILE_TOO_LARGE; use terminal tools for streaming');
   const buf=fs.readFileSync(file);
   if(buf.includes(0))throw Error('BINARY_FILE');
   return {path:args.path,text:buf.toString('utf8'),sha256:sha(buf),bytes:buf.length};
  }
  case 'files_write':{
   const file=allowed(args.path,{create:true});
   const previous=checkExpected(file,args.expected_sha256);
   const text=requireText(args.text);
   if(previous?.includes(0))throw Error('BINARY_FILE');
   atomic(file,Buffer.from(text,'utf8'));
   return {path:args.path,sha256:sha(Buffer.from(text,'utf8')),bytes:Buffer.byteLength(text)};
  }
  case 'files_edit':{
   const file=allowed(args.path);
   const previous=checkExpected(file,args.expected_sha256);
   if(previous===null||previous.length>MAX||previous.includes(0))throw Error('INVALID_FILE');
   const old=requireText(args.old),replacement=requireText(args.replacement);
   if(!old)throw Error('EMPTY_SEARCH');
   const text=previous.toString('utf8'),index=text.indexOf(old);
   if(index<0||text.indexOf(old,index+1)>=0)throw Error('SEARCH_NOT_UNIQUE');
   const result=Buffer.from(text.slice(0,index)+replacement+text.slice(index+old.length),'utf8');
   if(result.length>MAX)throw Error('RESULT_TOO_LARGE');
   atomic(file,result);
   return {sha256:sha(result),bytes:result.length};
  }
  case 'files_search':{
   const root=allowed(args.path),needle=requireText(args.needle);
   if(!needle||needle.length>120)throw Error('INVALID_SEARCH_TERM');
   const results=[],stack=[[root,0]];let visited=0;
   while(stack.length&&visited<1000&&results.length<60){
    const [dir,depth]=stack.pop();
    if(depth>4)continue;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
     if(visited++>=1000)break;
     const file=path.join(dir,entry.name);
     if(entry.isSymbolicLink())continue;
     if(entry.isDirectory()&&depth<4)stack.push([file,depth+1]);
     else if(entry.isFile()){
      try{
       if(fs.statSync(file).size>MAX)continue;
       const content=fs.readFileSync(file,'utf8');
       const index=content.toLowerCase().indexOf(needle.toLowerCase());
       if(index>=0)results.push({file,excerpt:content.slice(Math.max(0,index-45),index+needle.length+80)});
      }catch{}
     }
     if(results.length>=60)break;
    }
   }
   return {matches:results,visited,truncated:visited>=1000||results.length>=60};
  }
  default:throw Error('UNKNOWN_FILES_TOOL');
 }
}
module.exports={schemas,call,allowed,sha};
