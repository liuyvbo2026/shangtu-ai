import {prepareNative} from './native-build.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fail,Fault} from '../core.mjs';
const execute=promisify(execFile),source=fileURLToPath(new URL('./local-ocr.swift',import.meta.url));

export function localRecognizer(dataDir){
 if(process.platform!=='darwin'||!fs.existsSync('/usr/bin/xcrun'))return null;
 let compiled;
 const dir=path.join(dataDir,'ocr'),hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,16);
 const binary=path.join(dir,`vision-${hash}`);
 return async bytes=>{
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  // Never pass provider credentials to the compiler or OCR child process.
  const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,TMPDIR:dir};
  if(!fs.existsSync(binary)){
   compiled??=prepareNative(source,binary).catch(()=>{compiled=null;throw new Fault('OCR_UNAVAILABLE','本机文字识别暂不可用，请检查系统开发工具',503);});
   await compiled;
  }
  const temp=fs.mkdtempSync(path.join(dir,'input-')),file=path.join(temp,'image');
  try{fs.writeFileSync(file,bytes,{mode:0o600});const {stdout}=await execute(binary,[file],{timeout:30000,maxBuffer:256*1024,env});return JSON.parse(stdout);}
  catch(e){if(e instanceof Fault)throw e;throw new Fault('OCR_FAILED','文字识别失败，请重试；原图保持不变',503);}
  finally{fs.rmSync(temp,{recursive:true,force:true});}
 };
}
export function recognitionService(store,recognize){
 store.db.exec('CREATE TABLE IF NOT EXISTS integration_recognitions (id TEXT PRIMARY KEY,result_id TEXT NOT NULL,version INTEGER NOT NULL,asset_id TEXT NOT NULL,content_json TEXT NOT NULL)');
 let busy=false;
 return {available:!!recognize,async recognize(resultId,expectedVersion){
  fail(!!recognize,'OCR_UNAVAILABLE','文字识别能力尚未配置',503);fail(!busy,'OCR_BUSY','正在识别其他图片，请稍后重试',409);
  const head=store.result(resultId).versions.at(-1);fail(head.version===expectedVersion,'REVISION_CONFLICT','图片版本已改变，请重新打开识别',409);
  busy=true;
  try{
   const rows=await recognize(store.readAsset(head.assetId));
   fail(Array.isArray(rows)&&rows.length<=100,'OCR_OUTPUT_INVALID','文字识别结果无效或文字过多');
   const regions=rows.map((r,i)=>{
    fail(typeof r.text==='string'&&r.text.trim().length>0&&r.text.length<=1000&&Array.isArray(r.box)&&r.box.length===4&&r.box.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&r.box[2]>0&&r.box[3]>0&&r.box[0]+r.box[2]<=1.001&&r.box[1]+r.box[3]<=1.001,'OCR_OUTPUT_INVALID','文字识别结果无效');
    return {id:`text-${i+1}`,text:r.text,box:r.box,confidence:Number.isFinite(r.confidence)?r.confidence:null};
   });
   fail(regions.reduce((n,r)=>n+r.text.length,0)<=12000,'OCR_OUTPUT_INVALID','图片文字过多，请先裁剪后识别');
   fail(store.result(resultId).versions.at(-1).version===expectedVersion,'REVISION_CONFLICT','识别期间图片已有新版本，请重新识别',409);
   const id=randomUUID();store.run('INSERT INTO integration_recognitions VALUES(?,?,?,?,?)',id,resultId,head.version,head.assetId,JSON.stringify(regions));
   return {id,resultId,version:head.version,assetId:head.assetId,regions};
  }finally{busy=false;}
 }};
}

export function textChanges(store,resultId,version,input){
 fail(typeof input.recognitionId==='string','INVALID_INPUT','请先识别图片文字');
 const row=store.get('SELECT * FROM integration_recognitions WHERE id=?',input.recognitionId);
 fail(row?.result_id===resultId&&row.version===version,'REVISION_CONFLICT','识别结果已过期，请重新识别',409);
 const regions=JSON.parse(row.content_json),seen=new Set();
 fail(Array.isArray(input.changes)&&input.changes.length>0&&input.changes.length<=regions.length,'INVALID_INPUT','请先修改识别出的文字');
 const changes=input.changes.map(change=>{
  fail(change&&typeof change==='object','INVALID_INPUT','修改文字无效');
  const original=regions.find(r=>r.id===change.id);
  fail(original&&!seen.has(change.id)&&typeof change.text==='string'&&change.text.length<=1000&&change.text!==original.text,'INVALID_INPUT','修改文字无效或尚未改变');seen.add(change.id);
  return {...original,replacement:change.text};
 });
 fail(changes.reduce((n,r)=>n+r.replacement.length,0)<=12000,'INVALID_INPUT','修改文字过长');
 return changes;
}
