// Synthetic protocol fixtures only. Never evidence of model quality or real cup understanding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {hash} from '../../backend/core.mjs';
import {fixturePNG,handlers,settings} from './fixtures.mjs';
import {MIMO_MODEL} from '../../backend/integration/mimo-provider.mjs';

export const FAKE_MIMO_KEY='sk-SYNTHETIC_TEST_ONLY_NEVER_REAL';
export function fixtureOutput(data){
 if(data.operation==='quality')return {verdict:'needs-correction',summary:'测试检查结果，不代表真实图片质量',issues:[{category:'text',severity:'blocking',location:'右下角标签',evidence:'合成测试中的标签与预期不同',correction:'按原规划校正标签'}]};
 const refs=data.references.map(r=>r.id);
 if(data.operation==='understand')return {
  userInformation:data.userText.trim()?[{id:'u1',kind:'direction',quote:data.userText}]:[],
  observations:[{id:'o1',feature:'color',text:'蓝色杯身',referenceIds:refs}],
  references:refs.map((id,i)=>({referenceId:id,view:['正面','侧面','顶部'][i]||'侧面',observationIds:['o1']})),
  unknowns:['material','capacity','performance'].map(key=>({key,reason:`${key} 无法从图片核实`})),conflicts:[]};
 if(data.operation==='assist')return {suggestions:[{text:['展示蓝色杯身的外观与轮廓。','画面突出杯身的蓝色配色。','让蓝色主体在画面中保持清晰。'].find(s=>!data.userText.includes(s))||'为蓝色主体保留适当留白。',sourceIds:['o1']}]};
 if(data.operation==='style')return {visual:{palette:['蓝色','暖白'],font:'无衬线',lighting:'柔和侧光',background:'中性环境'},notes:[{text:'围绕可见蓝色安排统一配色',sourceIds:['o1']}],basis:'product-reference',marketEvidence:[]};
 if(data.operation==='listing')return {title:{text:'蓝色外观',sourceIds:['o1']},bullets:[{text:'展示蓝色主体',sourceIds:['o1']}],description:{text:'蓝色杯身的外观与轮廓。',sourceIds:['o1']},searchTerms:[{text:'蓝色杯身',sourceIds:['o1']}]};
 const shots=[['整体外观','完整正面展示蓝色杯身','正面','完整轮廓','中性浅色背景'],['顶部结构','展示参考图中已有的顶部连接','俯视','顶部局部','浅灰背景'],['侧面轮廓','突出侧面的外形线条','侧面','侧向全景','柔和渐变背景'],['近景细节','近距离观察杯身的可见转折','斜侧','杯身近景','纯白背景'],['桌面陈列','将完整商品放在简洁桌面','平视','带桌面环境的全景','木纹桌面背景'],['窗边布景','窗边自然光照亮商品轮廓','平视侧向','窗边中景','窗边背景'],['轮廓补充','补充已有视角中的侧边缘','参考斜向','边缘局部','中性深色背景']];
 const images=[];
 for(const [type,n] of Object.entries(data.settings.counts))for(let i=0;i<n;i++){
  const [purpose,content,angle,framing,background]=shots[images.length%shots.length];
  images.push({type,purpose,content,composition:{angle,framing,background},copy:type==='white'?[]:[{text:`${purpose} · 蓝色外观`,sourceIds:['o1']}],sourceIds:['o1'],referenceIds:refs});
 }
 return {visual:{palette:['蓝色','白色'],font:'简洁无衬线',lighting:'柔和自然光',background:'简洁中性背景'},images};
}
export function fixtureResponse(output,{finish='stop',usage=true,model=MIMO_MODEL}={}){
 return new Response(JSON.stringify({id:'synthetic-response',model,choices:[{finish_reason:finish,message:{role:'assistant',content:typeof output==='string'?output:JSON.stringify(output),reasoning_content:'SYNTHETIC_REASONING_MUST_NOT_BE_SAVED'}}],
  ...(usage?{usage:{prompt_tokens:1800,completion_tokens:600,total_tokens:2400,prompt_tokens_details:{cached_tokens:100}}}:{})}),{status:200,headers:{'Content-Type':'application/json','x-request-id':'test-only-request'}});
}
export function textFixture({dataDir,transport,config:override={},mimoKey=FAKE_MIMO_KEY,timeoutMs}={}){
 const temporary=!dataDir;dataDir??=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-mimo-'));
 const bytes=[0,1,2].map(i=>fixturePNG(`MIMO PROTOCOL TEST ONLY ${i}`,32,32)),sent=[];
 const config={modelCallsPaused:false,budgetId:'mimo-test-budget',budgetCny:5,reservePerImageCny:.12,mimo:{model:MIMO_MODEL,billing:'pay-as-you-go',accountConfirmed:true,
  authorizationEvidence:'SYNTHETIC LOCAL TEST ONLY',authorizedReferenceHashes:bytes.map(hash)},...override};
 const runtime=createRuntime({dataDir,key:'',config,mimoKey,testHandlers:handlers(),textTimeoutMs:timeoutMs,mimoTransport:async(url,options)=>{
  const payload=JSON.parse(options.body),data=JSON.parse(payload.messages[1].content.at(-1).text);sent.push({url,options,payload,data});
  return transport?transport({url,options,payload,data,sent}):fixtureResponse(fixtureOutput(data));
 }});
 let p=runtime.store.products()[0];
 if(!p){p=runtime.store.createProduct({name:'MiMo 协议测试商品',facts:{confirmed:[],unknowns:[],userInput:{version:1,text:'希望展示外观，不确定材质和容量',source:{kind:'user-provided'}},legacy:{kept:'LEGACY_PRESERVED'}}});
  for(let i=0;i<bytes.length;i++){const asset=runtime.store.putAsset(bytes[i],{kind:'original',name:`synthetic-${i}.png`,mediaType:'image/png'});p=runtime.store.addReference(p.id,{assetId:asset.id,role:'product'});}
 }
 const request={kind:'understand',productId:p.id,productRevision:p.revision,description:p.facts.userInput.text,settings:{...settings,language:'简体中文'}};
 return {runtime,config,sent,request,dataDir,p,async close(){await runtime.close();if(temporary)fs.rmSync(dataDir,{recursive:true,force:true});}};
}
export async function settled(h,id){for(let i=0;i<300;i++){const r=h.runtime.textService.get(id);if(r.state!=='running')return r;await new Promise(r=>setTimeout(r,5));}throw Error('TEST_TIMEOUT');}
