import {fail} from '../core.mjs';

// Presets are protocol contracts, not a claim of account access or visual quality.
const chat=(id,label,endpoint,models,extra={})=>({id,label,kind:'text',protocol:'chat',endpoint,models,maxReferences:6,maxReferenceMB:20,maxRequestMB:48,...extra});
const dash='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const MODEL_CATALOG=[
 chat('mimo','小米 MiMo','https://api.xiaomimimo.com/v1/chat/completions',['mimo-v2.6-flash'],{auth:'api-key',thinking:'disabled',tokenField:'max_completion_tokens',jsonMode:true}),
 chat('deepseek','DeepSeek','https://api.deepseek.com/chat/completions',['deepseek-flash'],{thinking:'disabled',jsonMode:true}),
 chat('qwen','阿里云百炼 · 千问','https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',['qwen3.5-plus','qwen3.6-plus','qwen3-vl-plus'],{thinking:'qwen',jsonMode:true}),
 chat('doubao','火山方舟 · 豆包','https://ark.cn-beijing.volces.com/api/v3/chat/completions',['doubao-seed-2-1-turbo-260628'],{thinking:'disabled',jsonMode:true}),
 chat('glm','智谱 · GLM','https://open.bigmodel.cn/api/paas/v4/chat/completions',['glm-4.6v','glm-4.6v-flash','glm-4.6v-flashx'],{thinking:'disabled',maxReferenceMB:5,maxReferenceEdge:6000}),
 chat('kimi','月之暗面 · Kimi','https://api.moonshot.cn/v1/chat/completions',['kimi-k2.5'],{thinking:'disabled'}),
 chat('minimax','MiniMax','https://api.minimax.cn/v1/chat/completions',['MiniMax-M3.1-Flash','MiniMax-M3'],{maxReferenceMB:10,maxRequestMB:64,tokenField:'max_completion_tokens'}),
 chat('siliconflow','硅基流动','https://api.siliconflow.cn/v1/chat/completions',['Qwen/Qwen3-VL-32B-Instruct']),
 chat('custom-text','自定义 · Chat Completions','',[],{models:[],note:'需支持图片输入和 JSON 文本输出。填写完整的 Chat Completions 地址。'}),
 {id:'seedream',label:'火山方舟 · Seedream',kind:'image',protocol:'seedream',endpoint:'https://ark.cn-beijing.volces.com/api/v3/images/generations',models:['doubao-seedream-5-0-flash-260915'],maxReferences:10,maxReferenceMB:20,maxPixels:4624220,maxPromptChars:20000},
 {id:'qwen-image',label:'阿里云百炼 · 千问图像',kind:'image',protocol:'dashscope',endpoint:dash,models:['qwen-image-2.0-pro','qwen-image-2.0'],maxReferences:3,maxReferenceMB:10,maxPixels:4194304,maxPromptChars:800,note:'最多 3 张参考图；长规划会在提交前提示缩短，不会截断。'},
 {id:'wan',label:'阿里云百炼 · 通义万相',kind:'image',protocol:'dashscope',endpoint:dash,models:['wan2.6-image'],maxReferences:4,maxReferenceMB:10,minReferenceEdge:240,maxReferenceEdge:8000,maxPixels:4194304,maxPromptChars:2000,note:'最多 4 张参考图；不支持透明 PNG。'},
 {id:'hunyuan-image',label:'腾讯混元 · TokenHub',kind:'image',protocol:'hunyuan',endpoint:'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation',models:['hy-image-v3.5-preview'],maxReferences:3,maxReferenceMB:10,maxPixels:16777216,maxPromptChars:20000,note:'使用 TokenHub API Key；本项目当前最多传入 3 张参考图。'},
];
export const DEFAULT_IDS={text:'mimo',image:'seedream'};
export function preset(kind,id=DEFAULT_IDS[kind]){const p=MODEL_CATALOG.find(p=>p.kind===kind&&p.id===id);fail(p,'INVALID_PROVIDER','请选择支持的服务商');return p;}
export function defaultConnection(kind){const p=preset(kind);return {providerId:p.id,model:p.models[0],endpoint:p.endpoint,reserveCny:null};}
export function validateEndpoint(endpoint){
 let u;try{u=new URL(endpoint);}catch{fail(false,'INVALID_ENDPOINT','请填写完整的 HTTPS 接口地址');}
 fail(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&(!u.port||u.port==='443')&&u.hostname.includes('.')&&!u.hostname.endsWith('.local')&&!u.hostname.endsWith('.localhost')&&endpoint.length<=500,'INVALID_ENDPOINT','接口地址须为公网 HTTPS 地址，不能包含密钥、查询参数或自定义端口');
 return u.href;
}
export function validateConnection(kind,c){
 preset(kind,c.providerId);
 fail(typeof c.model==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(c.model),'INVALID_MODEL','请填写有效的模型 ID');
 const endpoint=validateEndpoint(c.endpoint);
 fail(c.reserveCny===null||Number.isFinite(c.reserveCny)&&c.reserveCny>0&&c.reserveCny<=100,'INVALID_RESERVATION','单次预留金额须大于 0 且不超过 100 元');
 return {providerId:c.providerId,model:c.model,endpoint,reserveCny:c.reserveCny};
}
export function legacyConnection(kind,c){const d=defaultConnection(kind);return !c||c.providerId===d.providerId&&c.model===d.model&&c.endpoint===d.endpoint;}
export const connectionIdentity=c=>({providerId:c.providerId,model:c.model,endpoint:c.endpoint,reserveCny:c.reserveCny});
export function sameConnection(a,b){return a.providerId===b.providerId&&a.model===b.model&&a.endpoint===b.endpoint;}
export function validateReferences(c,assets){
 const p=preset(c.kind??'image',c.providerId);
 fail(assets.length<=p.maxReferences,'MODEL_REFERENCE_LIMIT',`${p.label} 当前最多支持 ${p.maxReferences} 张参考图，请减少参考图或更换模型`);
 fail(!p.maxRequestMB||assets.reduce((n,a)=>n+Math.ceil(a.byteLength*4/3),0)<(p.maxRequestMB-1)*1024*1024,'MODEL_REFERENCE_SIZE','参考图总大小超出当前模型限制，请压缩图片或减少数量');
 for(const a of assets){
  fail(a.byteLength<=p.maxReferenceMB*1024*1024,'MODEL_REFERENCE_SIZE',`${p.label} 单张参考图不得超过 ${p.maxReferenceMB} MB`);
  fail(!p.minReferenceEdge||Math.min(a.width,a.height)>=p.minReferenceEdge,'MODEL_REFERENCE_SIZE',`参考图宽高均须至少 ${p.minReferenceEdge} 像素`);
  fail(!p.maxReferenceEdge||Math.max(a.width,a.height)<=p.maxReferenceEdge,'MODEL_REFERENCE_SIZE',`参考图宽高均须不超过 ${p.maxReferenceEdge} 像素`);
  if(p.id==='hunyuan-image')fail(['image/png','image/jpeg'].includes(a.mediaType),'MODEL_REFERENCE_FORMAT','混元参考图请使用 PNG 或 JPG');
 }
}
