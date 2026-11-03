import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Executor } from '../../backend/executor.mjs';
import { testProcessor,TEST_CONTRACT,fixturePNG } from './test-processor.mjs';
import { ProcessorError } from '../../backend/core.mjs';
import { sandbox,storeAt,product,input,done,until,count,config } from './helpers.mjs';

async function cleanup(s,e) {await e.stop();s.close();}

test('successful queue records real stages and counts; duplicate settlement cannot create another result',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s),task=s.submit(input(p),'success').task;
  const e=new Executor(s,testProcessor()).start();t.after(()=>cleanup(s,e));
  const final=await done(s,task.id);assert.equal(final.state,'succeeded');assert.equal(final.progress.succeeded,3);assert.equal(final.progress.completed,3);
  assert.equal(count(s,'results'),3);assert.equal(count(s,'attempts'),3);
  const stages=s.events(task.id).filter(x=>x.kind==='stage').map(x=>x.data.stage);assert.ok(stages.includes('processing'));assert.ok(stages.includes('persisting'));
  for(const c of final.children){assert.equal(c.attemptCount,1);assert.equal(c.result.productId,p.id);assert.equal(c.result.versions[0].attemptId,c.attempts[0].id);}
  assert.equal(s.submit(input(p),'success').task.id,task.id);assert.equal(count(s,'results'),3);
});

test('single-image failure preserves successful siblings; manual retry targets only failed child and fences old attempt',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s),task=s.submit(input(p),'partial').task;
  const e=new Executor(s,testProcessor({b:{failFirst:1,code:'REJECTED',retryable:false}})).start();t.after(()=>cleanup(s,e));
  const partial=await done(s,task.id);assert.equal(partial.state,'partial');assert.equal(partial.progress.succeeded,2);assert.equal(partial.progress.failed,1);
  const ids=partial.children.filter(c=>c.result).map(c=>c.result.id),bad=partial.children[1],oldAttempt=bad.attempts[0];
  assert.throws(()=>s.retry(task.id,{childIds:[partial.children[0].id],expectedRevision:partial.revision}),{code:'TASK_NOT_RETRYABLE'});
  s.retry(task.id,{childIds:[bad.id],expectedRevision:partial.revision});
  assert.equal(s.complete({childId:bad.id,attemptId:oldAttempt.id,generation:oldAttempt.generation},{bytes:fixturePNG('stale')}),false);
  const final=await done(s,task.id);assert.equal(final.state,'succeeded');assert.equal(final.children[1].attemptCount,2);
  assert.deepEqual(final.children.filter((_,i)=>i!==1).map(c=>c.result.id),ids);assert.equal(count(s,'results'),3);assert.equal(count(s,'attempts'),4);
});

test('transient retry respects finite total attempts and backoff; permanent and unknown errors do not auto retry',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s);
  const task=s.submit(input(p,['transient','exhaust','auth','unknown']),'retry').task;
  const e=new Executor(s,testProcessor({transient:{failFirst:2},exhaust:{failAlways:true},auth:{failAlways:true,code:'AUTH'},unknown:{failAlways:true,outcomeUnknown:true}})).start();t.after(()=>cleanup(s,e));
  const final=await done(s,task.id);assert.equal(final.state,'partial');assert.deepEqual(final.children.map(c=>c.attemptCount),[3,3,1,1]);
  for(const c of final.children.slice(0,2)) for(let i=1;i<c.attempts.length;i++) assert.ok(c.attempts[i].startedAt>=c.attempts[i-1].endedAt+config.retryBaseMs*2**(i-1));
  assert.throws(()=>s.retry(task.id,{childIds:[final.children[1].id],expectedRevision:final.revision}),{code:'TASK_NOT_RETRYABLE'});
  assert.throws(()=>s.retry(task.id,{childIds:[final.children[3].id],expectedRevision:final.revision}),{code:'TASK_NOT_RETRYABLE'});
  assert.equal(final.children[3].error.outcomeUnknown,true);
});

