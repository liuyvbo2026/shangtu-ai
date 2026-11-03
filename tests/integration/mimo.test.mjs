import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {textFixture,settled,fixtureOutput,fixtureResponse,FAKE_MIMO_KEY} from './mimo-fixtures.mjs';
import {validateUnderstandingOutput,validateAssistOutput,validatePlanOutput} from '../../backend/integration/mimo-contracts.mjs';
import {MIMO_ENDPOINT,MIMO_MODEL} from '../../backend/integration/mimo-provider.mjs';
import {ledgerState} from '../../backend/integration/provider.mjs';
import {loadMimoKey} from '../../backend/integration/credentials.mjs';
import {savedInputFacts,productFromRemote} from '../../src/product-input.js';
import {pendingTextChanged,reusableUnderstanding} from '../../src/text-tools.js';

test('MiMo protocol only: three images, unchanged input, help and seven-slot planning; shared storage and zero image tasks',async t=>{
 const h=textFixture();t.after(()=>h.close());const baseline=JSON.stringify(h.p);
 const first=h.runtime.textService.submit(h.request,'understand');const u=await settled(h,first.run.id);assert.equal(u.state,'succeeded');
 const sent=h.sent[0];assert.equal(sent.url,MIMO_ENDPOINT);assert.equal(sent.payload.model,MIMO_MODEL);assert.equal(sent.payload.messages[1].content.filter(x=>x.type==='image_url').length,3);
 assert.deepEqual(sent.payload.response_format,{type:'json_object'});assert.equal(sent.payload.thinking.type,'disabled');assert.equal(sent.options.redirect,'error');
 assert.equal(sent.data.userText,h.request.description);assert.equal(sent.payload.tools,undefined);assert.equal(sent.options.headers['api-key'],FAKE_MIMO_KEY);
 const duplicate=h.runtime.textService.submit(h.request,'understand');assert.equal(duplicate.run.id,u.id);assert.equal(h.sent.length,1);
 const a=await settled(h,h.runtime.textService.submit({...h.request,kind:'assist',understandingRunId:u.id},'assist').run.id);
 assert.equal(a.state,'succeeded');assert.ok(a.output.text.startsWith(h.request.description));
 const p=await settled(h,h.runtime.textService.submit({...h.request,kind:'plan',understandingRunId:u.id},'plan').run.id);
 assert.equal(p.state,'succeeded');assert.equal(p.output.images.length,7);assert.deepEqual(p.output.images.reduce((x,i)=>(x[i.type]=(x[i.type]||0)+1,x),{}),h.request.settings.counts);
 assert.equal(h.sent.length,3);assert.ok(h.sent.slice(1).every(s=>s.payload.messages[1].content.every(x=>x.type==='text')));
 assert.equal(JSON.stringify(h.runtime.store.product(h.p.id)),baseline);assert.equal(h.runtime.store.tasks().length,0);assert.equal(h.runtime.store.get('SELECT count(*) AS n FROM provider_calls').n,0);
 const persisted=JSON.stringify(h.runtime.store.all('SELECT * FROM text_runs'))+JSON.stringify(h.runtime.store.all('SELECT * FROM text_calls'));
 assert.ok(!persisted.includes(FAKE_MIMO_KEY));assert.ok(!persisted.includes('SYNTHETIC_REASONING_MUST_NOT_BE_SAVED'));assert.ok(!persisted.includes('data:image'));
 assert.ok(ledgerState(h.runtime.store,h.config).reservedCny>0);assert.ok(ledgerState(h.runtime.store,h.config).reservedCny<.02);
});

