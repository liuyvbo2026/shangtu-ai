import {adaptiveUnderstandingRules,adaptivePlanningRules,adaptiveListingRules,adaptiveImagePrompt} from './adaptive-design.js';
import {reviewedLayers} from './reviewed-design.js';

export const INTENT_TEMPLATE='ecommerce-kit.14';
export const isIntentTemplate=v=>[INTENT_TEMPLATE,'ecommerce-kit.15','ecommerce-kit.16'].includes(v);
const str=max=>({type:'string',minLength:1,maxLength:max});
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const en=values=>({type:'string',enum:values});
export const intentSchema=obj({
 buyerQuestion:str(160),buyerTakeaway:str(240),
 depiction:en(['appearance','feature','in-use','context','detail']),
 actor:en(['person','none']),action:str(160),productRelation:str(160),
 visibleProof:{type:'array',minItems:1,maxItems:4,items:str(200)},
 copyMeanings:{type:'array',maxItems:4,items:obj({copyIndex:{type:'integer',minimum:0,maximum:3},meaning:str(200),kind:en(['fact','use','mood'])})}
});
export const intentRules=`
v14 商品用途与图文语义：先判断商品类别、普通使用方式和证据边界，再选图。每图intent写清买家问题、看完能知道什么、谁做什么、商品与人的关系、实际画面必须看得见的证据。普通用途常识可用于场景创意，但不能充当材质、性能、认证或兼容性的事实证据。
场景必须区分in-use（真实使用）和context（使用环境中的静物展示）。头戴耳机聆听应有正确佩戴关系；耳机摆在书桌上只能证明摆放，不能证明正在听、舒适或音质。鞋在玄关摆放可以展示外观，玄关本身不是鞋的卖点；杯子在办公桌上可作日常环境展示，不能据此宣传保温、防漏。不要机械要求所有商品场景必须有人：台灯等可在放置状态使用。根据本商品实际用途判断。
文案逐句表达清楚的意思，copyMeanings按copyIndex覆盖每条文案，区分事实、普通用途和氛围。不要把地点词与功能词机械拼成标题，如“书桌聆听”；可用“戴上，听首歌”，前提是画面确实表现佩戴。内部图片类型和拍摄说明不直接做广告标题。不能仅因短句好听或有合法sourceIds就认为语义成立。氛围表达不能暗含未经证实的性能。
每图只承担清楚的一项主要任务，整套覆盖不同购买疑问。白底展示身份外观，卖点解释有依据的特点，场景解释适当用途，其他按商品需要安排细节等；不能只换背景重复同一结论。每图可不写字，字数和字号沿用已定版式约束，不为凑字数制造怪词。
参考角度有限时，保持真实商品结构，优先选择仍能表达原用途的角度与自然动作。无法可靠展示所需动作应指出限制并停止该方案，不得将佩戴使用偷偷改为桌面静物后声称原任务完成。修改和重试必须核对原始buyerTakeaway与visibleProof。用户明确要求改变用途可以执行，但须记录为目标变化，不能作为原用途验收通过。
`;
export const intentUnderstandingRules=adaptiveUnderstandingRules+intentRules;
// v13 remains byte-for-byte available to historical tasks. Its fallback must
// not compete with the new purpose-preservation rule in v14.
export const intentPlanningRules=adaptivePlanningRules.split('\n单角度参考的场景选择：')[0]+intentRules;
export const intentListingRules=adaptiveListingRules+intentRules;

export function intentIssues(plan){
 const issues=[];
 plan.images.forEach((shot,i)=>{
  const intent=shot.intent;
  if(!intent)return issues.push({path:`images[${i}].intent`,code:'SEMANTIC_INTENT',message:'每张图须记录购买问题与用途'});
  const indices=intent.copyMeanings.map(c=>c.copyIndex).sort((a,b)=>a-b);
  if(indices.length!==shot.copy.length||indices.some((n,i)=>n!==i))issues.push({path:`images[${i}].intent.copyMeanings`,code:'SEMANTIC_COPY_COVERAGE',message:'文案含义必须逐条对应copy，不得遗漏、重复或引用不存在的文字'});
  if(shot.type==='white'&&intent.depiction!=='appearance')issues.push({path:`images[${i}].intent.depiction`,code:'SEMANTIC_WHITE',message:'白底图用于外观展示，不能冒充实际使用证明'});
 });
 return issues;
}
// Grow only automatic text containers to the measured minimum. Copy, font,
// product placement and user-selected layouts are immutable here. The normal
// bounds, clearance and native-render checks still run after this projection.
export function fitIntentTextBoxes(plan,size,language,pinnedIndices=[]){
 const output=structuredClone(plan);
 output.images.forEach((shot,index)=>{
  if(pinnedIndices.includes(index))return;
  for(let attempt=0;attempt<shot.copy.length*3;attempt++){
   try{reviewedLayers({minimumMvp:{plan:{...output,images:[{...shot,id:'fit'}]}},input:{requirements:{language}}},{id:'fit',size});break;}
   catch(error){
    const issue=error.layoutIssue;if(!issue)break;
    const e=shot.design.elements.find(e=>e.copyIndex===issue.copyIndex);
    if(!e||issue.reason==='TOO_MANY_LINES')break;
    if(issue.reason==='TITLE_LINE_TOO_WIDE')e.box[2]=Math.max(e.box[2],Math.ceil(issue.estimatedWidestLinePx+1)/size.width);
    else {const share=['图标卡片','局部放大'].includes(e.kind)?.4:1;e.box[3]=Math.max(e.box[3],Math.ceil(issue.minimumHeightForEstimatedLines*size.height/share+1)/size.height);}
   }
  }
 });return output;
}
export function intentImagePrompt(prepared,image,references){
 const p=adaptiveImagePrompt(prepared,image,references),shot=prepared.minimumMvp.plan.images.find(s=>s.id===image.id);
 p.version=INTENT_TEMPLATE+':seedream-base.1';p.data.templateVersion=INTENT_TEMPLATE;
 p.data.renderChecks=prepared.minimumMvp.semanticReview?.images.find(r=>r.imageIndex===prepared.minimumMvp.plan.images.indexOf(shot))?.renderChecks??[];
 p.data.intent=structuredClone(shot.intent);p.system+='\n'+intentRules;
 // Adaptive v13 summarized content to a short purpose. Preserve the reviewed
// action and relationship here, rather than lose them at the image boundary.
 p.data.image.content=shot.content;p.data.image.composition={...p.data.image.composition,action:shot.intent.action,productRelation:shot.intent.productRelation};
 return p;
}