test('queued cancellation makes zero attempts; running cancellation preserves results and drops ignored late output',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s);
  const queued=s.submit(input(p),'queued-cancel').task;s.cancel(queued.id);
  const active=s.submit(input(p),'running-cancel').task;
  const e=new Executor(s,testProcessor({b:{delayMs:100,ignoreAbort:true}})).start();t.after(()=>cleanup(s,e));
  await until(()=>s.task(active.id).children[1].state==='running','second child running');
  const before=s.task(active.id).children[0].result.id;
  const canceled=e.cancel(active.id);assert.equal(canceled.state,'canceled');
  await new Promise(resolve=>setTimeout(resolve,150));
  const final=s.task(active.id);assert.equal(final.children[0].result.id,before);assert.deepEqual(final.children.map(c=>c.state),['succeeded','canceled','canceled']);
  assert.equal(final.children[2].attemptCount,0);assert.equal(count(s,'results'),1);assert.equal(s.task(queued.id).children.every(c=>c.attemptCount===0),true);
  assert.equal(s.cancel(active.id).revision,final.revision);
});

test('timeout does not let a late success win; replay-safe retries stay bounded',async t=>{
  const dir=sandbox(t),s=storeAt(dir,{config:{...config,timeoutMs:15,maxAttempts:2}}),p=product(s);
  const task=s.submit(input(p,['slow']),'timeout').task;
  const e=new Executor(s,testProcessor({slow:{delayMs:80,ignoreAbort:true}})).start();t.after(()=>cleanup(s,e));
  const final=await done(s,task.id);assert.equal(final.state,'failed');assert.equal(final.children[0].attemptCount,2);assert.equal(final.children[0].error.code,'TIMEOUT');
  assert.equal(final.children[0].attempts.every(a=>a.state==='timed_out'),true);
  await new Promise(resolve=>setTimeout(resolve,110));assert.equal(count(s,'results'),0);assert.equal(count(s,'assets'),2);
});

test('non-replayable timeout is outcome unknown and is never automatically or manually repeated',async t=>{
  const dir=sandbox(t),contract={id:'unsafe-provider-fixture',version:'1',replaySafe:false},s=storeAt(dir,{config:{...config,timeoutMs:15},processor:contract}),p=product(s);
  const task=s.submit(input(p,['one']),'unsafe-timeout').task;
  const processor={...contract,execute:()=>new Promise(resolve=>setTimeout(()=>resolve({bytes:fixturePNG()}),80))};
  const e=new Executor(s,processor).start();t.after(()=>cleanup(s,e));
  const final=await done(s,task.id);assert.equal(final.children[0].attemptCount,1);assert.equal(final.children[0].error.outcomeUnknown,true);
  assert.throws(()=>s.retry(task.id,{childIds:[final.children[0].id],expectedRevision:final.revision}),{code:'TASK_NOT_RETRYABLE'});
  await new Promise(resolve=>setTimeout(resolve,90));assert.equal(count(s,'results'),0);
});

test('different products execute concurrently with immutable inputs and distinct correct outputs',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p1=product(s,'first',3),p2=product(s,'second',2);
  const t1=s.submit(input(p1,['slow','tail']),'p1').task,t2=s.submit(input(p2,['slow','tail']),'p2').task;
  const processor=testProcessor({slow:{delayMs:50}}),e=new Executor(s,processor).start();t.after(()=>cleanup(s,e));
  await until(()=>s.task(t1.id).progress.running===1&&s.task(t2.id).progress.running===1,'parallel products');
  s.updateProduct(p1.id,{name:'changed during execution',expectedRevision:p1.revision});
  const finished=await Promise.all([done(s,t1.id),done(s,t2.id)]);
  const hashes=new Set();
  for(const task of finished){
    assert.equal(task.state,'succeeded');const p=task.productId===p1.id?p1:p2;
    assert.equal(task.input.product.name,p.name);
    for(const c of task.children){
      const expected=await processor.execute({inputSnapshot:task.input,slot:c.slot,attempt:{ordinal:1},idempotencyKey:c.id,signal:new AbortController().signal,readAsset:id=>s.readAsset(id),reportStage:()=>{}});
      const asset=s.asset(c.result.versions[0].assetId);assert.equal(c.result.productId,p.id);assert.deepEqual(s.readAsset(asset.id),expected.bytes);hashes.add(asset.sha256);
    }
  }
  assert.equal(hashes.size,4);assert.equal(count(s,'products'),2);
});

