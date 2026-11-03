import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../../backend/store.mjs';
import { backup,restore } from '../../backend/backup.mjs';
import { TEST_CONTRACT,fixturePNG } from './test-processor.mjs';
import { sandbox,storeAt,product,input,count } from './helpers.mjs';

test('one product owns multiple references; updates, ordering, removal and snapshot remain traceable',t=>{
  const dir=sandbox(t),s=storeAt(dir);t.after(()=>s.close());
  let p=product(s,'multi',3);assert.equal(s.products().length,1);assert.equal(p.references.length,3);
  const submitted=s.submit(input(p),'multi'),snapshot=submitted.task.input;
  p=s.updateProduct(p.id,{name:'new name',facts:{confirmed:{color:'blue'}},expectedRevision:p.revision});
  p=s.updateReferences(p.id,{expectedRevision:p.revision,references:[...p.references].reverse().map(r=>({...r,role:'back'}))});
  const removed=p.references[0].assetId;s.removeReference(p.id,p.references[0].id);
  assert.equal(s.product(p.id).references.length,2);
  assert.deepEqual(s.task(submitted.task.id).input,snapshot);
  assert.equal(snapshot.product.name,'multi');assert.deepEqual(snapshot.references.map(r=>r.role),['front','detail','detail']);
  assert.equal(count(s,'products'),1);
  assert.throws(()=>s.removeAsset(removed),{code:'ASSET_REFERENCED'});
  assert.throws(()=>s.updateProduct(p.id,{name:'stale',expectedRevision:1}),{code:'REVISION_CONFLICT'});
  s.removeProduct(p.id);assert.equal(s.products().length,0);
  assert.equal(s.task(submitted.task.id).productId,p.id);assert.equal(s.readAsset(removed).length>0,true);
});

