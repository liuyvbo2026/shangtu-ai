// Candidate v8 adds an explicit rendering checklist and customer-facing copy
// checks. It does not change any historical v7 prompt or claim pixel quality.
export const COMMERCE_TEMPLATE='ecommerce-kit.8';
export function bindCommerceElements(plan){
 const output=structuredClone(plan);
 for(const image of output.images){
  const d=image.design;if(!d)continue;
  const decorative=d.elements.filter(e=>e.copyIndex===-1&&!['标题','标签'].includes(e.kind));
  // The copy list is authoritative. Do not ask the model to repeat indexes and
  // evidence correctly in a second, redundant list: bind them in code.
  d.elements=image.copy.map((c,i)=>({kind:i===0?'标题':image.composition.layout==='图标卡片'?'图标卡片':image.composition.layout==='局部放大'?'局部放大':'标签',copyIndex:i,sourceIds:[...c.sourceIds],box:[.05,.05,.2,.1]}));
  if(image.composition.layout!=='图标卡片'||!image.copy.length)d.elements.push(...decorative);
  if(image.composition.layout==='图标卡片'){
   // Card cardinality and labels are derived once, including prose sent to the
   // renderer. Keep the original model prose in text_plan_projections.
   const cards=d.elements.filter(e=>e.kind==='图标卡片');
   image.content=`完整展示参考中的商品，保持可见外观与结构。${image.copy.length?`独立主标题“${image.copy[0].text}”，标题不占卡片。`:''}安排${cards.length}张信息卡片，依次为${cards.map((e,i)=>e.copyIndex<0?`第${i+1}张为无字图示`:`第${i+1}张“${image.copy[e.copyIndex].text}”`).join('；')}。每张图示只说明该卡片sourceIds所支持的可见部位或事实，不绘制额外文字或卡片。`;
   image.composition.framing='按design.subjectBox保留完整商品；标题与卡片依design.elements逐项排布，互不遮挡，不重复标题为卡片。';
  }
 }
 return output;
}
const internalCopy=/同一款|可见特征|结构保持|包装文字清晰|品名印刷可见|品牌标记|轮廓收尾|接触阴影|织物衬托|侧向视角|正面呈现|细节证据|标签可辨|参考图|图文一致|主体完整|信息分工|柔光衬托/;
export function commerceCopyIssues(plan){
 const issues=[];
 for(const [i,image] of (plan.images??[]).entries())for(const [j,c] of (image.copy??[]).entries()){
  if(internalCopy.test(c.text))issues.push({path:`images[${i}].copy[${j}].text`,code:'COPY_INTERNAL_NOTE',message:'这是包装观察或摄影工作说明。改写为顾客能直接理解的商品名称、外观特点或有事实依据的商品信息；不要把画面布景当卖点，不添加功效。',rejected:c.text});
 }
 return issues;
}
export const commercePlanningRules=`本次采用 ecommerce-kit.8。先确定顾客要看的商品信息，再写可直接上架的文字。copy 只写最终顾客可见文案，绝不写摄影/校验/排版工作说明；镜头、品牌保持、完整性、文字清晰度、背景/织物/阴影等要求放在content与composition，不能拿来充当商品卖点。不要使用“包装文字清晰”“品名印刷可见”“竖排品牌标记”“整瓶轮廓收尾”“柔白织物衬托”等标题或标签。
每张标题指向商品本身的一个明确特点或生活语境，必要时直接使用已确认的商品名称。标签用准确的部位名称及可见特点；宁可只保留一个有效标题，也不要凑满三个无价值标签。缺少功能事实时，通过真实外观、细节和生活场景表达，不编造性能。
文字区域由程序根据copy清单逐条绑定索引、对应证据与版式坐标。design.elements仍需按schema填写，但不在content中另加未列入copy的信息卡或文字；标题不算标签或信息卡。每张有几个非标题copy就安排几个有字卡片，不做重复或多余卡片。
局部放大、卡片中的图像和文字必须表达同一部位，sourceIds只选择能指明这个部位的证据；content逐项说明对应关系。只有确切可定位的部位才用引线，引线末端应落在所说部位，不能指向空白或其他部件。可见角度不足时选已有视角的细节，不补画未知背面。
整套字体家族、字重、字色保持一致，文字用清楚的深色无衬线体，不混用衬线、手写、描边或装饰字体。相同类型标签保持相同层级。文字清单必须与实际画面一一对应，商品上原有文字不算营销标题。`;
export function commerceRenderSpec(shot,source){
 const sources=source.sources??[];
 return {version:'commerce-render.1',typography:{family:source.plan.visual.font,style:'整套统一字体家族、字重与字色；清楚的实心文字，不混用描边、衬线与手写体'},
  requiredText:shot.copy.map((c,i)=>({index:i,text:c.text,role:i===0?'标题':'标签',box:shot.design.elements.find(e=>e.copyIndex===i)?.box,
   evidence:sources.filter(s=>c.sourceIds.includes(s.id))})),
  regions:shot.design.elements.map(e=>({...e,text:e.copyIndex>=0?shot.copy[e.copyIndex].text:null,evidence:sources.filter(s=>e.sourceIds.includes(s.id))})),
  subject:{mode:shot.design.subjectMode,box:shot.design.subjectBox,angle:shot.composition.angle},
  requirements:['先为全部标题和标签保留指定留白，不可省略清单文字','包装原有标记按原图保留，与营销文案分开','局部图和标签对应同一部位；引线只指向该部位，不画无指向装饰线','完整主体模式不裁掉商品，局部细节模式按本图重点取景','最终逐项核对文字数量、逐字内容、字体、取景和部位对应']};
}
