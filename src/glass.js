// A pre-rendered optical animation. Runtime only manages playback;
// the light/refraction animation is contained in the video itself.
export function initGlass(video) {
 const surface=video.parentElement;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let scene=surface.dataset.scene||'empty',request=0;
 video.muted=true;video.defaultMuted=true;video.loop=true;video.playsInline=true;
 const active=()=>scene==='empty'&&!document.hidden&&!reduced.matches;
 function poster(reason){surface.dataset.renderer='artwork';surface.dataset.motion=reason;}
 async function refresh(){
  const attempt=++request;
  if(!active()){
   video.pause();
   poster(reduced.matches?'reduced-motion':'paused');
   return;
  }
  try{
   await video.play();
   if(attempt!==request)return;
   if(active()){surface.dataset.renderer='video';surface.dataset.motion='playing';}
  }catch{
   if(attempt===request)poster(video.error?'error':'autoplay-blocked');
  }
 }
 video.addEventListener('playing',()=>{
  if(active()){surface.dataset.renderer='video';surface.dataset.motion='playing';}
  else video.pause();
 });
 video.addEventListener('error',()=>poster('error'));
 document.addEventListener('visibilitychange',refresh);
 reduced.addEventListener('change',refresh);
 document.addEventListener('pointerdown',()=>{if(active()&&video.paused)refresh();},{passive:true});
 poster('loading');refresh();
 return {setScene(name){if(scene===name)return;scene=name;surface.dataset.scene=name;refresh();}};
}
