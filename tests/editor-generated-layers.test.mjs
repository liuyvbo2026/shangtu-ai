import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,currentScene,restoreVersion,referencedAssets,updateLayer} from '../src/editor/core.js';
import {importGeneratedLayers} from '../src/editor/generated-layers.js';

test('generated layers retain untouched composite, exact editable copy and separate base across edits and restore',()=>{
 const composite={id:'composite',width:1728,height:2304},base={id:'base',width:1728,height:2304};
 const original=createSession(composite),info={available:true,width:1728,height:2304,layers:[{text:'鞋舌处缝制标签',box:[.08,.05,.84,.12],fontSize:89,fontWeight:600,align:'left'}]};
 const s=importGeneratedLayers(original,base,info),scene=currentScene(s);
 assert.equal(s.versions.length,2);assert.equal(s.versions[0].scene.layers[0].assetId,'composite');assert.equal(scene.layers[0].assetId,'base');assert.equal(scene.layers[1].text,info.layers[0].text);
 const edited=updateLayer(s,scene.layers[1].id,{text:'白色鞋面'});assert.equal(currentScene(edited).layers[1].text,'白色鞋面');assert.equal(s.versions[1].scene.layers[1].text,info.layers[0].text);
 assert.deepEqual(referencedAssets(edited).sort(),['base','composite']);assert.equal(currentScene(restoreVersion(edited,original.originalVersionId)).layers[0].assetId,'composite');
 const colored=importGeneratedLayers(original,base,{...info,layers:[{...info.layers[0],color:'#29465B'}]});assert.equal(currentScene(colored).layers[1].style.color,'#29465B');assert.equal(currentScene(s).layers[1].style.color,'#28272b');
 assert.throws(()=>importGeneratedLayers(original,{...base,width:864},info));
});
