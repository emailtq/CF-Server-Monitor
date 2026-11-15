// Bound bytes at the trust boundary, not the number of targets.
export const EXTRA_PING_MAX_BYTES = 64 * 1024;
export const EXTRA_PROBE_MAX_BYTES = 128 * 1024;
export const EXTRA_PING_ID_PATTERN = /^p_[a-zA-Z0-9_-]{1,64}$/;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

export function validateExtraPingNodes(value, validateTarget) {
  if (!Array.isArray(value)) return { valid: false };
  if (bytes(value) > EXTRA_PING_MAX_BYTES) return { valid: false, error: 'too_large' };
  const ids = new Set();
  const nodes = [];
  for (const node of value) {
    if (!node || typeof node !== 'object' || Array.isArray(node) ||
      Object.keys(node).some(key => !['id', 'name', 'target'].includes(key)) ||
      typeof node.id !== 'string' || !EXTRA_PING_ID_PATTERN.test(node.id) || ids.has(node.id) ||
      typeof node.name !== 'string' || new TextEncoder().encode(node.name).length > 128 || /[\x00-\x1f]/.test(node.name) ||
      typeof node.target !== 'string') return { valid: false, field: node?.id };
    const target = validateTarget(node.target);
    if (!target.valid) return { valid: false, field: node.id };
    ids.add(node.id);
    nodes.push({ id: node.id, name: node.name.trim(), target: target.value });
  }
  return { valid: true, value: nodes };
}

export function publicExtraPingNodes(value) {
  return Array.isArray(value) ? value.filter(node => node && EXTRA_PING_ID_PATTERN.test(node.id))
    .map(({ id, name }) => ({ id, name: String(name || '') })) : [];
}

export function normalizeExtraProbes(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || bytes(value) > EXTRA_PROBE_MAX_BYTES) return null;
  const result = {};
  for (const [id, probe] of Object.entries(value)) {
    if (!EXTRA_PING_ID_PATTERN.test(id) || !probe || typeof probe !== 'object' || Array.isArray(probe) ||
      Object.keys(probe).some(key => !['ping', 'loss'].includes(key))) return null;
    const metric = (v, loss) => {
      if (v === false || v === 'false') return false;
      if (v === null || v === 'null') return null;
      if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+(?:\.\d+)?$/.test(v))) return undefined;
      const number = Number(v);
      return Number.isFinite(number) && number >= 0 && (loss ? number <= 100 : number <= 2147483647) ? number : undefined;
    };
    const ping = metric(probe.ping, false), loss = metric(probe.loss, true);
    if (ping === undefined || loss === undefined || (ping === false) !== (loss === false)) return null;
    result[id] = { ping: ping === 0 ? null : ping, loss };
  }
  return result;
}

export function extraProbeFields(probes) {
  return Object.fromEntries(Object.entries(probes || {}).filter(([, probe]) => probe.loss !== null).flatMap(([id, { ping, loss }]) => [
    [`ping_extra_${id}`, ping], [`loss_extra_${id}`, loss]
  ]));
}

export function mergeExtraProbeMetrics(target, probes) {
  for (const field of Object.keys(target)) {
    if (/^(ping|loss)_extra_/.test(field)) delete target[field];
  }
  target.extra_probes = probes;
  Object.assign(target, extraProbeFields(probes));
}

export function extraPingDefinitions(nodes) {
  return publicExtraPingNodes(nodes).map(({ id, name }) => ({
    key: `extra_${id}`, field: `ping_extra_${id}`, pingField: `ping_extra_${id}`,
    lossField: `loss_extra_${id}`, label: name || id, fallbackLabel: name || id
  }));
}
