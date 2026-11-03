// Draft credentials belong only to the open modal, never to a workspace/backup.
const kinds=['text','image'];
export function initSettingsDraft(m){
 for(const k of kinds){const p=m.settings.providers[k];for(const field of ['providerId','model','endpoint','reserveCny'])m[k+field[0].toUpperCase()+field.slice(1)]=p[field];m[k+'Key']='';m[k+'Clear']=false;m[k+'Show']=false;}
}
export function selectProvider(m,kind,id){
 const p=m.settings.profiles[kind][id];
 for(const field of ['providerId','model','endpoint','reserveCny'])m[kind+field[0].toUpperCase()+field.slice(1)]=p[field];
 m.resetDetails=true;m[kind+'Key']='';m[kind+'Clear']=false;m[kind+'Show']=false;m[kind+'Custom']=false;delete m[kind+'Test'];m.error='';m.message='';
}
export const settingsPayload=m=>({revision:m.settings.revision,...Object.fromEntries(kinds.map(k=>[k,{key:m[k+'Key']||'',clear:!!m[k+'Clear'],providerId:m[k+'ProviderId']??m.settings.providers[k].providerId,model:m[k+'Model']??m.settings.providers[k].model,endpoint:m[k+'Endpoint']??m.settings.providers[k].endpoint,reserveCny:m[k+'ReserveCny']===''?null:m[k+'ReserveCny']??null}]))});
export const settingsChanged=m=>kinds.some(k=>{const p=m.settings?.providers[k];if(!p)return false;const d=settingsPayload(m)[k];return d.key.trim()||d.clear||['providerId','model','endpoint','reserveCny'].some(f=>d[f]!==p[f]);});
export function apiSettingsView(m,{esc,btn}){
 if(m.loading)return '<p role="status">正在读取 API 设置…</p>';
 if(!m.settings)return `<p class="field-error" role="alert">${esc(m.error||'无法读取 API 设置')}</p>${btn('重新读取','api-settings-reload')}`;
 const busy=m.saving||m.testing;
 const field=(kind,name,label,content)=>`<label class="field api-config-field"><span>${label}</span>${content}</label>`;
 const select=(kind,name,options,value,label)=>`<select aria-label="${label}" data-scope="api-config" data-field="${kind+name}" data-api-field="${kind+name}" ${busy?'disabled':''}>${options.map(([v,l])=>`<option value="${esc(v)}" ${value===v?'selected':''}>${esc(l)}</option>`).join('')}</select>`;
 const cards=kinds.map(k=>{
  const p=m.settings.catalog.find(p=>p.id===(m[k+'ProviderId']??m.settings.providers[k].providerId)),saved=m.settings.profiles[k][p.id],name=k==='text'?'语言模型':'生图模型';
  const clear=!!m[k+'Clear'],show=!!m[k+'Show'],model=m[k+'Model']??saved.model;
  const custom=m[k+'Custom']||!p.models.includes(model),test=m[k+'Test'];
  const input=(f,value,extra='')=>`<input aria-label="${name}${f==='Model'?'模型 ID':'接口地址'}" data-api-field="${k+f}" value="${esc(value??'')}" ${busy?'disabled':''} ${extra}>`;
  return `<section class="api-provider"><div class="section-label"><h3>${name}</h3><span class="api-key-status">${clear?'待清除':saved.configured?'已保存密钥':'未保存密钥'}</span></div>
   ${field(k,'ProviderId','服务商',select(k,'ProviderId',m.settings.catalog.filter(p=>p.kind===k).map(p=>[p.id,p.label]),p.id,name+'服务商'))}
   ${field(k,'Preset','模型',select(k,'Preset',[...p.models.map(id=>[id,id]),['__custom','自定义模型 ID']],custom?'__custom':model,name+'模型'))}
   ${custom?field(k,'Model','模型 ID',input('Model',model,'maxlength="200" placeholder="填写服务商提供的模型 ID"')):''}
   <label class="field api-config-field"><span>API Key</span><div class="api-key-input"><input aria-label="${name} API Key" data-api-field="${k}Key" type="${show?'text':'password'}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="4096" value="${esc(m[k+'Key']||'')}" placeholder="${clear?'保存后清除密钥':saved.configured?'已配置，留空保留；填写可替换':'粘贴 API Key'}" ${busy||clear?'disabled':''}>${btn(show?'隐藏':'显示','api-key-show',{id:k,class:'text-button',disabled:busy||clear})}</div></label>
   ${saved.configured?btn(clear?'撤销清除':'清除已保存密钥','api-key-clear',{id:k,class:'text-button api-clear',disabled:busy}):''}
   <details class="api-advanced" ${!['mimo','seedream'].includes(p.id)?'open':''}><summary>调用设置</summary>
    ${field(k,'Endpoint','接口地址',input('Endpoint',m[k+'Endpoint']??saved.endpoint,'maxlength="500" placeholder="https://… 完整接口地址"'))}
    ${field(k,'ReserveCny','单次费用预留（元）',`<input aria-label="${name}单次费用预留" data-api-field="${k}ReserveCny" type="text" inputmode="decimal" maxlength="8" value="${esc(m[k+'ReserveCny']??'')}" placeholder="${['mimo','seedream'].includes(p.id)?'当前默认模型沿用已有预算配置':'请按服务商价格填写'}" ${busy?'disabled':''}>`)}
    <p class="helper">新模型需填写费用预留，用于本机预算检查，不改变服务商计费。模型名称或接口改变后请重新测试。</p>
   </details>
   <p class="helper api-capability">${esc(p.note??(k==='text'?'商品理解需要支持图片输入；可填写同协议的其他模型 ID。':`最多 ${p.maxReferences} 张参考图；商品一致性需实际评测。`))}</p>
   <div class="api-test-actions">${btn(m.testing===k?'正在测试…':'测试连接','api-test',{id:k,disabled:!!busy||clear})}${m.testing===k?btn('停止等待','api-test-cancel',{id:k,class:'text-button'}):''}<span class="helper">${k==='text'?'发送一张测试色块，验证文字与识图。':'实际生成 1 张测试图，使用服务商账户。'}</span></div>
   ${test?`<div class="api-test-result ${test.state}" role="status"><p>${esc(test.message)}</p>${test.preview?`<img alt="生图连接测试结果" src="${esc(test.preview)}">`:''}</div>`:''}
  </section>`;
 }).join('');
 return `<p class="helper api-settings-note">密钥仅保存在本机服务端，不包含在浏览器备份中。测试使用当前填写内容，不会自动保存。</p>${cards}<p class="field-error" role="alert">${esc(m.error||'')}</p><p class="helper" role="status">${esc(m.message||'保存配置不会发起生成。')}</p><div class="modal-footer">${btn('服务状态','demo',{class:'text-button',disabled:busy})}${btn('关闭','close-modal',{disabled:m.saving})}${btn(m.saving?'正在保存…':'保存配置','api-settings-save',{class:'primary',disabled:busy||!settingsChanged(m)})}</div>`;
}
