// OCR is evidence, not ground truth. Absence must never be called proof of
// missing pixels; it does prevent an unchecked automatic all-clear.
const normalized=s=>String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
function adjacent(a,b){
 const [x,y,w,h]=a.box,[bx,by,bw,bh]=b.box;
 const horizontal=Math.min(x+w,bx+bw)-Math.max(x,bx);
 return horizontal>Math.min(w,bw)*.3&&Math.min(Math.abs(by-y-h),Math.abs(y-by-bh))<.045;
}
export function auditCopy(copy,regions){
 return {kind:'local-ocr-not-visual-proof',regions,checks:copy.map(c=>{
  const expected=normalized(c.text),matches=[];
  for(const r of regions){if(normalized(r.text)===expected)matches.push(r);
   for(const b of regions)if(r!==b&&adjacent(r,b)&&normalized(r.text+b.text)===expected)matches.push(r,b);
  }
  const unique=[...new Set(matches)];return {planned:c.text,status:unique.length&&unique.every(r=>r.confidence==null||r.confidence>=.5)?'matched':'unconfirmed',observed:unique.map(r=>r.text)};
 })};
}
