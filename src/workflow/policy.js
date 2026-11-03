import {snapshot, ensure} from './value.js';

const rule = (value,basis,status='provisional') => ({value,basis,status});
export const DEFAULT_POLICY = snapshot({
  version:'03A.policy.1-provisional',
  totalMin:rule(7,'src/model.js validateKit; docs/MVP-TASKS.md A04 explicitly requires submission verification'),
  totalMax:rule(20,'src/model.js validateKit; original-site submission boundary not verified'),
  perTypeMax:rule(20,'src/model.js setCount; local provisional cap'),
  productReferencesMin:rule(1,'Current product input requirement'),
  productReferencesMax:rule(6,'src/model.js validateKit; original-site boundary still pending'),
  combinedReferencesMax:rule(10,'docs/MVP-TASKS.md recorded official API reading 2026-10-28; account/provider not reverified here','recorded-not-reverified'),
  ratios:rule(['1:1','3:4','9:16','16:9'],'src/views.js current UI options; full eight-ratio contract not frozen'),
  maxPixels:rule(40000000,'02A backend/core.mjs local safeguard; NOT provider pixel limit','local-safeguard'),
  allowedSizes:rule(null,'Provider request-size mapping remains B03 work; null means unknown, NOT unrestricted support'),
  outputsPerCall:rule(1,'docs/MVP-TASKS.md recorded Flash single-image API; not tested here','recorded-not-reverified'),
  imageModel:'Seedream 5.0 Flash', modelId:null,
  layoutOnce:rule(true,'docs/MVP-TASKS.md E06 one selected layout per selling image; provisional business rule')
});

// Rules are replaced atomically, so overriding a value also requires an explicit basis/status.
export function createPolicy(overrides = {}) {
  ensure(overrides && typeof overrides==='object' && !Array.isArray(overrides),'INVALID_POLICY');
  ensure(Object.keys(overrides).every(k=>Object.hasOwn(DEFAULT_POLICY,k)),'INVALID_POLICY');
  const p={...DEFAULT_POLICY,...overrides};
  ensure(typeof p.version==='string' && p.version.trim() && typeof p.imageModel==='string' && p.imageModel.trim() &&
    (p.modelId===null || typeof p.modelId==='string' && p.modelId.trim()),'INVALID_POLICY');
  for (const [k,v] of Object.entries(DEFAULT_POLICY)) {
    if (!v || typeof v!=='object' || !Object.hasOwn(v,'value')) continue;
    const r=p[k];
    ensure(r && Object.keys(r).sort().join(',')==='basis,status,value' && typeof r.basis==='string' && r.basis.trim() &&
      ['provisional','recorded-not-reverified','local-safeguard','verified'].includes(r.status),'INVALID_POLICY');
  }
  for (const k of ['totalMin','totalMax','perTypeMax','productReferencesMin','productReferencesMax','combinedReferencesMax','maxPixels','outputsPerCall'])
    ensure(Number.isSafeInteger(p[k].value) && p[k].value>0,'INVALID_POLICY');
  ensure(p.totalMin.value<=p.totalMax.value && p.productReferencesMin.value<=p.productReferencesMax.value && p.outputsPerCall.value===1,'INVALID_POLICY');
  ensure(Array.isArray(p.ratios.value) && p.ratios.value.length && p.ratios.value.every(r=>/^[1-9]\d*:[1-9]\d*$/.test(r)),'INVALID_POLICY');
  ensure(p.allowedSizes.value===null || Array.isArray(p.allowedSizes.value) && p.allowedSizes.value.length>0 && p.allowedSizes.value.every(s=>/^[1-9]\d*x[1-9]\d*$/.test(s)),'INVALID_POLICY');
  ensure(typeof p.layoutOnce.value==='boolean','INVALID_POLICY');
  return snapshot(p);
}