test('SIGKILL after durable claim recovers only unfinished replay-safe work, retaining successful result IDs',async t=>{
  const dir=sandbox(t);let s=storeAt(dir),e;
  t.after(async()=>{if(e)await e.stop();if(!s.closed)s.close();});
  const p=product(s),task=s.submit(input(p),'crash').task,claim=s.claim(TEST_CONTRACT);
  s.complete(claim,{bytes:fixturePNG('already-saved')});const first=s.task(task.id).children[0].result.id;s.close();
  const worker=spawn(process.execPath,[new URL('./crash-worker.mjs',import.meta.url).pathname,s.root],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(worker.exitCode===null)worker.kill('SIGKILL');});
  const [chunk]=await Promise.race([once(worker.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(Error('crash worker timeout')),3000).unref())]);
  const claimed=JSON.parse(chunk.toString());assert.ok(claimed.attemptId);
  const exited=once(worker,'exit');worker.kill('SIGKILL');const [,signal]=await exited;assert.equal(signal,'SIGKILL');
  s=storeAt(dir);e=new Executor(s,testProcessor()).start();
  const final=await done(s,task.id);assert.equal(final.state,'succeeded');assert.equal(final.children[0].result.id,first);
  assert.deepEqual(final.children.map(c=>c.attemptCount),[1,2,1]);assert.equal(final.children[1].attempts[0].state,'interrupted');
  assert.equal(count(s,'results'),3);assert.equal(count(s,'result_versions'),3);assert.deepEqual(s.readAsset(final.children[0].result.versions[0].assetId),fixturePNG('already-saved'));
  await e.stop();e=null;s.close();s=storeAt(dir);e=new Executor(s,testProcessor()).start();
  assert.equal(count(s,'results'),3);assert.equal(count(s,'attempts'),4);
});

test('unknown interrupted calls are quarantined; successful siblings retained and no blind recovery',t=>{
  const dir=sandbox(t),contract={id:'unsafe-provider-fixture',version:'1',replaySafe:false},s=storeAt(dir,{processor:contract});t.after(()=>s.close());const p=product(s);
  const task=s.submit(input(p,['a','b']),'unknown-restart').task;
  s.complete(s.claim(contract),{bytes:fixturePNG('keep')});const claim=s.claim(contract);
  assert.equal(s.recover({all:true}),1);
  const final=s.task(task.id);assert.equal(final.state,'partial');assert.equal(final.children[1].error.code,'OUTCOME_UNKNOWN');assert.equal(final.children[1].attemptCount,1);
  assert.equal(s.claim(contract),null);assert.equal(s.complete(claim,{bytes:fixturePNG('late')}),false);assert.equal(count(s,'results'),1);
});

test('expired attempt lease fences late result; recovered newer attempt is sole publisher',t=>{
  const dir=sandbox(t),s=storeAt(dir);t.after(()=>s.close());const p=product(s),task=s.submit(input(p,['a']),'lease').task;
  const old=s.claim(TEST_CONTRACT);s.run('UPDATE children SET lease_until=0 WHERE id=?',old.childId);s.recover();
  const current=s.claim(TEST_CONTRACT);assert.notEqual(current.attemptId,old.attemptId);assert.ok(current.generation>old.generation);
  assert.equal(s.complete(old,{bytes:fixturePNG('old')}),false);assert.equal(s.complete(current,{bytes:fixturePNG('new')}),true);
  const final=s.task(task.id);assert.equal(final.children[0].attemptCount,2);assert.equal(count(s,'results'),1);assert.deepEqual(s.readAsset(final.children[0].result.versions[0].assetId),fixturePNG('new'));
});

