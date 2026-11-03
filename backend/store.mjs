import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Fault, fail, id, now, hash, canonical, object, string, integer, json, configuration } from './core.mjs';
import { Files, safeDirectory, writeExclusive, readRegular } from './files.mjs';

const assetView = a => a && ({ id:a.id, kind:a.kind, parentId:a.parent_id, path:a.path, name:a.name, mediaType:a.media_type, width:a.width, height:a.height, byteLength:a.byte_length, sha256:a.sha256, createdAt:a.created_at });
const parse = x => x ? JSON.parse(x) : null;

// One OS process owns a data directory. SQLite still makes each state transition atomic.
// A missing/malformed owner record is never guessed stale: operator intervention is required.
function acquireLock(root) {
  const file = path.join(root, '.writer-lock');
  // Serialize stale-owner takeover. An interrupted claim is fail-closed, never stolen.
  const guard = path.join(root, '.writer-claim');
  try { writeExclusive(guard, Buffer.from(String(process.pid))); }
  catch(error) { if(error.code==='EEXIST') throw new Fault('STORE_LOCKED','Writer ownership is being acquired or needs inspection',409); throw error; }
  try {
  if (fs.existsSync(file)) {
    let previous;
    try { previous = JSON.parse(readRegular(file)); } catch { throw new Fault('STORE_LOCKED', 'Unverifiable writer lock', 409); }
    integer(previous.pid, 'lock pid');
    try { process.kill(previous.pid, 0); throw new Fault('STORE_LOCKED', 'Data directory already in use', 409); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(file);
  }
  const token = id();
  try { writeExclusive(file, Buffer.from(JSON.stringify({ pid: process.pid, token }))); }
  catch (error) { if (error.code === 'EEXIST') throw new Fault('STORE_LOCKED', 'Data directory already in use', 409); throw error; }
  return () => {
    if (fs.existsSync(file) && JSON.parse(readRegular(file)).token === token) fs.unlinkSync(file);
  };
  } finally { fs.unlinkSync(guard); }
}

export class Store {
  constructor({ dataDir, config = {}, processor = { id:'unconfigured', version:'0', replaySafe:false } }) {
    this.config = configuration(config); this.processor = structuredClone(processor);
    string(processor.id, 'processor id'); string(processor.version, 'processor version');
    this.root = safeDirectory(path.resolve(dataDir)); this.release = acquireLock(this.root);
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const p = path.join(this.root, `store.sqlite${suffix}`);
        if (fs.existsSync(p)) fail(fs.lstatSync(p).isFile() && !fs.lstatSync(p).isSymbolicLink(), 'UNSAFE_PATH', 'Invalid database path');
      }
      this.files = new Files(path.join(this.root, 'files'), this.config);
      this.db = new DatabaseSync(path.join(this.root, 'store.sqlite'));
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      this.closed = false; this.executor = null;
    } catch (error) { this.db?.close(); this.release(); throw error; }
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() {
    if (this.closed) return;
    fail(!this.executor, 'EXECUTOR_ACTIVE', 'Stop executor before closing store', 409);
    this.db.close(); this.closed = true; this.release();
  }
  event(taskId, kind, data = {}) { this.run('INSERT INTO events(task_id,kind,data_json,created_at) VALUES(?,?,?,?)', taskId, kind, json(data), now()); }
  events(taskId, after = 0) {
    this.taskRow(taskId); integer(after, 'event cursor', 0);
    return this.all('SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 500', taskId, after).map(e => ({ sequence:e.sequence, taskId:e.task_id, kind:e.kind, data:parse(e.data_json), createdAt:e.created_at }));
  }
  createProduct({ name, facts = {} }) {
    string(name, 'product name', 200); object(facts, 'facts');
    const productId = id();
    this.run('INSERT INTO products(id,name,facts_json,created_at) VALUES(?,?,?,?)', productId, name, json(facts), now());
    return this.product(productId);
  }
  product(productId, includeRemoved = false) {
    const p = this.get('SELECT * FROM products WHERE id=?', productId);
    fail(p && (includeRemoved || p.removed_at === null), 'NOT_FOUND', 'Product not found', 404);
    return { id:p.id, name:p.name, facts:parse(p.facts_json), revision:p.revision, createdAt:p.created_at, removedAt:p.removed_at,
      references:this.all('SELECT * FROM product_references WHERE product_id=? ORDER BY position', productId).map(r => ({ id:r.id, assetId:r.asset_id, role:r.role, position:r.position })) };
  }
  products() { return this.all('SELECT id FROM products WHERE removed_at IS NULL ORDER BY created_at,id').map(p => this.product(p.id)); }
  updateProduct(productId, { name, facts, expectedRevision }) {
    const p = this.product(productId); integer(expectedRevision, 'expectedRevision');
    fail(p.revision === expectedRevision, 'REVISION_CONFLICT', 'Product changed', 409);
    if (name !== undefined) string(name, 'product name', 200);
    if (facts !== undefined) object(facts, 'facts');
    this.run('UPDATE products SET name=?,facts_json=?,revision=revision+1 WHERE id=?', name ?? p.name, json(facts ?? p.facts), productId);
    return this.product(productId);
  }
  removeProduct(productId) {
    this.product(productId);
    this.run('UPDATE products SET removed_at=?,revision=revision+1 WHERE id=?', now(), productId);
    // Tombstone preserves task provenance and asset references; no physical data purge.
    return { id:productId, removed:true };
  }
  asset(assetId) { const a = assetView(this.get('SELECT * FROM assets WHERE id=?', assetId)); fail(a, 'NOT_FOUND', 'Asset not found', 404); return a; }
  insertAsset(a) {
    this.run('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?)', a.id,a.kind,a.parentId,a.path,a.name,a.mediaType,a.width,a.height,a.byteLength,a.sha256,now());
  }
  putAsset(bytes, metadata = {}) {
    if (metadata.parentId) this.asset(metadata.parentId);
    fail(metadata.kind !== 'original' || !metadata.parentId, 'INVALID_INPUT', 'Original cannot be a derived child');
    fail(!metadata.parentId || metadata.kind === 'derived', 'INVALID_INPUT', 'Parent requires derived kind');
    const a = this.files.prepare(bytes, metadata);
    try { this.insertAsset(a); } catch (error) { fs.unlinkSync(this.files.resolve(a.path)); throw error; }
    return this.asset(a.id);
  }
  readAsset(assetId) { return this.files.read(this.asset(assetId)); }
  removeAsset(assetId) {
    const a = this.asset(assetId), file = this.files.resolve(a.path);
    try { this.run('DELETE FROM assets WHERE id=?', assetId); }
    catch (error) { if (String(error.message).includes('FOREIGN KEY')) throw new Fault('ASSET_REFERENCED', 'Asset is still referenced', 409); throw error; }
    fs.unlinkSync(file);
    return { id:assetId, removed:true };
  }
  addReference(productId, { assetId, role = 'product' }) {
    const p = this.product(productId), asset = this.asset(assetId); string(role, 'reference role', 80);
    fail(asset.kind === 'original', 'INVALID_INPUT', 'Product references must point to original images');
    fail(p.references.length < this.config.maxReferences, 'REFERENCE_LIMIT', 'Configured reference limit exceeded');
    fail(!p.references.some(r => r.assetId === assetId), 'REFERENCE_EXISTS', 'Reference already attached', 409);
    const refId = id();
    this.transaction(() => {
      this.run('INSERT INTO product_references VALUES(?,?,?,?,?)', refId,productId,assetId,role,(p.references.at(-1)?.position ?? -1) + 1);
      this.run('UPDATE products SET revision=revision+1 WHERE id=?', productId);
    });
    return this.product(productId);
  }
  updateReferences(productId, { references, expectedRevision }) {
    const p = this.product(productId); integer(expectedRevision, 'expectedRevision');
    fail(p.revision === expectedRevision, 'REVISION_CONFLICT', 'Product changed', 409);
    fail(Array.isArray(references) && references.length <= this.config.maxReferences, 'INVALID_INPUT', 'Invalid references');
    const seen = new Set();
    for (const r of references) {
      object(r); string(r.role, 'reference role', 80); this.asset(r.assetId);
      fail(p.references.some(old => old.id === r.id && old.assetId === r.assetId) && !seen.has(r.id), 'INVALID_INPUT', 'Reference IDs must belong to this product'); seen.add(r.id);
    }
    this.transaction(() => {
      this.run('DELETE FROM product_references WHERE product_id=?', productId);
      references.forEach((r, index) => this.run('INSERT INTO product_references VALUES(?,?,?,?,?)', r.id,productId,r.assetId,r.role,index));
      this.run('UPDATE products SET revision=revision+1 WHERE id=?', productId);
    });
    return this.product(productId);
  }
  removeReference(productId, refId) {
    const p = this.product(productId);
    fail(p.references.some(r => r.id === refId), 'NOT_FOUND', 'Reference not found', 404);
    return this.updateReferences(productId, { expectedRevision:p.revision, references:p.references.filter(r => r.id !== refId) });
  }
  submit(input, idempotencyKey) {
    object(input); string(idempotencyKey, 'Idempotency-Key', 200);
    const requestHash = hash(canonical(JSON.parse(json(input))));
    const existing = this.get('SELECT id,request_hash FROM tasks WHERE idempotency_key=?', idempotencyKey);
    if (existing) { fail(existing.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Key was used with another request', 409); return { task:this.task(existing.id), duplicate:true }; }
    const p = this.product(string(input.productId, 'productId'));
    integer(input.productRevision, 'productRevision');
    fail(input.productRevision === p.revision, 'REVISION_CONFLICT', 'Refresh product before submission', 409);
    fail(p.references.length > 0 && p.references.length <= this.config.maxReferences, 'INVALID_INPUT', 'Product reference count is invalid');
    fail(Array.isArray(input.slots) && input.slots.length > 0 && input.slots.length <= this.config.maxSlots, 'INVALID_INPUT', 'Invalid output slots');
    const slotKeys = new Set();
    for (const slot of input.slots) {
      object(slot); string(slot.key, 'slot key', 100); string(slot.type, 'slot type', 80);
      fail(!slotKeys.has(slot.key), 'INVALID_INPUT', 'Duplicate slot key'); slotKeys.add(slot.key);
      if (slot.size !== undefined) {
        object(slot.size); integer(slot.size.width, 'width'); integer(slot.size.height, 'height');
        fail(slot.size.width * slot.size.height <= this.config.maxPixels, 'INVALID_INPUT', 'Requested pixels exceed configured safeguard');
        if (this.config.allowedSizes) fail(this.config.allowedSizes.includes(`${slot.size.width}x${slot.size.height}`), 'INVALID_INPUT', 'Size not allowed by configured policy');
      }
    }
    const settings = object(input.settings ?? {}, 'settings');
    const platformRule = Object.hasOwn(this.config.platformRules, settings.platform) ? this.config.platformRules[settings.platform] : null;
    if (platformRule) for (const [key, values] of Object.entries(platformRule)) fail(values.includes(settings[key]), 'INVALID_INPUT', `Configured platform rule rejected ${key}`);
    const snapshot = { contractVersion:1, product:p, references:p.references.map(r => ({...r, asset:this.asset(r.assetId)})), settings, description:input.description ?? '', slots:input.slots, versions:input.versions ?? {} };
    fail(typeof snapshot.description === 'string' && snapshot.description.length <= 20000, 'INVALID_INPUT', 'Invalid description');
    object(snapshot.versions, 'versions');
    return this.enqueueSnapshot(snapshot,idempotencyKey,requestHash);
  }
  // Internal only: revisions reuse the immutable original product snapshot, not today's draft.
  enqueueSnapshot(snapshot,idempotencyKey,requestHash=hash(canonical(snapshot))) {
    const existing=this.get('SELECT id,request_hash FROM tasks WHERE idempotency_key=?',idempotencyKey);
    if(existing){fail(existing.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','Key was used with another request',409);return {task:this.task(existing.id),duplicate:true};}
    const p=snapshot.product;
    const policy = { maxAttempts:snapshot.settings.correction?1:this.config.maxAttempts, timeoutMs:this.config.timeoutMs, retryBaseMs:this.config.retryBaseMs, processor:this.processor };
    const taskId = id(), time = now();
    this.transaction(() => {
      this.run('INSERT INTO tasks(id,product_id,idempotency_key,request_hash,input_json,policy_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,\'queued\',?,?)', taskId,p.id,idempotencyKey,requestHash,json(snapshot),json(policy),time,time);
      snapshot.references.forEach(r => this.run('INSERT INTO task_assets VALUES(?,?)', taskId,r.assetId));
      // Server-owned prepared layouts stay pinned independently of product identity references.
      for(const l of snapshot.settings.workflow03A?.minimumMvp?.layouts??[])this.run('INSERT OR IGNORE INTO task_assets VALUES(?,?)',taskId,l.reference.assetId);
      snapshot.slots.forEach((slot, index) => this.run('INSERT INTO children(id,task_id,position,slot_json,state) VALUES(?,?,?,?,\'queued\')', id(),taskId,index,json(slot)));
      this.event(taskId, 'submitted', { count:snapshot.slots.length });
    });
    return { task:this.task(taskId), duplicate:false };
  }
  taskRow(taskId) { const t = this.get('SELECT * FROM tasks WHERE id=?', taskId); fail(t, 'NOT_FOUND', 'Task not found', 404); return t; }
  task(taskId) {
    const t = this.taskRow(taskId);
    const children = this.all('SELECT * FROM children WHERE task_id=? ORDER BY position', taskId).map(c => ({ id:c.id, taskId:c.task_id, position:c.position, slot:parse(c.slot_json), state:c.state, generation:c.generation, attemptCount:c.attempt_count, localReplayCount:this.get('SELECT COUNT(*) n FROM local_replays WHERE child_id=?',c.id).n, nextRunAt:c.next_run_at, stage:c.stage, error:parse(c.error_json),
      attempts:this.all('SELECT * FROM attempts WHERE child_id=? ORDER BY ordinal', c.id).map(a => ({ id:a.id, ordinal:a.ordinal, generation:a.generation, processorId:a.processor_id, state:a.state, startedAt:a.started_at, endedAt:a.ended_at, error:parse(a.error_json), receipt:parse(a.receipt_json) })),
      result:this.resultForChild(c.id) }));
    const counts = { total:children.length, succeeded:0, failed:0, canceled:0, running:0, queued:0 };
    children.forEach(c => counts[c.state]++);
    counts.completed = counts.succeeded + counts.failed + counts.canceled;
    const stage = ['succeeded','partial','failed','canceled'].includes(t.state) ? t.state : counts.running ? 'executing' : children.some(c => c.state === 'queued' && c.nextRunAt > now()) ? 'retry_wait' : 'queued';
    return { id:t.id, productId:t.product_id, state:t.state, revision:t.revision, input:parse(t.input_json), policy:parse(t.policy_json), createdAt:t.created_at, updatedAt:t.updated_at, progress:{stage,...counts}, children };
  }
  tasks() { return this.all('SELECT id FROM tasks ORDER BY created_at,id').map(t => this.task(t.id)); }
  resultForChild(childId) { const r = this.get('SELECT id FROM results WHERE child_id=?', childId); return r ? this.result(r.id) : null; }
  result(resultId) {
    const r = this.get('SELECT * FROM results WHERE id=?', resultId); fail(r, 'NOT_FOUND', 'Result not found', 404);
    return { id:r.id, taskId:r.task_id, childId:r.child_id, productId:r.product_id, versions:this.all('SELECT v.*,e.edit_key FROM result_versions v LEFT JOIN result_edit_receipts e ON e.result_id=v.result_id AND e.version=v.version WHERE v.result_id=? ORDER BY v.version', resultId).map(v => ({ version:v.version, assetId:v.asset_id, attemptId:v.attempt_id, previousVersion:v.previous_version, createdAt:v.created_at,...(v.edit_key?{editKey:v.edit_key}:{}) })) };
  }
  appendVersion(resultId, { assetId, expectedVersion }, editKey) {
    integer(expectedVersion, 'expectedVersion'); const r = this.result(resultId), a = this.asset(assetId);
    const requestHash=hash(canonical({assetHash:a.sha256,parentId:a.parentId,expectedVersion}));
    if(editKey!==undefined){
      string(editKey,'edit key',200);
      const prior=this.get('SELECT * FROM result_edit_receipts WHERE result_id=? AND edit_key=?',resultId,editKey);
      if(prior){fail(prior.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','Edited version payload changed',409);return r;}
    }
    fail(r.versions.at(-1).version === expectedVersion, 'REVISION_CONFLICT', 'Result has a newer version', 409);
    fail(a.kind === 'derived' && a.parentId === r.versions.at(-1).assetId, 'INVALID_INPUT', 'New version must derive from current result asset');
    this.transaction(() => {
      this.run('INSERT INTO result_versions VALUES(?,?,?,?,?,?)', resultId,expectedVersion+1,assetId,null,expectedVersion,now());
      if(editKey!==undefined)this.run('INSERT INTO result_edit_receipts VALUES(?,?,?,?)',resultId,editKey,requestHash,expectedVersion+1);
      this.event(r.taskId, 'result_version', { resultId, version:expectedVersion+1 });
    });
    return this.result(resultId);
  }
  refresh(taskId) {
    if (this.taskRow(taskId).state === 'canceled') return;
    const children = this.all('SELECT state,attempt_count FROM children WHERE task_id=?', taskId);
    const unfinished = children.some(c => ['queued','running'].includes(c.state));
    const successes = children.filter(c => c.state === 'succeeded').length;
    const state = unfinished ? children.some(c => c.attempt_count > 0) ? 'running' : 'queued' : successes === children.length ? 'succeeded' : successes ? 'partial' : 'failed';
    this.run('UPDATE tasks SET state=?,updated_at=? WHERE id=?', state,now(),taskId);
  }
  claim(processor) {
    return this.transaction(() => {
      const candidates = this.all(`SELECT c.*,t.policy_json,t.input_json,t.product_id FROM children c JOIN tasks t ON c.task_id=t.id
        WHERE c.state='queued' AND c.next_run_at<=? AND t.state IN ('queued','running')
        AND NOT EXISTS(SELECT 1 FROM children active WHERE active.task_id=t.id AND active.state='running')
        ORDER BY t.last_scheduled_at,t.created_at,t.id,c.position`, now());
      const c = candidates.find(row => canonical(parse(row.policy_json).processor) === canonical({ id:processor.id,version:processor.version,replaySafe:processor.replaySafe }));
      if (!c) return null;
      const policy = parse(c.policy_json); fail(c.attempt_count < policy.maxAttempts || this.get('SELECT 1 FROM local_replays WHERE child_id=? AND generation=?',c.id,c.generation), 'ATTEMPT_LIMIT', 'Attempt limit violated', 500);
      const attemptId = id(), time = now(), ordinal = c.attempt_count+1;
      this.run('INSERT INTO attempts(id,child_id,ordinal,generation,processor_id,replay_safe,state,started_at) VALUES(?,?,?,?,?,?,\'running\',?)', attemptId,c.id,ordinal,c.generation,processor.id,processor.replaySafe ? 1 : 0,time);
      this.run('UPDATE children SET state=\'running\',attempt_count=?,active_attempt=?,lease_until=?,stage=\'preparing\',error_json=NULL WHERE id=?', ordinal,attemptId,time+this.config.leaseMs,c.id);
      this.run('UPDATE tasks SET state=\'running\',last_scheduled_at=?,updated_at=? WHERE id=?', time,time,c.task_id);
      this.event(c.task_id, 'started', { childId:c.id, attemptId, ordinal });
      return { childId:c.id,taskId:c.task_id,productId:c.product_id,generation:c.generation,attemptId,ordinal,slot:parse(c.slot_json),input:parse(c.input_json),policy };
    });
  }
  active(claim) {
    return this.get(`SELECT c.id FROM children c JOIN tasks t ON c.task_id=t.id WHERE c.id=? AND c.state='running' AND c.active_attempt=? AND c.generation=? AND c.lease_until>=? AND t.state<>'canceled'`, claim.childId,claim.attemptId,claim.generation,now());
  }
  heartbeat(claim) { if (this.active(claim)) this.run('UPDATE children SET lease_until=? WHERE id=?', now()+this.config.leaseMs,claim.childId); }
  stage(claim, stage) {
    fail(['preparing','processing','persisting'].includes(stage), 'INVALID_INPUT', 'Unknown execution stage');
    if (!this.active(claim)) return false;
    this.transaction(() => { this.run('UPDATE children SET stage=? WHERE id=?', stage,claim.childId); this.event(claim.taskId, 'stage', {childId:claim.childId,stage}); });
    return true;
  }
  recordWorkflow(claim,workflow) {
    if(!this.active(claim))return false;
    object(workflow,'workflow');
    this.run('UPDATE attempts SET receipt_json=? WHERE id=?',json({workflow},'workflow trace',64*1024),claim.attemptId);
    return true;
  }
  complete(claim, output) {
    if (!this.active(claim)) return false;
    object(output, 'processor output');
    // A narrow receipt prevents accidentally storing full provider bodies or secrets.
    const receipt = {};
    if (output.requestId !== undefined) { string(output.requestId, 'requestId', 160); fail(/^[a-zA-Z0-9_.:-]+$/.test(output.requestId), 'INVALID_INPUT', 'Invalid request identifier'); receipt.requestId=output.requestId; }
    if (output.workflow) { object(output.workflow); receipt.workflow=JSON.parse(json(output.workflow,'workflow trace',64*1024)); }
    receipt.processorId = claim.policy.processor.id; receipt.processorVersion = claim.policy.processor.version;
    const correction=claim.input.settings.correction;
    const a = this.files.prepare(output.bytes, {kind:'derived',name:`result-${claim.slot.key.replace(/[^a-zA-Z0-9_-]/g,'_')}.png`,mediaType:output.mediaType,parentId:correction?.sourceAssetId??claim.input.references[0].assetId});
    try {
      if (claim.slot.size) fail(a.width === claim.slot.size.width && a.height === claim.slot.size.height, 'INVALID_IMAGE', 'Output size differs from requested slot');
      return this.transaction(() => {
        if (!this.active(claim)) { fs.unlinkSync(this.files.resolve(a.path)); return false; }
        if(correction) {
          const target=this.result(correction.resultId),head=target.versions.at(-1);
          fail(target.taskId===correction.sourceTaskId&&target.productId===claim.productId&&head.version===correction.expectedVersion&&head.assetId===correction.sourceAssetId,'INVALID_INPUT','Correction base version changed');
          fail(this.taskRow(target.taskId).state!=='canceled','INVALID_INPUT','Source task canceled');
        }
        this.insertAsset(a);
        const resultId = id();
        this.run('INSERT INTO results VALUES(?,?,?,?,?)', resultId,claim.taskId,claim.childId,claim.productId,now());
        // Each attempt is linked once: correction provenance belongs to the source's appended version.
        this.run('INSERT INTO result_versions VALUES(?,?,?,?,?,?)', resultId,1,a.id,correction?null:claim.attemptId,null,now());
        if(correction) {
          this.run('INSERT INTO result_versions VALUES(?,?,?,?,?,?)',correction.resultId,correction.expectedVersion+1,a.id,claim.attemptId,correction.expectedVersion,now());
          this.run('UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?',now(),correction.sourceTaskId);
          this.event(correction.sourceTaskId,'result_version',{resultId:correction.resultId,version:correction.expectedVersion+1,correctionTaskId:claim.taskId});
        }
        this.run('UPDATE attempts SET state=\'succeeded\',ended_at=?,receipt_json=? WHERE id=?', now(),json(receipt),claim.attemptId);
        this.run('UPDATE children SET state=\'succeeded\',stage=\'persisted\',active_attempt=NULL,lease_until=NULL,error_json=NULL WHERE id=?', claim.childId);
        this.event(claim.taskId, 'succeeded', {childId:claim.childId,resultId}); this.refresh(claim.taskId);
        return true;
      });
    } catch (error) { if (fs.existsSync(this.files.resolve(a.path))) fs.unlinkSync(this.files.resolve(a.path)); throw error; }
  }
  failAttempt(claim, error) {
    if (!this.active(claim)) return false;
    return this.transaction(() => {
      const retry = error.retryable && !error.outcomeUnknown && claim.ordinal < claim.policy.maxAttempts;
      const nextRunAt = retry ? now() + Math.min(claim.policy.retryBaseMs * 2 ** (claim.ordinal-1), 60_000) : 0;
      this.run('UPDATE attempts SET state=?,ended_at=?,error_json=? WHERE id=?', error.code === 'TIMEOUT' ? 'timed_out' : 'failed',now(),json(error),claim.attemptId);
      this.run('UPDATE children SET state=?,stage=?,active_attempt=NULL,lease_until=NULL,next_run_at=?,error_json=? WHERE id=?', retry ? 'queued' : 'failed',retry ? 'retry_wait' : 'failed',nextRunAt,json(error),claim.childId);
      this.event(claim.taskId, retry ? 'retry_scheduled' : 'failed', {childId:claim.childId,error,nextRunAt}); this.refresh(claim.taskId); return true;
    });
  }
  cancel(taskId) {
    const t = this.taskRow(taskId);
    if (t.state === 'canceled') return this.task(taskId);
    fail(['queued','running'].includes(t.state), 'TASK_TERMINAL', 'Finished task cannot be canceled', 409);
    this.transaction(() => {
      for (const c of this.all('SELECT * FROM children WHERE task_id=? AND state IN (\'queued\',\'running\')', taskId)) {
        if (c.active_attempt) this.run('UPDATE attempts SET state=\'canceled\',ended_at=?,error_json=? WHERE id=?', now(),json({code:'CANCELED',outcomeUnknown:true}),c.active_attempt);
        this.run('UPDATE children SET state=\'canceled\',stage=\'canceled\',generation=generation+1,active_attempt=NULL,lease_until=NULL WHERE id=?', c.id);
      }
      this.run('UPDATE tasks SET state=\'canceled\',revision=revision+1,updated_at=? WHERE id=?', now(),taskId);
      this.event(taskId, 'canceled', {upstreamCancellationConfirmed:false});
    });
    return this.task(taskId);
  }
  retry(taskId, { childIds, expectedRevision }, beforeEnqueue = () => {}, { localOnly = false } = {}) {
    const t = this.taskRow(taskId); integer(expectedRevision, 'expectedRevision');
    fail(t.revision === expectedRevision, 'REVISION_CONFLICT', 'Task changed', 409);
    fail(['failed','partial'].includes(t.state), 'TASK_NOT_RETRYABLE', 'Only failed/partial tasks support selected retries', 409);
    fail(Array.isArray(childIds) && childIds.length > 0 && new Set(childIds).size === childIds.length, 'INVALID_INPUT', 'Select unique failed children');
    const policy = parse(t.policy_json);
    const targets = childIds.map(childId => {
      const c = this.get('SELECT * FROM children WHERE id=? AND task_id=?', childId,taskId);
      fail(c?.state === 'failed' && !parse(c.error_json)?.outcomeUnknown && (localOnly ? this.get('SELECT COUNT(*) n FROM local_replays WHERE child_id=?',c.id).n < 3 : c.attempt_count < policy.maxAttempts), 'TASK_NOT_RETRYABLE', 'Child exhausted, successful, canceled, or outcome unknown', 409); return c;
    });
    this.transaction(() => {
      if(localOnly)for(const c of targets)this.run('INSERT INTO local_replays VALUES(?,?,?)',c.id,c.generation+1,now());
      beforeEnqueue(targets);
      targets.forEach(c => this.run('UPDATE children SET state=\'queued\',stage=\'queued\',generation=generation+1,next_run_at=0,error_json=NULL WHERE id=?', c.id));
      this.run('UPDATE tasks SET revision=revision+1 WHERE id=?', taskId);
      this.event(taskId, 'manual_retry', {childIds,...(localOnly?{localOnly:true}:{})}); this.refresh(taskId);
    });
    return this.task(taskId);
  }
  recover({ all = false } = {}) {
    // all=true is only called at executor startup under this store's exclusive writer lock.
    return this.transaction(() => {
      const rows = this.all(`SELECT c.*,t.policy_json,a.replay_safe FROM children c JOIN tasks t ON c.task_id=t.id JOIN attempts a ON c.active_attempt=a.id WHERE c.state='running' AND (?=1 OR c.lease_until<?)`, all ? 1 : 0,now());
      for (const c of rows) {
        const policy = parse(c.policy_json);
        const error = {code:c.replay_safe ? 'INTERRUPTED' : 'OUTCOME_UNKNOWN',retryable:!!c.replay_safe,outcomeUnknown:!c.replay_safe};
        const retry = !!c.replay_safe && c.attempt_count < policy.maxAttempts;
        this.run('UPDATE attempts SET state=\'interrupted\',ended_at=?,error_json=? WHERE id=?', now(),json(error),c.active_attempt);
        this.run('UPDATE children SET state=?,stage=?,generation=generation+1,active_attempt=NULL,lease_until=NULL,next_run_at=0,error_json=? WHERE id=?', retry ? 'queued' : 'failed',retry ? 'queued' : 'failed',json(error),c.id);
        this.event(c.task_id, 'recovered', {childId:c.id,error,requeued:retry}); this.refresh(c.task_id);
      }
      return rows.length;
    });
  }
}
