import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {localCompositor} from '../../backend/integration/local-compose.mjs';
import {localRecognizer} from '../../backend/integration/recognition.mjs';
import {fixturePNG} from './fixtures.mjs';

test('native composition renders exact Chinese and rejects overflow without touching base pixels', {skip:process.platform!=='darwin',timeout:120000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'exact-type-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const base=fixturePNG('synthetic typography background',864,1152),raster={base64:base.toString('base64'),mediaType:'image/png',width:864,height:1152,provenance:'test-only',requestId:null};
 const compose=localCompositor(dir),layers=[{kind:'text',text:'鞋舌处缝制标签',box:[.08,.08,.84,.16],fontSize:44,fontWeight:600,align:'left'}];
 const out=await compose({raster,layers});assert.equal(raster.base64,base.toString('base64'));assert.equal(out.raster.provenance,'test-only');assert.deepEqual(out.layers,layers);
 const rows=await localRecognizer(dir)(Buffer.from(out.raster.base64,'base64'));assert.ok(rows.some(r=>r.text==='鞋舌处缝制标签'),JSON.stringify(rows));
 assert.ok(rows.find(r=>r.text==='鞋舌处缝制标签').box[1]<.25,'top-origin coordinates must not be vertically flipped');
 await assert.rejects(compose({raster,layers:[{...layers[0],box:[.1,.1,.1,.03],text:'不能截断这段过长的文字'}]}),e=>e.code==='COMPOSE_FAILED');
 const colored=await compose({raster,layers:[{...layers[0],color:'#29465B'}]});assert.notEqual(colored.raster.base64,out.raster.base64);assert.ok((await localRecognizer(dir)(Buffer.from(colored.raster.base64,'base64'))).some(r=>r.text==='鞋舌处缝制标签'));
 await assert.rejects(compose({raster,layers:[{...layers[0],color:'invalid'}]}),e=>e.code==='COMPOSE_FAILED');
 assert.equal((await compose({raster,layers:[]})).raster.base64,raster.base64);
});
