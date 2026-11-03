import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {staticHandler} from '../../backend/integration/static.mjs';
import {planSubmission,sizeFor,SIZES} from '../../backend/integration/planning.mjs';
import {handlers,fixturePNG,settings} from './fixtures.mjs';
import {recover,freshState} from '../../src/model.js';
import {mergeRemote,projectTask,api} from '../../src/integration-client.js';

async function harness(t,options={}){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-integration-'));
 const runtime=createRuntime({dataDir:dir,testHandlers:handlers(),...options});
 const serve=staticHandler(process.cwd()+'/');
 const server=http.createServer((req,res)=>req.url.startsWith('/api/')?runtime.handler(req,res):serve(req,res));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 async function request(url,method='GET',body,headers={}){
  const response=await fetch(base+'/api/backend-v1'+url,{method,headers:{'X-Backend-Client':'local-development',...(Buffer.isBuffer(body)?{'Content-Type':'image/png'}:body?{'Content-Type':'application/json'}:{}),...headers},body:Buffer.isBuffer(body)?body:body?JSON.stringify(body):undefined});
  return {status:response.status,value:await response.json()};
 }
 return {runtime,request,base};
}
async function product(h){
 let {value:p}=await h.request('/draft-products','POST',{clientId:'single',name:'合成参考商品',facts:{confirmed:[{id:'f1',key:'color',value:'蓝色',source:{kind:'user-confirmed',locator:'test'}}],unknowns:[]}});
 for(let i=0;i<3;i++){
  const {value:a}=await h.request('/assets','POST',fixturePNG(`reference-${i}`,32,32),{'X-Asset-Client-Id':`ref-${i}`});
  const twice=await h.request('/assets','POST',fixturePNG(`reference-${i}`,32,32),{'X-Asset-Client-Id':`ref-${i}`});assert.equal(twice.value.id,a.id);
  ({value:p}=await h.request(`/products/${p.id}/references`,'POST',{assetId:a.id,role:'product'}));
 }
 return p;
}
const submit=(h,p,key='kit')=>h.request('/kits','POST',{productId:p.id,productRevision:p.revision,description:'只验证集成契约，不是模型结果',settings},{'Idempotency-Key':key});
async function until(fn){const end=Date.now()+7000;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');}
const done=(h,id)=>until(()=>{const t=h.runtime.store.task(id);return !['running','queued'].includes(t.state)&&t;});

test('HTTP single product: 3 references, effective snapshot, idempotency, result bytes and version projection',async t=>{
 const h=await harness(t),p=await product(h);
 assert.equal(h.runtime.store.products().length,1);assert.equal(p.references.length,3);
 const first=await submit(h,p);assert.equal(first.status,201,JSON.stringify(first.value));
 const duplicate=await submit(h,p);assert.equal(duplicate.value.task.id,first.value.task.id);assert.equal(duplicate.value.duplicate,true);
 const final=await done(h,first.value.task.id);assert.equal(final.state,'succeeded');assert.equal(final.children.length,7);
 assert.deepEqual(final.input.settings.effectiveSettings,settings);assert.equal(final.input.references.length,3);
 assert.deepEqual(final.input.slots[0].size,{width:864,height:1152});
 h.runtime.store.updateProduct(p.id,{expectedRevision:p.revision,name:'后改名称'});assert.equal(h.runtime.store.task(final.id).input.product.name,'合成参考商品');
 for(const c of final.children){const v=c.result.versions[0],a=h.runtime.store.asset(v.assetId),bytes=Buffer.from(await(await fetch(h.base+`/api/backend-v1/assets/${a.id}/content`)).arrayBuffer());assert.deepEqual(bytes,h.runtime.store.readAsset(a.id));assert.equal(c.attempts[0].receipt.workflow.quality.evidence,'test-only');}
 const state=freshState();state.jobs.push({id:'legacy',kind:'kit',status:'success',createdAt:1,results:[]});mergeRemote(state,[final],[p]);assert.equal(state.jobs.length,2);assert.equal(projectTask(final).results[0].version,1);assert.equal(recover(state).jobs.find(j=>j.id===final.id).status,'success');
});

test('partial failure retries only target and preserves successful result IDs and attempts',async t=>{
 const h=await harness(t,{testHandlers:handlers({failFirst:'selling-1'})}),p=await product(h),s=await submit(h,p),first=await done(h,s.value.task.id);
 assert.equal(first.state,'partial');assert.equal(first.progress.succeeded,6);
 const failed=first.children.find(c=>c.state==='failed'),success=first.children.filter(c=>c.state==='succeeded');
 assert.ok(failed.attempts[0].receipt.workflow.trace.some(node=>node.id==='generate'&&node.status==='failed'));
 const retry=await h.request(`/tasks/${first.id}/retry`,'POST',{expectedRevision:first.revision,childIds:[failed.id]});assert.equal(retry.status,200);
 const final=await done(h,first.id);assert.equal(final.state,'succeeded');assert.equal(final.children.find(c=>c.id===failed.id).attemptCount,2);
 for(const c of success){const same=final.children.find(x=>x.id===c.id);assert.deepEqual(same.result,c.result);assert.equal(same.attemptCount,1);}
});

test('cancel stops scheduling; late processor cannot publish; refresh keeps server task active',async t=>{
 const h=await harness(t,{testHandlers:handlers({delay:120})}),p=await product(h),s=await submit(h,p),id=s.value.task.id;
 await until(()=>h.runtime.store.task(id).progress.succeeded===1&&h.runtime.store.task(id).progress.running===1);
 const before=h.runtime.store.task(id),state=freshState();state.jobs=[projectTask(before)];assert.equal(recover(state).jobs[0].status,'running');
 const result=await h.request(`/tasks/${id}/cancel`,'POST');assert.equal(result.value.state,'canceled');
 await new Promise(r=>setTimeout(r,250));const after=h.runtime.store.task(id);
 assert.equal(after.state,'canceled');assert.equal(after.progress.succeeded,1);assert.equal(after.children[2].attemptCount,0);assert.equal(after.children[1].result,null);assert.ok(projectTask(after).results.every(r=>!r.retryable));
});

test('normal runtime fails closed; unsupported options and arbitrary prepared browser plans rejected',async t=>{
 const h=await harness(t,{testHandlers:null,key:'',config:{}}),p=await product(h);
 assert.equal((await h.request('/health')).value.mode,'NO_REAL_PROVIDER');assert.equal((await submit(h,p)).status,503);
 assert.equal(h.runtime.store.tasks().length,0);
 assert.equal((await h.request('/tasks','POST',{})).status,400);
 const testH=await harness(t),testP=await product(testH);
 for(const changed of [{listing:true},{analysis:true},{layouts:['fake']},{ratio:'2:2'}]){
  const response=await testH.request('/kits','POST',{productId:testP.id,productRevision:testP.revision,description:'test',settings:{...settings,...changed}},{'Idempotency-Key':crypto.randomUUID()});assert.equal(response.status,400);
 }
 assert.equal(testH.runtime.store.tasks().length,0);
});

test('unready message reflects actual missing reference authorization through client API',async t=>{
 const h=await harness(t,{testHandlers:null,key:'synthetic-test-key',config:{accountConfirmed:true,budgetId:'test-message',budgetCny:5,reservePerImageCny:0.12,priceEvidence:'TEST',authorizedReferenceHashes:[],authorizationEvidence:''}});
 const response=await h.request('/kits','POST',{}, {'Idempotency-Key':'readiness-message'});
 assert.equal(response.status,503);assert.match(response.value.error.message,/授权参考图及事实/);
 assert.doesNotMatch(response.value.error.message,/凭证|权限|预算/);
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(response.value),{status:503,headers:{'Content-Type':'application/json'}}));
 await assert.rejects(api('/kits',{method:'POST',body:{}}),e=>e.code==='PROVIDER_NOT_READY'&&e.message===response.value.error.message);
 assert.equal(h.runtime.store.tasks().length,0);
});

