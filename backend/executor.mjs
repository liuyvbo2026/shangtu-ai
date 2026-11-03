import { classify, fail, ProcessorError } from './core.mjs';

export class Executor {
  constructor(store, processor) {
    this.store = store; this.processor = processor; this.running = new Map();
    this.timer = null; this.stopping = false; this.fatal = null;
    fail(typeof processor.execute === 'function' && typeof processor.replaySafe === 'boolean', 'INVALID_PROCESSOR', 'Invalid processor contract');
  }
  start() {
    fail(!this.store.executor, 'EXECUTOR_ACTIVE', 'Only one executor per store', 409);
    this.store.executor = this; this.stopping = false;
    try { this.store.recover({all:true}); }
    catch (error) { this.store.executor = null; throw error; }
    this.timer = setInterval(() => this.tick(), this.store.config.pollMs);
    this.tick(); return this;
  }
  tick() {
    if (this.fatal) return;
    try {
      this.store.recover();
      for (const {claim,controller} of this.running.values()) {
        if (!this.store.active(claim)) controller.abort();
        else this.store.heartbeat(claim);
      }
      if (this.stopping || this.processor.canSchedule?.()===false) return;
      while (this.running.size < this.store.config.concurrency) {
        const claim = this.store.claim(this.processor);
        if (!claim) break;
        const controller = new AbortController(), entry = {claim,controller,promise:null};
        this.running.set(claim.attemptId, entry);
        entry.promise = this.execute(claim, controller).catch(() => {
          // A persistence failure stops new scheduling. Do not turn lost durable writes into success.
          this.fatal = 'EXECUTOR_PERSISTENCE_FAILURE'; this.stopping = true; clearInterval(this.timer);
        }).finally(() => { this.running.delete(claim.attemptId); if (!this.stopping) this.tick(); });
      }
    } catch { this.fatal = 'EXECUTOR_PERSISTENCE_FAILURE'; this.stopping = true; clearInterval(this.timer); }
  }
  async execute(claim, controller) {
    let timer, abortHandler;
    const canceled = new Promise((_, reject) => {
      abortHandler = () => reject(new ProcessorError('CANCELED'));
      controller.signal.addEventListener('abort', abortHandler, {once:true});
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new ProcessorError('TIMEOUT', {retryable:this.processor.replaySafe,outcomeUnknown:!this.processor.replaySafe}));
        controller.abort();
      }, claim.policy.timeoutMs);
    });
    try {
      const work = Promise.resolve().then(() => this.processor.execute({
        taskId:claim.taskId, childId:claim.childId, inputSnapshot:structuredClone(claim.input), slot:structuredClone(claim.slot),
        attempt:{id:claim.attemptId,ordinal:claim.ordinal,generation:claim.generation},
        // Stable across retries: provider adapters must evaluate their actual idempotency support.
        idempotencyKey:claim.childId, signal:controller.signal,
        reportStage:stage => this.store.stage(claim, stage),
        recordWorkflow:workflow => this.store.recordWorkflow(claim,workflow),
        readAsset:assetId => {
          fail(claim.input.references.some(r => r.assetId === assetId)||(claim.input.settings.workflow03A?.minimumMvp?.layouts??[]).some(l=>l.reference.assetId===assetId), 'ASSET_SCOPE', 'Processor may only read this snapshot reference', 403);
          return this.store.readAsset(assetId);
        }
      }));
      const output = await Promise.race([work,timeout,canceled]);
      if (this.store.active(claim)) {
        this.store.stage(claim, 'persisting');
        try { this.store.complete(claim, output); }
        catch (error) {
          if (['INVALID_IMAGE','INVALID_INPUT'].includes(error.code)) throw new ProcessorError('OUTPUT_INVALID');
          throw error;
        }
      }
      // A processor that ignores AbortSignal can still finish upstream. Its return is detached
      // by Promise.race and cannot publish; there is no claim here of upstream cancellation.
    } catch (error) {
      if (this.store.active(claim)) this.store.failAttempt(claim, classify(error, this.processor.replaySafe));
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abortHandler);
    }
  }
  cancel(taskId) {
    const result = this.store.cancel(taskId);
    for (const {claim,controller} of this.running.values()) if (claim.taskId === taskId) controller.abort();
    return result;
  }
  async stop() {
    this.stopping = true;
    // Drain already-started attempts with their persisted timeout. No later child is scheduled.
    await Promise.all([...this.running.values()].map(x => x.promise));
    clearInterval(this.timer);
    this.store.executor = null;
  }
}
