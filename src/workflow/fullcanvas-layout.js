import {adaptivePlacement,protectedRegion} from './adaptive-layout.js';
const intersects=(a,b)=>a[0]<b[0]+b[2]&&a[0]+a[2]>b[0]&&a[1]<b[1]+b[3]&&a[1]+a[3]>b[1];
const inside=b=>b[0]>=.025&&b[1]>=.025&&b[2]>0&&b[3]>0&&b[0]+b[2]<=.975&&b[1]+b[3]<=.975;
const pad=b=>[b[0]-.008,b[1]-.008,b[2]+.016,b[3]+.016];
// Never silently replace the requested continuous photograph by an inset.
// Pixel checks stay conservative; failure preserves the original base for repair.
export function fullcanvasPlacement(layers,analysis,options){
 let prior;
 try{prior=adaptivePlacement(layers,analysis,options);}catch(error){if(!['LAYOUT_CAPACITY','LAYOUT_COLLISION'].includes(error.message))throw error;}
 if(prior?.photoBox.every((v,i)=>v===[0,0,1,1][i]))return {...prior,audit:{...prior.audit,version:'fullcanvas-layout.1',automaticPhotoShrink:false}};
 const {width,height,artDirection,cardIndices=[]}=options,metrics=analysis.metrics;
 if(!metrics||metrics.length!==layers.length||metrics.some((m,i)=>m.text!==layers[i].text||m.fontSize!==layers[i].fontSize))throw Error('LAYOUT_METRICS_CHANGED');
 // Native lineHeight already includes ascent, descent and leading. Applying
 // the old 1.4 multiplier again reserved almost two glyph heights per line.
 const natural=metrics.map(m=>Math.max(...m.widths)/width+.008),heights=layers.map((l,i)=>Math.max(l.fontSize*1.1,metrics[i].lineHeight*1.05)*metrics[i].widths.length/height);
 function build(boxes){return layers.map((l,i)=>({...l,box:[...boxes[i]]}));}
 function inkBox(l,i){const m=metrics[i],b=m.inkBounds?.[0];if(m.widths.length!==1||!Number.isFinite(m.ascent)||!b?.every(Number.isFinite)||b[2]<=0||b[3]<=0)return l.box;const offset=l.align==='center'?(l.box[2]*width-m.widths[0])/2:l.align==='right'?l.box[2]*width-m.widths[0]:0;return [l.box[0]+(b[0]+offset)/width,l.box[1]+(m.ascent-b[1]-b[3])/height,b[2]/width,b[3]/height];}
 function safe(candidate,wraps=[]){return candidate.every((l,i)=>{
  const w=wraps[i],boxes=w?w.inkBoxes.map(b=>[l.box[0]+b[0],l.box[1]+b[1],b[2],b[3]]):[inkBox(l,i)];
  return inside(l.box)&&l.box[2]>=(w?.width??natural[i])&&l.box[3]>=(w?.height??heights[i])&&boxes.every(b=>protectedRegion(b,analysis,{color:l.color,allowSmoothGradient:true}))&&candidate.every((other,j)=>i===j||!intersects(pad(l.box),pad(other.box)));
 });}
 function validWrap(w,i){return w.complete&&w.lineCount===2&&w.inkBoxes?.length===2&&w.lineTexts?.join('')===layers[i].text&&(!/[，,；;：:]/.test(layers[i].text)||/[，,；;：:]$/.test(w.lineTexts[0]));}
 // Try compact labels without decorative cards before declaring the base
 // unusable. Wording, size, colour and photo scale remain unchanged.
 const candidates=[];
 for(const y of [.05,.08,.14,.78,.82])for(const right of [false,true]){
  const boxes=layers.map((l,i)=>{const w=Math.max(natural[i],i===0?.38:.25),x=right?.95-w:.05;return [x,y+i*(Math.max(...heights)+.025),w,heights[i]];});candidates.push(build(boxes));
 }
 if(layers.length<=3)for(const top of [true,false]){
  const ty=top?.05:.80,by=top?.84:.05;
  for(const right of [false,true]){const tw=Math.max(natural[0],.4),boxes=[[right?.95-tw:.05,ty,tw,heights[0]]];for(let i=1;i<layers.length;i++)boxes.push([.05+(i-1)*.47,by,Math.max(natural[i],.4),heights[i]]);candidates.push(build(boxes));}
 }
 // Search actual safe top/bottom bands rather than assuming every photo has
 // exactly the same margin. Contrast, texture, masks and font sizes stay fixed.
 if(layers.length<=3)for(const ty of [.026,.04,.06,.08,.10,.13,.17,.22,.70,.76,.80,.83])for(const by of [.84,.87,.90,.05,.08])for(const right of [false,true]){
  const tw=Math.max(natural[0],.4),boxes=[[right?.95-tw:.05,ty,tw,heights[0]]];for(let i=1;i<layers.length;i++)boxes.push([.05+(i-1)*.47,by,Math.max(natural[i],.4),heights[i]]);candidates.push(build(boxes));
 }
 // A title across the top and short labels down either side can use natural
 // margins without forcing every label into a bottom band or an opaque card.
 if(layers.length>1&&layers.length<=3)for(const ty of [.026,.04,.06])for(const by of [.28,.36,.44,.52,.60])for(const right of [false,true]){
  const tw=natural[0],boxes=[[.05,ty,tw,heights[0]]];
  for(let i=1;i<layers.length;i++){const w=natural[i];boxes.push([right?.95-w:.05,by+(i-1)*(heights[i]+.04),w,heights[i]]);}
  candidates.push(build(boxes));
 }
 for(const candidate of candidates)if(safe(candidate))return {layers:candidate,cards:[],photoBox:[0,0,1,1],surface:artDirection.textSurfaceColor,audit:{version:'fullcanvas-layout.1',method:'full-photo-natural-space',automaticPhotoShrink:false,cardDecorationRemoved:cardIndices.length>0,positionsChanged:true,commercialAcceptance:false}};
 // Wrapped side labels retain exact copy and size. Use native line breaks and
 // glyph bounds, including punctuation, rather than guessing by character count.
 if(layers.length>1&&layers.length<=3){
  const wraps=layers.map((l,i)=>i?(metrics[i].wraps??[]).find(w=>validWrap(w,i)):null);
  if(wraps.slice(1).every(Boolean))for(const ty of [.026,.04])for(const by of [.20,.24,.28,.34,.40])for(const right of [false,true]){
   let y=by;const boxes=[[.05,ty,natural[0],heights[0]]];
   for(let i=1;i<layers.length;i++){const w=wraps[i];boxes.push([right?.974-w.width:.026,y,w.width,w.height]);y+=w.height+.035;}
   const candidate=build(boxes);if(safe(candidate,wraps))return {layers:candidate,cards:[],photoBox:[0,0,1,1],surface:artDirection.textSurfaceColor,audit:{version:'fullcanvas-layout.1',method:'full-photo-wrapped-side-labels',automaticPhotoShrink:false,positionsChanged:true,commercialAcceptance:false}};
  }
 }
 // A one-line CJK heading can wrap to two lines without rewriting its text or
 // changing its font. CoreText still rejects overflow and more than two lines.
 if(layers.length===1&&metrics[0].widths.length===1&&(/^[\p{Script=Han}\p{P}\s]+$/u.test(layers[0].text)||options.marketPolicy&&/[\p{Script=Latin}]/u.test(layers[0].text))){
  for(const wrap of metrics[0].wraps??[]){
   if(!wrap.complete||wrap.lineCount!==2||wrap.inkBoxes?.length!==2)continue;
   const lines=wrap.lineTexts;if(!lines||lines.join('')!==layers[0].text)continue;
   if(/[\p{Script=Latin}]/u.test(layers[0].text)&&!/[\s\-–—]$/.test(lines[0])&&!/^[\s\-–—]/.test(lines[1]))continue;
   if(/[，,；;：:]/.test(layers[0].text)&&!/[，,；;：:]$/.test(lines[0]))continue;
   const w=wrap.width,h=wrap.height;
   for(let y=.026;y+h<.97;y+=.025)for(const x of [.026,.95-w]){
    const box=[x,y,w,h],ink=wrap.inkBoxes.map(b=>[x+b[0],y+b[1],b[2],b[3]]);
    if(inside(box)&&ink.every(b=>protectedRegion(b,analysis,{color:layers[0].color,allowSmoothGradient:true})))return {layers:build([box]),cards:[],photoBox:[0,0,1,1],surface:artDirection.textSurfaceColor,audit:{version:'fullcanvas-layout.1',method:'full-photo-two-line-heading',automaticPhotoShrink:false,positionsChanged:true,commercialAcceptance:false}};
   }
  }
 }
 throw Error('LAYOUT_REPLAN_REQUIRED');
}
