// Browser/Node shared JSON boundary. No storage, timers, network or generated IDs.
export class BatchError extends Error {
  constructor(code, message) { super(message); this.name = 'BatchError'; this.code = code; }
}
export function requireValue(condition, code, message) {
  if (!condition) throw new BatchError(code, message);
}
export const record = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function cloneJSON(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  requireValue((Array.isArray(value) || record(value)) && !ancestors.has(value), 'INVALID_JSON', 'Expected finite, acyclic JSON data; undefined is not an override.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = Array.from(value, item => cloneJSON(item, ancestors));
  } else {
    result = {};
    for (const key of Object.keys(value)) {
      requireValue(!forbidden.has(key), 'INVALID_KEY', `Unsafe key: ${key}`);
      result[key] = cloneJSON(value[key], ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}
export function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const snapshot = value => freeze(cloneJSON(value));
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const same = (a, b) => canonical(a) === canonical(b);
export function identifier(value, label) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value), 'INVALID_ID', `Invalid ${label}`);
  return value;
}
export function integer(value, label, min = 0) {
  requireValue(Number.isSafeInteger(value) && value >= min, 'INVALID_NUMBER', `Invalid ${label}`);
  return value;
}
export function unique(values, label) {
  requireValue(new Set(values).size === values.length, 'DUPLICATE_ID', `Duplicate ${label}`);
}
export function pathParts(path) {
  const parts = typeof path === 'string' ? path.split('.') : path;
  requireValue(Array.isArray(parts) && parts.length > 0 && parts.every(p => typeof p === 'string' && p && !forbidden.has(p)), 'INVALID_PATH', 'Invalid override path');
  return parts;
}
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
