import {correctionFromReview} from './quality-tools.js';
import {layoutItems,applyLayoutSelection} from './layout-library.js';
import {settingsChanged,settingsPayload,initSettingsDraft,selectProvider} from './api-settings.js';
import {pendingTextChanged,reusableUnderstanding} from './text-tools.js';
import {INPUT_VERSION,INPUT_LIMIT,inputError,reuseTaskInput} from './product-input.js';
import {exportResultImage,listingContent} from './result-tools.js';
import {api,saveProduct,projectTask,mergeRemote,mergeKitRuns} from './integration-client.js';
import {uid,copy,TYPES,defaultSettings,freshState,setCount,changePlatform,countryLanguage,domesticPlatform,resolveSettings,validateKit,recover,isKitJob,previewContext} from './model.js';
import {openDB,loadState,saveState,importImage,assetURL,getAsset,exportWorkspace,importWorkspace} from './storage.js';
import {download,zip,safeName} from './export.js';
import {appView,modalView} from './views.js';
import {initGlass} from './glass.js';
import {initSelects,initInspectorDepth} from './controls.js';
const root=document.querySelector('#app'),modalRoot=document.querySelector('#modal-root'),fileInput=document.querySelector('#file-input');
let state,saveTimer,saveChain=Promise.resolve(),selectedFileHandler,rendering=false,renderedCards=new Map();
const ui={connection:'正在连接后台…',submitting:false,modal:null,stack:[],historySearch:'',librarySearch:'',libraryGroup:'全部',saveStatus:'内容自动保存在此浏览器',resultInstruction:'',assistText:'',resultSelections:{}};
const glass=initGlass(document.querySelector('#glass-surface'));
const selects=initSelects();
const inspectorDepth=initInspectorDepth();
function toast(message){const t=document.querySelector('#toast');t.textContent=message;t.classList.add('show');clearTimeout(ui.toastTimer);ui.toastTimer=setTimeout(()=>t.classList.remove('show'),4200);}
function markSave(){ui.saveStatus='正在保存…';const el=document.querySelector('#save-status');if(el)el.textContent=ui.saveStatus;clearTimeout(saveTimer);saveTimer=setTimeout(flushSave,180);}
async function flushSave(){clearTimeout(saveTimer);state.savedAt=Date.now();const snap=copy(state);saveChain=saveChain.catch(()=>{}).then(()=>saveState(snap));try{await saveChain;ui.saveStatus='已保存到此浏览器';}catch(e){ui.saveStatus='保存失败，请备份工作区';toast('本地空间不足或不可用，请导出备份后重试。');}const el=document.querySelector('#save-status');if(el)el.textContent=ui.saveStatus;}
const product=id=>state.products.find(p=>p.id===id);
const findJob=id=>state.jobs.find(j=>j.id===id&&isKitJob(j));
function set(o,path,v){const keys=path.split('.');let target=o;for(const k of keys.slice(0,-1))target=target[k]??={};target[keys.at(-1)]=v;}
function scopeTarget(scope){if(scope==='kit')return state.kit;if(scope==='settings')return state.kit.settings;if(scope==='ui')return ui;if(scope==='demo')return state.demo;if(scope==='batchglobal')return state.batch.global;const [kind,id]=scope.split(':');if(kind==='product')return product(id);if(kind==='batchitem')return state.batch.items.find(x=>x.id===id);if(kind==='override')return state.batch.items.find(x=>x.id===id)?.override;if(kind==='asset')return state.library.find(x=>x.id===id);if(kind==='job')return findJob(id);}
async function hydrateImages(container=document){await Promise.all([...container.querySelectorAll('img[data-asset]')].map(async im=>{try {const url=await assetURL(im.dataset.asset);if(url&&im.isConnected){im.src=url;await im.decode();}}catch{im.alt='图片读取失败';}}));}
function render({preserveScroll=true,restoreFocus=true}={}){
 if(rendering)return;rendering=true;
 const positions=preserveScroll?[...document.querySelectorAll('.work-scroll,.inspector-scroll,.modal-content')].map(el=>[el.classList.contains('work-scroll')?'.work-scroll':el.classList.contains('inspector-scroll')?'.inspector-scroll':'.modal-content',el.scrollTop]):[];
 const libraryView=preserveScroll?rememberLibraryView():null;
 const listingEditors=[...root.querySelectorAll('.job-card .listing-editor')].map(el=>({job:el.closest('[data-job]').dataset.job,open:el.open}));
 const previousCards=new Map([...root.querySelectorAll('.job-card[data-job]')].map(el=>[el.dataset.job,el]));
 const active=selects.focusedNative()||document.activeElement,apiFocus=active?.dataset.apiField?{field:active.dataset.apiField,start:active.selectionStart,end:active.selectionEnd}:null,focus=restoreFocus&&active?.dataset.scope?{scope:active.dataset.scope,field:active.dataset.field,start:active.selectionStart,end:active.selectionEnd}:null;
 root.innerHTML=appView(state,ui);modalRoot.innerHTML=modalView(state,ui);selects.refresh();
 const nextCards=new Map();for(const el of root.querySelectorAll('.job-card[data-job]')){const id=el.dataset.job,markup=el.outerHTML;nextCards.set(id,markup);if(renderedCards.get(id)===markup&&previousCards.has(id))el.replaceWith(previousCards.get(id));}renderedCards=nextCards;
 for(const saved of listingEditors){const el=root.querySelector(`[data-job="${CSS.escape(saved.job)}"] .listing-editor`);if(el)el.open=saved.open;}
 for(const [selector,top] of positions){const el=document.querySelector(selector);if(el)el.scrollTop=top;}
 if(focus){const el=document.querySelector(`[data-scope="${CSS.escape(focus.scope)}"][data-field="${CSS.escape(focus.field)}"]`);if(el?.tagName==='SELECT')selects.focus(el);else el?.focus({preventScroll:true});if(el&&focus.start!=null)try{el.setSelectionRange(focus.start,focus.end);}catch{}}
 if(apiFocus){const el=document.querySelector(`[data-api-field="${CSS.escape(apiFocus.field)}"]`);el?.focus({preventScroll:true});if(el)el.setSelectionRange(apiFocus.start,apiFocus.end);}
 document.body.dataset.scene=state.preview?'preview':state.view==='history'?'results':document.querySelector('.result-grid')?'results':'empty';
 restoreLibraryView(libraryView);glass.setScene(document.body.dataset.scene);inspectorDepth.refresh();rendering=false;const ready=hydrateImages();syncButtons();return ready;
}
function transitionRender(update,afterRender){
 const change=async()=>{update();await render({preserveScroll:false,restoreFocus:false});window.scrollTo(0,0);afterRender?.();};
 if(document.startViewTransition&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const t=document.startViewTransition(change);return t.updateCallbackDone;}
 return change();
}
async function openPreview(jobId,resultId){
 const j=findJob(jobId),r=j?.results.find(r=>r.id===resultId&&r.assetId);if(!r)return;
 const asset=await getAsset(r.assetId);if(!asset)throw Error('图片读取失败，请从备份恢复后重试。');
 const origin=state.preview?.origin||{view:state.view,scrollTop:document.querySelector('.work-scroll')?.scrollTop||0,windowScroll:window.scrollY,inspectorScroll:document.querySelector('.inspector-scroll')?.scrollTop||0};
 const oldImage=document.querySelector(`.result-image[data-id="${jobId}:${resultId}"] img`);if(oldImage)oldImage.style.viewTransitionName='focused-image';
 closeModal(true);
 await transitionRender(()=>{state.preview={jobId,resultId,origin,metadata:{width:asset.width,height:asset.height,format:(asset.type.split('/')[1]||'PNG').toUpperCase()}};ui.resultInstruction=state.previewDrafts?.[`${jobId}:${resultId}`]||'';markSave();});
 document.querySelector('[data-a="close-preview"]')?.focus({preventScroll:true});
}
async function closePreview(){
 const previous=state.preview;if(!previous)return;
 await transitionRender(()=>{state.preview=null;state.view=previous.origin?.view||state.view;markSave();},()=>{
 const scroller=document.querySelector('.work-scroll');if(scroller)scroller.scrollTop=previous.origin?.scrollTop||0;
 const inspector=document.querySelector('.inspector-scroll');if(inspector)inspector.scrollTop=previous.origin?.inspectorScroll||0;window.scrollTo(0,previous.origin?.windowScroll||0);
 });
 document.querySelector(`.result-image[data-id="${previous.jobId}:${previous.resultId}"]`)?.focus({preventScroll:true});
}
async function movePreview(direction){const context=previewContext(state);if(!context)return;const next=context.results[context.index+Number(direction)];if(next)await openPreview(context.job.id,next.id);}
function rememberLibraryView(){
 const dialog=modalRoot.querySelector('.layout-picker-modal');if(!dialog)return null;
 const active=document.activeElement,button=dialog.contains(active)?active.closest('[data-a]'):null;
 return {gallery:dialog.querySelector('.layout-gallery').scrollTop,selection:dialog.querySelector('.layout-selection-list').scrollTop,focus:button?{action:button.dataset.a,id:button.dataset.id||''}:null};
}
function restoreLibraryView(saved){
 const dialog=modalRoot.querySelector('.layout-picker-modal');if(!dialog||!saved)return;
 if(saved.focus){const target=[...dialog.querySelectorAll('[data-a]')].find(b=>b.dataset.a===saved.focus.action&&(b.dataset.id||'')===saved.focus.id);(target||dialog.querySelector('[data-a="apply-layouts"]'))?.focus({preventScroll:true});}
 dialog.querySelector('.layout-gallery').scrollTop=saved.gallery;dialog.querySelector('.layout-selection-list').scrollTop=saved.selection;
}
let renderedModal=null;
function renderModal(){const same=renderedModal===ui.modal,libraryView=same?rememberLibraryView():null,top=same?modalRoot.querySelector('.modal-content')?.scrollTop:0,expanded=same&&!ui.modal?.resetDetails?[...modalRoot.querySelectorAll('.api-advanced')].map(e=>e.open):null;modalRoot.innerHTML=modalView(state,ui);selects.refresh();hydrateImages(modalRoot);syncButtons();syncResultTools();if(expanded)modalRoot.querySelectorAll('.api-advanced').forEach((e,i)=>e.open=expanded[i]);const content=modalRoot.querySelector('.modal-content');if(content)content.scrollTop=top||0;restoreLibraryView(libraryView);renderedModal=ui.modal;if(ui.modal)ui.modal.resetDetails=false;}
function openModal(m,{replace=false}={}){if(ui.modal&&!replace)ui.stack.push(ui.modal);ui.modal=m;ui.lastFocus=document.activeElement;renderModal();document.querySelector('.modal')?.focus();}
function closeModal(all=false){if(ui.modal?.type==='api-settings'){if(ui.modal.saving)return;if(ui.modal.testing)cancelApiTest(ui.modal.testing);ui.modal.textKey='';ui.modal.imageKey='';}ui.modal=all?null:ui.stack.pop()||null;if(all)ui.stack=[];renderModal();ui.lastFocus?.isConnected&&ui.lastFocus.focus();}
async function openApiSettings(replace=false){
 const m={type:'api-settings',loading:true,textKey:'',imageKey:''};openModal(m,{replace});
 try{m.settings=await api('/api-settings');initSettingsDraft(m);}catch(error){m.error=error.message;}finally{m.loading=false;if(ui.modal===m)renderModal();}
}
async function saveApiSettings(){
 const m=ui.modal;if(m?.type!=='api-settings'||m.saving||m.testing||!m.settings||!settingsChanged(m))return;
 const payload=settingsPayload(m);m.saving=true;m.error='';m.message='';renderModal();
 try{const result=await api('/api-settings',{method:'PUT',body:payload});m.settings=result;initSettingsDraft(m);m.message='配置已保存，下次调用使用当前模型与密钥。';await refreshBackend();}
 catch(error){m.error=error.message;}
 finally{payload.text.key='';payload.image.key='';m.saving=false;if(ui.modal===m)renderModal();}
}
function updateApiField(event){
 const field=event.target.dataset.apiField,m=ui.modal;
 if(m?.type!=='api-settings'||m.saving||m.testing||!field)return;
 const kind=field.startsWith('text')?'text':'image';
 if(field.endsWith('ProviderId')){selectProvider(m,kind,event.target.value);renderModal();return;}
 if(field.endsWith('Preset')){m[kind+'Custom']=event.target.value==='__custom';m[kind+'Model']=m[kind+'Custom']?'':event.target.value;delete m[kind+'Test'];renderModal();return;}
 m[field]=field.endsWith('ReserveCny')?(event.target.value===''?null:Number(event.target.value)):event.target.value;m.error='';m.message='';delete m[kind+'Test'];
 modalRoot.querySelectorAll('.api-test-result').forEach(e=>e.remove());
 const save=modalRoot.querySelector('[data-a="api-settings-save"]');if(save)save.disabled=!settingsChanged(m);
}
document.addEventListener('input',event=>{if(event.target.tagName!=='SELECT')updateApiField(event);});
document.addEventListener('change',event=>{if(event.target.tagName==='SELECT')updateApiField(event);});
async function testApiConnection(kind){
 const m=ui.modal;if(m?.type!=='api-settings'||m.saving||m.testing||!['text','image'].includes(kind))return;
 const body={id:crypto.randomUUID(),kind,revision:m.settings.revision,draft:settingsPayload(m)[kind]};
 m.testing=kind;m[kind+'Test']={id:body.id,state:'running',message:'正在连接…'};m.error='';renderModal();
 try{
  let result=await api('/api-settings/test',{method:'POST',body});body.draft.key='';m[kind+'Test']=result;
  if(ui.modal!==m)await api(`/api-settings/test/${body.id}/cancel`,{method:'POST',body:{}});
  while(result.state==='running'){
   if(ui.modal===m)renderModal();await new Promise(r=>setTimeout(r,900));result=await api(`/api-settings/test/${body.id}`);m[kind+'Test']=result;
  }
 }catch(error){body.draft.key='';m[kind+'Test']={state:'failed',message:error.message};}
 finally{m.testing=null;if(ui.modal===m)renderModal();await refreshBackend();}
}
async function cancelApiTest(kind){const m=ui.modal,id=m?.[kind+'Test']?.id;if(!id)return;try{await api(`/api-settings/test/${id}/cancel`,{method:'POST',body:{}});}catch{} }
function makeProduct(asset,refs=[asset.id]){const p={id:uid(),name:asset.name?.replace(/\.[^.]+$/,'')||'未命名商品',refs,inputVersion:INPUT_VERSION,inputText:'',createdAt:Date.now()};state.products.push(p);return p;}
function chooseFiles(handler,{multiple=false,accept='image/png,image/jpeg,image/webp,image/heic,image/heif'}={}){selectedFileHandler=handler;fileInput.value='';fileInput.multiple=multiple;fileInput.accept=accept;fileInput.click();}
fileInput.addEventListener('change',async()=>{if(!selectedFileHandler)return;try{await selectedFileHandler([...fileInput.files]);}catch(e){toast(e.message);}finally{fileInput.value='';}});
async function importMany(files,options={}){const results=[],errors=[];for(const f of files){try{results.push(await importImage(f,options));}catch(e){errors.push(`${f.name}：${e.message}`);}}if(errors.length)toast(errors.join('\n'));return results;}
async function uploadRefs(files,target){let p;if(target==='kit'){p=product(state.kit.productId);if(!p){p=makeProduct({name:'未命名商品'},[]);state.kit.productId=p.id;}}else{p=product(state.batch.items.find(x=>x.id===target)?.productId);}if(!p)return;if(p.refs.length+files.length>6){toast('同一商品最多上传 6 张图片，请减少所选图片。');return;}const assets=await importMany(files);if(!assets.length)return;if(!p.refs.length&&p.name==='未命名商品')p.name=assets[0].name.replace(/\.[^.]+$/,'');p.refs.push(...assets.map(a=>a.id));await flushSave();render();if(target==='kit'){await saveDraftProduct(p,state.kit);toast('商品及多张参考图已保存到后台。');render();}}
async function addLibrary(files){const assets=await importMany(files,{limit:10});for(const a of assets)state.library.push({id:uid(),type:'layout',assetId:a.id,name:a.name.replace(/\.[^.]+$/,''),group:ui.libraryGroup&&ui.libraryGroup!=='全部'?ui.libraryGroup:'推荐场景',category:'日用百货'});markSave();render();}
function openLibrary(scope='settings'){ui.librarySearch='';ui.libraryGroup='全部';const settings=scopeTarget(scope);openModal({type:'library',scope,selected:[...settings.layouts],limit:settings.counts.selling});}
function newBatchItem(){const p=makeProduct({name:'未命名商品'},[]);const item={id:uid(),productId:p.id,description:'',inputVersion:INPUT_VERSION,override:{},expanded:false,confirmed:false};state.batch.items.push(item);return item;}
function syncButtons(){const p=product(state.kit.productId),err=validateKit(p,state.kit.settings,state.kit.description);document.querySelectorAll('[data-a="generate-kit"]').forEach(b=>b.disabled=!!err||ui.submitting);document.querySelectorAll('[data-a="batch-run"]').forEach(b=>b.disabled=ui.submitting||!state.batch.items.length||state.batch.items.some(i=>!!validateKit(product(i.productId),resolveSettings(state.batch.global,i.override),i.description)));document.querySelectorAll('[data-a="modify-result"]').forEach(b=>{const r=previewContext(state)?.result;b.disabled=ui.correcting||r?.historical||['queued','running'].includes(r?.correction?.state);});document.querySelectorAll('[data-a="batch-confirm"]').forEach(b=>{const i=state.batch.items.find(i=>i.id===b.dataset.id);if(i){b.disabled=false;b.textContent=i.confirmed?'编辑':'确定';}});}
function syncResultTools(){
 const m=ui.modal;if(!m)return;
 document.querySelectorAll('[data-a="confirm-text"]').forEach(b=>b.disabled=ui.correcting||!m.recognition?.regions.some(r=>m.edits?.[r.id]!==r.text));
 document.querySelectorAll('[data-a="confirm-restore"]').forEach(b=>b.disabled=ui.correcting||!m.originalAssetId||m.uploading);
}
function handleBinding(el,final){
 const scope=el.dataset.scope,field=el.dataset.field,target=scope==='text-edit'?ui.modal?.edits:scopeTarget(scope);if(!target)return;
 // Let users finish typing e.g. 10 before enforcing the total and layout limits.
 if(el.type==='number'&&field.startsWith('counts.')&&!final)return;
 let value=el.type==='checkbox'?el.checked:['number','range'].includes(el.type)?Number(el.value):el.value;
 if(['number','range'].includes(el.type)){if(!Number.isFinite(value))return;if(el.min!=='')value=Math.max(Number(el.min),value);if(el.max!=='')value=Math.min(Number(el.max),value);}
 state.languageManual||={};
 if(field==='platform'&&['settings','batchglobal'].includes(scope)){changePlatform(target,value);if(domesticPlatform(value))state.languageManual[scope]=false;}
 else if(field.startsWith('counts.'))setCount(target,field.split('.')[1],value);else set(target,field,value);
 if(field==='language'&&scope!=='ui')state.languageManual[scope]=!!value;
 if(field==='country'&&value&&(!state.languageManual[scope]||scope.startsWith('override:')))target.language=countryLanguage(value);
 if(scope.startsWith('override:')&&field==='platform'&&domesticPlatform(value)){Object.assign(target,{country:'中国',language:'中文'});state.languageManual[scope]=false;}
 if(scope.startsWith('batchitem:')||scope.startsWith('override:'))state.batch.items.find(x=>x.id===scope.split(':')[1]).confirmed=false;
 if(field==='description'){const feedback=el.closest('label')?.querySelector('[data-input-feedback]');if(feedback){feedback.textContent=value.length>INPUT_LIMIT?inputError(value):'';el.setAttribute('aria-invalid',String(value.length>INPUT_LIMIT));el.maxLength=Math.max(INPUT_LIMIT,value.length);}}
 const output=el.closest('.range-field')?.querySelector('output');if(output)output.textContent=el.value+(output.textContent.match(/ms/)?.[0]||'');
 if(scope.startsWith('job:')&&field==='listing'){state.listingDrafts||={};state.listingDrafts[scope.slice(4)]=value;}
 if(scope==='text-edit'){syncResultTools();return;}
 if(scope==='ui'&&field==='assistText'&&ui.modal?.run){state.textDrafts||={};state.textDrafts[ui.modal.run.id]=value;flushSave();}
 if(scope==='ui'&&field==='resultInstruction'&&(state.preview||ui.modal?.type==='ai-edit')){state.previewDrafts[ui.modal?.type==='ai-edit'?ui.modal.id:`${state.preview.jobId}:${state.preview.resultId}`]=value;markSave();}else if(field==='description'&&scope!=='ui'){flushSave();}else if(scope!=='ui')markSave();syncButtons();
 // Text blur must not replace the button receiving the same pointer gesture.
 if(el.type==='number'&&field.startsWith('counts.')){el.value=target.counts[field.split('.')[1]];setTimeout(render,0);return;}
 const liveView=el.type==='number'||scope==='ui'&&['historySearch','librarySearch'].includes(field);
 if(!final&&liveView||final&&(el.tagName==='SELECT'||['checkbox','range'].includes(el.type)))render();
}
document.addEventListener('input',e=>{const el=e.target;if(el.matches('[data-scope]'))handleBinding(el,false);});
document.addEventListener('change',e=>{const el=e.target;if(el.matches('[data-scope]'))handleBinding(el,true);});
async function saveDraftProduct(p,draft){
 const captured={...copy(p),inputVersion:INPUT_VERSION,inputText:draft.description};
 const remote=await saveProduct(captured,getAsset,async()=>{Object.assign(p,{serverId:captured.serverId,serverRefs:captured.serverRefs,serverRevision:captured.serverRevision});await flushSave();});
 p.inputText=captured.inputText;p.serverSavedAt=captured.serverSavedAt;await flushSave();return remote;
}
async function generateKit(){return submitFlow([{...copy(state.kit),settings:copy(state.kit.settings)}],'generate','immediate');}
async function assist(target,id){if(target==='kit')return startTextRun('assist');const item=state.batch.items.find(x=>x.id===id);return submitFlow([{...copy(item),settings:resolveSettings(state.batch.global,item.override)}],'assist','queue');}
async function submitFlow(items,kind,mode,resume=false){
 if(ui.submitting)return;ui.submitting=true;syncButtons();
 try{
  if(state.pendingFlow&&!resume){openModal({type:'pending-flow'});return;}
  if(!state.pendingFlow){
   const prepared=[];
   for(const item of items){const p=product(item.productId),error=validateKit(p,item.settings,item.description);if(error)throw Error(error);const remote=await saveDraftProduct(p,item);prepared.push({productId:remote.id,productRevision:remote.revision,description:item.description,settings:item.settings});}
   state.pendingFlow={key:uid(),body:{items:prepared,kind,mode}};await flushSave();
  }
  const pending=state.pendingFlow,response=await api('/kit-runs',{method:'POST',body:pending.body,headers:{'Idempotency-Key':pending.key}});
  delete state.pendingFlow;await flushSave();await refreshBackend();
  if(pending.body.kind==='assist'){openModal({type:'batch-assistance',batchId:response.runs[0].batchId});}
  else{closeModal(true);state.preview=null;state.view='history';await flushSave();render();}
 }catch(e){if(e.code&&e.status<500){delete state.pendingFlow;await flushSave();}throw e;}
 finally{ui.submitting=false;syncButtons();}
}
function showTextRun(run){
 const m={type:'text-run',run};if(run.kind==='assist'&&run.state==='succeeded'){ui.assistText=state.textDrafts?.[run.id]??run.output.text;m.loadedDraft=true;}
 openModal(m,{replace:['text-run','pending-text'].includes(ui.modal?.type)});
}
async function startTextRun(kind,resume=false){
 if(ui.textSubmitting)return;ui.textSubmitting=true;
 try{
  const draft=state.kit,p=product(draft.productId),pending=draft.pendingTextSubmission;
  if(!resume&&pendingTextChanged(pending,{kind,product:p,description:draft.description,settings:draft.settings})){openModal({type:'pending-text',pending});return;}
  if(!draft.pendingTextSubmission){
   if(!p?.refs.length)throw Error('请先上传图片');
   const description=draft.description,settings=copy(draft.settings),refs=copy(p.refs);if(description.length>INPUT_LIMIT)throw Error(inputError(description));
   const remote=await saveDraftProduct(p,{description});
   // Reopening an unchanged completed plan must not create another paid text request.
   const savedPlan=kind==='plan'&&(state.textRuns||[]).find(r=>r.kind==='plan'&&r.state==='succeeded'&&r.snapshot.productId===remote.id&&r.snapshot.productRevision===remote.revision&&r.snapshot.description===description&&JSON.stringify(r.snapshot.settings)===JSON.stringify(settings)&&(!ui.backend?.text?.templateVersion||(r.snapshot.templateVersion||'mimo-text.1')===ui.backend.text.templateVersion));
   if(savedPlan){showTextRun(await api(`/text-runs/${savedPlan.id}`));return;}
   const previous=reusableUnderstanding(state.textRuns||[],{productId:remote.id,productRevision:remote.revision,description,templateVersion:ui.backend?.text?.templateVersion});
   draft.pendingTextSubmission={key:uid(),refs,body:{kind,productId:remote.id,productRevision:remote.revision,description,settings,...(previous?{understandingRunId:previous.id}:{})}};await flushSave();
  }
  const submission=draft.pendingTextSubmission,response=await api('/text-runs',{method:'POST',headers:{'Idempotency-Key':submission.key},body:submission.body});
  draft.lastTextRunId=response.run.id;delete draft.pendingTextSubmission;await flushSave();showTextRun(response.run);await refreshBackend();
 }catch(error){if(error.code){delete state.kit.pendingTextSubmission;await flushSave();}throw error;}
 finally{ui.textSubmitting=false;}
}

