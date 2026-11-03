import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../backend/store.mjs';
import { TEST_CONTRACT, fixturePNG } from './test-processor.mjs';

export const config={retryBaseMs:5,pollMs:5,timeoutMs:400,leaseMs:1200,concurrency:2,maxAttempts:3};
export function sandbox(t) {
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-02a-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}
export function storeAt(dir,overrides={}) {return new Store({dataDir:path.join(dir,'data'),config,processor:TEST_CONTRACT,...overrides});}
export function product(store,name='product',refs=2) {
  let p=store.createProduct({name,facts:{confirmed:{color:'red'},inferred:{},unknown:['size']}});
  for(let i=0;i<refs;i++) {const a=store.putAsset(fixturePNG(`${name}-${i}`),{name:`${name}-${i}.png`});p=store.addReference(p.id,{assetId:a.id,role:i?'detail':'front'});}
  return p;
}
export const input=(p,keys=['a','b','c'])=>({productId:p.id,productRevision:p.revision,description:'isolated test only',settings:{platform:'test',language:'zh'},slots:keys.map(key=>({key,type:'test'})),versions:{workflow:'test-v1'}});
export async function until(predicate,message='condition',ms=4000) {
  const end=Date.now()+ms;
  while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail(`Timed out waiting for ${message}`);
}
export const done=(store,taskId)=>until(()=>{const t=store.task(taskId);return ['succeeded','failed','partial','canceled'].includes(t.state)&&t;},'terminal task');
export const count=(store,table)=>store.get(`SELECT count(*) AS n FROM ${table}`).n;
