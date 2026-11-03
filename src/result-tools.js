import {decodeImage} from './editor/render.js';

// PSD v1, 8-bit RGB, flattened composite. No invented layers or editable text.
// Adobe File Formats Specification: header + 3 empty sections + raw planar RGB.
export function flattenedPSD({width,height,data}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>40_000_000||data.length!==width*height*4)throw Error('PSD 图片尺寸无效');
 const n=width*height,bytes=new Uint8Array(40+n*3),v=new DataView(bytes.buffer);
 bytes.set([56,66,80,83]);v.setUint16(4,1);v.setUint16(12,3);v.setUint32(14,height);v.setUint32(18,width);v.setUint16(22,8);v.setUint16(24,3);
 for(let i=0;i<n;i++)for(let c=0;c<3;c++)bytes[40+c*n+i]=Math.round(data[i*4+c]*data[i*4+3]/255+255-data[i*4+3]);
 return new Blob([bytes],{type:'image/vnd.adobe.photoshop'});
}
export async function exportResultImage(blob,format){
 if(!['jpg','psd'].includes(format))throw Error('请选择 JPG 或 PSD');
 const image=await decodeImage(blob),canvas=document.createElement('canvas');
 canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
 const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);
 if(format==='psd')return flattenedPSD(ctx.getImageData(0,0,canvas.width,canvas.height));
 return new Promise((resolve,reject)=>canvas.toBlob(b=>b?.type==='image/jpeg'?resolve(b):reject(Error('JPG 导出失败')),'image/jpeg',.95));
}
export function listingContent(listing){
 if(typeof listing==='string'){
  const titles=['宝贝标题','核心卖点','核心卖点/促销利益点','详情页文案','搜索关键词','搜索关键词/属性词'];
  const lines=listing.split('\n'),sections=[];let current=null;
  for(const line of lines){const title=titles.find(t=>line.trim().replace(/[：:]$/,'')===t);
   if(title){current={title,text:''};sections.push(current);}else if(current)current.text+=(current.text?'\n':'')+line;
   else if(line){current={title:'商品上架文案',text:line};sections.push(current);}
  }
  return {text:listing,sections:sections.length?sections:[{title:'商品上架文案',text:listing}]};
 }
 const sections=(Array.isArray(listing?.sections)?listing.sections:[]).filter(s=>typeof s.title==='string'&&typeof s.text==='string').map(s=>({title:s.title,text:s.text}));
 return {text:sections.map(s=>`${s.title}\n${s.text}`).join('\n\n'),sections};
}
