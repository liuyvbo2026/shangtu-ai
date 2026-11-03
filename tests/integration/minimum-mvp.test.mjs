import {BETA_TEMPLATE,betaLayers} from '../../src/workflow/beta-design.js';
import {TYPOGRAPHY_TEMPLATE,typographyLayers} from '../../src/workflow/typography-design.js';
// Complete production adapters with injected transports. All pixels and responses are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApiSettings} from '../../backend/integration/api-settings.mjs';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {MODEL,POLICY} from '../../backend/integration/planning.mjs';
import {hash} from '../../backend/core.mjs';
import {fixturePNG,settings} from './fixtures.mjs';
import {fixtureOutput,fixtureResponse,FAKE_MIMO_KEY,textFixture,settled} from './mimo-fixtures.mjs';
import {CANDIDATE_TEMPLATE,DIVERSE_TEMPLATE,DESIGN_TEMPLATE,RESOLVED_TEMPLATE,COMMERCE_TEMPLATE,PRESENTATIONS} from '../../src/workflow/minimum-templates.js';
import {designIssues,renderDesign} from '../../src/workflow/kit-design.js';
import {designFixture} from './design-fixtures.mjs';
import {imagePrompt} from '../../src/workflow/prompts.js';
import {assertPrepared} from '../../src/workflow/workflow.js';
import {validatePlan} from '../../src/workflow/validation.js';
import {validatePlanOutput,textPrompt,textSchema,planRepairIssues} from '../../backend/integration/mimo-contracts.mjs';
import {executableTextPlan} from '../../backend/integration/minimum-plan.mjs';

