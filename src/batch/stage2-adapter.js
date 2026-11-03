import {snapshot, same, requireValue, identifier, integer, unique} from './value.js';
import {batchItem} from './batch.js';

export const STAGE2_CONTRACT = 'backend-v1-provisional';
export const TASK_STATES = Object.freeze(['queued', 'running', 'succeeded', 'partial', 'failed', 'canceled']);
export const CHILD_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'canceled']);
export const API_PREFIX = '/api/backend-v1';
const reference = r => ({id: r.id, assetId: r.assetId, role: r.role, position: r.position});

export function fromBackendProduct(product) {
  return snapshot({id: product.id, revision: product.revision, name: product.name,
    facts: product.facts, references: product.references.map(reference)});
}

// Descriptors only: callers own transport, authentication, persistence and request lifetimes.
export function createSubmission(batch, itemId) {
  const item = batchItem(batch, itemId);
  const key = JSON.stringify([batch.id, item.id]);
  requireValue(key.length <= 200, 'IDEMPOTENCY_KEY_LIMIT', 'Combined batch/item IDs exceed the backend key limit');
  return snapshot({
    contract: STAGE2_CONTRACT, method: 'POST', path: `${API_PREFIX}/tasks`,
    // JSON tuple avoids delimiter collisions. Batch IDs must be unique per new submission.
    headers: {'Idempotency-Key': key},
    body: {
      productId: item.productId, productRevision: item.product.revision,
      settings: item.settings, description: item.description, slots: item.slots,
      versions: {batch: {schema: '06A-v1', batchId: batch.id, itemId: item.id, rulesVersion: batch.rules.version}}
    },
    unsupported: ['executionPreference']
  });
}

function verifyTask(batch, itemId, task) {
  const item = batchItem(batch, itemId), expected = createSubmission(batch, itemId).body;
  identifier(task.id, 'task ID'); integer(task.revision, 'task revision', 1);
  requireValue(task.productId === item.productId && task.input?.contractVersion === 1, 'TASK_OWNERSHIP', 'Unexpected product or input contract');
  requireValue(same(fromBackendProduct(task.input.product), item.product) &&
    same(task.input.references.map(reference), item.product.references), 'REFERENCE_MISMATCH', 'Task product/references differ from frozen input');
  requireValue(same(task.input.settings, expected.settings) && task.input.description === expected.description &&
    same(task.input.slots, expected.slots) && same(task.input.versions, expected.versions), 'SNAPSHOT_MISMATCH', 'Task input differs from frozen submission');
  requireValue(Array.isArray(task.children) && task.children.length === item.slots.length, 'CHILD_MISMATCH', 'Unexpected image task count');
  unique(task.children.map(c => c.id), 'child ID'); unique(task.children.map(c => c.slot.key), 'slot key');
  task.children.forEach(child => {
    identifier(child.id, 'child ID'); integer(child.generation, 'generation', 1); integer(child.attemptCount, 'attempt count');
    requireValue(child.taskId === task.id && same(child.slot, item.slots[child.position]), 'CHILD_MISMATCH', 'Image task belongs to a different task or slot');
  });
  return item;
}

export function bindTask(batch, itemId, response) {
  const task = response.task ?? response;
  verifyTask(batch, itemId, task);
  return snapshot({batchId: batch.id, itemId, taskId: task.id});
}

function resultView(task, child, assets) {
  if (!child.result) return {result: null, issue: child.state === 'succeeded' ? 'RESULT_MISSING' : null};
  const result = child.result;
  requireValue(result.taskId === task.id && result.childId === child.id && result.productId === task.productId,
    'RESULT_OWNERSHIP', 'Result belongs to a different product, task or image');
  identifier(result.id, 'result ID');
  const versions = [...result.versions].sort((a, b) => a.version - b.version);
  requireValue(versions.length > 0, 'INVALID_VERSION', 'Result has no version');
  versions.forEach((v, i) => {
    identifier(v.assetId, 'result asset ID');
    requireValue(v.version === i + 1 && v.previousVersion === (i ? i : null), 'INVALID_VERSION', 'Result version chain is incomplete');
  });
  const current = versions.at(-1), asset = assets.get(current.assetId);
  const firstAttempt = child.attempts.find(a => a.id === versions[0].attemptId);
  let issue = null;
  if (child.state !== 'succeeded') issue = 'CHILD_NOT_SUCCEEDED';
  else if (!firstAttempt || firstAttempt.state !== 'succeeded') issue = 'ATTEMPT_NOT_SUCCEEDED';
  else if (!asset) issue = 'ASSET_MISSING';
  else if (asset.kind !== 'derived' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType) ||
    !/^[a-f0-9]{64}$/i.test(asset.sha256) || ![asset.width, asset.height, asset.byteLength].every(n => Number.isSafeInteger(n) && n > 0)) issue = 'ASSET_INVALID';
  else if (versions.length === 1 && asset.parentId !== task.input.references[0].assetId) issue = 'REFERENCE_ASSET_MISMATCH';
  else if (versions.length > 1 && asset.parentId !== versions.at(-2).assetId) issue = 'VERSION_ASSET_MISMATCH';
  return {result: {
    id: result.id, version: current.version, assetId: current.assetId, available: issue === null,
    ...(issue === null ? {asset: {
      id: asset.id, sha256: asset.sha256.toLowerCase(), mediaType: asset.mediaType,
      width: asset.width, height: asset.height, byteLength: asset.byteLength,
      contentPath: `${API_PREFIX}/assets/${encodeURIComponent(asset.id)}/content`
    }} : {})
  }, issue};
}

