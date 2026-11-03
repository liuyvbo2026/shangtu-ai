import { createHash, randomUUID } from 'node:crypto';

export class Fault extends Error {
  constructor(code, message, status = 400, details) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}
export const fail = (condition, code, message, status = 400) => {
  if (!condition) throw new Fault(code, message, status);
};
export const id = () => randomUUID();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const now = () => Date.now();
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function object(value, label = 'input') {
  fail(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', `${label} must be an object`);
  return value;
}
export function string(value, label, max = 1000) {
  fail(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value), 'INVALID_INPUT', `Invalid ${label}`);
  return value;
}
export function integer(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  fail(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', `Invalid ${label}`);
  return value;
}
export function json(value, label = 'JSON', max = 256 * 1024) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Fault('INVALID_INPUT', `Invalid ${label}`); }
  fail(typeof encoded === 'string' && Buffer.byteLength(encoded) <= max, 'INVALID_INPUT', `${label} is too large or invalid`);
  return encoded;
}

// Operational safeguards, NOT original-site product rules or verified Flash limits.
export function configuration(overrides = {}) {
  const c = {
    maxReferences: 32, maxSlots: 100, maxAssetBytes: 20 * 1024 * 1024,
    maxPixels: 40_000_000, allowedMediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
    allowedSizes: null, platformRules: {}, maxAttempts: 3, timeoutMs: 30_000,
    retryBaseMs: 100, concurrency: 2, leaseMs: 60_000, pollMs: 50,
    ...overrides
  };
  for (const k of ['maxReferences','maxSlots','maxAssetBytes','maxPixels','maxAttempts','timeoutMs','retryBaseMs','concurrency','leaseMs','pollMs']) integer(c[k], k);
  fail(c.leaseMs >= 100, 'INVALID_CONFIG', 'leaseMs must be >=100');
  fail(c.pollMs * 3 <= c.leaseMs, 'INVALID_CONFIG', 'Polling must be at least three times per lease');
  fail(Array.isArray(c.allowedMediaTypes) && c.allowedMediaTypes.every(t => ['image/png','image/jpeg','image/webp'].includes(t)), 'INVALID_CONFIG', 'Unsupported media type');
  if (c.allowedSizes !== null) fail(Array.isArray(c.allowedSizes) && c.allowedSizes.every(v => /^\d+x\d+$/.test(v)), 'INVALID_CONFIG', 'Invalid sizes');
  object(c.platformRules, 'platformRules');
  return structuredClone(c);
}

export class ProcessorError extends Error {
  constructor(code, { retryable = false, outcomeUnknown = false } = {}) {
    super(code); this.code = code; this.retryable = retryable; this.outcomeUnknown = outcomeUnknown;
  }
}
// Never persist raw provider exceptions, response bodies, headers or credentials.
export function classify(error, replaySafe = false) {
  const known = new Set(['TRANSIENT','RATE_LIMIT','INVALID_REQUEST','AUTH','REJECTED','TIMEOUT','CANCELED','OUTPUT_INVALID','OUTCOME_UNKNOWN']);
  const code = error instanceof ProcessorError && known.has(error.code) ? error.code : 'INTERNAL';
  const outcomeUnknown = !!error.outcomeUnknown || (['TIMEOUT','INTERNAL'].includes(code) && !replaySafe);
  return { code, retryable: !outcomeUnknown && error instanceof ProcessorError && !!error.retryable && ['TRANSIENT','RATE_LIMIT','TIMEOUT'].includes(code), outcomeUnknown };
}
