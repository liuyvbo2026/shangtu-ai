import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configureStartup} from './backend/startup-config.mjs';
import {startLocalServer,startupError} from './backend/local-server.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
// Same origin API; only explicitly public frontend resources are served.
import {createRuntime,loadConfig} from './backend/integration/runtime.mjs';
import {loadApiKey,loadMimoKey} from './backend/integration/credentials.mjs';
import {staticHandler} from './backend/integration/static.mjs';
import {createApiSettings} from './backend/integration/api-settings.mjs';
try{
 configureStartup(root);
 const service=await startLocalServer({
  port:Number(process.env.PORT??5178),instanceId:createHash('sha256').update(root).digest('hex').slice(0,16),
  serveStatic:staticHandler(root),
  createRuntime:()=>{
   const config=loadConfig(root);
   const apiSettings=createApiSettings({root,fallback:{image:loadApiKey(root),text:loadMimoKey(root)}});
   return createRuntime({dataDir:path.resolve(process.env.AIGC_DATA_DIR||path.join(root,'.private','single-product')),config,apiSettings});
  }
 });
 console.log(`${new Date().toISOString()} 商图AI: http://127.0.0.1:${service.server.address().port} (${service.runtime.status().mode}) pid=${process.pid}`);
 let closing=false;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
  if(closing)return;closing=true;
  const deadline=setTimeout(()=>{console.error(`${new Date().toISOString()} SHUTDOWN_TIMEOUT`);process.exit(1);},320000);deadline.unref();
  try{await service.close();console.log(`${new Date().toISOString()} stopped ${signal}`);process.exit(0);}
  catch{console.error(`${new Date().toISOString()} SHUTDOWN_FAILED`);process.exit(1);}
 });
}catch(error){console.error(startupError(error));process.exitCode=1;}
