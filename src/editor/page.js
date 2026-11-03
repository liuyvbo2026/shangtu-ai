import {importGeneratedLayers} from './generated-layers.js';
import * as core from './core.js';
import {renderScene,exportPNG} from './render.js';
import * as store from './storage.js';
import {download,safeName} from '../export.js';
import {initGlass} from '../glass.js';
import {exportResultImage} from '../result-tools.js';
import {api} from '../integration-client.js';
import {publishToKit} from './publish.js';
import {getAsset as sourceAsset} from '../storage.js';
import {initSelects,initInspectorDepth} from '../controls.js';

const $ = id => document.getElementById(id);
for(const [id,label] of Object.entries({documents:'已保存文档',zoom:'画布缩放',fontFamily:'字体',fontWeight:'字重',align:'对齐',versions:'历史版本'})){
 const select=$(id);select.dataset.scope='editor';select.dataset.field=id;select.setAttribute('aria-label',label);
}
const selects=initSelects(),depth=initInspectorDepth({headingSelector:'.editor-inspector .inspector-heading',scrollSelector:'.editor-properties',breakpoint:'(max-width:850px)'});
let session = null, etag = null, selectedId = null, selection = null, selectingRegion = false, busy = false, drawId = 0, gesture = null, uploadMode = 'new', evidence = null;
let operations = Promise.resolve(), pending = 0;
let inputTimer; const pendingInputs = new Map();
const assets = new Map(), resolveAsset = async id => {if (!assets.has(id)) assets.set(id,await store.getAsset(id)); return assets.get(id);};
const selected = () => session && core.currentScene(session).layers.find(l => l.id === selectedId);
const glass = initGlass($('glass-surface')); glass.setScene('results');
function status(message,error = false) {$('status').textContent = message; $('status').dataset.error = String(error);}
function run(fn) {
  // Queue a toolbar click behind a field's blur/change save; never silently drop it.
  pending++; busy = true; document.body.dataset.busy = 'true';
  operations = operations.then(async () => {
    try {await fn();} catch(e) {status(e.message,true);}
    finally {pending--; busy = pending > 0; document.body.dataset.busy = String(busy);}
  });
  return operations;
}
async function documents() {
  const items = await store.listDocuments();
  $('documents').replaceChildren(new Option('选择本地文档',''),...items.filter(x => !x.name.startsWith('[05A 自动验证]')).map(x => new Option(x.name,x.id)));
  if (session) $('documents').value = session.documentId;
  selects.refresh();
}
function fit() {
  if (!session) return;
  const s = core.currentScene(session), stage = $('stage'), scale = Math.min((stage.clientWidth-48)/s.width,(stage.clientHeight-48)/s.height,1)*Number($('zoom').value);
  $('frame').style.width = `${Math.max(1,s.width*scale)}px`; $('frame').style.height = `${Math.max(1,s.height*scale)}px`;
}
function showRect(element,r) {
  element.hidden = !r; if (!r || !session) return;
  const s = core.currentScene(session);
  Object.assign(element.style,{left:`${r.x/s.width*100}%`,top:`${r.y/s.height*100}%`,width:`${r.width/s.width*100}%`,height:`${r.height/s.height*100}%`});
}
async function paint(scene = session && core.currentScene(session)) {
  if (!scene) return; const token = ++drawId;
  const c = await renderScene(scene,resolveAsset); if (token !== drawId) return;
  c.id = 'artwork'; c.setAttribute('aria-label','当前编辑画面'); $('artwork').replaceWith(c);
}
async function regionInfo() {
  const l = selected(); showRect($('region'),selection);
  if (!selection) {$('region-info').textContent = '尚未框选'; return;}
  const mapping = l?.type === 'image' ? core.selectionToSource(selection,l,await resolveAsset(l.assetId)) : null;
  const format = r => `${Math.round(r.x)}, ${Math.round(r.y)} · ${Math.round(r.width)} × ${Math.round(r.height)} px`;
  $('region-info').textContent = `画布  ${format(selection)}\n${mapping ? `源图  ${format(mapping.rect)}\n归一化  ${Object.values(mapping.normalized).map(v=>v.toFixed(4)).join(', ')}` : '请选择与选区相交的图片图层查看源图坐标'}`;
}
function properties() {
  const l = selected(); $('properties').disabled = !l || l.locked;
  $('locked').disabled = !l; $('visible').disabled = !l || l.locked;
  $('locked').checked = !!l?.locked; $('visible').checked = !!l?.visible;
  $('text-properties').hidden = l?.type !== 'text'; $('replace-image').hidden = l?.type !== 'image';
  const set = (key,value) => {if (document.activeElement !== $(key) && selects.focusedNative() !== $(key)) $(key).value = value;};
  for (const k of ['x','y','width','height','opacity']) set(k,l?.[k] ?? '');
  set('layer-name',l?.name || '');
  if (l?.type === 'text') {set('text',l.text); for (const [k,v] of Object.entries(l.style)) {if (k === 'italic') $(k).checked = v; else set(k,v);} }
  const scene = session && core.currentScene(session), index = scene?.layers.findIndex(x => x.id === selectedId);
  $('up').disabled = !l || index === scene.layers.length-1; $('down').disabled = !l || index === 0;
  showRect($('selection'),l?.visible && !selectingRegion ? l : null);
  selects.refresh();
}
async function refresh() {
  $('save-to-kit').hidden=session?.source.kind!=='kit-result';
  $('save-to-kit').disabled=!session;
  for(const k of ['export-jpg','export-psd'])if($(k))$(k).disabled=!session;
  const has = !!session, s = has && core.currentScene(session);
  $('empty').hidden = has; $('frame').hidden = !has;
  for (const k of ['add-text','add-image','save','original','export-png','export-bundle','restore','region-mode','clear-region']) $(k).disabled = !has;
  $('undo').disabled = !session?.undo.length; $('redo').disabled = !session?.redo.length; $('cancel').disabled = !has || !core.isDirty(session);
  $('dirty').textContent = !has ? '未打开' : core.isDirty(session) ? '未保存修改' : '已保存版本';
  $('document-info').textContent = !has ? '尚未打开图片' : `${session.name} · ${s.width} × ${s.height} · ${s.layers.length} 个图层`;
  $('layers').replaceChildren();
  if (has) for (const l of [...s.layers].reverse()) {
    const li = document.createElement('li'), b = document.createElement('button'), text = document.createElement('span'), meta = document.createElement('small');
    b.dataset.layerId = l.id; b.setAttribute('aria-pressed',String(l.id === selectedId)); text.textContent = l.name;
    meta.textContent = `${l.type === 'text' ? '文字' : '图片'}${l.locked ? ' · 锁定' : ''}${!l.visible ? ' · 隐藏' : ''}`;
    b.append(text,meta); li.append(b); $('layers').append(li);
  }
  $('versions').replaceChildren(...(session?.versions || []).map((v,i) => new Option(`${String(i).padStart(2,'0')} · ${v.label}${v.id === session.savedVersionId ? ' · 已保存' : ''}`,v.id)));
  if (has) $('versions').value = session.currentVersionId;
  properties(); depth.refresh(); fit(); await paint(); await regionInfo();
}
async function setDocument(record) {
  session = record.session; etag = record.etag; selectedId = null; selection = null;
  history.replaceState(null,'',`?document=${encodeURIComponent(session.documentId)}`);
  await documents(); await refresh();
}
async function mutate(next,newAssets = [],message = '草稿已自动保留') {
  if (next === session) return;
  newAssets.forEach(a => assets.set(a.id,a));
  // Keep the new working state on a failed save, available for portable export.
  const previousSaved = session?.savedVersionId;
  try {
    const record = await store.persistDocument(next,{expectedEtag:etag,assets:newAssets});
    session = record.session; etag = record.etag;
    history.replaceState(null,'',`?document=${encodeURIComponent(session.documentId)}`);
    await documents(); status(message);
  } catch(e) {session = core.clone(next); if (previousSaved) session.savedVersionId = previousSaved; status(`${e.message}；当前修改仍在内存，可导出编辑包`,true);}
  await refresh();
}
async function newDocument(asset,name) {
  assets.set(asset.id,asset); const record = await store.persistDocument(core.createSession(asset,{name,source:{kind:document.getElementById('verify')?'standalone-validation':'standalone-image'}}),{assets:[asset]});
  await setDocument(record); status('独立文档已建立，原始图片已保留');
}
function action(id,fn) {$(id)?.addEventListener('click',() => {gesture = null; flushInputs(); run(fn);});}
action('new-demo',async () => {const {fixtureAsset}=await import('../../tests/editor/fixtures.js');return newDocument(await fixtureAsset(),'05A 图层验证样张');});
action('new-image',() => {uploadMode = 'new'; $('image-file').click();});
action('add-image',() => {uploadMode = 'add'; $('image-file').click();});
action('replace-image',() => {uploadMode = 'replace'; $('image-file').click();});
$('image-file').addEventListener('change',() => run(async () => {
  const file = $('image-file').files[0]; $('image-file').value = ''; if (!file) return;
  const a = await store.createAsset(file,file.name);
  if (uploadMode === 'new') return newDocument(a,file.name);
  if (uploadMode === 'replace') return mutate(core.updateLayer(session,selectedId,{assetId:a.id,sourceRect:{x:0,y:0,width:a.width,height:a.height}}),[a]);
  const s = core.currentScene(session), ratio = Math.min(1,s.width*.6/a.width,s.height*.6/a.height);
  const l = core.imageLayer(a,{name:file.name,x:40,y:40,width:a.width*ratio,height:a.height*ratio}); selectedId = l.id;
  await mutate(core.addLayer(session,l),[a]);
}));
action('import',() => $('bundle-file').click());
$('bundle-file').addEventListener('change',() => run(async () => {const f = $('bundle-file').files[0]; $('bundle-file').value = ''; if (f) {await setDocument(await store.importBundle(f)); status('编辑包已作为独立副本导入');}}));
action('reopen',async () => {const id = $('documents').value; if (!id) throw Error('请先选择本地文档'); const record = await store.loadDocument(id); if (!record) throw Error('找不到文档'); await setDocument(record); status('已从本地存储重新载入');});
action('add-text',async () => {const s = core.currentScene(session), l = core.textLayer({x:Math.round(s.width*.06),y:Math.round(s.height*.08),width:Math.round(s.width*.8),height:Math.round(s.height*.2),style:{fontSize:Math.max(12,Math.round(s.width*.045))}}); selectedId = l.id; await mutate(core.addLayer(session,l));});
for (const [key,fn] of Object.entries({undo:core.undo,redo:core.redo,cancel:core.cancelChanges})) action(key,() => mutate(fn(session)));
action('original',() => mutate(core.restoreVersion(session,session.originalVersionId)));
action('restore',() => mutate(core.restoreVersion(session,$('versions').value)));
action('save',() => mutate(core.markSaved(session),[],'版本已保存，可重新打开恢复'));
action('save-to-kit',async()=>{
 const saved=await publishToKit(session,()=>exportPNG(core.currentScene(session),resolveAsset),api);
 await mutate(core.markSaved(session));
 status(`已保存到套图 v${saved.version}，原图及历史版本保留`);
});
action('export-png',async () => {const snapshot = core.currentScene(session); download(await exportPNG(snapshot,resolveAsset),`${safeName(session.name)}-${session.currentVersionId.slice(0,8)}.png`); status('PNG 已导出，画布尺寸与当前版本一致');});
for(const format of ['jpg','psd'])action('export-'+format,async()=>download(await exportResultImage(await exportPNG(core.currentScene(session),resolveAsset),format),`${safeName(session.name)}-${session.currentVersionId.slice(0,8)}.${format}`));
action('export-bundle',async () => download(await store.exportBundle(session,resolveAsset),`${safeName(session.name)}.editor.json`));
action('delete',() => mutate(core.removeLayer(session,selectedId)));
for (const [key,delta] of [['up',1],['down',-1]]) action(key,() => mutate(core.moveLayer(session,selectedId,core.currentScene(session).layers.findIndex(l => l.id === selectedId)+delta)));
action('deselect',async () => {selectedId = null; await refresh();});
$('layers').addEventListener('click',e => {const b = e.target.closest('[data-layer-id]'); if (b) {flushInputs(); run(async () => {selectedId = b.dataset.layerId; await refresh();});}});
const fields = ['x','y','width','height','opacity','layer-name','text','visible','locked','fontFamily','fontSize','fontWeight','color','align','lineHeight','italic'];
const numeric = ['x','y','width','height','opacity','fontSize','fontWeight','lineHeight'];
function captureInput(key) {
  if (!selected()) return; const layerId = selectedId;
  const input = $(key), value = input.type === 'checkbox' ? input.checked : numeric.includes(key) ? Number(input.value) : input.value;
  const style = ['fontFamily','fontSize','fontWeight','color','align','lineHeight','italic'].includes(key);
  const previous = pendingInputs.get(layerId) || {};
  pendingInputs.set(layerId,style ? {...previous,style:{...previous.style,[key]:value}} : {...previous,[key === 'layer-name' ? 'name' : key]:value});
}
function flushInputs() {
  clearTimeout(inputTimer); const edits = [...pendingInputs]; pendingInputs.clear();
  for (const [layerId,patch] of edits) run(async () => {
    try {await mutate(core.updateLayer(session,layerId,patch));} finally {properties();}
  });
}
for (const key of fields) {
  $(key).addEventListener('input',() => {captureInput(key); clearTimeout(inputTimer); inputTimer = setTimeout(flushInputs,350);});
  $(key).addEventListener('change',() => {captureInput(key); flushInputs();});
}
$('zoom').addEventListener('change',fit); new ResizeObserver(fit).observe($('stage'));
action('region-mode',async () => {selectingRegion = !selectingRegion; $('region-mode').setAttribute('aria-pressed',String(selectingRegion)); $('region-mode').textContent = selectingRegion ? '结束框选' : '框选区域'; $('frame').style.cursor = selectingRegion ? 'crosshair' : ''; properties();});
action('clear-region',async () => {selection = null; await regionInfo();});
const point = e => core.clientToDocument({x:e.clientX,y:e.clientY},$('frame').getBoundingClientRect(),core.currentScene(session));
$('frame').addEventListener('pointerdown',e => {
  if (pendingInputs.size) {flushInputs(); return;}
  if (busy || !session || e.button !== 0) return; e.preventDefault(); $('stage').focus();
  const p = point(e), s = core.currentScene(session), handle = e.target.id === 'resize-handle';
  if (selectingRegion) gesture = {kind:'region',start:p};
  else {
    const l = handle ? selected() : core.hitTest(s,p); selectedId = l?.id || null; properties();
    for (const b of $('layers').querySelectorAll('button')) b.setAttribute('aria-pressed',String(b.dataset.layerId === selectedId));
    if (l && !l.locked) gesture = {kind:handle ? 'resize' : 'move',start:p,layer:core.clone(l),scene:s};
  }
  if (gesture) $('frame').setPointerCapture(e.pointerId);
});
$('frame').addEventListener('pointermove',e => {
  if (!gesture) return; const p = point(e), g = gesture;
  if (g.kind === 'region') {selection = core.selectionRect(g.start,p); void regionInfo(); return;}
  const scene = core.clone(g.scene), l = scene.layers.find(l => l.id === g.layer.id);
  if (g.kind === 'move') {l.x = Math.round(g.layer.x+p.x-g.start.x); l.y = Math.round(g.layer.y+p.y-g.start.y);}
  else {l.width = Math.max(1,Math.round(g.layer.width+p.x-g.start.x)); l.height = Math.max(1,Math.round(g.layer.height+p.y-g.start.y));}
  g.preview = scene; showRect($('selection'),l); void paint(scene).catch(e=>status(e.message,true));
});
$('frame').addEventListener('pointerup',() => {const g = gesture; gesture = null; if (g?.preview) run(() => mutate(core.commit(session,g.preview,g.kind === 'move' ? '拖动位置' : '拖动大小')));});
$('frame').addEventListener('pointercancel',() => {gesture = null; void refresh();});
document.addEventListener('keydown',e => {
  if (!session || busy || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.isComposing) return;
  const modifier = e.metaKey || e.ctrlKey;
  if (modifier && ['z','y','s'].includes(e.key.toLowerCase())) {e.preventDefault(); gesture = null; const k = e.key.toLowerCase(); run(() => mutate(k === 's' ? core.markSaved(session) : k === 'y' || e.shiftKey ? core.redo(session) : core.undo(session))); return;}
  if (e.key === 'Escape') {gesture = null; selectedId = null; selection = null; void refresh();}
  const l = selected(), offsets = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}, offset = offsets[e.key];
  if (offset && l && !l.locked) {e.preventDefault(); const n = e.shiftKey ? 10 : 1; run(() => mutate(core.updateLayer(session,l.id,{x:l.x+offset[0]*n,y:l.y+offset[1]*n})));}
});
window.addEventListener('beforeunload',e => {if (busy || pendingInputs.size || $('status').dataset.error === 'true') {e.preventDefault(); e.returnValue = '';}});
action('verify',async () => {
  $('test-result').textContent = '正在比较真实画布像素与 PNG 文件…'; $('evidence').disabled = true; evidence = null;
  const {runVerification}=await import('../../tests/editor/browser-suite.js');
  const result = await runVerification(); evidence = result.bundle; $('evidence').disabled = false;
  $('test-result').textContent = `${result.report.passed}/${result.report.expectedChecks} 项通过\n${result.report.checks.map(c => `${c.ok ? '✓' : '×'} ${c.name}`).join('\n')}${result.report.failure ? `\n失败：${result.report.failure}` : ''}`;
  $('test-result').dataset.passed = String(result.report.passed); window.editorVerification = result.report;
  status(result.report.ok ? '内核验证通过，测试证据可下载' : '验证存在失败项，请查看证据',!result.report.ok);
});
action('evidence',() => download(evidence,'05a-editor-evidence.zip'));
async function openKitResult(params){
 const resultId=params.get('result'),result=await api('/results/'+encodeURIComponent(resultId));
 const version=params.has('version')?Number(params.get('version')):result.versions.at(-1).version;
 const selected=result.versions.find(v=>v.version===version);if(!selected)throw Error('找不到指定的结果版本');
 for(const item of await store.listDocuments()){
  const record=await store.loadDocument(item.id);
  if(record.session.source.kind==='kit-result'&&record.session.source.resultId===resultId&&record.session.source.resultVersion===version){await setDocument(record);status('已恢复此版本的独立编辑草稿');return;}
 }
 const original=await sourceAsset('server:'+selected.assetId);if(!original)throw Error('结果图片无法读取');
 const asset=await store.createAsset(original.blob,original.name);assets.set(asset.id,asset);
 let session=core.createSession(asset,{name:`套图图片-v${version}`,source:{kind:'kit-result',resultId,resultVersion:version,serverAssetId:selected.assetId,taskId:result.taskId}});
 const info=await api(`/results/${encodeURIComponent(resultId)}/layers/${version}`),newAssets=[asset];
 if(info.available){const originalBase=await sourceAsset('server:'+info.baseAssetId);if(!originalBase)throw Error('原始底图无法读取');const base=await store.createAsset(originalBase.blob,originalBase.name);assets.set(base.id,base);newAssets.push(base);session=core.markSaved(importGeneratedLayers(session,base,info));}
 await setDocument(await store.persistDocument(session,{assets:newAssets}));status(info.available?'已载入商品底图与可编辑文字，原始成图保留在版本中':'当前图片已在独立编辑文档中打开');
}
await run(async () => {await documents();const params=new URL(location.href).searchParams,id=params.get('document');if(id){const record=await store.loadDocument(id);if(!record)throw Error('此浏览器中找不到该文档');await setDocument(record);}else if(params.get('result'))await openKitResult(params);else await refresh();});
