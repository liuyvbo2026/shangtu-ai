import {WorkflowError} from '../../src/workflow/value.js';
// Explicit retry of a failed local compose may reuse its immutable provider base.
// It never fabricates a provider receipt or retries an unknown external outcome.
export function initComposeRecovery(store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS compose_recoveries(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),source_call_id TEXT NOT NULL REFERENCES provider_calls(id),created_at INTEGER NOT NULL);`);
 store.db.exec(`CREATE TABLE IF NOT EXISTS compose_reframes(child_id TEXT NOT NULL REFERENCES children(id),generation INTEGER NOT NULL,source_call_id TEXT NOT NULL REFERENCES provider_calls(id),version TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(child_id,generation));`);
}
export function reframeRequest(store,request){
 const c=request.executionContext;if(!c)return null;const row=store.get('SELECT r.* FROM compose_reframes r JOIN attempts a ON a.child_id=r.child_id AND a.generation=r.generation WHERE a.id=?',c.attemptId);if(!row)return null;
 const prompt=structuredClone(request.prompt);
 if(row.version==='composition-reframe.4'){
  const scene=prompt.data.marketStage==='lifestyle',brief=prompt.data.sceneBrief;
  const feet=scene&&/鞋|双脚|全身|足部/.test(JSON.stringify(brief??{}));
  prompt.version+=':reframe.4';
  prompt.system=(scene?`重新拍摄原生活场景，保留sceneBrief的地点、活动、persona、experience和商品使用关系。相机适当后移，人物向右安排，原textReserve区域拍摄该环境真实存在的低纹理负空间，足够按原字号排标题。${feet?'本图必须从头顶到双脚和完整鞋子全部入画；人物头顶与双脚都留安全边距，保留真实步态、鞋与地面接触及鞋型辨识，绝不能只拍到膝盖或胯部。':'保持原任务要求的身体、商品及活动区域可见，不以人像特写代替生活片段。'}户外使用原场景中的天空或远景自然留白；室内才使用原房间墙面，不为了排字换地点或活动。`:'重拍原方案指定的单一商品细节，保持参考结构与原有展示部位，调整机位和主体位置，在textReserve区域留出足够原字号标题的真实摄影背景。不要把局部放大到占满画布。')+'\n全幅连续摄影到四边，不加独立文字底板、顶部条带、相框或内嵌小照片；不在底图写营销文字。\n'+prompt.system;
  prompt.data.compositionRepair={version:row.version,sourceCallId:row.source_call_id,reason:'previous-local-composition-failed',explicitRegeneration:true};return {...request,prompt};
 }
 if(row.version==='composition-reframe.3'){
  const scene=prompt.data.marketStage==='lifestyle';prompt.version+=':reframe.3';
  prompt.system=(scene?'本次明确重拍为环境中景，相机后移，人物从头顶到膝盖都在画面内，安排在画面右侧约一半范围；左侧约四成拍摄连续真实的浅色墙面，低纹理且无家具遮挡，供英文标题按原字号分两行排版。保留已定persona与experience的模特造型、投入听歌表情和自然节奏动作，沙发、手部及活动区域清楚。':'本次重拍单一真实细节照片，细节放在右侧与中下部，保持参考结构。左上至少约55%宽、20%高为同一摄影空间的连续浅色低纹理背景，能放下原字号英文标题。不能把整个商品局部放大到占满画布。')+'\n整幅是一张真实连续摄影；留白是墙面或摄影背景的一部分，不生成顶部条带、独立文字底板、相框、小照片或边界分区。不要在底图写任何标题、参数、字母或营销文字，商品原有标记保持。\n'+prompt.system;
  prompt.data.compositionRepair={version:row.version,sourceCallId:row.source_call_id,reason:'previous-local-composition-failed',explicitRegeneration:true};return {...request,prompt};
 }
 if(row.version==='composition-reframe.2'){
  prompt.version+=':reframe.2';
  prompt.system='重新取景以安排实际文字区域的自然负空间。保留本图sceneBrief的环境线索、自然活动及商品使用关系，只调整相机位置、人物/商品位置与局部背景。不要变成纯佩戴肖像或抹掉场景，不要求整幅顶部35%留白。商品保持可辨，文字避让人物和商品，不缩照片、不套框、不画白条。\n'+prompt.system;
  prompt.data.compositionRepair={version:row.version,sourceCallId:row.source_call_id,reason:'previous-local-composition-failed',explicitRegeneration:true};
  return {...request,prompt};
 }
 prompt.version+=':reframe.1';
 prompt.system='重新取景，修复上一张没有足够自然留白的问题。画布顶部35%整幅宽度只能出现同一摄影空间的干净浅色背景；商品、人物头发和部件全部从35%高度以下开始。把相机后移，画面上方保留大量背景，不能继续拍占满画布的面部或商品大特写。保留正常使用动作与原商品身份。局部细节仍只拍原方案指定部位，不让其他部件进入标题区。不加白条、不套相框、不缩图后贴底板。\n'+prompt.system.replaceAll('25%','35%');
 prompt.data.subject={...prompt.data.subject,box:[.12,.38,.8,.58]};prompt.data.compositionRepair={version:row.version,sourceCallId:row.source_call_id,reason:'previous-local-composition-failed',explicitRegeneration:true};
 return {...request,prompt};
}
export function reusableComposeBase(store,request){
 if(request.prompt?.data.copyMode!=='source-aware-overlay')return null;
 const c=request.executionContext;if(!c?.attemptId||!c.childId||!c.taskId)return null;
 const task=store.task(c.taskId),prepared=task.input.settings.workflow03A;
 const prior=store.get(`SELECT a.id,a.receipt_json,p.id AS call_id,p.asset_id,p.request_id FROM attempts a JOIN provider_calls p ON p.attempt_id=a.id
 WHERE a.child_id=? AND a.id!=? AND a.state='failed' AND p.task_id=? AND p.state='received' AND p.asset_id IS NOT NULL AND p.error_code IS NULL ORDER BY a.ordinal DESC LIMIT 1`,c.childId,c.attemptId,c.taskId);
 if(!prior)return null;
 const workflow=JSON.parse(prior.receipt_json??'null')?.workflow;
 if(workflow?.planDigest!==prepared.digest||!workflow.trace?.some(n=>n.id==='generate'&&n.status==='succeeded')||!workflow.trace.some(n=>n.id==='compose'&&n.status==='failed'&&n.error?.code==='COMPOSE_FAILED'))return null;
 const child=task.children.find(x=>x.id===c.childId);
 if(!child||child.slot.key!==request.image.id||!prepared.plan.images.some(i=>i.id===request.image.id&&i.textMode==='source-aware-overlay'))return null;
 const asset=store.asset(prior.asset_id);
 if(asset.width!==request.image.size.width||asset.height!==request.image.size.height)return null;
 const bytes=store.readAsset(asset.id);
 store.run('INSERT OR IGNORE INTO compose_recoveries VALUES(?,?,?)',c.attemptId,prior.call_id,Date.now());
 return {base64:bytes.toString('base64'),mediaType:asset.mediaType,width:asset.width,height:asset.height,provenance:'provider',requestId:prior.request_id};
}

export function withComposeRecovery(store,generate){
 return request=>{
  const repair=reframeRequest(store,request);if(repair)return generate(repair);
  const base=reusableComposeBase(store,request);if(base)return base;
  const c=request.executionContext;
  if(c&&store.get('SELECT 1 FROM local_replays r JOIN attempts a ON a.child_id=r.child_id AND a.generation=r.generation WHERE a.id=?',c.attemptId))throw new WorkflowError('COMPOSE_FAILED');
  return generate(request);
 };
}
