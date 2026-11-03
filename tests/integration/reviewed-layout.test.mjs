import test from 'node:test';import assert from 'node:assert/strict';import {reviewedLayers} from '../../src/workflow/reviewed-design.js';
function fixture(text='办公桌旁的随行杯',box=[.06,.08,.44,.16]){return {minimumMvp:{plan:{artDirection:{titleColor:'#2F4A63',bodyColor:'#3D4A55',textSurfaceColor:'#EEF2F5',paletteReason:'蓝杯配深蓝字',typography:{titlePx:72,bodyPx:34,rationale:'统一字号'}},images:[{id:'scene',copy:[{text,sourceIds:['o1']}],design:{elements:[{kind:'标题',copyIndex:0,box}]}}]}},input:{requirements:{language:'中文'}}};}
const image={id:'scene',size:{width:2048,height:2048}};
test('v12 layout rejection distinguishes horizontal overflow; height-only repair still fails',()=>{
 const p=fixture();let issue;assert.throws(()=>reviewedLayers(p,image),e=>{issue=e.layoutIssue;return e.message==='TEXT_REGION_TOO_SMALL';});
 assert.equal(issue.reason,'TITLE_LINE_TOO_WIDE');assert.equal(issue.copyIndex,0);assert.equal(issue.text,'办公桌旁的随行杯');assert.ok(issue.estimatedWidestLinePx>issue.currentWidthPx);assert.ok(issue.minimumSingleLineWidth>.44);
 p.minimumMvp.plan.images[0].design.elements[0].box[3]=.35;assert.throws(()=>reviewedLayers(p,image),e=>e.layoutIssue.reason==='TITLE_LINE_TOO_WIDE');
 p.minimumMvp.plan.images[0].design.elements[0].box[2]=.65;assert.equal(reviewedLayers(p,image)[0].fontSize,137);
});
test('v12 explicit phrase wrap requires sufficient height without shrinking font',()=>{
 const p=fixture('办公桌旁\n随行相伴');assert.throws(()=>reviewedLayers(p,image),e=>e.layoutIssue.reason==='TEXT_BOX_TOO_SHORT');p.minimumMvp.plan.images[0].design.elements[0].box[3]=.24;
 const layer=reviewedLayers(p,image)[0];assert.equal(layer.text,'办公桌旁\n随行相伴');assert.equal(layer.fontSize,137);
});
