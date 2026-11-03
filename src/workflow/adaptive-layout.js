// Pixel-driven placement. Model masks are fallible; an unavailable/empty mask
// never grants permission to paint over the photograph. Separate-canvas fallback
// preserves the complete original photograph and records the change explicitly.
const intersects=(a,b)=>a[0]<b[0]+b[2]&&a[0]+a[2]>b[0]&&a[1]<b[1]+b[3]&&a[1]+a[3]>b[1];
const inside=b=>b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]>0&&b[3]>0&&b[0]+b[2]<=1.000001&&b[1]+b[3]<=1.000001;
const pad=(b,p=.016)=>[b[0]-p,b[1]-p,b[2]+2*p,b[3]+2*p];
const lum=rgb=>rgb.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
const rgb=s=>[1,3,5].map(i=>parseInt(s.slice(i,i+2),16));
export function protectedRegion(box,analysis,{color='#28272b',card=false,allowSmoothGradient=false}={}){
 const b=pad(box);if(!inside(b)||analysis.maskState!=='foreground-mask'||!analysis.cells.some(c=>c[4]>0))return false;
 if((analysis.protectedBoxes??[]).some(p=>intersects(b,pad(p,.025))))return false;
 const n=analysis.grid,ink=lum(rgb(color));let min=255,max=0;
 for(let y=Math.floor(b[1]*n);y<Math.ceil((b[1]+b[3])*n);y++)for(let x=Math.floor(b[0]*n);x<Math.ceil((b[0]+b[2])*n);x++){
  const c=analysis.cells[y*n+x];if(!c||c[4]>0||c[3]>180)return false;const l=(c[0]+c[1]+c[2])/3;min=Math.min(min,l);max=Math.max(max,l);if(!card&&contrast(ink,lum(c.slice(0,3)))<4.5)return false;
 }return allowSmoothGradient||max-min<45;
}
const iconFor=t=>/头梁|头带/.test(t)?'headband':/耳罩|耳垫/.test(t)?'earpad':/色|黑|白|蓝|灰|黄|红/.test(t)?'color':/细节|孔|口|接口|按|扣|钮/.test(t)?'detail':'bullet';
export function adaptivePlacement(layers,analysis,{width,height,artDirection,cardIndices=[]}){
 if(!layers.length)return {layers:[],cards:[],photoBox:[0,0,1,1],audit:{version:'adaptive-layout.1',method:'no-marketing-copy',commercialAcceptance:false}};
 const metrics=analysis.metrics;if(!Array.isArray(metrics)||metrics.length!==layers.length||metrics.some((m,i)=>m.text!==layers[i].text||m.fontSize!==layers[i].fontSize))throw Error('LAYOUT_METRICS_CHANGED');
 const natural=metrics.map(m=>Math.max(...m.widths)/width+.008),heights=layers.map((l,i)=>Math.max(l.fontSize*1.65,metrics[i].lineHeight*1.4)*metrics[i].widths.length/height);
 const surface=artDirection.textSurfaceColor,ink=artDirection.bodyColor;
 function build(boxes){const cards=[],out=layers.map((l,i)=>{let box=[...boxes[i]];if(cardIndices.includes(i)){cards.push({box:[...box],color:'#FFFFFF',ink,icon:iconFor(l.text),index:i});const left=.12,lineHeight=metrics[i].lineHeight*metrics[i].widths.length/height;box=[box[0]+left,box[1]+(box[3]-lineHeight)/2,box[2]-left-.018,heights[i]];}return {...l,box};});return {layers:out,cards};}
 function fits(result){return result.layers.every((l,i)=>inside(l.box)&&l.box[2]>=natural[i]&&l.box[3]>=heights[i])&&result.cards.every(c=>inside(c.box))&&result.layers.every((l,i)=>result.layers.every((r,j)=>i===j||!intersects(pad(l.box,.006),pad(r.box,.006))));}
 function safe(result){return fits(result)&&result.layers.every(l=>protectedRegion(l.box,analysis,{color:l.color}))&&result.cards.every(c=>protectedRegion(c.box,analysis,{card:true}));}
 const groups=[];
 // Prefer a coherent stack over disconnected model-generated card coordinates.
 for(const right of [false,true]){const x=right?.53:.05,w=.42,boxes=layers.map((l,i)=>[x,i===0?.07:.31+(i-1)*.205,w,i===0?Math.max(.15,heights[i]):Math.max(.15,heights[i]+.05)]);groups.push(build(boxes));}
 if(layers.length===1){const l=layers[0],w=Math.max(natural[0],Math.min(.88,l.box[2])),h=Math.max(heights[0],l.box[3]);groups.unshift(build([l.box]));for(const y of [.05,.82,.7,.18])for(const x of [.05,Math.max(.05,.95-w)])groups.push(build([[x,y,w,h]]));}
 else if(!cardIndices.length)groups.unshift(build(layers.map(l=>l.box)));
 for(const r of groups)if(safe(r))return {...r,photoBox:[0,0,1,1],surface,audit:{version:'adaptive-layout.1',method:'pixel-checked-placement',maskState:analysis.maskState,protectedBoxes:analysis.protectedBoxes,positionsChanged:r.layers.some((l,i)=>JSON.stringify(l.box)!==JSON.stringify(layers[i].box)),commercialAcceptance:false}};
 // No safe area: fit the complete photo into a separate editorial region.
 // Its bounds are protected regardless of model mask quality.
 const side=layers.length>3&&groups.find(r=>fits(r)&&r.layers.every(l=>l.box[0]<.5));let result,area;
 if(side){result=side;area=[.51,.05,.45,.9];}
 else{const titleH=heights[0]+.025,bodyCount=layers.length-1,bodyH=bodyCount?Math.max(...heights.slice(1))+.065:0;
  const boxes=[[.05,.035,.9,titleH]];for(let i=1;i<layers.length;i++)boxes.push([.05+(i-1)*(.9/bodyCount),.96-bodyH,.9/bodyCount-.016,bodyH]);
  result=build(boxes);area=[.05,.065+titleH,.9,.96-bodyH-(.065+titleH)-.025];
 }
 if(!fits(result)||area[2]<=0||area[3]<=.2)throw Error('LAYOUT_CAPACITY');
 const scale=Math.min(area[2]*width/width,area[3]*height/height),photoBox=[area[0]+(area[2]-scale)/2,area[1]+(area[3]-scale)/2,scale,scale];
 if(result.layers.some(l=>intersects(pad(l.box,.012),photoBox))||result.cards.some(c=>intersects(pad(c.box,.012),photoBox)))throw Error('LAYOUT_COLLISION');
 return {...result,photoBox,surface,audit:{version:'adaptive-layout.1',method:'separate-photo-region',reason:analysis.maskState!=='foreground-mask'?'segmentation-unavailable':'no-safe-natural-space',maskState:analysis.maskState,photoBox,originalPhotoPreserved:true,positionsChanged:true,commercialAcceptance:false}};
}
export function validAdaptiveLayers(original,actual){return Array.isArray(actual)&&actual.length===original.length&&actual.every((l,i)=>inside(l.box)&&JSON.stringify({...l,box:original[i].box})===JSON.stringify(original[i]));}
