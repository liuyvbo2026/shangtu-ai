import {reviewedUnderstandingRules,reviewedPlanningRules,reviewedStyleRules,reviewedListingRules,reviewedImagePrompt,reviewedLayers} from './reviewed-design.js';
export const ADAPTIVE_TEMPLATE='ecommerce-kit.13';
export const isAdaptiveTemplate=v=>[ADAPTIVE_TEMPLATE,'ecommerce-kit.14','ecommerce-kit.15','ecommerce-kit.16'].includes(v);
export const isReviewedTemplate=v=>['ecommerce-kit.12',ADAPTIVE_TEMPLATE,'ecommerce-kit.14','ecommerce-kit.15','ecommerce-kit.16'].includes(v);
export const adaptiveUnderstandingRules=reviewedUnderstandingRules+`
v13 静态证据约束：不同参考照片首先视为拍摄角度或光线变化，不能据此推断滑动、折叠、旋转、开关或拆装过程。observations只记录单张照片的可见形态；功能和动作能力若用户明确提供，放入userInformation并引用原句，不包装成照片证明。不能写“推开后露出另一侧”“转动即可”“无反光高光”等过程/绝对判断。可写“表面呈哑光质感，局部有柔和反光”。不把未经标注的两张静态照片当作操作前后对比。buyerQuestions优先已知卖点与日常购买疑问，少列没有资料可回答的定制/隐含功能。`;
export const adaptivePlanningRules=reviewedPlanningRules+`
v13 内容与实际排版：先让每页承担不同购买问题，再安排文案与摄影。用户明确提供且无冲突的规格/功能是可用信息，优先安排进卖点页，不能全部遗漏却反复写颜色；无需强行用满四条。标题写自然短句，建议4–6个汉字、最长两行；标签尽量6–9字。场景强调商品在使用中的关系，人物和布景不能抢走商品重点；允许基于用途的自然生活表达，不承诺未知性能。白底无字，细节真实聚焦局部，不能以不同角度重复整杯/整鞋。
卡片、图标和文字由本机共同绘制。设计elements仍给出绑定copyIndex的完整卡片位置，copy[0]只做标题，其他卡片每条对应一个真实卖点；最多三卡。禁止要求摄影模型生成卡片、标注框、图标、占位字、引线或拼接小图。局部放大/分区等复杂展示在本轮优先用独立细节页表达，避免无法绑定的标注。商品底图聚焦摄影和真实结构；actual pixel检查后程序可以整体移动组件，若无足够留白则把完整照片与文字分区排版。规划坐标是意图，不是最终像素检测结果。
文案sourceIds必须支持产品事实。生活场景短句可以配合用户用途，不将“办公随行/日常相伴”误当成功能承诺；明确的规格性能仍须用户事实或清晰标记。不得把拍摄角度变化宣传为开合动作。
单角度参考的场景选择：先检查人物佩戴/手持是否迫使展示未见侧面、接口或连接结构；若无法可靠核对，优先保持已见角度，在真实用途场所展示取用前/使用后的商品关系。场景仍须解释用途并突出商品，不能退成无关背景装饰；不强制安排人物。连接方式未知时不补线缆，也不把无线缆画面写成无线性能。`;
export const adaptiveStyleRules=reviewedStyleRules+'以商品主色选择整套字色，允许干净的摄影区与信息区分工，卡片和图标由本机排版，不在摄影建议中要求AI画空卡片。';
export const adaptiveListingRules=reviewedListingRules+'跨视图差异不能作为运动/折叠/开合证据。用户提供的功能可以直接说明，但不能补写未经提供的操作步骤和内部机制。避免“无反光高光”等绝对观察；将规格和特点转写为自然介绍，减少外观清单堆砌。';
export const motionInference=text=>/推开后|滑动后|转动后|折叠后|露出另一侧|位置.{0,5}不同.{0,6}(?:偏移|状态)|无反光高光/.test(text);
// Copy is the single source of truth for its local component's evidence.
// Keep all wording, indexes and geometry; validation still checks the copy's
// sources against the understanding and the image's own allowed sources.
export function bindAdaptiveEvidence(plan){const output=structuredClone(plan);for(const shot of output.images)for(const e of shot.design.elements)if(e.copyIndex>=0&&shot.copy[e.copyIndex])e.sourceIds=[...shot.copy[e.copyIndex].sourceIds];return output;}
export function adaptiveLayers(prepared,image){return reviewedLayers(prepared,image);}
export function adaptiveImagePrompt(prepared,image,references){const p=reviewedImagePrompt(prepared,image,references),shot=prepared.minimumMvp.plan.images.find(s=>s.id===image.id);p.version=ADAPTIVE_TEMPLATE+':seedream-base.1';p.data.templateVersion=ADAPTIVE_TEMPLATE;p.data.localComponents={version:'local-components.1',cardIndices:shot.design.elements.filter(e=>e.kind==='图标卡片'&&e.copyIndex>0).map(e=>e.copyIndex)};p.data.regions=[];
 p.data.image={...p.data.image,content:shot.type==='white'?shot.content:shot.design.subjectMode==='局部细节'?`摄影任务：${shot.purpose}。仅拍真实商品局部，目标证据见selectedSources。`:`摄影任务：${shot.purpose}。只拍商品与适用环境。`,composition:{angle:shot.composition.angle,background:shot.composition.background,framing:shot.design.subjectMode==='局部细节'?'指定部位特写，保持真实结构':'商品清楚完整，遵守subject区域和留白',layout:'摄影底图'}};
 if(shot.design.subjectMode==='局部细节'){
  p.data.image.purpose=shot.design.question;p.data.image.content=`一幅连续的局部摄影，只回答：${shot.design.question}。目标部位以focusSources为准，不附带整机小图。`;
  p.data.image.composition.angle='参考照片已见部位的单一局部近景，不额外展示整机或第二视角';
  p.data.focusSources=prepared.minimumMvp.sources.filter(s=>shot.design.focusSourceIds.includes(s.id));
 }
 p.system+='\nv13执行边界：这是没有任何设计组件的摄影原片，所有标题、标签、卡片、图标和信息图将由应用统一添加。禁止画卡片、玻璃板、圆角矩形装饰、空框、编号、引线、占位字及多格拼版。局部图只放大已见结构。不同参考视角不代表开合动作，不创造运动机制。未知附件、线缆和接口不得新增；连接方式未知时不补画连接线，也不把无连接线解释为无线功能。场景中商品是销售主体，人和环境用于解释使用关系，商品需清楚且比例可信。';return p;}
