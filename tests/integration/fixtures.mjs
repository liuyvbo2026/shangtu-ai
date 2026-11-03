import { factualUnderstanding,rulesPlan } from '../../backend/integration/planning.mjs';
import {fixturePNG} from '../workflow/fixtures.mjs';
import {WorkflowError} from '../../src/workflow/value.js';
export function handlers({delay=20,failFirst=null}={}){return {
 id:'integration-fixture',version:'1',replaySafe:true,understand:factualUnderstanding,plan:rulesPlan,
 async generate(r){
  for(const a of r.prompt.data.references)await r.readAsset(a.assetId);
  await new Promise(resolve=>setTimeout(resolve,delay));
  if(r.image.id===failFirst&&r.attempt===1)throw new WorkflowError('REJECTED');
  const {width,height}=r.image.size;
  return {base64:fixturePNG(`TEST ONLY ${r.prompt.data.productId}/${r.image.id}/${r.prompt.data.editInstruction||'original'}`,width,height).toString('base64'),mediaType:'image/png',width,height,provenance:'test-only',requestId:`test-${r.image.id}-${r.attempt}`};
 },async compose({raster,layers}){return {raster,layers};},async inspect(){return {passed:true,evidence:'test-only',issues:[]};}
};}
export {fixturePNG};
export const settings={platform:'亚马逊',country:'德国',language:'英文',ratio:'3:4',resolution:'1K',counts:{white:1,selling:3,scene:2,other:1},layouts:[],analysis:false,listing:false};
