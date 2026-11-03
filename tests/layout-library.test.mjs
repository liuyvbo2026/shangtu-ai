import test from 'node:test';
import assert from 'node:assert/strict';
import {freshState,defaultSettings} from '../src/model.js';
import {layoutCatalog} from '../src/layout-catalog.js';
import {layoutItems,applyLayoutSelection} from '../src/layout-library.js';
import {modalView,appView} from '../src/views.js';

test('正式原创版式与旧工作区素材并存，不清除历史引用',()=>{
 assert.equal(layoutCatalog.length,4);assert.ok(layoutCatalog.every(l=>l.rights.kind==='original-vector-art'&&l.reference.sha256.length===64));
 const state=freshState(),old={id:'old',type:'layout',assetId:'asset',name:'旧参考'};
 state.library=[old,{id:'scene',type:'scene'}];state.kit.settings.layouts=['old'];
 assert.equal(layoutItems(state).at(-1),old);assert.equal(layoutItems(state).length,5);
 assert.deepEqual(state.kit.settings.layouts,['old']);
 const markup=modalView(freshState(),{modal:{type:'library',selected:[],limit:3}});
 assert.match(markup,/侧栏叙事/);assert.match(markup,/应用 0 个版式/);
 assert.doesNotMatch(markup,/upload-library|librarySearch|libraryGroup|delete-asset|asset-info/);
});
test('应用按选择顺序保存，每项占一张，余量保留，原草稿不被提前改变',()=>{
 const original=defaultSettings(),items=['a','b','c','d'].map(id=>({id}));
 const two=applyLayoutSelection(original,['b','a'],items);
 assert.deepEqual(two.layouts,['b','a']);assert.equal(two.counts.selling,3);
 assert.deepEqual(original.layouts,[]);assert.equal(original.counts.selling,3);
 const four=applyLayoutSelection(original,['d','b','a','c'],items);
 assert.equal(four.counts.selling,4);assert.deepEqual(four.layouts,['d','b','a','c']);
 const clear=applyLayoutSelection(four,[],items);assert.deepEqual(clear.layouts,[]);assert.equal(clear.counts.selling,4);
});
test('总量超出时拒绝应用且保留原设置，失效引用可移除',()=>{
 const settings=defaultSettings();settings.counts={white:3,selling:13,scene:2,other:2};
 const items=Array.from({length:17},(_,i)=>({id:`a${i}`})),before=structuredClone(settings);
 assert.throws(()=>applyLayoutSelection(settings,items.map(x=>x.id),items),/最多可应用 13/);
 assert.deepEqual(settings,before);
 assert.throws(()=>applyLayoutSelection(settings,['missing'],items),/暂不可用/);
 assert.deepEqual(applyLayoutSelection(settings,[],items).layouts,[]);
});
test('缩略图有可访问选中状态，主页面与选中预览引用同一素材',()=>{
 const state=freshState();state.library=[{id:'a',type:'layout',assetId:'asset-a',name:'测试<版式>'}];
 state.kit.settings.layouts=['a'];
 const html=modalView(state,{modal:{type:'library',selected:['a'],limit:3}});
 assert.match(html,/aria-pressed="true"/);assert.match(html,/移除测试&lt;版式&gt;/);
 assert.equal((html.match(/data-asset="asset-a"/g)||[]).length,2);
 assert.match(appView(state,{}),/data-asset="asset-a"/);
 assert.match(html,/应用 1 个版式/);
 assert.match(modalView(state,{modal:{type:'library',selected:['missing'],limit:3}}),/版式暂不可用/);
});
