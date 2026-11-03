import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createApiSettings} from '../../backend/integration/api-settings.mjs';
import {MODEL_CATALOG,preset,defaultConnection} from '../../backend/integration/model-catalog.mjs';
import {chatPayload,chatRequest,imagePayload,imageRequest,preflightImage,renderImagePrompt} from '../../backend/integration/model-adapters.mjs';
import {publicAddress,safeTransport} from '../../backend/integration/model-transport.mjs';
import {connectionTestImage,createConnectionTests} from '../../backend/integration/connection-tests.mjs';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {ledgerState} from '../../backend/integration/provider.mjs';
import {fixturePNG,settings} from './fixtures.mjs';
import {fixtureOutput,fixtureResponse} from './mimo-fixtures.mjs';
import {hash} from '../../backend/core.mjs';
const KEY='SYNTHETIC_ONLY_PROVIDER_KEY';
const c=(kind,id)=>({kind,providerId:id,model:preset(kind,id).models[0]??'custom-vlm',endpoint:preset(kind,id).endpoint||'https://models.example.com/v1/chat/completions',key:id==='mimo'?'sk-'+KEY:KEY,reserveCny:.12});
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
function root(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-models-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('provider profiles migrate without dropping old keys; switching vendors never reuses another credential',t=>{
 const dir=root(t),s=createApiSettings({root:dir,fallback:{text:'sk-'+KEY,image:KEY}}),revision=s.view().revision;
 assert.equal(s.view().catalog.filter(x=>x.kind==='text').length,9);
 assert.equal(s.view().catalog.filter(x=>x.kind==='image').length,4);
 s.save({revision,text:{...strip(c('text','qwen'))}});assert.equal(s.key('text'),KEY);
 assert.equal(s.preview('text',{providerId:'glm'},s.view().revision).key,'');
 assert.throws(()=>s.preview('text',{endpoint:'https://other.example.com/v1/chat/completions'},s.view().revision),e=>e.code==='KEY_DESTINATION_CHANGED');
 assert.throws(()=>s.preview('text',{endpoint:'https://other.example.com/?key=oops',key:KEY},s.view().revision),e=>e.code==='INVALID_ENDPOINT');
 s.save({revision:s.view().revision,text:{providerId:'mimo'}});assert.equal(s.key('text'),'sk-'+KEY);
 const restored=createApiSettings({root:dir,fallback:{text:'sk-'+KEY,image:KEY}});assert.equal(restored.preview('text',{providerId:'qwen'},restored.view().revision).key,KEY);
 assert.ok(!JSON.stringify(restored.view()).includes(KEY));assert.equal(fs.statSync(path.join(dir,'.private/api-settings.json')).mode&0o777,0o600);
});
function strip({kind,...x}){return x;}
test('chat presets use correct headers and vendor-specific request fields, validate complete JSON and do not expose provider errors',async()=>{
 for(const p of MODEL_CATALOG.filter(p=>p.kind==='text')){
  const conn=c('text',p.id),payload=chatPayload(conn,[{role:'user',content:'JSON'}],128);
  if(p.id==='qwen')assert.equal(payload.enable_thinking,false);
  if(p.id==='mimo'){assert.equal(payload.max_completion_tokens,128);assert.equal(payload.max_tokens,undefined);}
  let called=0;const result=await chatRequest(conn,payload,{transport:async(url,o)=>{called++;assert.equal(url,conn.endpoint);assert.equal(o.headers[p.id==='mimo'?'api-key':'Authorization'],p.id==='mimo'?conn.key:'Bearer '+conn.key);return fixtureResponse({ok:true,color:'red'},{model:conn.model});}});
  assert.equal(called,1);assert.equal(result.output.color,'red');
 }
 await assert.rejects(chatRequest(c('text','qwen'),{}, {transport:async()=>new Response(KEY,{status:401})}),e=>e.code==='MODEL_AUTH'&&!e.message.includes(KEY));
 await assert.rejects(chatRequest(c('text','qwen'),{}, {transport:async()=>fixtureResponse({key:KEY})}),e=>e.code==='TEXT_OUTPUT_INVALID');
});
test('all image protocols pass reference bytes, one-image output, dimensions and save valid returned pixels',async()=>{
 const bytes=fixturePNG('SYNTHETIC IMAGE PROTOCOL',1024,1024),image='data:image/png;base64,'+connectionTestImage().toString('base64');
 for(const p of MODEL_CATALOG.filter(p=>p.kind==='image')){
  const conn=c('image',p.id),payload=imagePayload(conn,{prompt:'保留参考图，纯白背景',images:[image],size:{width:1024,height:1024}});
  assert.ok(JSON.stringify(payload).includes(image));assert.equal(payload.model,conn.model);
  let downloaded=false;
  const result=await imageRequest(conn,payload,{transport:async()=>p.protocol==='dashscope'?json({output:{choices:[{message:{content:[{image:'https://images.example.com/test.png'}]}}]}}):p.protocol==='hunyuan'?json({choices:[{delta:{image:{url:'https://images.example.com/test.png'}}}]}):json({data:[{b64_json:bytes.toString('base64')}]}),downloadTransport:async(url,o)=>{assert.equal(o.headers,undefined);downloaded=true;return new Response(bytes);}});
  assert.deepEqual(result.bytes,bytes);assert.equal(result.info.width,1024);assert.equal(downloaded,p.id!=='seedream');
 }
});
test('unsupported references, dimensions and lengthy instructions fail before sending; render retains design and copy',()=>{
 const conn=c('image','wan'),request={image:{size:{width:1024,height:1024}},prompt:{system:'',data:{image:{type:'selling',purpose:'Purpose',content:'Content',composition:{angle:'Angle',framing:'Framing',background:'Background'}},identity:'Identity',sharedVisual:{palette:['blue']},copy:[{text:'EXACT COPY'}],unknowns:['capacity'],layoutSpec:{elements:[{text:'EXACT COPY',box:[0,0,1,1]}]},references:[{role:'product'}],output:{count:1}}}};
 const prompt=renderImagePrompt(request);for(const word of ['Purpose','Content','Angle','Framing','Background','Identity','EXACT COPY','capacity','layout'])assert.ok(prompt.includes(word));
 const asset={byteLength:50,width:512,height:512,mediaType:'image/png'};
 assert.throws(()=>preflightImage(conn,Array(5).fill(asset),request),e=>e.code==='MODEL_REFERENCE_LIMIT');
 assert.throws(()=>imagePayload(conn,{prompt:'字'.repeat(2001),images:['a'],size:{width:1024,height:1024}}),e=>e.code==='MODEL_PROMPT_TOO_LONG');
 assert.throws(()=>preflightImage(c('image','qwen-image'),Array(4).fill(asset),request),e=>e.code==='MODEL_REFERENCE_LIMIT');
 assert.throws(()=>imagePayload(c('image','qwen-image'),{prompt:'字'.repeat(500),images:['a'],size:{width:1024,height:1024}}),e=>e.code==='MODEL_PROMPT_TOO_LONG');
});
test('outbound transport rejects loopback, private, metadata, mapped IPv6 and redirects cannot send credentials elsewhere',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 await assert.rejects(safeTransport('https://127.0.0.1/'),e=>e.code==='UNSAFE_ENDPOINT');
 await assert.rejects(safeTransport('http://public.example/'),e=>e.code==='UNSAFE_ENDPOINT');
});
async function harness(t,{textTransport,imageTransport,timeoutMs=3000,budgetCny=5}={}){
 const dir=root(t),s=createApiSettings({root:dir,fallback:{text:'sk-'+KEY,image:KEY}}),bytes=fixturePNG('SYNTHETIC REFERENCE',512,512),calls=[];
 const config={modelCallsPaused:false,planningMode:'rules-v2',accountConfirmed:true,budgetId:'providers-test',budgetCny,reservePerImageCny:.12,priceEvidence:'SYNTHETIC',authorizationEvidence:'SYNTHETIC',authorizedReferenceHashes:[hash(bytes)],mimo:{model:'mimo-v2.6-flash',billing:'pay-as-you-go',accountConfirmed:true,authorizationEvidence:'SYNTHETIC',authorizedReferenceHashes:[hash(bytes)]}};
 const runtime=createRuntime({dataDir:path.join(dir,'.private/data'),config,apiSettings:s,recognizeText:null,connectionTimeoutMs:timeoutMs,
  mimoTransport:async(url,o)=>{calls.push({kind:'text',url,options:o});if(textTransport)return textTransport(url,o);const p=JSON.parse(o.body);let data;try{data=JSON.parse(p.messages[1].content.at(-1).text);}catch{}return fixtureResponse(data?fixtureOutput(data):{ok:true,color:'red'},{model:p.model});},
  imageTransport:async(url,o)=>{calls.push({kind:'image',url,options:o});if(imageTransport)return imageTransport(url,o);const b=JSON.parse(o.body);return b.model.startsWith('hy-')?json({choices:[{delta:{image:{url:'https://images.example.com/test.png'}}}]}):json({model:b.model,data:[{b64_json:fixturePNG('SYNTHETIC IMAGE',...b.size.split('x').map(Number)).toString('base64')}]});},
  downloadTransport:async()=>new Response(fixturePNG('SYNTHETIC DOWNLOAD',1024,1024))});
 const server=http.createServer(runtime.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await runtime.close();});
 const url=`http://127.0.0.1:${server.address().port}/api/backend-v1`;
 const api=async(p,body,method=body?'POST':'GET',extra={})=>{const r=await fetch(url+p,{method,headers:{'Content-Type':'application/json','X-Backend-Client':'local-development',...extra},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 let p=runtime.store.createProduct({name:'provider fixture',facts:{confirmed:[],unknowns:[],userInput:{version:1,text:'测试商品外观',source:{kind:'user-provided'}}}});const a=runtime.store.putAsset(bytes,{kind:'original',name:'fixture.png',mediaType:'image/png'});p=runtime.store.addReference(p.id,{assetId:a.id,role:'product'});
 return {s,runtime,config,api,p,calls};
}
async function waitFor(fn){for(let i=0;i<300;i++){const r=await fn();if(!['running','queued'].includes(r.state))return r;await new Promise(r=>setTimeout(r,10));}throw Error('TEST_TIMEOUT');}
const startBody=(h,kind,override={})=>({id:randomUUID(),kind,revision:h.s.view().revision,draft:{...strip(c(kind,kind==='text'?'qwen':'hunyuan-image')),...override}});
test('unsaved connection tests return true response checks, respect shared budget, do not change keys or create product results',async t=>{
 const h=await harness(t),original=h.s.view().revision,before=h.runtime.store.all('SELECT * FROM assets');
 for(const kind of ['text','image']){
  const body=startBody(h,kind);assert.equal((await h.api('/api-settings/test',body)).status,202);
  const result=await waitFor(async()=> (await h.api('/api-settings/test/'+body.id)).body);
  assert.equal(result.state,'succeeded',result.message);if(kind==='image')assert.ok(result.preview.startsWith('data:image/png;base64,'));
  assert.equal((await h.api('/api-settings/test',body)).body.id,body.id);
 }
 assert.equal(h.calls.length,2);assert.equal(h.s.view().revision,original);assert.deepEqual(h.runtime.store.all('SELECT * FROM assets'),before);
 assert.equal(h.runtime.store.tasks().length,0);assert.equal(ledgerState(h.runtime.store,h.config).reservedCny,.24);
 assert.ok(!JSON.stringify(h.runtime.store.all('SELECT * FROM connection_tests')).includes(KEY));
 assert.equal((await h.api('/api-settings/test',startBody(h,'text'), 'POST',{Origin:'https://foreign.example'})).status,403);
});
test('authentication rejection is actionable without echo; timeout and cancel stop waiting and never repeat a request',async t=>{
 const denied=await harness(t,{textTransport:async()=>new Response(KEY,{status:401})});const request=startBody(denied,'text');await denied.api('/api-settings/test',request);const r=await waitFor(async()=> (await denied.api('/api-settings/test/'+request.id)).body);assert.equal(r.state,'failed');assert.equal(r.errorCode,'MODEL_AUTH');assert.ok(!JSON.stringify(r).includes(KEY));
 const hanging=await harness(t,{textTransport:async(_url,o)=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(Error('aborted')));})});
 const b=startBody(hanging,'text');await hanging.api('/api-settings/test',b);
 assert.equal((await hanging.api('/api-settings',{revision:hanging.s.view().revision,text:{key:'sk-REPLACEMENT_TEST_ONLY'}},'PUT')).status,409);
 await hanging.api('/api-settings/test/'+b.id+'/cancel',{});
 const stopped=await waitFor(async()=> (await hanging.api('/api-settings/test/'+b.id)).body);assert.equal(stopped.state,'canceled');assert.equal(hanging.calls.length,1);assert.equal(ledgerState(hanging.runtime.store,hanging.config).unknown,true);
 const low=await harness(t,{budgetCny:.01});assert.equal((await low.api('/api-settings/test',startBody(low,'image'))).body.error.code,'BUDGET_LIMIT');assert.equal(low.calls.length,0);
});
test('selected language model runs real application schema; selected image provider generates a complete kit and pins model for retries',async t=>{
 const h=await harness(t);h.s.save({revision:h.s.view().revision,text:strip(c('text','qwen')),image:strip(c('image','hunyuan-image'))});
 const r=h.runtime.textService.submit({kind:'understand',productId:h.p.id,productRevision:h.p.revision,description:'测试商品外观',settings},'qwen-understand');
 const done=await waitFor(()=>h.runtime.textService.get(r.run.id));assert.equal(done.state,'succeeded');assert.equal(done.model,'qwen3.5-plus');assert.ok(h.calls[0].url.includes('dashscope'));
 const submitted=await h.api('/kits',{productId:h.p.id,productRevision:h.p.revision,description:'测试商品外观',settings:{...settings,ratio:'1:1'}},'POST',{'Idempotency-Key':randomUUID()});
 assert.equal(submitted.status,201,JSON.stringify(submitted.body));
 const task=await waitFor(()=>h.runtime.store.task(submitted.body.task.id));assert.equal(task.state,'succeeded',JSON.stringify({children:task.children.map(c=>({error:c.error,attempts:c.attempts})),calls:h.runtime.store.all('SELECT state,error_code FROM provider_calls')}));assert.equal(task.children.length,7);assert.equal(task.input.versions.modelId,'hy-image-v3.5-preview');assert.equal(task.input.settings.modelConnection.providerId,'hunyuan-image');
 assert.equal(h.calls.filter(c=>c.kind==='image').length,7);assert.ok(!JSON.stringify(h.runtime.store.all('SELECT * FROM provider_calls')).includes(KEY));
 h.s.save({revision:h.s.view().revision,image:{providerId:'seedream'}});
 const correction=await h.api('/results/'+task.children[0].result.id+'/corrections',{expectedVersion:1,instruction:'保持背景'},'POST',{'Idempotency-Key':randomUUID()});assert.equal(correction.body.error.code,'MODEL_CHANGED');
});
test('MiniMax thinking remains enabled with a usable token budget and split reasoning',()=>{
 const p=chatPayload(c('text','minimax'),[{role:'user',content:'JSON'}],128);
 assert.equal(p.thinking,undefined);assert.equal(p.reasoning_effort,'low');assert.equal(p.reasoning_split,true);assert.equal(p.max_completion_tokens,2048);
});
test('timeout stays unknown and does not automatically resend; no reservation means no request',async t=>{
 const h=await harness(t,{timeoutMs:30,textTransport:async(_url,o)=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Error('timeout'))))});
 const b=startBody(h,'text');assert.equal((await h.api('/api-settings/test',b)).status,202);const r=await waitFor(async()=> (await h.api('/api-settings/test/'+b.id)).body);
 assert.equal(r.state,'failed');assert.equal(r.errorCode,'MODEL_OUTCOME_UNKNOWN');assert.equal(h.calls.length,1);
 const blocked=await h.api('/api-settings/test',startBody(h,'text'));assert.equal(blocked.body.error.code,'BILLING_UNKNOWN');assert.equal(h.calls.length,1);
 const fresh=await harness(t);const noPrice=startBody(fresh,'text',{reserveCny:null});assert.equal((await fresh.api('/api-settings/test',noPrice)).body.error.code,'MODEL_PRICE_REQUIRED');assert.equal(fresh.calls.length,0);
});