test('static allowlist and loopback API reject private/source/foreign requests',async t=>{
 const h=await harness(t);
 for(const route of ['/.private/single-product/store.sqlite','/backend/core.mjs','/package.json','/docs/STATUS.md','/.env','/.git/config','/artifacts/integration-round1/pre-integration-files.json','/src/../backend/core.mjs'])assert.equal((await fetch(h.base+route)).status,404,route);
 assert.equal((await fetch(h.base+'/')).status,200);assert.equal((await fetch(h.base+'/src/app.js')).status,200);
 const response=await fetch(h.base+'/api/backend-v1/products',{headers:{Origin:'https://external.example'}});assert.equal(response.status,403);
});

test('explicit request sizes satisfy official minimum, maximum and ratio for all current controls',()=>{
 for(const resolution of Object.keys(SIZES))for(const ratio of Object.keys(SIZES[resolution])){const {width,height}=sizeFor({resolution,ratio});assert.ok(width*height>=921600&&width*height<=4624220);const [x,y]=ratio.split(':').map(Number);assert.equal(width*y,height*x);}
});

test('all integration tables, snapshots and PNGs survive backend backup and restore in new directory',async t=>{
 const {backup,restore}=await import('../../backend/backup.mjs');
 const {Store}=await import('../../backend/store.mjs');
 const h=await harness(t),p=await product(h),submitted=await submit(h,p);await done(h,submitted.value.task.id);
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-backup-integration-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 await h.runtime.executor.stop();
 const tables=h.runtime.store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
 const rows=Object.fromEntries(tables.map(table=>[table,h.runtime.store.all(`SELECT * FROM ${table}`)]));
 const manifest=backup(h.runtime.store,path.join(base,'backup'));restore(path.join(base,'backup'),path.join(base,'restored'));
 const restored=new Store({dataDir:path.join(base,'restored')});
 try{for(const table of tables)assert.deepEqual(restored.all(`SELECT * FROM ${table}`),rows[table]);for(const a of manifest.assets)assert.deepEqual(restored.readAsset(a.id),h.runtime.store.readAsset(a.id));}finally{restored.close();}
});

