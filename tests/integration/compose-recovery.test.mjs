import test from 'node:test';import assert from 'node:assert/strict';
import {reusableComposeBase} from '../../backend/integration/compose-recovery.mjs';
test('local composition recovery reuses only a received base from the same failed compose and immutable plan',()=>{
 const request={prompt:{data:{copyMode:'source-aware-overlay'}},executionContext:{taskId:'task',childId:'child',attemptId:'retry'},image:{id:'image-2',size:{width:2048,height:2048}}};
 const workflow={planDigest:'pinned',trace:[{id:'generate',status:'succeeded'},{id:'compose',status:'failed',error:{code:'COMPOSE_FAILED'}}]},writes=[];
 const store={task:id=>{assert.equal(id,'task');return {input:{settings:{workflow03A:{digest:'pinned',plan:{images:[{id:'image-2',textMode:'source-aware-overlay'}]}}}},children:[{id:'child',slot:{key:'image-2'}}]};},get:(q,...args)=>{assert.match(q,/p.state='received'/);assert.match(q,/p.error_code IS NULL/);assert.deepEqual(args,['child','retry','task']);return {receipt_json:JSON.stringify({workflow}),call_id:'original-call',asset_id:'base',request_id:'actual-receipt'};},asset:()=>({id:'base',width:2048,height:2048,mediaType:'image/png'}),readAsset:()=>Buffer.from('synthetic bytes'),run:(...a)=>writes.push(a)};
 const result=reusableComposeBase(store,request);assert.equal(result.requestId,'actual-receipt');assert.equal(writes[0][1],'retry');assert.equal(writes[0][2],'original-call');
 workflow.planDigest='different';assert.equal(reusableComposeBase(store,request),null);workflow.planDigest='pinned';workflow.trace[1].error.code='OUTCOME_UNKNOWN';assert.equal(reusableComposeBase(store,request),null);
 assert.equal(reusableComposeBase(store,{...request,prompt:{data:{copyMode:'provider-rendered'}}}),null);assert.equal(writes.length,1);
});

test('explicit reframing binds the new attempt generation and leaves the original prompt immutable',async()=>{
 const {reframeRequest}=await import('../../backend/integration/compose-recovery.mjs');const request={executionContext:{attemptId:'new-attempt'},prompt:{version:'base.2',system:'顶部25%自然留白',data:{subject:{mode:'完整主体',box:[.1,.2,.8,.7]},intent:{action:'佩戴听歌'}}}};const original=structuredClone(request);let allowed=false;const store={get:(sql,id)=>{assert.match(sql,/a.generation=r.generation/);assert.equal(id,'new-attempt');return allowed?{version:'composition-reframe.1',source_call_id:'received-base'}:null;}};
 assert.equal(reframeRequest(store,request),null);allowed=true;const next=reframeRequest(store,request);assert.deepEqual(request,original);assert.equal(next.prompt.data.compositionRepair.explicitRegeneration,true);assert.equal(next.prompt.data.compositionRepair.sourceCallId,'received-base');assert.match(next.prompt.system,/35%/);assert.deepEqual(next.prompt.data.intent,original.prompt.data.intent);
});

test('local-only retry never falls through to a paid generation when the base cannot be reused',async()=>{
 const {withComposeRecovery}=await import('../../backend/integration/compose-recovery.mjs');let calls=0;
 const store={get:sql=>sql.includes('local_replays')?{exists:1}:null};
 const request={executionContext:{attemptId:'local'},prompt:{data:{copyMode:'none'}}};
 assert.throws(()=>withComposeRecovery(store,()=>{calls++;})(request),{code:'COMPOSE_FAILED'});assert.equal(calls,0);
});
