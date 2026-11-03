import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {Fault,fail,json} from '../core.mjs';
import {crc32} from '../files.mjs';
import {ledgerState} from './provider.mjs';
import {legacyConnection,connectionIdentity} from './model-catalog.mjs';
import {chatPayload,chatRequest,imagePayload,imageRequest} from './model-adapters.mjs';
import {knownRejection} from './model-router.mjs';

export function connectionTestImage(){
 const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(512,0);head.writeUInt32BE(512,4);head[8]=8;head[9]=2;
 const rows=Buffer.alloc(512*(512*3+1));for(let y=0;y<512;y++)for(let x=0;x<512;x++){const i=y*1537+1+x*3;rows[i]=230;rows[i+1]=30;rows[i+2]=30;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
export function createConnectionTests({store,config,apiSettings,textTransport,imageTransport,downloadTransport,timeoutMs=120000}){
 store.db.exec(`CREATE TABLE IF NOT EXISTS connection_tests(id TEXT PRIMARY KEY,kind TEXT NOT NULL,budget_id TEXT NOT NULL,reserved_cny REAL NOT NULL,state TEXT NOT NULL,connection_json TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,error_code TEXT);`);
 store.run("UPDATE connection_tests SET state='unknown',error_code='PROCESS_INTERRUPTED',ended_at=? WHERE state='sent'",Date.now());
 const runs=new Map();let active=null;
 const view=r=>({id:r.id,kind:r.kind,state:r.state,message:r.message,...(r.preview?{preview:r.preview}:{}),...(r.errorCode?{errorCode:r.errorCode}:{}),elapsedMs:(r.endedAt??Date.now())-r.startedAt});
 const stored=id=>{const r=store.get('SELECT * FROM connection_tests WHERE id=?',id);return r?{id:r.id,kind:r.kind,state:r.state==='sent'?'running':r.state==='received'&&!r.error_code?'succeeded':'failed',message:r.state==='received'&&!r.error_code?'此前测试已完成；临时预览不在刷新后保留。':r.state==='unknown'?'此前请求结果未确认，请先核对服务商调用记录。':'此前测试未通过，请检查配置后重新测试。',errorCode:r.error_code,startedAt:r.started_at,endedAt:r.ended_at}:null;};
 return {get busy(){return !!active;},get(id){const r=runs.get(id)??stored(id);fail(r,'NOT_FOUND','找不到本次连接测试，请重新打开设置',404);return view(r);},
  start(input){
   fail(input&&['text','image'].includes(input.kind)&&typeof input.id==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(input.id)&&Object.keys(input).every(k=>['kind','id','revision','draft'].includes(k)),'INVALID_INPUT','连接测试请求无效');
   const previous=runs.get(input.id)??stored(input.id);if(previous)return view(previous);
   fail(!active,'TEST_BUSY','已有连接测试正在进行，请等待完成',409);
   fail(config.modelCallsPaused===false,'MODEL_CALLS_PAUSED','模型调用已暂停，请先恢复服务',503);
   const c=apiSettings.preview(input.kind,input.draft,input.revision);fail(c.key,'INVALID_API_KEY','请先填写 API Key');
   const amount=legacyConnection(input.kind,c)?input.kind==='text'?.02:config.reservePerImageCny:c.reserveCny;
   fail(Number.isFinite(amount)&&amount>0,'MODEL_PRICE_REQUIRED','请展开调用设置，填写该服务商的单次预留金额');
   const status=ledgerState(store,config);fail(!status.unknown,'BILLING_UNKNOWN','已有调用结果待核对，请先检查服务状态',409);
   fail(config.budgetId&&status.reservedCny+amount<=config.budgetCny+1e-8,'BUDGET_LIMIT','剩余预算不足以进行本次连接测试',409);
   const id=input.id,startedAt=Date.now(),controller=new AbortController();
   const run={id,kind:input.kind,state:'running',message:input.kind==='text'?'正在验证文字响应与图片输入…':'正在生成 1 张测试图…',startedAt,controller};
   store.run('INSERT INTO connection_tests VALUES(?,?,?,?,?,?,?,?,?)',id,input.kind,config.budgetId,amount,'sent',json(connectionIdentity(c)),startedAt,null,null);
   if(runs.size>=10)runs.delete(runs.keys().next().value);
   runs.set(id,run);active=run;
   const image=`data:image/png;base64,${connectionTestImage().toString('base64')}`,signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
   run.promise=(async()=>{
    try{
     if(input.kind==='text'){
      const payload=chatPayload(c,[{role:'system',content:'只返回 JSON 对象，包含 ok: true 和 color（图片的主色，英文小写基本颜色名），不要返回其他内容。'},{role:'user',content:[{type:'image_url',image_url:{url:image}},{type:'text',text:'识别这张纯色图片的主色。'}]}],128);
      const {output}=await chatRequest(c,payload,{transport:textTransport,signal});
      fail(output.ok===true&&output.color==='red','VISION_TEST_FAILED','接口已响应，但未正确识别测试图片；请确认选择了支持图片输入的模型',502);
      run.message='测试通过：鉴权、文字响应、JSON 输出和图片输入均正常。';
     }else{
      const payload=imagePayload(c,{prompt:'以参考图的红色为主体，生成一张纯白背景上的红色正方体图片。只生成一张图片，不添加文字。',images:[image],size:{width:1024,height:1024}});
      const result=await imageRequest(c,payload,{transport:imageTransport,downloadTransport,signal});
      fail(result.info.width===1024&&result.info.height===1024,'IMAGE_SIZE_MISMATCH','接口已出图，但没有遵守测试尺寸 1024×1024，请检查模型兼容性',502);
      run.preview=`data:image/png;base64,${result.bytes.toString('base64')}`;run.message='测试通过：参考图已提交，已收到 1024×1024 图片。商品一致性仍需实际评测。';
     }
     run.state=controller.signal.aborted?'canceled':'succeeded';
     store.run("UPDATE connection_tests SET state='received',ended_at=? WHERE id=?",Date.now(),id);
    }catch(e){
     const received=['TEXT_OUTPUT_INVALID','VISION_TEST_FAILED','IMAGE_SIZE_MISMATCH'].includes(e.code);
     run.state=controller.signal.aborted?'canceled':'failed';run.errorCode=e instanceof Fault?e.code:'MODEL_OUTCOME_UNKNOWN';
     run.message=controller.signal.aborted?'已停止等待。已发出的请求可能继续计费，请先核对服务商调用记录。':e instanceof Fault?e.message:'请求超时或连接中断，结果未确认，请核对服务商调用记录后再试。';
     store.run('UPDATE connection_tests SET state=?,ended_at=?,error_code=? WHERE id=?',knownRejection(e)?'rejected':received?'received':'unknown',Date.now(),run.errorCode,id);
    }finally{c.key='';run.endedAt=Date.now();active=null;delete run.controller;delete run.promise;}
   })();
   return view(run);
  },cancel(id){const run=runs.get(id);fail(run,'NOT_FOUND','找不到本次连接测试',404);run.controller?.abort();return view(run);},async close(){active?.controller?.abort();if(active?.promise)await active.promise;}
 };
}
