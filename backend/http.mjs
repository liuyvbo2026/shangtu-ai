import http from 'node:http';
import { Fault, fail, object } from './core.mjs';

const PREFIX = '/api/backend-v1';
export function body(req, limit) {
  return new Promise((resolve,reject) => {
    const chunks=[]; let size=0, exceeded=false;
    req.on('data', chunk => { size+=chunk.length; if(size>limit) { exceeded=true; chunks.length=0; } else if(!exceeded) chunks.push(chunk); });
    req.on('end', () => exceeded ? reject(new Fault('BODY_TOO_LARGE','Request body too large',413)) : resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}
export async function jsonBody(req) {
  fail(req.headers['content-type']?.split(';')[0]==='application/json','CONTENT_TYPE','Expected application/json',415);
  try { return object(JSON.parse((await body(req,256*1024)).toString('utf8'))); }
  catch(error) { if(error instanceof Fault) throw error; throw new Fault('INVALID_JSON','Malformed JSON'); }
}
export function createApiHandler({store,executor=null,route=null}) {
  return async(req,res) => {
    const send=(status,value) => {
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(JSON.stringify(value));
    };
    try {
      const port=req.socket.localPort, expectedHosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      fail(expectedHosts.includes(req.headers.host),'HOST_REJECTED','Loopback Host required',403);
      if(req.headers.origin) fail(expectedHosts.map(h=>`http://${h}`).includes(req.headers.origin),'ORIGIN_REJECTED','Cross-origin access is disabled',403);
      if(!['GET','HEAD'].includes(req.method)) fail(req.headers['x-backend-client']==='local-development','CLIENT_HEADER_REQUIRED','Set X-Backend-Client: local-development',403);
      const url=new URL(req.url,'http://127.0.0.1');
      fail(url.pathname===PREFIX || url.pathname.startsWith(PREFIX+'/'),'NOT_FOUND','Route not found',404);
      const parts=url.pathname.slice(PREFIX.length).split('/').filter(Boolean).map(s=>decodeURIComponent(s));
      const [resource,key,action,refId]=parts;
      const method=req.method;
      if(route && await route({req,res,send,parts,method,url})) return;
      if(resource==='health' && parts.length===1 && method==='GET') return send(200,{contract:'backend-v1-provisional',mode:store.processor.id==='deterministic-test-only'?'TEST_ONLY':'NO_REAL_PROVIDER',processor:store.processor,executor:executor ? {running:!executor.stopping,error:executor.fatal} : null});
      if(resource==='policy' && parts.length===1 && method==='GET') return send(200,{provisional:true,config:store.config});
      if(resource==='products') {
        if(!key && method==='GET') return send(200,{products:store.products()});
        if(!key && method==='POST') return send(201,store.createProduct(await jsonBody(req)));
        if(key && parts.length===2 && method==='GET') return send(200,store.product(key));
        if(key && parts.length===2 && method==='PATCH') return send(200,store.updateProduct(key,await jsonBody(req)));
        if(key && parts.length===2 && method==='DELETE') return send(200,store.removeProduct(key));
        if(action==='references' && parts.length===3 && method==='POST') return send(201,store.addReference(key,await jsonBody(req)));
        if(action==='references' && parts.length===3 && method==='PUT') return send(200,store.updateReferences(key,await jsonBody(req)));
        if(action==='references' && parts.length===4 && method==='DELETE') return send(200,store.removeReference(key,refId));
      }
      if(resource==='assets') {
        if(!key && method==='POST') {
          const metadata={kind:url.searchParams.get('kind')??'original',parentId:url.searchParams.get('parentId'),name:decodeURIComponent(req.headers['x-asset-name']??'upload'),mediaType:req.headers['content-type']};
          return send(201,store.putAsset(await body(req,store.config.maxAssetBytes),metadata));
        }
        if(key && parts.length===2 && method==='GET') return send(200,store.asset(key));
        if(key && parts.length===2 && method==='DELETE') return send(200,store.removeAsset(key));
        if(key && action==='content' && parts.length===3 && method==='GET') {
          const a=store.asset(key), bytes=store.readAsset(key);
          res.writeHead(200,{'Content-Type':a.mediaType,'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="${a.id}.${a.mediaType.split('/')[1]}"`}); return res.end(bytes);
        }
      }
      if(resource==='tasks') {
        if(!key && method==='GET') return send(200,{tasks:store.tasks()});
        if(!key && method==='POST') { const result=store.submit(await jsonBody(req),req.headers['idempotency-key']); executor?.tick(); return send(result.duplicate?200:201,result); }
        if(key && parts.length===2 && method==='GET') return send(200,store.task(key));
        if(action==='events' && parts.length===3 && method==='GET') return send(200,{events:store.events(key,Number(url.searchParams.get('after')??0))});
        if(action==='cancel' && parts.length===3 && method==='POST') return send(200,executor?executor.cancel(key):store.cancel(key));
        if(action==='retry' && parts.length===3 && method==='POST') { const result=store.retry(key,await jsonBody(req)); executor?.tick(); return send(200,result); }
      }
      if(resource==='results') {
        if(key && parts.length===2 && method==='GET') return send(200,store.result(key));
        if(key && action==='versions' && parts.length===3 && method==='POST') return send(201,store.appendVersion(key,await jsonBody(req),req.headers['idempotency-key']));
      }
      throw new Fault('NOT_FOUND','Route not found',404);
    } catch(error) {
      const status=error instanceof Fault?error.status:500;
      send(status,{error:{code:error instanceof Fault?error.code:'INTERNAL',message:error instanceof Fault?error.message:'Internal backend error'}});
    }
  };
}
export async function startApi({store,executor=null,port=0}) {
  fail(Number.isInteger(port) && port>=0 && port<=65535 && port!==5178,'INVALID_PORT','Use an available local port other than 5178');
  const server=http.createServer(createApiHandler({store,executor}));
  server.requestTimeout=30_000; server.headersTimeout=15_000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,url:`http://127.0.0.1:${server.address().port}${PREFIX}`,close:()=>new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();})};
}
