import { EXTRA_PING_ID_PATTERN, normalizeExtraProbes, mergeExtraProbeMetrics } from './extraPing.js';

export const LEGACY_LATENCY_SLOTS = ['custom_ct', 'custom_cu', 'custom_cm', 'custom_bd', 'node_1', 'node_2', 'node_3', 'node_4'];
export const legacyMetricSuffix = field => field.startsWith('custom_') ? field.slice(7) : field;
export const latencyTaskAssigned = (task, nodeId, document) => task.nodes.includes(nodeId) || (task.auto_join && document.seen_nodes && !document.seen_nodes.includes(nodeId));

// Apply only the editor's delta; unrelated concurrent assignments remain intact.
export function mergeLatencyAssignments(current, chosen, base) {
  const next = new Set(current);
  for (const id of base) if (!chosen.includes(id)) next.delete(id);
  for (const id of chosen) if (!base.includes(id)) next.add(id);
  return [...next];
}

export function validateLatencyTask(value, validateTarget, nodeIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.name !== 'string' || !value.name.trim() || new TextEncoder().encode(value.name).length > 128 || /[\x00-\x1f]/.test(value.name) ||
    typeof value.target !== 'string' || !value.target.trim() || !validateTarget(value.target).valid ||
    !Number.isInteger(value.interval) || value.interval < 5 || value.interval > 3600 ||
    typeof value.auto_join !== 'boolean' || !Array.isArray(value.nodes) ||
    value.nodes.some(id => typeof id !== 'string' || !nodeIds.includes(id)) || new Set(value.nodes).size !== value.nodes.length ||
    (value.id !== undefined && !EXTRA_PING_ID_PATTERN.test(value.id)) ||
    (value.metric_id !== undefined && !EXTRA_PING_ID_PATTERN.test(value.metric_id))) return false;
  return true;
}

export function validateLatencyBackup(document, validateTarget) {
  return !!document && document.version === 1 && Array.isArray(document.tasks) &&
    new Set(document.tasks.map(task => task.id)).size === document.tasks.length &&
    new Set(document.tasks.map(task => task.metric_id || task.id)).size === document.tasks.length &&
    document.tasks.every(task => task.id && validateLatencyTask(task, validateTarget, task.nodes || []));
}

export function publicLatencyNodes(document, nodeId = null) {
  return document.tasks.filter(task => nodeId === null || latencyTaskAssigned(task, nodeId, document)).map(task => ({ id: task.metric_id || task.id, name: task.name }));
}

export function projectLatencyMetrics(metrics, tasks, nodeId, legacyConfigMatches = false, document = null) {
  const assigned = tasks.filter(task => document ? latencyTaskAssigned(task, nodeId, document) : task.nodes.includes(nodeId));
  const ids = new Set(assigned.map(task => task.metric_id || task.id));
  const extra = Object.fromEntries(Object.entries(metrics.extra_probes || {}).filter(([id]) => ids.has(id)));
  if (legacyConfigMatches) {
    const slots = new Set();
    for (const task of assigned) {
      if (!task.legacy_slot || slots.has(task.legacy_slot)) continue;
      slots.add(task.legacy_slot);
      const suffix = legacyMetricSuffix(task.legacy_slot);
      if (Object.hasOwn(metrics, `loss_${suffix}`)) extra[task.metric_id || task.id] = { ping: metrics[`ping_${suffix}`] ?? null, loss: metrics[`loss_${suffix}`] };
    }
  }
  metrics.extra_probes = extra;
  metrics.extra_ping_nodes = assigned.map(task => ({ id: task.metric_id || task.id, name: task.name }));
  metrics.latency_tasks_active = true;
  return metrics;
}

export function withLegacyLatencyHistory(row, nodeId, document) {
  if (!row || !document) return row;
  const result = { ...row }, probes = { ...(normalizeExtraProbes(row.extra_probes || {}) || {}) };
  const active = new Set(document.tasks.map(task => task.metric_id || task.id));
  for (const source of document.sources || []) {
    if (source.extra || source.node !== nodeId || !active.has(source.id) || Number(row.timestamp) > source.before) continue;
    const suffix = legacyMetricSuffix(source.slot);
    if (Object.hasOwn(row, `loss_${suffix}`) && !Object.hasOwn(probes, source.id)) {
      const normalized = normalizeExtraProbes({ [source.id]: { ping: row[`ping_${suffix}`] ?? null, loss: row[`loss_${suffix}`] } });
      if (normalized) Object.assign(probes, normalized);
    }
  }
  mergeExtraProbeMetrics(result, probes);
  return result;
}
