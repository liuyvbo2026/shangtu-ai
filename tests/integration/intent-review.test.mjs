import test from 'node:test';
import assert from 'node:assert/strict';
import {textFixture,settled,fixtureOutput,fixtureResponse} from './mimo-fixtures.mjs';
import {designFixture} from './design-fixtures.mjs';
import {INTENT_TEMPLATE,intentIssues} from '../../src/workflow/intent-design.js';
import {validateSemanticReview,requireSemanticApproval} from '../../backend/integration/intent-review.mjs';
import {executableTextPlan} from '../../backend/integration/minimum-plan.mjs';
import {textPrompt} from '../../backend/integration/mimo-contracts.mjs';
import {reconcileQuality} from '../../backend/integration/quality-review.mjs';
import {ledgerState} from '../../backend/integration/provider.mjs';
const pass=()=>({status:'pass',reason:'合成协议测试，不代表真实语义质量'});
export const approved=plan=>({verdict:'approved',images:plan.images.map((s,imageIndex)=>({imageIndex,naturalCopy:pass(),useRelation:pass(),evidence:pass(),purpose:pass(),repair:'无修改'})),setDivision:pass()});
function planned(data){
 const out=designFixture(fixtureOutput(data));
 out.artDirection={titleColor:'#29465B',bodyColor:'#3D505C',textSurfaceColor:'#F7F8FA',paletteReason:'蓝灰字',typography:{titlePx:72,bodyPx:34,rationale:'统一字号'}};
 for(const [i,x] of out.images.entries()){
  x.copy=x.type==='white'?[]:[{text:['','蓝调日常','日常相伴','杯身细节'][i],sourceIds:['o1']}];
  x.composition.layout=x.type==='scene'?'环境场景':'主体展示';
  x.design.subjectMode='完整主体';x.design.subjectBox=[.08,.35,.84,.6];
  x.design.elements=x.copy.map((c,copyIndex)=>({kind:'标题',copyIndex,sourceIds:['o1'],box:[.06,.05,.88,.14]}));
  x.intent={buyerQuestion:x.design.question,buyerTakeaway:'看清商品蓝色外观',depiction:x.type==='white'?'appearance':x.type==='scene'?'context':'feature',actor:'none',action:'摆放展示',productRelation:'商品放在台面上',visibleProof:['蓝色杯身完整可见'],copyMeanings:x.copy.map((c,copyIndex)=>({copyIndex,meaning:c.text,kind:'fact'}))};
 }
 return out;
}
function harness(t,review){
 const h=textFixture({transport:({data})=>{
  if(data.operation==='plan-review')return review?review(data):fixtureResponse(approved(data.candidate));
  const out=data.operation==='plan'?planned(data):fixtureOutput(data);
  if(data.operation==='understand')out.assessment={decision:'allow',category:'杯子',reason:'可识别商品',buyerQuestions:['外观如何']};
  return fixtureResponse(out);
 }});h.config.mimo.templateVersion=INTENT_TEMPLATE;h.request.kind='plan';h.request.settings.counts={white:1,selling:1,scene:1,other:1};t.after(()=>h.close());return h;
}
test('v14 semantic approval is durable, binds exact output and is required by image submission',async t=>{
 const h=harness(t),run=await settled(h,h.runtime.textService.submit(h.request,'intent-good').run.id);
 assert.equal(run.state,'succeeded',JSON.stringify(run));assert.deepEqual(h.sent.map(x=>x.data.operation),['understand','plan','plan-review']);
 assert.equal(run.semanticReview.state,'approved');requireSemanticApproval(h.runtime.store,run);
 const pinned=executableTextPlan(h.runtime.store,run,h.request);assert.deepEqual(pinned.plan.images[2].intent,run.output.images[2].intent);
 const changed=structuredClone(run);changed.output.images[2].intent.buyerTakeaway='替换目标';assert.throws(()=>requireSemanticApproval(h.runtime.store,changed),e=>e.code==='SEMANTIC_REVIEW_REQUIRED');
 assert.equal(h.sent[2].payload.messages[1].content.filter(x=>x.type==='image_url').length,0);
 assert.equal(h.runtime.textService.submit(h.request,'intent-good').run.id,run.id);assert.equal(h.sent.length,3);
 const again=await settled(h,h.runtime.textService.submit(h.request,'intent-new').run.id);h.runtime.store.run('DELETE FROM text_semantic_reviews WHERE run_id=?',again.id);
 assert.throws(()=>executableTextPlan(h.runtime.store,again,h.request),e=>e.code==='SEMANTIC_REVIEW_REQUIRED');
});
for(const status of ['fail','uncertain'])test(`v14 ${status} blocks generation, exposes path, and cannot bypass review through local revalidation`,async t=>{
 const h=harness(t,data=>{const r=approved(data.candidate);r.images[2].useRelation={status,reason:'场景没有表现要求的实际使用关系'};r.images[2].repair='保留原用途，重新规划实际动作';return fixtureResponse(r);});
 const run=await settled(h,h.runtime.textService.submit(h.request,'intent-bad').run.id);
 assert.equal(run.state,'failed');assert.equal(run.errorCode,'TEXT_SEMANTIC_REVIEW');assert.equal(JSON.parse(h.runtime.store.get('SELECT review_json FROM text_semantic_reviews WHERE run_id=?',run.id).review_json).verdict,'approved');assert.equal(run.output,null);assert.equal(h.runtime.store.tasks().length,0);
 assert.ok(run.designProblems.some(p=>p.path==='images[2].useRelation'));assert.throws(()=>h.runtime.textService.revalidate(run.id,'bypass'),e=>e.code==='SEMANTIC_REVIEW_REQUIRED');
 const next=await settled(h,h.runtime.textService.submit({...h.request,understandingRunId:run.id,repairRunId:run.id},'explicit-repair').run.id);
 assert.equal(next.state,'failed');assert.ok(h.sent.find(x=>x.data.repairContext)?.data.repairContext.validationIssues.some(x=>x.code==='SEMANTIC_USERELATION'));
});
test('v14 unknown semantic call retains reservation and blocks new requests; does not start images',async t=>{
 const h=harness(t,()=>{throw Error('connection dropped')});const run=await settled(h,h.runtime.textService.submit(h.request,'unknown-review').run.id);
 assert.equal(run.state,'failed');assert.equal(run.errorCode,'MIMO_OUTCOME_UNKNOWN');assert.equal(ledgerState(h.runtime.store,h.config).unknown,true);assert.equal(h.runtime.store.tasks().length,0);
 assert.equal(h.sent.length,3);assert.throws(()=>h.runtime.textService.submit(h.request,'unsafe-retry'),e=>e.code==='BILLING_UNKNOWN');
});
test('semantic coverage and cautious verdicts cannot be promoted; labels cannot skip a copy',()=>{
 const plan={images:[{},{}]},r=approved(plan);r.images[1].imageIndex=0;assert.throws(()=>validateSemanticReview(r,plan));
 const cautious=approved(plan);cautious.verdict='uncertain';assert.equal(validateSemanticReview(cautious,plan).verdict,'uncertain');
 assert.equal(intentIssues({images:[{type:'scene',copy:[{text:'戴上听歌'}],intent:{depiction:'in-use',copyMeanings:[]}}]})[0].code,'SEMANTIC_COPY_COVERAGE');
});
test('v14 final review requires original-purpose evidence and cannot mark removed use or changed goals as passed',()=>{
 const base={verdict:'no-obvious-issue',summary:'图片清楚',issues:[]};assert.throws(()=>reconcileQuality(base,INTENT_TEMPLATE));
 for(const [status,verdict] of [['failed','needs-correction'],['changed','uncertain'],['uncertain','uncertain'],['preserved','no-obvious-issue']])assert.equal(reconcileQuality({...base,intentFulfillment:{status,evidence:'对照成图核对原始任务'}},INTENT_TEMPLATE).verdict,verdict);
 const full={...base,issues:Array.from({length:12},(_,i)=>({category:'identity',severity:i?'uncertain':'blocking',location:'位置'+i,evidence:'原有问题'+i,correction:'修复'})),intentFulfillment:{status:'changed',evidence:'目标变更'}};const kept=reconcileQuality(full,INTENT_TEMPLATE);assert.equal(kept.issues.length,13);assert.deepEqual(kept.issues.slice(0,12),full.issues);assert.equal(kept.verdict,'needs-correction');
 assert.deepEqual(reconcileQuality(base,'ecommerce-kit.13'),base);
});
test('v14 rules distinguish use, context and evidence instead of banning desks or requiring all products to have people',()=>{
 const snapshot={templateVersion:INTENT_TEMPLATE,description:'耳机',settings:{},references:[],semanticPlan:{images:[]}};
 const prompt=textPrompt('plan-review',snapshot,{});assert.match(prompt.system,/台灯/);assert.match(prompt.system,/鞋在玄关/);assert.match(prompt.system,/杯子在办公桌/);assert.match(prompt.system,/书桌聆听/);assert.match(prompt.system,/尚未生图/);assert.match(prompt.system,/本阶段只判断/);assert.match(prompt.system,/renderChecks/);
});

