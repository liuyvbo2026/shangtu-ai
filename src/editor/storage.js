import {clone,validateSession,referencedAssets,serialize,deserialize} from './core.js';
import {decodeImage} from './render.js';

export const DATABASE_NAME = 'liuyubo-aigc-editor-05a-v1';
let database;
export async function sha256(value) {
  const bytes = value instanceof Blob ? await value.arrayBuffer() : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n => n.toString(16).padStart(2,'0')).join('');
}
export async function createAsset(blob, name = '图片.png') {
  if (!(blob instanceof Blob) || !['image/png','image/jpeg','image/webp'].includes(blob.type) || !blob.size || blob.size > 20*1024*1024) throw Error('请选择不超过 20MB 的 PNG、JPEG 或 WebP 图片');
  const image = await decodeImage(blob), width = image.naturalWidth, height = image.naturalHeight;
  if (!width || !height || width > 8192 || height > 8192 || width*height > 40_000_000) throw Error('图片边长上限 8192，总像素上限 4000 万');
  const hash = await sha256(blob);
  return {id:`sha256:${hash}`,sha256:hash,name:String(name).slice(0,200),width,height,type:blob.type,blob};
}
async function openDB() {
  if (!database) database = new Promise((resolve,reject) => {
    const r = indexedDB.open(DATABASE_NAME,1);
    r.onupgradeneeded = () => { r.result.createObjectStore('documents',{keyPath:'id'}); r.result.createObjectStore('assets',{keyPath:'id'}); };
    r.onsuccess = () => { r.result.onversionchange = () => {r.result.close(); database = null;}; resolve(r.result); };
    r.onerror = () => {database = null; reject(r.error);};
  });
  return database;
}
async function get(store,key) {
  const db = await openDB();
  return new Promise((resolve,reject) => {const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);});
}
export const getAsset = id => get('assets',id);
export async function loadDocument(id) { const r = await get('documents',id); if (r) validateSession(r.session); return r; }
export async function listDocuments() {
  const db = await openDB();
  return new Promise((resolve,reject) => {const r = db.transaction('documents').objectStore('documents').getAll(); r.onsuccess = () => resolve(r.result.map(x => ({id:x.id,name:x.session.name,updatedAt:x.updatedAt})).sort((a,b) => b.updatedAt-a.updatedAt)); r.onerror = () => reject(r.error);});
}
export async function validateAssets(session, resolveAsset) {
  const assets = new Map();
  for (const id of referencedAssets(session)) {
    const asset = await resolveAsset(id); if (!asset) throw Error(`缺少图片资产 ${id}`); assets.set(id,asset);
  }
  for (const v of session.versions) for (const l of v.scene.layers) if (l.type === 'image') {
    const a = assets.get(l.assetId), r = l.sourceRect;
    if (r.x+r.width > a.width || r.y+r.height > a.height) throw Error('图片裁剪区域超出原图');
  }
  return assets;
}
// All assets and the document are written in one transaction. Compare-and-swap
// rejects stale tabs. Existing assets and version snapshots are never replaced.
export async function persistDocument(session, {expectedEtag = null, assets = []} = {}) {
  const snapshot = deserialize(serialize(session)), verified = new Map();
  for (const a of assets) {
    const checked = await createAsset(a.blob,a.name);
    if (a.id !== checked.id || a.width !== checked.width || a.height !== checked.height || a.type !== checked.type) throw Error('资产完整性校验失败');
    verified.set(a.id,checked);
  }
  await validateAssets(snapshot, id => verified.get(id) || getAsset(id));
  const db = await openDB();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(['documents','assets'],'readwrite'), docs = tx.objectStore('documents'), images = tx.objectStore('assets');
    let result, failure;
    const abort = message => {failure = Error(message); tx.abort();};
    const read = docs.get(snapshot.documentId);
    read.onsuccess = () => {
      const previous = read.result;
      if ((previous?.etag ?? null) !== expectedEtag) {abort('该文档已在其他页面更新，请导出当前编辑包后重新打开'); return;}
      if (previous) {
        const before = previous.session;
        if (JSON.stringify(before.source) !== JSON.stringify(snapshot.source) || before.originalVersionId !== snapshot.originalVersionId || before.versions.some(v => JSON.stringify(v) !== JSON.stringify(snapshot.versions.find(n => n.id === v.id)))) {abort('禁止覆盖原始来源或已有版本'); return;}
      }
      for (const a of verified.values()) {
        const r = images.get(a.id); r.onsuccess = () => { if (!r.result) images.add(a); };
      }
      result = {id:snapshot.documentId,etag:(previous?.etag || 0)+1,session:snapshot,updatedAt:Date.now()}; docs.put(result);
    };
    tx.oncomplete = () => resolve(clone(result));
    tx.onabort = tx.onerror = () => reject(failure || tx.error || Error('保存失败，旧版本仍保留'));
  });
}
function dataURL(blob) { return new Promise((resolve,reject) => {const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob);}); }
export async function exportBundle(session, resolveAsset = getAsset) {
  validateSession(session); const assets = await validateAssets(session,resolveAsset), packed = [];
  for (const a of assets.values()) {const {blob,...meta} = a; packed.push({...meta,data:await dataURL(blob)});}
  return new Blob([JSON.stringify({format:'aigc-editor',schemaVersion:1,session,assets:packed})],{type:'application/json'});
}
// Import creates an independent document, preserving all original/version IDs.
// Validate every blob before opening the write transaction (no partial import).
export async function importBundle(file) {
  if (file.size > 150*1024*1024) throw Error('编辑包超过 150MB');
  const bundle = JSON.parse(await file.text());
  if (bundle.format !== 'aigc-editor' || bundle.schemaVersion !== 1 || !Array.isArray(bundle.assets)) throw Error('不是有效的编辑包');
  const session = validateSession(bundle.session), assets = [], ids = new Set();
  for (const a of bundle.assets) {
    if (ids.has(a.id) || typeof a.data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(a.data)) throw Error('编辑包图片无效或重复');
    const blob = await (await fetch(a.data)).blob(), checked = await createAsset(blob,a.name);
    if (a.id !== checked.id || a.sha256 !== checked.sha256 || a.width !== checked.width || a.height !== checked.height || a.type !== checked.type) throw Error('编辑包图片完整性校验失败');
    ids.add(a.id); assets.push(checked);
  }
  await validateAssets(session,id => assets.find(a => a.id === id));
  session.documentId = crypto.randomUUID(); session.name = `${session.name.slice(0,180)} · 导入副本`;
  return persistDocument(session,{assets});
}