test('MiMo validation rejects source and business errors without a model call',async t=>{
 const h=textFixture();t.after(()=>h.close());const run=await settled(h,h.runtime.textService.submit(h.request,'fixture').run.id),snapshot=run.snapshot,u=run.understanding;
 for(const mutate of [x=>x.extra=true,x=>x.observations[0].referenceIds=['foreign'],x=>x.userInformation[0].quote='材质玻璃',x=>x.userInformation[0].kind='fact',x=>x.observations[0].text='500ml保温杯',x=>x.references.pop(),x=>x.unknowns.pop(),x=>x.observations.push({...x.observations[0]})]){
  const bad=structuredClone(u);mutate(bad);assert.throws(()=>validateUnderstandingOutput(bad,snapshot));
 }
 const plan=fixtureOutput({...h.sent[0].data,operation:'plan'});
 for(const mutate of [x=>x.images.pop(),x=>x.images[0].type='scene',x=>x.images[1].copy[0].text='304不锈钢保温',x=>x.images[1].copy[0].sourceIds=['u1'],x=>x.images[1].referenceIds=x.images[1].referenceIds.slice(1),x=>x.images[1].sourceIds=['made-up'],x=>x.images[1].purpose=x.images[0].purpose,x=>x.images[1].composition=x.images[0].composition,x=>x.images[0].copy=[{text:'蓝色',sourceIds:['o1']}],x=>x.images[1].copy[0].text='字'.repeat(61)]){
  const bad=structuredClone(plan);mutate(bad);assert.throws(()=>validatePlanOutput(bad,snapshot,u));
 }
 const conflict=structuredClone(u);conflict.conflicts=[{sourceIds:['o1'],reason:'测试冲突'}];assert.throws(()=>validatePlanOutput(plan,snapshot,conflict));
 assert.throws(()=>validateAssistOutput({suggestions:[{text:'容量500ml',sourceIds:['o1']}]},snapshot,u));
 assert.throws(()=>validateAssistOutput({suggestions:[{text:'蓝色',sourceIds:['o1']}]},{...snapshot,description:'字'.repeat(1000)},u));
});

for(const [name,transport,code,unknown] of [
 ['401',()=>new Response('SECRET UPSTREAM BODY',{status:401}),'MIMO_AUTH',false],
 ['429',()=>new Response('SECRET UPSTREAM BODY',{status:429}),'MIMO_RATE_LIMIT',false],
 ['503',()=>new Response('SECRET UPSTREAM BODY',{status:503}),'MIMO_OUTCOME_UNKNOWN',true],
 ['network',()=>{throw Error('SECRET UPSTREAM ERROR');},'MIMO_OUTCOME_UNKNOWN',true],
 ['usage missing',({data})=>fixtureResponse(fixtureOutput(data),{usage:false}),'MIMO_USAGE_UNKNOWN',true],
 ['truncated',({data})=>fixtureResponse(fixtureOutput(data),{finish:'length'}),'TEXT_OUTPUT_TRUNCATED',false],
 ['bad JSON',()=>fixtureResponse('{'),'TEXT_OUTPUT_INVALID',false],
 ['bad schema',()=>fixtureResponse({madeUp:true}),'TEXT_OUTPUT_INVALID',false],
 ['unsupported spec',({data})=>{const v=fixtureOutput(data);v.observations[0].text='500ml不锈钢';return fixtureResponse(v);},'UNSUPPORTED_PRODUCT_CLAIM',false]
])test(`MiMo ${name}: durable safe failure, no automatic retry or fallback`,async t=>{
 const h=textFixture({transport});t.after(()=>h.close());const run=await settled(h,h.runtime.textService.submit(h.request,'fail').run.id);
 assert.equal(run.state,'failed');assert.equal(run.errorCode,code);assert.equal(run.output,null);assert.equal(h.sent.length,1);assert.equal(ledgerState(h.runtime.store,h.config).unknown,unknown);
 assert.ok(!JSON.stringify(run).includes('SECRET'));assert.equal(h.runtime.store.tasks().length,0);
 assert.equal(h.runtime.textService.submit(h.request,'fail').run.id,run.id);assert.equal(h.sent.length,1);
 if(unknown)assert.throws(()=>h.runtime.textService.submit(h.request,'next'),e=>e.code==='BILLING_UNKNOWN');
});

