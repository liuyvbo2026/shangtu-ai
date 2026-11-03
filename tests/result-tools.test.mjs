import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenedPSD,listingContent} from '../src/result-tools.js';
import {modalView} from '../src/views.js';
import {freshState} from '../src/model.js';

test('PSD uses Adobe RGB planar bytes, correct dimensions and white alpha composite',async()=>{
 const bytes=new Uint8Array(await flattenedPSD({width:2,height:1,data:new Uint8Array([255,0,0,255,0,0,255,128])}).arrayBuffer()),v=new DataView(bytes.buffer);
 assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'8BPS');assert.equal(v.getUint16(4),1);assert.equal(v.getUint16(12),3);assert.equal(v.getUint32(14),1);assert.equal(v.getUint32(18),2);assert.equal(v.getUint16(22),8);assert.equal(v.getUint16(24),3);assert.deepEqual([...bytes.slice(26,40)],Array(14).fill(0));assert.deepEqual([...bytes.slice(40)],[255,127,0,127,0,255]);
 assert.throws(()=>flattenedPSD({width:2,height:2,data:[]}));
});
test('listing preserves whole original copy, recognizes evidenced section titles and keeps unknown legacy text',()=>{
 const raw='宝贝标题\n测试杯\n\n核心卖点/促销利益点\n测试卖点\n\n详情页文案\n测试详情\n\n搜索关键词/属性词\n测试关键词';
 const result=listingContent(raw);assert.equal(result.text,raw);assert.equal(result.sections.length,4);assert.equal(result.sections[1].text,'测试卖点\n');
 assert.deepEqual(listingContent('旧版无标题文案\n第二行').sections,[{title:'商品上架文案',text:'旧版无标题文案\n第二行'}]);
 assert.equal(listingContent({sections:[{title:'标题',text:'原文'}]}).text,'标题\n原文');
});
test('evidenced tool gates: blank redraw allowed; no original restore and unchanged OCR remain disabled',()=>{
 const state=freshState(),modal=m=>modalView(state,{modal:m,resultInstruction:'',downloadFormat:'jpg'});
 assert.match(modal({type:'ai-edit',id:'j:r'}),/选填/);assert.doesNotMatch(modal({type:'ai-edit',id:'j:r'}),/data-a="modify-result"[^>]*disabled/);
 assert.match(modal({type:'restore-product'}),/data-a="confirm-restore"[^>]*disabled/);
 const recognition={regions:[{id:'text-1',text:'原文字'}]},base={type:'edit-text',recognition,edits:{'text-1':'原文字'}};
 assert.match(modal(base),/data-a="confirm-text"[^>]*disabled/);assert.doesNotMatch(modal({...base,edits:{'text-1':'改后'}}),/data-a="confirm-text"[^>]*disabled/);
});
