import test from 'node:test';
import assert from 'node:assert/strict';
import {inputFixture,deterministicHandlers,understandingFixture,planFixture} from './workflow/fixtures.mjs';
import {prepareWorkflow,executeImage,recordImageResult,rerunImage,aggregateResults,validateInput,validateUnderstanding,validatePlan,
  createPolicy,DEFAULT_POLICY,PROMPT_TEMPLATES,revisionPrompt,WorkflowError,createStage2Submission,stage2Body,digest} from '../src/workflow/index.js';

const clone=structuredClone;
const rule=value=>({value,basis:'Explicit deterministic test rule, not provider evidence',status:'local-safeguard'});
async function prepared(options={}) { const h=deterministicHandlers(options),p=await prepareWorkflow(inputFixture(),h);assert.equal(p.status,'ready',JSON.stringify(p.error));return {p,h}; }
async function run(p,h) { let results={};for(const img of p.plan.images) results=recordImageResult(results,await executeImage(p,img.id,h,{results}));return results; }
function planCase(mutate,code) {
  const input=inputFixture(),u=understandingFixture(input),p=planFixture(input,u);mutate(p,input,u);
  assert.ok(validatePlan(input,u,p).some(e=>e.code===code),code);
}

test('03A: deterministic successful kit has seven separately traced test-only artifacts',async()=>{
  const {p,h}=await prepared(),results=await run(p,h);
  assert.equal(aggregateResults(p,results).status,'succeeded');
  assert.equal(Object.keys(results).length,7);
  assert.equal(new Set(Object.values(results).map(r=>r.versions[0].artifact.sha256)).size,7);
  assert.ok(Object.values(results).every(r=>r.versions[0].quality.evidence==='test-only'));
  assert.deepEqual(p.trace.map(n=>n.id),['understand','plan','validate']);
  assert.deepEqual(results['selling-1'].attempts[0].trace.map(n=>n.id),['assemble','generate','compose','inspect']);
  assert.equal(results['selling-1'].versions[0].layers[0].text,'蓝色');
  const second=await executeImage(p,'selling-1',h);assert.deepEqual(second.value,results['selling-1'].versions[0] && (({version,...v})=>v)(results['selling-1'].versions[0]));
});
test('03A: partial failure and one-image retry leave every sibling byte/version/trace unchanged',async()=>{
  const {p,h}=await prepared({failures:{'scene-1':{untilAttempt:1}}}),results=await run(p,h),before=JSON.stringify(results);
  assert.equal(aggregateResults(p,results).status,'partial');assert.equal(aggregateResults(p,results).progress.succeeded,6);
  const retried=await rerunImage(p,results,'scene-1',h);
  assert.equal(aggregateResults(p,retried.results).status,'succeeded');
  assert.equal(retried.results['scene-1'].attempts.length,2);
  for (const id of Object.keys(results).filter(id=>id!=='scene-1')) assert.deepEqual(retried.results[id],results[id]);
  assert.equal(JSON.stringify(results),before);assert.equal(h.calls.filter(x=>x==='generate:white-1').length,1);
});
test('03A: successful target rerun appends version; failed rerun retains its last good artifact',async()=>{
  const {p,h}=await prepared(),results=await run(p,h);
  const v2=await rerunImage(p,results,'selling-1',h);
  assert.equal(v2.results['selling-1'].currentVersion,2);assert.deepEqual(v2.results['selling-1'].versions[0],results['selling-1'].versions[0]);
  const bad=deterministicHandlers({failures:{'selling-1':{}}}),v3=await rerunImage(p,v2.results,'selling-1',bad);
  assert.equal(v3.results['selling-1'].status,'succeeded');assert.equal(v3.results['selling-1'].lastAttemptStatus,'failed');
  assert.deepEqual(v3.results['selling-1'].versions,v2.results['selling-1'].versions);
});
test('03A: illegal plan cannot reach any image handler',async()=>{
  const h=deterministicHandlers({mutatePlan:p=>{p.images.pop();return p;}}),p=await prepareWorkflow(inputFixture(),h);
  assert.equal(p.status,'failed');assert.equal(p.error.code,'INVALID_PLAN');assert.equal(p.trace.at(-1).id,'validate');
  assert.ok(p.error.issues.some(e=>e.code==='TYPE_COUNT'));
  await assert.rejects(executeImage(p,'white-1',h),{code:'SNAPSHOT_CHANGED'});assert.deepEqual(h.calls,['understand','plan']);
});
test('03A: facts cannot be promoted, changed or sourced from style references',()=>{
  const input=inputFixture(),u=understandingFixture(input);
  u.facts.push({id:'fake',key:'material',value:'steel',source:{kind:'user-confirmed',locator:'model'}});
  assert.ok(validateUnderstanding(input,u).some(x=>x.code==='FACT_PROMOTION'));
  const u2=understandingFixture(input);u2.inferred[0].evidenceReferenceIds=['ref-style'];
  assert.ok(validateUnderstanding(input,u2).some(x=>x.code==='INFERENCE_EVIDENCE'));
  const u3=understandingFixture(input);u3.unknowns=[];assert.ok(validateUnderstanding(input,u3).some(x=>x.code==='UNKNOWN_DROPPED'));
});
test('03A: unresolved fact conflicts and unconfirmed copy citations are rejected',()=>{
  planCase((p,i,u)=>{u.conflicts.push({key:'color',factIds:['f-color'],referenceIds:['ref-front'],reason:'测试矛盾'});p.understandingDigest=digest(u);},'UNRESOLVED_CONFLICT');
  planCase(p=>{p.images[1].copy[0].factIds=['inferred-shape'];},'UNCONFIRMED_CLAIM');
  const input=inputFixture(),u=understandingFixture(input);u.inferred[0].key='color';
  assert.ok(validateUnderstanding(input,u).some(x=>x.code==='CONFLICT_MISSING'));
});
for (const [label,mutate,code] of [
  ['fractional count',i=>i.requirements.counts.selling=1.5,'SCHEMA'],
  ['negative count',i=>i.requirements.counts.scene=-1,'SCHEMA'],
  ['NaN count',i=>i.requirements.counts.white=NaN,'SCHEMA'],
  ['unknown type',i=>i.requirements.counts.fake=1,'SCHEMA'],
  ['too few',i=>i.requirements.counts.selling=2,'TOTAL_COUNT'],
  ['too many',i=>i.requirements.counts.selling=20,'TOTAL_COUNT'],
  ['ratio',i=>i.requirements.ratio='5:3','RATIO'],
  ['size mismatch',i=>i.requirements.size.height=32,'ASPECT_SIZE'],
  ['layout overflow',i=>i.requirements.counts.selling=0,'LAYOUT_CAPACITY'],
  ['duplicate reference asset',i=>i.product.references[1].assetId='asset-front','DUPLICATE'],
  ['missing product reference',i=>i.product.references[0].role='style','PRODUCT_REFERENCES'],
  ['layout overlaps subject',i=>i.layouts[0].textSlots[0].box=[0.2,0.3,0.4,0.4],'LAYOUT_BOUNDS'],
  ['layout outside bounds',i=>i.layouts[0].subjectBox=[0.8,0.3,0.8,0.6],'LAYOUT_BOUNDS'],
  ['unknown schema version',i=>i.schemaVersion='next','SCHEMA']
]) test(`03A validation: ${label}`,()=>{const i=inputFixture();mutate(i);assert.ok(validateInput(i).some(e=>e.code===code),code);});
for (const [label,mutate,code] of [
  ['wrong type count',p=>p.images[0].type='other','TYPE_COUNT'],
  ['duplicate image ID',p=>p.images[1].id=p.images[0].id,'DUPLICATE'],
  ['wrong reference role',p=>p.images[0].references[0].role='style','REFERENCE_ROLE'],
  ['missing reference',p=>p.images[0].references[0].referenceId='missing','REFERENCE_ROLE'],
  ['duplicate content',p=>{p.images[2]=clone(p.images[1]);p.images[2].id='selling-2';},'DUPLICATE_CONTENT'],
  ['layout reuse',p=>p.images[2].layoutId='layout-one','LAYOUT_USAGE'],
  ['missing layout ref',p=>p.images[1].references.pop(),'LAYOUT_REFERENCE'],
  ['layout not executed',p=>p.images[1].composition.subjectBox=[0,0,1,1],'LAYOUT_COMPOSITION'],
  ['text overflow',p=>p.images[1].copy[0].text='字'.repeat(33),'COPY_CAPACITY'],
  ['line overflow',p=>p.images[1].copy[0].text='一\n二\n三','COPY_CAPACITY'],
  ['invalid dependency',p=>p.images[1].dependencies=[{imageId:'missing',use:'baseline'}],'DEPENDENCY'],
  ['dependency cycle',p=>{p.images[0].dependencies=[{imageId:'selling-1',use:'baseline'}];p.images[1].dependencies=[{imageId:'white-1',use:'baseline'}];},'DEPENDENCY_CYCLE']
]) test(`03A plan: ${label}`,()=>planCase(mutate,code));
test('03A: boundaries and supplier limits are configurable with provenance',()=>{
  const i=inputFixture();i.requirements.counts.selling=2;
  assert.deepEqual(validateInput(i,createPolicy({totalMin:rule(6)})),[]);
  assert.throws(()=>createPolicy({totalMin:{value:6}}),{code:'INVALID_POLICY'});
  assert.throws(()=>createPolicy({outputsPerCall:rule(2)}),{code:'INVALID_POLICY'});
  assert.ok(validateInput(inputFixture(),createPolicy({allowedSizes:rule(['1024x1024'])})).some(x=>x.code==='PROVIDER_SIZE'));
  for(const [ratio,width,height] of [['1:1',64,64],['3:4',48,64],['9:16',36,64],['16:9',64,36]]) {
    const input=inputFixture();input.requirements.ratio=ratio;input.requirements.size={width,height};assert.deepEqual(validateInput(input),[]);
  }
  const input=inputFixture(),u=understandingFixture(input),p=planFixture(input,u);
  p.images[1].dependencies=[{imageId:'white-1',use:'baseline'}];
  assert.ok(validatePlan(input,u,p,createPolicy({combinedReferencesMax:rule(4)})).some(x=>x.code==='REFERENCE_BUDGET'));
  assert.equal(DEFAULT_POLICY.allowedSizes.value,null);
});
test('03A: missing dependency blocks only its target; baseline rerun keeps downstream version pins',async()=>{
  const {p,h}=await prepared({mutatePlan:p=>{p.images[1].dependencies=[{imageId:'white-1',use:'baseline'}];return p;}});
  const blocked=await executeImage(p,'selling-1',h);assert.equal(blocked.status,'blocked');assert.ok(!h.calls.includes('generate:selling-1'));
  const results=await run(p,h),downstream=clone(results['selling-1']);
  assert.equal(downstream.versions[0].dependencyPins[0].version,1);
  const {results:next}=await rerunImage(p,results,'white-1',h);
  assert.deepEqual(next['selling-1'],downstream);assert.equal(next['white-1'].currentVersion,2);
  assert.throws(()=>stage2Body(p),{code:'STAGE2_DEPENDENCY_UNSUPPORTED'});
});
test('03A: compose failure resumes from generated checkpoint without a second generation',async()=>{
  const {p,h}=await prepared();const fail={...h,compose:async()=>{throw new WorkflowError('COMPOSE_FAILED');}};
  const first=await executeImage(p,'selling-1',fail);assert.equal(first.status,'failed');assert.equal(first.checkpoint.stage,'generated');
  const next=await executeImage(p,'selling-1',h,{resume:first.checkpoint,attempt:2});assert.equal(next.status,'succeeded');
  assert.equal(h.calls.filter(x=>x==='generate:selling-1').length,1);
  const corrupt=clone(first.checkpoint);corrupt.generated.width=1;
  assert.equal((await executeImage(p,'selling-1',h,{resume:corrupt})).error.code,'SNAPSHOT_CHANGED');
});
test('03A: quality rejection and invalid raster/layers cannot publish success',async()=>{
  const {p,h}=await prepared();
  const bad=await executeImage(p,'selling-1',{...h,inspect:async()=>({passed:false,evidence:'test-only',issues:[{code:'drift',severity:'error',message:'test'}]})});
  assert.equal(bad.error.code,'QUALITY_REJECTED');assert.equal(bad.checkpoint.stage,'composed');assert.equal(bad.value,undefined);assert.equal(bad.quality.issues[0].code,'drift');
  const wrong=await executeImage(p,'selling-1',{...h,compose:async({raster})=>({raster,layers:[]})});assert.equal(wrong.error.code,'OUTPUT_INVALID');
  const invalid=await executeImage(p,'white-1',{...h,generate:async r=>({...await h.generate(r),width:1})});assert.equal(invalid.error.code,'OUTPUT_INVALID');
});
test('03A: cancellation discards a late generated raster and unknown outcome prohibits rerun',async()=>{
  const {p,h}=await prepared(),controller=new AbortController();
  const canceled=await executeImage(p,'white-1',{...h,generate:async r=>{const x=await h.generate(r);controller.abort();return x;}},{signal:controller.signal});
  assert.equal(canceled.status,'canceled');assert.equal(canceled.value,undefined);
  const unsafe={...h,replaySafe:false,generate:async()=>{throw new Error('SECRET_PROVIDER_BODY');}};
  const unsafePrepared=await prepareWorkflow(inputFixture(),unsafe);
  const unknown=await executeImage(unsafePrepared,'white-1',unsafe);
  assert.equal(unknown.error.outcomeUnknown,true);assert.ok(!JSON.stringify(unknown).includes('SECRET_PROVIDER_BODY'));
  await assert.rejects(rerunImage(unsafePrepared,recordImageResult({},unknown),'white-1',unsafe),{code:'OUTCOME_UNKNOWN'});
});
test('03A: frozen snapshot, prompt versions and draft boundaries are explicit',async()=>{
  const {p,h}=await prepared(),changed=clone(p);changed.plan.images[0].content='changed';
  await assert.rejects(executeImage(changed,'white-1',h),{code:'SNAPSHOT_CHANGED'});
  assert.throws(()=>p.plan.images.push({}),TypeError);
  for (const kind of ['understand','plan','white','selling','scene','other','edit','restore']) assert.equal(PROMPT_TEMPLATES[kind].status,'draft-unassessed');
  assert.throws(()=>revisionPrompt('edit',{references:[],region:[0,0,1,1],instruction:'test'}),{code:'INVALID_REVISION_INPUT'});
});
test('03A: stage2 submission freezes complete plan and verifies product identity',async()=>{
  const {p}=await prepared();const product={...clone(p.input.product),facts:{confirmed:p.input.product.facts,unknowns:p.input.product.unknowns}};
  const request=createStage2Submission(p,product,'test-request');assert.equal(request.body.slots.length,7);assert.equal(request.body.settings.workflow03A.digest,p.digest);
  product.references[0].assetId='cross-product';assert.throws(()=>createStage2Submission(p,product,'test-request'),{code:'SNAPSHOT_CHANGED'});
});
test('03A: inclusive count/reference boundaries and all reference roles consume the budget',()=>{
  const input=inputFixture();input.requirements.counts.other=14;assert.deepEqual(validateInput(input),[]); // 20 total
  input.requirements.counts.other=15;assert.ok(validateInput(input).some(e=>e.code==='TOTAL_COUNT'));
  input.requirements.counts.other=1;
  for(let i=0;i<4;i++)input.product.references.push({id:`extra-${i}`,assetId:`asset-extra-${i}`,role:'detail',purpose:'test'});
  assert.deepEqual(validateInput(input),[]); // 6 product references plus style/layout
  input.product.references.push({id:'extra-over',assetId:'asset-extra-over',role:'detail',purpose:'test'});
  assert.ok(validateInput(input).some(e=>e.code==='PRODUCT_REFERENCES'));
  const i=inputFixture();for(const role of ['current','baseline'])i.product.references.push({id:role,assetId:`asset-${role}`,role,purpose:'test'});
  const u=understandingFixture(i),p=planFixture(i,u);p.images[1].references.push({referenceId:'current',role:'current'},{referenceId:'baseline',role:'baseline'});
  assert.ok(validatePlan(i,u,p,createPolicy({combinedReferencesMax:rule(5)})).some(e=>e.code==='REFERENCE_BUDGET'));
  assert.deepEqual(validatePlan(i,u,p,createPolicy({combinedReferencesMax:rule(6)})),[]);
});
test('03A: handler versions cannot silently change on a frozen plan',async()=>{
  const {p,h}=await prepared();await assert.rejects(executeImage(p,'white-1',{...h,version:'test.2'}),{code:'SNAPSHOT_CHANGED'});
});
test('03A: untrusted structured provider exceptions do not enter validation diagnostics',async()=>{
  const {p,h}=await prepared();const result=await executeImage(p,'white-1',{...h,generate:async()=>{throw new WorkflowError('OUTPUT_INVALID',[{raw:'SECRET_HEADER'}]);}});
  assert.equal(result.status,'failed');assert.deepEqual(result.error.issues,[]);assert.ok(!JSON.stringify(result).includes('SECRET_HEADER'));
});
test('03A: image asset reads are narrowed to selected references',async()=>{
  const {p,h}=await prepared(),reads=[];
  const result=await executeImage(p,'white-1',{...h,generate:async request=>{request.readAsset('asset-layout');return h.generate(request);}},{readAsset:id=>reads.push(id)});
  assert.equal(result.status,'failed');assert.equal(result.error.code,'INVALID_INPUT');assert.deepEqual(reads,[]);
});
test('03A: composed checkpoint can recheck quality without generating or composing again',async()=>{
  const {p,h}=await prepared();const failed=await executeImage(p,'selling-1',{...h,inspect:async()=>({passed:false,evidence:'test-only',issues:[]})});
  const retry=await executeImage(p,'selling-1',h,{resume:failed.checkpoint,attempt:2});assert.equal(retry.status,'succeeded');
  assert.deepEqual(retry.trace.map(x=>x.id),['assemble','inspect']);assert.equal(h.calls.filter(x=>x==='generate:selling-1').length,1);
});
test('03A: no confirmed facts means no invented copy; pre-cancelled preparation calls nothing',async()=>{
  const input=inputFixture();input.product.facts=[];const h=deterministicHandlers(),p=await prepareWorkflow(input,h);
  assert.equal(p.status,'ready');assert.ok(p.plan.images.every(i=>i.copy.length===0));
  const controller=new AbortController();controller.abort();const h2=deterministicHandlers();
  const canceled=await prepareWorkflow(input,h2,{signal:controller.signal});assert.equal(canceled.error.code,'CANCELED');assert.deepEqual(h2.calls,[]);
});
