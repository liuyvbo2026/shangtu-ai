import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),pending=new Map();
const cacheRoot=fileURLToPath(new URL('../../.private/native-tools/',import.meta.url));
// The toolchain is identical across isolated stores. Compile each source once,
// from an immutable snapshot, then atomically install into the requested store.
// A process lock prevents simultaneous cold Swift builds exhausting resources.
export async function prepareNative(source,binary){
 if(fs.existsSync(binary))return;
 const bytes=fs.readFileSync(source),digest=createHash('sha256').update(bytes).digest('hex');
 const key=process.platform+'-'+process.arch+'-'+digest,cache=path.join(cacheRoot,key),ready=path.join(cache,'tool');
 let work=pending.get(key);
 if(!work){work=build();pending.set(key,work);work.finally(()=>pending.delete(key)).catch(()=>{});}
 await work;
 fs.mkdirSync(path.dirname(binary),{recursive:true,mode:0o700});
 const temporary=binary+'.'+randomUUID();try{fs.copyFileSync(ready,temporary);fs.chmodSync(temporary,0o700);fs.renameSync(temporary,binary);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 async function build(){
  fs.mkdirSync(cacheRoot,{recursive:true,mode:0o700});if(fs.existsSync(ready))return;
  const lock=path.join(cacheRoot,'.compile-lock'),token=randomUUID(),deadline=Date.now()+180000;
  while(true){
   try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});break;}
   catch(e){if(e.code!=='EEXIST')throw e;}
   if(fs.existsSync(ready))return;
   try{const owner=JSON.parse(fs.readFileSync(lock));if(Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH'&&JSON.parse(fs.readFileSync(lock)).token===owner.token){fs.unlinkSync(lock);continue;}}}}catch{}
   if(Date.now()>deadline)throw Error('NATIVE_BUILD_BUSY');await new Promise(r=>setTimeout(r,100));
  }
  try{
   if(fs.existsSync(ready))return;
   fs.mkdirSync(cache,{recursive:true,mode:0o700});const snapshot=path.join(cache,'source.swift'),temporary=path.join(cache,'tool-'+token);
   fs.writeFileSync(snapshot,bytes,{mode:0o600});
   try{await run('/usr/bin/xcrun',['swiftc','-module-cache-path',path.join(cacheRoot,'modules'),snapshot,'-o',temporary],{timeout:90000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,TMPDIR:cacheRoot}});fs.chmodSync(temporary,0o700);fs.renameSync(temporary,ready);}
   finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }finally{try{if(JSON.parse(fs.readFileSync(lock)).token===token)fs.unlinkSync(lock);}catch{}}
 }
}
