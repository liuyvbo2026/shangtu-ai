import {LIFESTYLE_TEMPLATE} from '../../src/workflow/lifestyle-design.js';
import {FULLCANVAS_TEMPLATE} from '../../src/workflow/fullcanvas-design.js';
import {requireSemanticApproval} from './intent-review.mjs';
import {isIntentTemplate,INTENT_TEMPLATE} from '../../src/workflow/intent-design.js';
import {ADAPTIVE_TEMPLATE,isAdaptiveTemplate,isReviewedTemplate} from '../../src/workflow/adaptive-design.js';
import {REVIEWED_TEMPLATE} from '../../src/workflow/reviewed-design.js';
import {ART_TEMPLATE} from '../../src/workflow/art-directed-design.js';
import {BETA_TEMPLATE,betaLayers} from '../../src/workflow/beta-design.js';
import {TYPOGRAPHY_TEMPLATE} from '../../src/workflow/typography-design.js';
import {fail,canonical} from '../core.mjs';
import {validateUnderstandingOutput,validatePlanOutput,sources} from './mimo-contracts.mjs';
import {BASELINE_TEMPLATE,DESIGN_TEMPLATE,isDesignedTemplate,TEMPLATE_IDS} from '../../src/workflow/minimum-templates.js';
import {factualUnderstanding,IDENTITY_RULES} from './planning.mjs';
import {VERSIONS,digest,AUTO_LAYOUTS} from '../../src/workflow/index.js';
import {verifyPinnedLayouts} from './layouts.mjs';

// Revalidate a saved, source-aware plan against the exact live product revision.
// Browser submissions contain an ID only; no browser-provided prompts are accepted.
export function executableTextPlan(store,run,request,frozenProduct=null){
 fail(run?.kind==='plan'&&run.state==='succeeded','PLAN_NOT_READY','请先完成商品理解与套图规划',409);
 const p=frozenProduct??store.product(request.productId),s=run.snapshot;
 const refs=p.references.map(({id,assetId,role})=>({id,assetId,role}));
 fail(s.productId===p.id&&s.productRevision===p.revision&&request.productRevision===p.revision&&s.description===request.description&&
  canonical(s.settings)===canonical(request.settings)&&canonical(refs)===canonical(s.references)&&
  canonical(refs.map(r=>store.asset(r.assetId).sha256))===canonical(s.referenceHashes),
  'PLAN_SOURCE_CHANGED','商品、参考图或设置已变化，请重新规划；旧记录仍保留',409);
 const templateVersion=s.templateVersion??BASELINE_TEMPLATE;
 fail(TEMPLATE_IDS.includes(templateVersion),'PLAN_VERSION_UNSUPPORTED','此规划模板版本暂不支持执行',409);
 const semanticReview=isIntentTemplate(templateVersion)?requireSemanticApproval(store,run):null;
 const understanding=validateUnderstandingOutput(run.understanding,s);
 const layouts=verifyPinnedLayouts(store,s.layouts);
 // Stored output includes deterministic server annotations; only model fields enter the schema.
 const raw={visual:run.output.visual,...([ART_TEMPLATE,REVIEWED_TEMPLATE,ADAPTIVE_TEMPLATE,INTENT_TEMPLATE,FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(templateVersion)?{artDirection:run.output.artDirection}:{}),images:run.output.images.map(({type,purpose,content,copy,composition,referenceIds,sourceIds,design,layoutId,intent,sceneBrief})=>({type,purpose,content,copy,composition,referenceIds,sourceIds,...(isIntentTemplate(templateVersion)?{intent}:{}),...(templateVersion===LIFESTYLE_TEMPLATE?{sceneBrief}:{}),...(layouts.length?{layoutId}:{}),...(isDesignedTemplate(templateVersion)?{design}:{})}))};
 const plan=validatePlanOutput(raw,s,understanding);
 const safeSources=sources(understanding).filter(x=>!understanding.conflicts.some(c=>c.sourceIds.includes(x.id)));
 const identity=IDENTITY_RULES+'\n'+understanding.observations.filter(o=>safeSources.some(s=>s.id===o.id)).map(o=>`${o.text}（证据 ${o.referenceIds.join('、')}）`).join('\n');
 return {...(s.marketPolicy?{marketPolicy:structuredClone(s.marketPolicy)}:{}),...(semanticReview?{semanticReview}:{}),...([FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(templateVersion)?{photographyRevision:2}:{}),runId:run.id,templateVersion,model:run.model,understanding,plan,sources:safeSources,identity,
  referenceHashes:s.referenceHashes,quality:'unassessed',copyMode:'provider-rendered',...(layouts.length?{layouts}:{})};
}

export function textPlanningHandlers(handlers,pinned){
 return {...handlers,
  understand:({input})=>({...factualUnderstanding({input}),
   inferred:pinned.understanding.observations.map(o=>({id:`mimo-${o.id}`,key:`visual-${o.id}`,value:o.text,confidence:0.5,evidenceReferenceIds:o.referenceIds}))}),
  plan:({input,understanding})=>({schemaVersion:VERSIONS.schema,productId:input.product.id,productRevision:input.product.revision,understandingDigest:digest(understanding),
   visual:pinned.plan.visual,images:pinned.plan.images.map(x=>({id:x.id,type:x.type,purpose:x.purpose,content:x.content,
    factIds:[],copy:[],layoutId:x.layoutId??null,composition:{subjectBox:x.subjectBox??AUTO_LAYOUTS[x.type].subjectBox},
    references:x.referenceIds.map(id=>({referenceId:id,role:input.product.references.find(r=>r.id===id).role})),dependencies:[],
    ratio:input.requirements.ratio,size:input.requirements.size,method:'generate',textMode:[TYPOGRAPHY_TEMPLATE,BETA_TEMPLATE,ART_TEMPLATE,REVIEWED_TEMPLATE,ADAPTIVE_TEMPLATE,INTENT_TEMPLATE,FULLCANVAS_TEMPLATE,LIFESTYLE_TEMPLATE].includes(pinned.templateVersion)?'source-aware-overlay':'provider-rendered'}))})};
}
