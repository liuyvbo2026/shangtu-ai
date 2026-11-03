// Dedicated synthetic browser fixture. No production key/config or network model transport.
import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {textFixture,fixtureOutput,fixtureResponse} from './mimo-fixtures.mjs';
import {staticHandler} from '../../backend/integration/static.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const h=textFixture({dataDir:root+'.private/mimo-browser-qa',transport:async({data})=>{
 await new Promise(r=>setTimeout(r,600));
 if(data.userText.includes('TEST_FAIL'))return fixtureResponse({invalid:true});
 return fixtureResponse(fixtureOutput(data));
}});
const serve=staticHandler(root),server=http.createServer((req,res)=>req.url.startsWith('/api/')?h.runtime.handler(req,res):serve(req,res));
server.listen(5193,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:5193',mode:'SYNTHETIC_MIMO_PROTOCOL_ONLY',productId:h.p.id})));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{server.close();await h.close();process.exit(0);});
