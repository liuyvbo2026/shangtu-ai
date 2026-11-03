// Isolated browser acceptance only: synthetic credentials, replies and pixels. No network models.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {createApiSettings} from '../../backend/integration/api-settings.mjs';
import {staticHandler} from '../../backend/integration/static.mjs';
import {fixturePNG} from './fixtures.mjs';
import {fixtureResponse} from './mimo-fixtures.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-model-browser-'));
const apiSettings=createApiSettings({root:dir,fallback:{text:'sk-SYNTHETIC_BROWSER_ONLY',image:'SYNTHETIC_BROWSER_ONLY'}});
const config={modelCallsPaused:false,budgetId:'SYNTHETIC_BROWSER_ONLY',budgetCny:100,reservePerImageCny:.12,priceEvidence:'SYNTHETIC',accountConfirmed:true,authorizationEvidence:'SYNTHETIC',authorizedReferenceHashes:['a'.repeat(64)],mimo:{model:'mimo-v2.6-flash',billing:'pay-as-you-go',accountConfirmed:true,authorizationEvidence:'SYNTHETIC',authorizedReferenceHashes:['a'.repeat(64)]}};
const transport=async(url,o)=>{
 await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1000);o.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});});
 const payload=JSON.parse(o.body),key=o.headers.Authorization??o.headers['api-key'];
 if(key.includes('DENIED'))return new Response('PRIVATE_RESPONSE_MUST_NOT_LEAK',{status:401});
 if(url.includes('chat/completions'))return fixtureResponse({ok:true,color:'red'},{model:payload.model});
 if(url.includes('multimodal-generation'))return Response.json({output:{choices:[{message:{content:[{image:'https://test.example/image.png'}]}}]}});
 if(url.includes('v35-generation'))return Response.json({choices:[{delta:{image:{url:'https://test.example/image.png'}}}]});
 return Response.json({model:payload.model,data:[{b64_json:fixturePNG('SYNTHETIC CONNECTION ONLY',1024,1024).toString('base64')}]});
};
const runtime=createRuntime({dataDir:path.join(dir,'data'),config,apiSettings,mimoTransport:transport,imageTransport:transport,downloadTransport:async()=>new Response(fixturePNG('SYNTHETIC CONNECTION ONLY',1024,1024)),recognizeText:null});
const serve=staticHandler(root),server=http.createServer((req,res)=>req.url.startsWith('/api/')?runtime.handler(req,res):serve(req,res));
server.listen(5197,'127.0.0.1',()=>console.log('SYNTHETIC MODEL SETTINGS http://127.0.0.1:5197'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();await runtime.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);});