const revise=(h,r,key='revision',extra={})=>h.request(`/results/${r.id}/corrections`,'POST',{expectedVersion:r.versions.at(-1).version,instruction:'仅修正可见结构，其他保持。',...extra},{'Idempotency-Key':key});
test('single correction freezes originals, appends one version, keeps sibling results and projects history versions',async t=>{
 const h=await harness(t),p=await product(h),s=await submit(h,p),first=await done(h,s.value.task.id),target=first.children[1].result;
 h.runtime.store.updateProduct(p.id,{expectedRevision:p.revision,name:'later draft'});
 const correction=await revise(h,target);assert.equal(correction.status,201,JSON.stringify(correction.value));
 const duplicate=await revise(h,target);assert.equal(duplicate.value.task.id,correction.value.task.id);
 const final=await done(h,correction.value.task.id);assert.equal(final.state,'succeeded');assert.equal(final.children.length,1);assert.equal(final.children[0].attemptCount,1);
 assert.deepEqual(final.input.product,first.input.product);assert.equal(final.input.references.length,4);assert.equal(final.input.references.at(-1).role,'current');
 const source=h.runtime.store.task(first.id),changed=source.children[1].result;
 assert.equal(changed.versions.length,2);assert.deepEqual(changed.versions[0],target.versions[0]);assert.equal(changed.versions[1].previousVersion,1);assert.equal(changed.versions[1].attemptId,final.children[0].attempts[0].id);
 assert.equal(h.runtime.store.asset(changed.versions[1].assetId).parentId,target.versions[0].assetId);
 for(const c of first.children.filter(c=>c.id!==first.children[1].id))assert.deepEqual(source.children.find(x=>x.id===c.id),c);
 const lateDuplicate=await revise(h,target);assert.equal(lateDuplicate.status,200);assert.equal(h.runtime.store.tasks().length,2);
 const state=freshState();mergeRemote(state,[source,final],[p]);assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].results[1].version,2);assert.equal(state.jobs[0].results[1].versions[0].assetId,`server:${target.versions[0].assetId}`);
 const conflict=await revise(h,target,'different');assert.equal(conflict.status,409);
 const bad=await revise(h,changed,'bad',{sourceAssetId:'foreign'});assert.equal(bad.status,400);
});

test('active correction rejects second key; cancel ignores late image and preserves target and siblings',async t=>{
 const h=await harness(t),p=await product(h),s=await submit(h,p),source=await done(h,s.value.task.id),target=source.children[0].result;
 const original=h.runtime.handlers.generate;let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 h.runtime.handlers.generate=async args=>{entered();await wait;return original(args);};
 const c=await revise(h,target);await started;
 assert.equal((await revise(h,target,'second')).status,409);
 assert.equal((await h.request(`/tasks/${c.value.task.id}/cancel`,'POST')).value.state,'canceled');release();
 await until(()=>h.runtime.executor.running.size===0);await new Promise(r=>setTimeout(r,60));
 assert.deepEqual(h.runtime.store.task(source.id),source);assert.equal(h.runtime.store.task(c.value.task.id).children[0].result,null);
});

test('failed correction has no automatic retry and never replaces old result',async t=>{
 const h=await harness(t),p=await product(h),s=await submit(h,p),source=await done(h,s.value.task.id),target=source.children[0].result;
 const {WorkflowError}=await import('../../src/workflow/value.js');h.runtime.handlers.generate=async()=>{throw new WorkflowError('REJECTED');};
 const c=await revise(h,target),final=await done(h,c.value.task.id);assert.equal(final.state,'failed');assert.equal(final.policy.maxAttempts,1);assert.equal(final.children[0].attemptCount,1);assert.deepEqual(h.runtime.store.task(source.id),source);
});

