export const reviewState={unreviewed:'尚未完整检查',running:'检查中',failed:'检查未完成','needs-correction':'建议修改',uncertain:'仍需人工核对','no-obvious-issue':'未见明显问题'};
export function correctionFromReview(items){
 const issues=items.filter(i=>!i.stale&&i.state==='succeeded').flatMap(i=>i.output?.issues??[]).filter(i=>i.severity!=='uncertain');
 return [...new Set(issues.map(i=>`${i.location}：${i.correction}`))].join('\n');
}
export function qualityView(m,{esc,btn}){
 if(m.loading)return '<p role="status">正在读取检查记录…</p>';
 if(m.error)return `<p role="alert">${esc(m.error)}</p>${btn('重新读取','quality-open',{id:m.taskId})}`;
 const q=m.report;if(!q)return '';
 const current=q.items.filter(i=>!i.stale),old=q.items.filter(i=>i.stale);
 const rows=items=>items.map(i=>`<section class="control-section"><h3>第 ${i.position+1} 张 · 版本 ${i.version}${i.totalReferenceGroups>1?` · 参考组 ${i.referenceGroup+1}/${i.totalReferenceGroups}`:''}${i.stale?' · 已过期':''}</h3><p>${esc(i.output?.summary||({queued:'等待检查',running:'正在检查',failed:i.errorCode==='CANCELED'?'已取消，记录保留':i.errorCode==='QUALITY_SOURCE_CHANGED'?'图片已更新，旧检查停止':'本次检查未完成'}[i.state]||'等待结果'))}</p>${i.verdictAdjusted?'<p class="helper">模型总判断与问题清单矛盾，已按问题清单归类；原报告保留。</p>':''}${(i.planningIssues??[]).map(x=>`<p><strong>规划文案问题：${esc(x.text)}</strong><br>${esc(x.message)}</p>`).join('')}${i.textAudit?.checks?.length?`<details><summary>文字核对</summary>${i.textAudit.checks.map(c=>`<p>${esc(c.planned)} · ${c.status==='matched'?'已识别到':'未确认，请查看原图'}</p>`).join('')}</details>`:''}${(i.output?.issues??[]).map(x=>`<p><strong>${esc(x.location)}</strong>${x.severity==='uncertain'?'（待核实）':''}<br>${esc(x.evidence)}<br>建议：${esc(x.correction)}</p>`).join('')}${!i.stale&&correctionFromReview([i])?btn('查看并修改此图','quality-correct',{id:i.resultId,class:'text-button',disabled:m.busy}):''}</section>`).join('');
 return `<p role="status">${esc(reviewState[q.state]||q.state)}</p><p class="helper">检查原图、文案、版式和相邻图的一致性。模型可能漏检，仍需逐图核对；修改会另存版本。</p>${rows(current)}${old.length?`<details><summary>历史检查 · ${old.length} 条</summary><p class="helper">图片或相邻图片已更新，旧结论不适用于当前套图。</p>${rows(old)}</details>`:''}<div class="modal-footer">${q.state==='running'?btn('取消检查','quality-cancel',{disabled:m.busy}):btn(current.some(i=>i.state==='failed')?'重试未完成检查':'检查当前套图','quality-run',{class:'primary',disabled:m.busy})}</div>`;
}
