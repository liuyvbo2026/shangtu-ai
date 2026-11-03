import {MARKET_VERSION,marketPolicyFor} from '../../src/workflow/market-design.js';
import {LIFESTYLE_TEMPLATE} from '../../src/workflow/lifestyle-design.js';
import {FULLCANVAS_TEMPLATE} from '../../src/workflow/fullcanvas-design.js';
import {validateSemanticReview,semanticDigest,semanticIssues,semanticSchemaFor} from './intent-review.mjs';
import {isIntentTemplate,INTENT_TEMPLATE} from '../../src/workflow/intent-design.js';
import {ADAPTIVE_TEMPLATE,isAdaptiveTemplate,isReviewedTemplate} from '../../src/workflow/adaptive-design.js';
import {REVIEWED_TEMPLATE} from '../../src/workflow/reviewed-design.js';
import {ART_TEMPLATE} from '../../src/workflow/art-directed-design.js';
import {BETA_TEMPLATE} from '../../src/workflow/beta-design.js';
import {randomUUID} from 'node:crypto';
import {Fault,fail,canonical,hash,json} from '../core.mjs';
import {INPUT_VERSION,productFromRemote} from '../../src/product-input.js';
import {validateSettings} from './planning.mjs';
import {TEXT_VERSION,textSchema,planRepairIssues,addonRepairIssues,validateUnderstandingOutput,validateAssistOutput,validatePlanOutput,validateAddonOutput} from './mimo-contracts.mjs';
import {schemaIssues} from '../../src/workflow/index.js';
import {MIMO_MODEL,createMimoProvider,initTextLedger,mimoReadiness} from './mimo-provider.mjs';
import {createTextRouter,modelReadiness} from './model-router.mjs';
import {defaultConnection,connectionIdentity,validateReferences} from './model-catalog.mjs';
import {ledgerState} from './provider.mjs';
import {BASELINE_TEMPLATE,REPAIR_TEMPLATE,DIVERSE_TEMPLATE,DESIGN_TEMPLATE,RESOLVED_TEMPLATE,isResolvedTemplate,isDesignedTemplate,isDiverseTemplate,TEMPLATE_IDS,understandingTemplate} from '../../src/workflow/minimum-templates.js';
import {designIssues} from '../../src/workflow/kit-design.js';
import {validateQuality,reconcileQuality,qualityAttachments} from './quality-review.mjs';

