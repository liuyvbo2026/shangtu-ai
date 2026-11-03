import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { crc32 } from '../../backend/files.mjs';
import { ProcessorError } from '../../backend/core.mjs';

export const TEST_CONTRACT = Object.freeze({ id:'deterministic-test-only',version:'1',replaySafe:true });
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header,body,checksum]);
}
export function fixturePNG(seed = 'test-only') {
  const rgb = createHash('sha256').update(seed).digest().subarray(0,3);
  const header = Buffer.alloc(13); header.writeUInt32BE(1,0); header.writeUInt32BE(1,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat([Buffer.from([0]),rgb]))),chunk('IEND',Buffer.alloc(0))]);
}
function delay(ms, signal, ignoreAbort) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ProcessorError('CANCELED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (!ignoreAbort) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once:true}); }
  });
}
/** Never imported by the normal server. Tests inject scripts; input cannot select behavior. */
export function testProcessor(script = {}) {
  return { ...TEST_CONTRACT, async execute(request) {
    const behavior = script[request.slot.key] ?? {};
    request.reportStage('processing');
    // Read every reference through the scope-limited capability, verify ownership in tests.
    const sources = request.inputSnapshot.references.map(r => request.readAsset(r.assetId));
    if (behavior.delayMs) await delay(behavior.delayMs,request.signal,behavior.ignoreAbort);
    if (behavior.failAlways || request.attempt.ordinal <= (behavior.failFirst ?? 0)) {
      throw new ProcessorError(behavior.code ?? 'TRANSIENT', {retryable:behavior.retryable ?? true,outcomeUnknown:behavior.outcomeUnknown ?? false});
    }
    return {bytes:fixturePNG(`${request.inputSnapshot.product.id}/${request.slot.key}/${sources.map(b => b.toString('hex')).join('/')}`),mediaType:'image/png',requestId:`test-${request.idempotencyKey}`};
  }};
}
