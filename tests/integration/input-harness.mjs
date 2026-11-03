import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRuntime} from '../../backend/integration/runtime.mjs';
import {staticHandler} from '../../backend/integration/static.mjs';
import {handlers,fixturePNG} from './fixtures.mjs';

export async function inputHarness({dataDir,delay=10,recognizeText=undefined,testHandlers=handlers({delay})}={}){
 const temporary=!dataDir;
 dataDir??=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-input-'));
 const runtime=createRuntime({dataDir,testHandlers,recognizeText,key:''});
 const serve=staticHandler(process.cwd()+'/');
 const server=http.createServer((req,res)=>req.url.startsWith('/api/')?runtime.handler(req,res):serve(req,res));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const base=`http://127.0.0.1:${server.address().port}`;
 return {runtime,base,dataDir,async close(){await new Promise(r=>server.close(r));await runtime.close();if(temporary)fs.rmSync(dataDir,{recursive:true,force:true});}};
}
export function legacyProduct(store,clientId='legacy'){
 const facts={confirmed:[{id:'f1',key:'容量',value:'500ml',source:{kind:'user-confirmed',locator:'legacy'}}],unknowns:[],originalSource:'kept'};
 const p=store.createProduct({name:'旧蓝杯',facts});
 store.run('INSERT INTO integration_products VALUES(?,?)',clientId,p.id);
 const a=store.putAsset(fixturePNG('INPUT TEST ONLY',32,32),{kind:'original',name:'input-test.png',mediaType:'image/png'});
 return store.addReference(p.id,{assetId:a.id,role:'product'});
}
