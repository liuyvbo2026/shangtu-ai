import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {staticHandler} from '../../backend/integration/static.mjs';

test('MP4 playback supports metadata, seeking, suffix ranges and public asset boundaries',async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'glass-media-')));
 await mkdir(path.join(root,'assets'));
 const bytes=Buffer.from(Array.from({length:256},(_,i)=>i));
 await writeFile(path.join(root,'assets','loop.mp4'),bytes);
 await writeFile(path.join(root,'private.mp4'),bytes);
 const server=http.createServer(staticHandler(root));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const head=await fetch(base+'/assets/loop.mp4',{method:'HEAD'});
 assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'video/mp4');assert.equal(head.headers.get('content-length'),'256');assert.equal((await head.arrayBuffer()).byteLength,0);
 for(const [range,start,end] of [['bytes=0-31',0,31],['bytes=200-',200,255],['bytes=-10',246,255]]){
  const res=await fetch(base+'/assets/loop.mp4',{headers:{Range:range}});
  assert.equal(res.status,206);assert.equal(res.headers.get('content-range'),`bytes ${start}-${end}/256`);assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes.subarray(start,end+1));
 }
 for(const range of ['bytes=256-','bytes=20-10','bytes=-0','bytes=0-2,4-6','invalid']){
  const res=await fetch(base+'/assets/loop.mp4',{headers:{Range:range}});assert.equal(res.status,416);await res.arrayBuffer();
 }
 const denied=await fetch(base+'/private.mp4');assert.equal(denied.status,404);
});