test('metadata and original/derived bytes survive reopening; exclusive writer prevents concurrent owners',t=>{
  const dir=sandbox(t);let s=storeAt(dir);t.after(()=>{if(!s.closed)s.close();});
  const p=product(s),a=s.asset(p.references[0].assetId);
  const derived=s.putAsset(fixturePNG('derived'),{kind:'derived',parentId:a.id,name:'derived.png'});
  const task=s.submit(input(p),'restart').task;
  assert.match(a.path,/^original\//);assert.match(derived.path,/^derived\//);
  assert.throws(()=>storeAt(dir),{code:'STORE_LOCKED'});
  s.close();s=storeAt(dir);
  assert.deepEqual(s.product(p.id),p);assert.deepEqual(s.task(task.id),task);
  assert.deepEqual(s.readAsset(a.id),fixturePNG('product-0'));assert.deepEqual(s.readAsset(derived.id),fixturePNG('derived'));
  assert.throws(()=>s.removeAsset(a.id),{code:'ASSET_REFERENCED'});
  s.removeAsset(derived.id);assert.throws(()=>s.asset(derived.id),{code:'NOT_FOUND'});
});

test('file validation rejects traversal, MIME spoof, corrupt data, symlinks and configured limits',t=>{
  const dir=sandbox(t),s=storeAt(dir,{config:{maxReferences:2,maxAssetBytes:1024,maxPixels:16,maxSlots:2}});t.after(()=>s.close());
  const p=product(s,'limited',2);
  const extra=s.putAsset(fixturePNG('extra'));
  assert.throws(()=>s.addReference(p.id,{assetId:extra.id}),{code:'REFERENCE_LIMIT'});
  assert.throws(()=>s.putAsset(fixturePNG(),{name:'../escape.png'}),{code:'INVALID_INPUT'});
  assert.throws(()=>s.putAsset(fixturePNG(),{mediaType:'image/jpeg'}),{code:'INVALID_IMAGE'});
  assert.throws(()=>s.putAsset(Buffer.alloc(2048)),{code:'INVALID_IMAGE'});
  const corrupt=fixturePNG();corrupt[30]^=1;
  assert.throws(()=>s.putAsset(corrupt),{code:'INVALID_IMAGE'});
  assert.throws(()=>s.files.resolve('../store.sqlite'),{code:'UNSAFE_PATH'});
  assert.throws(()=>s.submit(input(p),'too-many'),{code:'INVALID_INPUT'});
  const real=s.files.resolve(extra.path);fs.unlinkSync(real);fs.symlinkSync(path.join(s.root,'store.sqlite'),real);
  assert.throws(()=>s.readAsset(extra.id),{code:'ASSET_UNAVAILABLE'});
  const other=path.join(dir,'symlink');fs.symlinkSync(s.root,other);
  assert.throws(()=>new Store({dataDir:other}),{code:'UNSAFE_PATH'});
});

test('submission deduplicates before current-product revision checks; differing payload conflicts',t=>{
  const dir=sandbox(t),s=storeAt(dir);t.after(()=>s.close());const p=product(s),req=input(p);
  const first=s.submit(req,'dedupe');s.updateProduct(p.id,{name:'changed',expectedRevision:p.revision});
  assert.equal(s.submit(structuredClone(req),'dedupe').task.id,first.task.id);
  assert.equal(s.submit(req,'dedupe').duplicate,true);assert.equal(count(s,'tasks'),1);assert.equal(count(s,'children'),3);
  assert.throws(()=>s.submit({...req,description:'different'},'dedupe'),{code:'IDEMPOTENCY_CONFLICT'});
  assert.throws(()=>s.submit(req,'new'),{code:'REVISION_CONFLICT'});
});

test('result versions use optimistic concurrency and preserve original result bytes',t=>{
  const dir=sandbox(t),s=storeAt(dir);t.after(()=>s.close());const p=product(s);
  const task=s.submit(input(p,['a']),'versions').task,claim=s.claim(TEST_CONTRACT);
  assert.equal(s.complete(claim,{bytes:fixturePNG('output')}),true);
  const result=s.task(task.id).children[0].result,original=result.versions[0].assetId;
  const next=s.putAsset(fixturePNG('edit'),{kind:'derived',parentId:original});
  const changed=s.appendVersion(result.id,{assetId:next.id,expectedVersion:1});
  assert.equal(changed.versions.length,2);assert.equal(changed.productId,p.id);
  assert.throws(()=>s.appendVersion(result.id,{assetId:next.id,expectedVersion:1}),{code:'REVISION_CONFLICT'});
  assert.equal(s.complete(claim,{bytes:fixturePNG('late-old-output')}),false);
  assert.deepEqual(s.readAsset(original),fixturePNG('output'));assert.deepEqual(s.readAsset(next.id),fixturePNG('edit'));
  assert.equal(count(s,'results'),1);assert.equal(count(s,'result_versions'),2);
});

test('backup restores exact logical rows and file hashes, including queued tasks; corrupted backup is rejected',t=>{
  const dir=sandbox(t);let s=storeAt(dir);t.after(()=>{if(!s.closed)s.close();});const p=product(s,'backup',3);
  const task=s.submit(input(p),'backup').task,c=s.claim(TEST_CONTRACT);s.complete(c,{bytes:fixturePNG('saved')});
  const before=s.task(task.id),products=s.products(),tables=['products','assets','product_references','tasks','task_assets','children','attempts','results','result_versions','events'];
  const rows=Object.fromEntries(tables.map(table=>[table,s.all(`SELECT * FROM ${table}`)]));
  const dst=path.join(dir,'backup'),manifest=backup(s,dst);s.close();
  assert.equal(manifest.assets.length,4);
  restore(dst,path.join(dir,'restored'));
  const restored=new Store({dataDir:path.join(dir,'restored'),processor:TEST_CONTRACT});
  try {
    assert.deepEqual(restored.products(),products);assert.deepEqual(restored.task(task.id),before);
    for(const table of tables)assert.deepEqual(restored.all(`SELECT * FROM ${table}`),rows[table]);
    for(const a of manifest.assets)assert.equal(restored.asset(a.id).sha256,a.sha256);
    assert.deepEqual(restored.readAsset(before.children[0].result.versions[0].assetId),fixturePNG('saved'));
  } finally {restored.close();}
  const file=path.join(dst,manifest.assets[0].path);fs.writeFileSync(file,'broken');
  assert.throws(()=>restore(dst,path.join(dir,'bad-restore')),{code:'INVALID_BACKUP'});
  assert.equal(fs.existsSync(path.join(dir,'bad-restore')),false);
  assert.throws(()=>restore(dst,path.join(dir,'restored')),{code:'DESTINATION_EXISTS'});
});

test('size and platform policies are injected without copying unverified frontend rules',t=>{
  const dir=sandbox(t),s=storeAt(dir,{config:{allowedSizes:['10x20'],platformRules:{test:{language:['zh']}}}});t.after(()=>s.close());const p=product(s);
  const req=input(p,['a']);req.slots[0].size={width:10,height:20};assert.equal(s.submit(req,'allowed').task.state,'queued');
  assert.throws(()=>s.submit({...req,settings:{platform:'test',language:'en'}},'language'),{code:'INVALID_INPUT'});
  assert.throws(()=>s.submit({...req,slots:[{key:'a',type:'test',size:{width:11,height:20}}]},'size'),{code:'INVALID_INPUT'});
});

test('real JPEG and WebP containers preserve raw size, type, bytes, and detect truncation',t=>{
  const dir=sandbox(t),s=storeAt(dir);t.after(()=>s.close());
  for(const [extension,type] of [['jpg','image/jpeg'],['webp','image/webp']]) {
    const bytes=fs.readFileSync(new URL(`./fixtures/2x3.${extension}`,import.meta.url));
    const a=s.putAsset(bytes,{mediaType:type,name:`fixture.${extension}`});
    assert.equal(a.width,2);assert.equal(a.height,3);assert.equal(a.mediaType,type);assert.deepEqual(s.readAsset(a.id),bytes);
    assert.throws(()=>s.putAsset(bytes.subarray(0,bytes.length-3)),{code:'INVALID_IMAGE'});
  }
});

test('offline backup/restore CLI round trip and active-writer refusal',t=>{
  const dir=sandbox(t),s=storeAt(dir),p=product(s),task=s.submit(input(p),'cli').task,cli=new URL('../../backend/maintenance.mjs',import.meta.url).pathname;
  const backupPath=path.join(dir,'cli-backup'),restorePath=path.join(dir,'cli-restore');
  let result=spawnSync(process.execPath,[cli,'backup',s.root,backupPath],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/STORE_LOCKED/);assert.equal(fs.existsSync(backupPath),false);
  s.close();
  result=spawnSync(process.execPath,[cli,'backup',s.root,backupPath],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  result=spawnSync(process.execPath,[cli,'restore',backupPath,restorePath],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const restored=new Store({dataDir:restorePath});try{assert.deepEqual(restored.task(task.id),task);assert.deepEqual(restored.product(p.id),p);}finally{restored.close();}
  result=spawnSync(process.execPath,[cli,'backup',path.join(dir,'missing'),path.join(dir,'empty')],{encoding:'utf8'});assert.notEqual(result.status,0);assert.equal(fs.existsSync(path.join(dir,'missing')),false);
});
