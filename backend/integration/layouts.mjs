import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fail,hash,canonical} from '../core.mjs';
import {validateInput,VERSIONS} from '../../src/workflow/index.js';
import {layoutCatalog} from '../../src/layout-catalog.js';
import {PRESENTATIONS} from '../../src/workflow/minimum-templates.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
// Only the trusted, versioned catalog defines executable layouts. Browser thumbnails
// and arbitrary uploaded images are not silently promoted to approved templates.
export function createLayoutRegistry(store,entries=layoutCatalog){
 return {resolve(ids,settings){return ids.map(id=>{
  const entry=entries.find(x=>x.id===id);
  fail(entry?.definition&&entry.reference&&entry.rights?.modelUpload===true,'LAYOUT_UNAVAILABLE','所选版式缺少正式素材、规则或上传授权，请移除后重新选择',409);
  const {definition,reference}=entry;
  fail(definition.id===id&&definition.version&&PRESENTATIONS.includes(entry.presentation),'LAYOUT_INVALID','版式定义无效');
  const check={schemaVersion:VERSIONS.schema,product:{id:'layout-check',revision:1,name:'版式验证',facts:[],unknowns:[],references:[{id:'product',assetId:'product',role:'product',purpose:'身份'}]},
   requirements:{description:'版式规则验证',platform:settings.platform,language:settings.language,counts:settings.counts,ratio:settings.ratio,size:{width:1024,height:1024},layoutIds:[id]},layouts:[definition]};
  // Size is checked independently by the generation settings; validate template geometry here.
  const errors=validateInput(check).filter(e=>!['ASPECT_SIZE','PROVIDER_SIZE','PIXELS','RATIO'].includes(e.code));
  fail(!errors.length,'LAYOUT_INCOMPATIBLE','所选版式不支持当前比例或版式区域有冲突',409);
  let asset;
  if(reference.assetId)asset=store.asset(reference.assetId); // injected isolated test catalog only
  else{
   fail(/^\/assets\/layout-[a-z0-9-]+\.png$/.test(reference.path),'LAYOUT_INVALID','版式原图路径无效');
   const file=path.join(root,reference.path),real=fs.realpathSync(file);
   fail(real===file,'LAYOUT_INVALID','版式原图不能是链接');
   const bytes=fs.readFileSync(file);fail(hash(bytes)===reference.sha256,'LAYOUT_SOURCE_CHANGED','版式素材与已发布版本不一致',409);
   const old=store.get("SELECT id FROM assets WHERE sha256=? AND kind='original' ORDER BY created_at LIMIT 1",reference.sha256);
   asset=old?store.asset(old.id):store.putAsset(bytes,{kind:'original',mediaType:'image/png',name:`layout-${id}-${definition.version}.png`});
  }
  fail(asset.sha256===reference.sha256&&asset.kind==='original','LAYOUT_SOURCE_CHANGED','版式原图无法核对',409);
  const pinned={id,name:entry.name,presentation:entry.presentation,definition:structuredClone(definition),reference:{id:`layout:${id}`,assetId:asset.id,role:'layout',sha256:asset.sha256},rights:structuredClone(entry.rights)};
  return {...pinned,digest:hash(canonical(pinned))};
 });}};
}
export function verifyPinnedLayouts(store,layouts=[]){
 for(const layout of layouts){const {digest,...body}=layout;fail(hash(canonical(body))===digest&&store.asset(layout.reference.assetId).sha256===layout.reference.sha256,'LAYOUT_SOURCE_CHANGED','历史版式内容无法核对',409);}
 return layouts;
}
export function layoutForSlot(layouts,images,index){
 return images[index].type==='selling'?layouts[images.slice(0,index+1).filter(x=>x.type==='selling').length-1]??null:null;
}
