import {defaultSettings} from '../src/model.js';
import {createBatchSnapshot, createSubmission, bindTask, projectTask} from '../src/batch/index.js';

export function fixtures() {
  const products = ['A', 'B'].map(letter => ({
    id: `product-${letter}`, revision: 3, name: `商品${letter}`, facts: {confirmed: {color: letter === 'A' ? 'red' : 'blue'}},
    references: [0, 1].map(position => ({id: `${letter}-ref-${position}`, assetId: `${letter}-original-${position}`, role: position ? 'detail' : 'front', position}))
  }));
  const draft = {id: 'batch-06A', createdAt: 100, mode: 'immediate', global: defaultSettings(),
    items: products.map((product, i) => ({id: `item-${i}`, productId: product.id, confirmed: true, description: `独立描述${i}`, override: {}}))};
  const batch = createBatchSnapshot(draft, products);
  return {products, draft, batch};
}

export function backendTask(batch, itemId, state = 'queued') {
  const item = batch.items.find(i => i.id === itemId), request = createSubmission(batch, itemId).body;
  const taskId = `task-${itemId}`;
  return structuredClone({id: taskId, productId: item.productId, state, revision: 1, createdAt: 100, updatedAt: 100,
    input: {contractVersion: 1, product: item.product, references: item.product.references, settings: request.settings,
      description: request.description, slots: request.slots, versions: request.versions}, policy: {maxAttempts: 3},
    children: item.slots.map((slot, position) => ({id: `${taskId}-${slot.key}`, taskId, position, slot,
      state: 'queued', generation: 1, attemptCount: 0, error: null, attempts: [], result: null}))});
}

export function finish(task, position, state = 'succeeded', options = {}) {
  const child = task.children[position];
  child.state = state; child.attemptCount = options.attemptCount ?? 1;
  child.error = options.error ?? null;
  const attemptId = `attempt-${child.id}`;
  child.attempts = [{id: attemptId, state, ordinal: 1, generation: child.generation}];
  if (state !== 'succeeded') return null;
  const assetId = options.assetId ?? `output-${child.id}`;
  child.result = {id: `result-${child.id}`, taskId: task.id, childId: child.id, productId: task.productId,
    versions: [{version: 1, assetId, attemptId, previousVersion: null, createdAt: 200}]};
  return {id: assetId, kind: 'derived', parentId: task.input.references[0].assetId,
    mediaType: options.mediaType ?? 'image/png', width: 1200, height: 1200, byteLength: 1024,
    sha256: options.sha256 ?? `${task.productId.endsWith('A') ? 'a' : 'b'}${position.toString(16).padStart(63, '0')}`};
}

export function completed(batch, itemId) {
  const task = backendTask(batch, itemId, 'succeeded');
  const assets = task.children.map((_, i) => finish(task, i));
  return {task, assets, binding: bindTask(batch, itemId, task)};
}
export const project = (batch, task, assets = []) => projectTask(batch, bindTask(batch, task.input.versions.batch.itemId, task), task, assets);
