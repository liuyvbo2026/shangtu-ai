let database;
const urlCache=new Map(),assetCache=new Map();
export async function openDB(){return database ||= await new Promise((resolve,reject)=>{const r=indexedDB.open('liuyubo-aigc-beta-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('state');r.result.createObjectStore('assets',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function access(store,mode,fn){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(store,mode);const r=fn(tx.objectStore(store));let result;r.onsuccess=()=>{result=r.result;};r.onerror=()=>reject(r.error);tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('保存已中止'));});}
export const loadState=()=>access('state','readonly',s=>s.get('workspace'));
export const saveState=state=>access('state','readwrite',s=>s.put(structuredClone(state),'workspace'));
export async function putAsset(asset){await access('assets','readwrite',s=>s.put(asset));assetCache.set(asset.id,asset);return asset;}
export async function getAsset(id){if(!id)return null;if(assetCache.has(id))return assetCache.get(id);let value=await access('assets','readonly',s=>s.get(id));if(!value&&id.startsWith('server:')){const path='/api/backend-v1/assets/'+encodeURIComponent(id.slice(7));const response=await fetch(path);if(!response.ok)return null;const meta=await response.json(),content=await fetch(path+'/content');if(!content.ok)throw Error('后台图片读取失败');value={id,name:meta.name,type:meta.mediaType,width:meta.width,height:meta.height,blob:await content.blob(),sha256:meta.sha256,createdAt:meta.createdAt};}if(value)assetCache.set(id,value);return value;}
export async function assetURL(id){if(!id)return '';if(urlCache.has(id))return urlCache.get(id);const a=await getAsset(id);if(!a)return '';const url=URL.createObjectURL(a.blob);urlCache.set(id,url);return url;}
export async function importImage(file,{limit=20}={}){
 if(!file||!(/image\/(png|jpeg|webp|heic|heif)/i.test(file.type)||/\.(png|jpe?g|webp|heic|heif)$/i.test(file.name)))throw Error('请选择 PNG、JPG、WEBP 或 HEIC 图片。');
 if(file.size>limit*1024*1024)throw Error(`图片超过 ${limit}MB，请重新选择。`);
 const url=URL.createObjectURL(file);let image;
 try {image=await new Promise((r,j)=>{const im=new Image();im.onload=()=>r(im);im.onerror=()=>j(Error(/hei[cf]/i.test(file.type+file.name)?'当前浏览器无法读取 HEIC，请先转为 JPG 或 PNG。':'图片无法读取，请重新选择。'));im.src=url;});}
 finally {URL.revokeObjectURL(url);}
 if(image.naturalWidth*image.naturalHeight>40_000_000)throw Error('图片超过 4000 万像素，请缩小后重新上传。');
 return putAsset({id:crypto.randomUUID(),name:file.name||'粘贴的图片.png',width:image.naturalWidth,height:image.naturalHeight,type:file.type||'image/png',blob:file,createdAt:Date.now()});
}
export async function storeCanvas(canvas,name='编辑结果.png'){const blob=await new Promise((resolve,reject)=>canvas.toBlob(v=>v?resolve(v):reject(Error('图片导出失败。')),'image/png'));return putAsset({id:crypto.randomUUID(),name,width:canvas.width,height:canvas.height,type:'image/png',blob,createdAt:Date.now()});}
export async function exportWorkspace(state){const ids=new Set();function walk(v){if(typeof v==='string')ids.add(v);else if(v&&typeof v==='object')for(const x of Object.values(v))walk(x);}walk(state);const assets=[];for(const id of ids){const a=await getAsset(id);if(a)assets.push({...a,blob:await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(a.blob);})});}return new Blob([JSON.stringify({app:'liuyubo-aigc-beta',state,assets})],{type:'application/json'});}
export async function importWorkspace(file){const v=JSON.parse(await file.text());if(v.app!=='liuyubo-aigc-beta'||v.state?.version!==1||!Array.isArray(v.assets))throw Error('这不是有效的工作区备份。');for(const a of v.assets){if(!/^data:image\//.test(a.blob))throw Error('备份包含无效图片。');await putAsset({...a,blob:await(await fetch(a.blob)).blob()});}return v.state;}