test('completed connection tests remain idempotent after service reconstruction; sent tests recover as unknown',async t=>{
 const h=await harness(t),b=startBody(h,'text');await h.api('/api-settings/test',b);await waitFor(async()=> (await h.api('/api-settings/test/'+b.id)).body);
 const second=createConnectionTests({store:h.runtime.store,config:h.config,apiSettings:h.s,textTransport:async()=>{throw Error('MUST_NOT_CALL');}});
 assert.equal(second.start(b).state,'succeeded');assert.equal(h.calls.length,1);
 h.runtime.store.run("INSERT INTO connection_tests VALUES(?,?,?,?,?,?,?,?,?)",'interrupted-test','text',h.config.budgetId,.12,'sent','{}',Date.now(),null,null);
 const restored=createConnectionTests({store:h.runtime.store,config:h.config,apiSettings:h.s});
 assert.equal(restored.get('interrupted-test').errorCode,'PROCESS_INTERRUPTED');assert.equal(ledgerState(h.runtime.store,h.config).unknown,true);
});
test('v1 key migration preserves both roles and clearing removes the obsolete key copy',t=>{
 const dir=root(t);fs.mkdirSync(path.join(dir,'.private'),{mode:0o700});const file=path.join(dir,'.private/api-settings.json');
 fs.writeFileSync(file,JSON.stringify({version:1,revision:'old',keys:{text:'sk-'+KEY,image:KEY}}),{mode:0o600});
 const s=createApiSettings({root:dir});s.save({revision:'old',text:{clear:true}});
 const saved=JSON.parse(fs.readFileSync(file));assert.deepEqual(saved.keys,{});assert.equal(saved.profiles.text.mimo.key,'');assert.equal(saved.profiles.image.seedream.key,KEY);
 assert.equal(createApiSettings({root:dir}).key('text'),'');assert.equal(createApiSettings({root:dir}).key('image'),KEY);
});