test('rejected structured output is retained privately for diagnosis without applying or repeating it',async t=>{
 const h=textFixture({transport:()=>fixtureResponse({madeUp:true})});t.after(()=>h.close());
 const run=await settled(h,h.runtime.textService.submit(h.request,'diagnostic').run.id);
 const failure=h.runtime.store.get('SELECT * FROM text_validation_failures WHERE run_id=?',run.id);
 assert.equal(run.state,'failed');assert.equal(run.output,null);assert.equal(run.understanding,null);
 assert.deepEqual(JSON.parse(failure.output_json),{madeUp:true});assert.ok(JSON.parse(failure.issues_json).length>0);
 assert.equal(failure.call_id,run.calls[0].id);assert.equal(h.sent.length,1);
 assert.ok(!JSON.stringify(run).includes('madeUp'));assert.ok(!JSON.stringify(failure).includes(FAKE_MIMO_KEY));
 assert.ok(!JSON.stringify(failure).includes('SYNTHETIC_REASONING_MUST_NOT_BE_SAVED'));
 h.runtime.textService.submit(h.request,'diagnostic');assert.equal(h.sent.length,1);
});

test('failed planning may explicitly reuse its valid understanding with the same understanding template',async t=>{
 const h=textFixture({transport:({data,sent})=>{
  if(data.operation==='plan'&&sent.length<=3)return fixtureResponse({madeUp:true});
  const output=fixtureOutput(data);for(const image of output.images??[])for(const copy of image.copy)copy.text=image.purpose;
  return fixtureResponse(output);
 }});t.after(()=>h.close());
 h.config.mimo.templateVersion='ecommerce-kit.2';
 const failed=await settled(h,h.runtime.textService.submit({...h.request,kind:'plan'},'failed-plan').run.id);
 assert.equal(failed.state,'failed');assert.ok(failed.understanding);assert.equal(h.sent.length,2);
 h.config.mimo.templateVersion='ecommerce-kit.4';
 const second=await settled(h,h.runtime.textService.submit({...h.request,kind:'plan',understandingRunId:failed.id,repairRunId:failed.id},'explicit-plan-fix').run.id);
 assert.equal(second.state,'failed');assert.ok(second.understanding);assert.equal(second.calls.length,1);assert.equal(second.calls[0].operation,'plan');
 const summaries=h.runtime.textService.list(),context={...h.request,templateVersion:'ecommerce-kit.4'};
 assert.equal(reusableUnderstanding(summaries,context).id,second.id);
 for(const changed of [{productId:'other'},{productRevision:999},{description:'新资料'},{templateVersion:'mimo-text.1'}])assert.equal(reusableUnderstanding(summaries,{...context,...changed}),undefined);
 const next=await settled(h,h.runtime.textService.submit({...h.request,kind:'plan',understandingRunId:second.id},'explicit-plan-fix-again').run.id);
 assert.equal(next.state,'succeeded');assert.equal(h.sent.length,4);assert.equal(h.sent[2].data.operation,'plan');assert.equal(h.sent[3].data.operation,'plan');
 assert.ok(h.sent[2].data.allowedSourceIds.includes('o1'));assert.ok(!h.sent[2].data.allowedSourceIds.includes(h.p.references[0].id));
 assert.equal(h.sent[2].data.slotRequirements.length,7);
 assert.equal(h.sent[2].data.repairContext.fromRunId,failed.id);
 assert.ok(!JSON.stringify(next).includes('madeUp'));assert.equal(next.snapshot.planRepair.fromRunId,second.id);
 h.config.mimo.templateVersion='mimo-text.1';
 assert.throws(()=>h.runtime.textService.submit({...h.request,kind:'plan',understandingRunId:failed.id},'incompatible'),e=>e.code==='TEXT_SOURCE_CHANGED');
});

