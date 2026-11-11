import http from 'node:http';

export async function startLocalServer({port,instanceId,createRuntime,serveStatic,log=console.log}){
 if(!Number.isInteger(port)||port<0||port>65535)throw Object.assign(Error('Invalid port'),{code:'INVALID_PORT'});
 let runtime,closing=false,closePromise;
 const startedAt=new Date().toISOString();
 const server=http.createServer(async(req,res)=>{
  try{
   if(!runtime||closing){res.writeHead(503,{'Retry-After':'1'});res.end('Service starting or stopping');return;}
   if(req.url.split('?')[0]==='/healthz'){
    const localPort=server.address().port;
    if(![`127.0.0.1:${localPort}`,`localhost:${localPort}`].includes(req.headers.host)){
     res.writeHead(403);res.end();return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    // Web liveness is independent of model configuration and unknown billing.
    runtime.store?.get('SELECT 1 AS alive');
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(req.method==='HEAD'?undefined:JSON.stringify({service:'shangtu-ai',instanceId,status:'ok',pid:process.pid,startedAt}));
    return;
   }
   await(req.url.startsWith('/api/')?runtime.handler(req,res):serveStatic(req,res));
  }catch{
   log(`${new Date().toISOString()} request_failed`);
   if(res.headersSent){res.destroy();return;}
   res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'INTERNAL',message:'Local service error'}}));
  }
 });
 server.requestTimeout=60000;server.headersTimeout=15000;
 // Claim the port before opening SQLite or recovering queues. A duplicate
 // invocation must not change history or start work while its port is occupied.
 await new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});
 });
 try{runtime=await createRuntime();}
 catch(error){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw error;}
 function close(){
  if(closePromise)return closePromise;
  closing=true;
  closePromise=(async()=>{
   const drained=new Promise(resolve=>server.close(resolve));
   server.closeIdleConnections();
   try{await runtime.close();}
   finally{server.closeAllConnections();await drained;}
  })();
  return closePromise;
 }
 return {server,runtime,close};
}

export function startupError(error){
 const messages={EADDRINUSE:'5178端口或指定端口已被占用；请检查 npm run service:status，勿重复启动。',STORE_LOCKED:'数据目录已有运行进程或锁需检查；未启动第二个写入进程。',INVALID_PORT:'PORT 必须是有效端口号。',UNSAFE_CONFIG:'私有配置权限或位置不正确。',UNSAFE_CREDENTIAL:'服务端凭证文件不安全或不可读。',API_SETTINGS_STORAGE:'API 设置文件不安全或不可读。'};
 const code=Object.hasOwn(messages,error?.code)?error.code:'STARTUP_FAILED';
 return `${new Date().toISOString()} ${code}: ${messages[code]??'请检查 Node 版本、私有配置和数据目录；原始错误内容未写入日志。'}`;
}
