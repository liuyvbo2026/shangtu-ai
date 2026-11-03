import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadApiKey} from '../../backend/integration/credentials.mjs';
import {createRuntime} from '../../backend/integration/runtime.mjs';

const synthetic='synthetic-credential-for-local-tests-only';
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'aigc-credential-test-'));
 fs.mkdirSync(path.join(root,'.private'));const file=path.join(root,'.private','key');
 fs.writeFileSync(file,synthetic+'\n',{mode:0o600});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,file};
}
test('server reads private credential and preserves explicit environment precedence',t=>{
 const {root,file}=fixture(t);
 assert.equal(loadApiKey(root,{}),'');
 assert.equal(loadApiKey(root,{ARK_API_KEY_FILE:file}),synthetic);
 assert.equal(loadApiKey(root,{ARK_API_KEY:'explicit-test-credential',ARK_API_KEY_FILE:'/missing'}),'explicit-test-credential');
});
test('credential reader rejects public paths, broad permissions, aliases and malformed content without echo',t=>{
 const {root,file}=fixture(t),read=()=>loadApiKey(root,{ARK_API_KEY_FILE:file});
 const rejected=e=>e.code==='UNSAFE_CREDENTIAL'&&!e.message.includes(synthetic);
 fs.chmodSync(file,0o644);assert.throws(read,rejected);fs.chmodSync(file,0o600);
 const publicFile=path.join(root,'public.js');fs.copyFileSync(file,publicFile);
 assert.throws(()=>loadApiKey(root,{ARK_API_KEY_FILE:publicFile}),rejected);
 const alias=path.join(root,'.private','link');fs.symlinkSync(file,alias);
 assert.throws(()=>loadApiKey(root,{ARK_API_KEY_FILE:alias}),rejected);
 fs.linkSync(file,path.join(root,'hardlink'));assert.throws(read,rejected);fs.unlinkSync(path.join(root,'hardlink'));
 for(const content of [synthetic+'\r\nInjected: header','',synthetic.repeat(200)]){
  fs.writeFileSync(file,content);assert.throws(read,rejected);
 }
 assert.throws(()=>loadApiKey(root,{ARK_API_KEY_FILE:path.join(root,'.private','absent')}),rejected);
});
test('configured credentials and budget cannot schedule without authorized references; no secret in health or DB',async t=>{
 const {root,file}=fixture(t),runtime=createRuntime({dataDir:path.join(root,'.private','data'),key:loadApiKey(root,{ARK_API_KEY_FILE:file}),config:{accountConfirmed:true,budgetId:'test-five-cny',budgetCny:5,reservePerImageCny:0.12,priceEvidence:'SYNTHETIC TEST',authorizedReferenceHashes:[],authorizationEvidence:''}});
 t.after(()=>runtime.close());
 assert.equal(runtime.executor,null);assert.equal(runtime.status().ready,false);
 assert.deepEqual(runtime.status().missing,['授权参考图及事实']);
 assert.ok(!JSON.stringify(runtime.status()).includes(synthetic));
 assert.equal(runtime.store.get('SELECT count(*) AS n FROM provider_calls').n,0);
});
