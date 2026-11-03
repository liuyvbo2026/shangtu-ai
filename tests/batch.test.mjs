import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings} from '../src/model.js';
import {createRules, resolveSettings, setOverride, clearOverride, effectiveSettings, changeGlobalPlatform, changeGlobalCountry,
  fromLegacyOverrides, createBatchSnapshot, createSubmission, bindTask, projectTask, selectRetryTargets,
  aggregateBatch, sortedResults, applyTaskObservation, listHistory, buildDownloadManifest, safeSegment} from '../src/batch/index.js';
import {fixtures, backendTask, finish, completed, project} from './batch-fixtures.mjs';
const error = code => ({code});

test('06A overrides distinguish absence from 0, false, empty string, null and empty array', () => {
  const global = {...defaultSettings(), prompt: 'global', seed: 42, optional: 'yes'};
  const result = resolveSettings(global, {seed: 0, listing: false, prompt: '', optional: null, layouts: [], counts: {white: 0}});
  assert.equal(result.seed, 0); assert.equal(result.listing, false); assert.equal(result.prompt, '');
  assert.equal(result.optional, null); assert.deepEqual(result.layouts, []);
  assert.deepEqual(result.counts, {white: 0, selling: 3, scene: 2, other: 1});
  assert.equal(global.counts.white, 1); assert.equal(result.country, global.country);
});

test('06A clearing one nested override resumes following without removing siblings', () => {
  let override = setOverride({}, 'counts.white', 0);
  override = setOverride(override, ['counts', 'scene'], 5);
  const cleared = clearOverride(override, 'counts.white');
  const global = defaultSettings(); global.counts.white = 2;
  assert.deepEqual(resolveSettings(global, cleared).counts, {white: 2, selling: 3, scene: 5, other: 1});
  assert.equal(override.counts.white, 0); assert.deepEqual(clearOverride(cleared, 'counts.scene'), {});
  assert.deepEqual(clearOverride(override), {}); assert.deepEqual(clearOverride({}, 'absent.deep'), {});
});

test('06A override JSON boundary rejects undefined, nonfinite, cycles and unsafe paths', () => {
  for (const value of [undefined, NaN, Infinity, new Date(), new Set()]) assert.throws(() => setOverride({}, 'x', value), error('INVALID_JSON'));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => resolveSettings({}, cyclic), error('INVALID_JSON'));
  assert.throws(() => setOverride({}, '__proto__.polluted', true), error('INVALID_PATH'));
  assert.throws(() => resolveSettings({}, JSON.parse('{"__proto__":{"polluted":true}}')), error('INVALID_KEY'));
  assert.equal({}.polluted, undefined);
});

test('06A latest observed platform count links preserve country/language; explicit fields win', () => {
  const global = defaultSettings();
  const next = changeGlobalPlatform(global, '淘宝天猫1688');
  assert.equal(next.settings.country, '美国'); assert.equal(next.settings.language, '英文');
  assert.deepEqual(next.settings.counts, {white: 0, selling: 3, scene: 2, other: 2});
  const override = {platform: '淘宝天猫1688', language: '英文', counts: {scene: 0}, listing: false};
  const local = effectiveSettings(global, override).settings;
  assert.equal(local.country, '美国'); assert.equal(local.language, '英文'); assert.equal(local.counts.scene, 0);
  assert.equal(local.listing, false); assert.equal(global.country, '美国');
  assert.equal(effectiveSettings(global, clearOverride(override, 'platform')).settings.country, '美国');
});

test('06A unknown platform keeps fields and reports uncertainty; policy can explicitly supply links', () => {
  const global = defaultSettings(), unknown = changeGlobalPlatform(global, '未核实平台');
  assert.equal(unknown.settings.country, '美国'); assert.equal(unknown.notices[0].code, 'PLATFORM_LINK_UNKNOWN');
  const rules = createRules({platformLinks: {OZON: {country: '俄罗斯', language: '俄文'}}, evidence: {platformLinks: 'test policy only'}});
  assert.equal(changeGlobalPlatform(global, 'OZON', rules).settings.language, '俄文');
  assert.equal(changeGlobalPlatform(global, '淘宝天猫1688', rules).notices[0].code, 'PLATFORM_LINK_UNKNOWN');
});

