import { createHash, randomUUID } from 'node:crypto';
import { WorkflowError } from '../../src/workflow/value.js';
import { factualUnderstanding, rulesPlan, MODEL } from './planning.mjs';
import { json } from '../core.mjs';
import {currentKey} from './credentials.mjs';

const ENDPOINT='https://ark.cn-beijing.volces.com/api/v3/images/generations';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function readiness(config={},key=''){
 key=currentKey(key);
 const missing=[];
 if(!key)missing.push('服务端凭证');
 if(config.accountConfirmed!==true)missing.push('北京区域模型权限确认');
 if(typeof config.budgetId!=='string'||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(config.budgetId)||!Number.isFinite(config.budgetCny)||config.budgetCny<=0||!Number.isFinite(config.reservePerImageCny)||config.reservePerImageCny<=0||typeof config.priceEvidence!=='string'||!config.priceEvidence.trim())missing.push('本轮预算与单次费用上界依据');
 if(!Array.isArray(config.authorizedReferenceHashes)||!config.authorizedReferenceHashes.length||!config.authorizedReferenceHashes.every(h=>/^[0-9a-f]{64}$/.test(h))||typeof config.authorizationEvidence!=='string'||!config.authorizationEvidence.trim())missing.push('授权参考图及事实');
 return {ready:!missing.length,missing};
}
export function initLedger(store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS provider_calls (
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
 budget_id TEXT NOT NULL,reserved_cny REAL NOT NULL,state TEXT NOT NULL,request_json TEXT NOT NULL,
 request_id TEXT,usage_json TEXT,asset_id TEXT REFERENCES assets(id),started_at INTEGER NOT NULL,ended_at INTEGER,error_code TEXT);
 CREATE TABLE IF NOT EXISTS integration_submissions (key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id));`);
 // No replay after a lost process. Reservation remains until explicit billing reconciliation.
 store.run("UPDATE provider_calls SET state='unknown',error_code='PROCESS_INTERRUPTED' WHERE state='sent'");
}
export function ledgerState(store,config){
 const rows=store.all('SELECT state,reserved_cny FROM provider_calls WHERE budget_id=?',config.budgetId??'');
 const hasText=store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='text_calls'");
 const text=hasText?store.all('SELECT state,reserved_cny,cost_cny FROM text_calls WHERE budget_id=?',config.budgetId??''):[];
 const hasTests=store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='connection_tests'");
 const tests=hasTests?store.all('SELECT state,reserved_cny FROM connection_tests WHERE budget_id=?',config.budgetId??''):[];
 // An explicit owner acknowledgment permits a new request, never changes the
 // unknown receipt or refunds its full reservation. Unlisted calls still block.
 const reviews=Array.isArray(config.acknowledgedUnknownTextCalls)?config.acknowledgedUnknownTextCalls:[];
 const textUnknown=hasText&&(reviews.length?
  store.all("SELECT id,budget_id,reserved_cny FROM text_calls WHERE state='unknown'").some(call=>!reviews.some(r=>r.callId===call.id&&r.budgetId===call.budget_id&&r.budgetId===config.budgetId&&r.reservedCny===call.reserved_cny&&r.disposition==='retain-full-reservation'&&typeof r.authorization==='string'&&r.authorization.trim().length>0&&Number.isFinite(Date.parse(r.reviewedAt)))):
  store.get("SELECT count(*) AS n FROM text_calls WHERE state='unknown'").n>0);

 return {reservedCny:tests.reduce((sum,r)=>sum+r.reserved_cny,0)+rows.reduce((sum,r)=>sum+r.reserved_cny,0)+text.reduce((sum,r)=>sum+(r.state==='received'&&r.cost_cny!==null?r.cost_cny:r.reserved_cny),0),
  unknown:!!(hasTests&&store.get("SELECT count(*) AS n FROM connection_tests WHERE state='unknown'").n)||store.get("SELECT count(*) AS n FROM provider_calls WHERE state IN ('unknown','late')").n>0||!!textUnknown,calls:rows.length+text.length+tests.length};
}
async function boundedJSON(response){
 const reader=response.body?.getReader();if(!reader)throw new Error('EMPTY_RESPONSE');
 const chunks=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>70*1024*1024){await reader.cancel();throw new Error('RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(value));}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const safeRequestId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value)?value:null;
export function createProviderHandlers({store,config,key,transport=fetch}){
 const handlers={id:'seedream-flash-manual-facts',version:'integration1.2',replaySafe:false,
  understand:factualUnderstanding,plan:rulesPlan,
  async generate(request){
   const credential=currentKey(key),ready=readiness(config,credential);
   if(config.modelCallsPaused!==false)throw new WorkflowError('REJECTED');
   if(!ready.ready)throw new WorkflowError('AUTH');
   const context=request.executionContext;
   const assets=request.prompt.data.references.map(r=>store.asset(r.assetId));
   const correction=context.correction;
   const authorizedCurrent=correction&&store.result(correction.resultId).versions.some(v=>v.version===correction.expectedVersion&&v.assetId===correction.sourceAssetId);
   if(!assets.every(a=>config.authorizedReferenceHashes.includes(a.sha256)||(authorizedCurrent&&a.id===correction.sourceAssetId&&request.prompt.data.references.find(r=>r.assetId===a.id)?.role==='current')))throw new WorkflowError('AUTH');
   const image=await Promise.all(assets.map(async a=>`data:${a.mediaType};base64,${Buffer.from(await request.readAsset(a.id)).toString('base64')}`));
   const textRule=correction?.kind==='text'?'仅按指定区域替换给定文字，其他文字保持不变。':correction?.kind==='modify'&&correction.promptVersion==='integration-correction.3'?'用户明确要求替换或删除的文字按editInstruction执行；其余文字保持，不自行添加文案。':correction?'保留原有文字，不额外添加新文字。':request.prompt.data.copyMode==='provider-rendered'?'仅绘制copy中指定文字，不添加额外文案；文字为图片像素，仍需人工核对字形。':'本轮未接入图内文案，不额外绘制文字。';
   const prompt=`${request.prompt.system}\n${textRule}\n${JSON.stringify(request.prompt.data)}`;
   const payload={model:MODEL,prompt,image,size:`${request.image.size.width}x${request.image.size.height}`,output_format:'png',response_format:'b64_json',watermark:request.prompt.data.marketPolicy?.visibleWatermark??true};
   const callId=randomUUID();
   store.transaction(()=>{
    const status=ledgerState(store,config);
    if(status.unknown)throw new WorkflowError('REJECTED');
    if(status.reservedCny+config.reservePerImageCny>config.budgetCny+1e-8)throw new WorkflowError('REJECTED');
    store.run('INSERT INTO provider_calls(id,task_id,attempt_id,budget_id,reserved_cny,state,request_json,started_at) VALUES(?,?,?,?,?,?,?,?)',callId,context.taskId,context.attemptId,config.budgetId,config.reservePerImageCny,'sent',json({...payload,image:assets.map(a=>({assetId:a.id,sha256:a.sha256})),promptSha256:sha(prompt),priceEvidence:config.priceEvidence}),Date.now());
   });
   let accepted=false;
   try{
    const response=await transport(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential}`},body:JSON.stringify(payload),signal:request.signal,redirect:'error'});
    const requestId=safeRequestId(response.headers.get('x-request-id'));
    if(!response.ok){
     const certain=[400,401,403,422,429].includes(response.status);
     const code=response.status===401||response.status===403?'AUTH':response.status===429?'RATE_LIMIT':certain?'REJECTED':'OUTCOME_UNKNOWN';
     store.run('UPDATE provider_calls SET state=?,request_id=?,ended_at=?,error_code=? WHERE id=?',certain?'rejected':'unknown',requestId,Date.now(),code,callId);
     await response.body?.cancel();
     throw new WorkflowError(code,[],{retryable:false,outcomeUnknown:!certain});
    }
    accepted=true;
    const body=await boundedJSON(response);
    if(body.model!==MODEL||!Array.isArray(body.data)||body.data.length!==1||typeof body.data[0]?.b64_json!=='string')throw new Error('OUTPUT_INVALID');
    const bytes=Buffer.from(body.data[0].b64_json,'base64');
    // Persist original provider PNG even if cancellation arrived after response; never publish it as a canceled result.
    const asset=store.putAsset(bytes,{kind:'derived',parentId:assets[0].id,mediaType:'image/png',name:`provider-${callId}.png`});
    store.run('UPDATE provider_calls SET asset_id=? WHERE id=?',asset.id,callId);
    if(asset.width!==request.image.size.width||asset.height!==request.image.size.height)throw new Error('OUTPUT_SIZE');
    const usage=Object.fromEntries(['generated_images','input_images','output_tokens','total_tokens'].filter(k=>Number.isSafeInteger(body.usage?.[k])&&body.usage[k]>=0).map(k=>[k,body.usage[k]]));
    store.run('UPDATE provider_calls SET state=?,request_id=?,usage_json=?,asset_id=?,ended_at=? WHERE id=?',request.signal?.aborted?'late':'received',requestId,json(usage),asset.id,Date.now(),callId);
    return {base64:bytes.toString('base64'),mediaType:'image/png',width:asset.width,height:asset.height,provenance:'provider',requestId};
   }catch(error){
    if(error instanceof WorkflowError)throw error;
    if(!store.closed)store.run("UPDATE provider_calls SET state='unknown',ended_at=?,error_code=? WHERE id=?",Date.now(),accepted?'OUTPUT_UNVERIFIED':'OUTCOME_UNKNOWN',callId);
    throw new WorkflowError('OUTCOME_UNKNOWN',[],{outcomeUnknown:true});
   }
  },
  async compose({raster,layers}){if(layers.length)throw new WorkflowError('COMPOSE_FAILED');return {raster,layers};},
  async inspect(){return {passed:true,evidence:'structural-check',issues:[{code:'HUMAN_REVIEW_REQUIRED',severity:'warning',message:'仅文件和尺寸结构检查；商品一致性与视觉质量待人工验收'}]};}
 };
 return handlers;
}
