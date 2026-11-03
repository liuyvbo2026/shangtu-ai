import {validateScene} from './core.js';
export const FONT_STACKS = {system:'"PingFang SC", "Microsoft YaHei", sans-serif',serif:'"Songti SC", SimSun, serif',mono:'Menlo, Consolas, monospace'};
export function canvasBlob(canvas) { return new Promise((resolve,reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('PNG 导出失败')), 'image/png')); }
export async function decodeImage(blob) {
  const url = URL.createObjectURL(blob), image = new Image();
  try { image.src = url; await image.decode(); return image; }
  catch { throw Error('图片无法解码，请使用 PNG、JPEG 或 WebP'); }
  finally { URL.revokeObjectURL(url); }
}
function textLines(ctx, text, width) {
  const lines = [], segmenter = new Intl.Segmenter('zh',{granularity:'grapheme'});
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const {segment} of segmenter.segment(paragraph)) {
      if (line && ctx.measureText(line + segment).width > width) { lines.push(line); line = ''; }
      line += segment;
    }
    lines.push(line);
  }
  return lines;
}
// Render into a fresh canvas, then replace the preview only after success.
// No selection outline, decoration, CSS filter or viewport scaling is exported.
export async function renderScene(scene, resolveAsset) {
  validateScene(scene); await document.fonts.ready;
  const canvas = document.createElement('canvas'); canvas.width = scene.width; canvas.height = scene.height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw Error('浏览器无法创建图片画布');
  ctx.fillStyle = scene.background; ctx.fillRect(0,0,scene.width,scene.height);
  for (const l of scene.layers) {
    if (!l.visible || l.opacity === 0) continue;
    ctx.save(); ctx.globalAlpha = l.opacity;
    if (l.type === 'image') {
      const asset = await resolveAsset(l.assetId); if (!asset) throw Error(`缺少图片资产 ${l.assetId}`);
      const r = l.sourceRect;
      if (r.x+r.width > asset.width || r.y+r.height > asset.height) throw Error('图片裁剪区域超出原图');
      const img = await decodeImage(asset.blob);
      if (img.naturalWidth !== asset.width || img.naturalHeight !== asset.height) throw Error('图片尺寸与资产元数据不一致');
      ctx.drawImage(img,r.x,r.y,r.width,r.height,l.x,l.y,l.width,l.height);
    } else {
      const s = l.style;
      ctx.font = `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px ${FONT_STACKS[s.fontFamily]}`;
      ctx.textBaseline = 'top'; ctx.textAlign = s.align; ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.rect(l.x,l.y,l.width,l.height); ctx.clip();
      const x = l.x + (s.align === 'center' ? l.width/2 : s.align === 'right' ? l.width : 0);
      textLines(ctx,l.text,l.width).forEach((line,i) => { const y = l.y+i*s.fontSize*s.lineHeight; if (y < l.y+l.height) ctx.fillText(line,x,y); });
    }
    ctx.restore();
  }
  return canvas;
}
export async function exportPNG(scene, resolveAsset) { return canvasBlob(await renderScene(scene,resolveAsset)); }
