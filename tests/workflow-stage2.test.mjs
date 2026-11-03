import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inputFixture,deterministicHandlers,fixturePNG} from './workflow/fixtures.mjs';
import {prepareWorkflow,createStage2Submission,createStage2Processor,processorIdentity,WorkflowError} from '../src/workflow/index.js';

// Opt-in sibling workspace import; the 03A unit suite runs without any backend checkout.
const root=process.env.STAGE2_WORKSPACE||fileURLToPath(new URL('..',import.meta.url));
const integration=(name,work)=>test(name,{skip:!root && 'Set STAGE2_WORKSPACE to test against the existing 02A backend'},work);
async function setup(t,options={}) {
  const [{Store},{Executor},{ProcessorError}]=await Promise.all(['store','executor','core'].map(n=>import(pathToFileURL(path.join(root,`backend/${n}.mjs`)))));
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-03a-integration-'));
  const handlers=deterministicHandlers({readReferences:true,...options}),processor=createStage2Processor({handlers,ProcessorError});
  const store=new Store({dataDir:path.join(dir,'data'),processor:processorIdentity(processor),config:{pollMs:5,leaseMs:1500,timeoutMs:500,retryBaseMs:5,maxAttempts:3}});
  let executor;
  t.after(async()=>{if(executor)await executor.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const input=inputFixture();
  let p=store.createProduct({name:input.product.name,facts:{confirmed:input.product.facts,unknowns:input.product.unknowns}});
  const refMap=new Map();
  for(const reference of input.product.references) {
    const asset=store.putAsset(fixturePNG(reference.id),{kind:'original',name:`${reference.id}.png`,mediaType:'image/png'});
    p=store.addReference(p.id,{assetId:asset.id,role:reference.role});refMap.set(reference.id,p.references.at(-1));
  }
  input.product={...input.product,id:p.id,revision:p.revision,references:input.product.references.map(r=>({...refMap.get(r.id),purpose:r.purpose}))};
  input.product.references.forEach(r=>delete r.position);
  input.layouts.forEach(l=>{if(l.referenceId)l.referenceId=refMap.get(l.referenceId).id;});
  const prepared=await prepareWorkflow(input,handlers);assert.equal(prepared.status,'ready',JSON.stringify(prepared.error));
  const submission=createStage2Submission(prepared,p,'test-kit');
  const task=store.submit(submission.body,submission.headers['Idempotency-Key']).task;
  return {store,handlers,processor,prepared,submission,task,start(){executor=new Executor(store,processor).start();return executor;}};
}
async function terminal(store,id) {
  const until=Date.now()+4000;
  while(Date.now()<until) {const task=store.task(id);if(['succeeded','partial','failed','canceled'].includes(task.state))return task;await new Promise(r=>setTimeout(r,5));}
  assert.fail('02A executor did not reach terminal state');
}
integration('03A + actual 02A: seven valid PNGs persisted and idempotent submission reused',async t=>{
  const x=await setup(t);x.start();const result=await terminal(x.store,x.task.id);
  assert.equal(result.state,'succeeded');assert.equal(result.children.length,7);
  assert.equal(x.store.submit(x.submission.body,'test-kit').task.id,x.task.id);
  for(const child of result.children) {
    assert.equal(child.attempts.length,1);assert.equal(child.result.versions.length,1);
    const asset=x.store.asset(child.result.versions[0].assetId);assert.equal(asset.width,64);assert.equal(asset.height,64);
    assert.ok(x.store.readAsset(asset.id).length>33);
  }
  assert.equal(result.input.settings.workflow03A.digest,x.prepared.digest);
});
integration('03A + actual 02A: partial kit retries only selected failed child',async t=>{
  const x=await setup(t,{failures:{'scene-1':{untilAttempt:1}}});x.start();const partial=await terminal(x.store,x.task.id);
  assert.equal(partial.state,'partial');const failed=partial.children.find(c=>c.state==='failed');assert.equal(failed.slot.key,'scene-1');
  const originals=partial.children.filter(c=>c.state==='succeeded').map(c=>({id:c.id,result:c.result,attempts:c.attempts}));
  x.store.retry(x.task.id,{expectedRevision:partial.revision,childIds:[failed.id]});
  const success=await terminal(x.store,x.task.id);assert.equal(success.state,'succeeded');
  for(const expected of originals) {const actual=success.children.find(c=>c.id===expected.id);assert.deepEqual(actual.result,expected.result);assert.deepEqual(actual.attempts,expected.attempts);}
  assert.equal(success.children.find(c=>c.id===failed.id).attemptCount,2);
});
integration('03A + actual 02A: ProcessorError identity preserves retryable errors',async t=>{
  const x=await setup(t,{failures:{'other-1':{code:'TRANSIENT',retryable:true,untilAttempt:1}}});x.start();
  const result=await terminal(x.store,x.task.id);assert.equal(result.state,'succeeded');
  assert.equal(result.children.find(c=>c.slot.key==='other-1').attemptCount,2);
  assert.ok(result.children.filter(c=>c.slot.key!=='other-1').every(c=>c.attemptCount===1));
});
integration('03A + actual 02A: tampered snapshot rejected before generation and unknown outcomes do not retry',async t=>{
  const x=await setup(t);
  const request={inputSnapshot:structuredClone(x.task.input),slot:x.task.input.slots[0],attempt:{ordinal:1},idempotencyKey:'child',signal:new AbortController().signal,
    readAsset:()=>{throw new Error('Must not read');},reportStage:()=>{}};
  request.inputSnapshot.product.id='wrong-product';
  await assert.rejects(x.processor.execute(request),{code:'INVALID_REQUEST'});assert.ok(!x.handlers.calls.some(c=>c.startsWith('generate:')));
  x.handlers.generate=async()=>{throw new WorkflowError('TIMEOUT',[],{retryable:true,outcomeUnknown:true});};
  x.start();const result=await terminal(x.store,x.task.id);assert.equal(result.state,'failed');
  assert.ok(result.children.every(c=>c.attemptCount===1 && c.error.outcomeUnknown));
  assert.throws(()=>x.store.retry(x.task.id,{expectedRevision:result.revision,childIds:[result.children[0].id]}));
});
