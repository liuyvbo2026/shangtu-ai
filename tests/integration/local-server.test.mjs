import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {startLocalServer,startupError} from '../../backend/local-server.mjs';
import {configureStartup} from '../../backend/startup-config.mjs';
import {agentPlist} from '../../scripts/local-service.mjs';

const staticPage=(req,res)=>{res.writeHead(200);res.end('workspace');};
const runtime=()=>({handler:(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ready:false,billingUnknown:true}));},close:async()=>{}});

test('web stays healthy with generation blocked; duplicate startup never opens another runtime',async t=>{
 let opened=0,closed=0;
 const service=await startLocalServer({port:0,instanceId:'test',serveStatic:staticPage,createRuntime:()=>{opened++;return {...runtime(),close:async()=>{closed++;}};}});
 t.after(()=>service.close());
 const port=service.server.address().port,base=`http://127.0.0.1:${port}`;
 assert.equal(await(await fetch(base)).text(),'workspace');
 assert.equal((await(await fetch(base+'/healthz')).json()).status,'ok');
 assert.equal((await(await fetch(base+'/api/health')).json()).billingUnknown,true);
 await assert.rejects(startLocalServer({port,instanceId:'duplicate',serveStatic:staticPage,createRuntime:()=>{opened++;return runtime();}}),{code:'EADDRINUSE'});
 assert.equal(opened,1);
 assert.equal((await fetch(base+'/healthz')).status,200);
 await Promise.all([service.close(),service.close()]);assert.equal(closed,1);
});

test('failed initialization releases the listening port and redacts error contents',async t=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
 const port=probe.address().port;await new Promise(r=>probe.close(r));
 const secret='private-key-must-not-appear';
 await assert.rejects(startLocalServer({port,instanceId:'fail',serveStatic:staticPage,createRuntime:()=>{throw Error(secret);}}));
 assert.ok(!startupError(Error(secret)).includes(secret));
 const service=await startLocalServer({port,instanceId:'retry',serveStatic:staticPage,createRuntime:runtime});
 t.after(()=>service.close());assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
});

test('unexpected async request error does not take down the local website or expose details',async t=>{
 const service=await startLocalServer({port:0,instanceId:'test',log:()=>{},serveStatic:staticPage,createRuntime:()=>({...runtime(),handler:async()=>{throw Error('secret-response');}})});
 t.after(()=>service.close());const base=`http://127.0.0.1:${service.server.address().port}`;
 const error=await fetch(base+'/api/failure');assert.equal(error.status,500);assert.ok(!(await error.text()).includes('secret-response'));
 assert.equal(await(await fetch(base)).text(),'workspace');
 assert.equal((await fetch(base+'/healthz',{method:'POST'})).status,405);
 const rejected=await new Promise((resolve,reject)=>{http.get(base+'/healthz',{headers:{host:'foreign.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
 assert.equal(rejected,403);
});

test('direct, npm and managed entry points keep saved config while isolated data stays isolated',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'startup-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'.private'));fs.writeFileSync(path.join(root,'.private/integration-round1.json'),'{}');fs.writeFileSync(path.join(root,'.private/ark-api-key'),'test-only');
 const env={};configureStartup(root,env);assert.equal(env.AIGC_CONFIG_FILE,path.join(root,'.private/integration-round1.json'));
 assert.equal(env.ARK_API_KEY_FILE,path.join(root,'.private/ark-api-key'));
 const explicit={AIGC_CONFIG_FILE:'/explicit.json',ARK_API_KEY_FILE:''};configureStartup(root,explicit);assert.deepEqual(explicit,{AIGC_CONFIG_FILE:'/explicit.json',ARK_API_KEY_FILE:''});
 const isolated={AIGC_DATA_DIR:'/isolated'};configureStartup(root,isolated);assert.deepEqual(isolated,{AIGC_DATA_DIR:'/isolated'});
});

test('macOS accepts service paths with spaces and XML characters as exact argument values',{skip:process.platform!=='darwin'},()=>{
 const project='/tmp/project & photos',node='/tmp/Node Tools/node',logs='/tmp/logs & more';
 const result=spawnSync('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{input:agentPlist(project,node,logs),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
 assert.deepEqual(value.ProgramArguments,[node,path.join(project,'scripts/start-configured.mjs')]);
 assert.equal(value.StandardErrorPath,path.join(logs,'stderr.log'));
 assert.equal(value.KeepAlive,true);assert.equal(value.RunAtLoad,true);
});
