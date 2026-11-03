import {snapshot, requireValue, identifier, unique} from './value.js';
import {batchItem} from './batch.js';
import {checkedTasks, sortedResults} from './results.js';

const extensions = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'};
const keyOf = ({itemId, slotKey}) => JSON.stringify([itemId, slotKey]);
const encoder = new TextEncoder();

// ZIP path components, not filesystem paths. UTF-8 byte cap keeps Chinese names safe.
export function safeSegment(value) {
  let text = String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/gu, '_')
    .trim().replace(/^[. ]+|[. ]+$/gu, '');
  if (!text) text = '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)) text = `_${text}`;
  while (encoder.encode(text).length > 80) text = Array.from(text).slice(0, -1).join('');
  return text.replace(/[. ]+$/gu, '') || '未命名';
}

export function buildDownloadManifest(batch, tasks, options = {}) {
  const {scope = 'batch', itemId, selection = [], format = 'original'} = options;
  requireValue(['batch', 'product', 'selected', 'image'].includes(scope), 'INVALID_SCOPE', 'Invalid download scope');
  requireValue(['original', 'png', 'jpg', 'webp'].includes(format), 'INVALID_FORMAT', 'Invalid download format');
  checkedTasks(batch, tasks);
  if (scope === 'product') batchItem(batch, itemId);
  if (scope === 'image') requireValue(selection.length === 1, 'INVALID_SELECTION', 'Choose exactly one image');
  for (const selected of selection) {
    const item = batchItem(batch, selected.itemId);
    requireValue(item.slots.some(s => s.key === selected.slotKey), 'TARGET_MISSING', 'Selection does not belong to this product');
  }
  const selectedKeys = new Set(selection.map(keyOf)); // Duplicate selection never duplicates a file.
  const included = value => scope === 'batch' || (scope === 'product' ? value.itemId === itemId : selectedKeys.has(keyOf(value)));
  const results = sortedResults(batch, tasks).filter(included);
  const skipped = [], files = [], assetPaths = new Map(), hashPaths = new Map();
  const root = `批次-${safeSegment(batch.id)}`;
  const availableKeys = new Set(results.map(keyOf));
  for (const item of batch.items) for (const slot of item.slots) {
    const target = {itemId: item.id, slotKey: slot.key};
    if (!included(target) || availableKeys.has(keyOf(target))) continue;
    const task = tasks.find(t => t.itemId === item.id), child = task?.children.find(c => c.slotKey === slot.key);
    skipped.push({...target, reason: !task ? 'NOT_SUBMITTED' : child?.state !== 'succeeded' ? 'NOT_SUCCEEDED' :
      task.issues.find(i => i.childId === child.id)?.code ?? 'RESULT_UNAVAILABLE'});
  }
  for (const result of results) {
    const {asset} = result;
    const extension = extensions[asset.mediaType];
    const source = {itemId: result.itemId, productId: result.productId, taskId: result.taskId,
      childId: result.childId, slotKey: result.slotKey, resultId: result.id, version: result.version, assetId: asset.id};
    if (format !== 'original' && format !== extension) {
      skipped.push({...source, reason: 'CONVERSION_REQUIRED'}); continue;
    }
    const duplicate = assetPaths.get(asset.id) ?? hashPaths.get(asset.sha256);
    if (duplicate) { duplicate.sources.push(source); continue; }
    identifier(asset.id, 'download asset ID');
    const directory = `${root}/${String(result.itemPosition + 1).padStart(3, '0')}-${safeSegment(result.productName)}`;
    const filename = `${String(result.position + 1).padStart(3, '0')}-${safeSegment(result.type)}-${String(result.index).padStart(2, '0')}-v${result.version}-${asset.width}x${asset.height}.${extension}`;
    const file = {path: `${directory}/${filename}`, assetId: asset.id, sha256: asset.sha256,
      mediaType: asset.mediaType, width: asset.width, height: asset.height, byteLength: asset.byteLength,
      contentPath: asset.contentPath, sources: [source]};
    assetPaths.set(asset.id, file); hashPaths.set(asset.sha256, file); files.push(file);
  }
  unique(files.map(f => f.path.toLowerCase()), 'download path');
  return snapshot({schemaVersion: 1, batchId: batch.id, scope, files, skipped,
    fileCount: files.length, sourceCount: files.reduce((n, f) => n + f.sources.length, 0),
    totalBytes: files.reduce((n, f) => n + f.byteLength, 0)});
}
