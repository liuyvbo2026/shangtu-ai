// Framework-free editor model. Coordinates are document pixels, layers bottom → top.
export const SCHEMA_VERSION = 1;
export const FONT_FAMILIES = ['system', 'serif', 'mono'];
export const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = () => crypto.randomUUID();
function check(ok, message) { if (!ok) throw Error(message); }
function finite(v, min, max) { return Number.isFinite(v) && v >= min && v <= max; }
function string(v, max = 200) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function rect(r) { return r && finite(r.x, -32768, 32768) && finite(r.y, -32768, 32768) && finite(r.width, 1, 16384) && finite(r.height, 1, 16384); }
export function validateScene(scene) {
  check(scene && Number.isInteger(scene.width) && Number.isInteger(scene.height) && finite(scene.width, 1, 8192) && finite(scene.height, 1, 8192) && scene.width * scene.height <= 40_000_000, '画布尺寸无效或超过 4000 万像素');
  check(/^#[\da-f]{6}$/i.test(scene.background), '画布背景颜色无效');
  check(Array.isArray(scene.layers) && scene.layers.length <= 128, '最多支持 128 个图层');
  const ids = new Set();
  for (const l of scene.layers) {
    check(l && string(l.id) && !ids.has(l.id) && string(l.name) && rect(l), '图层标识、名称或尺寸无效'); ids.add(l.id);
    check(['image', 'text'].includes(l.type) && typeof l.visible === 'boolean' && typeof l.locked === 'boolean' && finite(l.opacity, 0, 1), '图层类型或状态无效');
    if (l.type === 'image') {
      check(string(l.assetId) && rect(l.sourceRect) && l.sourceRect.x >= 0 && l.sourceRect.y >= 0, '图片资产或裁剪坐标无效');
    } else {
      check(typeof l.text === 'string' && l.text.length <= 10000, '文字内容过长');
      const s = l.style;
      check(s && FONT_FAMILIES.includes(s.fontFamily) && finite(s.fontSize, 1, 1024) && [400, 500, 600, 700].includes(s.fontWeight) && typeof s.italic === 'boolean' && /^#[\da-f]{6}$/i.test(s.color) && ['left', 'center', 'right'].includes(s.align) && finite(s.lineHeight, 1, 3), '文字样式无效');
    }
  }
  return scene;
}
export function imageLayer(asset, options = {}) {
  return {id:id(), type:'image', name:'图片图层', x:0, y:0, width:asset.width, height:asset.height, visible:true, locked:false, opacity:1, assetId:asset.id, sourceRect:{x:0,y:0,width:asset.width,height:asset.height}, ...options};
}
export function textLayer(options = {}) {
  return {id:id(), type:'text', name:'文字图层', x:40, y:40, width:400, height:120, visible:true, locked:false, opacity:1, text:'输入文字', ...options, style:{fontFamily:'system',fontSize:40,fontWeight:600,italic:false,color:'#222326',align:'left',lineHeight:1.3,...options.style}};
}
export function createSession(asset, {name = '未命名编辑', source = {}} = {}) {
  const root = {id:id(), parentId:null, createdAt:Date.now(), label:'原始结果', restoredFrom:null, scene:{width:asset.width,height:asset.height,background:'#ffffff',layers:[imageLayer(asset, {name:'原始结果',locked:true})]}};
  const session = {schemaVersion:SCHEMA_VERSION, documentId:id(), name, source:{...clone(source),assetId:asset.id,width:asset.width,height:asset.height}, originalVersionId:root.id, savedVersionId:root.id, currentVersionId:root.id, versions:[root], undo:[], redo:[]};
  validateSession(session); return session;
}
export function validateSession(s) {
  check(s && s.schemaVersion === SCHEMA_VERSION && string(s.documentId) && string(s.name), '不支持的编辑文档');
  check(s.source && string(s.source.assetId) && Number.isInteger(s.source.width) && Number.isInteger(s.source.height), '缺少原始资产来源');
  check(Array.isArray(s.versions) && s.versions.length > 0 && s.versions.length <= 2000, '编辑版本数量无效（上限 2000）');
  const ids = new Set();
  for (const [i, v] of s.versions.entries()) {
    check(v && string(v.id) && !ids.has(v.id) && string(v.label) && finite(v.createdAt, 0, Number.MAX_SAFE_INTEGER), '编辑版本元数据无效');
    check(i === 0 ? v.parentId === null && v.restoredFrom === null : ids.has(v.parentId) && (v.restoredFrom === null || ids.has(v.restoredFrom)), '版本引用无效');
    validateScene(v.scene); ids.add(v.id);
    check(v.scene.width === s.source.width && v.scene.height === s.source.height, '版本画布与原始结果尺寸不一致');
  }
  check(s.originalVersionId === s.versions[0].id && ids.has(s.savedVersionId) && ids.has(s.currentVersionId), '版本指针无效');
  const original = s.versions[0].scene.layers;
  check(original.length === 1 && original[0].type === 'image' && original[0].assetId === s.source.assetId && original[0].x === 0 && original[0].y === 0 && original[0].width === s.source.width && original[0].height === s.source.height && equal(original[0].sourceRect, {x:0,y:0,width:s.source.width,height:s.source.height}) && original[0].visible && original[0].opacity === 1, '原始版本必须完整保留原图');
  check(Array.isArray(s.undo) && Array.isArray(s.redo) && [...s.undo, ...s.redo].every(x => ids.has(x)), '撤销或重做记录无效');
  return s;
}
export const currentVersion = s => s.versions.find(v => v.id === s.currentVersionId);
// Return copies so consumer code cannot accidentally change a saved scene.
export const currentScene = s => clone(currentVersion(s).scene);
export const isDirty = s => s.currentVersionId !== s.savedVersionId;
export function commit(s, scene, label = '调整图层', restoredFrom = null) {
  validateScene(scene); if (equal(scene, currentVersion(s).scene)) return s;
  const next = clone(s), v = {id:id(),parentId:s.currentVersionId,createdAt:Date.now(),label,restoredFrom,scene:clone(scene)};
  next.versions.push(v); next.undo.push(s.currentVersionId); next.redo = []; next.currentVersionId = v.id;
  validateSession(next); return next;
}
export function addLayer(s, layer) { const scene = currentScene(s); scene.layers.push(clone(layer)); return commit(s,scene,'添加图层'); }
export function updateLayer(s, layerId, patch) {
  const scene = currentScene(s), l = scene.layers.find(x => x.id === layerId); check(l,'图层不存在');
  check(Object.keys(patch).every(k => ['name','x','y','width','height','visible','locked','opacity','text','style','assetId','sourceRect'].includes(k)), '不允许修改图层身份');
  check(!l.locked || Object.keys(patch).every(k => k === 'locked'), '请先解锁图层');
  Object.assign(l,clone(patch), patch.style ? {style:{...l.style,...patch.style}} : {});
  return commit(s,scene,'修改图层');
}
export function removeLayer(s, layerId) {
  const scene = currentScene(s), l = scene.layers.find(x => x.id === layerId); check(l && !l.locked,'图层不存在或已锁定');
  scene.layers = scene.layers.filter(x => x.id !== layerId); return commit(s,scene,'删除图层');
}
export function moveLayer(s, layerId, toIndex) {
  const scene = currentScene(s), from = scene.layers.findIndex(x => x.id === layerId);
  check(from >= 0 && !scene.layers[from].locked && Number.isInteger(toIndex),'图层不存在、已锁定或层级无效');
  const [l] = scene.layers.splice(from,1); scene.layers.splice(Math.max(0,Math.min(scene.layers.length,toIndex)),0,l);
  return commit(s,scene,'调整层级');
}
export function undo(s) { if (!s.undo.length) return s; const n = clone(s); n.redo.push(n.currentVersionId); n.currentVersionId = n.undo.pop(); return n; }
export function redo(s) { if (!s.redo.length) return s; const n = clone(s); n.undo.push(n.currentVersionId); n.currentVersionId = n.redo.pop(); return n; }
export function markSaved(s) { const n = clone(s); n.savedVersionId = n.currentVersionId; return n; }
export function cancelChanges(s) { if (!isDirty(s)) return s; const n = clone(s); n.undo.push(n.currentVersionId); n.currentVersionId = n.savedVersionId; n.redo = []; return n; }
export function restoreVersion(s, versionId) { const v = s.versions.find(v => v.id === versionId); check(v,'恢复版本不存在'); return commit(s,v.scene,'恢复版本',versionId); }
export function serialize(s) { validateSession(s); return JSON.stringify(s); }
export function deserialize(text) { return validateSession(JSON.parse(text)); }
export function referencedAssets(s) { return [...new Set(s.versions.flatMap(v => v.scene.layers.filter(l => l.type === 'image').map(l => l.assetId)))]; }

// viewport is the image content's CSS rectangle (not the letterboxed container).
// client coordinates already account for page scroll; DPR never enters this map.
export function clientToDocument(point, viewport, scene, clamp = true) {
  check(viewport.width > 0 && viewport.height > 0,'画布尚未显示');
  const x = (point.x - viewport.left) * scene.width / viewport.width, y = (point.y - viewport.top) * scene.height / viewport.height;
  return {x:clamp ? Math.max(0,Math.min(scene.width,x)) : x,y:clamp ? Math.max(0,Math.min(scene.height,y)) : y};
}
export function selectionRect(a,b) { return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)}; }
export function selectionToSource(selection, layer, asset) {
  check(layer.type === 'image' && layer.assetId === asset.id,'选区需要对应的图片资产');
  const x = Math.max(selection.x,layer.x), y = Math.max(selection.y,layer.y);
  const right = Math.min(selection.x+selection.width,layer.x+layer.width), bottom = Math.min(selection.y+selection.height,layer.y+layer.height);
  if (right <= x || bottom <= y) return null;
  const r = layer.sourceRect, sx = r.width/layer.width, sy = r.height/layer.height;
  const left = Math.max(0,Math.floor(r.x+(x-layer.x)*sx)), top = Math.max(0,Math.floor(r.y+(y-layer.y)*sy));
  const endX = Math.min(asset.width,Math.ceil(r.x+(right-layer.x)*sx)), endY = Math.min(asset.height,Math.ceil(r.y+(bottom-layer.y)*sy));
  if (endX <= left || endY <= top) return null;
  return {assetId:asset.id,rect:{x:left,y:top,width:endX-left,height:endY-top},normalized:{x:left/asset.width,y:top/asset.height,width:(endX-left)/asset.width,height:(endY-top)/asset.height}};
}
export function hitTest(scene, p) { return [...scene.layers].reverse().find(l => l.visible && l.opacity > 0 && p.x >= l.x && p.y >= l.y && p.x <= l.x+l.width && p.y <= l.y+l.height) || null; }
