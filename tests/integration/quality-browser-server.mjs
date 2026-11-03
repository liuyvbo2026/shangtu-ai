// Persistent isolated browser fixture. No production configuration or network model calls.
import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {textFixture,fixtureOutput,fixtureResponse} from './mimo-fixtures.mjs';
import {designFixture} from './design-fixtures.mjs';
import {COMMERCE_TEMPLATE} from '../../src/workflow/minimum-templates.js';
import {staticHandler} from '../../backend/integration/static.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=root+'artifacts/product-kit-delivery-2026-11-01/browser-data';
const h=textFixture({dataDir:dir,transport:async({data})=>{
 await new Promise(r=>setTimeout(r,250));const output=fixtureOutput(data);
 if(data.operation==='plan')designFixture(output);
 return fixtureResponse(output);
}});
h.config.mimo.templateVersion=COMMERCE_TEMPLATE;
const serve=staticHandler(root),server=http.createServer((req,res)=>req.url.startsWith('/api/')?h.runtime.handler(req,res):serve(req,res));
server.listen(5203,'127.0.0.1',()=>console.log('SYNTHETIC QUALITY ONLY http://127.0.0.1:5203'));
fs.writeFileSync(root+'artifacts/product-kit-delivery-2026-11-01/synthetic-input.json',JSON.stringify(h.request,null,2));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{server.close();await h.close();process.exit(0);});
