import {LIFESTYLE_TEMPLATE} from '../../src/workflow/lifestyle-design.js';
import {FULLCANVAS_TEMPLATE,isFullcanvasTemplate} from '../../src/workflow/fullcanvas-design.js';
import {isIntentTemplate,INTENT_TEMPLATE} from '../../src/workflow/intent-design.js';
import {ADAPTIVE_TEMPLATE,isAdaptiveTemplate,isReviewedTemplate} from '../../src/workflow/adaptive-design.js';
import {adaptiveCompositor} from './adaptive-compose.mjs';
import {REVIEWED_TEMPLATE} from '../../src/workflow/reviewed-design.js';
import {ART_TEMPLATE} from '../../src/workflow/art-directed-design.js';
import {initComposeRecovery,withComposeRecovery} from './compose-recovery.mjs';
import {BETA_TEMPLATE,betaLayers} from '../../src/workflow/beta-design.js';
import {resultLayers} from './result-layers.mjs';
import {TYPOGRAPHY_TEMPLATE} from '../../src/workflow/typography-design.js';
import {localCompositor} from './local-compose.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../store.mjs';
import { Executor } from '../executor.mjs';
import { Fault, fail, hash, canonical, ProcessorError } from '../core.mjs';
import { createApiHandler, jsonBody, body } from '../http.mjs';
import { createStage2Processor, processorIdentity } from '../../src/workflow/stage2-adapter.js';
import { planSubmission, MODEL } from './planning.mjs';
import { createProviderHandlers, readiness, initLedger, ledgerState } from './provider.mjs';
import {correctionSnapshot,withCorrections} from './corrections.mjs';
import {localRecognizer,recognitionService} from './recognition.mjs';
import {createTextService} from './mimo-service.mjs';
import {defaultConnection,connectionIdentity,sameConnection,legacyConnection} from './model-catalog.mjs';
import {createImageRouter,modelReadiness,reserveFor} from './model-router.mjs';
import {createConnectionTests} from './connection-tests.mjs';
import {preflightImage,imageAssets} from './model-adapters.mjs';
import {imagePrompt} from '../../src/workflow/prompts.js';
import {executableTextPlan,textPlanningHandlers} from './minimum-plan.mjs';
import {createLayoutRegistry} from './layouts.mjs';
import {createKitRuns} from './kit-runs.mjs';
import {referenceConsent} from './reference-consent.mjs';
import {listingEdits} from './listing-edits.mjs';
import {createQualityReviews} from './quality-review.mjs';