export function createTextService({store,config,key,connection=null,transport,timeoutMs,layouts}){
 initTextLedger(store);
 store.db.exec(`CREATE TABLE IF NOT EXISTS text_runs(
 id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,
 product_id TEXT NOT NULL REFERENCES products(id),kind TEXT NOT NULL,state TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,understanding_json TEXT,output_json TEXT,error_code TEXT,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS text_runs_product ON text_runs(product_id,created_at);
 CREATE TABLE IF NOT EXISTS text_run_references(
 run_id TEXT NOT NULL REFERENCES text_runs(id),asset_id TEXT NOT NULL REFERENCES assets(id),
 PRIMARY KEY(run_id,asset_id));
 CREATE TABLE IF NOT EXISTS text_validation_failures(
 run_id TEXT NOT NULL REFERENCES text_runs(id),operation TEXT NOT NULL,call_id TEXT NOT NULL,
 output_json TEXT NOT NULL,issues_json TEXT NOT NULL,error_code TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,operation));
 CREATE TABLE IF NOT EXISTS text_understanding_projections(run_id TEXT PRIMARY KEY REFERENCES text_runs(id),original_json TEXT NOT NULL,resolved_json TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS text_quality_projections(run_id TEXT PRIMARY KEY REFERENCES text_runs(id),call_id TEXT NOT NULL,original_json TEXT NOT NULL,resolved_json TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS text_semantic_review_attempts(run_id TEXT NOT NULL REFERENCES text_runs(id),ordinal INTEGER NOT NULL,call_id TEXT NOT NULL,output_json TEXT NOT NULL,error_code TEXT,PRIMARY KEY(run_id,ordinal));
 CREATE TABLE IF NOT EXISTS text_semantic_reviews(run_id TEXT PRIMARY KEY REFERENCES text_runs(id),plan_hash TEXT NOT NULL,candidate_json TEXT NOT NULL,review_json TEXT,call_id TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS text_plan_projections(run_id TEXT PRIMARY KEY REFERENCES text_runs(id),call_id TEXT NOT NULL,version TEXT NOT NULL,original_json TEXT NOT NULL,resolved_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 // Text snapshots pin the original bytes just as image tasks do. Removing a current
 // product reference must not make a historical understanding lose its evidence.
 store.transaction(()=>{
  for(const row of store.all('SELECT id,snapshot_json FROM text_runs'))for(const r of JSON.parse(row.snapshot_json).references)
   if(store.get('SELECT id FROM assets WHERE id=?',r.assetId))store.run('INSERT OR IGNORE INTO text_run_references VALUES(?,?)',row.id,r.assetId);
 });
 store.run("UPDATE text_runs SET state='failed',error_code='PROCESS_INTERRUPTED',updated_at=? WHERE state='running'",Date.now());
 store.run("UPDATE text_semantic_reviews SET state='interrupted' WHERE state='pending'");
 const readReady=()=>connection?modelReadiness('text',config,connection()):mimoReadiness(config,key);
 const call=connection?createTextRouter({store,config,key,connection,transport,timeoutMs}):createMimoProvider({store,config,key,transport,timeoutMs});let active=null,activeRun=null,closing=false;
 function view(row){
  fail(row,'NOT_FOUND','找不到文字任务',404);
  const snapshot=JSON.parse(row.snapshot_json);
  const problem=store.get("SELECT issues_json FROM text_validation_failures WHERE run_id=? AND operation='plan'",row.id);
  const designProblems=problem?JSON.parse(problem.issues_json).filter(x=>String(x.code).startsWith('DESIGN_')||String(x.code).startsWith('SEMANTIC_')).map(({path,code,message})=>({path,code,message})):[];
  if(snapshot.planRepair)snapshot.planRepair={fromRunId:snapshot.planRepair.fromRunId,errorCode:snapshot.planRepair.errorCode};
  if(snapshot.addonRepair)snapshot.addonRepair={fromRunId:snapshot.addonRepair.fromRunId,errorCode:snapshot.addonRepair.errorCode};
  if(snapshot.understandingRepair)snapshot.understandingRepair={fromRunId:snapshot.understandingRepair.fromRunId,errorCode:snapshot.understandingRepair.errorCode};
  return {id:row.id,kind:row.kind,state:row.state,version:TEXT_VERSION,model:snapshot.modelConnection?.model??MIMO_MODEL,snapshot,
   understandingReady:!!row.understanding_json,
   understanding:row.understanding_json?JSON.parse(row.understanding_json):null,output:row.output_json?JSON.parse(row.output_json):null,
   errorCode:row.error_code,createdAt:row.created_at,updatedAt:row.updated_at,...(designProblems.length?{designProblems}:{}),
   ...(isIntentTemplate(snapshot.templateVersion)?{semanticReview:(()=>{const r=store.get('SELECT state,review_json,candidate_json FROM text_semantic_reviews WHERE run_id=?',row.id);return r?{state:r.state,review:r.review_json&&['approved','revise','uncertain'].includes(r.state)?validateSemanticReview(JSON.parse(r.review_json),JSON.parse(r.candidate_json),snapshot.templateVersion):null}:null;})()}:{}),
   calls:store.all('SELECT id,operation,state,request_id AS requestId,usage_json AS usage,reserved_cny AS reservedCny,cost_cny AS estimatedCostCny,error_code AS errorCode FROM text_calls WHERE run_id=?',row.id).map(c=>({...c,usage:c.usage?JSON.parse(c.usage):null}))};
 }
 const get=id=>view(store.get('SELECT * FROM text_runs WHERE id=?',id));
 function snapshotOf(request){
  fail(request&&Object.keys(request).every(k=>['kind','productId','productRevision','description','settings','understandingRunId','repairRunId','styleRunId'].includes(k)),'INVALID_INPUT','文字请求包含未知字段');
  fail(['understand','assist','plan','style','listing'].includes(request.kind),'INVALID_INPUT','文字任务类型无效');
  const p=store.product(request.productId);
  fail(p.revision===request.productRevision,'REVISION_CONFLICT','商品已改变，请重新保存后操作',409);
  fail(typeof request.description==='string'&&request.description.length<=1000,'INVALID_INPUT','单个输入框最多1000字');
  const saved=p.facts.userInput?.version===INPUT_VERSION?p.facts.userInput.text:productFromRemote(p).inputText;
  fail(request.description===saved,'REVISION_CONFLICT','输入内容与已保存商品不一致，请先保存',409);
  fail(p.references.length>=1&&p.references.length<=6,'INVALID_INPUT','请先上传同一商品的1–6张参考图');
  const settings=structuredClone(request.settings);
  // Executable planning must reject unsupported options before spending on MiMo.
  validateSettings(request.kind==='plan'?settings:{...settings,layouts:[],analysis:false,listing:false},{allowLayouts:true,allowAddons:true});
  const selectedLayouts=request.kind==='plan'?layouts?.resolve(settings.layouts,settings)??[]:[];
  fail(selectedLayouts.length===(request.kind==='plan'?settings.layouts.length:0),'LAYOUT_UNAVAILABLE','版式目录暂不可用',409);
  fail(selectedLayouts.every(l=>config.authorizedReferenceHashes?.includes(l.reference.sha256)&&config.mimo?.authorizedReferenceHashes?.includes(l.reference.sha256)),'REFERENCE_NOT_AUTHORIZED','版式原图尚未获得文字与图像模型上传授权',403);
  const references=p.references.map(r=>({id:r.id,assetId:r.assetId,role:r.role}));
  fail(references.some(r=>r.role==='product')&&references.every(r=>['product','detail','packaging'].includes(r.role)),'INVALID_INPUT','本轮仅支持同一商品的原图、细节和包装参考');
  fail(references.every(r=>config.mimo?.authorizedReferenceHashes?.includes(store.asset(r.assetId).sha256)),'REFERENCE_NOT_AUTHORIZED','这组参考图尚未获得 语言模型上传授权',403);
  let sourceUserText=request.description;
  const assistance=p.facts.userInput?.assistance;
  if(assistance?.text===request.description){
   const previous=get(assistance.runId);
   fail(previous.kind==='assist'&&previous.state==='succeeded'&&previous.snapshot.productId===p.id,'TEXT_SOURCE_CHANGED','帮写来源无法核对，请保留资料并检查记录',409);
   sourceUserText=previous.snapshot.sourceUserText??previous.snapshot.description;
  }
  if(connection)validateReferences({...connection(),kind:'text'},references.map(r=>store.asset(r.assetId)));
  const templateVersion=config.mimo?.templateVersion??BASELINE_TEMPLATE;
  fail(TEMPLATE_IDS.includes(templateVersion),'PLAN_VERSION_UNSUPPORTED','配置中的规划模板版本不受支持');
  fail(!selectedLayouts.length||isDiverseTemplate(templateVersion),'LAYOUT_VERSION_UNSUPPORTED','当前旧规划模板不支持自定义版式，请使用已支持的规划版本',409);
  return {version:TEXT_VERSION,...(templateVersion===LIFESTYLE_TEMPLATE&&config.mimo?.marketPolicyVersion===MARKET_VERSION?{marketPolicy:marketPolicyFor(settings)}:{}),...(connection?{modelConnection:connectionIdentity(connection())}:{}),templateVersion,product:structuredClone(p),productId:p.id,productRevision:p.revision,name:p.name,description:request.description,sourceUserText,settings,references,
   referenceHashes:references.map(r=>store.asset(r.assetId).sha256),...(selectedLayouts.length?{layouts:selectedLayouts}:{})};
 }
 const sourceDigest=s=>hash(canonical({version:s.version,...(s.marketPolicy?{marketPolicy:s.marketPolicy}:{}),templateVersion:understandingTemplate(s.templateVersion??BASELINE_TEMPLATE),productId:s.productId,productRevision:s.productRevision,description:s.description,references:s.references,referenceHashes:s.referenceHashes,modelConnection:s.modelConnection??defaultConnection('text')}));
 function validated(id,kind,result,snapshot,understanding){
  try{
   const output=kind==='quality'?reconcileQuality(result.output,snapshot.templateVersion,snapshot.quality?.shot,snapshot.quality?.sceneReviewMode):kind==='understand'?validateUnderstandingOutput(result.output,snapshot):kind==='assist'?validateAssistOutput(result.output,snapshot,understanding):['style','listing'].includes(kind)?validateAddonOutput(kind,result.output,snapshot,understanding):validatePlanOutput(result.output,snapshot,understanding);
   if(kind==='understand'&&canonical(result.output)!==canonical(output))store.run('INSERT INTO text_understanding_projections VALUES(?,?,?,?)',id,json(result.output),json(output),Date.now());
   if(kind==='quality'&&canonical(result.output)!==canonical(output))store.run('INSERT INTO text_quality_projections VALUES(?,?,?,?,?)',id,result.callId,json(result.output),json(output),Date.now());
   if(kind==='plan'&&(isResolvedTemplate(snapshot.templateVersion)||[BETA_TEMPLATE,ART_TEMPLATE,REVIEWED_TEMPLATE,ADAPTIVE_TEMPLATE,INTENT_TEMPLATE,FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(snapshot.templateVersion)))store.run('INSERT INTO text_plan_projections VALUES(?,?,?,?,?,?)',id,result.callId,'resolved-layout.1',json(result.output),json(output),Date.now());
   return output;
  }catch(error){
   // Keep only parsed model JSON after the provider's credential guard, inside the
   // private database. Never expose rejected output through the public run view.
   const issues=schemaIssues(textSchema(kind,snapshot.templateVersion,snapshot.layouts,snapshot.marketPolicy),result.output);
   if(!issues.length&&kind==='plan'&&isDesignedTemplate(snapshot.templateVersion))issues.push(...planRepairIssues(result.output,snapshot,understanding));
   store.run('INSERT INTO text_validation_failures VALUES(?,?,?,?,?,?,?)',id,kind,result.callId,json(result.output),json(issues),error instanceof Fault?error.code:'TEXT_INTERNAL',Date.now());
   throw error;
  }
 }
 async function execute(id,snapshot,kind,previous,signal,retained=null){
  let u=previous?.understanding??null;
  try{
   if(kind==='quality')u=snapshot.quality.understanding;
   else if(!u){const r=await call({runId:id,kind:'understand',snapshot,signal});u=validated(id,'understand',r,snapshot);
    store.run('UPDATE text_runs SET understanding_json=?,updated_at=? WHERE id=?',json(u),Date.now(),id);
   }else{
    const resolved=validateUnderstandingOutput(u,snapshot);
    if(canonical(u)!==canonical(resolved))store.run('INSERT INTO text_understanding_projections VALUES(?,?,?,?)',id,json(u),json(resolved),Date.now());
    u=resolved;
    store.run('UPDATE text_runs SET understanding_json=?,updated_at=? WHERE id=?',json(u),Date.now(),id);
   }
   if(signal.aborted)return;
   let output=u;
   if(kind!=='understand'){
    const r=retained??await call({runId:id,kind,snapshot,understanding:u,signal});
    output=validated(id,kind,r,snapshot,u);
    if(kind==='plan'&&isIntentTemplate(snapshot.templateVersion)){
     store.run('INSERT INTO text_semantic_reviews VALUES(?,?,?,?,?,?,?)',id,semanticDigest(output),json(output),null,null,'pending',Date.now());
     try{
      let review,semanticRepair;
      for(let ordinal=0;ordinal<([FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(snapshot.templateVersion)?2:1);ordinal++){
       if(signal.aborted)return;
       const checked=await call({runId:id,kind:'plan-review',snapshot:{...snapshot,semanticPlan:output,...(semanticRepair?{semanticRepair}:{})},understanding:u,signal});
       store.run('INSERT INTO text_semantic_review_attempts VALUES(?,?,?,?,?)',id,ordinal,checked.callId,json(checked.output),null);
       store.run('UPDATE text_semantic_reviews SET review_json=?,call_id=? WHERE run_id=?',json(checked.output),checked.callId,id);
       try{review=validateSemanticReview(checked.output,output,snapshot.templateVersion);break;}
       catch(error){
        store.run('UPDATE text_semantic_review_attempts SET error_code=? WHERE run_id=? AND ordinal=?',error.code??'TEXT_INTERNAL',id,ordinal);
        if(![FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(snapshot.templateVersion)||ordinal!==0||error.code!=='SEMANTIC_OUTPUT_INVALID')throw error;
        semanticRepair={previousOutput:checked.output,issues:schemaIssues(semanticSchemaFor(snapshot.templateVersion),checked.output),requiredIndices:output.images.map((_,i)=>i)};
       }
      }
      store.run('UPDATE text_semantic_reviews SET state=? WHERE run_id=?',review.verdict,id);
      if(review.verdict!=='approved'){
       store.run('INSERT INTO text_validation_failures VALUES(?,?,?,?,?,?,?)',id,'plan',r.callId,json(r.output),json(semanticIssues(review)),'TEXT_SEMANTIC_REVIEW',Date.now());
       fail(false,'TEXT_SEMANTIC_REVIEW','图文方案的用途或文案尚未通过复核，未启动生图',422);
      }
     }catch(error){
      store.run("UPDATE text_semantic_reviews SET state='failed' WHERE run_id=? AND state='pending'",id);
      throw error;
     }
    }
   }
   // Save the original revision even if another tab changes the product during the call.
   store.run("UPDATE text_runs SET state='succeeded',understanding_json=?,output_json=?,updated_at=? WHERE id=? AND state='running'",json(u),json(output),Date.now(),id);
  }catch(error){
   const code=error instanceof Fault?error.code:'TEXT_INTERNAL';
   store.run("UPDATE text_runs SET state='failed',error_code=?,updated_at=? WHERE id=? AND state='running'",code,Date.now(),id);
  }
 }
 function submit(request,idempotencyKey,preparedSnapshot=null){
  fail(typeof idempotencyKey==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(idempotencyKey),'INVALID_INPUT','需要有效的幂等键');
  const requestHash=hash(canonical(request)),old=store.get('SELECT * FROM text_runs WHERE idempotency_key=?',idempotencyKey);
  if(old){fail(old.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','同一请求的内容已改变',409);return {run:view(old),duplicate:true};}
  const ready=readReady();fail(!ready.paused,'MODEL_CALLS_PAUSED','模型调用当前暂停，已有文字与图片记录仍保留',503);fail(ready.ready,'MIMO_NOT_READY',`文字能力待配置：${ready.missing.join('、')}`,503);
  fail(!closing&&!active,'TEXT_BUSY','已有文字任务执行中，请稍后读取结果',409);
  fail(!ledgerState(store,config).unknown,'BILLING_UNKNOWN','上游结果或费用待核对，未发起新请求',409);
  const snapshot=preparedSnapshot?structuredClone(preparedSnapshot):snapshotOf(request);let previous=null;
  if(request.styleRunId){const style=get(request.styleRunId);fail(request.kind==='plan'&&style.kind==='style'&&style.state==='succeeded'&&sourceDigest(style.snapshot)===sourceDigest(snapshot),'TEXT_SOURCE_CHANGED','风格分析来源已变化',409);snapshot.styleAnalysis={runId:style.id,output:style.output};}
  if(request.understandingRunId){
   previous=get(request.understandingRunId);
   // A failed plan may itself have reused a validated understanding. Keep that
   // stage reusable on an explicit retry; revalidate it against this snapshot.
   const completedUnderstanding=previous.state==='succeeded'||previous.kind==='plan'&&previous.state==='failed';
   fail(completedUnderstanding&&previous.understanding&&sourceDigest(previous.snapshot)===sourceDigest(snapshot),'TEXT_SOURCE_CHANGED','商品或参考图已变化，请重新理解',409);
   validateUnderstandingOutput(previous.understanding,snapshot);
   const repairRun=request.repairRunId?get(request.repairRunId):previous;
   if(request.repairRunId&&request.kind==='plan')fail(request.kind==='plan'&&(snapshot.templateVersion===REPAIR_TEMPLATE||isDiverseTemplate(snapshot.templateVersion))&&repairRun.kind==='plan'&&repairRun.state==='failed'&&sourceDigest(repairRun.snapshot)===sourceDigest(snapshot),'TEXT_SOURCE_CHANGED','待修复规划来源不匹配',409);
   if(request.kind==='plan'&&(snapshot.templateVersion===REPAIR_TEMPLATE||isDiverseTemplate(snapshot.templateVersion))&&repairRun.state==='failed'){
    const rejected=store.get("SELECT output_json,error_code,issues_json FROM text_validation_failures WHERE run_id=? AND operation='plan'",repairRun.id);
    const repairSchemaIssues=rejected&&snapshot.marketPolicy?schemaIssues(textSchema('plan',snapshot.templateVersion,snapshot.layouts,snapshot.marketPolicy),JSON.parse(rejected.output_json)):rejected?JSON.parse(rejected.issues_json):[];
    if(rejected)snapshot.planRepair={fromRunId:repairRun.id,rejectedOutput:JSON.parse(rejected.output_json),errorCode:rejected.error_code,schemaIssues:repairSchemaIssues,
     ...(isDiverseTemplate(snapshot.templateVersion)?{validationIssues:[...repairSchemaIssues,...planRepairIssues(JSON.parse(rejected.output_json),snapshot,previous.understanding)]}:{}),
     referenceRequirement:snapshot.references.map(r=>r.id),copyRequirement:'Only source IDs of user facts or image observations; directions are not copy evidence.'};
   }
  }
  if(request.repairRunId&&['style','listing'].includes(request.kind)){
   const rejectedRun=get(request.repairRunId),failure=store.get('SELECT output_json,issues_json,error_code FROM text_validation_failures WHERE run_id=? AND operation=?',request.repairRunId,request.kind);
   fail(rejectedRun.state==='failed'&&rejectedRun.kind===request.kind&&failure&&sourceDigest(rejectedRun.snapshot)===sourceDigest(snapshot),'TEXT_SOURCE_CHANGED','待修复文字来源不匹配',409);
   const rejectedOutput=JSON.parse(failure.output_json);
   snapshot.addonRepair={fromRunId:rejectedRun.id,errorCode:failure.error_code,issues:[...JSON.parse(failure.issues_json),...addonRepairIssues(request.kind,rejectedOutput,previous?.understanding??rejectedRun.understanding)],rejectedOutput};
  }
  if(request.repairRunId&&!previous){
   const rejectedRun=get(request.repairRunId),failure=store.get("SELECT output_json,error_code FROM text_validation_failures WHERE run_id=? AND operation='understand'",request.repairRunId);
   fail(rejectedRun.state==='failed'&&failure&&sourceDigest(rejectedRun.snapshot)===sourceDigest(snapshot),'TEXT_SOURCE_CHANGED','待修复商品理解来源不匹配',409);
   snapshot.understandingRepair={version:'understanding-repair.1',fromRunId:rejectedRun.id,errorCode:failure.error_code,rejectedOutput:JSON.parse(failure.output_json)};
  }
  const id=randomUUID(),time=Date.now();
  store.transaction(()=>{
   store.run('INSERT INTO text_runs(id,idempotency_key,request_hash,product_id,kind,state,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id,idempotencyKey,requestHash,snapshot.productId,request.kind,'running',json(snapshot),time,time);
   for(const r of [...snapshot.references,...(snapshot.layouts??[]).map(l=>l.reference),...(request.kind==='quality'?qualityAttachments(store,snapshot).map(x=>({assetId:x.asset.id})):[])])store.run('INSERT OR IGNORE INTO text_run_references VALUES(?,?)',id,r.assetId);
  });
  const controller=new AbortController();activeRun={id,controller};
  active=Promise.resolve().then(()=>{if(!controller.signal.aborted)return execute(id,snapshot,request.kind,previous,controller.signal);}).finally(()=>{active=null;activeRun=null;});
  return {run:get(id),duplicate:false};
 }
 function reviewRetained(id,idempotencyKey){
  fail(typeof idempotencyKey==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(idempotencyKey),'INVALID_INPUT','需要有效提交编号');
  const requestHash=hash(canonical({operation:'review-retained',id})),existing=store.get('SELECT * FROM text_runs WHERE idempotency_key=?',idempotencyKey);
  if(existing){fail(existing.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','请求内容已变化',409);return {run:view(existing),duplicate:true};}
  const prior=get(id),rejected=store.get("SELECT * FROM text_validation_failures WHERE run_id=? AND operation='plan'",id);
  fail(isIntentTemplate(prior.snapshot.templateVersion)&&prior.state==='failed'&&(rejected?.error_code==='TEXT_REGION_TOO_SMALL'||prior.snapshot.templateVersion===LIFESTYLE_TEMPLATE&&rejected?.output_json&&store.get("SELECT id FROM text_calls WHERE id=? AND state='received' AND error_code IS NULL",rejected.call_id)),'TASK_NOT_RETRYABLE','只可复用已有有效模型回执、可重新通过完整校验的新版规划',409);
  const ready=readReady();fail(ready.ready&&!ready.paused,'MIMO_NOT_READY','文字服务未就绪',503);
  fail(!closing&&!active,'TEXT_BUSY','已有文字任务执行中',409);fail(!ledgerState(store,config).unknown,'BILLING_UNKNOWN','存在未知回执，未启动复核',409);
  const snapshot=JSON.parse(store.get('SELECT snapshot_json FROM text_runs WHERE id=?',id).snapshot_json),raw=JSON.parse(rejected.output_json);
  validateUnderstandingOutput(prior.understanding,snapshot);validatePlanOutput(raw,snapshot,prior.understanding);
  snapshot.validationReview={version:'semantic-review-retained.1',sourceRunId:id,sourceCallId:rejected.call_id};
  const nextId=randomUUID(),time=Date.now();
  store.transaction(()=>{
   store.run('INSERT INTO text_runs(id,idempotency_key,request_hash,product_id,kind,state,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',nextId,idempotencyKey,requestHash,snapshot.productId,'plan','running',json(snapshot),time,time);
   for(const r of [...snapshot.references,...(snapshot.layouts??[]).map(l=>l.reference)])store.run('INSERT OR IGNORE INTO text_run_references VALUES(?,?)',nextId,r.assetId);
  });
  const controller=new AbortController();activeRun={id:nextId,controller};
  active=Promise.resolve().then(()=>{if(!controller.signal.aborted)return execute(nextId,snapshot,'plan',prior,controller.signal,{output:raw,callId:rejected.call_id});}).finally(()=>{active=null;activeRun=null;});
  return {run:get(nextId),duplicate:false};
 }
 function revalidate(id,idempotencyKey){
  fail(typeof idempotencyKey==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(idempotencyKey),'INVALID_INPUT','需要有效提交编号');
  const requestHash=hash(canonical({operation:'revalidate',id})),existing=store.get('SELECT * FROM text_runs WHERE idempotency_key=?',idempotencyKey);
  if(existing){fail(existing.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','请求内容已变化',409);return {run:view(existing),duplicate:true};}
  const prior=get(id),rejected=store.get("SELECT * FROM text_validation_failures WHERE run_id=? AND operation='plan'",id);
  fail(prior.kind==='plan'&&prior.state==='failed'&&prior.understanding&&rejected,'TASK_NOT_RETRYABLE','这份规划没有可重新校验的模型输出',409);
  const snapshot=JSON.parse(store.get('SELECT snapshot_json FROM text_runs WHERE id=?',id).snapshot_json);
  fail(!isIntentTemplate(snapshot.templateVersion),'SEMANTIC_REVIEW_REQUIRED','这份方案需要独立语义复核，不能只按格式重新校验后放行',409);
  validateUnderstandingOutput(prior.understanding,snapshot);
  const output=validatePlanOutput(JSON.parse(rejected.output_json),snapshot,prior.understanding);
  snapshot.validationReview={version:'validation-review.1',sourceRunId:id,sourceCallId:rejected.call_id};
  const nextId=randomUUID(),time=Date.now();
  store.transaction(()=>{
   store.run('INSERT INTO text_runs(id,idempotency_key,request_hash,product_id,kind,state,snapshot_json,understanding_json,output_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',nextId,idempotencyKey,requestHash,snapshot.productId,'plan','succeeded',json(snapshot),json(prior.understanding),json(output),time,time);
   for(const r of [...snapshot.references,...(snapshot.layouts??[]).map(l=>l.reference)])store.run('INSERT OR IGNORE INTO text_run_references VALUES(?,?)',nextId,r.assetId);
  });return {run:get(nextId),duplicate:false};
 }
 return {get,submit,revalidate,reviewRetained,prepare:snapshotOf,cancel(id){
   const run=get(id);if(run.state==='running'){
    store.run("UPDATE text_runs SET state='canceled',updated_at=? WHERE id=? AND state='running'",Date.now(),id);
    if(activeRun?.id===id)activeRun.controller.abort();
   }return get(id);
  },list:()=>store.all('SELECT * FROM text_runs ORDER BY created_at DESC LIMIT 100').map(row=>{const {understanding,output,calls,...summary}=view(row);return summary;}),
  status:()=>({...readReady(),templateVersion:config.mimo?.templateVersion??BASELINE_TEMPLATE,busy:!!active,billingUnknown:ledgerState(store,config).unknown}),
  async close(){closing=true;await active;}};
}