test('MiMo readiness, authorization, stale inputs and cumulative reservation gates precede paid calls',async t=>{
 const noKey=textFixture({mimoKey:''});t.after(()=>noKey.close());assert.throws(()=>noKey.runtime.textService.submit(noKey.request,'nokey'),e=>e.code==='MIMO_NOT_READY');assert.equal(noKey.sent.length,0);
 const low=textFixture({config:{budgetCny:.2}});t.after(()=>low.close());const r=await settled(low,low.runtime.textService.submit(low.request,'low').run.id);assert.equal(r.errorCode,'BUDGET_LIMIT');assert.equal(low.sent.length,0);
 const h=textFixture();t.after(()=>h.close());assert.throws(()=>h.runtime.textService.submit({...h.request,description:'changed'},'stale'),e=>e.code==='REVISION_CONFLICT');
 const r1=await settled(h,h.runtime.textService.submit(h.request,'one').run.id);
 assert.throws(()=>h.runtime.textService.submit({...h.request,kind:'plan'},'one'),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const p=h.runtime.store.updateProduct(h.p.id,{expectedRevision:h.p.revision,name:'changed'});
 assert.throws(()=>h.runtime.textService.submit({...h.request,productRevision:p.revision,kind:'plan',understandingRunId:r1.id},'bad-source'),e=>e.code==='TEXT_SOURCE_CHANGED');
 h.config.mimo.authorizedReferenceHashes=[];assert.throws(()=>h.runtime.textService.submit({...h.request,productRevision:p.revision},'unauthorized'));
 assert.equal(h.sent.length,1);
});

test('MiMo restart restores outputs and marks interrupted calls unknown without replay',async t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mimo-restart-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const h=textFixture({dataDir:dir});const r=await settled(h,h.runtime.textService.submit(h.request,'saved').run.id);const calls=h.runtime.store.all('SELECT * FROM text_calls');
 h.runtime.store.run("UPDATE text_runs SET state='running' WHERE id=?",r.id);h.runtime.store.run("UPDATE text_calls SET state='sent' WHERE id=?",calls[0].id);await h.close();
 const restored=textFixture({dataDir:dir});t.after(()=>restored.close());const found=restored.runtime.textService.get(r.id);
 assert.equal(found.state,'failed');assert.equal(found.errorCode,'PROCESS_INTERRUPTED');assert.deepEqual(found.understanding,r.understanding);assert.equal(found.calls[0].state,'unknown');assert.equal(restored.sent.length,0);
});

test('MiMo key loader stays separate, excludes Token Plan and insecure files',t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mimo-key-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'.private'));
 assert.equal(loadMimoKey(dir,{}),'');assert.equal(loadMimoKey(dir,{ARK_API_KEY:FAKE_MIMO_KEY}),'');
 assert.throws(()=>loadMimoKey(dir,{MIMO_API_KEY:'tp-SYNTHETIC_TOKEN_PLAN'}));
 const file=path.join(dir,'.private','mimo-api-key');fs.writeFileSync(file,FAKE_MIMO_KEY,{mode:0o600});assert.equal(loadMimoKey(dir,{}),FAKE_MIMO_KEY);
 fs.chmodSync(file,0o644);assert.throws(()=>loadMimoKey(dir,{}));
});

