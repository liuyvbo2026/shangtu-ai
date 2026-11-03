// The approved low-chroma glass is decoration only; user assets are never filtered.
// Refraction is already in the artwork, so do not add a second bright ridge pass.
export function initGlass(canvas) {
 const surface=canvas.parentElement,artwork=surface.querySelector('.glass-art');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const finePointer=matchMedia('(hover: hover) and (pointer: fine)');
 let scene='empty',frame=0,last=0,mouse=[0,0],target=[0,0];
 canvas.hidden=true;
 surface.dataset.renderer='artwork';
 function draw(now){
  frame=0;
  const dt=Math.min(40,now-last||16);last=now;
  const blend=reduced.matches?1:1-Math.exp(-dt/180);
  mouse=mouse.map((v,i)=>v+(target[i]-v)*blend);
  artwork.style.setProperty('--glass-x',`${mouse[0].toFixed(3)}px`);
  artwork.style.setProperty('--glass-y',`${mouse[1].toFixed(3)}px`);
  if(mouse.some((v,i)=>Math.abs(v-target[i])>.01))schedule();
 }
 function schedule(){if(!frame&&!document.hidden)frame=requestAnimationFrame(draw);}
 function reset(){target=[0,0];schedule();}
 window.addEventListener('pointermove',event=>{
  if(reduced.matches||!finePointer.matches||event.pointerType==='touch'||scene!=='empty')return;
  const box=surface.getBoundingClientRect();
  if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom){reset();return;}
  target=[((event.clientX-box.left)/Math.max(1,box.width)*2-1)*1.5,((event.clientY-box.top)/Math.max(1,box.height)*2-1)];
  schedule();
 },{passive:true});
 document.documentElement.addEventListener('pointerleave',reset);
 document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&frame){cancelAnimationFrame(frame);frame=0;}else if(!document.hidden){last=0;reset();}
 });
 reduced.addEventListener('change',reset);
 finePointer.addEventListener('change',reset);
 artwork.decode().then(()=>{surface.dataset.artwork='ready';}).catch(()=>{surface.dataset.artwork='unavailable';});
 return {setScene(name){
  if(scene===name)return;
  scene=name;surface.dataset.scene=name;
  if(name!=='empty')reset();
 }};
}