test('processor scope and error boundary reject unrelated assets without persisting secret error text',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s),other=product(s,'other'),task=s.submit(input(p,['a']),'scope').task;
  const e=new Executor(s,{...TEST_CONTRACT,execute:request=>request.readAsset(other.references[0].assetId)}).start();t.after(()=>cleanup(s,e));
  const final=await done(s,task.id);assert.equal(final.state,'failed');assert.equal(final.children[0].error.code,'INTERNAL');assert.equal(count(s,'results'),0);
  assert.equal(JSON.stringify(final).includes(other.references[0].assetId),false);
});

test('stop drains current attempt but does not schedule remaining children; restart resumes remaining slots',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s),task=s.submit(input(p),'stop').task;
  let e=new Executor(s,testProcessor({a:{delayMs:40}})).start();t.after(()=>cleanup(s,e));
  await until(()=>s.task(task.id).children[0].state==='running');await e.stop();
  assert.deepEqual(s.task(task.id).children.map(c=>c.state),['succeeded','queued','queued']);
  e=new Executor(s,testProcessor()).start();const final=await done(s,task.id);assert.equal(final.state,'succeeded');assert.deepEqual(final.children.map(c=>c.attemptCount),[1,1,1]);
});

test('invalid output dimensions fail without publishing or leaking an unreferenced asset',async t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s),req=input(p,['a']);req.slots[0].size={width:10,height:10};
  const task=s.submit(req,'invalid-size').task,e=new Executor(s,testProcessor()).start();t.after(()=>cleanup(s,e));
  const final=await done(s,task.id);assert.equal(final.state,'failed');assert.equal(final.children[0].error.code,'OUTPUT_INVALID');
  assert.equal(count(s,'assets'),2);assert.equal(count(s,'results'),0);
});

test('unexpected provider exception is redacted and treated as outcome unknown for unsafe processors',async t=>{
  const dir=sandbox(t),contract={id:'unsafe-exception-fixture',version:'1',replaySafe:false},s=storeAt(dir,{processor:contract}),p=product(s);
  const task=s.submit(input(p,['a']),'secret-boundary').task;
  const e=new Executor(s,{...contract,execute:()=>{throw Error('Authorization: Bearer TEST_SECRET_MUST_NOT_PERSIST');}}).start();t.after(()=>cleanup(s,e));
  const final=await done(s,task.id);assert.equal(final.state,'failed');assert.equal(final.children[0].error.outcomeUnknown,true);assert.equal(final.children[0].attemptCount,1);
  assert.equal(JSON.stringify(final).includes('TEST_SECRET'),false);assert.equal(JSON.stringify(s.events(task.id)).includes('TEST_SECRET'),false);
  assert.throws(()=>s.retry(task.id,{childIds:[final.children[0].id],expectedRevision:final.revision}),{code:'TASK_NOT_RETRYABLE'});
});

test('explicit local replay remains bounded after normal attempts are exhausted and retains every failure',async t=>{
 const dir=sandbox(t),s=storeAt(dir,{config:{...config,maxAttempts:1}}),p=product(s),task=s.submit(input(p,['local']),'local-only').task;
 const e=new Executor(s,testProcessor({local:{failAlways:true,retryable:false}})).start();t.after(()=>cleanup(s,e));
 let current=await done(s,task.id);const child=current.children[0].id;
 assert.throws(()=>s.retry(task.id,{childIds:[child],expectedRevision:current.revision}),{code:'TASK_NOT_RETRYABLE'});
 for(let i=1;i<=3;i++){
  s.retry(task.id,{childIds:[child],expectedRevision:current.revision},()=>{},{localOnly:true});current=await done(s,task.id);
  assert.equal(current.children[0].localReplayCount,i);assert.equal(current.children[0].attempts.length,i+1);
 }
 assert.throws(()=>s.retry(task.id,{childIds:[child],expectedRevision:current.revision},()=>{},{localOnly:true}),{code:'TASK_NOT_RETRYABLE'});
 assert.equal(s.get('SELECT COUNT(*) n FROM local_replays').n,3);
});
