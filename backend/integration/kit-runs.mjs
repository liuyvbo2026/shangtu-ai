import {randomUUID} from 'node:crypto';
import {fail,hash,canonical,json,Fault} from '../core.mjs';
import {resolveSettings} from '../../src/model.js';
import {validateSettings} from './planning.mjs';

const terminal=state=>['succeeded','partial','failed','canceled'].includes(state);
const columns={understand:'understand_id',style:'style_id',plan:'plan_id',listing:'listing_id',assist:'assist_id'};
// Durable orchestration on the existing SQLite store and image executor. There is
// no second worker, image queue, or duplicate billing ledger.
export function createKitRuns({store,textService,submitKit,cancelTask,config,isReady,quality}){
 store.db.exec(`CREATE TABLE IF NOT EXISTS kit_runs(
 id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,position INTEGER NOT NULL,mode TEXT NOT NULL,kind TEXT NOT NULL,
 idempotency_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,
 state TEXT NOT NULL,stage TEXT NOT NULL,understand_id TEXT,style_id TEXT,plan_id TEXT,listing_id TEXT,assist_id TEXT,task_id TEXT,
 errors_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS kit_run_assets(run_id TEXT NOT NULL REFERENCES kit_runs(id),asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(run_id,asset_id));
 CREATE TABLE IF NOT EXISTS kit_run_attempts(run_id TEXT NOT NULL REFERENCES kit_runs(id),stage TEXT NOT NULL,attempt INTEGER NOT NULL,text_run_id TEXT,error_code TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,stage,attempt));`);
 let busy=false,closed=false,timer,fatal=null;
 const row=id=>{const r=store.get('SELECT * FROM kit_runs WHERE id=?',id);fail(r,'NOT_FOUND','找不到套图任务',404);return r;};
 const view=r=>{
  const s=JSON.parse(r.snapshot_json),errors=JSON.parse(r.errors_json),task=r.task_id?store.task(r.task_id):null;
  const text=id=>id?textService.get(id):null;
  return {id:r.id,batchId:r.batch_id,position:r.position,kind:r.kind,mode:r.mode,state:r.state,stage:r.stage,
   productId:s.productId,name:s.name,description:s.description,settings:s.settings,references:s.references,taskId:r.task_id,
   understandingRunId:r.understand_id,styleRunId:r.style_id,planRunId:r.plan_id,listingRunId:r.listing_id,assistRunId:r.assist_id,
   style:text(r.style_id)?.output??null,listing:text(r.listing_id)?.output??null,assistance:text(r.assist_id)?.output??null,
   ...(r.task_id?{quality:quality.view(r.task_id)}:{}),errors,retryStages:terminal(r.state)&&r.state!=='canceled'?Object.keys(errors).filter(stage=>Object.hasOwn(columns,stage)||['images','quality'].includes(stage)):[],createdAt:r.created_at,updatedAt:r.updated_at,taskState:task?.state??null};
 };
 function patch(id,data){const keys=Object.keys(data);store.run(`UPDATE kit_runs SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE id=?`,...keys.map(k=>data[k]),Date.now(),id);}
 const error=(r,stage,code)=>patch(r.id,{errors_json:json({...JSON.parse(row(r.id).errors_json),[stage]:code})});
 function submit(input,key){
  fail(typeof key==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(key),'INVALID_INPUT','需要有效提交编号');
  fail(input&&Object.keys(input).every(k=>['items','global','mode','kind'].includes(k))&&Array.isArray(input.items)&&input.items.length>=1&&input.items.length<=50,'INVALID_INPUT','需要1–50个商品任务');
  const requestHash=hash(canonical(input)),old=store.all('SELECT * FROM kit_runs WHERE batch_id=? ORDER BY position',key);
  if(old.length){fail(old.every(r=>r.request_hash===requestHash),'IDEMPOTENCY_CONFLICT','本次提交内容已变化',409);return {runs:old.map(view),duplicate:true};}
  const mode=input.mode??'immediate',kind=input.kind??'generate';fail(['immediate','queue'].includes(mode)&&['generate','assist'].includes(kind),'INVALID_INPUT','任务模式无效');
  fail(!closed&&!fatal&&isReady(kind),'PROVIDER_NOT_READY','后台暂不可用，请先检查模型连接、预算或在途请求',503);
  const snapshots=input.items.map(item=>{
   fail(item&&Object.keys(item).every(k=>['productId','productRevision','description','settings','override'].includes(k)),'INVALID_INPUT','商品任务包含未知字段');
   const settings=item.settings??resolveSettings(input.global,item.override??{});validateSettings(settings,{allowLayouts:true,allowAddons:true});
   const snapshot=textService.prepare({kind:kind==='assist'?'assist':'plan',productId:item.productId,productRevision:item.productRevision,description:item.description,settings});
   return {...snapshot,qualityReview:config.qualityReviewEnabled===true||['ecommerce-kit.13','ecommerce-kit.14','ecommerce-kit.15','ecommerce-kit.16'].includes(snapshot.templateVersion)};
  });
  store.transaction(()=>snapshots.forEach((snapshot,index)=>{
   const id=randomUUID(),time=Date.now();store.run('INSERT INTO kit_runs(id,batch_id,position,mode,kind,idempotency_key,request_hash,snapshot_json,state,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,key,index,mode,kind,`${key}:${index}`,requestHash,json(snapshot),'queued','understand',time,time);
   for(const r of [...snapshot.references,...(snapshot.layouts??[]).map(l=>l.reference)])store.run('INSERT OR IGNORE INTO kit_run_assets VALUES(?,?)',id,r.assetId);
  }));
  return {runs:store.all('SELECT * FROM kit_runs WHERE batch_id=? ORDER BY position',key).map(view),duplicate:false};
 }
 function textStep(r,s,kind,next){
  const column=columns[kind];let id=r[column];
  if(!id){
   if(textService.status().busy)return;
   const prior=store.get('SELECT * FROM kit_run_attempts WHERE run_id=? AND stage=? ORDER BY attempt DESC LIMIT 1',r.id,kind);
   const rejected=prior?.text_run_id?textService.get(prior.text_run_id):null;
   const canRepair=rejected?.state==='failed'&&store.get('SELECT run_id FROM text_validation_failures WHERE run_id=? AND operation=?',rejected.id,kind);
   const request={kind,productId:s.productId,productRevision:s.productRevision,description:s.description,settings:s.settings,
    ...(canRepair&&['understand','plan','style','listing'].includes(kind)?{repairRunId:rejected.id}:{}),
    ...(kind!=='understand'&&r.understand_id?{understandingRunId:r.understand_id}:{}),...(kind==='plan'&&r.style_id&&textService.get(r.style_id).state==='succeeded'?{styleRunId:r.style_id}:{})};
   const key=`kit-run:${r.id}:${kind}:${prior?.attempt??0}`;let result;
   // An explicit retry may follow a validator fix. Reuse the recorded model
   // response if it now passes every rule before purchasing another plan.
   if(canRepair&&kind==='plan'&&s.templateVersion==='ecommerce-kit.13'){
    try{result=textService.revalidate(rejected.id,key+':revalidated');}
    catch(e){if(!(e instanceof Fault)||e.status!==422)throw e;}
   }
   if(canRepair&&kind==='plan'&&['ecommerce-kit.14','ecommerce-kit.15','ecommerce-kit.16'].includes(s.templateVersion)&&(rejected.errorCode==='TEXT_REGION_TOO_SMALL'||s.templateVersion==='ecommerce-kit.16')){
    try{result=textService.reviewRetained(rejected.id,key+':review-retained');}catch(e){if(!(e instanceof Fault)||e.status!==422)throw e;}
   }
   result??=textService.submit(request,key,s);id=result.run.id;patch(r.id,{[column]:id,state:'running'});return;
  }
  const t=textService.get(id);if(t.state==='running')return;
  if(t.state==='succeeded'){patch(r.id,{stage:next});return;}
  error(r,kind,t.errorCode??'CANCELED');
  if(['style','listing'].includes(kind))patch(r.id,{stage:next});else patch(r.id,{state:'failed'});
 }
 async function tick(){
  if(busy||closed||fatal||config.modelCallsPaused!==false)return;busy=true;
  try{
   // Update all image-completion stages even while another item owns the text slot.
   for(const r of store.all("SELECT * FROM kit_runs WHERE task_id IS NOT NULL AND state!='canceled' AND stage IN ('await-images','done')")){
    const task=store.task(r.task_id),snapshot=JSON.parse(r.snapshot_json);
    if(task.state==='succeeded'&&snapshot.qualityReview&&(r.stage==='await-images'||(r.stage==='done'&&quality.view(task.id).state==='unreviewed'))){quality.enqueue(task.id);patch(r.id,{state:'running',stage:'quality'});continue;}
    if(r.stage==='done'&&task.state==='succeeded'&&snapshot.qualityReview&&quality.view(task.id).state==='no-obvious-issue'){const errors=JSON.parse(r.errors_json);if(errors.quality){delete errors.quality;patch(r.id,{errors_json:json(errors)});}}
    const state=task.state==='succeeded'?(Object.keys(JSON.parse(row(r.id).errors_json)).length?'partial':'succeeded'):task.state,stage=terminal(task.state)?'done':'await-images';
    if(r.state!==state||r.stage!==stage)patch(r.id,{state,stage});
   }
   let r=store.get("SELECT * FROM kit_runs WHERE state IN ('queued','running') AND stage!='await-images' ORDER BY CASE WHEN state='running' THEN 0 WHEN mode='immediate' THEN 1 ELSE 2 END,created_at,position LIMIT 1");
   if(!r)return;
   if(r.state==='queued'&&r.mode==='queue'&&(textService.status().busy||store.get("SELECT id FROM tasks WHERE state IN ('running','queued') LIMIT 1")))return;
   const s=JSON.parse(r.snapshot_json);patch(r.id,{state:'running'});
   try{
    if(r.stage==='understand')textStep(r,s,'understand',r.kind==='assist'?'assist':s.settings.analysis?'style':'plan');
    else if(r.stage==='style')textStep(r,s,'style',r.task_id?'await-images':'plan');
    else if(r.stage==='plan')textStep(r,s,'plan','images');
    else if(r.stage==='assist'){textStep(r,s,'assist','done');if(row(r.id).stage==='done')patch(r.id,{state:'succeeded'});}
    else if(r.stage==='images'){
     const request={productId:s.productId,productRevision:s.productRevision,description:s.description,settings:s.settings,planRunId:r.plan_id};
     const result=await submitKit(request,`kit-run:${r.id}:images`,s.product);
     // Cancellation may arrive during asynchronous preparation. Cancel the durable
     // image task too; never leave an untracked task after the group was canceled.
     if(row(r.id).state==='canceled'){cancelTask(result.task.id);return;}
     patch(r.id,{task_id:result.task.id,stage:s.settings.listing?'listing':'await-images'});
    }else if(r.stage==='listing')textStep(r,s,'listing','await-images');
    else if(r.stage==='quality'){
     const q=quality.view(r.task_id);if(q.state==='running')return;
     if(q.state==='no-obvious-issue'){const errors=JSON.parse(row(r.id).errors_json);if(errors.quality){delete errors.quality;patch(r.id,{errors_json:json(errors)});}}
     if(['failed','unreviewed'].includes(q.state))error(r,'quality','QUALITY_INCOMPLETE');
     if(['ecommerce-kit.13','ecommerce-kit.14','ecommerce-kit.15','ecommerce-kit.16'].includes(s.templateVersion)&&['needs-correction','uncertain'].includes(q.state))error(r,'quality',q.state==='needs-correction'?'QUALITY_NEEDS_CORRECTION':'QUALITY_REVIEW_UNCERTAIN');
     const task=store.task(r.task_id);patch(r.id,{stage:'done',state:task.state==='succeeded'?(Object.keys(JSON.parse(row(r.id).errors_json)).length?'partial':'succeeded'):task.state});
    }
   }catch(e){
    if(row(r.id).state==='canceled')return;
    if(e.code==='TEXT_BUSY')return;
    error(r,r.stage,e instanceof Fault?e.code:'KIT_INTERNAL');
    if(['style','listing'].includes(r.stage))patch(r.id,{stage:r.stage==='style'&&!r.task_id?'plan':'await-images'});else patch(r.id,{state:'failed'});
   }
  }finally{busy=false;}
 }
 // An unexpected storage/orchestration fault must be visible, not silently leave
 // a permanently spinning task or cause unbounded retries of a failed tick.
 timer=setInterval(()=>tick().catch(()=>{fatal='KIT_INTERNAL';}),150);timer.unref?.();
 return {submit,get:id=>view(row(id)),list:()=>store.all('SELECT * FROM kit_runs ORDER BY created_at DESC,position LIMIT 500').map(view),
  get fatal(){return fatal;},
  get active(){return !!store.get("SELECT id FROM kit_runs WHERE state IN ('queued','running') LIMIT 1");},
  retry(id,{stage,expectedUpdatedAt}={}){
   const r=row(id);fail(expectedUpdatedAt===r.updated_at,'REVISION_CONFLICT','任务已改变，请刷新后重试',409);
   fail(view(r).retryStages.includes(stage),'TASK_NOT_RETRYABLE','该阶段不能重试',409);
   fail(!closed&&!fatal&&isReady(r.kind)&&!textService.status().billingUnknown,'RETRY_REQUIRES_REVIEW','请先核对模型连接、预算或未知回执',409);
   const errors=JSON.parse(r.errors_json),column=columns[stage];
   if(stage==='quality')quality.enqueue(r.task_id,{retry:true});
   store.transaction(()=>{
    const count=store.get('SELECT COUNT(*) AS n FROM kit_run_attempts WHERE run_id=? AND stage=?',id,stage).n;
    store.run('INSERT INTO kit_run_attempts VALUES(?,?,?,?,?,?)',id,stage,count+1,column?r[column]:null,errors[stage],Date.now());
    delete errors[stage];patch(id,{state:'queued',stage,errors_json:json(errors),...(column?{[column]:null}:{})});
   });return view(row(id));
  },
  cancel(id){const r=row(id);if(terminal(r.state))return view(r);patch(id,{state:'canceled'});for(const column of Object.values(columns))if(r[column])textService.cancel(r[column]);if(r.task_id){cancelTask(r.task_id);quality.cancel(r.task_id);}return view(row(id));},
  async close(){closed=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,10));}
 };
}
