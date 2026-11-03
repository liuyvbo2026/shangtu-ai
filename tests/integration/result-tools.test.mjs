import test from 'node:test';
import assert from 'node:assert/strict';
import {inputHarness,legacyProduct} from './input-harness.mjs';
import {api,mergeRemote} from '../../src/integration-client.js';
import {settings,fixturePNG} from './fixtures.mjs';
import {freshState} from '../../src/model.js';
const recognized=[{text:'BLUE CUP',box:[.1,.1,.4,.1],confidence:.9},{text:'300 ml',box:[.1,.3,.4,.1],confidence:.8}];
async function done(store,id){for(let i=0;i<500;i++){const t=store.task(id);if(!['queued','running'].includes(t.state))return t;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');}
async function harness(t,options={}){
 const h=await inputHarness({recognizeText:async()=>structuredClone(recognized),...options});t.after(()=>h.close());const original=globalThis.fetch;t.mock.method(globalThis,'fetch',(url,options)=>original(String(url).startsWith('/')?h.base+url:url,options));
 const p=legacyProduct(h.runtime.store),s=await api('/kits',{method:'POST',body:{productId:p.id,productRevision:p.revision,settings,description:'Test only'},headers:{'Idempotency-Key':'source'}});
 const source=await done(h.runtime.store,s.task.id);assert.equal(source.state,'succeeded');
 return {...h,source,result:source.children[0].result,p};
}
const edit=(result,body,key=crypto.randomUUID())=>api(`/results/${result.id}/corrections`,{method:'POST',body:{expectedVersion:result.versions.at(-1).version,...body},headers:{'Idempotency-Key':key}});
const recognize=result=>api(`/results/${result.id}/recognitions`,{method:'POST',body:{expectedVersion:result.versions.at(-1).version}});

test('blank redraw is idempotent, frozen and appends exactly one version while preserving siblings and listing',async t=>{
 const h=await harness(t),{store}=h.runtime;
 const s=await edit(h.result,{instruction:'  '},'blank');const final=await done(store,s.task.id);assert.equal(final.state,'succeeded');
 assert.equal(final.input.settings.correction.requestedInstruction,'  ');assert.match(final.input.settings.correction.instruction,/重绘/);
 assert.equal((await edit(h.result,{instruction:'  '},'blank')).task.id,final.id);
 const after=store.task(h.source.id);assert.equal(after.children[0].result.versions.length,2);assert.deepEqual(after.children[0].result.versions[0],h.result.versions[0]);assert.deepEqual(after.children.slice(1),h.source.children.slice(1));
 const state=freshState();state.jobs=[{id:h.source.id,listing:'旧文案\n逐字保留'}];mergeRemote(state,[after,final],[h.p]);assert.equal(state.jobs[0].listing,'旧文案\n逐字保留');
});
test('restore requires a separately selected original; freezes only this original plus current and preserves product references',async t=>{
 const h=await harness(t),{store}=h.runtime;
 await assert.rejects(edit(h.result,{kind:'restore'}),/单独上传/);assert.equal(store.tasks().length,1);
 const original=await api('/assets',{method:'POST',body:new Blob([fixturePNG('restore-original',32,32)],{type:'image/png'}),headers:{'X-Asset-Client-Id':'separate-original'}});
 const s=await edit(h.result,{kind:'restore',originalAssetId:original.id}),final=await done(store,s.task.id);assert.equal(final.state,'succeeded');
 assert.deepEqual(final.input.references.map(r=>r.assetId),[original.id,h.result.versions[0].assetId]);assert.deepEqual(store.product(h.p.id),h.p);assert.equal(store.result(h.result.id).versions.length,2);
 await assert.rejects(edit(store.result(h.result.id),{kind:'restore',originalAssetId:h.result.versions[0].assetId}),/原图/);
});
test('recognized text is bound to result/version; unchanged, forged, malformed and stale edits never enqueue',async t=>{
 const h=await harness(t),{store}=h.runtime,ocr=await recognize(h.result);
 assert.deepEqual(ocr.regions.map(r=>r.text),recognized.map(r=>r.text));assert.equal(store.tasks().length,1);
 for(const changes of [[],[{id:'text-1',text:'BLUE CUP'}],[{id:'unknown',text:'bad'}],[null],[{id:'text-1',text:'new'},{id:'text-1',text:'twice'}]])await assert.rejects(edit(h.result,{kind:'text',recognitionId:ocr.id,changes}));
 await assert.rejects(edit(h.result,{kind:'text',changes:[]}));
 await assert.rejects(edit(h.source.children[1].result,{kind:'text',recognitionId:ocr.id,changes:[{id:'text-1',text:'wrong image'}]}),/过期/);
 assert.equal(store.tasks().length,1);
 const s=await edit(h.result,{kind:'text',recognitionId:ocr.id,changes:[{id:'text-1',text:'蓝色水杯'},{id:'text-2',text:''}]}),final=await done(store,s.task.id);assert.equal(final.state,'succeeded');
 assert.equal(final.input.settings.correction.changes[0].text,'BLUE CUP');assert.equal(final.input.settings.correction.changes[0].replacement,'蓝色水杯');assert.deepEqual(final.input.settings.correction.changes[0].box,recognized[0].box);
 const head=store.result(h.result.id);await assert.rejects(edit(head,{kind:'text',recognitionId:ocr.id,changes:[{id:'text-1',text:'stale'}]}),/过期/);assert.equal(store.tasks().length,2);
 assert.deepEqual(store.task(h.source.id).children.slice(1),h.source.children.slice(1));
});
test('empty OCR and failed/unavailable OCR never create edit tasks or alter source images',async t=>{
 let failed=false;const h=await harness(t,{recognizeText:async()=>{if(failed)throw Error('Test OCR failure');return [];}});const empty=await recognize(h.result);assert.deepEqual(empty.regions,[]);assert.deepEqual(h.runtime.store.task(h.source.id),h.source);assert.equal(h.runtime.store.tasks().length,1);
 failed=true;await assert.rejects(recognize(h.result));assert.deepEqual(h.runtime.store.task(h.source.id),h.source);assert.equal(h.runtime.store.tasks().length,1);
 const unavailable=await inputHarness({recognizeText:null});t.after(()=>unavailable.close());
 const res=await fetch(unavailable.base+'/api/backend-v1/results/missing/recognitions',{method:'POST',headers:{'Content-Type':'application/json','X-Backend-Client':'local-development'},body:JSON.stringify({expectedVersion:1})});assert.equal(res.status,503);assert.equal((await res.json()).error.code,'OCR_UNAVAILABLE');
});
test('OCR completing after version changes is rejected without storing a stale recognition',async t=>{
 let release,started;const entered=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const h=await harness(t,{recognizeText:async()=>{started();await wait;return recognized;}}),promise=recognize(h.result);await entered;
 const s=await edit(h.result,{instruction:''});await done(h.runtime.store,s.task.id);release();
 await assert.rejects(promise,/已有新版本/);assert.equal(h.runtime.store.all('SELECT * FROM integration_recognitions').length,0);
});

test('saved listing revisions survive reload, reject stale writes and preserve edits across idempotent response recovery',async t=>{
 const h=await harness(t),id=h.source.id;
 const save=(text,expectedRevision,key)=>api(`/tasks/${id}/listing`,{method:'POST',headers:{'Idempotency-Key':key},body:{text,expectedRevision}});
 const first=await save('宝贝标题\n蓝色水杯',0,'listing-first');assert.equal(first.revision,1);
 assert.deepEqual(await save('宝贝标题\n蓝色水杯',0,'listing-first'),first);
 await assert.rejects(save('过期编辑',0,'listing-stale'),/其他窗口/);
 const second=await save('宝贝标题\n蓝色水杯（修订）',1,'listing-second');assert.equal(second.revision,2);
 const history=await api(`/tasks/${id}/listing`);assert.deepEqual(history.versions.map(v=>v.text),[second.text,first.text]);
 assert.deepEqual((await api('/listing-edits')).edits,[second]);assert.deepEqual(h.runtime.store.task(id),h.source);
 const {listingEdits}=await import('../../backend/integration/listing-edits.mjs');assert.deepEqual(listingEdits(h.runtime.store).history(id),history.versions);
 await assert.rejects(save('不同内容',1,'listing-second'),/保存内容已改变/);
});


test('independent editor publishes through the integration route without model calls and retains siblings',async t=>{
 const h=await harness(t),{store}=h.runtime;
 const {publishToKit}=await import('../../src/editor/publish.js');
 const calls=store.all('SELECT * FROM provider_calls').length,tasks=store.tasks().length;
 const session={documentId:'editor-browser',currentVersionId:'version-a',name:'文字编辑',source:{kind:'kit-result',resultId:h.result.id,resultVersion:1,serverAssetId:h.result.versions[0].assetId}};
 const render=async()=>new Blob([fixturePNG('manual edit',864,1152)],{type:'image/png'});
 assert.deepEqual(await publishToKit(session,render,api),{version:2,duplicate:false});
 assert.deepEqual(await publishToKit(session,render,api),{version:2,duplicate:true});
 const after=store.task(h.source.id);assert.deepEqual(after.children.slice(1),h.source.children.slice(1));assert.deepEqual(after.children[0].result.versions[0],h.result.versions[0]);
 assert.equal(store.all('SELECT * FROM provider_calls').length,calls);assert.equal(store.tasks().length,tasks);
 await assert.rejects(api(`/results/${h.result.id}/versions`,{method:'POST',body:{assetId:after.children[0].result.versions[1].assetId,expectedVersion:2}}),/提交编号/);
});
