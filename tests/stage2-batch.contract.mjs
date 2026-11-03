// Opt-in contract test against the actual sibling backend. No server, worker or provider.
// Only test-owned temporary data is written; backend source and user data stay read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../backend/store.mjs';
import {TEST_CONTRACT, fixturePNG} from './backend/test-processor.mjs';
import {defaultSettings} from '../src/model.js';
import {fromBackendProduct, createBatchSnapshot, createSubmission, bindTask, projectTask, selectRetryTargets,
  aggregateBatch, buildDownloadManifest, applyTaskObservation} from '../src/batch/index.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aigc-06a-contract-'));
  const store = new Store({dataDir: root, processor: TEST_CONTRACT, config: {leaseMs: 60000}});
  t.after(() => {store.close(); fs.rmSync(root, {recursive: true, force: true});});
  const products = ['A', 'B'].map(name => {
    let p = store.createProduct({name: `契约商品-${name}`, facts: {confirmed: {color: name === 'A' ? 'red' : 'blue'}}});
    for (let i = 0; i < 2; i++) {
      const asset = store.putAsset(fixturePNG(`${name}-reference-${i}`), {name: `${name}-${i}.png`});
      p = store.addReference(p.id, {assetId: asset.id, role: i ? 'detail' : 'front'});
    }
    return fromBackendProduct(p);
  });
  const draft = {id: 'contract-batch', createdAt: 100, mode: 'queue', global: defaultSettings(),
    items: products.map((p, i) => ({id: `item-${i}`, productId: p.id, description: `description-${i}`, confirmed: true,
      override: i ? {language: '中文', counts: {white: 0, other: 2}, listing: false, layouts: ['B-layout']} : {}}))};
  const batch = createBatchSnapshot(draft, products);
  const submit = itemId => {const r = createSubmission(batch, itemId); return store.submit(r.body, r.headers['Idempotency-Key']);};
  const project = binding => {
    const task = store.task(binding.taskId);
    const assets = task.children.flatMap(c => c.result ? [store.asset(c.result.versions.at(-1).assetId)] : []);
    return projectTask(batch, binding, task, assets);
  };
  return {store, products, draft, batch, submit, project};
}