test('v14 grows undersized automatic text boxes without shrinking type or changing copy; pinned layouts and collisions remain guarded',async t=>{
 const {fitIntentTextBoxes}=await import('../../src/workflow/intent-design.js');const {reviewedLayers}=await import('../../src/workflow/reviewed-design.js');const {artPlanIssues}=await import('../../src/workflow/art-directed-design.js');
 const data={operation:'plan',references:[{id:'r1'}],settings:{counts:{white:1,selling:1,scene:1,other:1}}},raw=planned(data),shot=raw.images[3];shot.copy[0].text='外壳纹理细节';shot.design.elements[0].box=[.06,.05,.4,.14];const size={width:2048,height:2048},fixed=fitIntentTextBoxes(raw,size,'中文');
 assert.deepEqual(fixed.images.map(x=>x.copy),raw.images.map(x=>x.copy));assert.deepEqual(fixed.artDirection,raw.artDirection);assert.deepEqual(fixed.images.map(x=>x.intent),raw.images.map(x=>x.intent));assert.ok(fixed.images[3].design.elements[0].box[2]>.4);assert.equal(artPlanIssues(fixed).length,0);
 assert.equal(reviewedLayers({minimumMvp:{plan:{...fixed,images:[{...fixed.images[3],id:'s'}]}},input:{requirements:{language:'中文'}}},{id:'s',size})[0].fontSize,137);
 assert.deepEqual(fitIntentTextBoxes(raw,size,'中文',[3]).images[3],raw.images[3]);
 raw.images[3].design.elements[0].box=[.06,.34,.4,.14];assert.ok(artPlanIssues(fitIntentTextBoxes(raw,size,'中文')).length>0,'growth cannot waive overlap checks');
});
for(const reject of [false,true])test(`retained v14 layout response spends only on semantic review and still honors rejection (${reject})`,async t=>{
 let rejectNow=false;const h=harness(t,data=>{const r=approved(data.candidate);if(rejectNow)r.images[2].purpose={status:'fail',reason:'原用途未保留'};return fixtureResponse(r);});
 const p=await settled(h,h.runtime.textService.submit(h.request,'retained-first').run.id);assert.equal(p.state,'succeeded');const store=h.runtime.store;
 const raw=JSON.parse(store.get('SELECT original_json FROM text_plan_projections WHERE run_id=?',p.id).original_json);
 store.run("UPDATE text_runs SET state='failed',output_json=NULL,error_code='TEXT_REGION_TOO_SMALL' WHERE id=?",p.id);
 store.run('INSERT INTO text_validation_failures VALUES(?,?,?,?,?,?,?)',p.id,'plan',p.calls.find(c=>c.operation==='plan').id,JSON.stringify(raw),'[]','TEXT_REGION_TOO_SMALL',Date.now());rejectNow=reject;
 const before=h.sent.length,start=h.runtime.textService.reviewRetained(p.id,'retained-review');assert.equal(start.run.state,'running');assert.equal(start.run.output,null);
 const r=await settled(h,start.run.id);assert.equal(r.state,reject?'failed':'succeeded');assert.equal(h.sent.length,before+1);assert.equal(h.sent.at(-1).data.operation,'plan-review');assert.equal(store.tasks().length,0);
 assert.equal(h.runtime.textService.reviewRetained(p.id,'retained-review').run.id,r.id);assert.equal(h.sent.length,before+1);
});
