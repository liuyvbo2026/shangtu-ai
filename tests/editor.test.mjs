import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/editor/core.js';
const asset = {id:'original-asset',width:1200,height:800};
const fresh = () => c.createSession(asset);

test('05A 编辑、撤销、分支和恢复保留原始版本与旧版本',() => {
  const s = fresh(), original = c.serialize(s), layer = c.textLayer({text:'before'});
  const added = c.addLayer(s,layer), changed = c.updateLayer(added,layer.id,{text:'after'}), undone = c.undo(changed);
  assert.equal(c.serialize(s),original); assert.equal(c.currentScene(undone).layers[1].text,'before');
  assert.deepEqual(c.currentScene(c.redo(undone)),c.currentScene(changed));
  const fork = c.updateLayer(undone,layer.id,{text:'branch'});
  assert.equal(fork.redo.length,0); assert.ok(fork.versions.some(v=>v.id===changed.currentVersionId));
  const restored = c.restoreVersion(fork,changed.currentVersionId);
  assert.equal(c.currentScene(restored).layers[1].text,'after');
  assert.equal(c.currentVersion(restored).parentId,fork.currentVersionId);
  assert.equal(c.currentVersion(restored).restoredFrom,changed.currentVersionId);
  assert.deepEqual(c.currentScene(c.restoreVersion(restored,s.originalVersionId)),c.currentScene(s));
});
test('05A 保存、取消和取消后的撤销语义',() => {
  const l = c.textLayer(), saved = c.markSaved(c.addLayer(fresh(),l)), draft = c.updateLayer(saved,l.id,{text:'draft'}), canceled = c.cancelChanges(draft);
  assert.ok(c.isDirty(draft)); assert.equal(c.isDirty(canceled),false);
  assert.equal(canceled.currentVersionId,saved.currentVersionId); assert.equal(c.undo(canceled).currentVersionId,draft.currentVersionId);
  assert.deepEqual(c.deserialize(c.serialize(draft)),draft);
});
test('05A 克隆隔离、无变化操作不产生版本',() => {
  const s = fresh(), scene = c.currentScene(s); scene.layers[0].x = 100;
  assert.equal(c.currentScene(s).layers[0].x,0); assert.equal(c.commit(s,c.currentScene(s)),s);
});
test('05A 图片替换、文本样式、层级与命中次序',() => {
  let s = fresh(); const a = c.imageLayer(asset,{name:'overlay'}), t = c.textLayer({x:10,y:10});
  s = c.addLayer(c.addLayer(s,a),t);
  assert.equal(c.hitTest(c.currentScene(s),{x:20,y:20}).id,t.id);
  s = c.moveLayer(s,a.id,2); assert.equal(c.hitTest(c.currentScene(s),{x:20,y:20}).id,a.id);
  s = c.updateLayer(s,t.id,{style:{fontSize:22}}); assert.equal(c.currentScene(s).layers[1].style.color,'#222326');
  s = c.updateLayer(s,a.id,{assetId:'replacement'}); assert.ok(c.referencedAssets(s).includes('original-asset')); assert.ok(c.referencedAssets(s).includes('replacement'));
  assert.equal(c.currentScene(c.removeLayer(s,a.id)).layers.length,2);
});
test('05A 锁定图层禁止修改移动删除，允许显式解锁',() => {
  const s = fresh(), id = c.currentScene(s).layers[0].id;
  for (const fn of [()=>c.updateLayer(s,id,{x:20}),()=>c.moveLayer(s,id,1),()=>c.removeLayer(s,id)]) assert.throws(fn,/锁/);
  assert.equal(c.currentScene(c.updateLayer(c.updateLayer(s,id,{locked:false}),id,{x:20})).layers[0].x,20);
});
test('05A 无效尺寸、颜色、版本引用和重复图层拒绝',() => {
  const s = c.addLayer(fresh(),c.textLayer()), id = c.currentScene(s).layers[1].id;
  for (const patch of [{width:0},{x:NaN},{opacity:2},{style:{color:'url(x)'}},{id:'bad'},{style:{fontSize:Infinity}}]) assert.throws(()=>c.updateLayer(s,id,patch));
  const duplicate = c.currentScene(s); duplicate.layers.push(duplicate.layers[0]); assert.throws(()=>c.commit(s,duplicate));
  const bad = c.clone(s); bad.currentVersionId = 'unknown'; assert.throws(()=>c.deserialize(JSON.stringify(bad)));
  const badRoot = c.clone(s); badRoot.versions[0].scene.layers[0].assetId = 'changed'; assert.throws(()=>c.validateSession(badRoot),/原始版本/);
});
test('05A CSS 缩放与页面滚动映射，边界钳制与反向选区',() => {
  const scene = c.currentScene(fresh()), viewport = {left:40,top:-100,width:600,height:400};
  assert.deepEqual(c.clientToDocument({x:340,y:100},viewport,scene),{x:600,y:400});
  assert.deepEqual(c.clientToDocument({x:-10,y:700},viewport,scene),{x:0,y:800});
  assert.deepEqual(c.selectionRect({x:400,y:300},{x:100,y:50}),{x:100,y:50,width:300,height:250});
});
test('05A 源图裁剪、非等比缩放、部分相交及向外取整',() => {
  const l = c.imageLayer(asset,{x:100,y:50,width:400,height:150,sourceRect:{x:200,y:100,width:800,height:600}});
  assert.deepEqual(c.selectionToSource({x:200,y:75,width:100,height:50},l,asset).rect,{x:400,y:200,width:200,height:200});
  assert.deepEqual(c.selectionToSource({x:50,y:40,width:100,height:30},l,asset).rect,{x:200,y:100,width:100,height:80});
  assert.deepEqual(c.selectionToSource({x:100.25,y:50.25,width:1,height:1},l,asset).rect,{x:200,y:101,width:3,height:4});
  assert.equal(c.selectionToSource({x:0,y:0,width:10,height:10},l,asset),null);
  assert.equal(c.selectionToSource({x:150,y:75,width:0,height:20},l,asset),null);
});
test('05A UI 验证入口独立，正式页面不引用编辑测试脚本',async () => {
  const {readFile} = await import('node:fs/promises');
  const index = await readFile(new URL('../index.html',import.meta.url),'utf8'), app = await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(index+app,/editor-test|editor\/page|browser-suite/);
});
