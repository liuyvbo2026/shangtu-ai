import {createHash} from 'node:crypto';

export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value && typeof value==='object' ? `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const byteDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export function freeze(value) {
  if (value && typeof value==='object' && !ArrayBuffer.isView(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
export const snapshot = value => freeze(structuredClone(value));
export class WorkflowError extends Error {
  constructor(code, issues = [], {retryable=false,outcomeUnknown=false} = {}) {
    super(code); this.code=code; this.issues=issues; this.retryable=retryable; this.outcomeUnknown=outcomeUnknown;
  }
}
export function requireValid(issues, code='INVALID_INPUT') { if (issues.length) throw new WorkflowError(code,issues); }
export function ensure(condition, code) { if (!condition) throw new WorkflowError(code); }
export const issue = (code,path,message) => ({code,path,message});
export function duplicates(values,path) {
  return new Set(values).size===values.length ? [] : [issue('DUPLICATE',path,'Duplicate identifiers or selections')];
}
