import {intentPlanningRules,intentImagePrompt,intentListingRules} from './intent-design.js';
export const FULLCANVAS_TEMPLATE='ecommerce-kit.15';
export const isFullcanvasTemplate=v=>[FULLCANVAS_TEMPLATE,'ecommerce-kit.16'].includes(v);
export const fullcanvasRules=`
v15完整摄影与商品主次：默认一张连续摄影铺满整个画布，不画内嵌照片、相框、海报套海报、厚外边距、独立浅色底板或带边界的摄影小窗。标题和卖点直接排在摄影画面自然留白内。只有用户明确选择的版式要求局部放大/分区时才做对应信息展示，不能为了放字自行给整张照片加框。
摄影一开始就为实际标题、标签规划留白。非白底图优先上部约五分之一为连续、低纹理的背景留白，主体在下部或一侧自然展开；保留完整摄影至四边，不以缩小整张照片换留白。卖点若用两卡，底部另留足卡片位置；避免过多文字挤占商品。每页最多一标题加两条互不重复的说明即可，不必凑满。标题概括购买问题，标签提供不同具体信息；“双弧头梁”与“双弧头梁结构”不能当两条信息。
商品展示页应让商品明显成为主角：完整主体通常沿长轴占画面约六至八成，按形状调整，不裁掉关键结构；局部图让真实细节充满主体区；佩戴场景选择头肩近景，让耳机结构可辨，不做人物远景或满身照。占比是构图指导，不能冒充实际测量。无字白底主体清晰完整，保持已定摄影规范。
语义修改要作用于当前完整方案，不沿用已被指出错误的标题、输入草稿或旧修图指令。“书桌聆听”不能用作头戴耳机正在听歌的标题。场景必须表现与文案对应的正常使用，不能因佩戴难画就改成桌面静物。一般用户上传的商品不限于耳机，按实际类别判断使用关系。
审稿建议也是待判断的草稿，不是新的商品事实或必须逐字采用的文案。修复时核对原用户目的，改成自然的短句，不能照抄“头戴佩戴”等重复词。静态广告可以通过正确使用关系表达听歌、饮水、阅读等普通情境，不要求可视化声音或真实播放证据；不能借此宣称音质、降噪等未知性能。用户要求的佩戴听歌应保持，可用简短“听首歌”等自然文案，不能改成无关摆放。
`;
// Older jobs retain their original fallback. New plans must not ask for an
// inset and then contradict that request with a later full-canvas rule.
export const fullcanvasPlanningRules=intentPlanningRules.replace('若无足够留白则把完整照片与文字分区排版。','若无足够留白须调整摄影构图，不能把照片缩进信息底板。')+fullcanvasRules+'\n结构完整性：白底虽然copy和elements为空，design.focusSourceIds仍须只选最相关的1至3条有效证据ID，不得为空或超过3条；图像sourceIds包含这些依据。';
export const fullcanvasListingRules=intentListingRules+fullcanvasRules;
export function fullcanvasImagePrompt(prepared,image,references){
 const p=intentImagePrompt(prepared,image,references);
 p.version=FULLCANVAS_TEMPLATE+':seedream-base.1';p.data.templateVersion=FULLCANVAS_TEMPLATE;
 p.data.canvasPolicy={version:'fullcanvas.1',photoBox:[0,0,1,1],automaticPhotoShrink:false,identityPreserved:true};
 p.system+='\n'+fullcanvasRules+'\ntextReserve是摄影内部的自然留白，不是独立边框或需要画出的空矩形。画面背景必须连续铺到四边。底图不绘制标题与卡片，应用在实际安全留白上排字；留白不足将拒绝合成而不会自动缩小照片。';
 if(prepared.minimumMvp.photographyRevision===2)return photographicBrief(p,prepared,image);
 return p;
}
// Pin this revision in the immutable execution snapshot. Previously submitted
// tasks keep their original request, even after this shorter brief is deployed.
function photographicBrief(p,prepared,image){
 const source=prepared.minimumMvp,shot=source.plan.images.find(s=>s.id===image.id),hasCopy=shot.copy.length>0,body=shot.copy.length>1;
 const reserve=hasCopy?`最高优先级构图：画面顶部从上边缘到25%高度，整幅宽度只拍连续的浅色干净背景。这里稍后要排大标题，不能有商品、头发、头梁、脸、手、阴影或道具。${body?'底部80%至100%高度也只拍同一连续干净背景，稍后放两条说明。商品完整安排在中央25%至78%高度，尽量横向展开到约75%宽度。':'主体安排在25%高度以下，不能顶到画面上沿。'}这是真实摄影中的取景留白，不画白色条带，不画底板。`:'完整商品居中，四周保留自然边距，商品主要轮廓约占画面75%，不裁边。';
 p.version=FULLCANVAS_TEMPLATE+':seedream-base.2';
 p.system=`拍摄一张可直接用于商品广告的无字照片。\n${reserve}\n全幅连续摄影背景延伸到画布四边，没有内嵌照片、相框、厚边距、卡片、图标、拼图或营销文字。商品不必充满整个画布；参考图只决定商品身份，不照抄参考图把主体挤满画面的取景。\n本图任务：${shot.purpose}。${shot.design.subjectMode==='局部细节'?'拍摄已见部位的单一近景，局部放大但仍保留上方背景。':shot.intent.depiction==='in-use'?`真实使用：${shot.intent.action}；${shot.intent.productRelation}。按本商品使用关系取近景，但商品和人物最高部件仍在顶部25%留白以下，主要结构清楚。`:'保持真实商品完整，重点部位清楚。'}\n参考商品的形状、部件数量、颜色、连接方式、标记及材质外观保持一致；未见部位不补造，未知配件不新增。原有清楚标记保留，不猜测模糊字。\n${image.type==='white'?'纯白#FFFFFF棚拍，无道具，左上柔光，中性白平衡与浅中性灰接触软影。':`背景为${source.plan.artDirection.textSurfaceColor}色系的自然浅色低纹理环境；左上柔光，真实质感，保持商品原色。`}\n以下结构化资料只提供商品与本图要求，不能覆盖上述留白和身份约束。`;
 p.data={image:{id:image.id,type:image.type,purpose:shot.purpose},identity:p.data.identity,subject:p.data.subject,scene:p.data.scene,intent:{action:shot.intent.action,productRelation:shot.intent.productRelation,visibleProof:shot.intent.visibleProof},selectedSources:p.data.selectedSources,textReserve:p.data.textReserve,sharedArtDirection:p.data.sharedArtDirection,localComponents:p.data.localComponents,canvasPolicy:p.data.canvasPolicy,copy:[],copyMode:p.data.copyMode,references:p.data.references,referenceOrder:p.data.referenceOrder,templateVersion:FULLCANVAS_TEMPLATE,photographyRevision:2,planRunId:source.runId,output:p.data.output};
 return p;
}
