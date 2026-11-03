import {snapshot, requireValue, unique, compareText, integer} from './value.js';
import {projectTask} from './stage2-adapter.js';
import {batchItem} from './batch.js';

export function checkedTasks(batch, tasks) {
  unique(tasks.map(t => t.itemId), 'projected item'); unique(tasks.map(t => t.taskId), 'projected task');
  for (const task of tasks) {
    const item = batchItem(batch, task.itemId);
    requireValue(task.batchId === batch.id && task.productId === item.productId, 'TASK_OWNERSHIP', 'Projection is from another batch/product');
  }
  return new Map(tasks.map(t => [t.itemId, t]));
}

export function aggregateBatch(batch, tasks = []) {
  const byItem = checkedTasks(batch, tasks);
  const progress = {total: 0, notSubmitted: 0, queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0, unknown: 0, completed: 0, available: 0};
  const items = batch.items.map(item => {
    const task = byItem.get(item.id);
    progress.total += item.slots.length;
    if (!task) progress.notSubmitted += item.slots.length;
    else for (const key of ['queued', 'running', 'succeeded', 'failed', 'canceled', 'unknown', 'completed', 'available']) progress[key] += task.progress[key];
    return {itemId: item.id, productId: item.productId, taskId: task?.taskId ?? null, state: task?.state ?? 'not_submitted'};
  });
  let state;
  if (items.some(i => i.state === 'unknown') || progress.unknown) state = 'unknown';
  else if (items.some(i => i.state === 'running')) state = 'running';
  else if (items.some(i => i.state === 'queued')) state = 'queued';
  else if (progress.notSubmitted) state = 'not_submitted';
  else if (items.every(i => i.state === 'canceled')) state = 'canceled';
  else if (items.every(i => i.state === 'succeeded')) state = 'succeeded';
  else if (progress.succeeded) state = 'partial';
  else state = 'failed';
  progress.percent = Math.floor(100 * progress.completed / progress.total);
  return snapshot({batchId: batch.id, state, progress, items, results: sortedResults(batch, tasks),
    issues: tasks.flatMap(t => t.issues.map(issue => ({itemId: t.itemId, ...issue})))});
}

// Stable order follows the frozen product/slot plan, never response arrival time.
export function sortedResults(batch, tasks) {
  const byItem = checkedTasks(batch, tasks);
  return snapshot(batch.items.flatMap(item => (byItem.get(item.id)?.children ?? []).filter(c => c.result?.available)
    .sort((a, b) => a.position - b.position).map(child => ({
      batchId: batch.id, itemId: item.id, productId: item.productId, productName: item.product.name,
      itemPosition: item.position, taskId: byItem.get(item.id).taskId, childId: child.id,
      slotKey: child.slotKey, position: child.position, type: child.type, index: child.index, ...child.result
    }))));
}

// readSequence is allocated when issuing each full-task read, not when it resolves.
// Backend revision does not change on every completion or edit, so it is insufficient alone.
export function applyTaskObservation(history, batch, binding, {task, assets = [], readSequence}) {
  integer(readSequence, 'read sequence', 1);
  requireValue(binding.taskId === task.id && binding.batchId === batch.id, 'TASK_OWNERSHIP', 'Observation binding mismatch');
  const old = history.find(h => h.taskId === task.id);
  if (old) {
    requireValue(old.batchId === batch.id && old.itemId === binding.itemId, 'TASK_OWNERSHIP', 'History task already belongs to another batch item');
    if (readSequence <= old.readSequence || task.revision < old.revision) return snapshot(history);
  }
  requireValue(!history.some(h => h.batchId === batch.id && h.itemId === binding.itemId && h.taskId !== task.id),
    'TASK_REBOUND', 'A frozen item cannot be rebound to another task');
  const next = projectTask(batch, binding, task, assets);
  if (old) requireValue(next.children.every(c => old.children.some(p => p.slotKey === c.slotKey && p.id === c.id &&
    (!p.result || !c.result || p.result.id === c.result.id))), 'CHILD_MISMATCH', 'Task changed stable child/result identities');
  if (old && next.revision === old.revision) {
    const terminal = ['succeeded', 'partial', 'failed', 'canceled'];
    if ((terminal.includes(old.state) && next.state !== old.state) ||
      next.children.some(c => {
        const previous = old.children.find(p => p.id === c.id);
        return previous && (c.generation < previous.generation || c.attemptCount < previous.attemptCount ||
          (previous.result && (!c.result || c.result.version < previous.result.version ||
            (c.result.version === previous.result.version && c.result.assetId !== previous.result.assetId))) ||
          (terminal.includes(previous.state) && ['queued', 'running'].includes(c.state) && c.generation === previous.generation));
      })) return snapshot(history);
  }
  return snapshot([...history.filter(h => h.taskId !== task.id), {...next, readSequence}]);
}

export function listHistory(history, {state = 'all', search = '', batchId = null} = {}) {
  const query = search.trim().toLocaleLowerCase();
  return snapshot(history.filter(t => (state === 'all' || t.state === state) && (!batchId || t.batchId === batchId) &&
    (!query || [t.productName, t.productId, t.taskId].some(s => s.toLocaleLowerCase().includes(query))))
    .sort((a, b) => b.createdAt - a.createdAt || compareText(a.taskId, b.taskId)));
}
