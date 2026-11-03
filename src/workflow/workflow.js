import {LIFESTYLE_TEMPLATE} from './lifestyle-design.js';
import {FULLCANVAS_TEMPLATE} from './fullcanvas-design.js';
import {isIntentTemplate,INTENT_TEMPLATE} from './intent-design.js';
import {ADAPTIVE_TEMPLATE,isAdaptiveTemplate,isReviewedTemplate} from './adaptive-design.js';
import {validAdaptiveLayers} from './adaptive-layout.js';
import {REVIEWED_TEMPLATE,reviewedLayers} from './reviewed-design.js';
import {ART_TEMPLATE,artLayers} from './art-directed-design.js';
import {BETA_TEMPLATE,betaLayers} from './beta-design.js';
import {TYPOGRAPHY_TEMPLATE,typographyLayers} from './typography-design.js';
import {VERSIONS, schemas, schemaIssues} from './contracts.js';
import {createPolicy} from './policy.js';
import {validateInput, validateUnderstanding, validatePlan, effectiveLayout} from './validation.js';
import {structuredPrompt, imagePrompt} from './prompts.js';
import {snapshot, digest, byteDigest, requireValid, ensure, WorkflowError, canonical} from './value.js';

const SAFE_CODES=new Set(['INVALID_INPUT','INVALID_POLICY','INVALID_UNDERSTANDING','INVALID_PLAN','DEPENDENCY_BLOCKED','SNAPSHOT_CHANGED','CANCELED',
  'OUTPUT_INVALID','QUALITY_REJECTED','TRANSIENT','RATE_LIMIT','TIMEOUT','OUTCOME_UNKNOWN','AUTH','REJECTED','COMPOSE_FAILED']);
