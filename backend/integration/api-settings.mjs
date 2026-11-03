import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Fault,fail} from '../core.mjs';
import {MODEL_CATALOG,DEFAULT_IDS,preset,defaultConnection,validateConnection} from './model-catalog.mjs';

// These are the two implemented adapters, not a promise of universal API compatibility.
export const API_PROVIDERS={
 text:{name:'语言模型',provider:'小米 MiMo · 普通 API',model:'mimo-v2.6-flash',endpoint:'https://api.xiaomimimo.com/v1/chat/completions'},
 image:{name:'生图模型',provider:'火山方舟 · Seedream',model:'doubao-seedream-5-0-flash-260915',endpoint:'https://ark.cn-beijing.volces.com/api/v3/images/generations'}
};
const unsafe=()=>new Fault('API_SETTINGS_STORAGE','无法安全保存 API 设置，请检查本机私有目录权限',500);
export function createApiSettings({root,fallback={}}){
 const parent=path.join(fs.realpathSync(root),'.private'),file=path.join(parent,'api-settings.json');
 function checkParent(){
  if(!fs.existsSync(parent))fs.mkdirSync(parent,{mode:0o700});
  const s=fs.lstatSync(parent);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022))throw unsafe();
 }
 function read(){
  let fd;
  try{
   checkParent();
   if(!fs.existsSync(file)){if(fs.lstatSync(file,{throwIfNoEntry:false}))throw unsafe();return {version:1,revision:'initial',keys:{}};}
   fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   const s=fs.fstatSync(fd);
   if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size>100000)throw unsafe();
   const value=JSON.parse(fs.readFileSync(fd,'utf8'));
   if(![1,2].includes(value.version)||typeof value.revision!=='string'||!value.keys||Object.keys(value.keys).some(k=>!API_PROVIDERS[k]))throw unsafe();
   for(const [kind,key] of Object.entries(value.keys))if(key!=='')validateKey(kind,key);
   if(value.version===2){
    for(const kind of ['text','image'])for(const [id,profile] of Object.entries(value.profiles?.[kind]??{})){
     if(id!==profile.providerId)throw unsafe();validateConnection(kind,profile);
     if(profile.key)validateKey(kind,profile.key,id);
    }
    for(const kind of ['text','image'])if(value.selected?.[kind])preset(kind,value.selected[kind]);
   }
   return value;
  }catch{throw unsafe();}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 function validateKey(kind,key,id=DEFAULT_IDS[kind]){
  fail(typeof key==='string'&&key.length>=16&&key.length<=4096&&/^[\x21-\x7e]+$/.test(key),'INVALID_API_KEY','API Key 格式不正确，请粘贴完整密钥');
  if(id==='mimo')fail(/^sk-/.test(key),'INVALID_API_KEY','请填写 MiMo 普通 API Key（以 sk- 开头）');
  return key;
 }
 let current=read();
 const profile=(state,kind,id=state.selected?.[kind]??DEFAULT_IDS[kind])=>{
  const p=preset(kind,id),saved=state.profiles?.[kind]?.[id];
  return saved??{...defaultConnection(kind),providerId:id,model:p.models[0]??'',endpoint:p.endpoint,key:id===DEFAULT_IDS[kind]?(Object.hasOwn(state.keys,kind)?state.keys[kind]:fallback[kind]||''):''};
 };
 const connection=kind=>({...profile(current,kind),kind});
 const key=kind=>connection(kind).key;
 const publicProfile=(kind,p)=>{const {key,...safe}=p;return {...safe,name:API_PROVIDERS[kind].name,provider:preset(kind,p.providerId).label,configured:!!key};};
 const view=()=>({revision:current.revision,catalog:MODEL_CATALOG,providers:Object.fromEntries(['text','image'].map(kind=>[kind,publicProfile(kind,connection(kind))])),profiles:Object.fromEntries(['text','image'].map(kind=>[kind,Object.fromEntries(MODEL_CATALOG.filter(p=>p.kind===kind).map(p=>[p.id,publicProfile(kind,profile(current,kind,p.id))]))]))});
 function patched(state,kind,patch){
  fail(patch&&typeof patch==='object'&&!Array.isArray(patch)&&Object.keys(patch).every(k=>['key','clear','providerId','model','endpoint','reserveCny'].includes(k)),'INVALID_SETTINGS','API 设置格式不正确');
  fail(patch.clear===undefined||typeof patch.clear==='boolean','INVALID_SETTINGS','清除选项格式不正确');
  fail(patch.key===undefined||typeof patch.key==='string','INVALID_API_KEY','API Key 格式不正确');
  const old=profile(state,kind,patch.providerId??state.selected?.[kind]??DEFAULT_IDS[kind]);
  const value=(patch.key??'').trim(),next={...old};
  for(const field of ['providerId','model','endpoint','reserveCny'])if(patch[field]!==undefined)next[field]=patch[field];
  Object.assign(next,validateConnection(kind,next));
  fail(!(patch.clear&&value),'INVALID_SETTINGS','清除密钥时无需填写新密钥');
  // Never send a retained credential to a new destination, even on the same host.
  fail(next.endpoint===old.endpoint||value||patch.clear||!old.key,'KEY_DESTINATION_CHANGED','修改接口地址后，请重新填写该地址对应的 API Key');
  if(value||patch.clear)next.key=patch.clear?'':validateKey(kind,value,next.providerId);
  return next;
 }
 function preview(kind,patch,revision){
  fail(revision===current.revision,'SETTINGS_CONFLICT','API 设置已改变，请重新打开后测试',409);
  return {...patched(current,kind,patch),kind};
 }
 function save(input){
  fail(input&&typeof input==='object'&&Object.keys(input).every(k=>['revision','text','image'].includes(k)),'INVALID_SETTINGS','API 设置包含未知字段');
  // Re-read before compare-and-swap, including changes from another tab/process.
  const saved=read();
  fail(input.revision===saved.revision,'SETTINGS_CONFLICT','API 设置已在其他窗口更新，请重新打开后填写',409);
  const next={...saved,version:2,profiles:structuredClone(saved.profiles??{text:{},image:{}}),selected:{...saved.selected}};let changed=false;
  // Move legacy per-role keys into profiles once, so clearing a migrated key does
  // not leave an obsolete second copy inside this configuration file.
  for(const kind of Object.keys(saved.keys)){
   next.profiles[kind]??={};next.profiles[kind][DEFAULT_IDS[kind]]??=profile(saved,kind,DEFAULT_IDS[kind]);
  }
  next.keys={};
  for(const kind of Object.keys(API_PROVIDERS)){
   const patch=input[kind];if(patch===undefined)continue;
   const result=patched(saved,kind,patch);
   if(JSON.stringify(result)!==JSON.stringify(profile(saved,kind))){
    next.profiles[kind]??={};next.profiles[kind][result.providerId]=result;next.selected[kind]=result.providerId;changed=true;
   }
  }
  if(!changed){current=saved;return view();}
  next.revision=randomUUID();const temp=path.join(parent,`.api-settings-${randomUUID()}.tmp`);let fd;
  try{
   fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   fs.renameSync(temp,file);current=next;
  }catch{throw unsafe();}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return view();
 }
 return {key,view,save,connection,preview};
}
