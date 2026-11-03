import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {VERSIONS, TYPES, effectiveLayout, digest, WorkflowError} from '../../src/workflow/index.js';

export function inputFixture() {
  return {schemaVersion:VERSIONS.schema,product:{id:'test-cup',revision:1,name:'测试杯（合成资料）',
    facts:[{id:'f-color',key:'color',value:'蓝色',source:{kind:'user-confirmed',locator:'test-fixture:color'}},
      {id:'f-volume',key:'volume',value:'350 mL',source:{kind:'user-confirmed',locator:'test-fixture:volume'}}],
    unknowns:[{key:'material',reason:'未提供材质证明'}],references:[
      {id:'ref-front',assetId:'asset-front',role:'product',purpose:'确认商品正面外观'},
      {id:'ref-detail',assetId:'asset-detail',role:'detail',purpose:'杯口细节'},
      {id:'ref-style',assetId:'asset-style',role:'style',purpose:'仅参考光线和背景'},
      {id:'ref-layout',assetId:'asset-layout',role:'layout',purpose:'仅参考文字与主体位置'}]},
    requirements:{description:'独立测试套图，未知材质不得写入文案',platform:'test',language:'zh',counts:{white:1,selling:3,scene:2,other:1},ratio:'1:1',size:{width:64,height:64},layoutIds:['layout-one']},
    layouts:[{id:'layout-one',version:'test.1',allowedTypes:['selling'],ratios:['1:1','3:4','9:16','16:9'],referenceId:'ref-layout',
      subjectBox:[0.1,0.3,0.8,0.6],textSlots:[{id:'headline',box:[0.1,0.05,0.8,0.2],maxChars:32,maxLines:2}]}]};
}
function crc32(bytes) {
  let c=0xffffffff;
  for (const b of bytes) { c^=b; for(let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0); }
  return (c^0xffffffff)>>>0;
}
function chunk(type,bytes) {
  const body=Buffer.concat([Buffer.from(type),bytes]),len=Buffer.alloc(4),crc=Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([len,body,crc]);
}
export function fixturePNG(seed='test-only',width=1,height=1) {
  const rgb=createHash('sha256').update(seed).digest().subarray(0,3),head=Buffer.alloc(13);
  head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
  const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++)rgb.copy(row,1+x*3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:height},()=>row)))),chunk('IEND',Buffer.alloc(0))]);
}
export function understandingFixture(input) {
  return {schemaVersion:VERSIONS.schema,productId:input.product.id,productRevision:input.product.revision,
    facts:structuredClone(input.product.facts),unknowns:structuredClone(input.product.unknowns),references:structuredClone(input.product.references),
    inferred:[{id:'inferred-shape',key:'shape',value:'杯状轮廓（测试推断）',confidence:0.75,evidenceReferenceIds:[input.product.references.find(r=>r.role==='product').id]}],conflicts:[]};
}
export function planFixture(input,understanding) {
  const images=[];
  const purposes={white:['正面整体','背面整体','侧面轮廓'],selling:['颜色信息','容量信息','外观细节'],scene:['桌面展示','窗边展示','置物台展示'],other:['杯口特写','底部特写']};
  for (const type of TYPES) for(let i=0;i<input.requirements.counts[type];i++) {
    const layoutId=type==='selling' ? input.requirements.layoutIds[i]??null : null;
    const image={id:`${type}-${i+1}`,type,purpose:purposes[type][i]??`测试视角 ${i+1}`,
      content:`${type} 测试内容 ${i+1}；仅验证流程结构，不代表可用商品图`,factIds:[],copy:[],layoutId,
      composition:{subjectBox:[]},references:input.product.references.filter(r=>['product','detail','style'].includes(r.role)).map(r=>({referenceId:r.id,role:r.role})),
      dependencies:[],ratio:input.requirements.ratio,size:structuredClone(input.requirements.size),method:'generate',textMode:'editable-overlay'};
    const layout=effectiveLayout(input,image);image.composition.subjectBox=layout.subjectBox;
    if (layout.referenceId) image.references.push({referenceId:layout.referenceId,role:'layout'});
    if (type!=='white' && input.product.facts.length) {
      const fact=input.product.facts[i%input.product.facts.length];image.factIds=[fact.id];
      image.copy=[{slotId:layout.textSlots[0].id,text:fact.value,factIds:[fact.id]}];
    }
    images.push(image);
  }
  return {schemaVersion:VERSIONS.schema,productId:input.product.id,productRevision:input.product.revision,understandingDigest:digest(understanding),
    visual:{palette:['白色','浅灰'],font:'test-font',lighting:'柔和侧光',background:'简洁背景'},images};
}

/** Deliberately not imported from src/workflow. No real inference, rendering or visual QA. */
export function deterministicHandlers({failures={},mutateUnderstanding,mutatePlan,readReferences=false}={}) {
  const calls=[];
  return {id:'deterministic-03a-test-only',version:'test.1',replaySafe:true,calls,
    async understand({input}) { calls.push('understand');const u=understandingFixture(input);return mutateUnderstanding?.(u)??u; },
    async plan({input,understanding}) { calls.push('plan');const p=planFixture(input,understanding);return mutatePlan?.(p)??p; },
    async generate(request) {
      calls.push(`generate:${request.image.id}`);
      const failure=failures[request.image.id];
      if (failure && request.attempt<=(failure.untilAttempt??Infinity)) throw new WorkflowError(failure.code??'REJECTED',[],failure);
      if (readReferences) for (const ref of request.prompt.data.references) await request.readAsset(ref.assetId);
      const {width,height}=request.image.size;
      const bytes=fixturePNG(digest({prompt:request.prompt,attempt:request.attempt}),width,height);
      return {base64:bytes.toString('base64'),mediaType:'image/png',width,height,provenance:'test-only',requestId:`test-${request.image.id}-${request.attempt}`};
    },
    async compose({raster,layers,image}) { calls.push(`compose:${image.id}`);return {raster,layers}; },
    async inspect({image}) { calls.push(`inspect:${image.id}`);return {passed:true,evidence:'test-only',issues:[]}; }
  };
}
