// Dedicated local browser environment; synthetic transport and pixels, never real credentials.
import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {textFixture,fixtureOutput,fixtureResponse} from './mimo-fixtures.mjs';
import {designFixture} from './design-fixtures.mjs';
import {DESIGN_TEMPLATE} from '../../src/workflow/minimum-templates.js';
import {staticHandler} from '../../backend/integration/static.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=root+'artifacts/product-depth-2026-10-31/browser-data';
const h=textFixture({dataDir:dir,transport:async({data})=>{
 await new Promise(r=>setTimeout(r,250));
 const out=fixtureOutput(data);
 if(data.operation==='plan'){
  designFixture(out);
  if(data.settings.language==='无文字')for(const image of out.images){image.copy=[];image.design.elements=image.design.elements.filter(e=>['图标卡片','局部放大'].includes(e.kind)).map(e=>({...e,copyIndex:-1}));}
  if(data.userText.includes('TEST_BAD_DESIGN'))out.images.find(x=>x.composition.layout==='图标卡片').content+='四张等大卡片。';
 }
 return fixtureResponse(out);
}});
h.config.mimo.templateVersion=DESIGN_TEMPLATE;
for(let i=0;i<h.p.references.length;i++)fs.writeFileSync(root+`artifacts/product-depth-2026-10-31/upload-${i+1}.png`,h.runtime.store.readAsset(h.p.references[i].assetId));
const serve=staticHandler(root),server=http.createServer((req,res)=>req.url.startsWith('/api/')?h.runtime.handler(req,res):serve(req,res));
server.listen(5198,'127.0.0.1',()=>console.log('SYNTHETIC_DESIGN_ONLY http://127.0.0.1:5198'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{server.close();await h.close();process.exit(0);});
