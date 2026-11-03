import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
export function staticHandler(root){root=path.resolve(root);return async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname==='/')pathname='/index.html';
  const allowed=['/index.html','/editor-test.html','/editor.html'].includes(pathname)||/^\/src\/[a-zA-Z0-9_./-]+\.(js|css)$/.test(pathname)||/^\/assets\/[a-zA-Z0-9_-]+\.(png|svg)$/.test(pathname)||/^\/tests\/editor\/[a-zA-Z0-9_-]+\.js$/.test(pathname);
  if(!allowed||pathname.split('/').some(s=>s.startsWith('.'))){res.writeHead(404);res.end('Not found');return;}
  const target=path.resolve(root,'.'+pathname),real=await realpath(target);
  if(real!==target||!real.startsWith(root+path.sep)||!(await stat(real)).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(target)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});
  res.end(req.method==='HEAD'?undefined:await readFile(target));
 }catch{res.writeHead(404);res.end('Not found');}
};}