async function until(read){for(let i=0;i<600;i++){const value=read();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('TEST_TIMEOUT');}
async function harness(t,{paused=false,failOne=false,unknown=false,slow=false,templateVersion=CANDIDATE_TEMPLATE,transformPlan,transformUnderstanding,transformAddon,withSettings=false,recognizeText=null,referenceCount=3,layoutCatalog=[]}={}){
 const dataDir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'minimum-mvp-'));
 const bytes=Array.from({length:referenceCount},(_,i)=>fixturePNG(`SYNTHETIC REFERENCE ${i}`,32,32)),payloads=[],texts=[];
 const config={modelCallsPaused:!paused?false:undefined,accountConfirmed:true,budgetId:'synthetic-minimum',budgetCny:5,reservePerImageCny:.12,
  priceEvidence:'TEST ONLY',authorizationEvidence:'TEST ONLY',authorizedReferenceHashes:bytes.map(hash),
  mimo:{model:'mimo-v2.6-flash',billing:'pay-as-you-go',accountConfirmed:true,templateVersion,authorizationEvidence:'TEST ONLY',authorizedReferenceHashes:bytes.map(hash)}};
 const options={dataDir,config,apiSettings:withSettings?createApiSettings({root:dataDir,fallback:{text:FAKE_MIMO_KEY,image:'SYNTHETIC_ARK_KEY'}}):null,key:'SYNTHETIC_ARK_KEY',mimoKey:FAKE_MIMO_KEY,recognizeText,layoutCatalog,
  mimoTransport:async(url,options)=>{const payload=JSON.parse(options.body),data=JSON.parse(payload.messages[1].content.at(-1).text);texts.push(payload);
   if(data.operation==='plan-review'){const check={status:'pass',reason:'合成协议测试'};return fixtureResponse({verdict:'approved',images:data.candidate.images.map((x,imageIndex)=>({imageIndex,naturalCopy:check,useRelation:check,evidence:check,purpose:check,repair:'无需修改'})),setDivision:check});}
   const output=fixtureOutput(data);if(data.operation==='understand')transformUnderstanding?.(output,data);if(['style','listing'].includes(data.operation))transformAddon?.(output,data);if(data.operation==='plan'){output.images.forEach(i=>i.copy.forEach(c=>c.text=i.purpose));transformPlan?.(output,data);}return fixtureResponse(output);},
  imageTransport:async(url,options)=>{const payload=JSON.parse(options.body);payloads.push(payload);
   if(slow)await new Promise(r=>setTimeout(r,120));
   if(unknown)throw Error('SYNTHETIC_UNKNOWN');
   if(failOne&&payloads.length===2)return new Response('{}',{status:429});
   const [w,h]=payload.size.split('x').map(Number);
   return new Response(JSON.stringify({model:MODEL,data:[{b64_json:fixturePNG(`SYNTHETIC RESULT ${payloads.length}`,w,h).toString('base64')}],usage:{generated_images:1,input_images:payload.image.length}}),{headers:{'x-request-id':`synthetic-${payloads.length}`}});
  }};
 let runtime=createRuntime(options);
 const server=http.createServer((req,res)=>runtime.handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/api/backend-v1`;
 t.after(async()=>{await new Promise(r=>server.close(r));await runtime.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 let p=runtime.store.createProduct({name:'SYNTHETIC CUP',facts:{confirmed:[],unknowns:[],userInput:{version:1,text:'希望展示外观，不确定材质和容量',source:{kind:'user-provided'}}}});
 for(const b of bytes){const a=runtime.store.putAsset(b,{kind:'original'});p=runtime.store.addReference(p.id,{assetId:a.id,role:'product'});}
 const input={productId:p.id,productRevision:p.revision,description:p.facts.userInput.text,settings:{...settings,language:'简体中文'}};
 const request=async(route,body,key='request')=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Backend-Client':'local-development','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 const done=id=>until(()=>{const x=runtime.store.task(id);return !['queued','running'].includes(x.state)&&x;});
 async function plan(){const r=await request('/text-runs',{...input,kind:'plan'},'plan');assert.equal(r.status,202,JSON.stringify(r.value));return until(()=>{const v=runtime.textService.get(r.value.run.id);return v.state!=='running'&&v;});}
 return {get runtime(){return runtime;},config,input,p,payloads,texts,request,done,plan,base,async restart(){await runtime.close();runtime=createRuntime(options);}};
}

test('selected real catalog layouts pin rules and pixels through planning, final request, retry and restart',async t=>{
 const {layoutCatalog}=await import('../../src/layout-catalog.js');
 const chosen=structuredClone(layoutCatalog.slice(0,2));
 const h=await harness(t,{templateVersion:DIVERSE_TEMPLATE,layoutCatalog:chosen,failOne:true,transformPlan:(output,data)=>{
  let n=0;for(const image of output.images){const l=image.type==='selling'?data.selectedLayouts[n++]:null;image.layoutId=l?.id??null;image.composition.layout=l?.presentation??PRESENTATIONS[output.images.indexOf(image)%PRESENTATIONS.length];}
 }});
 h.config.authorizedReferenceHashes.push(...chosen.map(l=>l.reference.sha256));h.config.mimo.authorizedReferenceHashes.push(...chosen.map(l=>l.reference.sha256));
 h.input.settings.layouts=chosen.map(l=>l.id);
 const plan=await h.plan();assert.equal(plan.state,'succeeded',JSON.stringify(plan));
 assert.equal(h.texts[0].messages[1].content.filter(c=>c.type==='image_url').length,3,'understanding sees only product evidence');
 assert.equal(h.texts[1].messages[1].content.filter(c=>c.type==='image_url').length,2,'planning receives actual layout pixels');
 assert.equal(plan.output.images.filter(i=>i.layoutId).length,2);
 const r=await h.request('/kits',{...h.input,planRunId:plan.id},'layout-kit');assert.equal(r.status,201,JSON.stringify(r.value));
 let task=await h.done(r.value.task.id);assert.equal(task.state,'partial');
 const prepared=task.input.settings.workflow03A;
 assert.deepEqual(prepared.input.requirements.layoutIds,h.input.settings.layouts);
 for(const img of prepared.plan.images){
  const prompt=imagePrompt(prepared,img),layout=plan.snapshot.layouts?.find(l=>l.id===img.layoutId);
  assert.equal(prompt.data.references.length,layout?4:3);
  if(layout){assert.equal(prompt.data.references.at(-1).role,'layout');assert.equal(prompt.data.selectedLayout.digest,layout.digest);assert.deepEqual(img.composition.subjectBox,layout.definition.subjectBox);
   assert.throws(()=>h.runtime.store.removeAsset(layout.reference.assetId),/referenced/i);
  }
 }
 const call=h.payloads.find(p=>p.prompt.includes('"selectedLayout"'));
 assert.ok(call);assert.equal(call.image.length,4);assert.match(call.prompt,/只借鉴构图|只参考构图/);
 assert.equal(hash(Buffer.from(call.image.at(-1).split(',')[1],'base64')),chosen[0].reference.sha256);
 const raw={visual:plan.output.visual,images:plan.output.images.map(({id,subjectBox,ratio,size,...x})=>x)};
 raw.images.find(x=>x.layoutId).layoutId=null;assert.throws(()=>validatePlanOutput(raw,plan.snapshot,plan.understanding),e=>e.code==='TEXT_LAYOUT_MISMATCH');
 const failed=task.children.find(c=>c.state==='failed');chosen.splice(0);await h.restart();
 const retry=await h.request(`/tasks/${task.id}/retry`,{childIds:[failed.id],expectedRevision:task.revision},'layout-retry');assert.equal(retry.status,200);
 task=await h.done(task.id);assert.equal(task.state,'succeeded');assert.equal(h.payloads.at(-1).image.length,4,'retry uses historical layout even after catalog removal');
 const old=h.runtime.textService.get(plan.id);assert.deepEqual(old.snapshot.layouts,plan.snapshot.layouts);
});

test('unresolved and unauthorized layouts fail before any model call',async t=>{
 const h=await harness(t,{templateVersion:DIVERSE_TEMPLATE});h.input.settings.layouts=['old-browser-thumbnail'];
 const bad=await h.request('/text-runs',{...h.input,kind:'plan'},'bad-layout');assert.equal(bad.value.error.code,'LAYOUT_UNAVAILABLE');assert.equal(h.texts.length,0);
});

test('image quality review uploads pinned originals and result versions, keeps findings and never regenerates',async t=>{
 const h=await harness(t),plan=await h.plan();assert.equal(plan.state,'succeeded');
 const started=await h.request('/kits',{...h.input,planRunId:plan.id},'quality-images');const task=await h.done(started.value.task.id);
 const first=await h.request(`/tasks/${task.id}/quality`,{});assert.equal(first.status,202,JSON.stringify(first));
 const reviewed=await until(()=>{const q=h.runtime.quality.view(task.id);return q.state!=='running'&&q;});
 assert.equal(reviewed.state,'needs-correction',JSON.stringify(reviewed));assert.equal(reviewed.items.length,7);assert.ok(reviewed.items.every(i=>i.version===1&&!i.stale&&i.output.issues.length===1));
 const calls=h.texts.filter(x=>JSON.parse(x.messages[1].content.at(-1).text).operation==='quality');assert.equal(calls.length,7);
 assert.ok(calls.every(x=>x.messages[1].content.filter(c=>c.type==='image_url').length===5));
 assert.equal(h.payloads.length,7,'reviews never trigger a second image generation');
 const count=h.texts.length;await h.request(`/tasks/${task.id}/quality`,{});await h.restart();assert.equal(h.texts.length,count);assert.deepEqual(h.runtime.quality.view(task.id),reviewed);
 const row=h.runtime.store.get('SELECT * FROM image_reviews WHERE task_id=? LIMIT 1',task.id),snapshot=JSON.parse(row.snapshot_json);
 const {qualityAttachments,validateQuality}=await import('../../backend/integration/quality-review.mjs');
 snapshot.quality.outputs[0].assetId=h.p.references[0].assetId;assert.throws(()=>qualityAttachments(h.runtime.store,snapshot),e=>e.code==='QUALITY_SOURCE_CHANGED');
 assert.throws(()=>validateQuality({verdict:'no-obvious-issue',summary:'wrong',issues:reviewed.items[0].output.issues}),e=>e.code==='QUALITY_OUTPUT_INVALID');
});

test('six-reference reviews cover both groups and missing groups cannot pass a whole set',async t=>{
 const h=await harness(t,{referenceCount:6}),plan=await h.plan();assert.equal(plan.state,'succeeded');
 const started=await h.request('/kits',{...h.input,planRunId:plan.id},'six-reference-images'),task=await h.done(started.value.task.id);
 h.runtime.quality.enqueue(task.id);
 const q=await until(()=>{const q=h.runtime.quality.view(task.id);return q.state!=='running'&&q;});
 assert.equal(q.items.length,14);assert.equal(q.state,'needs-correction');
 const calls=h.texts.filter(x=>JSON.parse(x.messages[1].content.at(-1).text).operation==='quality');
 assert.equal(calls.length,14);assert.deepEqual([...new Set(calls.map(x=>x.messages[1].content.filter(c=>c.type==='image_url').length))].sort(),[4,6]);
 h.runtime.store.run('DELETE FROM image_reviews WHERE id=?',q.items.find(i=>i.referenceGroup===1).id);
 assert.equal(h.runtime.quality.view(task.id).state,'unreviewed','one group is not full coverage');
 h.runtime.quality.enqueue(task.id);assert.equal(h.runtime.quality.view(task.id).state,'running');
});

test('changed target and comparison versions expire reports; old queued evidence spends nothing',async t=>{
 const h=await harness(t),plan=await h.plan();
 const started=await h.request('/kits',{...h.input,planRunId:plan.id},'stale-images'),task=await h.done(started.value.task.id);
 h.runtime.quality.enqueue(task.id);await until(()=>h.runtime.quality.view(task.id).state==='needs-correction');
 const correction=await h.request(`/results/${task.children[0].result.id}/corrections`,{kind:'modify',expectedVersion:1,instruction:'仅调整背景明暗'},'stale-correction');await h.done(correction.value.task.id);
 let q=h.runtime.quality.view(task.id);assert.equal(q.state,'unreviewed');assert.deepEqual(q.items.filter(i=>i.stale).map(i=>i.position).sort(),[0,1]);
 const before=h.texts.length;
 for(const i of q.items.filter(i=>i.stale))h.runtime.store.run("UPDATE image_reviews SET state='queued',text_run_id=NULL WHERE id=?",i.id);
 await until(()=>h.runtime.store.get("SELECT count(*) n FROM image_reviews WHERE state='queued'").n===0);
 assert.equal(h.texts.length,before,'stale jobs are not uploaded');
 h.runtime.quality.enqueue(task.id);q=await until(()=>{const q=h.runtime.quality.view(task.id);return q.state==='needs-correction'&&q;});
 assert.equal(h.texts.length,before+2);assert.equal(q.items.length,9);assert.equal(q.items.filter(i=>!i.stale).length,7);
 const reviewedEdit=h.texts.map(x=>JSON.parse(x.messages[1].content.at(-1).text)).find(x=>x.operation==='quality'&&x.quality.position===0&&x.quality.outputs[0].version===2);
 assert.equal(reviewedEdit.quality.edits[0].instruction,'仅调整背景明暗');assert.equal(reviewedEdit.quality.edits[0].version,2);
 await h.restart();assert.deepEqual(h.runtime.quality.view(task.id),q);h.runtime.quality.enqueue(task.id);assert.equal(h.texts.length,before+2);
});

test('cancel during local OCR never dispatches a paid review after OCR returns',async t=>{
 let release,entered=false;const gate=new Promise(r=>release=r);
 const h=await harness(t,{recognizeText:async()=>{entered=true;await gate;return [];}}),plan=await h.plan();
 const started=await h.request('/kits',{...h.input,planRunId:plan.id},'ocr-cancel-images'),task=await h.done(started.value.task.id);
 const before=h.texts.length;h.runtime.quality.enqueue(task.id);await until(()=>entered);
 h.runtime.quality.cancel(task.id);release();await new Promise(r=>setTimeout(r,250));
 assert.equal(h.texts.length,before);assert.equal(h.runtime.quality.view(task.id).state,'failed');
});

test('OCR evidence is pinned into reviews and survives restart without recognition or model replay',async t=>{
 let count=0;const h=await harness(t,{recognizeText:async()=>{count++;return [{text:'实际画面文字',box:[.1,.1,.3,.1],confidence:1}];}}),plan=await h.plan();
 const started=await h.request('/kits',{...h.input,planRunId:plan.id},'ocr-review-images'),task=await h.done(started.value.task.id);
 h.runtime.quality.enqueue(task.id);const q=await until(()=>{const q=h.runtime.quality.view(task.id);return q.state!=='running'&&q;});
 assert.equal(count,7);assert.equal(q.state,'needs-correction');assert.ok(q.items.every(i=>i.textAudit.regions[0].text==='实际画面文字'));
 const calls=h.texts.filter(x=>JSON.parse(x.messages[1].content.at(-1).text).operation==='quality');
 assert.ok(calls.every(x=>JSON.parse(x.messages[1].content.at(-1).text).version==='image-review.2'));
 assert.match(calls[0].messages[0].content,/不得用规划的坐标或文案冒充可见证据/);
 await h.restart();h.runtime.quality.enqueue(task.id);assert.equal(count,7);assert.deepEqual(h.runtime.quality.view(task.id),q);
});

test('review queued work blocks API configuration and can be canceled over HTTP',async t=>{
 const h=await harness(t,{withSettings:true}),plan=await h.plan();
 const started=await h.request('/kits',{...h.input,planRunId:plan.id},'cancel-review-images'),task=await h.done(started.value.task.id);
 h.runtime.quality.enqueue(task.id);
 const settings=await fetch(h.base+'/api-settings',{method:'PUT',headers:{'Content-Type':'application/json','X-Backend-Client':'local-development'},body:'{}'});
 assert.equal((await settings.json()).error.code,'SETTINGS_BUSY');
 const tests=await h.request('/api-settings/test',{});assert.equal(tests.value.error.code,'SETTINGS_BUSY');
 const cancel=await h.request(`/tasks/${task.id}/quality/cancel`,{});assert.equal(cancel.status,200);assert.equal(cancel.value.state,'failed');
 const before=h.texts.length;await new Promise(r=>setTimeout(r,250));assert.equal(h.texts.length,before);
});

test('quality checks are opt-in on new flows, cancellation does not submit queued reviews',async t=>{
 const h=await harness(t);h.config.qualityReviewEnabled=true;
 const response=h.runtime.kitRuns.submit({items:[h.input]},'quality-flow');
 const run=await until(()=>{const r=h.runtime.kitRuns.get(response.runs[0].id);return ['succeeded','partial','failed'].includes(r.state)&&r;});
 assert.equal(run.state,'succeeded',JSON.stringify(run));assert.equal(run.quality.state,'needs-correction');assert.equal(h.payloads.length,7);
 const q=h.runtime.quality.view(run.taskId);assert.equal(q.items.length,7);
 const before=h.texts.length;
 for(const item of q.items)h.runtime.store.run("UPDATE image_reviews SET state='failed',error_code='SYNTHETIC_FAILURE' WHERE id=?",item.id);
 h.runtime.quality.enqueue(run.taskId,{retry:true});h.runtime.quality.cancel(run.taskId);
 await new Promise(r=>setTimeout(r,250));assert.equal(h.texts.length,before);assert.ok(h.runtime.quality.view(run.taskId).items.every(i=>i.errorCode==='CANCELED'));
});

test('durable complete flow freezes separate products and settings, drives style/listing, survives restart without replay',async t=>{
 const h=await harness(t,{templateVersion:DIVERSE_TEMPLATE,transformPlan:(out,data)=>{out.images.forEach((x,i)=>x.composition.layout=PRESENTATIONS[i%PRESENTATIONS.length]);if(data.styleAnalysis)out.visual=data.styleAnalysis.visual;}});
 let other=h.runtime.store.createProduct({name:'SYNTHETIC SECOND PRODUCT',facts:structuredClone(h.p.facts)});
 for(const ref of h.p.references)other=h.runtime.store.addReference(other.id,{assetId:ref.assetId,role:'product'});
 const input={mode:'immediate',global:h.input.settings,items:[{productId:h.p.id,productRevision:h.p.revision,description:h.input.description,override:{}},{productId:other.id,productRevision:other.revision,description:h.input.description,override:{ratio:'3:4',analysis:true,listing:true}}]};
 const response=await h.request('/kit-runs',input,'complete-batch');assert.equal(response.status,202,JSON.stringify(response.value));
 const again=await h.request('/kit-runs',input,'complete-batch');assert.equal(again.value.duplicate,true);assert.deepEqual(again.value.runs.map(r=>r.id),response.value.runs.map(r=>r.id));
 h.runtime.store.updateProduct(other.id,{expectedRevision:other.revision,name:'Edited while queued; old snapshot must remain'});
 await until(()=>h.runtime.kitRuns.list().every(r=>['succeeded','partial','failed','canceled'].includes(r.state)));
 const runs=h.runtime.kitRuns.list();assert.equal(runs.length,2);assert.ok(runs.every(r=>r.state==='succeeded'),JSON.stringify(runs));
 const second=runs.find(r=>r.productId===other.id);assert.equal(second.name,'SYNTHETIC SECOND PRODUCT');assert.equal(second.settings.ratio,'3:4');assert.ok(second.style&&second.listing);
 const task=h.runtime.store.task(second.taskId);assert.equal(task.input.product.name,'SYNTHETIC SECOND PRODUCT');assert.deepEqual(task.input.settings.workflow03A.plan.visual,second.style.visual);
 assert.equal(h.payloads.length,14);assert.equal(h.texts.filter(x=>JSON.parse(x.messages[1].content.at(-1).text).operation==='understand').length,2,'understanding reused by all later text stages');
 const calls=h.texts.length;await h.restart();assert.equal(h.texts.length,calls);assert.deepEqual(h.runtime.kitRuns.list(),runs);
});

test('queued flow cancellation spends nothing and batch help-writing produces separate saved drafts only',async t=>{
 const h=await harness(t);
 const input={kind:'assist',mode:'queue',items:[h.input]};
 const first=h.runtime.kitRuns.submit(input,'assist-cancel');h.runtime.kitRuns.cancel(first.runs[0].id);assert.equal(h.texts.length,0);
 const second=h.runtime.kitRuns.submit(input,'assist-success');
 await until(()=>h.runtime.kitRuns.get(second.runs[0].id).state==='succeeded');
 const run=h.runtime.kitRuns.get(second.runs[0].id);assert.ok(run.assistance.text.startsWith(h.input.description));assert.equal(h.payloads.length,0);assert.equal(h.runtime.store.product(h.p.id).facts.userInput.text,h.input.description);
});

test('MVP production transports: validated MiMo plan drives all seven images, targeted retry/edit/download/restart preserve siblings',async t=>{
 const h=await harness(t,{failOne:true}),original=JSON.stringify(h.runtime.store.product(h.p.id));
 const plan=await h.plan();assert.equal(plan.state,'succeeded',JSON.stringify(plan));assert.equal(h.texts.length,2);assert.match(h.texts[1].messages[0].content,/ecommerce-kit.1/);
 const request={...h.input,planRunId:plan.id};const s=await h.request('/kits',request,'kit');assert.equal(s.status,201,JSON.stringify(s.value));
 const duplicate=await h.request('/kits',request,'kit');assert.equal(duplicate.value.task.id,s.value.task.id);
 let task=await h.done(s.value.task.id);assert.equal(task.state,'partial');assert.equal(h.payloads.length,7);
 assert.equal(task.input.settings.workflow03A.minimumMvp.runId,plan.id);assert.equal(task.policy.maxAttempts,2);
 assert.ok(h.payloads.every(p=>p.model===MODEL&&p.image.length===3));
 assert.ok(h.payloads.every(p=>p.prompt.includes('"country":"德国"')&&p.prompt.includes('"platform":"亚马逊"')));
 for(let i=0;i<7;i++){assert.ok(h.payloads[i].prompt.includes(plan.output.images[i].purpose));assert.ok(!h.payloads[i].prompt.includes('本轮未接入图内文案'));}
 const prepared=task.input.settings.workflow03A;
 assert.equal(imagePrompt(prepared,prepared.plan.images[1]).data.copy[0].text,plan.output.images[1].copy[0].text);
 const tampered=structuredClone(prepared);tampered.minimumMvp.plan.images[1].copy[0].text='篡改';assert.throws(()=>assertPrepared(tampered));
 const failed=task.children.find(c=>c.state==='failed'),siblings=task.children.filter(c=>c.result).map(c=>c.result);
 const retry=await h.request(`/tasks/${task.id}/retry`,{childIds:[failed.id],expectedRevision:task.revision});assert.equal(retry.status,200);
 task=await h.done(task.id);assert.equal(task.state,'succeeded');assert.equal(h.payloads.length,8);
 for(const r of siblings)assert.deepEqual(task.children.find(c=>c.result?.id===r.id).result,r);
 const target=task.children[0].result,correction=await h.request(`/results/${target.id}/corrections`,{kind:'modify',expectedVersion:1,instruction:'仅调整背景明暗'},'modify');
 assert.equal(correction.status,201);await h.done(correction.value.task.id);
 task=h.runtime.store.task(task.id);assert.equal(task.children[0].result.versions.length,2);assert.equal(task.children[1].result.versions.length,1);
 for(const child of task.children){const v=child.result.versions.at(-1);const download=Buffer.from(await(await fetch(h.base+`/assets/${v.assetId}/content`)).arrayBuffer());assert.equal(hash(download),h.runtime.store.asset(v.assetId).sha256);}
 assert.equal(JSON.stringify(h.runtime.store.product(h.p.id)),original);
 h.runtime.store.run('DELETE FROM integration_submissions WHERE key=?','kit');
 h.runtime.store.updateProduct(h.p.id,{expectedRevision:h.p.revision,name:'later local change'});
 const recovered=await h.request('/kits',request,'kit');assert.equal(recovered.value.task.id,task.id);assert.equal(recovered.value.duplicate,true);
 const calls=h.payloads.length,history=h.runtime.store.tasks();await h.restart();assert.equal(h.payloads.length,calls);assert.deepEqual(h.runtime.store.tasks(),history);assert.equal(h.runtime.textService.get(plan.id).state,'succeeded');
});

test('v5 composition and multiple labels reach the real image adapter unchanged; paused restart preserves history',async t=>{
 const h=await harness(t,{templateVersion:DIVERSE_TEMPLATE,transformPlan:output=>{
  output.images.forEach((x,i)=>x.composition.layout=PRESENTATIONS[i%PRESENTATIONS.length]);
  const selling=output.images.find(x=>x.type==='selling');
  selling.composition.layout='图标卡片';
  selling.composition.framing='右侧完整商品，左侧标题及三张图标卡片；各卡片按 copy 顺序排列';
  selling.copy.push(...['蓝色外观','清晰轮廓','侧面线条'].map(text=>({text,sourceIds:['o1']})));
 }});
 const plan=await h.plan();assert.equal(plan.state,'succeeded',JSON.stringify(plan));
 const planning=h.texts.find(x=>JSON.parse(x.messages[1].content.at(-1).text).operation==='plan');
 assert.doesNotMatch(planning.messages[0].content,/杯身|杯盖|不拼贴|标题放上方留白/);
 const submit=await h.request('/kits',{...h.input,planRunId:plan.id},'v5-kit');assert.equal(submit.status,201,JSON.stringify(submit));
 const task=await h.done(submit.value.task.id);assert.equal(task.state,'succeeded');assert.equal(h.payloads.length,7);
 for(const payload of h.payloads){
  const data=JSON.parse(payload.prompt.slice(payload.prompt.indexOf('{"productId"'))),shot=plan.output.images.find(x=>x.id===data.image.id);
  assert.deepEqual(data.image.composition,shot.composition);assert.deepEqual(data.copy,shot.copy);assert.deepEqual(data.image.copy,shot.copy);
  assert.equal(data.image.purpose,shot.purpose);assert.equal(data.image.content,shot.content);
  assert.doesNotMatch(payload.prompt,/不生成拼贴|标题在上方留白区域/);
  assert.equal(payload.image.length,3);assert.equal(payload.model,MODEL);
 }
 const calls=h.runtime.store.all('SELECT request_json FROM provider_calls');
 for(let i=0;i<calls.length;i++)assert.equal(JSON.parse(calls[i].request_json).prompt,h.payloads[i].prompt);
 const history=h.runtime.store.tasks();h.config.modelCallsPaused=true;await h.restart();
 assert.deepEqual(h.runtime.store.tasks(),history);assert.equal(h.payloads.length,7);
 assert.equal((await h.request('/text-runs',{...h.input,kind:'plan'},'paused-v5')).value.error.code,'MODEL_CALLS_PAUSED');
});

test('v5 layout/copy schema is versioned and keeps source, quantity and no-text guards',async t=>{
 const h=textFixture();t.after(()=>h.close());const run=await settled(h,h.runtime.textService.submit(h.request,'v5-guards').run.id);
 const s={...run.snapshot,templateVersion:DIVERSE_TEMPLATE};
 const raw=fixtureOutput({...h.sent[0].data,operation:'plan'});
 raw.images.forEach((x,i)=>{x.composition.layout=PRESENTATIONS[i%PRESENTATIONS.length];x.copy.forEach(c=>c.text=x.purpose);});
 const selling=raw.images.find(x=>x.type==='selling');selling.copy.push({text:'蓝色外观',sourceIds:['o1']});
 assert.equal(validatePlanOutput(raw,s,run.understanding).images.length,7);
 for(const mutate of [x=>delete x.images[1].composition.layout,x=>x.images[1].copy.push({text:'500ml',sourceIds:['o1']}),x=>x.images[1].copy[0].sourceIds=['u1'],x=>x.images.pop(),x=>x.images[1].copy=Array.from({length:5},()=>({text:'蓝色',sourceIds:['o1']}))]){
  const bad=structuredClone(raw);mutate(bad);assert.throws(()=>validatePlanOutput(bad,s,run.understanding));
 }
 const empty=structuredClone(raw);empty.images.forEach(x=>x.copy=[]);
 assert.equal(validatePlanOutput(empty,{...s,settings:{...s.settings,language:'无文字'}},run.understanding).images.length,7);
 assert.throws(()=>validatePlanOutput(raw,{...s,templateVersion:'ecommerce-kit.4'},run.understanding));
 assert.equal(textSchema('plan','ecommerce-kit.4').properties.images.items.properties.copy.maxItems,1);
 assert.equal(textSchema('plan',DIVERSE_TEMPLATE).properties.images.items.properties.copy.maxItems,4);
 assert.equal(textSchema('plan','ecommerce-kit.4').properties.images.items.properties.composition.properties.layout,undefined);
 const prompt=textPrompt('plan',{...s,name:'背包',description:'仅桌面展示，不要人物'},run.understanding);
 assert.doesNotMatch(prompt.system,/杯身|杯盖/);assert.equal(prompt.data.userText,'仅桌面展示，不要人物');
 assert.ok(prompt.data.slotRequirements.every(x=>x.copyMax===(x.type==='white'?0:4)));
 const rejected=structuredClone(raw);rejected.images[2].referenceIds=rejected.images[2].referenceIds.slice(0,-1);rejected.images[1].copy[0].sourceIds=['u1'];
 const unchanged=JSON.stringify(rejected),issues=planRepairIssues(rejected,s,run.understanding);
 assert.deepEqual(issues.map(x=>x.path),['images[1].copy[0].sourceIds','images[2].referenceIds']);
 assert.deepEqual(issues[1].expected,s.references.map(x=>x.id));assert.deepEqual(issues[0].rejectedIds,['u1']);
 assert.equal(JSON.stringify(rejected),unchanged);assert.throws(()=>validatePlanOutput(rejected,s,run.understanding));
 const ban=structuredClone(raw);ban.images[1].content+='，不使用任何认证类标识。';
 assert.equal(validatePlanOutput(ban,s,run.understanding).images.length,7);
 for(const instruction of ['，使用认证标识。','，不是不使用认证标识。','，不使用任何认证类标识，商品已获认证。']){
  const claim=structuredClone(raw);claim.images[1].content+=instruction;assert.throws(()=>validatePlanOutput(claim,s,run.understanding));
 }
 ban.images[1].copy[0].text='不添加认证标识';assert.throws(()=>validatePlanOutput(ban,s,run.understanding));
});

test('v6 buyer questions, evidence, regions and exact labels survive the production pipeline and restart',async t=>{
 const h=await harness(t,{templateVersion:DESIGN_TEMPLATE,transformPlan:designFixture});
 const plan=await h.plan();assert.equal(plan.state,'succeeded',JSON.stringify(plan));
 const s=await h.request('/kits',{...h.input,planRunId:plan.id},'v6-kit');assert.equal(s.status,201,JSON.stringify(s.value));
 const task=await h.done(s.value.task.id);assert.equal(task.state,'succeeded');assert.equal(h.payloads.length,7);
 for(const payload of h.payloads){
  const data=JSON.parse(payload.prompt.slice(payload.prompt.indexOf('{"productId"'))),shot=plan.output.images.find(x=>x.id===data.image.id);
  assert.deepEqual(data.image.design,shot.design);assert.deepEqual(data.layoutSpec,renderDesign(shot));
  assert.deepEqual(data.image.copy,shot.copy);assert.deepEqual(data.copy,shot.copy);
  const prepared=task.input.settings.workflow03A;
  assert.deepEqual(prepared.plan.images.find(x=>x.id===shot.id).composition.subjectBox,shot.design.subjectBox);
  assert.equal(payload.model,MODEL);assert.equal(payload.image.length,3);
 }
 const current=JSON.stringify(h.runtime.store.tasks()),requests=h.payloads.length;
 const prepared=task.input.settings.workflow03A,invalid=structuredClone(prepared.plan);
 invalid.images[0].composition.subjectBox=[.9,.2,.5,.5];
 assert.ok(validatePlan(prepared.input,prepared.understanding,invalid,POLICY).some(x=>x.code==='LAYOUT_BOUNDS'));
 invalid.images[0].textMode='editable-overlay';invalid.images[0].composition.subjectBox=[.45,.18,.5,.75];
 assert.ok(validatePlan(prepared.input,prepared.understanding,invalid,POLICY).some(x=>x.code==='LAYOUT_COMPOSITION'),'old overlay layout bounds remain enforced');
 await h.restart();assert.equal(JSON.stringify(h.runtime.store.tasks()),current);assert.equal(h.payloads.length,requests);
 const stale=structuredClone(plan);stale.output.images[1].design.elements.pop();
 assert.throws(()=>executableTextPlan(h.runtime.store,stale,h.input));
});

test('v6 rejects observed design regressions before images and supplies explicit repair diagnostics',async t=>{
 const h=await harness(t,{templateVersion:DESIGN_TEMPLATE,transformPlan:out=>{designFixture(out);out.images[1].content+='四张等大图标卡片。';}});
 const failed=await h.plan();assert.equal(failed.state,'failed');assert.equal(failed.errorCode,'TEXT_DESIGN_INVALID');
 assert.ok(failed.designProblems.some(x=>x.code==='DESIGN_CARD_COUNT'));
 assert.equal(failed.output,null);assert.equal('rejectedOutput' in failed,false);
 const s=await h.request('/kits',{...h.input,planRunId:failed.id},'bad-v6-kit');assert.ok(s.status>=400);assert.equal(h.payloads.length,0);
 const retry=await h.request('/text-runs',{...h.input,kind:'plan',understandingRunId:failed.id,repairRunId:failed.id},'repair-v6');assert.equal(retry.status,202);
 await until(()=>h.runtime.textService.get(retry.value.run.id).state!=='running');
 const data=JSON.parse(h.texts.at(-1).messages[1].content.at(-1).text);
 assert.ok(data.repairContext.validationIssues.some(x=>x.code==='DESIGN_CARD_COUNT'));
 assert.equal(h.texts.length,3,'understanding reused, no automatic repair requests');assert.equal(h.payloads.length,0);
});

test('v6 validates the full set, white/no-text variants and distinct scene tasks without relaxing facts',async t=>{
 const h=textFixture();t.after(()=>h.close());const run=await settled(h,h.runtime.textService.submit(h.request,'understand-design').run.id);
 const snap={...run.snapshot,templateVersion:DESIGN_TEMPLATE},raw=designFixture(fixtureOutput({...h.sent[0].data,operation:'plan'}));
 assert.equal(validatePlanOutput(raw,snap,run.understanding).images.length,7);
 const cases=[
  ['missing label position',x=>x.images[1].design.elements.pop()],
  ['icon-only product page',x=>x.images[1].design.subjectMode='局部细节'],
  ['extra fourth card',x=>x.images[1].design.elements.push({...x.images[1].design.elements[1],copyIndex:3})],
  ['out of canvas',x=>x.images[1].design.subjectBox=[.8,.2,.5,.7]],
  ['label over product',x=>x.images[1].design.elements[1].box=[.5,.3,.2,.1]],
  ['card without evidence',x=>x.images[1].design.elements[1].sourceIds=[]],
  ['directions used as facts',x=>x.images[1].design.focusSourceIds=['u1']],
  ['white background with cards',x=>x.images[0].design.elements=[{kind:'图标卡片',copyIndex:-1,sourceIds:['o1'],box:[.01,.01,.1,.1]}]],
  ['white background with a misleading role',x=>x.images[0].design.role='使用情境'],
  ['scene without a situation',x=>x.images[4].design.scene.activity=''],
  ['same question renumbered',x=>x.images[5].design.question=x.images[4].design.question+' 02'],
  ['same scene moved left/right',x=>{x.images[5].design={...structuredClone(x.images[4].design),question:'换到左边是否好看？',subjectBox:[.4,.2,.5,.7]};x.images[5].composition.layout=x.images[4].composition.layout;}],
  ['invented capacity',x=>x.images[1].copy[1].text='500ml'],
  ['foreign reference',x=>x.images[1].referenceIds=['foreign-reference']]
 ];
 for(const [name,mutate] of cases){const bad=structuredClone(raw);mutate(bad);assert.throws(()=>validatePlanOutput(bad,snap,run.understanding),name);}
 const differentContext=structuredClone(raw);
 differentContext.images[5].design={...structuredClone(differentContext.images[4].design),question:'如何在通勤中自然携带？',scene:{kind:'人物互动',setting:'通勤路上',activity:'自然手持，不展示开合动作'}};
 differentContext.images[5].composition.layout=differentContext.images[4].composition.layout;
 assert.equal(validatePlanOutput(differentContext,snap,run.understanding).images.length,7,'distinct uses can share the same layout and scene category');
 const noText=structuredClone(raw);
 for(const x of noText.images){x.copy=[];x.design.elements=x.design.elements.filter(e=>['图标卡片','局部放大'].includes(e.kind)).map(e=>({...e,copyIndex:-1}));}
 assert.equal(validatePlanOutput(noText,{...snap,settings:{...snap.settings,language:'无文字'}},run.understanding).images.length,7);
 const legacy=structuredClone(raw);legacy.images.forEach(x=>delete x.design);
 assert.equal(validatePlanOutput(legacy,{...snap,templateVersion:DIVERSE_TEMPLATE},run.understanding).images.length,7,'old contract preserved');
 const n=structuredClone(raw);n.images[1].content+='四张等大卡片。';assert.ok(designIssues(n).some(x=>x.code==='DESIGN_CARD_COUNT'));
 const requested=textPrompt('plan',{...snap,name:'耳机',description:'仅桌面，无人物'},run.understanding);
 assert.equal(requested.data.userText,'仅桌面，无人物');assert.ok(requested.system.includes('买家'));assert.ok(requested.system.includes('仅桌面')||requested.system.includes('用户限定桌面'));
});

test('MVP blocks stale settings/references, forged browser plans and unsupported options before image calls',async t=>{
 const h=await harness(t),plan=await h.plan();
 for(const input of [{...h.input},{...h.input,planRunId:plan.id,settings:{...h.input.settings,ratio:'1:1'}},{...h.input,planRunId:plan.id,prompt:'smuggled'}]){
  const r=await h.request('/kits',input,crypto.randomUUID());assert.ok(r.status>=400,JSON.stringify(r));
 }
 const before=h.texts.length;const bad=await h.request('/text-runs',{...h.input,kind:'plan',settings:{...h.input.settings,layouts:['unavailable-layout']}},'unsupported');assert.equal(bad.value.error.code,'LAYOUT_UNAVAILABLE');assert.equal(h.texts.length,before);
 h.runtime.store.updateProduct(h.p.id,{expectedRevision:h.p.revision,name:'changed'});
 const stale=await h.request('/kits',{...h.input,planRunId:plan.id},'stale');assert.equal(stale.value.error.code,'PLAN_SOURCE_CHANGED');assert.equal(h.payloads.length,0);
});

test('MVP pause defaults closed for both models; history remains readable',async t=>{
 const h=await harness(t,{paused:true});const health=(await h.request('/health')).value;assert.equal(health.modelCallsPaused,true);assert.equal(health.ready,false);assert.equal(health.text.paused,true);
 assert.equal((await h.request('/text-runs',{...h.input,kind:'plan'})).value.error.code,'MODEL_CALLS_PAUSED');
 assert.equal((await h.request('/kits',h.input)).value.error.code,'MODEL_CALLS_PAUSED');
 assert.equal((await h.request('/tasks')).status,200);assert.equal(h.payloads.length+h.texts.length,0);
});

test('MVP cancel stops subsequent images and unknown outcomes cannot be retried',async t=>{
 const h=await harness(t,{slow:true}),plan=await h.plan(),r=await h.request('/kits',{...h.input,planRunId:plan.id},'cancel');
 await until(()=>h.payloads.length===1);await h.request(`/tasks/${r.value.task.id}/cancel`,{});await new Promise(r=>setTimeout(r,180));
 assert.equal(h.runtime.store.task(r.value.task.id).state,'canceled');assert.equal(h.payloads.length,1);assert.equal(h.runtime.store.task(r.value.task.id).children.filter(c=>c.result).length,0);
 const u=await harness(t,{unknown:true}),p=await u.plan(),s=await u.request('/kits',{...u.input,planRunId:p.id},'unknown');
 await until(()=>u.runtime.store.task(s.value.task.id).children[0].state==='failed');const task=u.runtime.store.task(s.value.task.id);
 assert.equal(task.children[0].error.outcomeUnknown,true);const retry=await u.request(`/tasks/${task.id}/retry`,{childIds:[task.children[0].id],expectedRevision:task.revision});assert.ok(retry.status>=400);assert.equal(u.payloads.length,1);
 await u.request(`/tasks/${task.id}/cancel`,{});
});

test('text cancellation preserves partial understanding and never advances into planning',async t=>{
 let release;const h=textFixture({transport:async({data})=>{await new Promise(r=>release=r);return fixtureResponse(fixtureOutput(data));}});t.after(()=>h.close());
 const run=h.runtime.textService.submit({...h.request,kind:'plan'},'cancel-text').run;await until(()=>release);
 h.runtime.textService.cancel(run.id);release();await new Promise(r=>setTimeout(r,20));
 assert.equal(h.runtime.textService.get(run.id).state,'canceled');assert.equal(h.sent.length,1);assert.ok(h.runtime.textService.get(run.id).understanding);assert.equal(h.runtime.store.tasks().length,0);
});

test('no-text mode is executed without copy; candidate rejects excessive copy and invented promotion',async t=>{
 const h=textFixture();t.after(()=>h.close());const u=await settled(h,h.runtime.textService.submit(h.request,'u').run.id);
 const raw=fixtureOutput({...h.sent[0].data,operation:'plan'}),snapshot={...u.snapshot,settings:{...u.snapshot.settings,language:'无文字'}};
 raw.images.forEach(i=>i.copy=[]);assert.equal(validatePlanOutput(raw,snapshot,u.understanding).images.length,7);
 const bad=fixtureOutput({...h.sent[0].data,operation:'plan'});bad.images[1].copy[0].text='满300减30';assert.throws(()=>validatePlanOutput(bad,u.snapshot,u.understanding));
 bad.images[1].copy[0].text='这是一段超过十个字的中文长标题';assert.throws(()=>validatePlanOutput(bad,{...u.snapshot,templateVersion:CANDIDATE_TEMPLATE},u.understanding));
 const layout=fixtureOutput({...h.sent[0].data,operation:'plan'});layout.images[1].composition.framing='主体占画面60%，标题高度为画面高度的8%';
 assert.equal(validatePlanOutput(layout,u.snapshot,u.understanding).images.length,7);
 layout.images[1].composition.framing='性能提升60%';assert.throws(()=>validatePlanOutput(layout,u.snapshot,u.understanding));
 const run=await settled(h,h.runtime.textService.submit({...h.request,kind:'plan'},'baseline-plan').run.id);
 h.config.mimo.templateVersion=CANDIDATE_TEMPLATE;
 assert.throws(()=>h.runtime.textService.submit({...h.request,kind:'plan',understandingRunId:run.id},'candidate-stale'),e=>e.code==='TEXT_SOURCE_CHANGED');
});


test('understanding rejection stays failed until explicit stage repair; failure evidence and frozen source survive',async t=>{
 const h=await harness(t,{templateVersion:DIVERSE_TEMPLATE,transformUnderstanding:(out,data)=>{if(!data.repairContext)out.observations[0].text+='塑料';},transformPlan:out=>out.images.forEach((x,i)=>x.composition.layout=PRESENTATIONS[i%PRESENTATIONS.length])});
 const r=h.runtime.kitRuns.submit({items:[h.input]},'repair-understanding').runs[0];
 await until(()=>h.runtime.kitRuns.get(r.id).state==='failed');
 const failed=h.runtime.kitRuns.get(r.id);assert.equal(failed.errors.understand,'UNSUPPORTED_PRODUCT_CLAIM');assert.equal(h.texts.length,1);assert.equal(h.payloads.length,0);
 h.runtime.store.updateProduct(h.p.id,{expectedRevision:h.p.revision,name:'Changed after failure'});
 const retried=await h.request(`/kit-runs/${r.id}/retry`,{stage:'understand',expectedUpdatedAt:failed.updatedAt});assert.equal(retried.status,200,JSON.stringify(retried));
 const duplicate=await h.request(`/kit-runs/${r.id}/retry`,{stage:'understand',expectedUpdatedAt:failed.updatedAt});assert.equal(duplicate.status,409);
 await until(()=>['succeeded','failed'].includes(h.runtime.kitRuns.get(r.id).state));
 assert.equal(h.runtime.kitRuns.get(r.id).state,'succeeded',JSON.stringify(h.runtime.kitRuns.get(r.id)));
 assert.equal(h.runtime.textService.get(failed.understandingRunId).state,'failed');assert.equal(h.runtime.store.all('SELECT * FROM text_validation_failures').length,1);
 assert.ok(JSON.parse(h.texts[1].messages[1].content.at(-1).text).repairContext);
 assert.equal(h.payloads.length,7);
});

test('explicit local uploads acquire auditable consent only on submit, not on storage, and replay preserves the old revision',async t=>{
 const h=await harness(t);h.config.allowUserSubmittedReferences=true;
 const asset=h.runtime.store.putAsset(fixturePNG('NEW USER UPLOAD',36,36),{kind:'original'});
 let p=h.runtime.store.createProduct({name:'New uploaded product',facts:structuredClone(h.p.facts)});p=h.runtime.store.addReference(p.id,{assetId:asset.id,role:'product'});
 assert.equal(h.runtime.store.all('SELECT * FROM reference_consents').length,0);
 const input={kind:'assist',items:[{...h.input,productId:p.id,productRevision:p.revision}]};
 const response=await h.request('/kit-runs',input,'consented');assert.equal(response.status,202,JSON.stringify(response));
 assert.deepEqual(h.runtime.store.all('SELECT sha256 FROM reference_consents').map(x=>x.sha256),[asset.sha256]);
 await until(()=>h.runtime.kitRuns.get(response.value.runs[0].id).state==='succeeded');
 h.runtime.store.updateProduct(p.id,{expectedRevision:p.revision,name:'Later edit'});
 assert.equal((await h.request('/kit-runs',input,'consented')).value.duplicate,true);
 await h.restart();assert.equal(h.runtime.store.all('SELECT * FROM reference_consents').length,1);
});

test('canvas-relative approximate percentages are layout instructions; product percentages remain guarded',async t=>{
 const h=await harness(t,{templateVersion:DIVERSE_TEMPLATE,transformPlan:out=>out.images.forEach((x,i)=>{x.composition.layout=PRESENTATIONS[i%PRESENTATIONS.length];x.composition.framing+='，主体占画面约70%';})}),p=await h.plan();assert.equal(p.state,'succeeded');
 const raw={visual:p.output.visual,images:p.output.images.map(({id,subjectBox,ratio,size,...x})=>x)};
 raw.images[0].composition.framing='主体占据画面中央约60%高度，主体范围46%-94%宽度，14%-90%高度；两个区域各占约40%宽度';
 assert.doesNotThrow(()=>validatePlanOutput(raw,p.snapshot,p.understanding));
 raw.images[0].composition.framing+='，保温效率提高70%';assert.throws(()=>validatePlanOutput(raw,p.snapshot,p.understanding),e=>e.code==='UNSUPPORTED_PRODUCT_CLAIM');
});

test('explicit product restoration consents only the chosen original; modern correction honors text and existing detail layouts',async t=>{
 const h=await harness(t);h.config.allowUserSubmittedReferences=true;
 const plan=await h.plan(),s=await h.request('/kits',{...h.input,planRunId:plan.id},'correction-consent-source'),task=await h.done(s.value.task.id),result=task.children[0].result;
 const original=h.runtime.store.putAsset(fixturePNG('NEW RESTORATION PHOTO',36,36),{kind:'original'});
 assert.equal(h.runtime.store.get('SELECT * FROM reference_consents WHERE asset_id=?',original.id),undefined);
 const restored=await h.request(`/results/${result.id}/corrections`,{kind:'restore',expectedVersion:1,originalAssetId:original.id},'restore-consented');assert.equal(restored.status,201,JSON.stringify(restored));
 await h.done(restored.value.task.id);assert.equal(h.runtime.store.get('SELECT action FROM reference_consents WHERE asset_id=?',original.id).action,'submit-product-restore');
 const changed=await h.request(`/results/${result.id}/corrections`,{kind:'modify',expectedVersion:2,instruction:'保留局部放大，把标题替换为蓝色杯身'},'new-correction-contract');assert.equal(changed.status,201);await h.done(changed.value.task.id);
 const prompt=h.payloads.at(-1).prompt;assert.match(prompt,/蓝色杯身/);assert.match(prompt,/仅在用户明确要求时修改/);assert.doesNotMatch(prompt,/文字由图层合成|不得输出拼图|保留原有文字，不额外添加新文字/);
 const after=h.runtime.store.task(task.id);assert.equal(after.children[0].result.versions.length,3);assert.deepEqual(after.children.slice(1),task.children.slice(1));
});

test('validation-rule repair creates a new review record without model calls or changing the failed evidence',async t=>{
 const h=await harness(t),p=await h.plan();
 const raw={visual:p.output.visual,images:p.output.images.map(({id,subjectBox,ratio,size,...x})=>x)};
 h.runtime.store.run("UPDATE text_runs SET state='failed',output_json=NULL,error_code='OLD_VALIDATOR_BUG' WHERE id=?",p.id);
 h.runtime.store.run('INSERT INTO text_validation_failures VALUES(?,?,?,?,?,?,?)',p.id,'plan',p.calls.at(-1).id,JSON.stringify(raw),'[]','OLD_VALIDATOR_BUG',Date.now());
 const before=h.texts.length,r=await h.request(`/text-runs/${p.id}/revalidate`,{},'local-review');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.value.run.state,'succeeded');assert.equal(r.value.run.snapshot.validationReview.sourceRunId,p.id);assert.equal(h.texts.length,before);assert.equal(h.runtime.textService.get(p.id).state,'failed');
 const again=await h.request(`/text-runs/${p.id}/revalidate`,{},'local-review');assert.equal(again.value.run.id,r.value.run.id);
});


test('failed optional style and listing repair independently while retaining generated image versions',async t=>{
 const h=await harness(t,{templateVersion:DIVERSE_TEMPLATE,transformPlan:out=>out.images.forEach((x,i)=>x.composition.layout=PRESENTATIONS[i%PRESENTATIONS.length]),transformAddon:(out,data)=>{if(data.operation==='style'&&!data.repairContext)delete out.basis;}});
 const start=h.runtime.kitRuns.submit({items:[{...h.input,settings:{...h.input.settings,analysis:true,listing:true}}]},'addon-partial').runs[0];
 await until(()=>h.runtime.kitRuns.get(start.id).state==='partial');
 const failed=h.runtime.kitRuns.get(start.id),task=h.runtime.store.task(failed.taskId);assert.equal(failed.errors.style,'TEXT_OUTPUT_INVALID');assert.ok(failed.listing);assert.equal(task.state,'succeeded');
 const ids=task.children.map(c=>c.result.versions.at(-1).assetId);
 h.runtime.kitRuns.retry(start.id,{stage:'style',expectedUpdatedAt:failed.updatedAt});await until(()=>h.runtime.kitRuns.get(start.id).state==='succeeded');
 assert.deepEqual(h.runtime.store.task(task.id).children.map(c=>c.result.versions.at(-1).assetId),ids);assert.equal(h.payloads.length,7);assert.equal(h.texts.filter(p=>JSON.parse(p.messages[1].content.at(-1).text).operation==='understand').length,1);
});

test('v8 rejects internal working notes and pins every required text and region evidence into image requests',async t=>{
 const h=await harness(t,{templateVersion:COMMERCE_TEMPLATE,transformPlan:out=>{designFixture(out);out.images[1].design.elements[1].sourceIds=['wrong-redundant-evidence'];out.images[1].design.elements[2].copyIndex=3;}}),p=await h.plan();assert.equal(p.state,'succeeded',JSON.stringify(p));
 const original=JSON.parse(h.runtime.store.get('SELECT * FROM text_plan_projections WHERE run_id=?',p.id).original_json);
 assert.equal(original.images[1].design.elements[1].sourceIds[0],'wrong-redundant-evidence');assert.deepEqual(p.output.images[1].design.elements.map(e=>e.sourceIds),p.output.images[1].copy.map(c=>c.sourceIds));
 const bad=structuredClone(original);bad.images[1].copy[0].text='包装文字清晰';
 assert.throws(()=>validatePlanOutput(bad,p.snapshot,p.understanding),e=>e.code==='TEXT_COMMERCE_COPY');
 const issues=planRepairIssues(bad,p.snapshot,p.understanding);assert.ok(issues.some(x=>x.path==='images[1].copy[0].text'&&x.code==='COPY_INTERNAL_NOTE'));
 const tooLong=structuredClone(original);tooLong.images[1].copy[0].text='白色鞋面 · 低帮鞋型';assert.ok(planRepairIssues(tooLong,p.snapshot,p.understanding).some(x=>x.path==='images[1].copy[0].text'&&x.code==='COPY_LENGTH'));
 const extra=structuredClone(original);extra.images.push(structuredClone(extra.images[1]));assert.ok(planRepairIssues(extra,p.snapshot,p.understanding).some(x=>x.code==='PLAN_SLOT_COUNT'));
 const mismatched=structuredClone(original);mismatched.images[1].content='安排三张卡片';mismatched.images[1].copy.pop();const normalized=validatePlanOutput(mismatched,p.snapshot,p.understanding);assert.match(normalized.images[1].content,/安排2张信息卡片/);assert.equal(normalized.images[1].copy.length,3);assert.equal(mismatched.images[1].content,'安排三张卡片','raw model evidence retained');
 const duplicate=structuredClone(original);duplicate.images[2].copy[0].text=duplicate.images[1].copy[0].text;assert.ok(planRepairIssues(duplicate,p.snapshot,p.understanding).some(x=>x.code==='COPY_DUPLICATE_TITLE'&&x.otherPath==='images[1].copy[0].text'));

 const old={visual:p.output.visual,images:p.output.images.map(({id,subjectBox,ratio,size,...x})=>structuredClone(x))};old.images[1].copy[0].text='包装文字清晰';
 assert.doesNotThrow(()=>validatePlanOutput(old,{...p.snapshot,templateVersion:RESOLVED_TEMPLATE},p.understanding),'old plans retain their original validation');
 const unsupported=structuredClone(original);unsupported.images[1].copy[0].sourceIds=['invented'];assert.throws(()=>validatePlanOutput(unsupported,p.snapshot,p.understanding),'binding never authorizes invented copy evidence');
 const started=await h.request('/kits',{...h.input,planRunId:p.id},'commerce-images');assert.equal(started.status,201,JSON.stringify(started));const task=await h.done(started.value.task.id);
 for(const image of task.input.settings.workflow03A.plan.images){const prompt=imagePrompt(task.input.settings.workflow03A,image),shot=p.output.images.find(x=>x.id===image.id),spec=prompt.data.commerceRendering;
  assert.deepEqual(spec.requiredText.map(x=>x.text),shot.copy.map(x=>x.text));assert.ok(spec.requiredText.every(x=>x.box&&x.evidence.length));
  assert.equal(spec.typography.family,p.output.visual.font);assert.deepEqual(spec.subject.box,shot.design.subjectBox);assert.match(prompt.system,/完整绘制全部营销文字/);
 }
 assert.equal(h.payloads.length,7);assert.ok(h.payloads.every(x=>x.prompt.includes('commerce-render.1')));
});

test('v7 resolves geometry and declared evidence closure without rewriting copy, preserves raw output and enforces factual guards',async t=>{
 const h=await harness(t,{templateVersion:RESOLVED_TEMPLATE,transformPlan:out=>{designFixture(out);out.images[1].design.subjectBox=[.08,.04,.8,.8];out.images[1].design.elements.forEach(e=>e.box=[.1,.1,.5,.4]);out.images[1].sourceIds=['u1'];}});
 const p=await h.plan();assert.equal(p.state,'succeeded',JSON.stringify(p));assert.equal(designIssues(p.output).length,0);
 const audit=h.runtime.store.get('SELECT * FROM text_plan_projections WHERE run_id=?',p.id);assert.ok(audit);const original=JSON.parse(audit.original_json);
 assert.notDeepEqual(original.images[1].design.subjectBox,p.output.images[1].design.subjectBox);assert.deepEqual(original.images.map(x=>x.copy),p.output.images.map(x=>x.copy));
 const s=await h.request('/kits',{...h.input,planRunId:p.id},'resolved-design');assert.equal(s.status,201,JSON.stringify(s));await h.done(s.value.task.id);assert.match(h.payloads[1].prompt,/layoutSpec/);assert.equal(h.payloads.length,7);
 const raw=structuredClone(original);raw.images[1].copy[0].text='保温24小时';assert.throws(()=>validatePlanOutput(raw,p.snapshot,p.understanding),e=>e.code==='UNSUPPORTED_PRODUCT_CLAIM');
 raw.images[1].copy[0].text='蓝色杯身';raw.images[1].design.focusSourceIds=['invented-evidence'];assert.throws(()=>validatePlanOutput(raw,p.snapshot,p.understanding));
 await h.restart();assert.deepEqual(h.runtime.store.get('SELECT * FROM text_plan_projections WHERE run_id=?',p.id),audit);
});


test('v9 uses exact local typography, keeps original bases and source-aware layers in durable receipts', {skip:process.platform!=='darwin',timeout:90000},async t=>{
 const h=await harness(t,{templateVersion:TYPOGRAPHY_TEMPLATE,transformPlan:out=>{designFixture(out);for(const x of out.images)if(['分区拼版','多视角排版'].includes(x.composition.layout))x.copy.push({text:'左侧轮廓',sourceIds:['o1']},{text:'右侧轮廓',sourceIds:['o1']});}});
 const p=await h.plan();assert.equal(p.state,'succeeded',JSON.stringify(p));
 const raw=JSON.parse(h.runtime.store.get('SELECT original_json FROM text_plan_projections WHERE run_id=?',p.id).original_json);
 const bad=structuredClone(raw);bad.images.find(x=>x.composition.layout==='分区拼版').copy.pop();
 assert.throws(()=>validatePlanOutput(bad,p.snapshot,p.understanding),e=>e.code==='TEXT_PANEL_LABELS');assert.ok(planRepairIssues(bad,p.snapshot,p.understanding).some(x=>x.code==='PANEL_LABELS_REQUIRED'));
 const missing=structuredClone(raw);missing.images[3].copy=[];assert.ok(planRepairIssues(missing,p.snapshot,p.understanding).some(x=>x.code==='COPY_REQUIRED'&&x.path==='images[3].copy'));
 const prompt=textPrompt('plan',{...p.snapshot,layouts:[{id:'split',presentation:'分区拼版',definition:{},reference:{}}]},p.understanding);assert.equal(prompt.data.slotRequirements.find(x=>x.type==='selling').copyMin,3);
 const start=await h.request('/kits',{...h.input,planRunId:p.id},'typography-kit');assert.equal(start.status,201,JSON.stringify(start));
 // Native compilation runs once on this isolated data directory.
 let task;for(let i=0;i<1500;i++){task=h.runtime.store.task(start.value.task.id);if(!['running','queued'].includes(task.state))break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(task.state,'succeeded',JSON.stringify(task.children.map(c=>c.error)));
 const prepared=task.input.settings.workflow03A;
 for(const child of task.children){
  const im=prepared.plan.images.find(x=>x.id===child.slot.key),prompt=imagePrompt(prepared,im);assert.equal(im.textMode,'source-aware-overlay');assert.deepEqual(prompt.data.copy,[]);assert.match(prompt.system,/绝对不要画标题/);
  const v=child.result.versions[0],receipt=JSON.parse(h.runtime.store.get('SELECT receipt_json FROM attempts WHERE id=?',v.attemptId).receipt_json);
  assert.deepEqual(receipt.workflow.layers,typographyLayers(prepared,im));
  const editable=await h.request(`/results/${child.result.id}/layers/1`);assert.equal(editable.status,200);assert.equal(editable.value.available,!!receipt.workflow.layers.length);if(editable.value.available)assert.deepEqual(editable.value.layers,receipt.workflow.layers);
  const original=h.runtime.store.get('SELECT asset_id FROM provider_calls WHERE attempt_id=?',v.attemptId);
  assert.ok(original.asset_id);const base=h.runtime.store.asset(original.asset_id),final=h.runtime.store.asset(v.assetId);
  if(receipt.workflow.layers.length)assert.notEqual(base.sha256,final.sha256);else assert.equal(base.sha256,final.sha256);
  if(prompt.data.panels.length)assert.equal(prompt.data.panels.length,p.output.images.find(x=>x.id===im.id).copy.length-1);
 }
 const assetIds=task.children.map(c=>c.result.versions[0].assetId);await h.restart();assert.deepEqual(h.runtime.store.task(task.id).children.map(c=>c.result.versions[0].assetId),assetIds);assert.equal(h.payloads.length,7);
});


test('v10 gates unclear/rejected inputs before planning and image calls; unknown specs remain allowed',async t=>{
 for(const decision of ['clarify','reject']){
  const h=await harness(t,{templateVersion:BETA_TEMPLATE,transformUnderstanding:u=>{u.observations=[];u.references.forEach(r=>r.observationIds=[]);u.assessment={decision,category:'无法判断',reason:'请补充清晰商品图',buyerQuestions:[]};}});
  const p=await h.plan();assert.equal(p.state,'failed');assert.equal(p.errorCode,decision==='clarify'?'PRODUCT_INPUT_UNCLEAR':'PRODUCT_CONTENT_REJECTED');assert.equal(h.texts.length,1);assert.equal(h.payloads.length,0);
  const denied=await h.request('/kits',{...h.input,planRunId:p.id},'blocked-kit');assert.notEqual(denied.status,201);assert.equal(h.payloads.length,0);assert.equal(h.runtime.store.product(h.p.id).references.length,3);
 }
});

test('v10 allows varied copy and model-planned positions, preserves exact text layers and original v9 rules', {skip:process.platform!=='darwin',timeout:90000},async t=>{
 const h=await harness(t,{templateVersion:BETA_TEMPLATE,transformUnderstanding:u=>{u.assessment={decision:'allow',category:'随行杯',reason:'主体清晰，规格未知不妨碍外观展示',buyerQuestions:['外观怎样','适合怎样的日常场景']};},transformPlan:out=>{
  designFixture(out);
  for(const x of out.images){
   if(x.type==='other'){x.copy=[];x.design.elements=[];}
   for(const e of x.design.elements){if(e.kind==='图标卡片')e.box=[.05,.25+(e.copyIndex-1)*.24,.3,.22];else e.box[3]=Math.max(e.box[3],e.kind==='标题'?.16:.24);}
  }
  out.images[3].copy[0].text='蓝灰配色融入你的日常生活';
  out.images[2].composition.framing='商品完整入镜占约45%高度';out.images[6].composition.framing='交界处占画面中心约50%';
 }});
 const p=await h.plan();assert.equal(p.state,'succeeded',JSON.stringify(p));
 assert.ok(p.output.images.some(i=>i.type==='other'&&!i.copy.length));
 const raw={visual:p.output.visual,images:p.output.images.map(({id,subjectBox,ratio,size,...x})=>x)};
 const selectedRaw=structuredClone(raw),selectedIndex=selectedRaw.images.findIndex(x=>x.type==='selling');
 const chosen={id:'beta-chosen',presentation:selectedRaw.images[selectedIndex].composition.layout,definition:{subjectBox:[.45,.18,.5,.75],textSlots:selectedRaw.images[selectedIndex].design.elements.filter(e=>e.copyIndex>=0).map(e=>({box:[...e.box],maxChars:30,maxLines:2}))}};
 selectedRaw.images.forEach((x,i)=>x.layoutId=i===selectedIndex?chosen.id:null);selectedRaw.images[selectedIndex].design.subjectBox=[.1,.1,.8,.8];
 const selected=validatePlanOutput(selectedRaw,{...p.snapshot,layouts:[chosen]},p.understanding);assert.deepEqual(selected.images[selectedIndex].design.subjectBox,chosen.definition.subjectBox);assert.deepEqual(selected.images[3].design.subjectBox,raw.images[3].design.subjectBox);
 const bad=structuredClone(raw);bad.images[3].copy[0].text='蓝'.repeat(17);assert.throws(()=>validatePlanOutput(bad,p.snapshot,p.understanding),e=>e.code==='TEXT_COPY_TOO_LONG');
 const prompt=textPrompt('plan',p.snapshot,p.understanding);assert.ok(prompt.data.slotRequirements.every(s=>s.copyMin===0));assert.doesNotMatch(prompt.system,/每行.*10字|至少两个分区标签/);
 const start=await h.request('/kits',{...h.input,planRunId:p.id},'beta-kit');assert.equal(start.status,201,JSON.stringify(start));
 let task;for(let i=0;i<1500;i++){task=h.runtime.store.task(start.value.task.id);if(!['queued','running'].includes(task.state))break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(task.state,'succeeded',JSON.stringify(task.children.map(c=>c.error)));
 const prepared=task.input.settings.workflow03A;
 for(const image of prepared.plan.images){assert.equal(image.textMode,'source-aware-overlay');assert.equal(imagePrompt(prepared,image).version,BETA_TEMPLATE+':seedream-base.1');assert.ok(betaLayers(prepared,image).every(l=>l.fontSize>=Math.ceil(Math.min(image.size.width,image.size.height)*24/1080)));}
 assert.equal(h.payloads.length,7);
});

for(const candidate of [11,12])test(`v${candidate} carries product-coordinated color and stable type through planning, execution, layers and restart; rejects unsafe layout before image calls`, {skip:process.platform!=='darwin',timeout:120000},async t=>{
 const previous=await import('../../src/workflow/art-directed-design.js'),next=await import('../../src/workflow/reviewed-design.js');
 const ART_TEMPLATE=candidate===12?next.REVIEWED_TEMPLATE:previous.ART_TEMPLATE,artLayers=candidate===12?next.reviewedLayers:previous.artLayers,studioLock=previous.studioLock;
 const artDirection={titleColor:'#29465B',bodyColor:'#3D505C',textSurfaceColor:'#F7F8FA',paletteReason:'蓝灰商品配深蓝灰文字，统一浅色底',...(candidate===12?{typography:{titlePx:76,bodyPx:36,rationale:'竖幅短标题保持清楚层级'}}:{})};
 const h=await harness(t,{templateVersion:ART_TEMPLATE,transformUnderstanding:u=>{u.assessment={decision:'allow',category:'随行杯',reason:'商品明确',buyerQuestions:['外观怎样','日常如何搭配']};},transformPlan:out=>{
  designFixture(out);out.artDirection=artDirection;
  for(const [i,x] of out.images.entries()){
   x.design.subjectBox=[.08,.35,.84,.6];
   if(x.type==='white'){x.copy=[];x.design.elements=[];continue;}
   x.composition.layout=x.type==='scene'?'人物场景':i===2?'细节特写':'主体展示';x.design.subjectMode=i===2?'局部细节':'完整主体';
   x.copy=[{text:['','蓝调日常','柔和配色','简洁有型','自在随行','日常相伴','清爽蓝色'][i],sourceIds:['o1']}];
   x.design.elements=[{kind:'标题',copyIndex:0,sourceIds:['o1'],box:[.06,.05,.88,.14]}];
  }
 }});
 const p=await h.plan();assert.equal(p.state,'succeeded',JSON.stringify(p));assert.deepEqual(p.output.artDirection,artDirection);
 const raw={visual:p.output.visual,artDirection,images:p.output.images.map(({id,subjectBox,ratio,size,...x})=>x)};
 const pale=structuredClone(raw);pale.artDirection.titleColor='#E4EAF2';assert.throws(()=>validatePlanOutput(pale,p.snapshot,p.understanding),e=>e.code==='TEXT_ART_DIRECTION');
 const tight=structuredClone(raw);tight.images[1].design.elements[0].box=[.06,.05,.88,.04];assert.throws(()=>validatePlanOutput(tight,p.snapshot,p.understanding),e=>e.code==='TEXT_REGION_TOO_SMALL');assert.ok(planRepairIssues(tight,p.snapshot,p.understanding).some(x=>x.code==='TEXT_REGION_TOO_SMALL'));
 const near=structuredClone(raw);near.images[1].design.elements[0].box=[.06,.205,.88,.14];assert.throws(()=>validatePlanOutput(near,p.snapshot,p.understanding),e=>e.code==='TEXT_ART_DIRECTION');
 assert.equal(h.payloads.length,0);
 const request=await h.request('/kits',{...h.input,planRunId:p.id},'art-kit');assert.equal(request.status,201,JSON.stringify(request));let task;for(let i=0;i<1500;i++){task=h.runtime.store.task(request.value.task.id);if(!['queued','running'].includes(task.state))break;await new Promise(r=>setTimeout(r,30));}assert.equal(task.state,'succeeded',JSON.stringify(task.children.map(c=>c.error)));
 const prepared=task.input.settings.workflow03A;assert.deepEqual(prepared.minimumMvp.plan.artDirection,artDirection);
 for(const child of task.children){const image=prepared.plan.images.find(i=>i.id===child.slot.key),prompt=imagePrompt(prepared,image);assert.equal(prompt.version,ART_TEMPLATE+':seedream-base.1');assert.deepEqual(prompt.data.studioLock,studioLock);assert.deepEqual(prompt.data.sharedArtDirection,artDirection);
  const layers=artLayers(prepared,image);if(layers.length){assert.equal(layers[0].color,artDirection.titleColor);assert.equal(layers[0].fontSize,Math.round(Math.min(image.size.width,image.size.height)*(candidate===12?76:72)/1080));assert.ok(prompt.data.textReserve[0].box[2]>layers[0].box[2]);const info=await h.request(`/results/${child.result.id}/layers/1`);assert.deepEqual(info.value.layers,layers);}
 }
 const prompts=h.payloads.map(p=>p.prompt);await h.restart();assert.equal(h.payloads.length,7);assert.deepEqual(h.payloads.map(p=>p.prompt),prompts);
 if(candidate===12){
  const missing=structuredClone(raw);delete missing.artDirection.typography;assert.throws(()=>validatePlanOutput(missing,p.snapshot,p.understanding));
  const badFont=structuredClone(raw);badFont.artDirection.typography.titlePx=40;assert.throws(()=>validatePlanOutput(badFont,p.snapshot,p.understanding));
  const body=structuredClone(prepared);body.minimumMvp.plan.images[1].copy.push({text:'蓝色日常',sourceIds:['o1']});body.minimumMvp.plan.images[1].design.elements.push({kind:'标签',copyIndex:1,sourceIds:['o1'],box:[.06,.21,.88,.08]});assert.equal(artLayers(body,prepared.plan.images[1])[1].fontSize,Math.round(Math.min(prepared.plan.images[1].size.width,prepared.plan.images[1].size.height)*36/1080));
  const title=structuredClone(prepared);title.minimumMvp.plan.images[1].copy[0].text='清爽蓝色融入日常';title.minimumMvp.plan.images[1].design.elements[0].box=[.06,.04,.3,.3];assert.throws(()=>artLayers(title,prepared.plan.images[1]),/TEXT_REGION_TOO_SMALL/);
  title.minimumMvp.plan.images[1].copy[0].text='清爽蓝色\n融入日常';title.minimumMvp.plan.images[1].design.elements[0].box[2]=.36;assert.equal(artLayers(title,prepared.plan.images[1])[0].text,'清爽蓝色\n融入日常');
  h.runtime.quality.enqueue(task.id);const reviewRow=h.runtime.store.get('SELECT snapshot_json FROM image_reviews WHERE task_id=? LIMIT 1',task.id),qs=JSON.parse(reviewRow.snapshot_json);
  assert.deepEqual(qs.quality.sharedArtDirection,artDirection);assert.equal(qs.quality.kitShots.length,7);
  const {qualityPrompt}=await import('../../backend/integration/quality-review.mjs');const qp=qualityPrompt(qs);assert.equal(qp.data.version,'image-review.3');assert.equal(qp.data.reviewCoverage.wholeSetPixelsProvided,false);assert.equal(qp.data.reviewCoverage.listingProvided,false);
  h.runtime.quality.cancel(task.id);assert.equal(h.payloads.length,7,'review never starts image generation');
  const result=task.children[1].result,correction=await h.request(`/results/${result.id}/corrections`,{kind:'modify',expectedVersion:1,instruction:'将标题移到左上空白处，保持商品和背景'},'v12-correction');assert.equal(correction.status,201,JSON.stringify(correction));const corrected=await h.done(correction.value.task.id);assert.equal(corrected.state,'succeeded');
  assert.equal(corrected.input.settings.correction.promptVersion,'integration-correction.4');assert.deepEqual(corrected.input.settings.correction.sharedArtDirection,artDirection);assert.match(h.payloads.at(-1).prompt,/v12定向修正约束/);assert.match(h.payloads.at(-1).prompt,/typography/);assert.equal(h.runtime.store.result(result.id).versions.length,2);assert.equal(h.runtime.store.result(result.id).versions[0].assetId,result.versions[0].assetId);
 }
});

for(const candidate of [12,13,14])test(`v${candidate} exact four-image kit keeps counts through execution and rejects zero`, {skip:process.platform!=='darwin',timeout:120000},async t=>{
 const previous=await import('../../src/workflow/art-directed-design.js'),next=await import('../../src/workflow/reviewed-design.js');
 const ART_TEMPLATE=candidate===14?'ecommerce-kit.14':candidate===13?'ecommerce-kit.13':candidate===12?next.REVIEWED_TEMPLATE:previous.ART_TEMPLATE,artLayers=candidate===12?next.reviewedLayers:previous.artLayers,studioLock=previous.studioLock;
 const artDirection={titleColor:'#29465B',bodyColor:'#3D505C',textSurfaceColor:'#F7F8FA',paletteReason:'蓝灰商品配深蓝灰文字，统一浅色底',...(candidate>=12?{typography:{titlePx:76,bodyPx:36,rationale:'竖幅短标题保持清楚层级'}}:{})};
 const h=await harness(t,{templateVersion:ART_TEMPLATE,transformUnderstanding:u=>{u.assessment={decision:'allow',category:'随行杯',reason:'商品明确',buyerQuestions:['外观怎样','日常如何搭配']};},transformPlan:out=>{
  designFixture(out);out.artDirection=artDirection;
  for(const [i,x] of out.images.entries()){
   x.design.subjectBox=[.08,.35,.84,.6];
   if(x.type==='white'){x.copy=[];x.design.elements=[];if(candidate===14)x.intent={buyerQuestion:'看清外观',buyerTakeaway:'识别商品',depiction:'appearance',actor:'none',action:'摆放',productRelation:'独立展示',visibleProof:['完整商品'],copyMeanings:[]};continue;}
   x.composition.layout=x.type==='scene'?'人物场景':i===2?'细节特写':'主体展示';x.design.subjectMode=i===2?'局部细节':'完整主体';
   x.copy=[{text:['','蓝调日常','柔和配色','简洁有型','自在随行','日常相伴','清爽蓝色'][i],sourceIds:['o1']}];
   x.design.elements=[{kind:'标题',copyIndex:0,sourceIds:['o1'],box:[.06,.05,.88,.14]}];
   if(candidate===14)x.intent={buyerQuestion:x.design.question,buyerTakeaway:x.purpose,depiction:x.type==='scene'?'in-use':'feature',actor:x.type==='scene'?'person':'none',action:x.type==='scene'?'握持杯子':'摆放',productRelation:x.type==='scene'?'手握杯身':'独立展示',visibleProof:['主体轮廓清楚'],copyMeanings:[{copyIndex:0,meaning:x.copy[0].text,kind:'mood'}]};
  }
 }});
 h.input.settings.counts={white:1,selling:1,scene:1,other:1};
 const p=await h.plan();assert.equal(p.state,'succeeded',JSON.stringify(p));assert.deepEqual(p.output.images.map(x=>x.type),['white','selling','scene','other']);
 if(candidate===13){
  const spatial=structuredClone(p.output);for(const image of spatial.images){delete image.id;delete image.subjectBox;delete image.ratio;delete image.size;}
  spatial.images[1].composition.framing='商品置于中下部占约55%';spatial.images[2].composition.framing='上区局部占约45%，下区整机占约45%';spatial.images[1].design.elements[0].sourceIds=[];
  const fixed=validatePlanOutput(spatial,p.snapshot,p.understanding);assert.deepEqual(fixed.images[1].design.elements[0].sourceIds,fixed.images[1].copy[0].sourceIds);
  for(const unsupported of ['商品含棉55%','降噪效果55%','商品置于中下部占约55%棉']){const bad=structuredClone(spatial);bad.images[1].composition.framing=unsupported;assert.throws(()=>validatePlanOutput(bad,p.snapshot,p.understanding),e=>e.code==='UNSUPPORTED_PRODUCT_CLAIM');}
 }
 const r=await h.request('/kits',{...h.input,planRunId:p.id},'four-kit');assert.equal(r.status,201,JSON.stringify(r));let task;for(let i=0;i<1500;i++){task=h.runtime.store.task(r.value.task.id);if(!['queued','running'].includes(task.state))break;await new Promise(r=>setTimeout(r,30));}assert.equal(task.state,'succeeded',JSON.stringify(task.children.map(c=>c.error)));assert.equal(task.children.length,4);assert.equal(h.payloads.length,4);
 if(candidate>=13){const rows=h.runtime.store.all('SELECT * FROM adaptive_compositions');assert.equal(rows.length,3);assert.ok(rows.every(r=>JSON.parse(r.layout_json).audit.commercialAcceptance===false));h.runtime.quality.enqueue(task.id);const q=JSON.parse(h.runtime.store.get('SELECT snapshot_json FROM image_reviews WHERE task_id=? LIMIT 1',task.id).snapshot_json);assert.equal(q.quality.outputs.length,Math.min(4,6-q.references.length));assert.equal(q.quality.totalImages,4);h.runtime.quality.cancel(task.id);}
 if(candidate===14){
  assert.ok(h.texts.some(p=>JSON.parse(p.messages[1].content.at(-1).text).operation==='plan-review'));
  assert.ok(h.payloads.every(p=>p.prompt.includes('visibleProof')));
  const result=task.children[2].result;
  const c=await h.request(`/results/${result.id}/corrections`,{kind:'modify',expectedVersion:1,instruction:'修正佩戴关系，保留实际使用任务'},'intent-correct');assert.equal(c.status,201);
  const corrected=await h.done(c.value.task.id);assert.equal(corrected.state,'succeeded');assert.equal(corrected.input.settings.correction.promptVersion,'integration-correction.5');assert.deepEqual(corrected.input.settings.correction.originalIntent,p.output.images[2].intent);assert.match(h.payloads.at(-1).prompt,/originalIntent/);
 }
 const zero=await h.request('/text-runs',{...h.input,kind:'plan',settings:{...h.input.settings,counts:{white:0,selling:0,scene:0,other:0}}},'zero-kit');assert.equal(zero.status,400);assert.equal(h.payloads.length,candidate===14?5:4);
 if(candidate===13){
  const store=h.runtime.store,raw={...p.output,images:p.output.images.map(({id,subjectBox,ratio,size,...x})=>x)};
  store.run("UPDATE text_runs SET state='failed',output_json=NULL,error_code='OLD_VALIDATOR_BUG' WHERE id=?",p.id);
  store.run('INSERT INTO text_validation_failures VALUES(?,?,?,?,?,?,?)',p.id,'plan',p.calls.at(-1).id,JSON.stringify(raw),'[]','OLD_VALIDATOR_BUG',Date.now());
  const flow=h.runtime.kitRuns.submit({items:[h.input]},'local-reuse-flow').runs[0];
  store.run("UPDATE kit_runs SET state='failed',stage='plan',plan_id=?,understand_id=?,errors_json=? WHERE id=?",p.id,p.id,JSON.stringify({plan:'OLD_VALIDATOR_BUG'}),flow.id);
  const before=h.texts.length,failed=h.runtime.kitRuns.get(flow.id);h.runtime.kitRuns.retry(flow.id,{stage:'plan',expectedUpdatedAt:failed.updatedAt});
  await until(()=>h.runtime.kitRuns.get(flow.id).planRunId);const reused=h.runtime.kitRuns.get(flow.id);h.runtime.kitRuns.cancel(flow.id);
  assert.equal(h.runtime.textService.get(reused.planRunId).snapshot.validationReview.sourceRunId,p.id);assert.equal(h.texts.length,before);assert.equal(h.payloads.length,4);assert.equal(h.runtime.textService.get(p.id).state,'failed');
 }
});

test('automatic whole-set review waits for failed images to be recovered',async t=>{
 const h=await harness(t,{failOne:true});h.config.qualityReviewEnabled=true;
 const started=h.runtime.kitRuns.submit({items:[h.input]},'partial-no-auto-review');
 let run=await until(()=>{const r=h.runtime.kitRuns.get(started.runs[0].id);return r.state==='partial'&&r;});
 assert.equal(run.quality.state,'unreviewed');assert.equal(h.texts.filter(x=>JSON.parse(x.messages[1].content.at(-1).text).operation==='quality').length,0);
 h.runtime.quality.enqueue(run.taskId);
 const previous=await until(()=>{const q=h.runtime.quality.view(run.taskId);return q.items.length&&q.items.every(i=>i.state==='succeeded')&&q.items.map(i=>i.id);});
 const task=h.runtime.store.task(run.taskId),child=task.children.find(c=>c.state==='failed');
 h.runtime.store.retry(task.id,{childIds:[child.id],expectedRevision:task.revision});
 run=await until(()=>{const r=h.runtime.kitRuns.get(run.id);return r.state==='succeeded'&&r;});assert.equal(run.quality.items.filter(i=>!i.stale).length,7);assert.ok(run.quality.items.length>previous.length);const current=run.quality.items.filter(i=>!i.stale);assert.equal(new Set(current.map(i=>`${i.resultId}:${i.version}:${i.referenceGroup}`)).size,current.length);assert.ok(run.quality.items.some(i=>previous.includes(i.id)&&i.stale));
});
