import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,setCount,total,changePlatform,resolveSettings,validateKit,resultSlots,freshState,recover,isKitJob,outputSize,previewContext} from '../src/model.js';
import {LocalDemoService} from '../src/demo-service.js';
import {zip} from '../src/export.js';
import {appView,modalView} from '../src/views.js';
test('旧编辑页面恢复到套图，保存的图片和旧任务不会被丢弃',()=>{
 const s=freshState();s.view='editor';s.historyFilter='editor';
 s.docs=[{id:'old-document',layers:[{assetId:'original-image'}]}];
 const old={id:'old-job',kind:'editor',status:'success',results:[{assetId:'old-output'}]};
 s.jobs=[old];recover(s);
 assert.equal(s.view,'kit');assert.equal(s.historyFilter,'all');
 assert.equal(s.docs[0].layers[0].assetId,'original-image');
 assert.equal(s.jobs[0],old);assert.equal(s.jobs.filter(isKitJob).length,0);
});
test('旧套图的单张修改按结果来源迁移，独立商品图记录不会混入',()=>{
 const s=freshState();
 const parent={id:'kit',kind:'kit',createdAt:1,status:'success',refs:['product-source'],results:[{assetId:'kit-output'}]};
 const first={id:'first',kind:'editor',capability:'modify',createdAt:2,status:'success',refs:['kit-output'],results:[{assetId:'first-output'}]};
 const next={id:'next',kind:'editor',capability:'restore-product',createdAt:3,status:'success',refs:['first-output'],results:[]};
 const unrelated={id:'other',kind:'editor',capability:'modify',createdAt:4,status:'success',refs:['unrelated-output'],results:[]};
 s.jobs=[unrelated,next,first,parent];recover(s);
 assert.deepEqual(s.jobs.filter(isKitJob).map(j=>j.id),['next','first','kit']);
 assert.equal(next.parentJobId,'first');assert.deepEqual(next.productRefs,['product-source']);
 assert.equal(unrelated.kind,'editor');
});
test('套图尺寸保留比例与分辨率，任务画布不依赖旧编辑器',()=>{
 assert.deepEqual(outputSize({...defaultSettings(),ratio:'3:4'}),{width:1536,height:2048});
 assert.deepEqual(outputSize({...defaultSettings(),ratio:'16:9',resolution:'1K'}),{width:1024,height:576});
});
test('保留现有皮肤与图片预览，接入已核实的结果工具',()=>{
 const s=freshState(),ui={resultSelections:{},historySearch:'',resultInstruction:''};
 const original={id:'p',name:'测试商品',refs:['a']};s.products=[original];
 const job={id:'kit',name:'测试商品',kind:'kit',status:'success',createdAt:1,results:[{id:'r',assetId:'a',index:1}],settings:defaultSettings()};
 s.jobs=[job,{id:'old',name:'旧编辑任务',kind:'editor',status:'success',results:[]}];
 const kit=appView(s,ui);s.view='history';const history=appView(s,ui);
 const products=modalView(s,{...ui,modal:{type:'products'}});
 s.preview={jobId:'kit',resultId:'r',metadata:{width:2048,height:2048,format:'PNG'}};const result=appView(s,ui);
 for(const markup of [kit,history,products,result])assert.doesNotMatch(markup,/AI 商品图|data-appearance|界面风格|原版|product-editor|edit-result|similar-background/);
 assert.doesNotMatch(history,/旧编辑任务/);
 assert.doesNotMatch(result,/role="dialog"|preview-modal/);assert.match(result,/close-preview/);assert.match(result,/ai-edit/);assert.match(result,/image-editor/);assert.match(result,/download-result/);
 assert.match(kit,/batch/);
});
test('数量受1–20总量约束，减量保留已选版式并显式检查冲突',()=>{const s=defaultSettings();setCount(s,'selling',99);assert.equal(total(s),20);s.layouts=['a','b','c','d'];setCount(s,'selling',1);assert.equal(total(s),5);assert.equal(s.layouts.length,4);assert.match(validateKit({refs:['a']},s,'说明'),/版式/);s.counts={white:0,selling:0,scene:0,other:0};assert.match(validateKit({refs:['a']},s,'说明'),/1–20/);s.layouts=[];s.counts={white:1,selling:1,scene:1,other:1};assert.equal(validateKit({refs:['a']},s,'说明'),'');});
test('平台切换与多商品逐字段覆盖相互独立',()=>{const s=defaultSettings();changePlatform(s,'淘宝天猫1688');assert.equal(s.country,'中国');assert.equal(s.counts.white,0);const local=resolveSettings(s,{language:'英文',ratio:'',resolution:'1K'});assert.equal(local.language,'英文');assert.equal(local.ratio,'1:1');s.country='德国';assert.equal(resolveSettings(s,{language:'英文'}).country,'德国');assert.equal(local.country,'中国');assert.equal(s.language,'中文');});
test('同一商品的6个参考图只对应一套结构，每种版式仅占一张',()=>{const s=defaultSettings();s.layouts=['a','b'];const p={refs:['1','2','3','4','5','6']};assert.equal(validateKit(p,s,'说明'),'');const results=resultSlots(s);assert.equal(results.length,7);assert.equal(new Set(results.map(r=>r.id)).size,7);assert.deepEqual(results.filter(r=>r.type==='selling').map(r=>r.layoutId),['a','b',null]);assert.match(validateKit({refs:[...p.refs,'7']},s,'说明'),/最多/);});
test('刷新不虚报任务完成，既有结果可恢复',()=>{const s={jobs:[{status:'running',results:[{status:'success',assetId:'a'},{status:'running'}]},{status:'queued',results:[]}]};recover(s);assert.equal(s.jobs[0].status,'interrupted');assert.equal(s.jobs[0].results[0].assetId,'a');assert.equal(s.jobs[1].status,'interrupted');});
test('演示适配器完成、失败、取消互斥，并且不会产生假图片',async()=>{const s=new LocalDemoService(),progress=[];const r=await s.run({capability:'product-kit',sourceAssetId:'user-image'},{duration:16,onProgress:p=>progress.push(p)});assert.equal(r.sourceAssetId,'user-image');assert.equal(progress.at(-1),100);await assert.rejects(s.run({},{duration:16,outcome:'failure'}),/未完成/);const c=new AbortController();const pending=s.run({},{signal:c.signal,duration:100});c.abort();await assert.rejects(pending,{name:'AbortError'});});
test('ZIP含UTF-8文件名与有效目录，可保存真实二进制文件',async()=>{const blob=await zip([{name:'商品/01.png',blob:new Blob([new Uint8Array([1,2,3])])}]);const bytes=new Uint8Array(await blob.arrayBuffer()),v=new DataView(bytes.buffer);assert.equal(v.getUint32(0,true),0x04034b50);assert.equal(v.getUint32(bytes.length-22,true),0x06054b50);assert.equal(v.getUint16(bytes.length-14,true),1);});

test('原位预览只浏览已完成图片，刷新保留列表位置与修改草稿',()=>{
 const s=freshState();s.view='history';s.previewDrafts={'j:done':'保留商品颜色'};
 s.jobs=[{id:'j',kind:'kit',status:'partial',results:[{id:'pending',status:'failed'},{id:'done',assetId:'asset',status:'success'}]}];
 s.preview={jobId:'j',resultId:'done',origin:{view:'history',scrollTop:415},metadata:{width:100,height:200}};
 recover(s);const context=previewContext(s);
 assert.equal(context.results.length,1);assert.equal(context.index,0);assert.equal(context.result.id,'done');
 assert.equal(s.preview.origin.scrollTop,415);assert.equal(s.previewDrafts['j:done'],'保留商品颜色');
 assert.equal(s.view,'history');
 s.preview.resultId='pending';recover(s);assert.equal(s.preview,null);
});
