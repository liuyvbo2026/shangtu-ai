import {VERSIONS} from './contracts.js';
import {assertPrepared, executeImage} from './workflow.js';
import {canonical, ensure, snapshot} from './value.js';

export const STAGE2_CONTRACT='backend-v1-provisional';
export const processorIdentity = ({id,version,replaySafe}) => ({id,version,replaySafe});
function verifyProduct(prepared,product,references=product.references) {
  const p=prepared.input.product;
  ensure(product.id===p.id && product.revision===p.revision && product.name===p.name &&
    canonical(product.facts.confirmed)===canonical(p.facts) && canonical(product.facts.unknowns)===canonical(p.unknowns),'SNAPSHOT_CHANGED');
  const map=refs=>refs.map(r=>({id:r.id,assetId:r.assetId,role:r.role}));
  ensure(canonical(map(references))===canonical(map(p.references)),'SNAPSHOT_CHANGED');
}
export function stage2Body(prepared) {
  assertPrepared(prepared);
  // 02A readAsset only admits frozen original references; no generated sibling capability exists.
  ensure(prepared.plan.images.every(i=>i.dependencies.length===0),'STAGE2_DEPENDENCY_UNSUPPORTED');
  const r=prepared.input.requirements;
  return snapshot({productId:prepared.input.product.id,productRevision:prepared.input.product.revision,description:r.description,
    settings:{platform:r.platform,language:r.language,ratio:r.ratio,counts:r.counts,...(prepared.modelConnection?{modelConnection:prepared.modelConnection}:{}),...(prepared.effectiveSettings?{effectiveSettings:prepared.effectiveSettings}:{}),workflow03A:prepared},
    slots:prepared.plan.images.map((image,i)=>({key:image.id,type:image.type,index:i+1,layoutId:image.layoutId,size:image.size})),
    versions:{...VERSIONS,...(prepared.effectiveSettings?{integration:'round1.1'}:{}),handlers:prepared.handlers,policy:prepared.policy.version,model:prepared.policy.imageModel,modelId:prepared.policy.modelId}});
}
export function createStage2Submission(prepared,backendProduct,idempotencyKey) {
  verifyProduct(prepared,backendProduct);
  ensure(typeof idempotencyKey==='string' && idempotencyKey.length>0 && idempotencyKey.length<=200 && !/[\u0000-\u001f]/.test(idempotencyKey),'INVALID_INPUT');
  const body=stage2Body(prepared);
  ensure(Buffer.byteLength(JSON.stringify(body))<=256*1024,'STAGE2_PAYLOAD_LIMIT');
  return snapshot({contract:STAGE2_CONTRACT,method:'POST',path:'/api/backend-v1/tasks',
    headers:{'Content-Type':'application/json','X-Backend-Client':'local-development','Idempotency-Key':idempotencyKey},body});
}

/** Inject 02A's actual ProcessorError class: its executor classifies by instanceof. */
export function createStage2Processor({handlers,ProcessorError,id='workflow-03a-test-only',version=`${VERSIONS.workflow}:${handlers.version}`}) {
  ensure(typeof ProcessorError==='function' && typeof handlers.generate==='function','INVALID_INPUT');
  return {id,version,replaySafe:handlers.replaySafe===true,async execute(request) {
    try {
      const prepared=request.inputSnapshot.settings.workflow03A;
      assertPrepared(prepared); verifyProduct(prepared,request.inputSnapshot.product,request.inputSnapshot.references);
      const body=stage2Body(prepared);
      ensure(request.inputSnapshot.contractVersion===1 && canonical(body.slots)===canonical(request.inputSnapshot.slots) &&
        canonical(body.settings)===canonical(request.inputSnapshot.settings) && canonical(body.versions)===canonical(request.inputSnapshot.versions) &&
        body.description===request.inputSnapshot.description && body.slots.some(slot=>canonical(slot)===canonical(request.slot)),'SNAPSHOT_CHANGED');
      const executionContext={taskId:request.taskId,childId:request.childId,attemptId:request.attempt.id};
      const boundHandlers={...handlers,generate:args=>handlers.generate({...args,executionContext}),compose:args=>handlers.compose({...args,executionContext})};
      const execution=await executeImage(prepared,request.slot.key,boundHandlers,{
        attempt:request.attempt.ordinal,idempotencyKey:request.idempotencyKey,signal:request.signal,
        readAsset:request.readAsset,reportStage:request.reportStage
      });
      request.recordWorkflow?.({planDigest:execution.planDigest,trace:execution.trace,quality:execution.quality??execution.value?.quality??null});
      if (execution.status!=='succeeded') {
        const e=execution.error;
        const code=['TRANSIENT','RATE_LIMIT','TIMEOUT','AUTH','REJECTED','CANCELED','OUTCOME_UNKNOWN'].includes(e.code) ? e.code : 'OUTPUT_INVALID';
        throw new ProcessorError(code,{retryable:e.retryable,outcomeUnknown:e.outcomeUnknown});
      }
      const raster=execution.value.raster;
      // 02A currently persists bytes and a safe receipt only. Node traces/layers need the documented extension.
      return {bytes:Buffer.from(raster.base64,'base64'),mediaType:raster.mediaType,workflow:{planDigest:execution.planDigest,trace:execution.trace,layers:execution.value.layers,quality:execution.value.quality},...(raster.requestId ? {requestId:raster.requestId} : {})};
    } catch (e) {
      if (e instanceof ProcessorError) throw e;
      throw new ProcessorError('INVALID_REQUEST');
    }
  }};
}
