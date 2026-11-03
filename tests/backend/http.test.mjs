import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApi } from '../../backend/http.mjs';
import { Executor } from '../../backend/executor.mjs';
import { testProcessor,fixturePNG } from './test-processor.mjs';
import { sandbox,storeAt,done } from './helpers.mjs';

test('loopback HTTP contract: upload, references, immutable submit, results, events, errors and content',async t=>{
  const dir=sandbox(t),s=storeAt(dir),e=new Executor(s,testProcessor()).start();let api;
  t.after(async()=>{if(api)await api.close();await e.stop();s.close();});
  api=await startApi({store:s,executor:e,port:0});
  const request=async(route,{method='GET',body,headers={}}={})=>{
    const res=await fetch(api.url+route,{method,headers:{'x-backend-client':'local-development',...(body&&!(body instanceof Buffer)?{'content-type':'application/json'}:{}),...headers},body:body instanceof Buffer?body:body?JSON.stringify(body):undefined});
    return {status:res.status,data:await res.json()};
  };
  assert.notEqual(new URL(api.url).port,'5178');
  assert.equal((await request('/health')).data.mode,'TEST_ONLY');
  const p=(await request('/products',{method:'POST',body:{name:'HTTP test'}})).data;
  const a=await request('/assets',{method:'POST',body:fixturePNG('http1'),headers:{'content-type':'image/png','x-asset-name':'a.png'}});assert.equal(a.status,201);
  await request(`/products/${p.id}/references`,{method:'POST',body:{assetId:a.data.id}});
  const b=await request('/assets',{method:'POST',body:fixturePNG('http2'),headers:{'content-type':'image/png'}});
  const attached=await request(`/products/${p.id}/references`,{method:'POST',body:{assetId:b.data.id}});assert.equal(attached.data.references.length,2);
  const input={productId:p.id,productRevision:attached.data.revision,slots:[{key:'a',type:'test'}]};
  const submitted=await request('/tasks',{method:'POST',body:input,headers:{'idempotency-key':'http'}});assert.equal(submitted.status,201);
  const duplicate=await request('/tasks',{method:'POST',body:input,headers:{'idempotency-key':'http'}});assert.equal(duplicate.status,200);assert.equal(duplicate.data.task.id,submitted.data.task.id);
  const final=await done(s,submitted.data.task.id),assetId=final.children[0].result.versions[0].assetId;
  const content=await fetch(api.url+`/assets/${assetId}/content`);assert.equal(content.status,200);assert.equal(content.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await content.arrayBuffer()),s.readAsset(assetId));
  const events=(await request(`/tasks/${final.id}/events`)).data.events;assert.ok(events.length>2);
  assert.equal((await request(`/tasks/${final.id}/events?after=${events.at(-1).sequence}`)).data.events.length,0);
  assert.equal((await request('/products')).data.products.length,1);
  assert.equal((await request(`/assets/${a.data.id}`,{method:'DELETE'})).status,409);
  assert.equal((await request('/tasks',{method:'POST',body:input})).status,400);
  assert.equal((await request('/health',{headers:{origin:'https://untrusted.example'}})).status,403);
  // Node fetch rewrites Host; use the wire-level HTTP client to actually send the hostile Host.
  const badHost=await new Promise((resolve,reject)=>{http.get(api.url+'/health',{headers:{host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(badHost,403);
  const missing=await fetch(api.url+'/products',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":"x"}'});assert.equal(missing.status,403);
  const invalid=await fetch(api.url+'/products',{method:'POST',headers:{'content-type':'application/json','x-backend-client':'local-development'},body:'{bad'});assert.equal(invalid.status,400);
  assert.equal((await request('/assets',{method:'POST',body:Buffer.from('fake'),headers:{'content-type':'image/png'}})).status,400);
  assert.equal((await request('/../../store.sqlite')).status,404);
});

test('normal API has no test processor and no execution; forbidden application port is rejected',async t=>{
  const dir=sandbox(t),s=storeAt(dir,{processor:{id:'unconfigured',version:'0',replaySafe:false}});t.after(()=>s.close());
  await assert.rejects(startApi({store:s,port:5178}),{code:'INVALID_PORT'});
  const api=await startApi({store:s});t.after(()=>api.close());
  const health=await(await fetch(api.url+'/health')).json();assert.equal(health.mode,'NO_REAL_PROVIDER');assert.equal(health.executor,null);
});
