import {schemas, schemaIssues, TYPES} from './contracts.js';
import {createPolicy} from './policy.js';
import {canonical, digest, duplicates, issue, snapshot} from './value.js';

export const AUTO_LAYOUTS = snapshot(Object.fromEntries(TYPES.map(type=>[type,{
  id:`auto-${type}`,version:'03A.layout.1',allowedTypes:[type],ratios:[],referenceId:null,
  subjectBox:type==='white' ? [0.1,0.1,0.8,0.8] : [0.1,0.3,0.8,0.6],
  textSlots:type==='white' ? [] : [{id:'headline',box:[0.1,0.05,0.8,0.2],maxChars:60,maxLines:2}]
}])));
export const effectiveLayout = (input,image) => image.layoutId===null ? AUTO_LAYOUTS[image.type] : input.layouts.find(l=>l.id===image.layoutId);
const productRole = role => ['product','detail','packaging'].includes(role);
const badBox = b => b[2]<=0 || b[3]<=0 || b[0]+b[2]>1+1e-9 || b[1]+b[3]>1+1e-9;
const overlap = (a,b) => Math.min(a[0]+a[2],b[0]+b[2])>Math.max(a[0],b[0])+1e-9 && Math.min(a[1]+a[3],b[1]+b[3])>Math.max(a[1],b[1])+1e-9;
function checkSize(ratio,size,p,path) {
  const errors=[];
  if (!p.ratios.value.includes(ratio)) errors.push(issue('RATIO',path,'Ratio not allowed by this policy'));
  const [a,b]=ratio.split(':').map(Number);
  if (!(a>0 && b>0) || Math.abs(size.width*b-size.height*a)>Math.max(a,b)/2+1e-9) errors.push(issue('ASPECT_SIZE',path,'Size differs from ratio beyond half-pixel rounding'));
  if (!Number.isSafeInteger(size.width*size.height) || size.width*size.height>p.maxPixels.value) errors.push(issue('PIXELS',path,'Size exceeds configured safeguard'));
  if (p.allowedSizes.value && !p.allowedSizes.value.includes(`${size.width}x${size.height}`)) errors.push(issue('PROVIDER_SIZE',path,'Size outside configured provider allowlist'));
  return errors;
}

export function validateInput(input,policy) {
  const p=createPolicy(policy), errors=schemaIssues(schemas.input,input);
  if (errors.length) return errors;
  const {product,requirements:r,layouts}=input;
  errors.push(...duplicates(product.facts.map(f=>f.id),'product.facts.id'),...duplicates(product.facts.map(f=>f.key),'product.facts.key'),
    ...duplicates(product.unknowns.map(u=>u.key),'product.unknowns'),...duplicates(product.references.map(x=>x.id),'product.references.id'),
    ...duplicates(product.references.map(x=>x.assetId),'product.references.assetId'),...duplicates(layouts.map(l=>l.id),'layouts'),...duplicates(r.layoutIds,'requirements.layoutIds'));
  const n=product.references.filter(x=>productRole(x.role)).length, total=TYPES.reduce((s,t)=>s+r.counts[t],0);
  if (n<p.productReferencesMin.value || n>p.productReferencesMax.value || !product.references.some(x=>x.role==='product')) errors.push(issue('PRODUCT_REFERENCES','product.references','Need identity reference and configured product/detail/packaging count'));
  if (total<p.totalMin.value || total>p.totalMax.value) errors.push(issue('TOTAL_COUNT','requirements.counts','Total outside configured range'));
  for (const t of TYPES) if (r.counts[t]>p.perTypeMax.value) errors.push(issue('TYPE_COUNT',`requirements.counts.${t}`,'Count exceeds configured type maximum'));
  if (product.unknowns.some(u=>product.facts.some(f=>f.key===u.key))) errors.push(issue('FACT_UNKNOWN_CONFLICT','product','A key cannot be both confirmed and unknown'));
  errors.push(...checkSize(r.ratio,r.size,p,'requirements.size'));
  if (r.layoutIds.length>r.counts.selling) errors.push(issue('LAYOUT_CAPACITY','requirements.layoutIds','More selected layouts than selling images'));
  for (const id of r.layoutIds) {
    const l=layouts.find(x=>x.id===id);
    if (!l || !l.allowedTypes.includes('selling') || !l.ratios.includes(r.ratio)) errors.push(issue('LAYOUT_SELECTION',`layouts.${id}`,'Selected layout missing or incompatible'));
  }
  for (const l of layouts) {
    errors.push(...duplicates(l.textSlots.map(s=>s.id),`layouts.${l.id}.slots`));
    const boxes=[l.subjectBox,...l.textSlots.map(s=>s.box)];
    if (boxes.some(badBox) || boxes.some((a,i)=>boxes.slice(i+1).some(b=>overlap(a,b)))) errors.push(issue('LAYOUT_BOUNDS',`layouts.${l.id}`,'Layout boxes must have area, fit canvas and not overlap'));
    if (l.referenceId!==null && !product.references.some(x=>x.id===l.referenceId && x.role==='layout')) errors.push(issue('LAYOUT_REFERENCE',`layouts.${l.id}`,'Layout asset must have layout role'));
  }
  return errors;
}