test('06A country links use observed transition conditions and preserve explicit no-text choice', () => {
  const global = {...defaultSettings(), country: '中国', language: '中文'};
  assert.equal(changeGlobalCountry(global, '德国').settings.language, '德语');
  assert.equal(changeGlobalCountry({...global, language: '无文字'}, '德国').settings.language, '无文字');
  assert.equal(changeGlobalCountry(global, '日本').notices[0].code, 'COUNTRY_LINK_UNKNOWN');
  assert.equal(effectiveSettings(global, {country: '德国', language: ''}).settings.language, '');
  assert.equal(effectiveSettings(global, {country: '德国'}).settings.language, '德语');
  assert.equal(global.language, '中文');
});

test('06A layout overflow is configurable and records trimmed IDs without mutating input', () => {
  const global = defaultSettings(); global.layouts = ['L1', 'L2', 'L3'];
  const resolved = effectiveSettings(global, {counts: {selling: 1}});
  assert.deepEqual(resolved.settings.layouts, ['L1']); assert.deepEqual(resolved.notices[0].removed, ['L2', 'L3']);
  assert.equal(global.layouts.length, 3);
  assert.throws(() => effectiveSettings(global, {counts: {selling: 0}}, createRules({layoutOverflow: 'reject'})), error('LAYOUT_LIMIT'));
  for (const value of [-1, 0.5, '0', null]) assert.throws(() => effectiveSettings(defaultSettings(), {counts: {white: value}}));
});

test('06A old select sentinels are translated only through explicit legacy boundary', () => {
  const input = {country: '', language: null, prompt: '', listing: false, seed: 0, nullable: null};
  assert.deepEqual(fromLegacyOverrides(input), {override: {prompt: '', listing: false, seed: 0, nullable: null}, removed: ['country', 'language']});
  assert.equal(resolveSettings(defaultSettings(), {country: ''}).country, '');
});

test('06A submit freezes every product/reference/config/slot/policy and survives JSON round-trip', () => {
  const {draft, products} = fixtures();
  draft.items[1].override = {language: '中文', counts: {white: 0, other: 2}, layouts: ['B-layout']};
  const policy = createRules({sizeMap: {'2K/1:1': {width: 2048, height: 2048}}});
  const batch = createBatchSnapshot(draft, products, policy), before = JSON.stringify(batch);
  draft.global.counts.selling = 9; draft.items[1].override.language = '法文';
  products[0].references[0].assetId = 'changed'; products[0].facts.confirmed.color = 'changed';
  assert.equal(JSON.stringify(batch), before); assert.equal(batch.items[0].slots.length, 7); assert.equal(batch.items[1].slots.length, 7);
  assert.equal(batch.items[0].settings.language, '英文'); assert.equal(batch.items[1].settings.language, '中文');
  assert.deepEqual(batch.items[0].slots[0].size, {width: 2048, height: 2048});
  assert.throws(() => batch.items[0].product.references.push({}));
  assert.deepEqual(JSON.parse(JSON.stringify(batch)), batch);
});

test('06A validates confirmed products, unique items, references, image minimum/maximum and policy capacity', () => {
  const {draft, products} = fixtures();
  draft.items[0].confirmed = false;
  assert.throws(() => createBatchSnapshot(draft, products), error('CONFIRMATION_REQUIRED'));
  assert.doesNotThrow(() => createBatchSnapshot(draft, products, createRules({requireConfirmation: false})));
  draft.items[0].confirmed = true; draft.items[0].override = {counts: {white: 0}};
  assert.throws(() => createBatchSnapshot(draft, products, createRules({minImages: 7})), error('IMAGE_MINIMUM'));
  assert.doesNotThrow(() => createBatchSnapshot(draft, products));
  assert.doesNotThrow(() => createBatchSnapshot(draft, products, createRules({minImages: 6})));
  draft.items[0].override = {counts: {white: 21}};
  assert.throws(() => createBatchSnapshot(draft, products), error('IMAGE_LIMIT'));
  draft.items[0].override = {};
  assert.throws(() => createBatchSnapshot(draft, products, createRules({maxItems: 1})), error('BATCH_LIMIT'));
  products[0].references[1].assetId = products[0].references[0].assetId;
  assert.throws(() => createBatchSnapshot(draft, products), error('DUPLICATE_ID'));
  assert.throws(() => createBatchSnapshot({...draft, items: [draft.items[0], draft.items[0]]}, products), error('DUPLICATE_ID'));
});

