/** Replace this adapter only when a real model is connected. Never calls a network API. */
export class LocalDemoService {
 async run(request,{signal,onProgress=()=>{},duration=3200,outcome='success'}={}){
  if(signal?.aborted)throw new DOMException('任务已取消','AbortError');
  const steps=8;
  for(let i=1;i<=steps;i++){
   await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('任务已取消','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},duration/steps);signal?.addEventListener('abort',abort,{once:true});});
   if(outcome==='failure'&&i===5)throw Error('演示任务未完成，请重试。');
   onProgress(Math.round(i/steps*100));
  }
  return {mode:'local-demo',capability:request.capability,sourceAssetId:request.sourceAssetId,createdAt:Date.now(),parameters:request.parameters,description:request.description||''};
 }
}
export const capabilities=new LocalDemoService();
