import { VERSIONS, prepareWorkflow, digest, effectiveLayout, preparedDigest } from '../../src/workflow/index.js';
import { createStage2Submission } from '../../src/workflow/stage2-adapter.js';
import { fail } from '../core.mjs';
import {preset,legacyConnection,connectionIdentity} from './model-catalog.mjs';
import {INPUT_VERSION,inputError} from '../../src/product-input.js';

export const MODEL='doubao-seedream-5-0-flash-260915';
// Explicit pixels; UI 1K means approximately 1 megapixel, not a 1024px longest edge.
export const SIZES={
 '1K':{'1:1':[1024,1024],'3:4':[864,1152],'9:16':[720,1280],'16:9':[1280,720]},
 '2K':{'1:1':[2048,2048],'3:4':[1728,2304],'9:16':[1440,2560],'16:9':[2560,1440]}
};
export function sizeFor(settings){const v=SIZES[settings.resolution]?.[settings.ratio];fail(v,'INVALID_SETTINGS','请选择支持的比例与分辨率');return {width:v[0],height:v[1]};}
export const POLICY={totalMin:{value:1,basis:'User requested an exact four-image kit on 2026-11-02; any positive count up to existing maximum is allowed',status:'verified'},version:'integration1.flexible-counts-2026-11-02',modelId:MODEL,
 allowedSizes:{value:Object.values(SIZES).flatMap(v=>Object.values(v).map(s=>s.join('x'))),basis:'Official explicit pixel range and aspect constraints, checked 2026-10-28',status:'verified'},
 maxPixels:{value:4624220,basis:'Official image generation pixel upper limit',status:'verified'}};

