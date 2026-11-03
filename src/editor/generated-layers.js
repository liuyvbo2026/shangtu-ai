import {commit,currentScene,imageLayer,textLayer} from './core.js';

export function importGeneratedLayers(session,base,info){
 if(!info.available||base.width!==info.width||base.height!==info.height)throw Error('可编辑图层与原图尺寸不一致');
 const scene=structuredClone(currentScene(session));
 scene.layers=[imageLayer(base,{name:'商品底图',locked:true}),...info.layers.map((l,i)=>textLayer({name:i?'标签 '+i:'标题',text:l.text,
  x:l.box[0]*info.width,y:l.box[1]*info.height,width:l.box[2]*info.width,height:l.box[3]*info.height,
  style:{fontFamily:'system',fontSize:l.fontSize,fontWeight:l.fontWeight,align:l.align,color:l.color??'#28272b',lineHeight:1.2}}))];
 return commit(session,scene,'载入原始底图与文字层');
}
