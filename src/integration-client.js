import {textErrors} from './text-tools.js';
import {migrateProductInput,savedInputFacts,productFromRemote} from './product-input.js';
const PREFIX='/api/backend-v1';
export const remoteAsset=id=>`server:${id}`;
const statusMap={succeeded:'success'};
const messages={TEXT_CAPABILITY_NOT_CONNECTED:'风格分析和上架文案尚未接入，请关闭这两项后提交图片任务。',LAYOUT_NOT_CONNECTED:'自定义版式尚未接入，请取消版式选择后提交。',RETRY_REQUIRES_REVIEW:'此任务不能直接重试，需要先核对上游请求和本轮预算。',TASK_NOT_RETRYABLE:'这张图已成功、已取消、已达次数上限，或请求结果待核对。',REFERENCE_NOT_AUTHORIZED:'这组参考图尚未取得本轮模型上传授权。',BUDGET_LIMIT:'本轮剩余预算不足以预留整套请求。'};
export async function api(path,{method='GET',body,headers={}}={}){
 let response;
 try{response=await fetch(PREFIX+path,{method,headers:{...(body instanceof Blob?{}:body?{'Content-Type':'application/json'}:{}),'X-Backend-Client':'local-development',...headers},body:body instanceof Blob?body:body?JSON.stringify(body):undefined});}
 catch{throw Error('后台连接中断，已保存内容仍保留。恢复连接后可重新读取。');}
 const result=await response.json();if(!response.ok){const e=Error(messages[result.error?.code]||result.error?.message||'后台请求失败');e.code=result.error?.code;e.status=response.status;throw e;}return result;
}
export async function saveProduct(p,getAsset,onSaved=()=>{}){
 migrateProductInput(p);
 let remote=p.serverId?await api(`/products/${p.serverId}`):await api('/draft-products',{method:'POST',body:{clientId:p.id,name:p.name,facts:savedInputFacts(p)}});
 const facts=savedInputFacts(p,remote.facts);
 p.serverId=remote.id;p.serverRefs||={};await onSaved();
 const wanted=p.refs.map(id=>id.startsWith('server:')?id.slice(7):p.serverRefs[id]).filter(Boolean);
 const retained=remote.references.filter(r=>wanted.includes(r.assetId));
 if(retained.length!==remote.references.length)remote=await api(`/products/${remote.id}/references`,{method:'PUT',body:{expectedRevision:remote.revision,references:retained}});

 for(const id of p.refs){
  let assetId=id.startsWith('server:')?id.slice(7):p.serverRefs[id];
  if(!assetId){const a=await getAsset(id);if(!a)throw Error('找不到原始参考图');const uploaded=await api('/assets',{method:'POST',body:a.blob,headers:{'Content-Type':a.type,'X-Asset-Name':encodeURIComponent(a.name),'X-Asset-Client-Id':id}});assetId=uploaded.id;p.serverRefs[id]=assetId;await onSaved();}
  if(!remote.references.some(r=>r.assetId===assetId))remote=await api(`/products/${remote.id}/references`,{method:'POST',body:{assetId,role:'product'}});
 }
 const desired=p.refs.map(id=>id.startsWith('server:')?id.slice(7):p.serverRefs[id]);
 const refs=desired.map(id=>remote.references.find(r=>r.assetId===id));
 if(JSON.stringify(refs)!==JSON.stringify(remote.references))remote=await api(`/products/${remote.id}/references`,{method:'PUT',body:{expectedRevision:remote.revision,references:refs}});
 if(remote.name!==p.name||JSON.stringify(remote.facts)!==JSON.stringify(facts))remote=await api(`/products/${remote.id}`,{method:'PATCH',body:{expectedRevision:remote.revision,name:p.name,facts}});
 p.serverRevision=remote.revision;p.serverSavedAt=Date.now();await onSaved();return remote;
}
export function projectTask(t,localProductId=t.productId,corrections=[]){
 const settings=t.input.settings.effectiveSettings??t.input.settings.workflow03A?.effectiveSettings;
 const typeIndex={};const results=t.children.map(c=>{const v=c.result?.versions.at(-1);typeIndex[c.slot.type]=(typeIndex[c.slot.type]||0)+1;return {id:c.id,type:c.slot.type,index:typeIndex[c.slot.type],status:statusMap[c.state]||c.state,
 assetId:v?remoteAsset(v.assetId):null,resultId:c.result?.id,version:v?.version,versions:(c.result?.versions??[]).map(v=>({...v,assetId:remoteAsset(v.assetId)})),
 correction:corrections.filter(x=>x.input.settings.correction.resultId===c.result?.id).sort((a,b)=>b.createdAt-a.createdAt)[0],attemptCount:c.attemptCount,error:c.error,compositionFailed:['ecommerce-kit.15','ecommerce-kit.16'].includes(t.input.settings.workflow03A?.minimumMvp?.templateVersion)&&c.attempts?.at(-1)?.receipt?.workflow?.trace.some(n=>n.id==='compose'&&n.status==='failed'&&n.error?.code==='COMPOSE_FAILED'),
 canReframe:c.attemptCount<t.policy.maxAttempts,
 retryable:['partial','failed'].includes(t.state)&&c.state==='failed'&&!c.error?.outcomeUnknown&&(c.attemptCount<t.policy.maxAttempts||(['ecommerce-kit.15','ecommerce-kit.16'].includes(t.input.settings.workflow03A?.minimumMvp?.templateVersion)&&(c.localReplayCount??0)<3&&c.attempts?.at(-1)?.receipt?.workflow?.trace.some(n=>n.id==='compose'&&n.status==='failed'&&n.error?.code==='COMPOSE_FAILED')))};});
 const errors=t.children.filter(c=>c.error).map(c=>`${c.slot.key}: ${c.error.outcomeUnknown?'上游结果待核对，禁止重复调用':results.find(r=>r.id===c.id)?.compositionFailed?'底图已保留，文字无法安全排入；可重试排版或重新构图':c.error.code}`);
 return {id:t.id,kind:'kit',backend:true,revision:t.revision,mode:t.policy.processor.id.includes('test')?'server-test':'server-real',name:t.input.product.name,productId:localProductId,serverProductId:t.productId,
 createdAt:t.createdAt,status:statusMap[t.state]||t.state,progress:Math.floor(t.progress.completed/t.progress.total*100),progressDetail:t.progress,
 refs:t.input.references.map(r=>remoteAsset(r.assetId)),settings,description:t.input.description,parameters:{settings,inputSnapshot:t.input},results,
 error:t.state==='canceled'?'后续调度已停止。已发出的上游请求是否停止及收费仍需核对。':errors.join('；'),trace:t.children.map(c=>({id:c.id,attempts:c.attempts})),savedAt:t.updatedAt};
}
export function mergeRemote(state,tasks,products){
 for(const p of products){const draft=state.products.find(x=>x.id===p.clientId);if(draft)draft.serverId=p.id;if(!state.products.some(x=>x.serverId===p.id||x.id===p.id))state.products.push(productFromRemote(p));}
 const corrections=tasks.filter(t=>t.input.settings.correction),correctionIds=new Set(corrections.map(t=>t.id));
 state.jobs=state.jobs.filter(j=>!correctionIds.has(j.id));
 for(const t of tasks.filter(t=>!t.input.settings.correction)){const p=state.products.find(p=>p.serverId===t.productId||p.id===t.productId),j=projectTask(t,p?.id,corrections),i=state.jobs.findIndex(x=>x.id===t.id);if(i<0)state.jobs.unshift(j);else state.jobs[i]={...state.jobs[i],...j};}
 state.jobs.sort((a,b)=>b.createdAt-a.createdAt);
}
export function mergeKitRuns(state,runs,mode){
 state.kitRuns=runs;state.listingDrafts||={};
 const stageNames={understand:'理解商品',style:'分析视觉方向',plan:'规划套图',images:'准备出图',listing:'生成上架文案','await-images':'生成图片',assist:'AI 帮写',done:'处理完成'};
 for(const run of runs.filter(r=>r.kind==='generate')){
  const id=run.taskId??`flow-${run.id}`,oldId=`flow-${run.id}`;
  if(run.taskId)state.jobs=state.jobs.filter(j=>j.id!==oldId);
  let j=state.jobs.find(j=>j.id===id);
  const product=state.products.find(p=>p.serverId===run.productId||p.id===run.productId);
  if(!j){j={id,kind:'kit',backend:true,mode:'server-real',name:run.name,productId:product?.id??run.productId,serverProductId:run.productId,createdAt:run.createdAt,settings:run.settings,description:run.description,refs:run.references.map(r=>remoteAsset(r.assetId)),results:[],progress:0,progressDetail:{completed:0,succeeded:0,total:Object.values(run.settings.counts).reduce((a,b)=>a+b,0)}};state.jobs.unshift(j);}
  j.flowId=run.id;j.flowStage=stageNames[run.stage];j.batchId=run.batchId;j.flowRetryStages=run.retryStages??[];j.flowUpdatedAt=run.updatedAt;
  if(!run.taskId&&mode==='TEST_ONLY')j.mode='server-test';
  if(!run.taskId||['queued','running'].includes(run.state))j.status=statusMap[run.state]||run.state;
  if(run.state==='partial'&&j.status==='success')j.status='partial';
  const errors=Object.entries(run.errors).map(([stage,code])=>textErrors[code]||`${stageNames[stage]||stage}未完成（${code}）`);
  j.addonErrors=run.taskId?errors:[];
  if(!run.taskId)j.error=errors.join('；');
  if(run.style)j.analysis=[...run.style.notes.map(n=>n.text),'依据商品参考与平台提出视觉方向，尚无市场热度数据。'].join('\n');
  if(run.listing)j.listing={sections:[{title:'宝贝标题',text:run.listing.title.text},{title:'核心卖点',text:run.listing.bullets.map(x=>x.text).join('\n')},{title:'详情页文案',text:run.listing.description.text},{title:'搜索关键词',text:run.listing.searchTerms.map(x=>x.text).join('、')}]};
  if(Object.hasOwn(state.listingDrafts,id))j.listing=state.listingDrafts[id];
 }
 state.jobs.sort((a,b)=>b.createdAt-a.createdAt);
}
