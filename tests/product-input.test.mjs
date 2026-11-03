import test from 'node:test';
import assert from 'node:assert/strict';
import {freshState,recover,defaultSettings,validateKit} from '../src/model.js';
import {INPUT_HINT,INPUT_LABEL,migrateProductInput,productFromRemote,savedInputFacts,reuseTaskInput} from '../src/product-input.js';
import {appView,modalView} from '../src/views.js';

test('legacy input migration is lossless, backed up and idempotent across kit, batch and history',()=>{
 const s=freshState();delete s.kit.inputVersion;
 const p={id:'p',name:'旧名称',refs:['a'],factsText:'蓝色\n500ml',description:'资料原文'};s.products=[p];
 Object.assign(s.kit,{productId:'p',description:'窗边场景'});
 s.batch.items=[{id:'b',productId:'p',description:'户外画面',override:{}}];
 s.jobs=[{id:'old',kind:'kit',status:'success',description:'历史原文',results:[]}];
 s.kit.pendingSubmission={key:'old-key',body:{description:'原提交'}};
 const before=structuredClone(s);recover(s);
 assert.deepEqual(s.inputMigrationBackup.products,before.products);
 assert.deepEqual(s.inputMigrationBackup.kit,before.kit);
 assert.equal(s.kit.description,'产品名称：旧名称\n\n蓝色\n500ml\n\n窗边场景');
 assert.equal(s.batch.items[0].description,'产品名称：旧名称\n\n蓝色\n500ml\n\n户外画面');
 assert.equal(p.inputText,'产品名称：旧名称\n\n蓝色\n500ml\n\n资料原文');
 assert.deepEqual(s.jobs,before.jobs);assert.deepEqual(s.kit.pendingSubmission,before.kit.pendingSubmission);
 s.kit.description='改成300ml';const migrated=structuredClone(s);assert.deepEqual(recover(s),migrated);
});

test('long historical text remains editable/savable without silent truncation; no five-field validation',()=>{
 const p=migrateProductInput({id:'p',name:'旧商品',refs:['a'],factsText:'旧参数',description:'长'.repeat(3500)});
 assert.ok(p.inputText.length>3500);assert.ok(savedInputFacts(p).userInput.text.endsWith('长'.repeat(3500)));
 assert.match(validateKit(p,defaultSettings(),p.inputText),/完整保留/);
 assert.equal(validateKit(p,defaultSettings(),'简洁明亮。'),'');
 assert.equal(validateKit(p,defaultSettings(),'字'.repeat(1000)),'');
 assert.match(validateKit(p,defaultSettings(),'字'.repeat(1001)),/1000/);
 assert.match(validateKit(p,defaultSettings(),'  '),/请填写/);
});

test('server-only legacy records retain full facts; unified input edits do not promote wishes or resurrect deleted facts',()=>{
 const facts={confirmed:[{id:'f',key:'容量',value:'500ml',source:{kind:'user-confirmed',locator:'original'}}],unknowns:[{key:'material',reason:'unknown'}],extra:{source:'retained'}};
 const p=productFromRemote({id:'server',clientId:'local',name:'旧杯',facts,references:[{assetId:'a'}]});
 assert.match(p.inputText,/500ml/);assert.deepEqual(p.facts,facts);
 p.inputText='期望户外场景，适合通勤';const next=savedInputFacts(p,facts);
 assert.deepEqual(next.confirmed,[]);assert.deepEqual(next.unknowns,[]);assert.deepEqual(next.legacy.confirmed,facts.confirmed);
 assert.deepEqual(next.legacy.extra,facts.extra);assert.equal(next.userInput.source.kind,'user-provided');
 const restored=productFromRemote({id:'server',name:'旧杯',facts:next,references:[]});
 assert.equal(restored.inputText,p.inputText);assert.doesNotMatch(restored.inputText,/500ml/);
 assert.deepEqual(savedInputFacts(restored,next).legacy,next.legacy);
});

test('history reuse reads its own input snapshot, leaving stored history unchanged',()=>{
 const j={description:'原场景',parameters:{inputSnapshot:{product:{name:'原名称',facts:{confirmed:[{value:'500ml'}]}}}}};
 const before=structuredClone(j);assert.equal(reuseTaskInput(j),'产品名称：原名称\n\n500ml\n\n原场景');assert.deepEqual(j,before);
 j.parameters.inputSnapshot.product.facts.userInput={version:1,text:'保存资料'};assert.equal(reuseTaskInput(j),'原场景');
});

test('single and batch inputs share exact reference hint, label and length; no repeated name/facts fields',()=>{
 const s=freshState();s.products=[{id:'p',name:'P',refs:['a'],inputVersion:1,inputText:''}];s.kit.productId='p';
 const html=appView(s,{});assert.equal((html.match(/<textarea/g)||[]).length,1);assert.ok(html.includes(INPUT_HINT));
 assert.ok(html.includes('maxlength="1000"'));assert.ok(html.includes('商品卖点&amp;生成要求'));
 assert.doesNotMatch(html,/data-field="(?:factsText|name)"/);
 s.batch.items=[{id:'b',productId:'p',description:'',override:{}}];const batch=modalView(s,{modal:{type:'batch'}});
 assert.ok(batch.includes(INPUT_HINT));assert.ok(batch.includes('maxlength="1000"'));assert.doesNotMatch(batch,/data-field="(?:factsText|name)"/);
 s.kit.description='旧'.repeat(1200);assert.ok(appView(s,{}).includes('maxlength="1200"'));assert.ok(appView(s,{}).includes(s.kit.description));
});