test('06A / actual stage2 Store: two products, idempotency, partial results, selected retry, versions and download manifest', t => {
  const {store, draft, products, batch, submit, project} = setup(t);
  const submissions = batch.items.map(i => submit(i.id));
  const bindings = submissions.map((s, i) => bindTask(batch, `item-${i}`, s));
  assert.equal(submit('item-0').duplicate, true); assert.equal(store.tasks().length, 2);
  draft.global.language = 'changed'; draft.items[1].override.layouts.push('changed-layout');
  let failedChild;
  for (let n = 0; n < 14; n++) {
    const claim = store.claim(TEST_CONTRACT); assert.ok(claim);
    const item = batch.items.find(i => i.productId === claim.productId);
    assert.deepEqual(claim.input.references.map(r => r.assetId), item.product.references.map(r => r.assetId));
    assert.equal(claim.input.settings.language, item.settings.language);
    assert.equal(claim.input.description, item.description);
    if (claim.productId === products[1].id && claim.slot.key === 'selling-001') {
      store.failAttempt(claim, {code: 'TRANSIENT', retryable: false, outcomeUnknown: false}); failedChild = claim.childId;
    } else {
      store.complete(claim, {bytes: fixturePNG(`${claim.productId}-${claim.slot.key}`), mediaType: 'image/png'});
    }
  }
  assert.equal(store.claim(TEST_CONTRACT), null);
  let tasks = bindings.map(project), summary = aggregateBatch(batch, tasks);
  assert.equal(summary.state, 'partial'); assert.equal(summary.progress.completed, 14); assert.equal(summary.progress.available, 13);
  let manifest = buildDownloadManifest(batch, tasks);
  assert.equal(manifest.fileCount, 13); assert.ok(manifest.files.every(f => f.width === 1 && f.height === 1));
  assert.ok(manifest.files.every(f => !f.sources.some(s => s.childId === failedChild)));
  const retry = selectRetryTargets(tasks[1], {scope: 'image', slotKey: 'selling-001'});
  assert.deepEqual(retry.childIds, [failedChild]);
  const successfulIds = tasks[0].children.map(c => c.result.id);
  store.retry(tasks[1].taskId, retry.request.body);
  const retryClaim = store.claim(TEST_CONTRACT); assert.equal(retryClaim.childId, failedChild);
  store.complete(retryClaim, {bytes: fixturePNG('retried-B-selling'), mediaType: 'image/png'});
  tasks = bindings.map(project); assert.equal(aggregateBatch(batch, tasks).state, 'succeeded');
  assert.deepEqual(tasks[0].children.map(c => c.result.id), successfulIds);
  const task = store.task(bindings[0].taskId), child = task.children[0], current = child.result.versions.at(-1);
  const edited = store.putAsset(fixturePNG('edited-A'), {kind: 'derived', parentId: current.assetId, name: 'edited.png'});
  store.appendVersion(child.result.id, {assetId: edited.id, expectedVersion: 1});
  const changed = store.task(task.id);
  assert.equal(changed.revision, task.revision); assert.equal(changed.updatedAt, task.updatedAt);
  let history = applyTaskObservation([], batch, bindings[0], {task, assets: [store.asset(current.assetId)], readSequence: 1});
  history = applyTaskObservation(history, batch, bindings[0], {task: changed, assets: [edited], readSequence: 2});
  assert.equal(history[0].children[0].result.version, 2);
  tasks = bindings.map(project); manifest = buildDownloadManifest(batch, tasks);
  assert.equal(manifest.fileCount, 14); assert.equal(manifest.files[0].assetId, edited.id);
  assert.match(manifest.files[0].path, /-v2-1x1.png$/);
  for (const file of manifest.files) assert.equal(store.readAsset(file.assetId).length, file.byteLength);
});

test('06A / actual stage2 Store: frozen revision conflicts and cross-product mapping fail closed', t => {
  const {store, products, batch, submit} = setup(t);
  const first = submit('item-0');
  assert.throws(() => bindTask(batch, 'item-1', first), {code: 'TASK_OWNERSHIP'});
  store.updateProduct(products[1].id, {name: 'changed', expectedRevision: products[1].revision});
  assert.throws(() => submit('item-1'), {code: 'REVISION_CONFLICT'});
  const r = createSubmission(batch, 'item-0');
  assert.throws(() => store.submit({...r.body, description: 'different'}, r.headers['Idempotency-Key']), {code: 'IDEMPOTENCY_CONFLICT'});
});

test('06A / actual stage2 Store: unknown outcome is not retried, cancellation rejects late completion', t => {
  const {store, batch, submit, project} = setup(t);
  const bindings = batch.items.map(item => bindTask(batch, item.id, submit(item.id)));
  let unknownChild;
  while (true) {
    const claim = store.claim(TEST_CONTRACT); if (!claim) break;
    if (claim.taskId === bindings[1].taskId) {
      store.cancel(claim.taskId);
      assert.equal(store.complete(claim, {bytes: fixturePNG('late'), mediaType: 'image/png'}), false);
    } else {
      unknownChild ??= claim.childId;
      store.failAttempt(claim, {code: 'OUTCOME_UNKNOWN', retryable: false, outcomeUnknown: true});
    }
  }
  const tasks = bindings.map(project);
  assert.equal(selectRetryTargets(tasks[0]).request, null); assert.equal(selectRetryTargets(tasks[1]).request, null);
  assert.throws(() => store.retry(tasks[0].taskId, {childIds: [unknownChild], expectedRevision: tasks[0].revision}), {code: 'TASK_NOT_RETRYABLE'});
  assert.equal(buildDownloadManifest(batch, tasks).fileCount, 0);
});
