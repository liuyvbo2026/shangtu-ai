import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApiSettings} from '../../backend/integration/api-settings.mjs';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {hash} from '../../backend/core.mjs';
import {fixturePNG,settings} from './fixtures.mjs';
import {fixtureOutput,fixtureResponse} from './mimo-fixtures.mjs';
import {MODEL} from '../../backend/integration/planning.mjs';
const oldText='sk-SYNTHETIC_OLD_TEXT_ONLY',newText='sk-SYNTHETIC_NEW_TEXT_ONLY',newImage='SYNTHETIC_NEW_IMAGE_ONLY';
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-api-settings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const patch=(s,p)=>s.save({revision:s.view().revision,...p});
test('private atomic settings preserve blank fields, clear overrides fallback, and survive reload without exposing keys',t=>{
 const root=fixture(t),s=createApiSettings({root,fallback:{text:oldText,image:newImage}});
 assert.equal(s.view().providers.text.configured,true);assert.ok(!JSON.stringify(s.view()).includes(oldText));
 patch(s,{text:{key:newText},image:{key:''}});assert.equal(s.key('text'),newText);assert.equal(s.key('image'),newImage);
 const file=path.join(root,'.private/api-settings.json');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.readdirSync(path.dirname(file)).length,1);
 const restored=createApiSettings({root,fallback:{text:oldText,image:newImage}});assert.equal(restored.key('text'),newText);
 patch(restored,{text:{clear:true}});const cleared=createApiSettings({root,fallback:{text:oldText}});assert.equal(cleared.key('text'),'');assert.equal(cleared.view().providers.text.configured,false);
});
test('invalid keys, mixed invalid save and stale tabs never partially replace credentials',t=>{
 const root=fixture(t),s=createApiSettings({root,fallback:{text:oldText}}),v=s.view().revision;
 for(const text of ['bad','tp-SYNTHETIC_TOKEN_PLAN',oldText+'\r\nX: header'])assert.throws(()=>patch(s,{text:{key:text},image:{key:newImage}}),e=>e.code==='INVALID_API_KEY'&&!e.message.includes(text));
 assert.equal(s.key('text'),oldText);assert.equal(s.key('image'),'');
 assert.throws(()=>patch(s,{image:{key:newImage,clear:true}}));assert.throws(()=>patch(s,{budgetCny:999}));
 patch(s,{image:{key:newImage}});assert.throws(()=>s.save({revision:v,text:{key:newText}}),e=>e.code==='SETTINGS_CONFLICT');assert.equal(s.key('text'),oldText);
});
test('unsafe files, links and directories are rejected without leaking credentials',t=>{
 const root=fixture(t),s=createApiSettings({root});patch(s,{text:{key:newText}});const file=path.join(root,'.private/api-settings.json');
 fs.chmodSync(file,0o644);assert.throws(()=>createApiSettings({root}),e=>e.code==='API_SETTINGS_STORAGE'&&!e.message.includes(newText));fs.chmodSync(file,0o600);
 fs.renameSync(file,path.join(root,'outside'));fs.symlinkSync(path.join(root,'outside'),file);assert.throws(()=>createApiSettings({root}));assert.throws(()=>patch(s,{text:{key:oldText}}));
});
async function harness(t,{empty=false,delay=0,textGate=null}={}){
 const root=fixture(t),s=createApiSettings({root,fallback:empty?{}:{text:oldText,image:'SYNTHETIC_OLD_IMAGE_ONLY'}}),bytes=fixturePNG('API SETTINGS TEST ONLY',32,32),calls=[];
 const config={modelCallsPaused:false,planningMode:'rules-v2',accountConfirmed:true,budgetId:'settings-test',budgetCny:5,reservePerImageCny:.12,priceEvidence:'SYNTHETIC',authorizationEvidence:'SYNTHETIC',authorizedReferenceHashes:[hash(bytes)],mimo:{model:'mimo-v2.6-flash',billing:'pay-as-you-go',accountConfirmed:true,authorizationEvidence:'SYNTHETIC',authorizedReferenceHashes:[hash(bytes)]}};
 const runtime=createRuntime({dataDir:path.join(root,'.private/data'),config,apiSettings:s,recognizeText:null,
 mimoTransport:async(url,options)=>{calls.push({kind:'text',key:options.headers['api-key']});if(textGate)await textGate;if(delay)await new Promise(r=>setTimeout(r,delay));const body=JSON.parse(options.body),data=JSON.parse(body.messages[1].content.at(-1).text);return fixtureResponse(fixtureOutput(data));},
 imageTransport:async(url,options)=>{calls.push({kind:'image',key:options.headers.Authorization});if(delay)await new Promise(r=>setTimeout(r,delay));const b=JSON.parse(options.body),[w,h]=b.size.split('x').map(Number);return new Response(JSON.stringify({model:MODEL,data:[{b64_json:fixturePNG('TEST ONLY',w,h).toString('base64')}],usage:{generated_images:1}}),{headers:{'Content-Type':'application/json'}});}});
 const server=http.createServer(runtime.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await runtime.close();});
 const url=`http://127.0.0.1:${server.address().port}/api/backend-v1`;
 const api=async(p,body,headers={})=>{const response=await fetch(url+p,{method:body?'PUT':'GET',headers:{'Content-Type':'application/json','X-Backend-Client':'local-development',...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 let p=runtime.store.createProduct({name:'settings fixture',facts:{confirmed:[],unknowns:[],userInput:{version:1,text:'测试商品外观',source:{kind:'user-provided'}}}});const asset=runtime.store.putAsset(bytes,{kind:'original',name:'fixture.png',mediaType:'image/png'});p=runtime.store.addReference(p.id,{assetId:asset.id,role:'product'});
 const request={kind:'understand',productId:p.id,productRevision:p.revision,description:'测试商品外观',settings};
 return {root,s,runtime,config,calls,api,request};
}
async function settle(runtime,id){for(let i=0;i<300;i++){const run=runtime.textService.get(id);if(run.state!=='running')return run;await new Promise(r=>setTimeout(r,10));}throw Error('TIMEOUT');}
test('same-origin settings endpoint returns no keys, validates CSRF and changes no budget/template/pause gates',async t=>{
 const h=await harness(t),before=JSON.stringify(h.config);const get=await h.api('/api-settings');assert.equal(get.status,200);assert.ok(!JSON.stringify(get).includes(oldText));
 const body={revision:get.body.revision,text:{key:newText}};
 assert.equal((await h.api('/api-settings',body,{Origin:'https://foreign.example'})).status,403);
 assert.equal((await h.api('/api-settings',body,{'X-Backend-Client':''})).status,403);
 assert.equal((await h.api('/api-settings',body,{'Sec-Fetch-Site':'cross-site'})).status,403);
 const saved=await h.api('/api-settings',body);assert.equal(saved.status,200);assert.ok(!JSON.stringify(saved).includes(newText));assert.equal(JSON.stringify(h.config),before);assert.equal(h.calls.length,0);
 assert.equal(h.runtime.store.get('SELECT count(*) AS n FROM provider_calls').n,0);assert.equal(h.runtime.store.get('SELECT count(*) AS n FROM text_calls').n,0);
});
test('running text work blocks replacement; next real adapter request uses rotated key and clears disable it',async t=>{
 let release;const textGate=new Promise(r=>{release=r;});
 const h=await harness(t,{textGate}),r=h.runtime.textService.submit(h.request,'settings-first');
 try{const busy=await h.api('/api-settings',{revision:h.s.view().revision,text:{key:newText}});assert.equal(busy.status,409);assert.equal(busy.body.error.code,'SETTINGS_BUSY');assert.equal(h.s.key('text'),oldText);}finally{release();}
 assert.equal((await settle(h.runtime,r.run.id)).state,'succeeded');
 const saved=await h.api('/api-settings',{revision:h.s.view().revision,text:{key:newText}});assert.equal(saved.status,200);
 const second=h.runtime.textService.submit(h.request,'settings-second');assert.equal((await settle(h.runtime,second.run.id)).state,'succeeded');
 assert.deepEqual(h.calls.map(c=>c.key),[oldText,newText]);
 assert.ok(!JSON.stringify(h.runtime.store.all('SELECT * FROM text_calls')).includes(newText));
 await h.api('/api-settings',{revision:h.s.view().revision,text:{clear:true}});assert.equal(h.runtime.status().text.ready,false);assert.throws(()=>h.runtime.textService.submit(h.request,'settings-third'),e=>e.code==='MIMO_NOT_READY');
});
test('first image key starts idle executor; image requests use new credential and existing queued work blocks changes',async t=>{
 const h=await harness(t,{empty:true,delay:100});assert.equal(h.runtime.executor,null);
 const saved=await h.api('/api-settings',{revision:h.s.view().revision,image:{key:newImage}});assert.equal(saved.status,200);assert.ok(h.runtime.executor);assert.equal(h.calls.length,0);
 // Submit via the same production route, with a deterministic rules plan and injected image transport.
 const server=await new Promise(r=>{const s=http.createServer(h.runtime.handler);s.listen(0,'127.0.0.1',()=>r(s));});t.after(()=>new Promise(r=>server.close(r)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/backend-v1/kits`,{method:'POST',headers:{'Content-Type':'application/json','X-Backend-Client':'local-development','Idempotency-Key':'settings-kit'},body:JSON.stringify({productId:h.request.productId,productRevision:h.request.productRevision,description:'测试商品外观',settings})});
 const submitted=await response.json();assert.equal(response.status,201,JSON.stringify(submitted));
 assert.equal((await h.api('/api-settings',{revision:h.s.view().revision,image:{clear:true}})).status,409);
 for(let i=0;i<300&&!['succeeded','failed','partial'].includes(h.runtime.store.task(submitted.task.id).state);i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(h.runtime.store.task(submitted.task.id).state,'succeeded');assert.equal(h.calls.length,7);assert.ok(h.calls.every(c=>c.key===`Bearer ${newImage}`));
 assert.ok(!JSON.stringify(h.runtime.store.all('SELECT * FROM provider_calls')).includes(newImage));
 const cleared=await h.api('/api-settings',{revision:h.s.view().revision,image:{clear:true}});assert.equal(cleared.status,200);assert.equal(cleared.body.health.ready,false);
});
