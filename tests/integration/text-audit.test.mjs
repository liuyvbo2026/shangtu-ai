import test from 'node:test';
import assert from 'node:assert/strict';
import {auditCopy} from '../../backend/integration/text-audit.mjs';
import {correctionFromReview} from '../../src/quality-tools.js';
import {modalView} from '../../src/views.js';
import {freshState} from '../../src/model.js';
test('local OCR distinguishes exact and two-line text from missing, low-confidence and unrelated regions',()=>{
 const regions=[{text:'暖黄',confidence:1,box:[.1,.1,.1,.03]},{text:'瓶身',confidence:1,box:[.1,.14,.1,.03]},{text:'品牌',confidence:.3,box:[.1,.3,.1,.03]},{text:'风格',confidence:1,box:[.8,.8,.1,.03]}];
 const a=auditCopy(['暖黄瓶身','包装文字清晰','品牌','瓶身风格'].map(text=>({text})),regions);
 assert.deepEqual(a.checks.map(c=>c.status),['matched','unconfirmed','unconfirmed','unconfirmed']);
 assert.deepEqual(auditCopy([{text:'无文字'}],[]).checks[0].observed,[]);
});
test('review UI escapes model data, preserves old reports and excludes uncertain or stale repair instructions',()=>{
 const issue={location:'<script>',evidence:'<img onerror="bad">',correction:'<b>改字</b>',severity:'blocking'};
 const current={resultId:'r',position:0,version:2,totalReferenceGroups:1,state:'succeeded',stale:false,output:{summary:'待核对',issues:[issue,{...issue,severity:'uncertain',correction:'不要自动应用'}]}};
 assert.equal(correctionFromReview([current,{...current,stale:true}]),'<script>：<b>改字</b>');
 const html=modalView(freshState(),{modal:{type:'quality',taskId:'t',report:{state:'needs-correction',items:[current,{...current,stale:true,version:1}]}}});
 assert.doesNotMatch(html,/<script>|<img onerror/);assert.match(html,/历史检查/);assert.equal((html.match(/data-a="quality-correct"/g)||[]).length,1);
});


test('planning copy checks catch internal notes missed by the model without judging superseded edited copy',async()=>{
 const {planningCopyAudit}=await import('../../backend/integration/quality-review.mjs');
 const q={shot:{copy:[{text:'柔白织物衬托'},{text:'半透明质感'}]},edits:[]};
 const issues=planningCopyAudit(q);assert.equal(issues.length,1);assert.equal(issues[0].text,'柔白织物衬托');assert.deepEqual(planningCopyAudit({...q,edits:[{version:2,instruction:'替换原标题'}]}),[]);
 const html=modalView(freshState(),{modal:{type:'quality',taskId:'t',report:{state:'needs-correction',items:[{position:0,version:1,state:'succeeded',planningIssues:issues,output:{verdict:'no-obvious-issue',summary:'未见明显问题',issues:[]}}]}}});assert.match(html,/规划文案问题/);
});

test('contradictory model verdicts are only made more conservative; no issue or raw value is discarded',async()=>{
 const {reconcileQuality,validateQuality}=await import('../../backend/integration/quality-review.mjs');
 const issue={category:'identity',severity:'uncertain',location:'鞋舌',evidence:'无法辨认小字',correction:'人工核对原图'};
 const raw={verdict:'no-obvious-issue',summary:'未见问题',issues:[issue]};
 assert.equal(reconcileQuality(raw).verdict,'uncertain');assert.equal(raw.verdict,'no-obvious-issue');assert.deepEqual(reconcileQuality(raw).issues,raw.issues);
 assert.equal(reconcileQuality({...raw,verdict:'uncertain',issues:[{...issue,severity:'blocking'}]}).verdict,'needs-correction');
 assert.equal(reconcileQuality({...raw,issues:[{...issue,severity:'minor'}]}).verdict,'needs-correction');
 assert.throws(()=>validateQuality(raw));assert.throws(()=>reconcileQuality({...raw,issues:[],verdict:'needs-correction'}));
 assert.equal(reconcileQuality({...raw,issues:[],verdict:'uncertain'}).verdict,'uncertain');
});
