import {assetURL, getAsset} from './storage.js';

// Shared image sizing for kit output. Model-dependent changes use the demo adapter.
export async function renderProductImage(assetId, dimensions = {}) {
  const asset = await getAsset(assetId);
  if (!asset) throw Error('找不到商品图片，请重新上传。');
  const source = await assetURL(assetId);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(Error('商品图片无法读取，请重新上传。'));
    img.src = source;
  });
  const width = dimensions.width || image.naturalWidth;
  const height = dimensions.height || image.naturalHeight;
  const limit = Math.min(1, 4096 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * limit));
  canvas.height = Math.max(1, Math.round(height * limit));
  const fit = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
  canvas.getContext('2d').drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  return canvas;
}