test('06A submission maps one multi-reference product to one backend task and stable idempotency key', () => {
  const {batch} = fixtures(), a = createSubmission(batch, 'item-0'), b = createSubmission(batch, 'item-1');
  assert.equal(a.body.productRevision, 3); assert.equal(a.body.slots.length, 7);
  assert.notEqual(a.headers['Idempotency-Key'], b.headers['Idempotency-Key']);
  assert.deepEqual(createSubmission(JSON.parse(JSON.stringify(batch)), 'item-0'), a);
  assert.ok(a.body.slots.every(s => !Object.hasOwn(s, 'size')));
  assert.equal(batch.items[0].notices[0].code, 'OUTPUT_SIZE_UNVERIFIED');
  assert.deepEqual(a.unsupported, ['executionPreference']);
});

test('06A adapter rejects mixed products, references, settings, slot ownership and result ownership', () => {
  const {batch} = fixtures(), {task, assets, binding} = completed(batch, 'item-0');
  for (const change of [
    t => {t.productId = 'product-B';}, t => {t.input.references[0].assetId = 'B-original-0';},
    t => {t.input.settings.language = '中文';}, t => {t.children[0].taskId = 'another-task';},
    t => {t.children[0].result.productId = 'product-B';}, t => {t.children[0].slot.layoutId = 'B-layout';}
  ]) {const bad = structuredClone(task); change(bad); assert.throws(() => projectTask(batch, binding, bad, assets));}
  assert.throws(() => bindTask(batch, 'item-1', task));
});

test('06A two products remain isolated despite reversed task and child arrival order', () => {
  const {draft, products} = fixtures(); draft.items[1].override = {language: '中文', layouts: ['only-B']};
  const batch = createBatchSnapshot(draft, products);
  const a = completed(batch, 'item-0'), b = completed(batch, 'item-1'); b.task.children.reverse();
  const tasks = [project(batch, b.task, b.assets), project(batch, a.task, a.assets)];
  const results = sortedResults(batch, tasks);
  assert.equal(results.length, 14); assert.ok(results.slice(0, 7).every(r => r.productId === 'product-A' && r.assetId.includes('item-0')));
  assert.ok(results.slice(7).every(r => r.productId === 'product-B' && r.assetId.includes('item-1')));
  assert.equal(b.task.input.settings.language, '中文'); assert.equal(a.task.input.settings.language, '英文');
  assert.equal(tasks[0].children.find(c => c.type === 'selling').layoutId, 'only-B');
});

test('06A progress uses image counts, exposes partial results while running and includes unsubmitted products', () => {
  const {draft, products} = fixtures(); draft.items[1].override = {counts: {other: 2}};
  const batch = createBatchSnapshot(draft, products), task = backendTask(batch, 'item-0', 'running');
  const assets = [finish(task, 0), finish(task, 1)]; finish(task, 2, 'failed');
  const value = aggregateBatch(batch, [project(batch, task, assets)]);
  assert.equal(value.progress.total, 15); assert.equal(value.progress.completed, 3); assert.equal(value.progress.percent, 20);
  assert.equal(value.progress.notSubmitted, 8); assert.equal(value.progress.available, 2); assert.equal(value.state, 'running');
  assert.equal(value.results.length, 2); assert.equal(aggregateBatch(batch).state, 'not_submitted');
});

test('06A finished mixed batch aggregates partial, cancellation remains explicit, unknown states fail closed', () => {
  const {batch} = fixtures(), a = completed(batch, 'item-0'), b = backendTask(batch, 'item-1', 'failed');
  b.children.forEach((_, i) => finish(b, i, 'failed'));
  const tasks = [project(batch, a.task, a.assets), project(batch, b)];
  assert.equal(aggregateBatch(batch, tasks).state, 'partial'); assert.equal(aggregateBatch(batch, tasks).progress.percent, 100);
  const unknown = structuredClone(b); unknown.state = 'upstream-new-state'; unknown.children[0].state = 'new-child-state';
  assert.equal(aggregateBatch(batch, [tasks[0], project(batch, unknown)]).state, 'unknown');
  assert.equal(project(batch, unknown).children[0].state, 'unknown');
  for (const task of [a.task, b]) {task.state = 'canceled'; task.children.forEach(c => {if (c.state !== 'succeeded') c.state = 'canceled';});}
  const canceled = aggregateBatch(batch, [project(batch, a.task, a.assets), project(batch, b)]);
  assert.equal(canceled.state, 'canceled'); assert.equal(canceled.progress.available, 7);
});