test('AI help provenance survives save/reload and cannot promote its own additions to user facts',async t=>{
 const h=textFixture();t.after(()=>h.close());const run=await settled(h,h.runtime.textService.submit({...h.request,kind:'assist'},'help-origin').run.id);
 const local=productFromRemote(h.p);local.inputText=run.output.text;local.aiAssistance={runId:run.id,text:run.output.text};
 const p=h.runtime.store.updateProduct(h.p.id,{expectedRevision:h.p.revision,facts:savedInputFacts(local,h.p.facts)});
 assert.equal(productFromRemote(p).aiAssistance.runId,run.id);assert.equal(p.facts.legacy.kept,'LEGACY_PRESERVED');
 const next=await settled(h,h.runtime.textService.submit({...h.request,productRevision:p.revision,description:run.output.text},'after-help').run.id);
 assert.equal(next.snapshot.sourceUserText,h.request.description);
 const bad=structuredClone(next.understanding);bad.userInformation=[{id:'u1',kind:'fact',quote:'展示蓝色杯身的外观与轮廓'}];
 assert.throws(()=>validateUnderstandingOutput(bad,next.snapshot),e=>e.code==='UNSUPPORTED_PRODUCT_CLAIM');
});

test('planning respects 20-slot counts, language, unique copy and declared facts',async t=>{
 const h=textFixture();t.after(()=>h.close());const r=await settled(h,h.runtime.textService.submit(h.request,'slots').run.id);
 const p=fixtureOutput({...h.sent[0].data,operation:'plan'});
 const repeated=structuredClone(p);repeated.images[2].copy=structuredClone(repeated.images[1].copy);assert.throws(()=>validatePlanOutput(repeated,r.snapshot,r.understanding),e=>e.code==='TEXT_DUPLICATE_IMAGE');
 assert.throws(()=>validatePlanOutput(p,{...r.snapshot,settings:{...r.snapshot.settings,language:'英文'}},r.understanding),e=>e.code==='TEXT_LANGUAGE_MISMATCH');
 const chinese=structuredClone(p);chinese.images[1].copy[0].text='容量五百毫升';assert.throws(()=>validatePlanOutput(chinese,r.snapshot,r.understanding),e=>e.code==='UNSUPPORTED_PRODUCT_CLAIM');
 const letters=[...'甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉'];
 const many={...p,images:letters.map(k=>({...structuredClone(p.images[1]),type:'other',purpose:`方案${k}`,content:`蓝色杯身取景${k}`,composition:{angle:'参考视角',framing:`布景${k}`,background:'浅色'},copy:[{text:`外观${k}`,sourceIds:['o1']}]}))};
 const result=validatePlanOutput(many,{...r.snapshot,settings:{...r.snapshot.settings,counts:{white:0,selling:0,scene:0,other:20}}},r.understanding);
 assert.equal(result.images.length,20);
});

test('concurrent requests and timeout do not send duplicate paid requests',async t=>{
 const h=textFixture({timeoutMs:20,transport:({options})=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('SYNTHETIC_TIMEOUT')),{once:true}))});t.after(()=>h.close());
 const one=h.runtime.textService.submit(h.request,'inflight');
 assert.equal(h.runtime.textService.submit(h.request,'inflight').run.id,one.run.id);
 assert.throws(()=>h.runtime.textService.submit(h.request,'second'),e=>e.code==='TEXT_BUSY');
 const r=await settled(h,one.run.id);assert.equal(r.errorCode,'MIMO_OUTCOME_UNKNOWN');assert.equal(h.sent.length,1);
});

test('shared ledger includes prior image reservation and text usage/unknown reservations',()=>{
 const fake={all(sql){return sql.includes('FROM provider_calls')?[{state:'received',reserved_cny:1.2}]:[{state:'received',reserved_cny:1.06,cost_cny:.01},{state:'unknown',reserved_cny:1.06,cost_cny:null}];},
  get(sql){return sql.includes('sqlite_master')?(sql.includes('connection_tests')?null:{name:'text_calls'}):{n:sql.includes('text_calls')?1:0};}};
 const state=ledgerState(fake,{budgetId:'same-budget'});assert.equal(state.reservedCny,2.27);assert.equal(state.unknown,true);assert.equal(state.calls,3);
});

