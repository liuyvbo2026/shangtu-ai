import test from 'node:test';
import assert from 'node:assert/strict';
import {startApi} from '../../backend/http.mjs';
import {publishToKit} from '../../src/editor/publish.js';
import {sandbox,storeAt,product,input,count} from './helpers.mjs';
import {TEST_CONTRACT,fixturePNG} from './test-processor.mjs';

test('editor result save survives lost response and restart, preserves versions, refuses concurrent edits',async t=>{
 const dir=sandbox(t);let store=storeAt(dir),server;
 t.after(async()=>{await server?.close();store.close();});
 const p=product(store),task=store.submit(input(p,['a']),'editor').task,claim=store.claim(TEST_CONTRACT);
 store.complete(claim,{bytes:fixturePNG('original')});
 const result=store.task(task.id).children[0].result,original=result.versions[0].assetId;
 const session={documentId:'draft-one',currentVersionId:'edit-one',name:'编辑',source:{kind:'kit-result',resultId:result.id,resultVersion:1,serverAssetId:original}};
 server=await startApi({store});let loseResponse=true,renders=0;
 const api=async(route,{method='GET',body,headers={}}={})=>{
  const response=await fetch(server.url+route,{method,headers:{'X-Backend-Client':'local-development',...(body?{'Content-Type':body instanceof Blob?'image/png':'application/json'}:{}),...headers},body:body instanceof Blob?body:body?JSON.stringify(body):undefined});
  const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error.message),{code:value.error.code});
  if(loseResponse&&route.endsWith('/versions')){loseResponse=false;throw Error('connection lost after commit');}
  return value;
 };
 const render=async()=>{renders++;return new Blob([fixturePNG('edited-'+session.currentVersionId)],{type:'image/png'});};
 await assert.rejects(publishToKit(session,render,api),/connection lost/);
 assert.equal(count(store,'result_versions'),2);
 await server.close();store.close();store=storeAt(dir);server=await startApi({store});
 assert.deepEqual(await publishToKit(session,render,api),{version:2,duplicate:true});assert.equal(renders,1);
 const saved=store.result(result.id).versions[1];
 const replayAsset=store.putAsset(fixturePNG('edited-edit-one'),{kind:'derived',parentId:original});
 assert.equal(store.appendVersion(result.id,{assetId:replayAsset.id,expectedVersion:1},'draft-one:edit-one').versions.length,2);
 const changed=store.putAsset(fixturePNG('tampered'),{kind:'derived',parentId:original});
 assert.throws(()=>store.appendVersion(result.id,{assetId:changed.id,expectedVersion:1},'draft-one:edit-one'),{code:'IDEMPOTENCY_CONFLICT'});
 session.currentVersionId='edit-two';assert.deepEqual(await publishToKit(session,render,api),{version:3,duplicate:false});
 const latest=store.result(result.id).versions.at(-1),other=store.putAsset(fixturePNG('other-editor'),{kind:'derived',parentId:latest.assetId});
 store.appendVersion(result.id,{assetId:other.id,expectedVersion:3});
 session.currentVersionId='edit-three';await assert.rejects(publishToKit(session,render,api),/已有更新版本/);assert.equal(renders,2);
 assert.equal(count(store,'result_versions'),4);assert.deepEqual(store.readAsset(original),fixturePNG('original'));assert.deepEqual(store.readAsset(saved.assetId),fixturePNG('edited-edit-one'));
 assert.equal(store.task(task.id).revision,task.revision,'editing retains the established task revision contract');
});
