import {layoutCatalog} from './layout-catalog.js';

export function layoutItems(state){
 const items=new Map();
 // Existing browser materials keep their IDs and take precedence over the catalog.
 for(const item of [...layoutCatalog,...(state.library||[])])if(item?.type==='layout'&&item.id)items.set(item.id,item);
 return [...items.values()];
}

export function applyLayoutSelection(settings,selected,items){
 const layouts=[...new Set(selected)],available=new Set(items.map(item=>item.id));
 if(layouts.some(id=>!available.has(id)))throw Error('部分版式暂不可用，请移除后重新选择。');
 const other=Object.entries(settings.counts).reduce((sum,[type,count])=>sum+(type==='selling'?0:Number(count)),0);
 if(layouts.length>20-other)throw Error(`当前其他图片占 ${other} 张，最多可应用 ${20-other} 个版式。请减少选择。`);
 // Reference behavior: selecting more layouts can increase the selling-image count.
 // Do not copy the observed unresolved 17/13 draft conflict into a valid saved state.
 return {...settings,counts:{...settings.counts,selling:Math.max(settings.counts.selling,layouts.length)},layouts};
}

export function layoutPickerView(state,m,{esc,icon,btn,image}){
 const items=layoutItems(state),selected=m.selected||[];
 const picture=item=>item?.assetId?image(item.assetId,'',item.name):item?.thumbnail?`<img src="${esc(item.thumbnail)}" alt="${esc(item.name)}" loading="lazy" decoding="async">`:'<span class="layout-unavailable">版式暂不可用</span>';
 return `<div class="layout-picker">
  <div class="layout-gallery" tabindex="0" aria-label="可选版式">
   ${items.length?`<div class="layout-grid">${items.map(item=>`<button type="button" class="layout-tile${selected.includes(item.id)?' is-selected':''}" data-a="pick-asset" data-id="${esc(item.id)}" aria-label="${esc(item.name)}" aria-pressed="${selected.includes(item.id)}" title="${esc(item.name)}">${picture(item)}${selected.includes(item.id)?`<span class="layout-check">${icon('check',18)}</span>`:''}</button>`).join('')}</div>`:`<div class="layout-empty"><span class="layout-empty-icon">${icon('layers',28)}</span><p>暂无版式参考</p><small>添加后将在这里显示</small></div>`}
  </div>
  <aside class="layout-selection" aria-label="已选版式">
   <div class="layout-selection-heading"><h3>已选版式</h3><span class="layout-count" role="status" aria-label="已选 ${selected.length} 个，卖点图 ${m.limit} 张">${selected.length}<span>/${m.limit}</span></span></div>
   <p class="layout-selection-hint">每种版式生成 1 张，剩余卖点图 AI 补齐。</p>
   <div class="layout-selection-list" tabindex="0" aria-label="已选版式预览">
    ${selected.length?selected.map(id=>{const item=items.find(item=>item.id===id);return `<div class="layout-picked">${picture(item)}${btn('','pick-asset',{id,icon:'close',class:'layout-remove',title:`移除${item?.name||'不可用版式'}`})}</div>`;}).join(''):'<div class="layout-selected-empty"><p>暂未选择版式</p><small>卖点图将使用 AI 智能版式</small></div>'}
   </div>
   <div class="layout-apply">${btn(`应用 ${selected.length} 个版式`,'apply-layouts',{class:'primary'})}</div>
  </aside>
 </div>`;
}