test('06A result availability excludes missing/current-version assets, failed attempts and late failure products', () => {
  const {batch} = fixtures(), {task, assets} = completed(batch, 'item-0');
  assert.equal(project(batch, task, []).progress.available, 0);
  task.children[0].result.versions.push({version: 2, assetId: 'edited-missing', previousVersion: 1, attemptId: null, createdAt: 201});
  task.children[1].attempts[0].state = 'failed'; task.children[2].state = 'failed';
  assets[3].kind = 'original';
  const value = project(batch, task, assets);
  assert.equal(value.progress.available, 3);
  assert.deepEqual(value.issues.map(i => i.code), ['ASSET_MISSING', 'ATTEMPT_NOT_SUCCEEDED', 'CHILD_NOT_SUCCEEDED', 'ASSET_INVALID']);
  assert.equal(buildDownloadManifest(batch, [value]).fileCount, 3);
});

test('06A a successful-looking result cannot download an asset derived from another product', () => {
  const {batch} = fixtures(), source = completed(batch, 'item-0');
  source.assets[0].parentId = 'B-original-0';
  const task = project(batch, source.task, source.assets);
  assert.equal(task.progress.available, 6);
  assert.equal(task.issues[0].code, 'REFERENCE_ASSET_MISMATCH');
  assert.ok(buildDownloadManifest(batch, [task]).files.every(f => f.assetId !== source.assets[0].id));
});

test('06A selected retry respects backend terminal state, unknown outcomes and remaining attempts', () => {
  const {batch} = fixtures(), task = backendTask(batch, 'item-0', 'partial');
  const assets = [finish(task, 0)]; finish(task, 1, 'failed');
  finish(task, 2, 'failed', {error: {outcomeUnknown: true}});
  finish(task, 3, 'failed', {attemptCount: 3});
  for (let i = 4; i < task.children.length; i++) finish(task, i, 'canceled');
  const value = project(batch, task, assets), all = selectRetryTargets(value);
  assert.deepEqual(all.childIds, [task.children[1].id]); assert.equal(all.request.body.expectedRevision, 1);
  assert.ok(all.excluded.some(e => e.reason === 'OUTCOME_UNKNOWN'));
  assert.ok(all.excluded.some(e => e.reason === 'ATTEMPTS_EXHAUSTED'));
  const one = selectRetryTargets(value, {scope: 'image', slotKey: task.children[1].slot.key});
  assert.deepEqual(one.childIds, all.childIds);
  assert.equal(selectRetryTargets(value, {scope: 'image', slotKey: task.children[0].slot.key}).request, null);
  assert.throws(() => selectRetryTargets(value, {scope: 'image', slotKey: 'alien'}), error('TARGET_MISSING'));
  task.state = 'running'; assert.equal(selectRetryTargets(project(batch, task, assets)).request, null);
  task.state = 'canceled'; assert.equal(selectRetryTargets(project(batch, task, assets)).request, null);
});

test('06A history ignores out-of-order responses and terminal regressions without removing other rows', () => {
  const {batch} = fixtures(), a = completed(batch, 'item-0'), b = completed(batch, 'item-1');
  const observe = (history, source, readSequence) => applyTaskObservation(history, batch, source.binding, {...source, readSequence});
  let history = observe([], a, 2); history = observe(history, b, 1);
  const queued = {...a, task: backendTask(batch, 'item-0')};
  assert.deepEqual(observe(history, queued, 1), history); assert.deepEqual(observe(history, queued, 3), history);
  assert.equal(observe(history, a, 4).length, 2);
  assert.equal(listHistory(history, {state: 'succeeded'}).length, 2);
  assert.equal(listHistory(history, {search: '商品B'})[0].itemId, 'item-1');
  assert.throws(() => applyTaskObservation(history, batch, {...a.binding, itemId: 'item-1'}, {...a, readSequence: 5}));
});

test('06A history accepts explicit retry revision and ignores older backend revisions', () => {
  const {batch} = fixtures(), task = backendTask(batch, 'item-0', 'failed');
  task.children.forEach((_, i) => finish(task, i, 'failed'));
  const binding = bindTask(batch, 'item-0', task);
  let history = applyTaskObservation([], batch, binding, {task, readSequence: 1});
  const retry = structuredClone(task); retry.revision = 2; retry.state = 'running';
  retry.children[0].state = 'queued'; retry.children[0].generation++;
  history = applyTaskObservation(history, batch, binding, {task: retry, readSequence: 2});
  assert.equal(history[0].state, 'running');
  assert.deepEqual(applyTaskObservation(history, batch, binding, {task, readSequence: 3}), history);
});