export function projectTask(batch, binding, task, assets = []) {
  requireValue(binding.batchId === batch.id && binding.taskId === task.id, 'TASK_OWNERSHIP', 'Task does not match binding');
  const item = verifyTask(batch, binding.itemId, task);
  unique(assets.map(a => a.id), 'asset metadata ID');
  unique(task.children.filter(c => c.result).map(c => c.result.id), 'result ID');
  integer(task.policy.maxAttempts, 'attempt limit', 1);
  integer(task.createdAt, 'task createdAt'); integer(task.updatedAt, 'task updatedAt');
  const assetMap = new Map(assets.map(a => [a.id, a]));
  const issues = [];
  const state = TASK_STATES.includes(task.state) ? task.state : 'unknown';
  if (state === 'unknown') issues.push({code: 'UNKNOWN_TASK_STATE', value: task.state});
  const children = [...task.children].sort((a, b) => a.position - b.position).map(child => {
    const childState = CHILD_STATES.includes(child.state) ? child.state : 'unknown';
    if (childState === 'unknown') issues.push({code: 'UNKNOWN_CHILD_STATE', childId: child.id, value: child.state});
    const {result, issue} = resultView(task, child, assetMap);
    if (issue) issues.push({code: issue, childId: child.id});
    return {id: child.id, slotKey: child.slot.key, position: child.position, type: child.slot.type,
      index: child.slot.index, layoutId: child.slot.layoutId, state: childState, generation: child.generation,
      attemptCount: child.attemptCount, error: child.error ?? null, result};
  });
  const progress = {total: children.length, queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0, unknown: 0, completed: 0, available: 0};
  for (const child of children) {
    progress[child.state]++;
    if (['succeeded', 'failed', 'canceled'].includes(child.state)) progress.completed++;
    if (child.result?.available) progress.available++;
  }
  progress.percent = Math.floor(100 * progress.completed / progress.total);
  return snapshot({contract: STAGE2_CONTRACT, batchId: batch.id, itemId: item.id, productId: item.productId,
    taskId: task.id, productName: item.product.name, revision: task.revision, state, createdAt: task.createdAt, updatedAt: task.updatedAt,
    maxAttempts: task.policy.maxAttempts, progress, children, issues});
}

export function selectRetryTargets(task, {scope = 'product', slotKey} = {}) {
  requireValue(['product', 'image'].includes(scope), 'INVALID_SCOPE', 'Retry scope must be product or image');
  const targets = scope === 'product' ? task.children : task.children.filter(c => c.slotKey === slotKey);
  requireValue(targets.length > 0, 'TARGET_MISSING', 'Retry image is not in this product task');
  const childIds = [], excluded = [];
  for (const child of targets) {
    const reason = !['partial', 'failed'].includes(task.state) ? 'TASK_NOT_RETRYABLE' :
      child.state !== 'failed' ? 'CHILD_NOT_FAILED' :
      child.error?.outcomeUnknown ? 'OUTCOME_UNKNOWN' :
      child.attemptCount >= task.maxAttempts ? 'ATTEMPTS_EXHAUSTED' : null;
    if (reason) excluded.push({childId: child.id, slotKey: child.slotKey, reason}); else childIds.push(child.id);
  }
  return snapshot({taskId: task.taskId, itemId: task.itemId, childIds, excluded,
    request: childIds.length ? {method: 'POST', path: `${API_PREFIX}/tasks/${encodeURIComponent(task.taskId)}/retry`,
      body: {childIds, expectedRevision: task.revision}} : null});
}
