import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.mp4':'video/mp4'};
export function staticHandler(root){root=path.resolve(root);return async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname==='/')pathname='/index.html';
  const allowed=['/index.html','/editor-test.html','/editor.html'].includes(pathname)||/^\/src\/[a-zA-Z0-9_./-]+\.(js|css)$/.test(pathname)||/^\/assets\/[a-zA-Z0-9_-]+\.(png|svg|mp4)$/.test(pathname)||/^\/tests\/editor\/[a-zA-Z0-9_-]+\.js$/.test(pathname);
  if(!allowed||pathname.split('/').some(s=>s.startsWith('.'))){res.writeHead(404);res.end('Not found');return;}
  const target=path.resolve(root,'.'+pathname),real=await realpath(target);
  if(real!==target||!real.startsWith(root+path.sep)||!(await stat(real)).isFile()){res.writeHead(404);res.end();return;}
  const size=(await stat(real)).size,video=path.extname(target)==='.mp4';
  const headers={'Content-Type':mime[path.extname(target)],'Content-Length':size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin',...(video?{'Accept-Ranges':'bytes'}:{})};
  if(video&&req.method==='GET'&&req.headers.range){
   const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
   let start=0,end=size-1;
   if(match&&(match[1]||match[2])){
    if(!match[1])start=Math.max(0,size-Number(match[2]));
    else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
   }else start=NaN;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
   res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${size}`});
   res.end((await readFile(real)).subarray(start,end+1));return;
  }
  res.writeHead(200,headers);
  res.end(req.method==='HEAD'?undefined:await readFile(real));
 }catch{res.writeHead(404);res.end('Not found');}
};}
