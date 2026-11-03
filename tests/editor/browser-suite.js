import * as core from '../../src/editor/core.js';
import * as storage from '../../src/editor/storage.js';
import {renderScene,exportPNG,decodeImage} from '../../src/editor/render.js';
import {zip} from '../../src/export.js';
import {fixtureAsset} from './fixtures.js';

const assert = (ok,message) => {if (!ok) throw Error(message);};
async function pixels(canvas) {return storage.sha256(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);}
async function decodedPixels(blob) {const im = await decodeImage(blob), c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im,0,0); return {width:c.width,height:c.height,hash:await pixels(c)};}
export async function runVerification() {
  const report = {suite:'05A browser editor',schemaVersion:1,expectedChecks:19,createdAt:new Date().toISOString(),userAgent:navigator.userAgent,checks:[],measurements:{}}, files = [];
  const check = async (name,fn) => {try {const detail = await fn(); report.checks.push({name,ok:true,detail:detail ?? null});} catch(e) {report.checks.push({name,ok:false,error:e.message}); throw e;}};
  try {
    const base = await fixtureAsset(), badge = await fixtureAsset('badge'), assets = new Map([[base.id,base],[badge.id,badge]]), resolve = id => assets.get(id);
    let s = core.createSession(base,{name:'[05A 自动验证] 持久化与恢复',source:{kind:'test-fixture'}});
    const originalJSON = JSON.stringify(s.versions[0]), sourceHash = await storage.sha256(base.blob);
    const before = await exportPNG(core.currentScene(s),resolve), beforePixel = await decodedPixels(before);
    files.push({name:'01-original.png',blob:before});
    await check('原图预览与真实 PNG 解码像素一致',async () => {
      assert(beforePixel.hash === await pixels(await renderScene(core.currentScene(s),resolve)),'PNG 与预览不同');
      assert(beforePixel.width === 960 && beforePixel.height === 720,'导出尺寸错误'); return beforePixel;
    });
    const text = core.textLayer({x:50,y:50,width:660,height:160,text:'EDITABLE 05A',style:{fontSize:62,color:'#252525'}});
    s = core.addLayer(s,text); const withText = await exportPNG(core.currentScene(s),resolve);
    await check('添加文字改变画面与导出文件',async () => {
      assert((await decodedPixels(withText)).hash !== beforePixel.hash,'文字没有改变像素');
      assert(await storage.sha256(withText) !== await storage.sha256(before),'导出文件未改变');
    });
    s = core.updateLayer(s,text.id,{text:'SAVED VERSION',style:{color:'#535f49',fontSize:54,fontWeight:700,align:'center'}});
    await check('文字内容和样式改变真实像素',async () => {assert((await decodedPixels(await exportPNG(core.currentScene(s),resolve))).hash !== (await decodedPixels(withText)).hash,'样式未生效');});
    const image = core.imageLayer(badge,{x:90,y:65,width:200,height:200,name:'测试图片图层'}); s = core.addLayer(s,image);
    const upperImage = await exportPNG(core.currentScene(s),resolve);
    s = core.moveLayer(s,image.id,1);
    await check('图层顺序改变重叠区域',async () => {assert((await decodedPixels(await exportPNG(core.currentScene(s),resolve))).hash !== (await decodedPixels(upperImage)).hash,'层级未生效');});
    const previous = s, previousPNG = await exportPNG(core.currentScene(s),resolve);
    s = core.updateLayer(s,image.id,{x:670,y:430,width:180,height:140});
    const changed = await exportPNG(core.currentScene(s),resolve), changedPixel = await decodedPixels(changed);
    files.push({name:'02-edited.png',blob:changed});
    await check('位置与大小调整改变画面和 PNG',async () => {assert(changedPixel.hash !== (await decodedPixels(previousPNG)).hash,'变换未生效'); return changedPixel;});
    s = core.undo(s); const undone = await exportPNG(core.currentScene(s),resolve);
    files.push({name:'03-before-transform.png',blob:previousPNG},{name:'04-undo.png',blob:undone});
    await check('撤销逐像素恢复前一个画面',async () => {assert((await decodedPixels(undone)).hash === (await decodedPixels(previousPNG)).hash,'撤销像素不一致'); assert(s.currentVersionId === previous.currentVersionId,'撤销版本不一致');});
    s = core.redo(s);
    await check('重做逐像素恢复编辑结果',async () => {assert((await decodedPixels(await exportPNG(core.currentScene(s),resolve))).hash === changedPixel.hash,'重做不一致');});
    s = core.markSaved(s); let record = await storage.persistDocument(s,{assets:[base,badge]});
    const reopened = await storage.loadDocument(s.documentId), reloadedPNG = await exportPNG(core.currentScene(reopened.session),storage.getAsset);
    files.push({name:'05-reopened.png',blob:reloadedPNG});
    await check('IndexedDB 保存后重新打开逐像素一致',async () => {assert(core.serialize(reopened.session) === core.serialize(s),'状态重载不同'); assert((await decodedPixels(reloadedPNG)).hash === changedPixel.hash,'重载图片不同');});
    s = core.updateLayer(s,text.id,{text:'UNSAVED DRAFT'}); record = await storage.persistDocument(s,{expectedEtag:record.etag});
    await check('未保存草稿及撤销记录经存储保留',async () => {const loaded = await storage.loadDocument(s.documentId); assert(core.isDirty(loaded.session),'草稿被误设为保存'); assert(core.serialize(loaded.session) === core.serialize(s),'草稿恢复失败');});
    s = core.cancelChanges(s);
    await check('取消修改恢复最近保存版本',async () => {assert(!core.isDirty(s),'取消后仍为脏状态'); assert((await decodedPixels(await exportPNG(core.currentScene(s),resolve))).hash === changedPixel.hash,'取消后画面不一致');});
    const canceled = s; s = core.restoreVersion(s,s.originalVersionId);
    const restored = await exportPNG(core.currentScene(s),resolve); files.push({name:'06-restored-original.png',blob:restored});
    await check('恢复原版且保留历史和原始资产',async () => {
      assert((await decodedPixels(restored)).hash === beforePixel.hash,'原版恢复失败'); assert(JSON.stringify(s.versions[0]) === originalJSON,'原始版本被修改');
      assert(await storage.sha256(base.blob) === sourceHash,'源文件被修改'); assert(s.versions.length > canceled.versions.length,'恢复没有创建版本');
    });
    s = core.undo(s);
    const serialized = core.serialize(s); s = core.deserialize(serialized);
    await check('序列化保留保存点、版本分支与撤销重做',() => {assert(core.serialize(s) === serialized && s.redo.length > 0,'序列化状态丢失');});
    const portable = await storage.exportBundle(s,resolve); files.push({name:'edited.editor.json',blob:portable});
    const imported = await storage.importBundle(portable), importedPNG = await exportPNG(core.currentScene(imported.session),storage.getAsset);
    files.push({name:'07-imported.png',blob:importedPNG});
    await check('自包含编辑包导入副本与保存结果一致',async () => {assert(imported.id !== s.documentId,'导入覆盖了原文档'); assert((await decodedPixels(importedPNG)).hash === changedPixel.hash,'编辑包像素不同');});
    await check('损坏图片包被拒绝且不产生半导入文档',async () => {
      const count = (await storage.listDocuments()).length, invalid = JSON.parse(await portable.text()); invalid.assets[0].width++;
      let rejected = false; try {await storage.importBundle(new Blob([JSON.stringify(invalid)]));} catch {rejected = true;}
      assert(rejected && count === (await storage.listDocuments()).length,'损坏包没有原子拒绝');
    });
    await check('多页面旧版本写入被拒绝',async () => {
      record = await storage.persistDocument(s,{expectedEtag:record.etag}); const stale = record.etag;
      record = await storage.persistDocument(core.markSaved(s),{expectedEtag:stale});
      let rejected = false; try {await storage.persistDocument(s,{expectedEtag:stale});} catch(e) {rejected = /其他页面/.test(e.message);}
      assert(rejected,'陈旧保存覆盖了新版本');
    });
    await check('已有编辑版本不可被原地覆盖',async () => {
      const tampered = core.clone(record.session); tampered.versions[1].scene.layers[1].text = 'TAMPERED';
      let rejected = false; try {await storage.persistDocument(tampered,{expectedEtag:record.etag});} catch(e) {rejected = /禁止覆盖/.test(e.message);}
      assert(rejected,'已保存版本被覆盖');
    });
    await check('缩放滚动偏移、反向框选映射到源图',() => {
      const scene = core.currentScene(s), viewport = {left:120,top:-80,width:480,height:360};
      const a = core.clientToDocument({x:360,y:100},viewport,scene), b = core.clientToDocument({x:240,y:10},viewport,scene);
      const mapped = core.selectionToSource(core.selectionRect(a,b),scene.layers[0],base);
      assert(JSON.stringify(mapped.rect) === JSON.stringify({x:240,y:180,width:240,height:180}),'原图坐标错误'); return mapped;
    });
    await check('变换及裁剪图层映射精确、无交集返回空',() => {
      const layer = core.imageLayer(base,{x:100,y:80,width:400,height:300,sourceRect:{x:100,y:50,width:800,height:600}});
      const mapped = core.selectionToSource({x:200,y:155,width:100,height:75},layer,base);
      assert(JSON.stringify(mapped.rect) === JSON.stringify({x:300,y:200,width:200,height:150}),'裁剪映射错误');
      assert(core.selectionToSource({x:0,y:0,width:10,height:10},layer,base) === null,'外部选区映射错误'); return mapped;
    });
    await check('缺失图片阻止导出，不生成假成功文件',async () => {let rejected = false; try {await exportPNG(core.currentScene(s),() => null);} catch {rejected = true;} assert(rejected,'缺失资产仍导出成功');});
    report.measurements = {sourceAsset:base.id,sourceHash,originalPixelHash:beforePixel.hash,editedPixelHash:changedPixel.hash,originalPNGHash:await storage.sha256(before),editedPNGHash:await storage.sha256(changed),reopenedPNGHash:await storage.sha256(reloadedPNG),restoredPNGHash:await storage.sha256(restored),documentId:s.documentId,importedDocumentId:imported.id};
  } catch(e) {report.failure = e.message;}
  report.passed = report.checks.filter(x => x.ok).length;
  report.ok = !report.failure && report.passed === report.expectedChecks;
  files.push({name:'report.json',blob:new Blob([JSON.stringify(report,null,2)],{type:'application/json'})});
  return {report,bundle:await zip(files)};
}