function safeError(error,{external=false,replaySafe=false,diagnostics=true}={}) {
  const recognized=error instanceof WorkflowError && SAFE_CODES.has(error.code), code=recognized ? error.code : 'PROVIDER_FAILURE';
  const outcomeUnknown=!!error?.outcomeUnknown || external && !replaySafe && (!recognized || ['TIMEOUT','CANCELED'].includes(code));
  return {code,retryable:recognized && !outcomeUnknown && !!error.retryable && ['TRANSIENT','RATE_LIMIT','TIMEOUT'].includes(code),outcomeUnknown,
    // Only our structured validation diagnostics; never a raw provider message/body.
    issues:diagnostics && recognized && ['INVALID_INPUT','INVALID_UNDERSTANDING','INVALID_PLAN','OUTPUT_INVALID'].includes(code) ? error.issues : []};
}
function canceled(signal) { if (signal?.aborted) throw new WorkflowError('CANCELED'); }
async function node(trace,id,input,work,validate=()=>{},options={}) {
  const entry={id,version:VERSIONS.nodes,inputDigest:digest(input),outputDigest:null,status:'running',error:null}; trace.push(entry);
  let validating=false;
  try {
    canceled(options.signal);
    const out=await work(); canceled(options.signal); validating=true; validate(out);
    entry.outputDigest=digest(out); entry.status='succeeded'; return snapshot(out);
  } catch (error) {
    entry.error=safeError(error,{...options,diagnostics:validating}); entry.status='failed';
    const failure=new WorkflowError(entry.error.code,entry.error.issues,entry.error); failure.safe=entry.error; throw failure;
  }
}
export function preparedDigest(prepared) {
  return digest({input:prepared.input,policy:prepared.policy,understanding:prepared.understanding,plan:prepared.plan,versions:prepared.versions,handlers:prepared.handlers,...(prepared.modelConnection?{modelConnection:prepared.modelConnection}:{}),...(prepared.effectiveSettings?{effectiveSettings:prepared.effectiveSettings}:{}),...(prepared.minimumMvp?{minimumMvp:prepared.minimumMvp}:{})});
}
function handlerIdentity(handlers) {
  ensure(handlers && ['id','version'].every(k=>typeof handlers[k]==='string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(handlers[k])) && typeof handlers.replaySafe==='boolean','INVALID_INPUT');
  return {id:handlers.id,version:handlers.version,replaySafe:handlers.replaySafe};
}
export function assertPrepared(prepared) {
  ensure(prepared?.status==='ready' && canonical(prepared.versions)===canonical(VERSIONS),'SNAPSHOT_CHANGED');
  handlerIdentity(prepared.handlers);
  ensure(prepared.digest===preparedDigest(prepared),'SNAPSHOT_CHANGED');
  ensure(prepared.plan.images.every(i=>!['provider-rendered','source-aware-overlay'].includes(i.textMode)||prepared.minimumMvp?.plan?.images.some(p=>p.id===i.id)),'SNAPSHOT_CHANGED');
  requireValid(validatePlan(prepared.input,prepared.understanding,prepared.plan,prepared.policy),'INVALID_PLAN');
}

/** One bounded preparation call. Caller owns persistence and scheduling. */
export async function prepareWorkflow(rawInput,handlers,{policy,signal}={}) {
  const trace=[], output={status:'failed',versions:VERSIONS,trace};
  try {
    output.policy=createPolicy(policy); output.input=snapshot(rawInput);
    output.handlers=handlerIdentity(handlers);
    requireValid(validateInput(output.input,output.policy));
    output.understanding=await node(trace,'understand',output.input,
      ()=>handlers.understand({input:output.input,prompt:structuredPrompt('understand',output.input),signal}),
      u=>requireValid(validateUnderstanding(output.input,u),'INVALID_UNDERSTANDING'),{signal,external:true,replaySafe:handlers.replaySafe===true});
    output.plan=await node(trace,'plan',{input:output.input,understanding:output.understanding,policy:output.policy},
      ()=>handlers.plan({input:output.input,understanding:output.understanding,policy:output.policy,
        prompt:structuredPrompt('plan',{input:output.input,understanding:output.understanding,policy:output.policy}),signal}),
      plan=>requireValid(schemaIssues(schemas.plan,plan),'INVALID_PLAN'),{signal,external:true,replaySafe:handlers.replaySafe===true});
    await node(trace,'validate',{input:output.input,understanding:output.understanding,plan:output.plan,policy:output.policy},
      ()=>({valid:true,policyVersion:output.policy.version}),
      ()=>requireValid(validatePlan(output.input,output.understanding,output.plan,output.policy),'INVALID_PLAN'),{signal});
    output.status='ready'; output.digest=preparedDigest(output);
  } catch (e) { output.error=e.safe??safeError(e); }
  return snapshot(output);
}

function validateRaster(raster,image) {
  requireValid(schemaIssues(schemas.raster,raster),'OUTPUT_INVALID');
  const bytes=Buffer.from(raster.base64,'base64');
  ensure(bytes.toString('base64')===raster.base64 && bytes.length>=33 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) &&
    bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16)===image.size.width && bytes.readUInt32BE(20)===image.size.height &&
    raster.width===image.size.width && raster.height===image.size.height,'OUTPUT_INVALID');
  // Full decoder/CRC validation belongs to the asset adapter (02A already validates PNG).
}
export function editableLayers(input,image) {
  const layout=effectiveLayout(input,image);
  return snapshot(image.copy.map(copy=>({kind:'text',text:copy.text,factIds:copy.factIds,slotId:copy.slotId,
    box:layout.textSlots.find(s=>s.id===copy.slotId).box,language:input.requirements.language})));
}
function executionLayers(prepared,image){
 if(image.textMode==='source-aware-overlay'){ensure([TYPOGRAPHY_TEMPLATE,BETA_TEMPLATE,ART_TEMPLATE,REVIEWED_TEMPLATE,ADAPTIVE_TEMPLATE,INTENT_TEMPLATE,FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(prepared.minimumMvp?.templateVersion),'SNAPSHOT_CHANGED');return snapshot(isReviewedTemplate(prepared.minimumMvp.templateVersion)?reviewedLayers(prepared,image):prepared.minimumMvp.templateVersion===ART_TEMPLATE?artLayers(prepared,image):prepared.minimumMvp.templateVersion===BETA_TEMPLATE?betaLayers(prepared,image):typographyLayers(prepared,image));}
 return editableLayers(prepared.input,image);
}
function checkpointDigest(checkpoint) {
  const {digest:ignored,...data}=checkpoint; return digest(data);
}
function sealCheckpoint(data) { return snapshot({...data,digest:checkpointDigest(data)}); }
function dependencyPins(prepared,image,results) {
  return image.dependencies.map(dep=>{
    const result=results[dep.imageId], version=result?.versions?.find(v=>v.version===result.currentVersion);
    ensure(result?.status==='succeeded' && result.imageId===dep.imageId && result.planDigest===prepared.digest && version,'DEPENDENCY_BLOCKED');
    ensure(version.artifact.sha256===byteDigest(Buffer.from(version.raster.base64,'base64')),'DEPENDENCY_BLOCKED');
    return {imageId:dep.imageId,version:version.version,artifactId:version.artifact.id,sha256:version.artifact.sha256,use:dep.use};
  });
}

/** Executes one image only, no background loop, sleep, retry or persistence. */
export async function executeImage(prepared,imageId,handlers,{
  results={},attempt=1,idempotencyKey=imageId,signal,readAsset,reportStage=()=>{},resume=null
}={}) {
  assertPrepared(prepared);
  ensure(canonical(handlerIdentity(handlers))===canonical(prepared.handlers),'SNAPSHOT_CHANGED');
  const image=prepared.plan.images.find(x=>x.id===imageId);
  ensure(image && Number.isSafeInteger(attempt) && attempt>0,'INVALID_INPUT');
  const trace=[], output={imageId,planDigest:prepared.digest,status:'failed',trace,checkpoint:null};
  let pins, prompt;
  try {
    if (resume) {
      ensure(resume.digest===checkpointDigest(resume) && resume.planDigest===prepared.digest && resume.imageId===imageId &&
        ['generated','composed'].includes(resume.stage),'SNAPSHOT_CHANGED');
      validateRaster(resume.generated,image);
      if (resume.composed) {
        validateRaster(resume.composed.raster,image);
        ensure(isAdaptiveTemplate(prepared.minimumMvp?.templateVersion)?validAdaptiveLayers(executionLayers(prepared,image),resume.composed.layers):canonical(resume.composed.layers)===canonical(executionLayers(prepared,image)),'SNAPSHOT_CHANGED');
      }
      ensure(Array.isArray(resume.pins) && resume.pins.length===image.dependencies.length,'SNAPSHOT_CHANGED');
      // Resume must retain exactly the versions it originally consumed, even if an upstream image has since rerun.
      for (const pin of resume.pins) {
        const source=results[pin.imageId], v=source?.versions?.find(x=>x.version===pin.version);
        ensure(image.dependencies.some(d=>d.imageId===pin.imageId) && source.planDigest===prepared.digest &&
          v?.artifact.id===pin.artifactId && v.artifact.sha256===pin.sha256,'DEPENDENCY_BLOCKED');
      }
      pins=resume.pins;
    } else pins=dependencyPins(prepared,image,results);
    prompt=await node(trace,'assemble',{image,pins,planDigest:prepared.digest},()=>imagePrompt(prepared,image,pins),undefined,{signal});
    const common={image,prompt,signal,attempt,idempotencyKey,
      dependencyArtifacts:pins.map(pin=>snapshot(results[pin.imageId].versions.find(v=>v.version===pin.version))),
      // Grant only references selected for this image, not every asset in the task.
      readAsset:assetId=>{
        ensure(prompt.data.references.some(r=>r.assetId===assetId),'INVALID_INPUT');
        ensure(typeof readAsset==='function','INVALID_INPUT'); return readAsset(assetId);
      }};
    const generated=resume?.generated??await node(trace,'generate',{prompt,attempt,idempotencyKey},()=>{
      reportStage('processing'); return handlers.generate(common);
    },r=>validateRaster(r,image),{signal,external:true,replaySafe:handlers.replaySafe===true});
    output.checkpoint=sealCheckpoint({stage:'generated',planDigest:prepared.digest,imageId,pins,generated,composed:null});
    const layers=executionLayers(prepared,image);
    const composed=resume?.stage==='composed' ? resume.composed : await node(trace,'compose',{generated,layers},()=>handlers.compose({...common,raster:generated,layers}),value=>{
      ensure(value && Object.keys(value).sort().join(',')==='layers,raster','OUTPUT_INVALID');
      validateRaster(value.raster,image);
      ensure(isAdaptiveTemplate(prepared.minimumMvp?.templateVersion)?validAdaptiveLayers(layers,value.layers):canonical(value.layers)===canonical(layers),'OUTPUT_INVALID');
      ensure(generated.provenance!=='test-only' || value.raster.provenance==='test-only','OUTPUT_INVALID');
    },{signal});
    output.checkpoint=sealCheckpoint({stage:'composed',planDigest:prepared.digest,imageId,pins,generated,composed});
    const quality=await node(trace,'inspect',{composed,image},()=>handlers.inspect({...common,composed,understanding:prepared.understanding}),value=>{
      requireValid(schemaIssues(schemas.quality,value),'OUTPUT_INVALID');
      output.quality=snapshot(value);
      ensure(value.passed && !value.issues.some(x=>x.severity==='error'),'QUALITY_REJECTED');
      ensure(composed.raster.provenance!=='test-only' || value.evidence==='test-only','OUTPUT_INVALID');
    },{signal});
    const sha256=byteDigest(Buffer.from(composed.raster.base64,'base64'));
    output.status='succeeded'; output.value=snapshot({raster:composed.raster,layers:composed.layers,quality,dependencyPins:pins,
      artifact:{id:`artifact-${sha256}`,sha256,mediaType:composed.raster.mediaType,width:image.size.width,height:image.size.height,provenance:composed.raster.provenance}});
  } catch (e) {
    output.error=e.safe??safeError(e);
    if (output.error.code==='DEPENDENCY_BLOCKED') output.status='blocked';
    if (output.error.code==='CANCELED') output.status='canceled';
  }
  return snapshot(output);
}

/** Explicit local result reducer for tests/callers. Durable versions remain owned by 02A. */
export function recordImageResult(results,execution) {
  const next=structuredClone(results), previous=next[execution.imageId];
  ensure(!previous || previous.planDigest===execution.planDigest,'SNAPSHOT_CHANGED');
  const attempts=[...(previous?.attempts??[]),{status:execution.status,trace:execution.trace,error:execution.error??null}];
  const versions=[...(previous?.versions??[])];
  if (execution.status==='succeeded') versions.push({...execution.value,version:versions.length+1});
  next[execution.imageId]={imageId:execution.imageId,planDigest:execution.planDigest,
    status:versions.length ? 'succeeded' : execution.status,lastAttemptStatus:execution.status,attempts,versions,
    currentVersion:versions.length || null,checkpoint:execution.checkpoint,error:execution.error??null};
  return snapshot(next);
}
export async function rerunImage(prepared,results,imageId,handlers,options={}) {
  const previous=results[imageId]; ensure(previous && previous.planDigest===prepared.digest,'SNAPSHOT_CHANGED');
  ensure(!previous.error?.outcomeUnknown,'OUTCOME_UNKNOWN');
  const execution=await executeImage(prepared,imageId,handlers,{...options,results,attempt:previous.attempts.length+1});
  return {execution,results:recordImageResult(results,execution)};
}
export function aggregateResults(prepared,results) {
  const progress={total:prepared.plan.images.length,succeeded:0,failed:0,blocked:0,canceled:0,pending:0};
  for (const image of prepared.plan.images) {
    const r=results[image.id]; ensure(!r || r.planDigest===prepared.digest,'SNAPSHOT_CHANGED');
    progress[r?.status??'pending']++;
  }
  const status=progress.pending ? 'pending' : progress.succeeded===progress.total ? 'succeeded' : progress.succeeded ? 'partial' : 'failed';
  return snapshot({status,progress});
}
