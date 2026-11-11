// Read-only preflight by default. --run makes text-only paid requests with durable idempotency keys.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ledgerState} from '../backend/integration/provider.mjs';
import {productFromRemote} from '../src/product-input.js';
const root=fileURLToPath(new URL('../',import.meta.url)),base='http://127.0.0.1:5178/api/backend-v1';
const run=process.argv.includes('--run');
if(process.argv.slice(2).some(x=>!['--run','--preflight'].includes(x)))throw Error('仅支持 --preflight 或 --run；不接受密钥参数。');
const evidence=path.join(root,'artifacts/mimo-integration-2026-10-28');fs.mkdirSync(evidence,{recursive:true});
const api=async(url,options={})=>{
 const response=await fetch(base+url,{...options,headers:{'Content-Type':'application/json','X-Backend-Client':'local-development',...options.headers},signal:AbortSignal.timeout(15000)});
 const value=await response.json();if(!response.ok)throw Error(value.error?.code||'LOCAL_API_FAILED');return value;
};
const expectedHashes=[
 '2f545d584d50d072f31f440729502523decd5f49a2e22e1ad6d7c7e4793a9f15',
 'e27a415e54e1be27d9e9594a039e6bf37518e0a97d910238f1b06627ebd0a795',
 'd334de0477eef49a8a9647a8048bbe68590aea138bf0a5d1e8ce8ead7c65ca50'];
try{
 const [health,{products},{tasks}]=await Promise.all([api('/health'),api('/products'),api('/tasks')]);
 const product=products.find(p=>p.id==='95ec7c48-5d40-447d-877e-2b95220afa66');
 if(!product||product.references.length!==3)throw Error('CUP_REFERENCES_CHANGED');
 const assets=await Promise.all(product.references.map(r=>api(`/assets/${r.assetId}`)));
 if(JSON.stringify(assets.map(a=>a.sha256))!==JSON.stringify(expectedHashes))throw Error('CUP_REFERENCE_HASH_MISMATCH');
 const original=tasks.find(t=>t.productId===product.id&&!t.input.settings.correction&&t.children.length===7);
 const settings=original?.input.settings.effectiveSettings??original?.input.settings.workflow03A?.effectiveSettings;
 if(!settings||Object.values(settings.counts).reduce((a,b)=>a+b,0)!==7)throw Error('SEVEN_IMAGE_SETTINGS_NOT_FOUND');
 const input={productId:product.id,productRevision:product.revision,description:productFromRemote(product).inputText,settings};
 const policy=JSON.parse(fs.readFileSync(path.join(root,'.private/integration-round1.json'),'utf8'));
 const db=new DatabaseSync(path.join(root,'.private/single-product/store.sqlite'),{readOnly:true});
 const ledger=ledgerState({all:(sql,...args)=>db.prepare(sql).all(...args),get:(sql,...args)=>db.prepare(sql).get(...args)},policy);db.close();
 if(!assets.every(a=>policy.mimo?.authorizedReferenceHashes.includes(a.sha256)))throw Error('MIMO_REFERENCE_AUTHORIZATION_MISSING');
 const record={time:new Date().toISOString(),mode:run?'real-text-only':'read-only-preflight',model:'mimo-v2.6-flash',health:health.text??null,
  budget:{id:policy.budgetId,capCny:policy.budgetCny,recordedAndReservedCny:ledger.reservedCny,remainingBeforeReserveCny:policy.budgetCny-ledger.reservedCny,billingUnknown:ledger.unknown,finalBillVerified:false},
  references:assets.map(a=>({id:a.id,name:a.name,sha256:a.sha256,width:a.width,height:a.height})),input,imageTaskIdsBefore:tasks.map(t=>t.id),results:[],qualityAcceptance:'pending-human-review'};
 fs.writeFileSync(path.join(evidence,'real-preflight.json'),JSON.stringify(record,null,2));
 if(health.modelCallsPaused||health.text?.paused){console.log(JSON.stringify({status:'BLOCKED_MODEL_CALLS_PAUSED',paidRequests:0}));process.exitCode=2;}
 else if(!health.text?.ready){console.log(JSON.stringify({status:'BLOCKED_MISSING_CONFIGURATION',missing:health.text?.missing??['请重启新版后台'],paidRequests:0}));process.exitCode=2;}
 else if(health.text.billingUnknown)throw Error('BILLING_UNKNOWN');
 else if(!run)console.log(JSON.stringify({status:'READY_FOR_TEXT_ONLY_RUN',paidRequests:0,referenceCount:3,counts:settings.counts}));
 else{
  const sessionFile=path.join(root,'.private','mimo-validation-session.json'),inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  let session=fs.existsSync(sessionFile)?JSON.parse(fs.readFileSync(sessionFile)):null;
  if(session&&session.inputHash!==inputHash)throw Error('SAVED_VALIDATION_INPUT_CHANGED');
  if(!session){session={inputHash,keys:Object.fromEntries(['understand','assist','plan'].map(k=>[k,randomUUID()]))};fs.writeFileSync(sessionFile,JSON.stringify(session),{mode:0o600,flag:'wx'});}
  let understandingRunId;
  for(const kind of ['understand','assist','plan']){
   const response=await api('/text-runs',{method:'POST',headers:{'Idempotency-Key':session.keys[kind]},body:JSON.stringify({...input,kind,...(understandingRunId?{understandingRunId}:{})})});
   let result=response.run,deadline=Date.now()+240000;
   while(result.state==='running'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));result=await api(`/text-runs/${result.id}`);}
   record.results.push(result);fs.writeFileSync(path.join(evidence,'real-results.json'),JSON.stringify(record,null,2));
   if(result.state!=='succeeded')throw Error(result.errorCode||'LOCAL_WAIT_TIMEOUT_REUSE_SAME_COMMAND');
   if(kind==='understand')understandingRunId=result.id;
   console.log(JSON.stringify({kind,state:result.state,id:result.id,calls:result.calls.map(c=>({requestId:c.requestId,usage:c.usage,estimatedCostCny:c.estimatedCostCny}))}));
  }
  const after=await api('/tasks');record.imageTaskIdsAfter=after.tasks.map(t=>t.id);
  if(JSON.stringify(record.imageTaskIdsAfter.sort())!==JSON.stringify([...record.imageTaskIdsBefore].sort()))throw Error('IMAGE_TASK_SET_CHANGED_REQUIRES_REVIEW');
  fs.writeFileSync(path.join(evidence,'real-results.json'),JSON.stringify(record,null,2));
  console.log('真实响应已保存；须逐图核对事实、内容分工和构图后才可判定效果验收。未创建图片任务。');
 }
}catch(error){console.error(error.message);process.exitCode=1;}
