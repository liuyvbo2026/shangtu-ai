import {VERSIONS} from './contracts.js';
import {snapshot} from './value.js';

export const NODE_CONTRACTS=snapshot([
  {id:'understand',input:'WorkflowInput',output:'ProductUnderstanding',failure:['INVALID_INPUT','INVALID_UNDERSTANDING','PROVIDER_FAILURE'],rerun:'New preparation; invalidates plan. No automatic retry.'},
  {id:'plan',input:'WorkflowInput + ProductUnderstanding',output:'KitPlan',failure:['INVALID_PLAN','PROVIDER_FAILURE'],rerun:'New preparation; new plan digest; old results retained separately.'},
  {id:'validate',input:'WorkflowInput + ProductUnderstanding + KitPlan + Policy',output:'ValidatedPlan',failure:['INVALID_PLAN'],rerun:'Correct input/plan and prepare again; no image call on rejection.'},
  {id:'assemble',input:'ValidatedPlan + ImagePlan + pinned dependency artifacts',output:'ImagePrompt',failure:['DEPENDENCY_BLOCKED','SNAPSHOT_CHANGED'],rerun:'One image with unchanged plan and explicit dependency versions.'},
  {id:'generate',input:'ImagePrompt + scoped asset reader + attempt + AbortSignal',output:'Raster bytes + mediaType + size + provenance',failure:['PROVIDER_FAILURE','OUTCOME_UNKNOWN','CANCELED','OUTPUT_INVALID'],rerun:'Queue-owned retry only. Unknown outcome requires reconciliation.'},
  {id:'compose',input:'Raster + layout + editable copy layers',output:'Final raster + editable layers',failure:['COMPOSE_FAILED','OUTPUT_INVALID'],rerun:'Resume from verified generate checkpoint for same image/plan.'},
  {id:'inspect',input:'Final raster + product constraints',output:'QualityReport',failure:['QUALITY_REJECTED','OUTPUT_INVALID'],rerun:'Resume inspection or explicitly regenerate target. Never silently rerun siblings.'}
].map(n=>({...n,version:VERSIONS.nodes})));
