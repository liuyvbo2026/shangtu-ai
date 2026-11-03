// The header stays in front of the moving form, on desktop and stacked layouts.
export function initInspectorDepth({headingSelector='.inspector-heading',scrollSelector='.inspector-scroll',breakpoint='(max-width:800px)'}={}){
 const compact=matchMedia(breakpoint);
 let heading,scroller,frame=0;
 function sync(){
  if(!heading?.isConnected||!scroller?.isConnected)return;
  const overlap=compact.matches
   ?heading.getBoundingClientRect().bottom-scroller.getBoundingClientRect().top
   :scroller.scrollTop;
  heading.style.setProperty('--header-shadow',String(Math.max(0,Math.min(1,overlap/24))));
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;sync();});}
 document.addEventListener('scroll',event=>{if(event.target===scroller||event.target===document)schedule();},{capture:true,passive:true});
 window.addEventListener('resize',schedule,{passive:true});
 return {refresh(){heading=document.querySelector(headingSelector);scroller=document.querySelector(scrollSelector);sync();}};
}

// Keep native select values and change events as the form contract; render the
// interaction in the document so system popup styling cannot leak into the UI.
export function initSelects(){
 const controls=new WeakMap(),triggers=new WeakMap();
 let current=null,sequence=0,typed='',typedAt=0;
 const arrow='<svg viewBox="0 0 12 8" width="12" height="8" fill="none" aria-hidden="true"><path d="m2 2 4 4 4-4" stroke="currentColor" stroke-width="1"/></svg>';
 const check='<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';

 function close(restoreFocus=false){
  if(!current)return;
  const {trigger,menu}=current;current=null;typed='';
  trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');trigger.removeAttribute('aria-controls');
  menu.remove();if(restoreFocus&&trigger.isConnected)trigger.focus({preventScroll:true});
 }
 function position(){
  if(!current)return;
  const {trigger,menu}=current,rect=trigger.getBoundingClientRect(),margin=10,gap=6;
  if(!trigger.isConnected||rect.bottom<0||rect.top>innerHeight){close();return;}
  const width=Math.min(Math.max(rect.width,192),innerWidth-margin*2);
  const below=innerHeight-rect.bottom-margin-gap,above=rect.top-margin-gap;
  const up=below<Math.min(220,current.options.length*34+12)&&above>below;
  menu.style.width=width+'px';menu.style.maxHeight=Math.max(34,Math.min(336,up?above:below))+'px';
  menu.style.left=Math.max(margin,Math.min(rect.left,innerWidth-width-margin))+'px';
  menu.style.top=Math.max(margin,Math.min(up?rect.top-gap-menu.getBoundingClientRect().height:rect.bottom+gap,innerHeight-menu.getBoundingClientRect().height-margin))+'px';
  menu.dataset.placement=up?'above':'below';
 }
 function highlight(index){
  if(!current||index<0||current.options[index]?.disabled)return;
  current.active=index;
  const rows=[...current.menu.children];rows.forEach((row,i)=>row.classList.toggle('is-active',i===index));
  const row=rows[index];current.trigger.setAttribute('aria-activedescendant',row.id);
  const top=row.offsetTop,bottom=top+row.offsetHeight;
  if(top<current.menu.scrollTop)current.menu.scrollTop=top;
  else if(bottom>current.menu.scrollTop+current.menu.clientHeight)current.menu.scrollTop=bottom-current.menu.clientHeight;
 }
 function move(delta){
  if(!current)return;
  const enabled=current.options.map((o,i)=>o.disabled?-1:i).filter(i=>i>=0);
  if(!enabled.length)return;
  const at=enabled.indexOf(current.active);
  highlight(enabled[Math.max(0,Math.min(enabled.length-1,at+delta))]);
 }
 function choose(index){
  if(!current)return;
  const {native,trigger,options}=current,option=options[index];
  if(!option||option.disabled||native.matches(':disabled'))return;
  const {scope,field}=native.dataset,changed=native.value!==option.value;
  close();trigger.focus({preventScroll:true});
  if(changed){
   native.value=option.value;
   native.dispatchEvent(new Event('change',{bubbles:true}));
   // The change handler can replace the entire form (platform linkage, batch
   // overrides). Focus the replacement trigger, never the now-hidden select.
   const replacement=document.querySelector(`select[data-scope="${CSS.escape(scope)}"][data-field="${CSS.escape(field)}"]`);
   controls.get(replacement)?.trigger.focus({preventScroll:true});
  }
 }
 function open(control){
  const {native,trigger,label}=control;if(native.matches(':disabled'))return;
  close();typed='';typedAt=0;trigger.focus({preventScroll:true});
  const menu=document.createElement('div'),id=`select-list-${++sequence}`;
  menu.id=id;menu.className='select-menu';menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label);menu.style.visibility='hidden';
  const options=[...native.options];
  options.forEach((option,i)=>{
   const row=document.createElement('div');row.id=`${id}-${i}`;row.className='select-option';row.dataset.index=i;
   row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.selected));
   if(option.disabled)row.setAttribute('aria-disabled','true');
   const text=document.createElement('span');text.textContent=option.textContent;
   row.append(text);row.insertAdjacentHTML('beforeend',check);menu.append(row);
  });
  current={...control,menu,options,active:-1};
  trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-controls',id);
  document.body.append(menu);position();menu.style.visibility='';
  highlight(options.findIndex(o=>o.selected&&!o.disabled)>=0?options.findIndex(o=>o.selected&&!o.disabled):options.findIndex(o=>!o.disabled));
  menu.addEventListener('pointerdown',e=>{if(e.pointerType!=='touch')e.preventDefault();});
  menu.addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;const row=e.target.closest('.select-option');if(row)highlight(Number(row.dataset.index));});
  menu.addEventListener('click',e=>{e.preventDefault();const row=e.target.closest('.select-option');if(row)choose(Number(row.dataset.index));});
 }
 function refresh(container=document){
  if(current&&!current.trigger.isConnected)close();
  for(const native of container.querySelectorAll('select[data-scope]')){
   let control=controls.get(native);
   if(!control){
    const wrapper=document.createElement('span'),trigger=document.createElement('button'),value=document.createElement('span');
    const labelNode=native.closest('.field')?.querySelector(':scope > span'),label=labelNode?.textContent.trim()||native.getAttribute('aria-label')||'选项';
    const id=`select-value-${++sequence}`;value.id=id;value.className='select-value';wrapper.className='select-control';
    trigger.type='button';trigger.className='select-trigger';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
    if(labelNode){labelNode.id||=`select-label-${sequence}`;trigger.setAttribute('aria-labelledby',`${labelNode.id} ${id}`);}else trigger.setAttribute('aria-label',label);
    trigger.dataset.selectScope=native.dataset.scope;trigger.dataset.selectField=native.dataset.field;
    trigger.append(value);trigger.insertAdjacentHTML('beforeend',arrow);
    native.replaceWith(wrapper);wrapper.append(trigger,native);native.hidden=true;native.tabIndex=-1;native.setAttribute('aria-hidden','true');
    control={native,trigger,value,label};controls.set(native,control);triggers.set(trigger,control);
    trigger.addEventListener('click',e=>{e.preventDefault();if(current?.trigger===trigger)close();else open(control);});
   }
   control.value.textContent=native.selectedOptions[0]?.textContent||'';control.trigger.disabled=native.matches(':disabled');
  }
 }
 document.addEventListener('pointerdown',e=>{if(current&&!current.menu.contains(e.target)&&!current.trigger.contains(e.target))close();},true);
 document.addEventListener('focusin',e=>{if(current&&!current.menu.contains(e.target)&&e.target!==current.trigger)close();});
 document.addEventListener('scroll',e=>{if(current&&e.target!==current.menu)close();},true);
 window.addEventListener('resize',position);
 document.addEventListener('keydown',e=>{
  const control=triggers.get(e.target);if(!control||control.native.matches(':disabled')||e.isComposing)return;
  if(e.key==='Tab'){close();return;}
  if(e.key==='Escape'&&current){e.preventDefault();e.stopImmediatePropagation();close(true);return;}
  if(['Enter',' ','ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(e.key)){
   e.preventDefault();e.stopImmediatePropagation();
   if(!current){open(control);if(e.key==='Home')highlight(current.options.findIndex(o=>!o.disabled));else if(e.key==='End')move(Infinity);return;}
   if(['Enter',' '].includes(e.key)||(e.altKey&&e.key==='ArrowUp'))choose(current.active);
   else if(e.key==='Home')move(-Infinity);else if(e.key==='End')move(Infinity);
   else move(e.key==='PageDown'?8:e.key==='PageUp'?-8:e.key==='ArrowDown'?1:-1);
  }else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
   e.preventDefault();e.stopImmediatePropagation();if(!current)open(control);
   const now=Date.now();typed=now-typedAt>700?e.key:typed+e.key;typedAt=now;
   const query=([...typed].every(c=>c===typed[0])?typed[0]:typed).toLocaleLowerCase();
   for(let offset=1;offset<=current.options.length;offset++){
    const index=(current.active+offset)%current.options.length,option=current.options[index];
    if(!option.disabled&&option.textContent.trim().toLocaleLowerCase().startsWith(query)){highlight(index);break;}
   }
  }
 },true);
 return {refresh,focusedNative:()=>triggers.get(document.activeElement)?.native,focus:native=>controls.get(native)?.trigger.focus({preventScroll:true})};
}