export function validateUnderstanding(input,u) {
  const errors=schemaIssues(schemas.understanding,u);
  if (errors.length) return errors;
  if (u.productId!==input.product.id || u.productRevision!==input.product.revision) errors.push(issue('PRODUCT_SNAPSHOT','understanding','Product revision changed'));
  if (canonical(u.facts)!==canonical(input.product.facts)) errors.push(issue('FACT_PROMOTION','understanding.facts','Only input user-confirmed facts may be facts; inference cannot confirm itself'));
  if (canonical(u.references)!==canonical(input.product.references)) errors.push(issue('REFERENCE_ROLES','understanding.references','Reference IDs, assets, order and roles must stay unchanged'));
  errors.push(...duplicates([...u.facts,...u.inferred].map(f=>f.id),'understanding.claimIds'),...duplicates(u.unknowns.map(x=>x.key),'understanding.unknowns'));
  for (const unknown of input.product.unknowns) if (!u.unknowns.some(x=>x.key===unknown.key)) errors.push(issue('UNKNOWN_DROPPED','understanding.unknowns','Unconfirmed input cannot become known'));
  for (const inf of u.inferred) {
    if (inf.evidenceReferenceIds.some(id=>!input.product.references.some(r=>r.id===id && productRole(r.role)))) errors.push(issue('INFERENCE_EVIDENCE',`understanding.${inf.id}`,'Inference requires product evidence; style/layout are not product facts'));
    if (u.facts.some(f=>f.key===inf.key && f.value!==inf.value) && !u.conflicts.some(c=>c.key===inf.key)) errors.push(issue('CONFLICT_MISSING',`understanding.${inf.id}`,'Contradicting inference must record a conflict'));
  }
  for (const c of u.conflicts) if (c.factIds.some(id=>!u.facts.some(f=>f.id===id)) || c.referenceIds.some(id=>!u.references.some(r=>r.id===id))) errors.push(issue('CONFLICT_SOURCE','understanding.conflicts','Conflict references missing evidence'));
  return errors;
}

