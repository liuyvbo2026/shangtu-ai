import {migrateWorkspaceInputs,inputError,INPUT_VERSION} from './product-input.js';
export const uid=()=>globalThis.crypto.randomUUID();
export const copy=x=>structuredClone(x);
export const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));
export const TYPES={white:'白底图',selling:'卖点图',scene:'场景图',other:'其他'};
export const PLATFORMS=['亚马逊','淘宝天猫1688','Temu','TikTok Shop','拼多多','抖音电商','OZON','独立站','Shopee','阿里国际站','速卖通','SHEIN','京东','美客多','Coupang','Wayfair'];
export const COUNTRIES=['美国','欧洲','中国','俄罗斯','东南亚','西班牙','德国','日本','韩国','巴西','墨西哥'];
export const LANGUAGES=['英文','中文','俄语','西语','德语','日语','韩语','葡萄牙语','印尼语','泰语','无文字'];
export const countryLanguage=country=>({'中国':'中文','俄罗斯':'俄语','西班牙':'西语','德国':'德语','日本':'日语','韩国':'韩语','巴西':'葡萄牙语','墨西哥':'西语'}[country]||'英文');
export const domesticPlatform=platform=>['淘宝天猫1688','拼多多','抖音电商','京东'].includes(platform);
export const GROUPS=['推荐场景','颜色空间','简约通用','家具家装','家居装饰','手持','玩偶手办','台面展台','饰品服饰','厨房浴室','场景配方','鞋子','食品饮品','户外实景','植物','砂砾岩石','数码家电','布艺绸缎','冰雪水系','人像'];
export function defaultSettings(){return {platform:'亚马逊',country:'美国',language:'英文',ratio:'1:1',resolution:'2K',counts:{white:1,selling:3,scene:2,other:1},layouts:[],analysis:false,listing:false};}
export function platformDefaults(platform){
 if(['淘宝天猫1688','拼多多','抖音电商','京东'].includes(platform))return {country:'中国',language:'中文',counts:{white:0,selling:3,scene:2,other:2}};
 if(platform==='OZON')return {country:'俄罗斯',language:'俄文',counts:{white:1,selling:3,scene:2,other:1}};
 if(platform==='Coupang')return {country:'韩国',language:'韩文',counts:{white:1,selling:3,scene:2,other:1}};
 return {country:'美国',language:'英文',counts:{white:1,selling:3,scene:2,other:1}};
}
export function changePlatform(settings,platform){const defaults=platformDefaults(platform);Object.assign(settings,{platform,counts:defaults.counts},domesticPlatform(platform)?{country:'中国',language:'中文'}:{});return settings;}
export const total=s=>Object.values(s.counts).reduce((a,b)=>a+Number(b),0);
export function setCount(s,key,value){const rest=total(s)-s.counts[key];s.counts[key]=clamp(Math.round(Number(value)),0,Math.max(0,20-rest));return s;}
export function resolveSettings(globals,override={}){const resolved=copy(globals);for(const [key,v] of Object.entries(override))if(v!==''&&v!=null)resolved[key]=copy(v);return resolved;}
export function validateKit(product,settings,description){
 if(!product?.refs?.length)return '请上传商品原图。';
 if(product.refs.length>6)return '同一商品最多上传 6 张图片。';
 if(inputError(description))return inputError(description);
 if(total(settings)<1||total(settings)>20)return '一套需包含 1–20 张图片。';
 if(settings.layouts.length>settings.counts.selling)return '已选版式不能超过卖点图数量。';
 return '';
}
export function resultSlots(s){return Object.entries(s.counts).flatMap(([type,n])=>Array.from({length:n},(_,i)=>({id:uid(),type,index:i+1,layoutId:type==='selling'?(s.layouts[i]||null):null,status:'pending'})));}
export function freshState(){return {version:1,view:'kit',preview:null,previewDrafts:{},products:[],kit:{productId:null,description:'',inputVersion:INPUT_VERSION,settings:defaultSettings(),expanded:false},batch:{global:defaultSettings(),items:[],mode:'immediate'},jobs:[],library:[],demo:{outcome:'success',duration:3200},historyFilter:'all',savedAt:null};}
export const isKitJob=job=>['kit','kit-result'].includes(job.kind);
export function outputSize(settings){const [w,h]=settings.ratio.split(':').map(Number),edge=settings.resolution==='2K'?2048:1024;return {width:w>=h?edge:Math.round(edge*w/h),height:h>=w?edge:Math.round(edge*h/w)};}
export function recover(state){
 migrateWorkspaceInputs(state);
 if(!['kit','history'].includes(state.view))state.view='kit';
 if(!['all','running','queued','success','failed'].includes(state.historyFilter))state.historyFilter='all';
 const kitSources=new Map();
 for(const job of [...state.jobs].sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))){
  const parent=kitSources.get(job.refs?.[0]);
  if(job.kind==='editor'&&['modify','restore-product'].includes(job.capability)&&parent){job.kind='kit-result';job.parentJobId=parent.id;job.productRefs=[...(parent.productRefs||parent.refs||[])];}
  if(isKitJob(job))for(const result of job.results||[])if(result.assetId)kitSources.set(result.assetId,job);
  if(!job.backend&&['running','queued'].includes(job.status)){job.status='interrupted';job.error='页面关闭或刷新，任务已中断。可重试。';for(const r of job.results||[])if(r.status==='running')r.status='interrupted';}
 }
 state.previewDrafts ||= {};
 if(!previewContext(state))state.preview=null;
 return state;
}

export function previewContext(state){
 const p=state.preview;if(!p)return null;
 const job=state.jobs.find(j=>j.id===p.jobId&&isKitJob(j));
 if(!job)return null;
 const results=job.results.filter(r=>r.assetId),index=results.findIndex(r=>r.id===p.resultId);
 if(index<0)return null;
 const latest=results[index],version=latest.versions?.find(v=>v.version===p.version);
 return {job,result:version?{...latest,...version,historical:version.version!==latest.version}:latest,results,index};
}