test('06A history sees new edit version even when backend revision and updatedAt are unchanged', () => {
  const {batch} = fixtures(), source = completed(batch, 'item-0');
  let history = applyTaskObservation([], batch, source.binding, {...source, readSequence: 1});
  const child = source.task.children[0], previous = child.result.versions[0];
  child.result.versions.push({version: 2, assetId: 'edited-A', previousVersion: 1, attemptId: null, createdAt: 201});
  source.assets.push({...source.assets[0], id: 'edited-A', parentId: previous.assetId, sha256: 'e'.repeat(64)});
  history = applyTaskObservation(history, batch, source.binding, {...source, readSequence: 2});
  assert.equal(history[0].children[0].result.version, 2);
  assert.match(buildDownloadManifest(batch, history).files[0].path, /-v2-/);
});

test('06A manifest orders by product/slot and coalesces repeated assets and hashes with source aliases', () => {
  const {batch} = fixtures(), a = completed(batch, 'item-0'), b = completed(batch, 'item-1');
  b.assets[0].sha256 = a.assets[0].sha256;
  const tasks = [project(batch, b.task, b.assets), project(batch, a.task, a.assets)];
  const manifest = buildDownloadManifest(batch, tasks);
  assert.equal(manifest.fileCount, 13); assert.equal(manifest.sourceCount, 14);
  assert.equal(manifest.files[0].sources.length, 2); assert.equal(manifest.files[0].sources[1].productId, 'product-B');
  assert.match(manifest.files[0].path, /001-商品A\/001-white-01-v1-1200x1200.png$/);
  assert.match(manifest.files.at(-1).path, /002-商品B\//);
  assert.equal(new Set(manifest.files.map(f => f.sha256)).size, 13);
  assert.equal(buildDownloadManifest(batch, tasks, {scope: 'product', itemId: 'item-1'}).fileCount, 7);
});

test('06A selections never broaden empty scope; repeated/failed/foreign selections cannot add files', () => {
  const {batch} = fixtures(), source = completed(batch, 'item-0'); source.task.children[1].state = 'failed';
  const tasks = [project(batch, source.task, source.assets)], selected = {itemId: 'item-0', slotKey: 'white-001'};
  assert.equal(buildDownloadManifest(batch, tasks, {scope: 'selected'}).fileCount, 0);
  assert.equal(buildDownloadManifest(batch, tasks, {scope: 'selected', selection: [selected, selected]}).fileCount, 1);
  const bad = {itemId: 'item-0', slotKey: 'selling-001'};
  assert.equal(buildDownloadManifest(batch, tasks, {scope: 'image', selection: [bad]}).fileCount, 0);
  assert.throws(() => buildDownloadManifest(batch, tasks, {scope: 'image', selection: [{itemId: 'foreign', slotKey: 'white-001'}]}));
  assert.throws(() => buildDownloadManifest(batch, tasks, {scope: 'image'}));
});

test('06A manifest uses actual asset type/dimensions, never renames PNG to JPEG to fake conversion', () => {
  const {batch} = fixtures(), task = backendTask(batch, 'item-0', 'running');
  const assets = [finish(task, 0, 'succeeded', {mediaType: 'image/jpeg'})];
  const tasks = [project(batch, task, assets)];
  assert.match(buildDownloadManifest(batch, tasks).files[0].path, /1200x1200.jpg$/);
  const png = buildDownloadManifest(batch, tasks, {format: 'png'});
  assert.equal(png.fileCount, 0); assert.ok(png.skipped.some(s => s.reason === 'CONVERSION_REQUIRED'));
});

test('06A filenames handle traversal, Windows names, Unicode, same product names and byte limits', () => {
  for (const input of ['../..', 'CON', 'nul.png', 'a/b\\c', ' .. ', '图'.repeat(100), '\u202eevil']) {
    const name = safeSegment(input); assert.ok(name && !/[\\/\u202e]/u.test(name));
    assert.ok(!/^[. ]|[. ]$/.test(name)); assert.ok(new TextEncoder().encode(name).length <= 80);
  }
  assert.equal(safeSegment('CON'), '_CON'); assert.equal(safeSegment('e\u0301'), 'é');
  const {draft, products} = fixtures(); products.forEach(p => {p.name = '../同名';});
  const batch = createBatchSnapshot(draft, products), tasks = batch.items.map(i => {const s = completed(batch, i.id); return project(batch, s.task, s.assets);});
  const files = buildDownloadManifest(batch, tasks).files;
  assert.equal(new Set(files.map(f => f.path)).size, 14); assert.ok(files.every(f => !f.path.split('/').includes('..')));
});
