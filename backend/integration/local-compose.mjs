import {prepareNative} from './native-build.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {WorkflowError} from '../../src/workflow/value.js';
const execute=promisify(execFile),source=fileURLToPath(new URL('./local-compose.swift',import.meta.url));

export function localCompositor(dataDir){
 const dir=path.join(dataDir,'compositor'),hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,16),binary=path.join(dir,`text-${hash}`);
 const prepare=async()=>{
  if(process.platform!=='darwin'||!fs.existsSync('/usr/bin/xcrun'))throw new WorkflowError('COMPOSE_FAILED');
  try{await prepareNative(source,binary);}catch{throw new WorkflowError('COMPOSE_FAILED');}
 };
 const compose=async ({raster,layers})=>{
  if(!layers.length)return {raster,layers};
  if(process.platform!=='darwin')throw new WorkflowError('COMPOSE_FAILED');
  const valid=layers.length<=4&&layers.every(l=>l.kind==='text'&&typeof l.text==='string'&&l.text.length>0&&l.text.length<=1000&&
   Array.isArray(l.box)&&l.box.length===4&&l.box.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&l.box[2]>0&&l.box[3]>0&&l.box[0]+l.box[2]<=1.000001&&l.box[1]+l.box[3]<=1.000001&&
   Number.isFinite(l.fontSize)&&l.fontSize>=8&&l.fontSize<=Math.min(raster.width,raster.height)*.08&&(l.color===undefined||/^#[0-9a-fA-F]{6}$/.test(l.color))&&[400,600].includes(l.fontWeight)&&['left','center','right'].includes(l.align));
  if(!valid)throw new WorkflowError('COMPOSE_FAILED');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,TMPDIR:dir};
  try{
   await prepare();
   const temp=fs.mkdtempSync(path.join(dir,'render-'));
   try{
    const input=path.join(temp,'base.png'),spec=path.join(temp,'spec.json'),output=path.join(temp,'composed.png');
    fs.writeFileSync(input,Buffer.from(raster.base64,'base64'),{mode:0o600});
    fs.writeFileSync(spec,JSON.stringify({width:raster.width,height:raster.height,layers}),{mode:0o600});
    await execute(binary,[input,spec,output],{timeout:30000,maxBuffer:65536,env});
    return {raster:{...raster,base64:fs.readFileSync(output).toString('base64'),provenance:raster.provenance==='test-only'?'test-only':'compositor'},layers};
   }finally{fs.rmSync(temp,{recursive:true,force:true});}
  }catch{throw new WorkflowError('COMPOSE_FAILED');}
 };
 compose.prepare=prepare;return compose;
}
