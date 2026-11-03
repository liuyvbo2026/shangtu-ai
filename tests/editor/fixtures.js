// Deterministic, programmatically drawn test assets. Never enter the product library.
import {canvasBlob} from '../../src/editor/render.js';
import {createAsset} from '../../src/editor/storage.js';
export async function fixtureAsset(kind = 'base') {
  const c = document.createElement('canvas'); c.width = kind === 'base' ? 960 : 160; c.height = kind === 'base' ? 720 : 160;
  const x = c.getContext('2d');
  if (kind === 'base') {
    x.fillStyle = '#f2f0eb'; x.fillRect(0,0,960,720);
    x.fillStyle = '#e4e0d7'; x.fillRect(0,540,960,180);
    x.fillStyle = '#d0c5b6'; x.fillRect(320,165,320,390);
    x.fillStyle = '#ede7dd'; x.fillRect(320,165,320,36);
    x.fillStyle = '#faf9f5'; x.fillRect(350,270,260,175);
    x.fillStyle = '#383b38'; x.font = '500 40px sans-serif'; x.fillText('FORM / 05',365,335);
    x.font = '18px sans-serif'; x.fillText('EDITOR TEST FIXTURE',365,386);
    x.fillStyle = '#747b6c'; x.fillRect(350,420,260,10);
    x.fillStyle = '#77796f'; x.font = '16px sans-serif'; x.fillText('ORIGINAL · 960 × 720',50,660);
  } else {
    x.fillStyle = '#6f7967'; x.fillRect(0,0,160,160);
    x.fillStyle = '#ffffff'; x.fillRect(24,24,112,12); x.fillRect(24,56,72,12); x.fillRect(24,88,92,12);
  }
  return createAsset(await canvasBlob(c),`05a-${kind}.png`);
}
