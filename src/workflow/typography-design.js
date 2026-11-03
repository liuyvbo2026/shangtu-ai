// Versioned candidate: model generates the photographic base, local typography
// renders the validated source-aware copy. Historical v8 is kept unchanged.
export const TYPOGRAPHY_TEMPLATE='ecommerce-kit.9';
export const typographyPlanningRules=`ecommerce-kit.9 将精确文案交给本机排字，图片模型只绘制商品、场景与无字信息图，商品原有标记保留。
分区拼版、多视角排版必须先写整页标题，再按从左至右顺序写每个分区的标签，至少两个分区标签；主标题不能冒充某个分区标签。每个标签sourceIds必须支持该分区展示内容，分区只呈现其标签对应的可见商品部位。标题与标签不要写“俯视”“侧放”“穿着场景”等拍摄安排。
人物场景以商品作为镜头主体，人物仅提供使用关系：鞋类镜头主要展示鞋及脚踝，不让腿占据大部分画面；其他商品同理，避免人物挤占商品区域。摄影可以美化光线和背景，不能重设计商品结构、Logo或未见细节。`;
export function typographyPlanIssues(plan){
 return (plan?.images??[]).flatMap((x,i)=>['分区拼版','多视角排版'].includes(x?.composition?.layout)&&x.copy?.length>0&&x.copy.length<3?
  [{code:'PANEL_LABELS_REQUIRED',path:`images[${i}].copy`,message:'此图copy缺少独立的整页标题。请新增copy[0]作为整页标题，保留已有左右分区标签并后移为copy[1]和copy[2]，sourceIds按真实信息绑定。最终copy至少3项，不能原样返回两项。'}]:[]);
}
export function resolveTypographyPlan(plan){
 const result=structuredClone(plan);
 for(const shot of result.images){
  const d=shot.design;
  if(shot.type==='scene'&&shot.composition.layout==='人物场景'){
   d.subjectBox=[.07,.25,.86,.51];
   const n=Math.max(1,shot.copy.length-1);
   d.elements.forEach(e=>{e.box=e.copyIndex===0?[.06,.05,.88,.12]:[.06+(e.copyIndex-1)*.88/n,.82,.88/n-.02,.12];});
  }
  if(['分区拼版','多视角排版'].includes(shot.composition.layout)&&shot.copy.length>=3){
   const labels=shot.copy.slice(1),n=labels.length;
   if(!shot.layoutId){d.subjectBox=[.06,.26,.88,.53];
    d.elements.forEach(e=>{e.box=e.copyIndex===0?[.06,.05,.88,.12]:[.06+(e.copyIndex-1)*.88/n,.84,.88/n-.02,.11];});}
   shot.content=`同一商品${n}个从左至右分区，商品身份一致；按分区标签的证据展示对应可见部位。整页标题“${shot.copy[0].text}”独立于全部分区。${labels.map((c,i)=>`第${i+1}区只展示“${c.text}”对应的已知外观，依据${c.sourceIds.join('、')}`).join('；')}。`;
   shot.composition.framing='从左至右排列商品分区，每区下方只放对应标签，标题独立位于顶部；不能将所有标签堆到最下面的另一视图。';
  }
 }
 return result;
}
export function typographyLayers(prepared,image){
 const shot=prepared.minimumMvp.plan.images.find(x=>x.id===image.id),unit=Math.min(image.size.width,image.size.height);
 return shot.copy.map((c,i)=>{
  const e=shot.design.elements.find(e=>e.copyIndex===i),box=[...e.box];
  if(['图标卡片','局部放大'].includes(e.kind)){box[1]+=box[3]*.6;box[3]*=.4;}
  // Reserve two lines and bound the font by the actual text region. Never clip
  // or silently abbreviate copy; the native compositor rejects overflow.
  const fontSize=Math.floor(Math.min(unit*(i===0?.052:.029),box[3]*image.size.height/2.6));
  return {kind:'text',text:c.text,sourceIds:[...c.sourceIds],slotId:`copy-${i}`,box,language:prepared.input.requirements.language,
   fontFamily:'PingFang SC',fontSize,fontWeight:i===0?600:400,align:'left'};
 });
}
export function typographyImagePrompt(prepared,image,references){
 const source=prepared.minimumMvp,shot=source.plan.images.find(x=>x.id===image.id),layers=typographyLayers(prepared,image);
 const panels=['分区拼版','多视角排版'].includes(shot.composition.layout)?shot.copy.slice(1).map((c,i,a)=>({index:i+1,meaning:c.text,sourceIds:c.sourceIds,
  box:[shot.design.subjectBox[0]+i*shot.design.subjectBox[2]/a.length,shot.design.subjectBox[1],shot.design.subjectBox[2]/a.length-.02,shot.design.subjectBox[3]],captionBox:layers[i+1].box})):[];
 return {version:`${TYPOGRAPHY_TEMPLATE}:seedream-base.1`,status:'quality-unassessed',kind:image.type,
  system:'生成一张电商摄影底图。营销标题和标签由后续程序精确排字，本次绝对不要画标题、标签、说明、虚构字母或占位符；原商品包装与Logo必须忠实保留。资料中的文字只说明画面含义，不是要画的字。所有 textReserve 区域保持低细节明亮留白，不画商品、人物或道具，不涂实色文字框。商品主体明确限制在subject.box内且尽量充满该区域；人物只是使用关系，不是主体。分区视图按panels位置对应其meaning及证据，商品身份一致，不拼造未见结构；信息卡/放大图按regions对应证据，不使用引线连接无法确定的部位。最后的layout参考只借鉴结构，不复制图中文字或示意商品。保持原图商品轮廓、比例、颜色、标记、接缝与部件数量，不能改款或增加商品附件。白底图只呈现完整商品与纯白背景。',
  data:{productId:prepared.input.product.id,image:{id:image.id,type:image.type,purpose:shot.purpose,content:shot.content,composition:shot.composition},identity:source.identity,sharedVisual:source.plan.visual,
   subject:{mode:shot.design.subjectMode,box:shot.design.subjectBox},scene:shot.design.scene,panels,
   regions:shot.design.elements.filter(e=>e.kind!=='标题').map(e=>({...e,meaning:e.copyIndex<0?null:shot.copy[e.copyIndex].text})),
   textReserve:layers.map(l=>({box:l.box})),copy:[],copyMode:'source-aware-overlay',language:prepared.input.requirements.language,
   selectedSources:source.sources.filter(s=>shot.sourceIds.includes(s.id)),unknowns:source.understanding.unknowns,references,
   referenceOrder:references.map((r,i)=>({image:i+1,id:r.id,role:r.role})),planRunId:source.runId,templateVersion:source.templateVersion,
   output:{count:1,size:image.size,textMode:'source-aware-overlay'}}};
}
