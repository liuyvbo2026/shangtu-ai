// Explicit isolated browser QA entry. The production entry never imports this module.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {staticHandler} from '../../backend/integration/static.mjs';
import {handlers} from './fixtures.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dataDir=process.env.QA_DATA_DIR||fs.mkdtempSync(path.join(root,'artifacts/integration-round1/qa-data-'));
const runtime=createRuntime({dataDir,testHandlers:handlers({delay:700,failFirst:'selling-1'})});
const serve=staticHandler(root),server=http.createServer((req,res)=>req.url.startsWith('/api/')?runtime.handler(req,res):serve(req,res));
server.listen(Number(process.env.PORT||5189),'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,mode:'TEST_ONLY',dataDir})));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{server.close();await runtime.close();process.exit(0);});