export function validatePlan(input,u,plan,policy) {
  const p=createPolicy(policy), errors=[...validateInput(input,p),...schemaIssues(schemas.understanding,u),...schemaIssues(schemas.plan,plan)];
  if (errors.length) return errors;
  errors.push(...validateUnderstanding(input,u));
  if (plan.productId!==input.product.id || plan.productRevision!==input.product.revision || plan.understandingDigest!==digest(u)) errors.push(issue('PLAN_SNAPSHOT','plan','Plan does not match understanding/product revision'));
  errors.push(...duplicates(plan.images.map(x=>x.id),'plan.images.id'));
  const r=input.requirements;
  for (const t of TYPES) if (plan.images.filter(x=>x.type===t).length!==r.counts[t]) errors.push(issue('TYPE_COUNT',`plan.images.${t}`,'Plan must exactly meet requested counts'));
  for (const id of r.layoutIds) {
    const n=plan.images.filter(x=>x.layoutId===id).length;
    if (!n || p.layoutOnce.value && n!==1) errors.push(issue('LAYOUT_USAGE',`plan.layout.${id}`,'Each selected layout must be used once under this policy'));
  }
  const signatures=new Set();
  for (const img of plan.images) {
    const path=`plan.images.${img.id}`, refIds=img.references.map(x=>x.referenceId), depIds=img.dependencies.map(x=>x.imageId);
    if(['provider-rendered','source-aware-overlay'].includes(img.textMode)&&img.copy.length)errors.push(issue('COPY_MODE',path,'Provider-rendered copy cannot also request editable overlays'));
    errors.push(...duplicates(refIds,`${path}.references`),...duplicates(depIds,`${path}.dependencies`),...duplicates(img.factIds,`${path}.factIds`),...duplicates(img.copy.map(c=>c.slotId),`${path}.copy`));
    errors.push(...checkSize(img.ratio,img.size,p,`${path}.size`));
    if (img.ratio!==r.ratio || canonical(img.size)!==canonical(r.size)) errors.push(issue('OUTPUT_SIZE',path,'Per-image ratio/size must match request'));
    if (img.references.length+img.dependencies.length>p.combinedReferencesMax.value) errors.push(issue('REFERENCE_BUDGET',path,'Combined product/style/layout/current/baseline references exceed policy'));
    if (!img.references.some(x=>x.role==='product')) errors.push(issue('IDENTITY_REFERENCE',path,'Each image needs a product identity reference'));
    for (const ref of img.references) if (!input.product.references.some(x=>x.id===ref.referenceId && x.role===ref.role)) errors.push(issue('REFERENCE_ROLE',path,'Reference role or ID does not match input'));
    for (const dep of img.dependencies) if (dep.imageId===img.id || !plan.images.some(x=>x.id===dep.imageId)) errors.push(issue('DEPENDENCY',path,'Dependency missing or self-referencing'));
    const usedFacts=[...img.factIds,...img.copy.flatMap(c=>c.factIds)];
    for (const id of usedFacts) {
      const f=u.facts.find(x=>x.id===id);
      if (!f) errors.push(issue('UNCONFIRMED_CLAIM',path,'Claims must cite confirmed facts, never inference or unknown'));
      else if (u.conflicts.some(c=>c.key===f.key || c.factIds.includes(id))) errors.push(issue('UNRESOLVED_CONFLICT',path,'Conflicting fact requires user resolution before use'));
    }
    if (img.copy.some(c=>c.factIds.some(id=>!img.factIds.includes(id)))) errors.push(issue('COPY_FACTS',path,'Copy claims must be declared in image facts'));
    const layout=effectiveLayout(input,img);
    if (img.layoutId!==null && (!r.layoutIds.includes(img.layoutId) || img.type!=='selling')) errors.push(issue('LAYOUT_SELECTION',path,'Custom selected layouts belong to selling slots'));
    if (!layout) { errors.push(issue('LAYOUT_MISSING',path,'Unknown layout')); continue; }
    if (!layout.allowedTypes.includes(img.type) || layout.ratios.length && !layout.ratios.includes(img.ratio)) errors.push(issue('LAYOUT_TYPE',path,'Layout incompatible with type/ratio'));
    // Provider-rendered auto designs carry their own validated geometry. Editable overlays
    // and selected library layouts must still execute the exact declared template bounds.
    if(['provider-rendered','source-aware-overlay'].includes(img.textMode)&&img.layoutId===null){
      if(badBox(img.composition.subjectBox))errors.push(issue('LAYOUT_BOUNDS',path,'Provider subject bounds must have area and fit the canvas'));
    }else if (canonical(img.composition.subjectBox)!==canonical(layout.subjectBox)) errors.push(issue('LAYOUT_COMPOSITION',path,'Composition must execute the layout subject bounds'));
    if (layout.referenceId!==null && !refIds.includes(layout.referenceId)) errors.push(issue('LAYOUT_REFERENCE',path,'Selected layout reference absent from generation inputs'));
    for (const c of img.copy) {
      const slot=layout.textSlots.find(s=>s.id===c.slotId);
      if (!slot || Array.from(c.text).length>slot.maxChars || c.text.split(/\r?\n/).length>slot.maxLines) errors.push(issue('COPY_CAPACITY',path,'Copy exceeds layout slot character/line capacity'));
    }
    if (img.type==='white' && img.copy.length) errors.push(issue('WHITE_COPY',path,'White image has no promotional text layer'));
    const signature=canonical([img.type,img.content.trim(),img.purpose.trim(),img.copy]);
    if (signatures.has(signature)) errors.push(issue('DUPLICATE_CONTENT',path,'Exact repeated content cannot fill image count')); signatures.add(signature);
  }
  const visiting=new Set(),visited=new Set(),byId=new Map(plan.images.map(x=>[x.id,x]));
  function visit(id) {
    if (visiting.has(id)) { errors.push(issue('DEPENDENCY_CYCLE','plan.images','Dependencies must be acyclic')); return; }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id); byId.get(id).dependencies.forEach(d=>visit(d.imageId)); visiting.delete(id); visited.add(id);
  }
  plan.images.forEach(x=>visit(x.id));
  return errors;
}