async function downloadResults(j,selected=null){const results=(selected||j.results).filter(r=>r.assetId);if(!results.length)return toast('暂无可下载的结果。');const files=[];for(const r of results){const a=await getAsset(r.assetId);files.push({name:`${safeName(j.name)}/${String(r.index||files.length+1).padStart(2,'0')}-${TYPES[r.type]||'商品图'}.png`,blob:a.blob});}if(j.listing)files.push({name:`${safeName(j.name)}/商品上架文案.txt`,blob:new Blob([listingContent(j.listing).text],{type:'text/plain'})});download(await zip(files),safeName(j.name)+'.zip');toast('下载已开始。');}
async function openQuality(taskId){
 const m={type:'quality',taskId,loading:true};openModal(m,{replace:ui.modal?.type==='quality'});
 try{m.report=await api(`/tasks/${taskId}/quality`);}catch(e){m.error=e.message;}finally{m.loading=false;if(ui.modal===m)renderModal();}
}
async function runQuality(cancel=false){
 const m=ui.modal;if(m?.type!=='quality'||m.busy)return;m.busy=true;renderModal();
 try{m.report=await api(`/tasks/${m.taskId}/quality${cancel?'/cancel':''}`,{method:'POST',body:cancel?{}:{retry:true}});}catch(e){toast(e.message);}finally{m.busy=false;if(ui.modal===m)renderModal();}
}
const actions={
 'quality-open':id=>openQuality(id),
 'quality-run':()=>runQuality(),
 'quality-cancel':()=>runQuality(true),
 'quality-correct':async id=>{const m=ui.modal;if(m?.type!=='quality')return;const j=findJob(m.taskId),r=j?.results.find(r=>r.resultId===id);if(!r)return;const instruction=correctionFromReview(m.report.items.filter(i=>i.resultId===id));await openPreview(j.id,r.id);ui.resultInstruction=instruction;openModal({type:'ai-edit',id:`${j.id}:${r.id}`,expectedVersion:r.version});},

 'view':async id=>{closeModal(true);await transitionRender(()=>{state.preview=null;state.view=['kit','history'].includes(id)?id:'kit';markSave();});},
 'demo':()=>{if(ui.modal?.type==='api-settings'){closeModal(true);}openModal({type:'demo'});},
 'api-settings':()=>openApiSettings(),
 'api-settings-reload':()=>openApiSettings(true),
 'api-key-show':kind=>{if(ui.modal?.type!=='api-settings'||!['text','image'].includes(kind)||ui.modal.saving||ui.modal.testing)return;ui.modal[`${kind}Show`]=!ui.modal[`${kind}Show`];renderModal();},
 'api-key-clear':kind=>{if(ui.modal?.type!=='api-settings'||!['text','image'].includes(kind)||ui.modal.saving||ui.modal.testing)return;ui.modal[`${kind}Clear`]=!ui.modal[`${kind}Clear`];ui.modal[`${kind}Key`]='';ui.modal.error='';ui.modal.message='';renderModal();},
 'api-settings-save':()=>saveApiSettings(),
 'api-test':kind=>testApiConnection(kind),
 'api-test-cancel':kind=>cancelApiTest(kind),
 'save-product':async()=>{const p=product(state.kit.productId);if(p){await saveDraftProduct(p,state.kit);toast('商品资料已保存到后台。');render();}}, 'products':()=>openModal({type:'products'}),
 'library-layout':id=>openLibrary(id),
 'upload-library':()=>chooseFiles(files=>addLibrary(files),{multiple:true}),
 'pick-asset':id=>{const m=ui.modal;if(m?.type!=='library')return;if(m.selected.includes(id))m.selected=m.selected.filter(x=>x!==id);else if(layoutItems(state).some(a=>a.id===id))m.selected.push(id);renderModal();},
 'apply-layouts':async()=>{const m=ui.modal;if(m?.type!=='library')return;const target=scopeTarget(m.scope);Object.assign(target,applyLayoutSelection(target,m.selected,layoutItems(state)));await flushSave();closeModal();render();},
 'remove-layout':id=>{const idx=id.lastIndexOf(':'),scope=id.slice(0,idx),assetId=id.slice(idx+1);const s=scopeTarget(scope);s.layouts=s.layouts.filter(x=>x!==assetId);markSave();render();},
 'delete-asset':id=>{state.library=state.library.filter(a=>a.id!==id);for(const s of [state.kit.settings,state.batch.global])s.layouts=s.layouts.filter(v=>v!==id);if(ui.modal?.selected)ui.modal.selected=ui.modal.selected.filter(v=>v!==id);for(const item of state.batch.items)if(item.override.layouts)item.override.layouts=item.override.layouts.filter(v=>v!==id);markSave();render();},
 'asset-info':id=>openModal({type:'asset-info',id}),
 'product-kit':id=>{const p=product(id);if(ui.modal.batchId){const isolated={...copy(p),id:uid(),refs:[...p.refs],createdAt:Date.now()};delete isolated.serverId;delete isolated.serverRevision;delete isolated.serverSavedAt;delete isolated.aiAssistance;state.products.push(isolated);Object.assign(state.batch.items.find(i=>i.id===ui.modal.batchId),{productId:isolated.id,description:p.inputText,inputVersion:INPUT_VERSION,confirmed:false});closeModal();}else{Object.assign(state.kit,{productId:id,description:p.inputText,inputVersion:INPUT_VERSION});state.preview=null;state.view='kit';closeModal(true);}markSave();render();},
 'upload-refs':id=>chooseFiles(files=>uploadRefs(files,id),{multiple:true}),
 'ref-remove':id=>{const split=id.indexOf(':'),scope=id.slice(0,split),assetId=id.slice(split+1),p=scope==='kit'?product(state.kit.productId):product(state.batch.items.find(x=>x.id===scope)?.productId);if(p)p.refs=p.refs.filter(x=>x!==assetId);markSave();render();},
 'kit-expand':()=>{state.kit.expanded=!state.kit.expanded;markSave();render();},
 'new-kit':()=>{closeModal(true);return transitionRender(()=>{state.preview=null;state.view='kit';state.kit={productId:null,description:'',inputVersion:INPUT_VERSION,settings:defaultSettings(),expanded:false};markSave();});},
 'count':id=>{const [scope,key,diff]=id.split(':');const s=scopeTarget(scope);setCount(s,key,s.counts[key]+Number(diff));markSave();render();},
 'generate-kit':()=>generateKit(),
 'generate-plan':id=>submitSingle(id),'resume-kit':()=>submitSingle(null,true),
 'text-cancel':async id=>{showTextRun(await api(`/text-runs/${id}/cancel`,{method:'POST'}));await refreshBackend();},
 'assist-kit':()=>assist('kit'),'assist-item':id=>assist('item',id),
 'resume-text':()=>startTextRun(ui.modal.pending.body.kind,true),
 'understand-kit':()=>startTextRun('understand'),'plan-kit':()=>startTextRun('plan'),'text-history':()=>openModal({type:'text-history'}),'text-open':async id=>showTextRun(await api(`/text-runs/${id}`)),
 'assist-batch':()=>submitFlow(state.batch.items.map(i=>({...copy(i),settings:resolveSettings(state.batch.global,i.override)})),'assist','queue'),
 'resume-flow':()=>submitFlow([],null,null,true),
 'batch-assistance':()=>openModal({type:'batch-assistance'}),
 'assist-cancel-flow':async id=>{await api(`/kit-runs/${id}/cancel`,{method:'POST'});await refreshBackend();},
 'assist-retry-flow':async id=>{const split=id.lastIndexOf(':'),run=state.kitRuns.find(r=>r.id===id.slice(0,split));await api(`/kit-runs/${run.id}/retry`,{method:'POST',body:{stage:id.slice(split+1),expectedUpdatedAt:run.updatedAt}});await refreshBackend();},
 'assist-open':async id=>{const run=await api(`/text-runs/${id}`);showTextRun(run);ui.modal.batchItemId=state.batch.items.find(i=>product(i.productId)?.serverId===run.snapshot.productId)?.id;renderModal();},
 'assist-apply':async()=>{const run=ui.modal?.run,draft=ui.modal?.batchItemId?state.batch.items.find(i=>i.id===ui.modal.batchItemId):state.kit,p=product(draft?.productId);if(!run||run.kind!=='assist'||run.state!=='succeeded')return;
  if(p?.serverId!==run.snapshot.productId||p.serverRevision!==run.snapshot.productRevision||draft?.description!==run.snapshot.description||JSON.stringify(p.refs.map(id=>id.startsWith('server:')?id.slice(7):p.serverRefs?.[id]))!==JSON.stringify(run.snapshot.references.map(r=>r.assetId)))throw Error('商品、原图或输入内容已改变，请重新帮写；旧结果仍在文字记录中。');
  const current=await api(`/products/${p.serverId}`);if(current.revision!==run.snapshot.productRevision)throw Error('商品在其他页面已改变，请重新读取后帮写。');
  const error=inputError(ui.assistText);if(error)throw Error(error);p.aiAssistance={runId:run.id,text:ui.assistText};draft.description=ui.assistText;await flushSave();await saveDraftProduct(p,draft);closeModal();render();toast('帮写内容已应用到原输入框并保存。');},
 'batch':()=>{if(!state.batch.items.length){state.batch.global=copy(state.kit.settings);newBatchItem();}openModal({type:'batch'});markSave();},
 'batch-add':()=>{if(state.batch.items.length>=50)return toast('最多创建 50 个商品任务。');newBatchItem();markSave();renderModal();},
 'batch-delete':id=>{state.batch.items=state.batch.items.filter(i=>i.id!==id);markSave();renderModal();},
 'batch-confirm':id=>{const item=state.batch.items.find(i=>i.id===id);item.confirmed=!item.confirmed;markSave();renderModal();},
 'batch-override':id=>{const i=state.batch.items.find(i=>i.id===id);i.expanded=!i.expanded;markSave();renderModal();},
 'batch-product':id=>openModal({type:'products',batchId:id}),
 'batch-mode':id=>{state.batch.mode=id;markSave();renderModal();},
 'batch-run':()=>submitFlow(state.batch.items.map(i=>({...copy(i),settings:resolveSettings(state.batch.global,i.override)})),'generate',state.batch.mode),
 'cancel-job':async id=>{const j=findJob(id);if(j.backend){await api(j.flowId?`/kit-runs/${j.flowId}/cancel`:`/tasks/${id}/cancel`,{method:'POST'});await refreshBackend();return;}throw Error('历史演示记录没有后台执行任务。');},
 'retry-flow-stage':async id=>{const split=id.lastIndexOf(':'),j=findJob(id.slice(0,split)),stage=id.slice(split+1);await api(`/kit-runs/${j.flowId}/retry`,{method:'POST',body:{stage,expectedUpdatedAt:j.flowUpdatedAt}});await refreshBackend();},
 'retry-job':async id=>{const j=findJob(id);if(j.backend)return retryRemote(j);throw Error('历史演示记录不能重试生成，请复用配置新建后台任务。');},
 'reframe-result':async id=>{const [jid,rid]=id.split(':');return retryRemote(findJob(jid),rid,true);},
 'retry-result':async id=>{const [jid,rid]=id.split(':'),j=findJob(jid);if(j.backend)return retryRemote(j,rid);throw Error('历史演示记录不能重试生成，请复用配置新建后台任务。');},
 'history-filter':id=>{state.historyFilter=id;markSave();render();},
 'select-result':(id,el)=>{const [jid,rid]=id.split(':');const values=ui.resultSelections[jid]||[];ui.resultSelections[jid]=el.checked?[...new Set([...values,rid])]:values.filter(v=>v!==rid);render();},
 'select-all-results':id=>{const all=findJob(id).results.filter(r=>r.assetId).map(r=>r.id);ui.resultSelections[id]=ui.resultSelections[id]?.length===all.length?[]:all;render();},
 'download-selected':id=>downloadResults(findJob(id),findJob(id).results.filter(r=>ui.resultSelections[id]?.includes(r.id))),
 'download-job':id=>downloadResults(findJob(id)),
 'download-result':id=>{const {result}=selectedResult(id);ui.downloadFormat='jpg';openModal({type:'download-image',assetId:result.assetId,version:result.version||1});},
 'download-format':format=>{ui.downloadFormat=format;renderModal();},
 'download-image':async()=>{const m=ui.modal,format=ui.downloadFormat,a=await getAsset(m.assetId);download(await exportResultImage(a.blob,format),`图片-v${m.version}.${format}`);toast('下载已开始。');},
 'preview-result':id=>openPreview(...id.split(':')),
 'result-nav':id=>movePreview(id),
 'result-version':async id=>{state.preview.version=Number(id);await flushSave();render();},
 'cancel-correction':async id=>{await api(`/tasks/${id}/cancel`,{method:'POST'});await refreshBackend();},
 'close-preview':()=>closePreview(),
 'job-detail':id=>openModal({type:'job',id}),
 'modify-result':id=>modifyResult(id,'modify',ui.resultInstruction),
 'retry-correction':()=>modifyResult(ui.modal.id,ui.modal.pending.body.kind||'modify',ui.modal.pending.body.instruction),
 'ai-edit':id=>{ui.resultInstruction=state.previewDrafts[id]||'';openResultTool('ai-edit',id);},
 'restore-product':id=>openResultTool('restore-product',id),
 'restore-upload':()=>chooseFiles(files=>uploadRestoreOriginal(files),{multiple:false,accept:'image/png,image/jpeg,image/webp'}),
 'confirm-restore':()=>modifyResult(ui.modal.id,'restore','',{originalAssetId:ui.modal.originalAssetId}),
 'edit-text':id=>recognizeResultText(id),
 'recognize-again':()=>recognizeResultText(ui.modal.id,true),
 'confirm-text':()=>{const m=ui.modal;return modifyResult(m.id,'text','',{recognitionId:m.recognition.id,changes:m.recognition.regions.filter(r=>m.edits[r.id]!==r.text).map(r=>({id:r.id,text:m.edits[r.id]}))});},
 'image-editor':id=>{const {result}=selectedResult(id);if(!result.resultId)throw Error('此历史结果尚无后台图片标识');window.open(`/editor.html?result=${encodeURIComponent(result.resultId)}&version=${result.version}`,'_blank','noopener');},
 'unverified-tool':()=>toast('此流程尚待核实，暂未接入。'),
 'reuse-kit':id=>{const j=findJob(id);state.kit={productId:j.productId,description:reuseTaskInput(j),inputVersion:INPUT_VERSION,settings:copy(j.settings),expanded:true};state.preview=null;state.view='kit';closeModal(true);markSave();render();},
 'preview-listing':id=>openModal({type:'listing',id,listing:copy(findJob(id).listing)}),
 'copy-listing':async id=>copyListing(listingContent(findJob(id).listing).text),
 'copy-listing-all':()=>copyListing(listingContent(ui.modal.listing).text),
 'copy-listing-section':index=>copyListing(listingContent(ui.modal.listing).sections[Number(index)].text),
 'save-listing':async id=>saveListing(id),
 'listing-history':async id=>{const value=await api(`/tasks/${id}/listing`);openModal({type:'listing-history',id,versions:value.versions});},
 'listing-use-version':async revision=>{const m=ui.modal,j=findJob(m.id),v=m.versions.find(v=>v.revision===Number(revision));state.listingDrafts||={};state.listingDrafts[j.id]=v.text;j.listing=v.text;await flushSave();closeModal();render();const editor=document.querySelector(`textarea[data-scope="job:${CSS.escape(j.id)}"][data-field="listing"]`);if(editor){editor.closest('details').open=true;editor.focus({preventScroll:true});}toast('历史版本已载入草稿，保存后成为新版本。');},
 'backup':async()=>{await flushSave();download(await exportWorkspace(state),'商图AI-工作区备份.json');toast('备份下载已开始。');},
 'restore':()=>openModal({type:'restore'}),
 'restore-file':()=>chooseFiles(async files=>{const value=recover(await importWorkspace(files[0]));state=value;ui.resultSelections={};ui.resultInstruction=state.preview?state.previewDrafts[`${state.preview.jobId}:${state.preview.resultId}`]||'':'';closeModal(true);markSave();render();toast('工作区已恢复。');},{accept:'.json'}),
 'close-modal':()=>closeModal()
};
function selectedResult(id){const [jid,rid]=id.split(':'),job=findJob(jid),context=previewContext(state);const result=context?.job.id===jid&&context.result.id===rid?context.result:job?.results.find(r=>r.id===rid);if(!result?.assetId)throw Error('找不到图片');return {job,result};}
function openResultTool(type,id,replace=false){const {result}=selectedResult(id);if(result.historical)throw Error('请切回最新版后修改');if(['queued','running'].includes(result.correction?.state))throw Error('本张图片正在修改，请等待或取消当前修改');const pending=state.pendingCorrections?.[result.resultId];openModal({type:pending?'pending-correction':type,id,serverResultId:result.resultId,expectedVersion:result.version,pending},{replace});}
async function recognizeResultText(id,replace=false){
 openResultTool('edit-text',id,replace);const m=ui.modal;if(m.type!=='edit-text')return;m.loading=true;renderModal();
 try{const recognition=await api(`/results/${m.serverResultId}/recognitions`,{method:'POST',body:{expectedVersion:m.expectedVersion}});if(ui.modal!==m)return;m.recognition=recognition;m.edits=Object.fromEntries(recognition.regions.map(r=>[r.id,r.text]));}
 catch(e){if(ui.modal===m)m.error=e.message;}
 finally{if(ui.modal===m){m.loading=false;renderModal();}}
}
async function uploadRestoreOriginal(files){
 const m=ui.modal;if(m?.type!=='restore-product'||!files[0])return;
 m.uploading=true;renderModal();
 try{const a=await importImage(files[0]);const uploaded=await api('/assets',{method:'POST',body:a.blob,headers:{'Content-Type':a.type,'X-Asset-Name':encodeURIComponent(a.name),'X-Asset-Client-Id':a.id}});if(ui.modal===m){m.originalAssetId=uploaded.id;m.originalPreviewId=a.id;}}
 finally{if(ui.modal===m){m.uploading=false;renderModal();}}
}
async function copyListing(text){try{await navigator.clipboard.writeText(text);toast('文案已复制。');}catch{toast('无法访问剪贴板，请选中文字复制。');}}
async function saveListing(id){
 const j=findJob(id),text=listingContent(j.listing).text;
 state.pendingListingSaves||={};const pending=state.pendingListingSaves[id]??={key:uid(),body:{text,expectedRevision:j.listingRevision??0}};await flushSave();
 try{const saved=await api(`/tasks/${id}/listing`,{method:'POST',headers:{'Idempotency-Key':pending.key},body:pending.body});delete state.pendingListingSaves[id];j.listingRevision=saved.revision;
  if(state.listingDrafts?.[id]===saved.text)delete state.listingDrafts[id];await flushSave();await refreshBackend();toast(`文案版本 ${saved.revision} 已保存。`);
 }catch(e){if(e.code&&e.status<500){delete state.pendingListingSaves[id];await flushSave();}throw e;}
}
async function modifyResult(id,kind,instruction,extra={}){
 if(ui.correcting)return;const [jid,rid]=id.split(':'),j=findJob(jid),r=j?.results.find(r=>r.id===rid);
 if(!j?.backend||!r?.resultId)throw Error('请选择后台生成的图片。');
 ui.correcting=true;syncButtons();syncResultTools();
 try{
  state.pendingCorrections||={};
  const pending=state.pendingCorrections[r.resultId]??={key:uid(),body:{expectedVersion:ui.modal?.expectedVersion??r.version,kind,instruction,...extra}};
  await flushSave();
  await api(`/results/${r.resultId}/corrections`,{method:'POST',headers:{'Idempotency-Key':pending.key},body:pending.body});
  delete state.pendingCorrections[r.resultId];if(state.preview)delete state.preview.version;
  closeModal(true);await flushSave();await refreshBackend();toast('单张修改已提交，旧版保留，其他图片不变。');
 }catch(e){if(e.code&&(e.status<500||e.code==='PROVIDER_NOT_READY')){delete state.pendingCorrections[r.resultId];await flushSave();}throw e;}
 finally{ui.correcting=false;syncButtons();syncResultTools();}
}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-a]');if(!b||b.disabled)return;const action=actions[b.dataset.a];if(!action)return;try{await action(b.dataset.id,b);}catch(error){console.error(error);toast(error.message||'操作失败，请重试。');}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&ui.modal){e.preventDefault();closeModal();return;}if(state?.preview&&!ui.modal&&!e.target.closest('input,textarea,select,[contenteditable]')){if(e.key==='Escape'){e.preventDefault();closePreview();return;}if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();movePreview(e.key==='ArrowLeft'?-1:1);return;}}if(e.key==='Tab'&&ui.modal){const elements=[...modalRoot.querySelectorAll('button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]')].filter(el=>el.offsetParent!==null);const first=elements[0],last=elements.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement.classList.contains('modal'))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}return;}});
async function handleDrop(files,target){if(target?.startsWith('refs:'))return uploadRefs(files,target.slice(5));if(state.view==='kit'&&!state.preview&&!ui.modal)return uploadRefs(files,'kit');toast('请在商品原图区域上传图片。');}
document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();e.target.closest('[data-drop]')?.classList.add('drag-over');}});
document.addEventListener('dragleave',e=>e.target.closest('[data-drop]')?.classList.remove('drag-over'));
document.addEventListener('drop',async e=>{if(!e.dataTransfer.files.length)return;e.preventDefault();document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));try{await handleDrop([...e.dataTransfer.files],e.target.closest('[data-drop]')?.dataset.drop);}catch(err){toast(err.message);}});
document.addEventListener('paste',async e=>{const files=[...e.clipboardData.items].filter(i=>i.kind==='file').map(i=>i.getAsFile());if(!files.length)return;e.preventDefault();try{await handleDrop(files,e.target.closest('[data-drop]')?.dataset.drop);}catch(err){toast(err.message);}});

