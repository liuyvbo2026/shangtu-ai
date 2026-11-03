// Isolated browser QA, synthetic responses only. Never loads production configuration or credentials.
import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {textFixture,fixtureOutput,fixtureResponse} from './mimo-fixtures.mjs';
import {handlers} from './fixtures.mjs';
import {staticHandler} from '../../backend/integration/static.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const h=textFixture({dataDir:root+'artifacts/minimum-mvp-2026-10-30/browser-data',transport:async({data})=>{
 await new Promise(r=>setTimeout(r,700));
 if(data.userText.includes('TEST_FAIL'))return fixtureResponse({invalid:true});
 const out=fixtureOutput(data);if(data.operation==='plan')for(const i of out.images){
  if(data.settings.language==='无文字')i.copy=[];else i.copy.forEach(c=>c.text=i.purpose);
 }return fixtureResponse(out);
}});
h.config.mimo.templateVersion='ecommerce-kit.1';
const imageFixture=handlers({delay:800});
h.runtime.handlers.generate=async request=>{
 const failed=h.runtime.store.get("SELECT count(*) AS n FROM attempts WHERE state='failed'").n;
 if(request.image.id==='image-2'&&request.attempt===1&&!failed){const {WorkflowError}=await import('../../src/workflow/value.js');throw new WorkflowError('REJECTED');}
 return imageFixture.generate(request);
};
// Export synthetic upload files for real file-input interaction in a new browser origin.
for(let i=0;i<h.p.references.length;i++)fs.writeFileSync(root+`artifacts/minimum-mvp-2026-10-30/upload-${i+1}.png`,h.runtime.store.readAsset(h.p.references[i].assetId));
const serve=staticHandler(root),server=http.createServer((req,res)=>req.url.startsWith('/api/')?h.runtime.handler(req,res):serve(req,res));
server.listen(5196,'127.0.0.1',()=>console.log('SYNTHETIC_MVP_ONLY http://127.0.0.1:5196'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{server.close();await h.close();process.exit(0);});
