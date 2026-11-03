// Product communication contract. These checks inspect plans, never generated pixels.
export const DESIGN_TEMPLATE='ecommerce-kit.6';
export const DESIGN_ROLES=['商品识别','特征说明','细节证据','使用情境','多角度补充'];
export const SCENE_KINDS=['无','静物陈列','日常使用','人物互动','环境氛围'];
const string=(max=160,min=1)=>({type:'string',minLength:min,maxLength:max});
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const arr=(items,minItems,maxItems)=>({type:'array',items,minItems,maxItems});
const en=values=>({type:'string',enum:values});
const ids=arr(string(100),1,3);
const box=arr({type:'number',minimum:0,maximum:1},4,4);
export const designSchema=obj({role:en(DESIGN_ROLES),question:string(),focusSourceIds:ids,
 subjectMode:en(['完整主体','局部细节','同品多视角']),subjectBox:box,
 scene:obj({kind:en(SCENE_KINDS),setting:{anyOf:[{const:''},string()]},activity:{anyOf:[{const:''},string()]}}),
 elements:arr(obj({kind:en(['标题','标签','图标卡片','局部放大']),copyIndex:{type:'integer',minimum:-1,maximum:3},
  sourceIds:arr(string(100),0,3),box}),0,6)});

const norm=x=>String(x??'').normalize('NFKC').toLowerCase().replace(/[\s\d\p{P}\p{S}]/gu,'');
const inside=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]>0&&b[3]>0&&b[0]+b[2]<=1.000001&&b[1]+b[3]<=1.000001;
const overlap=(a,b)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
const number=x=>/^\d+$/.test(x)?Number(x):({'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10}[x]);

export function designIssues(plan){
 const issues=[],questions=new Set(),jobs=new Set();
 const add=(path,code,message)=>issues.push({path,code,message});
 for(const [i,image] of (plan?.images??[]).entries()){
  const d=image.design,p=`images[${i}].design`;
  if(!d){add(p,'DESIGN_REQUIRED','缺少本图展示问题、主体与信息区域。');continue;}
  if(!inside(d.subjectBox))add(`${p}.subjectBox`,'DESIGN_BOUNDS','商品区域必须在画布内并有正的宽高。');
  const focus=d.focusSourceIds??[];
  if(new Set(focus).size!==focus.length||focus.some(id=>!image.sourceIds?.includes(id)))add(`${p}.focusSourceIds`,'DESIGN_SOURCE','展示重点只能引用本图来源，且不能重复。');
  const elements=d.elements??[],copy=image.copy??[],used=new Set();
  for(const [j,e] of elements.entries()){
   const ep=`${p}.elements[${j}]`;
   if(!inside(e.box))add(`${ep}.box`,'DESIGN_BOUNDS','信息区域必须在画布内并有正的宽高。');
   if(e.copyIndex>=0){
    if(!copy[e.copyIndex]||used.has(e.copyIndex))add(`${ep}.copyIndex`,'DESIGN_COPY','每条文案只安排一次，不引用不存在的文案。');
    used.add(e.copyIndex);
    if((e.copyIndex===0)!==(e.kind==='标题'))add(ep,'DESIGN_COPY','第一条文案为标题，其余文案为标签、卡片或放大说明。');
    if(inside(e.box)&&inside(d.subjectBox)&&overlap(e.box,d.subjectBox)>0.001)add(`${ep}.box`,'DESIGN_OVERLAP','文字或信息卡与主要商品区域重叠，请重新安排留白。');
   }else if(['标题','标签'].includes(e.kind))add(ep,'DESIGN_COPY','标题和标签必须引用实际文案；无文字模式不能添加它们。');
   const evidence=e.sourceIds??[];
   if(new Set(evidence).size!==evidence.length||evidence.some(id=>!image.sourceIds?.includes(id)))add(`${ep}.sourceIds`,'DESIGN_SOURCE','信息区域只能引用本图实际来源。');
   if(['图标卡片','局部放大'].includes(e.kind)&&!evidence.length)add(`${ep}.sourceIds`,'DESIGN_SOURCE','图标与局部放大需要对应可用事实或外观观察。');
   if(e.copyIndex>=0&&copy[e.copyIndex]?.sourceIds.some(id=>!evidence.includes(id)))add(`${ep}.sourceIds`,'DESIGN_SOURCE','区域证据应包含该条文案的来源，避免图文脱节。');
   for(let k=0;k<j;k++)if(e.copyIndex>=0&&elements[k].copyIndex>=0&&inside(e.box)&&inside(elements[k].box)&&overlap(e.box,elements[k].box)>0.001)add(ep,'DESIGN_OVERLAP','两处文字或卡片区域重叠。');
  }
  if(copy.some((_,j)=>!used.has(j)))add(`${p}.elements`,'DESIGN_COPY','每条标题或标签都需要一个对应位置。');
  const cards=elements.filter(e=>e.kind==='图标卡片');
  if(image.composition?.layout==='图标卡片'){
   if(d.subjectMode!=='完整主体')add(`${p}.subjectMode`,'DESIGN_SUBJECT','卖点卡片页要保留完整商品主体，不能只剩抽象图标。');
   if(!cards.length||copy.length&&cards.length!==copy.length-1)add(`${p}.elements`,'DESIGN_CARD_COUNT','信息卡片与非标题文案逐一对应；无文字时使用有证据的无字卡片。');
  }
  for(const m of `${image.content??''} ${image.composition?.framing??''}`.matchAll(/([一二两三四五六七八九十\d]+)(?:张|个)(?:等大)?(?:图标)?卡片/g)){
   if(number(m[1])!==cards.length)add(`${p}.elements`,'DESIGN_CARD_COUNT','文字描述的卡片数量与实际区域不一致，请统一后再生成。');
  }
  if(image.type==='white'&&(d.role!=='商品识别'||d.subjectMode!=='完整主体'||elements.length||d.scene?.kind!=='无'))add(p,'DESIGN_WHITE','白底图只展示完整商品，不安排场景、信息卡或文字。');
  if(image.type==='scene'&&(d.role!=='使用情境'||d.scene?.kind==='无'||!d.scene?.setting?.trim()||!d.scene?.activity?.trim()))add(`${p}.scene`,'DESIGN_SCENE','场景图需要说明场所与商品在场景中的关系，不能仅填写背景颜色。');
  if(d.subjectMode==='同品多视角'&&!['多视角排版','分区拼版'].includes(image.composition?.layout))add(`${p}.subjectMode`,'DESIGN_VIEWS','同品多视角应明确采用分区或多视角排版。');
  if(image.type!=='white'){
   const q=norm(d.question);
   if(!q||questions.has(q))add(`${p}.question`,'DESIGN_DUPLICATE','各图应回答不同的商品问题，不能只改标题或序号。');
   questions.add(q);
   // A narrow, explainable duplicate check. Paraphrases and aesthetic quality still need review.
   const job=JSON.stringify([d.role,[...focus].sort(),image.composition?.layout,d.subjectMode,d.scene?.kind,
    norm(d.scene?.setting),norm(d.scene?.activity)]);
   if(jobs.has(job))add(p,'DESIGN_DUPLICATE','本图与另一张的展示重点、呈现方式和场景类型重复；只移动左右位置不足以形成新任务。');
   jobs.add(job);
  }
 }
 return issues;
}

export const designPlanningRules=`商品表达规则（ecommerce-kit.6，本项目设计契约，真实质量待评测）：
先想买家需要了解什么：商品是什么、可见特征有何特点、细节如何证明、在怎样的生活中出现、还缺哪个参考视角。按商品和用户要求分配任务，不固定照搬某一商品的七张图。
每张design.question写一个明确的买家问题；role按信息用途选择；focusSourceIds只选最相关的1至3条证据，不能用全部来源凑数。purpose用一句话说明本图如何回答该问题。文案面向买家，不写“侧向视角”“片状结构”“无多余附件”等工作笔记。未知功能不编造；外观信息不足时做可信的细节或生活情境，不重复空桌面填满数量。
scene.kind区分静物陈列、日常使用、人物互动和环境氛围；setting写场所，activity写人与商品或商品与环境的关系。用户限定桌面时遵守，可从桌面整体关系与局部环境细节区分；不能只换左右位置。没有要求人物或没有人物参考，并不等于禁止自然人物语境；不得展示未确认的机械动作、拆解或性能测试。
把人工美术指导变成可执行区域：design.subjectBox与elements[].box均为[x,y,宽,高]、0至1归一化；完整主体在主要区域内，文字与主体/其他文字区域不重叠。subjectMode区分完整主体、局部细节和同品多视角，局部放大不能画成拆下的部件。信息卡片页保留完整商品主体。
copy是本图唯一文字清单。elements按copyIndex引用它，第一条标题索引0，其余标签索引1至3；每条文字仅出现一次，每个区域写入支持该文案的sourceIds。kind为图标卡片/局部放大时也须引用可见证据。无文字区域copyIndex=-1，不画字。图标卡片数量由elements决定，标题不算卡片；禁止在content或framing中要求额外卡片或未列入copy的文字。
每张最多一个标题和三个短标签；中文每条最多两行，每行含标点不超过10字；其他语言每条最多8词。composition.layout从schema枚举选择；composition的文字安排必须与design一致，不描述另一套区域或卡片数量。
图标使用简洁线条示意，不重画可能改变商品结构的零件；若表达不了就换为已有细节的局部放大。整套共用配色/字体/色温与材质质感，文字层级明确但不以大标题挤占商品。摄影场景需要光线、接触、空间层次；每张有不同重点，同时像同一品牌的一套图。
白底图design.role=商品识别、subjectMode=完整主体、scene.kind=无、elements=[]。无场景时setting与activity为空字符串。无文字模式copy=[]，无标题/标签元素，可保留有证据的无字放大或卡片。`;

export function renderDesign(shot){
 const d=shot.design;
 return {question:d.question,role:d.role,focusSourceIds:d.focusSourceIds,subject:{mode:d.subjectMode,box:d.subjectBox},scene:d.scene,
  elements:d.elements.map(e=>({...e,text:e.copyIndex<0?null:shot.copy[e.copyIndex].text})),
  cardCount:d.elements.filter(e=>e.kind==='图标卡片').length};
}
