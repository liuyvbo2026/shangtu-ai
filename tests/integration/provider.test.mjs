// Contract tests with injected HTTP transport. Zero external/model requests.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../../backend/store.mjs';
import {createProviderHandlers,initLedger,readiness,ledgerState} from '../../backend/integration/provider.mjs';
import {planSubmission,MODEL} from '../../backend/integration/planning.mjs';
import {imagePrompt} from '../../src/workflow/prompts.js';
import {fixturePNG,settings} from './fixtures.mjs';
async function setup(t,transport){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-provider-contract-'));
 const identity={id:'provider-contract-test',version:'1',replaySafe:false},store=new Store({dataDir:dir,processor:identity});initLedger(store);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 let p=store.createProduct({name:'synthetic',facts:{confirmed:[],unknowns:[]}});const a=store.putAsset(fixturePNG('ref',32,32));p=store.addReference(p.id,{assetId:a.id,role:'product'});
 const config={modelCallsPaused:false,accountConfirmed:true,budgetId:'test-budget',budgetCny:2,reservePerImageCny:1,priceEvidence:'TEST ONLY upper bound',authorizationEvidence:'SYNTHETIC ONLY',authorizedReferenceHashes:[a.sha256]};
 const handlers=createProviderHandlers({store,config,key:'injected-test-credential',transport});
 const body=await planSubmission(store,handlers,{productId:p.id,productRevision:p.revision,settings,description:'synthetic transport contract'},'test');
 const task=store.submit(body,'test').task,claim=store.claim(identity),prepared=body.settings.workflow03A,image=prepared.plan.images[0],controller=new AbortController();
 const request={image,prompt:imagePrompt(prepared,image),attempt:1,signal:controller.signal,readAsset:id=>store.readAsset(id),executionContext:{taskId:task.id,attemptId:claim.attemptId}};
 return {store,handlers,config,request,controller};
}
const response=()=>new Response(JSON.stringify({model:MODEL,data:[{b64_json:fixturePNG('transport-result',864,1152).toString('base64')}],usage:{input_images:1,generated_images:1,total_tokens:3888}}),{headers:{'x-request-id':'request-fixture-1','Content-Type':'application/json'}});

test('official Flash request contract, audit, safe usage and PNG retained, no key in DB',async t=>{
 let sent;
 const h=await setup(t,async(url,options)=>{sent={url,options};return response();});
 const result=await h.handlers.generate(h.request),body=JSON.parse(sent.options.body);
 assert.equal(body.model,MODEL);assert.equal(body.output_format,'png');assert.equal(body.response_format,'b64_json');assert.equal(body.size,'864x1152');assert.equal(body.image.length,1);
 for(const key of ['stream','sequential_image_generation','tools','layer_decomposition'])assert.ok(!(key in body));
 assert.equal(result.provenance,'provider');const row=h.store.get('SELECT * FROM provider_calls');assert.equal(row.state,'received');assert.equal(row.request_id,'request-fixture-1');assert.equal(JSON.parse(row.usage_json).generated_images,1);
 assert.ok(!JSON.stringify(row).includes('injected-test-credential'));assert.ok(!row.request_json.includes('base64,'));assert.deepEqual(h.store.readAsset(row.asset_id),Buffer.from(result.base64,'base64'));
});
test('unknown network outcome retains reservation and blocks the next call',async t=>{
 let n=0;const h=await setup(t,async()=>{n++;throw Error('private upstream error with credential');});
 await assert.rejects(h.handlers.generate(h.request),e=>e.code==='OUTCOME_UNKNOWN');assert.equal(ledgerState(h.store,h.config).unknown,true);
 await assert.rejects(h.handlers.generate(h.request),e=>e.code==='REJECTED');assert.equal(n,1);assert.equal(ledgerState(h.store,h.config).reservedCny,1);
 assert.ok(!JSON.stringify(h.store.all('SELECT * FROM provider_calls')).includes('private upstream'));
});
test('late upstream output retained in audit without a published result',async t=>{
 let controller;const h=await setup(t,async()=>{controller.abort();return response();});controller=h.controller;
 await h.handlers.generate(h.request);const row=h.store.get('SELECT * FROM provider_calls');assert.equal(row.state,'late');assert.ok(row.asset_id);assert.equal(h.store.get('SELECT count(*) AS n FROM results').n,0);
});
test('authorization and finite budget gates prevent network calls',async t=>{
 let n=0;const h=await setup(t,async()=>{n++;return response();});h.config.authorizedReferenceHashes=[];
 await assert.rejects(h.handlers.generate(h.request),e=>e.code==='AUTH');assert.equal(n,0);
 assert.equal(readiness({...h.config,budgetCny:Infinity},'test').ready,false);assert.equal(readiness({},'').ready,false);
});
