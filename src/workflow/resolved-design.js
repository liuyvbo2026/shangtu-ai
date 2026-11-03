// v7 resolves mechanical geometry in code. The model still decides the distinct
// information task, content, scene, copy, presentation and evidence. No factual
// text is replaced, and invalid/unknown evidence is still rejected by validation.
export const RESOLVED_TEMPLATE='ecommerce-kit.7';
export function resolveDesignGeometry(plan,layouts=[]){
 const output=structuredClone(plan);let selected=0;
 for(const image of output.images){
  const d=image.design,layout=image.type==='selling'?layouts[selected++]:null;
  if(!d)continue;
  const n=Math.max(1,image.copy.length-1),width=.88/n;
  let subject=[.08,.24,.84,.5],title=[.06,.05,.88,.12];
  let labels=Array.from({length:3},(_,i)=>[.06+i*width,.80,width-.02,.14]);
  const side=['主体展示','人物场景'].includes(image.composition.layout);
  if(side){subject=[.36,.23,.58,.69];labels=[[.05,.30,.26,.15],[.05,.52,.26,.15],[.05,.74,.26,.15]];}
  if(image.composition.layout==='局部放大'){subject=[.06,.23,.49,.69];labels=[[.64,.24,.30,.20],[.64,.48,.30,.20],[.64,.72,.30,.20]];}
  if(image.composition.layout==='图标卡片')subject=[.25,.22,.5,.5];
  if(image.type==='white')subject=[.14,.14,.72,.72];
  d.subjectBox=layout?.definition.subjectBox??subject;
  for(const e of d.elements){
   const i=e.copyIndex;
   if(i>=0)e.box=layout?.definition.textSlots[i]?.box??(i===0?title:labels[i-1]);
   // Free decorative magnifiers have no text. Keep them in a dedicated side
   // region rather than allowing random boxes over the main product.
   else if(e.kind==='局部放大')e.box=[.64,.24,.30,.20];
  }
  // Evidence already named by the model's copy/design belongs in the image's
  // declared closure. This does not manufacture or relabel any source.
  image.sourceIds=[...new Set([...image.sourceIds,...image.copy.flatMap(c=>c.sourceIds),...d.focusSourceIds,...d.elements.flatMap(e=>e.sourceIds)])];
 }
 return output;
}
