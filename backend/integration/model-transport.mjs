import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import {Fault,fail} from '../core.mjs';

export function publicAddress(address){
 if(net.isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
 return net.isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(db8|0|10|20):/i.test(address)&&!/^2002:/i.test(address);
}
// Resolve once and pin that address to the TLS connection, preventing DNS rebinding.
// No redirects; downloads never carry an API credential. Only bounded HTTPS bodies.
export async function safeTransport(url,options={}){
 const u=new URL(url);fail(u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443'),'UNSAFE_ENDPOINT','仅支持公网 HTTPS 服务',400);
 const literal=u.hostname.replace(/^\[|\]$/g,'');
 const addresses=net.isIP(literal)?[{address:literal,family:net.isIP(literal)}]:await dns.lookup(literal,{all:true});
 fail(addresses.length>0&&addresses.every(x=>publicAddress(x.address)),'UNSAFE_ENDPOINT','不允许访问本机或内网地址');
 const selected=addresses.find(x=>x.family===4)??addresses[0],signal=options.signal;
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const req=https.request(u,{method:options.method??'GET',headers:options.headers,signal,
   lookup:(_host,opts,cb)=>opts.all?cb(null,[selected]):cb(null,selected.address,selected.family)},res=>{
   let length=0;const chunks=[];
   res.on('data',chunk=>{length+=chunk.length;if(length>70*1024*1024)req.destroy(Error('BODY_TOO_LARGE'));else chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>resolve(new Response([204,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>typeof v==='string'))})));
  });
  req.setTimeout(180000,()=>req.destroy(Error('TIMEOUT')));req.on('error',reject);req.end(options.body);
 });
}
export async function readJSON(response,limit=70*1024*1024){
 const reader=response.body?.getReader();fail(reader,'MODEL_EMPTY_RESPONSE','模型未返回内容',502);
 let length=0;const chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw new Fault('MODEL_RESPONSE_TOO_LARGE','模型返回内容过大',502);}chunks.push(Buffer.from(value));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Fault('MODEL_RESPONSE_INVALID','接口未返回有效 JSON，请检查完整接口地址',502);}
}
export async function ensureResponse(response){
 if(response.ok)return;
 await response.body?.cancel();
 const code=response.status===401||response.status===403?'MODEL_AUTH':response.status===404?'MODEL_NOT_FOUND':response.status===429?'MODEL_RATE_LIMIT':[400,413,422].includes(response.status)?'MODEL_REJECTED':'MODEL_OUTCOME_UNKNOWN';
 const messages={MODEL_AUTH:'鉴权失败，请检查密钥、所属地域和模型权限',MODEL_NOT_FOUND:'找不到接口或模型，请检查完整地址和模型 ID',MODEL_RATE_LIMIT:'服务商限流或账户余额不足，请到服务商控制台检查后重试',MODEL_REJECTED:'服务商拒绝了请求，请检查模型、参数和图片支持范围',MODEL_OUTCOME_UNKNOWN:'服务商结果未确认，请先核对调用记录，避免重复计费'};
 throw new Fault(code,messages[code],502);
}