export function loadConfig(root){
 const file=process.env.AIGC_CONFIG_FILE;
 if(!file)return {};
 const real=fs.realpathSync(file),relative=path.relative(root,real);
 fail(!relative.startsWith('src'+path.sep)&&!relative.startsWith('assets'+path.sep),'UNSAFE_CONFIG','Configuration must be outside public directories');
 const mode=fs.statSync(real).mode;
 fail((mode&0o077)===0,'UNSAFE_CONFIG','Configuration must have mode 600');
 return JSON.parse(fs.readFileSync(real,'utf8'));
}
export function createRuntime({dataDir,config={},key=process.env.ARK_API_KEY??'',mimoKey='',apiSettings=null,mimoTransport,imageTransport,downloadTransport,connectionTimeoutMs, textTimeoutMs,testHandlers=null,recognizeText=undefined,layoutCatalog}){
 if(apiSettings){key=()=>apiSettings.key('image');mimoKey=()=>apiSettings.key('text');}
 const imageConnection=()=>apiSettings?apiSettings.connection('image'):{...defaultConnection('image'),kind:'image',key:typeof key==='function'?key():key};
 const imageReady=()=>apiSettings?modelReadiness('image',config,imageConnection()):readiness(config,key);
 const originalConfig=config;config=Object.create(config);Object.defineProperty(config,'reservePerImageCny',{get:()=>reserveFor('image',imageConnection(),originalConfig)??originalConfig.reservePerImageCny});
 const isTest=!!testHandlers,paused=!isTest&&config.modelCallsPaused!==false;
 const store=new Store({dataDir,config:{maxReferences:6,maxSlots:20,maxAttempts:2,timeoutMs:180000,concurrency:1,pollMs:100,leaseMs:30000}});
 const consent=referenceConsent(store,originalConfig);
 const listings=listingEdits(store);
 Object.defineProperty(config,'authorizedReferenceHashes',{get:()=>[...new Set([...(originalConfig.authorizedReferenceHashes??[]),...consent.hashes()])]});
 Object.defineProperty(config,'mimo',{get:()=>({...originalConfig.mimo,authorizedReferenceHashes:[...new Set([...(originalConfig.mimo?.authorizedReferenceHashes??[]),...consent.hashes()])]})});
 const check=imageReady();
 initLedger(store);
 const layouts=createLayoutRegistry(store,layoutCatalog);
 const textService=createTextService({store,config,key:mimoKey,connection:apiSettings?()=>apiSettings.connection('text'):null,transport:mimoTransport,timeoutMs:textTimeoutMs??(Number.isInteger(config.mimo?.requestTimeoutMs)&&config.mimo.requestTimeoutMs>=90000&&config.mimo.requestTimeoutMs<=300000?config.mimo.requestTimeoutMs:undefined),layouts});
 const recognition=recognitionService(store,recognizeText===undefined?localRecognizer(dataDir):recognizeText);
 const quality=createQualityReviews({store,textService,config,recognition});
 store.db.exec(`CREATE TABLE IF NOT EXISTS integration_products (client_id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id));
 CREATE TABLE IF NOT EXISTS integration_uploads (client_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id));`);
 const tests=apiSettings?createConnectionTests({store,config,apiSettings,textTransport:mimoTransport,imageTransport,downloadTransport,timeoutMs:connectionTimeoutMs}):null;
 const handlers=testHandlers??(apiSettings?createImageRouter({store,config,key,connection:imageConnection,transport:imageTransport,downloadTransport}):createProviderHandlers({store,config,key,transport:imageTransport}));
 initComposeRecovery(store);
 handlers.generate=withComposeRecovery(store,handlers.generate);
 store.db.exec(`CREATE TABLE IF NOT EXISTS adaptive_compositions(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),base_asset_id TEXT NOT NULL REFERENCES assets(id),underlay_asset_id TEXT NOT NULL REFERENCES assets(id),layout_json TEXT NOT NULL,analysis_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 const adaptive=adaptiveCompositor(dataDir,{persist:({request,underlay,layout,analysis})=>{
  const c=request.executionContext;if(!c)throw Error('COMPOSITION_CONTEXT_REQUIRED');
  const call=store.get("SELECT asset_id FROM provider_calls WHERE attempt_id=? AND state='received'",c.attemptId)??store.get("SELECT p.asset_id FROM compose_recoveries r JOIN provider_calls p ON p.id=r.source_call_id WHERE r.attempt_id=? AND p.state='received'",c.attemptId);
  // Test providers have no paid-call rows. Their synthetic underlay remains traceable.
  const parent=call?.asset_id??(isTest?store.task(c.taskId).input.references[0].assetId:null);if(!parent)throw Error('COMPOSITION_BASE_REQUIRED');
  const asset=store.putAsset(underlay,{kind:'derived',parentId:parent,mediaType:'image/png',name:`layout-base-${c.attemptId}.png`});
  store.run('INSERT INTO adaptive_compositions VALUES(?,?,?,?,?,?)',c.attemptId,parent,asset.id,JSON.stringify(layout),JSON.stringify(analysis),Date.now());
 }});
 const compose=localCompositor(dataDir),legacyCompose=handlers.compose;
 handlers.compose=request=>isAdaptiveTemplate(request.prompt?.data.templateVersion)?adaptive(request):request.prompt?.data.copyMode==='source-aware-overlay'?compose(request):legacyCompose(request);
 const processor=withCorrections(createStage2Processor({handlers,ProcessorError,id:isTest?'integration-test-only':'seedream-flash-integration'}),{store,handlers});
 store.processor=processorIdentity(processor);
 if(!isTest)processor.canSchedule=()=>config.modelCallsPaused===false&&imageReady().ready&&!ledgerState(store,config).unknown;
 let executor=isTest||check.ready&&!paused?new Executor(store,processor).start():null;
 const status=()=>({contract:'backend-v1-provisional',integration:'round1',mode:isTest?'TEST_ONLY':imageReady().ready?'REAL_PROVIDER_CONFIGURED':'NO_REAL_PROVIDER',model:imageConnection().model,
  ready:!!executor&&!executor.fatal&&!kitRuns.fatal&&!quality.fatal&&!tests?.busy&&(isTest||imageReady().ready&&!ledgerState(store,config).unknown),missing:imageReady().missing,modelCallsPaused:paused,
  capabilities:{images:!!executor,corrections:!!executor,recognition:recognition.available,understanding:textService.status().ready?textService.status().model:'not-configured',planning:'mimo-executable',text:textService.status().ready,customLayouts:true,visualQA:false},text:textService.status(),
  executor:executor?{running:!executor.stopping,error:executor.fatal??kitRuns.fatal??quality.fatal}:null,billingUnknown:!isTest&&ledgerState(store,config).unknown});
 async function submitKit(input,key,frozenProduct=null){
   fail(typeof key==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(key),'INVALID_INPUT','Valid idempotency key required');
   const requestHash=hash(canonical(input));let existing=store.get('SELECT * FROM integration_submissions WHERE key=?',key);
   // A crash between durable enqueue and the auxiliary receipt must not cause a new plan/call.
   if(!existing){
    const old=store.get('SELECT id FROM tasks WHERE idempotency_key=?',key);
    if(old){const saved=store.task(old.id).input;
     const original={productId:saved.product.id,productRevision:saved.product.revision,description:saved.description,settings:saved.settings.effectiveSettings,
      ...(saved.settings.workflow03A?.minimumMvp?{planRunId:saved.settings.workflow03A.minimumMvp.runId}:{})};
     existing={task_id:old.id,request_hash:hash(canonical(original))};
    }
   }
   if(existing){fail(existing.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','Submission has changed',409);return {task:store.task(existing.task_id),duplicate:true};}
   const service=status();
   fail(service.ready,paused&&!service.missing.length?'MODEL_CALLS_PAUSED':'PROVIDER_NOT_READY',service.billingUnknown?'上游请求结果与费用待核对，已停止后续生成。':service.missing.length?`真实生成暂未就绪。待补充：${service.missing.join('、')}。商品资料已保存。`:paused?'模型调用当前暂停，原图和历史仍可查看与下载。':'后台执行器暂不可用，请查看服务状态。',503);
   fail(input&&Object.keys(input).every(k=>['productId','productRevision','description','settings','planRunId'].includes(k)),'INVALID_INPUT','套图请求包含未知字段');
   fail(input.planRunId===undefined||typeof input.planRunId==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(input.planRunId),'INVALID_INPUT','规划记录ID无效');
   fail(input.planRunId||isTest||config.planningMode==='rules-v2','PLAN_REQUIRED','请先完成商品理解与套图规划',409);
   const pinned=input.planRunId?executableTextPlan(store,textService.get(input.planRunId),input,frozenProduct):null;
   if([TYPOGRAPHY_TEMPLATE,BETA_TEMPLATE,ART_TEMPLATE,REVIEWED_TEMPLATE,ADAPTIVE_TEMPLATE,INTENT_TEMPLATE,FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(pinned?.templateVersion)){try{await (isAdaptiveTemplate(pinned.templateVersion)?adaptive:compose).prepare();}catch{fail(false,'COMPOSITOR_UNAVAILABLE','本机排字服务暂不可用，尚未提交图片模型请求',503);}}
   const body=await planSubmission(store,pinned?textPlanningHandlers(handlers,pinned):handlers,input,key,pinned,apiSettings?imageConnection():null,frozenProduct);
   if(apiSettings){const prepared=body.settings.workflow03A;for(const image of prepared.plan.images){const prompt=imagePrompt(prepared,image);preflightImage(imageConnection(),imageAssets(store,imageConnection(),prompt.data.references),{image,prompt});}}
   if(!isTest){
    fail(body.productId&&(frozenProduct??store.product(body.productId)).references.every(r=>config.authorizedReferenceHashes.includes(store.asset(r.assetId).sha256)),'REFERENCE_NOT_AUTHORIZED','参考图尚未获本轮模型上传授权',403);
    const pending=store.all("SELECT c.id FROM children c JOIN tasks t ON t.id=c.task_id WHERE c.state='queued' AND t.state IN ('queued','running')").length;
    fail(ledgerState(store,config).reservedCny+(pending+body.slots.length)*config.reservePerImageCny<=config.budgetCny+1e-8,'BUDGET_LIMIT','本轮剩余预算不足以预留整套请求',409);
   }
   const submission=frozenProduct?store.enqueueSnapshot({contractVersion:1,product:frozenProduct,references:frozenProduct.references.map(r=>({...r,asset:store.asset(r.assetId)})),settings:body.settings,description:body.description,slots:body.slots,versions:body.versions},key,requestHash):store.submit(body,key);
   store.run('INSERT OR IGNORE INTO integration_submissions VALUES(?,?,?)',key,requestHash,submission.task.id);
   executor.tick();return submission;
 }
 const kitRuns=createKitRuns({store,textService,submitKit,cancelTask:id=>executor?executor.cancel(id):store.cancel(id),config,quality,isReady:kind=>textService.status().ready&&(kind==='assist'||status().ready)});
 const route=async({req,send,parts,method})=>{
  const [resource,id,action]=parts;
  fail(req.headers['sec-fetch-site']!=='cross-site','ORIGIN_REJECTED','Cross-site access is disabled',403);
  if(resource==='kit-runs'&&parts.length===1&&method==='POST'){const input=await jsonBody(req);if(!store.get('SELECT id FROM kit_runs WHERE batch_id=?',req.headers['idempotency-key']??'')&&Array.isArray(input?.items))consent.submit(input.items,'submit-kit-run');const result=kitRuns.submit(input,req.headers['idempotency-key']);send(result.duplicate?200:202,result);return true;}
  if(resource==='kit-runs'&&parts.length<=2&&method==='GET'){send(200,id?kitRuns.get(id):{runs:kitRuns.list()});return true;}
  if(resource==='kit-runs'&&parts.length===3&&action==='cancel'&&method==='POST'){send(200,kitRuns.cancel(id));return true;}
  if(resource==='kit-runs'&&parts.length===3&&action==='retry'&&method==='POST'){send(200,kitRuns.retry(id,await jsonBody(req)));return true;}
  if(resource==='api-settings'&&id==='test'){
   fail(tests,'SETTINGS_UNAVAILABLE','当前服务未启用连接测试',503);
   if(method==='POST'&&parts.length===2){const input=await jsonBody(req);fail(!kitRuns.active&&!quality.active&&!tests?.busy&&!textService.status().busy&&!executor?.running.size&&!store.get("SELECT id FROM tasks WHERE state IN ('queued','running') LIMIT 1"),'SETTINGS_BUSY','请等待正在执行的任务完成后测试连接',409);send(202,tests.start(input));return true;}
   if(method==='GET'&&parts.length===3){send(200,tests.get(action));return true;}
   if(method==='POST'&&parts.length===4&&parts[3]==='cancel'){send(200,tests.cancel(action));return true;}
  }
  if(resource==='api-settings'&&parts.length===1&&['GET','PUT'].includes(method)){
   fail(apiSettings,'SETTINGS_UNAVAILABLE','当前服务未启用网页 API 设置',503);
   if(method==='GET'){send(200,apiSettings.view());return true;}
   const input=await jsonBody(req);
   // No await between the busy check and atomic save: an active workflow keeps its credentials.
   fail(!kitRuns.active&&!quality.active&&!tests?.busy&&!textService.status().busy&&!executor?.running.size&&!store.get("SELECT id FROM tasks WHERE state IN ('queued','running') LIMIT 1")&&!store.get("SELECT id FROM provider_calls WHERE state='sent' LIMIT 1")&&!store.get("SELECT id FROM text_calls WHERE state='sent' LIMIT 1"),'SETTINGS_BUSY','有任务正在执行或排队，请结束后再保存 API 设置',409);
   const saved=apiSettings.save(input);
   if(!executor&&!paused&&imageReady().ready)executor=new Executor(store,processor).start();
   send(200,{...saved,health:status()});return true;
  }
  if(resource==='health'&&method==='GET'){send(200,status());return true;}
  if(resource==='tasks'&&id&&action==='quality'&&parts[3]==='cancel'&&parts.length===4&&method==='POST'){quality.cancel(id);send(200,quality.view(id));return true;}
  if(resource==='tasks'&&id&&action==='quality'&&parts.length===3){
   if(method==='GET'){send(200,quality.view(id));return true;}
   if(method==='POST'){const input=await jsonBody(req);fail(input&&Object.keys(input).every(k=>k==='retry')&&(input.retry===undefined||typeof input.retry==='boolean'),'INVALID_INPUT','检查参数无效');fail(!tests?.busy&&textService.status().ready,'PROVIDER_NOT_READY','文字服务暂不可用',503);send(202,quality.enqueue(id,input));return true;}
  }
  if(resource==='listing-edits'&&parts.length===1&&method==='GET'){send(200,{edits:listings.list()});return true;}
  if(resource==='tasks'&&id&&action==='listing'&&parts.length===3){
   if(method==='GET'){send(200,{versions:listings.history(id)});return true;}
   if(method==='POST'){send(200,listings.save(id,await jsonBody(req),req.headers['idempotency-key']));return true;}
  }
  if(resource==='text-runs'&&parts.length===1&&method==='POST'){fail(!tests?.busy,'TEST_BUSY','连接测试进行中，请稍后再试',409);const input=await jsonBody(req);if(!store.get('SELECT id FROM text_runs WHERE idempotency_key=?',req.headers['idempotency-key']??''))consent.submit([input],'submit-text-run');const result=textService.submit(input,req.headers['idempotency-key']);send(result.duplicate?200:202,result);return true;}
  if(resource==='text-runs'&&id&&action==='cancel'&&parts.length===3&&method==='POST'){send(200,textService.cancel(id));return true;}
  if(resource==='text-runs'&&id&&action==='review-retained'&&parts.length===3&&method==='POST'){fail(!tests?.busy,'TEST_BUSY','连接测试进行中',409);send(202,textService.reviewRetained(id,req.headers['idempotency-key']));return true;}
  if(resource==='text-runs'&&id&&action==='revalidate'&&parts.length===3&&method==='POST'){send(200,textService.revalidate(id,req.headers['idempotency-key']));return true;}
  if(resource==='text-runs'&&method==='GET'&&parts.length<=2){send(200,id?textService.get(id):{runs:textService.list()});return true;}
  if(resource==='products'&&!id&&method==='GET'){send(200,{products:store.products().map(p=>({...p,clientId:store.get('SELECT client_id FROM integration_products WHERE product_id=?',p.id)?.client_id}))});return true;}
  if(resource==='draft-products'&&method==='POST'){
   const input=await jsonBody(req);fail(typeof input.clientId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(input.clientId),'INVALID_INPUT','Client product ID required');
   let row=store.get('SELECT product_id FROM integration_products WHERE client_id=?',input.clientId);
   if(!row){store.transaction(()=>{const p=store.createProduct({name:input.name,facts:input.facts});store.run('INSERT INTO integration_products VALUES(?,?)',input.clientId,p.id);row={product_id:p.id};});}
   send(200,store.product(row.product_id));return true;
  }
  if(resource==='assets'&&!id&&method==='POST'&&req.headers['x-asset-client-id']){
   const clientId=req.headers['x-asset-client-id'];fail(/^[a-zA-Z0-9_-]{1,100}$/.test(clientId),'INVALID_INPUT','Asset client ID invalid');
   const bytes=await body(req,store.config.maxAssetBytes),row=store.get('SELECT asset_id FROM integration_uploads WHERE client_id=?',clientId);
   if(row){const a=store.asset(row.asset_id);fail(a.sha256===hash(bytes),'IDEMPOTENCY_CONFLICT','Asset bytes changed',409);send(200,a);return true;}
   const a=store.putAsset(bytes,{kind:'original',name:decodeURIComponent(req.headers['x-asset-name']??'upload'),mediaType:req.headers['content-type']});
   store.run('INSERT INTO integration_uploads VALUES(?,?)',clientId,a.id);send(201,a);return true;
  }
  // Prepared workflow is server-owned. Browser cannot smuggle arbitrary handlers, slots or policy.
  if(resource==='tasks'&&!id&&method==='POST')throw new Fault('USE_KIT_ENDPOINT','Submit through /kits',400);
  if(resource==='results'&&id&&action==='layers'&&parts.length===4&&method==='GET'){fail(/^[1-9][0-9]*$/.test(parts[3]),'INVALID_INPUT','图片版本无效');send(200,resultLayers(store,id,Number(parts[3])));return true;}
  if(resource==='results'&&id&&action==='recognitions'&&parts.length===3&&method==='POST'){
   const input=await jsonBody(req);fail(input&&Number.isInteger(input.expectedVersion),'INVALID_INPUT','请选择图片版本');send(200,await recognition.recognize(id,input.expectedVersion));return true;
  }
  if(resource==='results'&&id&&action==='corrections'&&parts.length===3&&method==='POST'){
   const input=await jsonBody(req),key=req.headers['idempotency-key'];
   fail(typeof key==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(key),'INVALID_INPUT','Valid idempotency key required');
   const requestHash=hash(canonical({resultId:id,correction:input})),existing=store.get('SELECT * FROM integration_submissions WHERE key=?',key)??store.get('SELECT id AS task_id,request_hash FROM tasks WHERE idempotency_key=?',key);
   if(existing){fail(existing.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','Submission has changed',409);send(200,{task:store.task(existing.task_id),duplicate:true});return true;}
   fail(!paused,'MODEL_CALLS_PAUSED','模型调用当前暂停，原图和历史仍可查看与下载',503);
   fail(status().ready,'PROVIDER_NOT_READY','后台暂不可用或上游费用待核对，请查看服务状态',503);
   const snapshot=correctionSnapshot(store,id,input,config.mimo?.templateVersion);
   if(snapshot.settings.correction.kind==='restore')consent.restore(snapshot.settings.correction.originalAssetId);
   if(apiSettings)imageAssets(store,imageConnection(),snapshot.references);
   fail(sameConnection(snapshot.settings.modelConnection??defaultConnection('image'),imageConnection()),'MODEL_CHANGED','请在 API 设置中切回这张结果使用的生图模型和地址，再进行修改',409);
   if(!isTest){
    fail(snapshot.references.filter(r=>r.role!=='current').every(r=>config.authorizedReferenceHashes.includes(store.asset(r.assetId).sha256)),'REFERENCE_NOT_AUTHORIZED','参考图尚未获本轮模型上传授权',403);
    // Completed/rejected receipts are bounded; any sent/unknown call must settle before another paid correction.
    fail(!store.get("SELECT id FROM provider_calls WHERE state IN ('sent','unknown','late')"),'RETRY_REQUIRES_REVIEW','上游请求仍在执行或结果待核对',409);
    const pending=store.all("SELECT c.id FROM children c JOIN tasks t ON t.id=c.task_id WHERE c.state='queued' AND t.state IN ('queued','running')").length;
    fail(ledgerState(store,config).reservedCny+(pending+1)*config.reservePerImageCny<=config.budgetCny+1e-8,'BUDGET_LIMIT','本轮剩余预算不足以预留单张修改',409);
   }
   const submission=store.enqueueSnapshot(snapshot,key,requestHash);
   store.run('INSERT INTO integration_submissions VALUES(?,?,?)',key,requestHash,submission.task.id);
   executor.tick();send(201,submission);return true;
  }
  if(resource==='results'&&id&&action==='versions'&&parts.length===3&&method==='POST'){
   const input=await jsonBody(req),key=req.headers['idempotency-key'];
   fail(typeof key==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(key),'INVALID_INPUT','编辑保存需要有效提交编号');
   fail(input&&Object.keys(input).every(k=>['assetId','expectedVersion'].includes(k)),'INVALID_INPUT','编辑保存参数无效');
   send(201,store.appendVersion(id,input,key));return true;
  }
  if(resource==='results'&&method==='POST')throw new Fault('EDIT_NOT_CONNECTED','Use the single-image correction endpoint',409);
  if(resource==='kits'&&parts.length===1&&method==='POST'){const result=await submitKit(await jsonBody(req),req.headers['idempotency-key']);send(result.duplicate?200:201,result);return true;}
  if(resource==='tasks'&&action==='retry'&&method==='POST'&&!isTest){
   fail(!paused,'MODEL_CALLS_PAUSED','模型调用当前暂停',503);
   fail(status().ready,'PROVIDER_NOT_READY','后台不可用或费用待核对',503);
   const input=await jsonBody(req),task=store.task(id);
   fail(Object.keys(input).every(k=>['childIds','expectedRevision','regenerateBase'].includes(k))&&(input.regenerateBase===undefined||typeof input.regenerateBase==='boolean'),'INVALID_INPUT','重试参数无效');
   fail(sameConnection(task.input.settings.modelConnection??defaultConnection('image'),imageConnection()),'MODEL_CHANGED','请先切回原任务的生图模型和地址，再重试',409);
   fail(Array.isArray(input.childIds)&&input.childIds.length===1,'INVALID_INPUT','每次只重试一张失败图片');
   const child=task.children.find(c=>c.id===input.childIds[0]);
   fail(child?.state==='failed'&&!child.error?.outcomeUnknown,'RETRY_REQUIRES_REVIEW','请求结果不明或图片并非失败状态，不能重发',409);
   fail(!store.get("SELECT id FROM provider_calls WHERE state IN ('sent','unknown','late')")&&!store.get("SELECT id FROM text_calls WHERE state='sent'")&&!ledgerState(store,config).unknown,'RETRY_REQUIRES_REVIEW','已有上游请求或费用待核对',409);
   fail(task.input.references.every(r=>config.authorizedReferenceHashes.includes(store.asset(r.assetId).sha256)),'REFERENCE_NOT_AUTHORIZED','原始参考图授权待核对',403);
   const localOnly=!input.regenerateBase&&isFullcanvasTemplate(task.input.settings.workflow03A?.minimumMvp?.templateVersion)&&child.attempts.at(-1)?.receipt?.workflow?.trace.some(n=>n.id==='compose'&&n.status==='failed'&&n.error?.code==='COMPOSE_FAILED')&&!!store.get("SELECT p.id FROM provider_calls p JOIN attempts a ON a.id=p.attempt_id WHERE a.child_id=? AND p.state='received' AND p.asset_id IS NOT NULL AND p.error_code IS NULL",child.id);
   const pending=store.get("SELECT count(*) AS n FROM children c JOIN tasks t ON t.id=c.task_id WHERE c.state='queued' AND t.state IN ('queued','running')").n;
   fail(localOnly||ledgerState(store,config).reservedCny+(pending+1)*config.reservePerImageCny<=config.budgetCny+1e-8,'BUDGET_LIMIT','剩余预算不足以预留单张重试',409);
   let sourceCall;
   if(input.regenerateBase){
    fail(isFullcanvasTemplate(task.input.settings.workflow03A?.minimumMvp?.templateVersion)&&child.attempts.at(-1)?.receipt?.workflow?.trace.some(n=>n.id==='compose'&&n.status==='failed'&&n.error?.code==='COMPOSE_FAILED'),'TASK_NOT_RETRYABLE','仅已收到底图但排版失败的新任务可重新构图',409);
    sourceCall=store.get("SELECT id FROM provider_calls WHERE attempt_id=? AND state='received' AND asset_id IS NOT NULL",child.attempts.at(-1).id);fail(sourceCall,'TASK_NOT_RETRYABLE','未找到已确认底图，不能重新构图',409);
   }
   const result=store.retry(id,input,targets=>{if(sourceCall)for(const c of targets)store.run('INSERT INTO compose_reframes VALUES(?,?,?,?,?)',c.id,c.generation+1,sourceCall.id,task.input.settings.workflow03A?.minimumMvp?.marketPolicy?.version==='market.2'?'composition-reframe.4':task.input.settings.workflow03A?.minimumMvp?.templateVersion===LIFESTYLE_TEMPLATE?'composition-reframe.2':'composition-reframe.1',Date.now());},{localOnly});executor.tick();send(200,result);return true;
  }
  if(resource==='tasks'&&action==='calls'&&method==='GET'){
   store.task(id);send(200,{calls:store.all('SELECT id,attempt_id AS attemptId,state,request_id AS requestId,usage_json AS usage,started_at AS startedAt,ended_at AS endedAt,error_code AS errorCode FROM provider_calls WHERE task_id=?',id)});return true;
  }
  return false;
 };
 const liveExecutor={tick:()=>executor?.tick(),cancel:id=>executor?executor.cancel(id):store.cancel(id)};
 return {store,get executor(){return executor;},handlers,textService,kitRuns,quality,status,handler:createApiHandler({store,executor:liveExecutor,route}),async close(){await kitRuns.close();await quality.close();await tests?.close();await textService.close();if(executor)await executor.stop();store.close();}};
}
