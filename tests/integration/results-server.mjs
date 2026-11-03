// Isolated result-tool browser QA. No provider key or real model handler.
import fs from 'node:fs';
import path from 'node:path';
import {inputHarness,legacyProduct} from './input-harness.mjs';
import {handlers,settings} from './fixtures.mjs';
const dir=path.resolve('.private/parity-results-2026-10-28/qa');
const bytes=fs.readFileSync('artifacts/parity-results-2026-10-28/ui-fixture.png');
const testHandlers={...handlers({delay:300}),async generate(r){
 for(const a of r.prompt.data.references)await r.readAsset(a.assetId);
 await new Promise(resolve=>setTimeout(resolve,300));
 return {base64:bytes.toString('base64'),mediaType:'image/png',width:1024,height:1024,provenance:'test-only',requestId:`test-${r.image.id}-${r.attempt}`};
}};
const h=await inputHarness({dataDir:dir,testHandlers});
if(!h.runtime.store.tasks().length){
 const p=legacyProduct(h.runtime.store,'result-tools-qa');
 const response=await fetch(h.base+'/api/backend-v1/kits',{method:'POST',headers:{'Content-Type':'application/json','X-Backend-Client':'local-development','Idempotency-Key':'result-tools-source'},body:JSON.stringify({productId:p.id,productRevision:p.revision,settings:{...settings,ratio:'1:1'},description:'结果工具验证，仅使用程序绘制测试图'})});
 if(!response.ok)throw Error(await response.text());
}
const metadata={url:h.base,mode:'TEST_ONLY',dataDir:dir,pid:process.pid};
fs.writeFileSync('artifacts/parity-results-2026-10-28/qa-server.json',JSON.stringify(metadata,null,2));console.log(metadata);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await h.close();process.exit(0);});