test('historical text runs pin reference bytes after the current product removes them',async t=>{
 const h=textFixture();t.after(()=>h.close());const r=await settled(h,h.runtime.textService.submit(h.request,'pin-originals').run.id);
 const original=h.p.references[0];h.runtime.store.removeReference(h.p.id,original.id);
 assert.throws(()=>h.runtime.store.removeAsset(original.assetId),e=>e.code==='ASSET_REFERENCED');
 assert.ok(h.runtime.store.readAsset(r.snapshot.references[0].assetId).length>0);
 assert.equal(h.runtime.store.get('SELECT count(*) AS n FROM text_run_references WHERE run_id=?',r.id).n,3);
});

test('a lost response cannot silently submit the old input after product, text or settings changes',()=>{
 const draft={kind:'assist',product:{serverId:'p',serverRevision:2,refs:['a','b']},description:'原文',settings:{counts:{other:7}}};
 const pending={refs:['a','b'],body:{kind:'assist',productId:'p',productRevision:2,description:'原文',settings:draft.settings}};
 assert.equal(pendingTextChanged(pending,draft),false);
 for(const change of [x=>x.description='新原文',x=>x.kind='plan',x=>x.product.serverId='other-product',x=>x.product.serverRevision++,x=>x.product.refs.reverse(),x=>x.settings.counts.other=8]){
  const next=structuredClone(draft);change(next);assert.equal(pendingTextChanged(pending,next),true);
 }
 assert.equal(pendingTextChanged(null,draft),false);
});


test('explicit unknown-call acknowledgment retains full cost and only unblocks the reviewed receipt',async t=>{
 const h=textFixture({transport:()=>{throw Error('SYNTHETIC_NETWORK_LOSS');}});t.after(()=>h.close());
 const start=h.runtime.textService.submit(h.request,'acknowledgment-test');const run=await settled(h,start.run.id);assert.equal(run.errorCode,'MIMO_OUTCOME_UNKNOWN');
 const call=h.runtime.store.get('SELECT * FROM text_calls WHERE run_id=?',run.id),before=ledgerState(h.runtime.store,h.config);assert.equal(before.unknown,true);
 h.config.acknowledgedUnknownTextCalls=[{callId:call.id,budgetId:h.config.budgetId,reservedCny:call.reserved_cny,disposition:'retain-full-reservation',reviewedAt:new Date().toISOString(),authorization:'SYNTHETIC OWNER AUTHORIZATION'}];
 const after=ledgerState(h.runtime.store,h.config);assert.equal(after.unknown,false);assert.equal(after.reservedCny,before.reservedCny);assert.deepEqual(h.runtime.store.get('SELECT * FROM text_calls WHERE id=?',call.id),call);
 h.config.acknowledgedUnknownTextCalls[0].reservedCny=0;assert.equal(ledgerState(h.runtime.store,h.config).unknown,true);
 h.config.acknowledgedUnknownTextCalls[0].reservedCny=call.reserved_cny;h.config.acknowledgedUnknownTextCalls[0].callId='another-call';assert.equal(ledgerState(h.runtime.store,h.config).unknown,true);
});

test('beta unverified statements cannot become copy evidence even when model labels them fact',async()=>{
 const {validateUnderstandingOutput,sources}=await import('../../backend/integration/mimo-contracts.mjs');
 const {BETA_TEMPLATE}=await import('../../src/workflow/beta-design.js');
 const raw=fixtureOutput({operation:'understand',userText:'保温防漏均未核实',references:[{id:'r1'}]});raw.userInformation[0].kind='fact';raw.assessment={decision:'allow',category:'杯子',reason:'可辨认',buyerQuestions:['外观怎样']};
 const out=validateUnderstandingOutput(raw,{templateVersion:BETA_TEMPLATE,description:'保温防漏均未核实',references:[{id:'r1'}]});
 assert.equal(raw.userInformation[0].kind,'fact');assert.equal(out.userInformation[0].kind,'direction');assert.equal(sources(raw).find(s=>s.id==='u1').kind,'direction');
});