let polling=false,remoteSignature='';
async function refreshBackend(){
 if(polling||!state)return;polling=true;
 try{
  const previousConnection=ui.connection,health=await api('/health');ui.backend=health;ui.connection=health.mode==='TEST_ONLY'?'测试处理器联调 · 非真实生成':health.modelCallsPaused?'模型调用已暂停 · 历史可查看与下载':health.ready?`后台已连接 · ${health.model}`:'后台已连接 · 真实生成待配置';
  const [{tasks},{products},{runs},{runs:kitRuns},{edits}]=await Promise.all([api('/tasks'),api('/products'),api('/text-runs'),api('/kit-runs'),api('/listing-edits').catch(e=>{if(e.status===404)return {edits:[]};throw e;})]);
  state.textRuns=runs;
  if(ui.modal?.type==='text-run'&&ui.modal.run?.state==='running'){
   const m=ui.modal,run=await api(`/text-runs/${m.run.id}`);if(ui.modal===m){m.run=run;if(run.kind==='assist'&&run.state==='succeeded'&&!m.loadedDraft){ui.assistText=state.textDrafts?.[run.id]??run.output.text;m.loadedDraft=true;}}
  }
  if(ui.modal?.type==='quality'&&!ui.modal.loading&&!ui.modal.busy){const m=ui.modal,report=await api(`/tasks/${m.taskId}/quality`);if(ui.modal===m&&JSON.stringify(report)!==JSON.stringify(m.report)){m.report=report;renderModal();}}
  const signature=JSON.stringify([health,tasks,products,runs,kitRuns,edits]);
  if(signature!==remoteSignature||previousConnection!==ui.connection){mergeRemote(state,tasks,products);mergeKitRuns(state,kitRuns,health.mode);for(const edit of edits){const j=findJob(edit.taskId);if(j){j.listingRevision=edit.revision;j.listing=state.listingDrafts?.[edit.taskId]??edit.text;}}remoteSignature=signature;await flushSave();render();}
 }catch{if(ui.connection!=='后台连接中断 · 保留已保存内容'){ui.connection='后台连接中断 · 保留已保存内容';render();}}
 finally{polling=false;}
}
async function submitSingle(planRunId,resume=false){
 if(ui.submitting)return;ui.submitting=true;syncButtons();
 const draft=state.kit;
 try{
  const p=product(draft.productId),settings=copy(draft.settings),description=draft.description;
  if(draft.pendingSubmission&&!resume&&draft.pendingSubmission.body.planRunId!==planRunId){openModal({type:'pending-kit',pending:draft.pendingSubmission});return;}
  if(!draft.pendingSubmission){
   const error=validateKit(p,settings,description);if(error)throw Error(error);
   const run=await api(`/text-runs/${planRunId}`),s=run.snapshot;
   const refs=p.refs.map(id=>id.startsWith('server:')?id.slice(7):p.serverRefs?.[id]);
   if(run.kind!=='plan'||run.state!=='succeeded'||s.productId!==p.serverId||s.productRevision!==p.serverRevision||s.description!==description||JSON.stringify(s.settings)!==JSON.stringify(settings)||JSON.stringify(s.references.map(r=>r.assetId))!==JSON.stringify(refs))throw Error('当前商品或设置与这份规划不同，请返回当前商品重新规划。旧规划仍保留。');
   draft.pendingSubmission={key:uid(),body:{productId:s.productId,productRevision:s.productRevision,settings:s.settings,description:s.description,planRunId}};await flushSave();
  }
  const pending=draft.pendingSubmission;
  const response=await api('/kits',{method:'POST',headers:{'Idempotency-Key':pending.key},body:pending.body});
  const local=state.products.find(p=>p.serverId===response.task.productId||p.id===response.task.productId);
  const j=projectTask(response.task,local?.id);if(!state.jobs.some(x=>x.id===j.id))state.jobs.unshift(j);
  delete draft.pendingSubmission;closeModal(true);state.preview=null;state.view='history';await flushSave();render();await refreshBackend();
 }catch(error){if(error.code&&(error.status<500||['MODEL_CALLS_PAUSED','PROVIDER_NOT_READY'].includes(error.code))){delete draft.pendingSubmission;await flushSave();}throw error;}
 finally{ui.submitting=false;syncButtons();}
}
async function retryRemote(j,rid,regenerateBase=false){
 const targets=j.results.filter(r=>(!rid||r.id===rid)&&r.retryable).map(r=>r.id);
 if(!targets.length)throw Error('没有可重试的失败图片。成功图片保持原版本，未知请求需先核对。');
 if(targets.length>1)throw Error('请在失败图片旁点击“重试此图”，每次只重试一张。');
 await api(`/tasks/${j.id}/retry`,{method:'POST',body:{expectedRevision:j.revision,childIds:targets,...(regenerateBase?{regenerateBase:true}:{})}});await refreshBackend();
}

window.addEventListener('visibilitychange',()=>{if(document.hidden&&state)flushSave();});
try{await openDB();state=recover(await loadState()||freshState());if(state.preview)ui.resultInstruction=state.previewDrafts[`${state.preview.jobId}:${state.preview.resultId}`]||'';await flushSave();render();await refreshBackend();setInterval(refreshBackend,1500);}catch(error){root.innerHTML='<div class="boot">无法打开本地存储。请允许浏览器保存网站数据后刷新。</div>';console.error(error);}