test('source version conflict during execution prevents publication and preserves current version',async t=>{
 const h=await harness(t),p=await product(h),s=await submit(h,p),source=await done(h,s.value.task.id),target=source.children[0].result;
 const original=h.runtime.handlers.generate;let release,entered;const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 h.runtime.handlers.generate=async args=>{entered();await waiting;return original(args);};
 const c=await revise(h,target);await started;
 const a=h.runtime.store.putAsset(fixturePNG('manual newer',864,1152),{kind:'derived',parentId:target.versions[0].assetId,name:'newer.png',mediaType:'image/png'});
 h.runtime.store.appendVersion(target.id,{assetId:a.id,expectedVersion:1});release();
 const final=await done(h,c.value.task.id);assert.equal(final.state,'failed');assert.equal(h.runtime.store.result(target.id).versions.length,2);assert.equal(h.runtime.store.result(target.id).versions[1].assetId,a.id);
});

test('idempotency survives missing integration receipt after durable correction enqueue',async t=>{
 const h=await harness(t),p=await product(h),s=await submit(h,p),source=await done(h,s.value.task.id),target=source.children[0].result;
 const c=await revise(h,target);await done(h,c.value.task.id);
 h.runtime.store.run('DELETE FROM integration_submissions WHERE key=?','revision');
 const retry=await revise(h,target);assert.equal(retry.status,200);assert.equal(retry.value.task.id,c.value.task.id);assert.equal(h.runtime.store.tasks().length,2);
});

test('real adapter correction sends original references plus pinned current, enforces cumulative budget and unknown-call gate',async t=>{
 const {createProviderHandlers,ledgerState}=await import('../../backend/integration/provider.mjs');const {MODEL}=await import('../../backend/integration/planning.mjs');
 const config={modelCallsPaused:false,planningMode:'rules-v2',accountConfirmed:true,budgetId:'revision-budget',budgetCny:0.96,reservePerImageCny:0.12,priceEvidence:'test price',authorizationEvidence:'synthetic',authorizedReferenceHashes:['0'.repeat(64)]};
 const h=await harness(t,{testHandlers:null,key:'test-secret',config}),p=await product(h);config.authorizedReferenceHashes=p.references.map(r=>h.runtime.store.asset(r.assetId).sha256);
 const payloads=[];h.runtime.handlers.generate=createProviderHandlers({store:h.runtime.store,config,key:'test-secret',transport:async(url,options)=>{
  const payload=JSON.parse(options.body);payloads.push(payload);return new Response(JSON.stringify({model:MODEL,data:[{b64_json:fixturePNG(`transport-${payloads.length}`,864,1152).toString('base64')}],usage:{generated_images:1,input_images:payload.image.length}}),{headers:{'x-request-id':`test-call-${payloads.length}`}});
 }}).generate;
 const s=await submit(h,p),source=await done(h,s.value.task.id);assert.equal(source.state,'succeeded');assert.equal(payloads.length,7);
 const correction=await revise(h,source.children[0].result);assert.equal(correction.status,201);assert.equal((await done(h,correction.value.task.id)).state,'succeeded');
 assert.equal(payloads.length,8);assert.equal(payloads[7].image.length,4);assert.ok(payloads[7].prompt.includes('数量、位置、连接关系必须一致'));assert.ok(payloads[7].prompt.includes('current'));
 const rows=h.runtime.store.all('SELECT * FROM provider_calls');assert.ok(!JSON.stringify(rows).includes('test-secret'));assert.ok(!JSON.stringify(rows).includes('base64,'));assert.ok(Math.abs(ledgerState(h.runtime.store,config).reservedCny-.96)<1e-8);
 assert.equal((await revise(h,source.children[1].result,'over-budget')).status,409);assert.equal(payloads.length,8);
 h.runtime.store.run("UPDATE provider_calls SET state='unknown' WHERE id=?",rows[0].id);
 assert.equal((await revise(h,source.children[1].result,'unknown')).status,503);assert.equal(payloads.length,8);
});

test('version navigation preserves immutable history while default preview follows newest result',async()=>{
 const {previewContext}=await import('../../src/model.js');const state=freshState();state.jobs=[{id:'kit',kind:'kit',results:[{id:'image',version:2,assetId:'new',versions:[{version:1,assetId:'old'},{version:2,assetId:'new'}]}]}];state.preview={jobId:'kit',resultId:'image',version:1};
 assert.equal(previewContext(state).result.assetId,'old');assert.equal(previewContext(state).result.historical,true);assert.equal(state.jobs[0].results[0].assetId,'new');delete state.preview.version;assert.equal(previewContext(state).result.assetId,'new');
});
