// One editable input; archived legacy fields are never generation constraints.
export const INPUT_VERSION=1;
export const INPUT_LIMIT=1000;
export const INPUT_LABEL='商品卖点&生成要求';
export const INPUT_HINT='建议包含以下信息生成更精准：\n1.产品名称\n2.核心卖点\n3.适用人群\n4.期望场景\n5.具体参数';

export function legacyDescription(product,description=''){
 const p=product?.legacyInput??product??{},parts=[];
 if(p.name&&p.name!=='未命名商品'&&!description.includes(p.name))parts.push(`产品名称：${p.name}`);
 const facts=p.factsText??(p.facts?.confirmed??[]).map(f=>f.value).join('\n');
 if(facts&&!description.includes(facts))parts.push(facts);
 if(description)parts.push(description);
 return parts.join('\n\n');
}
export function migrateProductInput(p){
 if(p.inputVersion===INPUT_VERSION)return p;
 p.legacyInput=structuredClone({name:p.name,factsText:p.factsText,facts:p.facts,description:p.description});
 p.inputText=legacyDescription(p,p.description??'');p.inputVersion=INPUT_VERSION;return p;
}
export function migrateDraftInput(draft,p){
 if(draft.inputVersion===INPUT_VERSION)return draft;
 draft.description=legacyDescription(p,draft.description??'');draft.inputVersion=INPUT_VERSION;return draft;
}
export function migrateWorkspaceInputs(state){
 const products=state.products??[],drafts=[state.kit,...(state.batch?.items??[])].filter(Boolean);
 if(products.some(p=>p.inputVersion!==INPUT_VERSION)||drafts.some(d=>d.inputVersion!==INPUT_VERSION)){
  state.inputMigrationBackup??=structuredClone({products:state.products,kit:state.kit,batch:state.batch});
  for(const d of drafts)migrateDraftInput(d,products.find(p=>p.id===d.productId));
  for(const p of products)migrateProductInput(p);
 }
 return state;
}
export function inputError(text){
 if(typeof text!=='string'||!text.trim())return '请填写商品卖点与生成要求。';
 if(text.length>INPUT_LIMIT)return `当前内容为 ${text.length} 字，已完整保留且可保存；生成前请调整至 ${INPUT_LIMIT} 字以内。`;
 return '';
}
export function savedInputFacts(p,remoteFacts={}){
 const legacy=remoteFacts.legacy??{...structuredClone(remoteFacts),local:structuredClone(p.legacyInput??{})};
 const assistance=p.aiAssistance??remoteFacts.userInput?.assistance;
 return {confirmed:[],unknowns:[],userInput:{version:INPUT_VERSION,text:p.inputText??'',source:{kind:'user-provided'},
  ...(assistance?.text===p.inputText?{assistance:structuredClone(assistance)}:{})},legacy};
}
export function productFromRemote(p){
 const input=p.facts.userInput;
 const local={id:p.clientId||p.id,serverId:p.id,serverRevision:p.revision,name:p.name,refs:p.references.map(r=>`server:${r.assetId}`),facts:structuredClone(p.facts),createdAt:p.createdAt};
 if(input?.version===INPUT_VERSION){Object.assign(local,{inputVersion:INPUT_VERSION,inputText:input.text,legacyInput:p.facts.legacy?.local,...(input.assistance?{aiAssistance:structuredClone(input.assistance)}:{})});return local;}
 return migrateProductInput(local);
}
export function reuseTaskInput(job){
 const snapshot=job.parameters?.inputSnapshot;
 if(snapshot?.product.facts.userInput?.version===INPUT_VERSION)return job.description;
 // Read the historical snapshot, never today's product facts.
 return legacyDescription(snapshot?.product??{name:job.name},job.description??'');
}
