import test from 'node:test';
import assert from 'node:assert/strict';
import {inputHarness,legacyProduct} from './input-harness.mjs';
import {saveProduct,api,mergeRemote,projectTask} from '../../src/integration-client.js';
import {productFromRemote,reuseTaskInput} from '../../src/product-input.js';
import {freshState,recover} from '../../src/model.js';
import {settings} from './fixtures.mjs';

async function harness(t){const h=await inputHarness();t.after(()=>h.close());const original=globalThis.fetch;t.mock.method(globalThis,'fetch',(url,options)=>original(String(url).startsWith('/')?h.base+url:url,options));return h;}
async function done(store,id){for(let i=0;i<300;i++){const t=store.task(id);if(!['queued','running'].includes(t.state))return t;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');}
const submit=(p,text,key)=>api('/kits',{method:'POST',body:{productId:p.id,productRevision:p.revision,settings,description:text},headers:{'Idempotency-Key':key}});

test('unified save -> reload -> submit freezes editable text, archives old facts and never revives them',async t=>{
 const h=await harness(t),old=legacyProduct(h.runtime.store);
 const historical=await submit(old,'旧场景','legacy-job');const before=await done(h.runtime.store,historical.task.id);
 const p=productFromRemote(old);assert.match(p.inputText,/500ml/);
 p.inputText='蓝色杯子，容量300ml。期望窗边场景，适合通勤。';
 let remote=await saveProduct(p,()=>{throw Error('Remote assets should not be reuploaded');});
 assert.deepEqual(remote.facts.legacy.confirmed,old.facts.confirmed);assert.deepEqual(remote.facts.confirmed,[]);
 assert.equal(remote.facts.userInput.text,p.inputText);assert.equal(remote.facts.legacy.originalSource,'kept');
 const s=freshState();mergeRemote(s,[],(await api('/products')).products);recover(s);assert.equal(s.products[0].inputText,p.inputText);
 const created=await submit(remote,p.inputText,'unified-job');assert.equal((await submit(remote,p.inputText,'unified-job')).task.id,created.task.id);
 const final=await done(h.runtime.store,created.task.id);assert.equal(final.state,'succeeded');
 const prepared=final.input.settings.workflow03A;
 assert.deepEqual(prepared.understanding.facts,[]);assert.deepEqual(prepared.input.product.facts,[]);
 assert.equal(prepared.input.requirements.description,p.inputText);assert.ok(prepared.plan.images.every(i=>i.content.includes(p.inputText)&&!i.content.includes('500ml')));
 p.inputText='只保留简洁明亮的画面';remote=await saveProduct(p,()=>{});
 assert.equal(productFromRemote(remote).inputText,p.inputText);
 assert.deepEqual(h.runtime.store.task(before.id),before);assert.equal(h.runtime.store.task(final.id).input.description,final.input.description);
 assert.equal(reuseTaskInput(projectTask(final)),final.input.description);
 assert.match(reuseTaskInput(projectTask(before)),/500ml/);
});

test('save accepts long legacy text intact while new submissions enforce 1000 and no hidden confirmed data',async t=>{
 const h=await harness(t),p=productFromRemote(legacyProduct(h.runtime.store));p.inputText='长'.repeat(3500);
 let remote=await saveProduct(p,()=>{});assert.equal(remote.facts.userInput.text.length,3500);
 await assert.rejects(submit(remote,p.inputText,'too-long'),/1000/);
 p.inputText='文'.repeat(1000);remote=await saveProduct(p,()=>{});assert.equal((await submit(remote,p.inputText,'limit')).task.input.description.length,1000);
 await assert.rejects(submit(remote,'修改后尚未保存','stale'),/重新保存/);
 p.inputText=' ';remote=await saveProduct(p,()=>{});await assert.rejects(submit(remote,p.inputText,'empty'),/请填写/);
 p.inputText='希望户外';remote=await saveProduct(p,()=>{});
 remote=h.runtime.store.updateProduct(remote.id,{expectedRevision:remote.revision,facts:{...remote.facts,confirmed:[{id:'hidden',value:'500ml'}]}});
 await assert.rejects(submit(remote,p.inputText,'hidden'),/隐藏/);
});

test('backend merge preserves local unsaved input, references, pending submission and old result versions',async t=>{
 const h=await harness(t),remote=legacyProduct(h.runtime.store),p=productFromRemote(remote),s=freshState();
 p.inputText='本地资料';s.products=[p];s.kit={...s.kit,productId:p.id,description:'本地未保存要求',pendingSubmission:{key:'pending',body:{description:'先前已提交'}}};
 const before=structuredClone(s);mergeRemote(s,[],[remote]);assert.deepEqual(s,before);
});