export function factualUnderstanding({input}){
 return {schemaVersion:VERSIONS.schema,productId:input.product.id,productRevision:input.product.revision,
 facts:structuredClone(input.product.facts),unknowns:structuredClone(input.product.unknowns),references:structuredClone(input.product.references),inferred:[],conflicts:[]};
}
export const IDENTITY_RULES='商品结构约束：逐一对应原始参考图中可见的开口、孔、按钮、盖片、接缝及附件，数量、位置、连接关系必须一致；不要把盖片、反光或阴影画成额外开口，不镜像复制结构。保持整体轮廓、长宽比例、原色和表面外观。不为不同视角猜造未展示结构；无法确定的区域采用参考图已展示的角度。';
const shots={
 white:[['正面整体','正视完整轮廓，主体居中'],['侧向整体','参考可见侧向，完整展示轮廓'],['斜向整体','参考可见三分之四角度，保持全部边缘']],
 selling:[['整体外观与配色','完整商品正面，主体占画面约70%，展示整体配色；不做局部特写'],['上部结构细节','近距离放大参考可见的上部结构，商品上半部占画面约80%，下部允许出画；不重复完整正面'],['下部轮廓细节','近距离展示参考可见的下半部和底缘连接，突出轮廓转折；不重复上部特写']],
 scene:[['桌面陈列全景','完整商品置于简洁桌面的一侧，环境约占画面55%；不引入未确认用途或尺寸道具'],['窗边侧向陈列','完整商品置于窗边，采用参考可见的侧向或三分之四视角，主体约占画面65%；背景为柔和侧窗光，不重复桌面全景']],
 other:[['俯视结构关系','略俯视展示顶部与主体的连接关系，完整保留顶部边缘，区别于正面与局部放大'],['侧向轮廓补充','参考中已有的侧向完整轮廓，平视窄侧面，在中性背景呈现侧面线条；不做三分之四正面']]
};
export function rulesPlan({input,understanding}){
 const images=[];
 for(const [type,n] of Object.entries(input.requirements.counts))for(let i=0;i<n;i++){
  const [purpose,shot]=shots[type][i%shots[type].length];
  const variation=i<shots[type].length?'':`本类型扩展视图${i+1}：主体安排在${i%2?'左':'右'}侧，保留${25+(i%4)*10}%环境留白；避免与前面相同取景。`;
  const image={id:`${type}-${i+1}`,type,purpose:`${purpose} · ${i+1}`,
   content:`本张唯一任务：${purpose}。拍摄方案：${shot}。${variation}每张只出现同一件商品，不做拼贴、重复摆放或虚构拆解。${IDENTITY_RULES}只展示可见外观和用户提供的资料，不推断材质/容量/性能。适用人群和期望场景属于创作方向，不能把愿望或推断当成已确认规格。用户原文：${input.requirements.description}`,
   factIds:input.product.facts.map(f=>f.id),copy:[],layoutId:null,composition:{subjectBox:[]},
   references:input.product.references.map(r=>({referenceId:r.id,role:r.role})),dependencies:[],ratio:input.requirements.ratio,size:input.requirements.size,method:'generate',textMode:'editable-overlay'};
  image.composition.subjectBox=effectiveLayout(input,image).subjectBox;images.push(image);
 }
 return {schemaVersion:VERSIONS.schema,productId:input.product.id,productRevision:input.product.revision,understandingDigest:digest(understanding),
 visual:{palette:['参考商品原色','中性白灰'],font:'system-ui',lighting:'柔和自然光',background:'简洁，保持商品清晰'},images};
}
export function validateSettings(s,{allowLayouts=false,allowAddons=false}={}){
 fail(s && Object.keys(s).every(k=>['platform','country','language','ratio','resolution','counts','layouts','analysis','listing'].includes(k)),'INVALID_SETTINGS','生成设置包含未知字段');
 fail(['platform','country','language'].every(k=>typeof s[k]==='string'&&s[k].length>0&&s[k].length<=100),'INVALID_SETTINGS','平台、地区及语言必填');
 fail(s.counts && Object.keys(s.counts).sort().join(',')==='other,scene,selling,white' && Object.values(s.counts).every(n=>Number.isInteger(n)&&n>=0&&n<=20),'INVALID_SETTINGS','图片数量无效');
 const total=Object.values(s.counts).reduce((a,b)=>a+b,0);fail(total>=1&&total<=20,'INVALID_SETTINGS','一套需要1–20张图片');
 fail(Array.isArray(s.layouts),'INVALID_SETTINGS','版式选择无效');
 fail(s.layouts.every(id=>typeof id==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(id))&&new Set(s.layouts).size===s.layouts.length&&s.layouts.length<=s.counts.selling,'INVALID_SETTINGS','版式数量不能超过卖点图数量，且不能重复');
 fail(allowLayouts||!s.layouts.length,'LAYOUT_NOT_CONNECTED','请先完成包含所选版式的套图规划');
 fail(typeof s.analysis==='boolean'&&typeof s.listing==='boolean','INVALID_SETTINGS','附加功能设置无效');
 fail(allowAddons||s.analysis===false&&s.listing===false,'TEXT_CAPABILITY_NOT_CONNECTED','附加功能需要通过完整套图流程执行');
 sizeFor(s);return s;
}
export async function planSubmission(store,handlers,input,key,pinned=null,connection=null,frozenProduct=null){
 const settings=structuredClone(validateSettings(input.settings,{allowLayouts:!!pinned,allowAddons:!!pinned}));
 const p=frozenProduct??store.product(input.productId);fail(p.revision===input.productRevision,'REVISION_CONFLICT','商品已改变，请重新保存',409);
 if(p.facts.userInput?.version===INPUT_VERSION){
  fail(!inputError(input.description),'INVALID_INPUT',inputError(input.description));
  fail(p.facts.userInput.text===input.description,'REVISION_CONFLICT','商品要求已改变，请重新保存后提交',409);
  fail(!p.facts.confirmed?.length&&!p.facts.unknowns?.length,'INVALID_INPUT','统一输入不能附带隐藏的旧事实');
 }else fail(typeof input.description==='string'&&input.description.trim().length>0&&input.description.length<=3000,'INVALID_INPUT','请填写不超过3000字的商品要求');
 fail(p.references.length>=1&&p.references.length<=6,'INVALID_INPUT','同一商品需要1–6张参考图');
 for(const r of p.references){const a=store.asset(r.assetId);fail(a.width>14&&a.height>14&&a.width*a.height<=36000000&&a.width/a.height>=1/16&&a.width/a.height<=16,'REFERENCE_SIZE','参考图须大于14像素、至多3600万像素，宽高比在1:16至16:1之间');}
 const workflowInput={schemaVersion:VERSIONS.schema,product:{id:p.id,revision:p.revision,name:p.name,facts:p.facts.confirmed??[],unknowns:p.facts.unknowns??[],references:p.references.map(r=>({id:r.id,assetId:r.assetId,role:r.role,purpose:'同一商品身份参考，保留原始顺序'}))},
 requirements:{description:input.description,platform:settings.platform,language:settings.language,counts:settings.counts,ratio:settings.ratio,size:sizeFor(settings),layoutIds:settings.layouts},layouts:(pinned?.layouts??[]).map(x=>x.definition)};
 const policy=connection&&!legacyConnection('image',connection)?{...POLICY,version:'multi-provider.1',modelId:connection.model,imageModel:preset('image',connection.providerId).label}:POLICY;
 const prepared=structuredClone(await prepareWorkflow(workflowInput,handlers,{policy}));
 if(connection)prepared.modelConnection=connectionIdentity(connection);
 fail(prepared.status==='ready','PLAN_INVALID','商品资料或套图规划校验未通过');
 prepared.effectiveSettings=settings;if(pinned)prepared.minimumMvp=structuredClone(pinned);prepared.digest=preparedDigest(prepared);
 return createStage2Submission(prepared,p,key).body;
}
