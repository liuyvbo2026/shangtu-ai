import {BASELINE_TEMPLATE,understandingTemplate} from './workflow/minimum-templates.js';

export function reusableUnderstanding(runs,{productId,productRevision,description,templateVersion=BASELINE_TEMPLATE}){
 return runs.find(r=>r.kind!=='quality'&&(r.state==='succeeded'||r.kind==='plan'&&r.state==='failed'&&r.understandingReady)&&
  r.snapshot.productId===productId&&r.snapshot.productRevision===productRevision&&r.snapshot.description===description&&
  understandingTemplate(r.snapshot.templateVersion??BASELINE_TEMPLATE)===understandingTemplate(templateVersion));
}

export const textKind={understand:'商品理解',assist:'AI 帮写',plan:'套图规划',style:'风格分析',listing:'上架文案',quality:'图片检查'};
export const textState={queued:'排队中',partial:'部分完成',running:'处理中',succeeded:'已保存',failed:'未通过',canceled:'已取消'};
export function pendingTextChanged(pending,{kind,product,description,settings}){
 return !!pending&&(pending.body.kind!==kind||pending.body.productId!==product?.serverId||pending.body.productRevision!==product?.serverRevision||
  pending.body.description!==description||JSON.stringify(pending.body.settings)!==JSON.stringify(settings)||JSON.stringify(pending.refs)!==JSON.stringify(product?.refs));
}
export const textErrors={
 PRODUCT_INPUT_UNCLEAR:'还无法确认要制作的商品，请补充清晰主体照片或说明目标商品。原资料已保留，尚未生成图片。',
 PRODUCT_CONTENT_REJECTED:'本次内容不适合制作商品宣传图，请调整图片或文字内容。原资料已保留，尚未生成图片。',
 TEXT_ART_DIRECTION:'整套字色对比或图文间距不足，请调整规划后重试。尚未生成图片。',
 TEXT_REGION_TOO_SMALL:'文字区域不足以清晰排字，请调整文案或版式后重试。尚未生成图片。',
 MIMO_AUTH:'MiMo 普通 API 凭证或模型权限未通过。',MIMO_RATE_LIMIT:'MiMo 请求受限，请稍后再决定是否新建任务。',
 MIMO_REJECTED:'MiMo 拒绝了请求，请核对配置。',MIMO_OUTCOME_UNKNOWN:'上游结果不明，已暂停后续调用，需要核对调用记录。',
 MIMO_USAGE_UNKNOWN:'上游用量无法核对，已暂停后续调用。',PROCESS_INTERRUPTED:'服务中断，未自动重发；原资料和已完成阶段仍保留。',
 TEXT_OUTPUT_TRUNCATED:'模型输出未完整结束，未应用。',TEXT_INPUT_TOO_LONG:'帮写后超过1000字，未截断或覆盖原文。',
 BUDGET_LIMIT:'本轮剩余预算不足，未发起后续请求。',BILLING_UNKNOWN:'已有上游结果或费用待核对，未发起后续请求。',
 REFERENCE_NOT_AUTHORIZED:'参考图尚未获得 MiMo 上传授权。',
 TEXT_SEMANTIC_REVIEW:'图文方案的用途或文案未通过复核，请按下方意见修改后重试。尚未生成图片。',
 SEMANTIC_OUTPUT_INVALID:'图文语义复核未能完整完成，记录已保留，尚未生成图片。',
 SEMANTIC_REVIEW_REQUIRED:'这份方案还需要图文语义复核，不能仅重新检查格式后开始生图。',
 TEXT_INTENT_INVALID:'图片任务与文案对应关系不完整，尚未生成图片。',
 TEXT_DESIGN_INVALID:'规划中的展示分工或图文安排有冲突，未开始生成图片。'
 ,TEXT_LAYOUT_MISMATCH:'规划未按所选版式安排对应卖点图，未开始生成。',TEXT_LAYOUT_CAPACITY:'版式文案超出文字区域容量，未开始生成。'
};
export function textRunView(run,{esc,btn,types}){
 if(!run)return '<p role="status">正在读取已保存内容…</p>';
 let html=`<p role="status">${esc(textKind[run.kind])} · ${esc(textState[run.state])}</p><p class="helper">${run.kind==='plan'?'规划保存后，可按此规划生成图片；当前尚未出图。':'本次仅处理文字，不生成图片。'}</p>`;
 if(run.state==='failed')html+=`<p role="alert">${esc(textErrors[run.errorCode]||'模型输出未通过结构或事实规则校验，原资料仍保留。')}（${esc(run.errorCode)}）</p>`;
 if(run.state==='failed'&&run.designProblems?.length)html+=`<ul>${[...new Set(run.designProblems.map(x=>x.message))].map(message=>`<li>${esc(message)}</li>`).join('')}</ul>`;
 html+=`<details><summary>本次商品输入与参考图</summary><p class="listing-copy">${esc(run.snapshot.description||'未填写文字')}</p><div class="reference-grid">${run.snapshot.references.map((r,i)=>`<div class="reference"><img data-asset="server:${esc(r.assetId)}" alt="参考图 ${i+1}"><span>${i+1}</span></div>`).join('')}</div></details>`;
 if(run.state==='succeeded'&&run.kind==='style')html+=`<section class="control-section"><h3>商品视觉方向</h3>${run.output.notes.map(n=>`<p>${esc(n.text)}</p>`).join('')}<p class="helper">依据商品参考，没有市场热度数据。</p></section>`;
 if(run.state==='succeeded'&&run.kind==='listing')html+=`<section class="control-section"><h3>${esc(run.output.title.text)}</h3>${run.output.bullets.map(n=>`<p>${esc(n.text)}</p>`).join('')}<p>${esc(run.output.description.text)}</p></section>`;
 if(run.kind==='quality'){
  const q=run.snapshot.quality,target=q.outputs.find(x=>x.role==='target');
  html+=`<section class="control-section"><h3>第 ${q.position+1} 张 · 版本 ${target.version}</h3><img class="result-image" data-asset="server:${esc(target.assetId)}" alt="本次检查的图片版本"><p class="helper">模型检查只供核对，不能代替上架前验收；修改后的版本需要重新检查。</p>${run.output?`<p>${esc(run.output.summary)}</p>${run.output.issues.map(i=>`<p>${esc(i.location)}：${esc(i.evidence)}<br>建议：${esc(i.correction)}</p>`).join('')}`:''}</section>`;
  return html;
 }
 const u=run.understanding;
 if(u){
  html+=`<section class="control-section"><h3>用户提供的信息</h3>${u.userInformation.length?u.userInformation.map(x=>`<p class="listing-copy">${esc(x.quote)} <small>（${x.kind==='fact'?'用户陈述':'创作要求'} · ${esc(x.id)}）</small></p>`).join(''):'<p>没有可引用的用户陈述</p>'}</section>`;
  html+=`<section class="control-section"><h3>图片可见特征</h3>${u.observations.map(x=>`<p>${esc(x.text)} <small>（参考图 ${x.referenceIds.map(id=>run.snapshot.references.findIndex(r=>r.id===id)+1).join('、')} · ${esc(x.id)}）</small></p>`).join('')}<p class="helper">这是模型观察，请核对原图；不代表已确认材质、容量或性能。</p></section>`;
  html+=`<section class="control-section"><h3>仍待核实</h3>${u.unknowns.map(x=>`<p>${esc(x.reason)}</p>`).join('')}${u.conflicts.map(x=>`<p role="alert">信息冲突：${esc(x.reason)}</p>`).join('')}</section>`;
 }
 if(run.state==='succeeded'&&run.kind==='plan')html+=`<section class="control-section"><h3>整套风格</h3><p>${esc([...run.output.visual.palette,run.output.visual.font,run.output.visual.lighting,run.output.visual.background].join(' · '))}</p></section>${run.output.images.map((x,i)=>`<section class="control-section"><h3>${i+1}. ${esc(types[x.type])} · ${esc(x.purpose)}</h3>${x.design?`<p>展示重点：${esc(x.design.question)}</p>`:''}<p class="listing-copy">${esc(x.content)}</p><p>文案：${x.copy.length?esc(x.copy.map(c=>c.text).join('\n')):'不加文案'}</p><p>构图：${esc(Object.values(x.composition).join(' · '))}</p><p class="helper">参考图 ${x.referenceIds.map(id=>run.snapshot.references.findIndex(r=>r.id===id)+1).join('、')} · 来源 ${esc(x.sourceIds.join('、'))} · ${esc(x.ratio)} · ${x.size.width} × ${x.size.height}</p></section>`).join('')}`;
 if(run.state==='running')html+='<p class="helper">关闭或刷新页面后，可从“文字记录”继续查看。不会自动重复调用。</p>'+btn('取消本次规划或理解','text-cancel',{id:run.id});
 if(run.state==='canceled')html+='<p class="helper">已停止后续阶段；已发出的请求是否计费以用量回执为准。已完成记录仍保留。</p>';
 return html;
}
