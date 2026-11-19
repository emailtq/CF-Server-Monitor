import { buildSparseHistoryQuery } from '../database/historySampling.js';
import { getHistoryIdRange, getServerHistoryInfo } from '../database/indexOptimization.js';
import { readLatencyTaskDocument } from '../database/latencyTasks.js';
import { MONITOR_COMPAT_VISIBLE } from '../database/monitorCompatIds.js';
import { EXTRA_PING_ID_PATTERN, normalizeExtraProbes, publicExtraPingNodes } from '../shared/extraPing.js';
import { LEGACY_LATENCY_SLOTS, legacyMetricSuffix, publicLatencyNodes, withLegacyLatencyHistory } from '../shared/latencyTasks.js';
import { getMetricsHistoryCache, setMetricsHistoryCache } from '../utils/cache.js';
import { PROBE_METRIC_FIELDS } from '../utils/historyFields.js';

const HOUR_MS = 3_600_000;
const MIB = 1024 ** 2;
const MAX_POINTS = 240;
const HISTORY_SLOTS = 4;
const CACHE_MS = 30_000;
const CACHE_RESULT_LIMIT = 64 * 1024;
const RESOURCE_COLUMNS = ['cpu', 'ram_used', 'disk_used', 'net_in_speed', 'net_out_speed'];
const PING_COLUMNS = ['extra_probes', ...PROBE_METRIC_FIELDS];
const LEGACY_LABELS = ['电信', '联通', '移动', 'BGP', 'Node 1', 'Node 2', 'Node 3', 'Node 4'];
const databases = new WeakMap();
let nextDatabaseId = 0;
let pendingHistory = 0;

function integerParam(query, key, fallback, min, max) {
  const values = query.getAll(key);
  if (!values.length) return fallback;
  const number = Number(values[0]);
  if (values.length !== 1 || !/^[+-]?\d+$/.test(values[0]) || !Number.isSafeInteger(number)) return null;
  return Math.min(max, Math.max(min, number));
}

async function sampleHistory(db, server, hours, step, columns) {
  const { partitionId, startTimestamp } = await getServerHistoryInfo(db, server.id, server);
  if (!partitionId) throw new Error('Monitor history partition unavailable');
  const now = Date.now();
  const queryEnd = Math.floor(now / 1000) * 1000 + 1000;
  const queryStart = Math.max(queryEnd - hours * HOUR_MS, startTimestamp);
  if (queryStart >= queryEnd) return [];

  if (!databases.has(db)) databases.set(db, ++nextDatabaseId);
  const cacheKey = `monitor:${databases.get(db)}:${server.id}:${partitionId}:${startTimestamp}`;
  const cached = getMetricsHistoryCache(cacheKey, hours, columns, step);
  if (cached && now - cached.timestamp >= 0 && now - cached.timestamp < CACHE_MS) {
    return cached.data.filter(row => row.timestamp >= queryStart && row.timestamp < queryEnd);
  }

  const sunday = new Date(now);
  sunday.setUTCHours(0, 0, 0, 0);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  const tableBoundary = sunday.getTime();
  const oldTableExists = queryStart < tableBoundary && !!await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_history_old'"
  ).first();
  const intervalMs = step * 1000;
  const { sql, bindValues } = buildSparseHistoryQuery({
    columns, queryStart, queryEnd, firstRangeEnd: Math.min(queryEnd, queryStart + intervalMs),
    intervalMs, idPrefix: getHistoryIdRange(partitionId).startId,
    oldTableExists, tableBoundary, serverId: server.id
  });
  const { success, results } = await db.prepare(sql).bind(...bindValues).all();
  if (!success) throw new Error('Monitor history unavailable');
  let size = 0;
  const rows = [];
  for (const { sample_json } of results) {
    if (!sample_json) continue;
    size += sample_json.length;
    const row = JSON.parse(sample_json);
    if (row.timestamp >= queryStart && row.timestamp < queryEnd) rows.push(row);
  }
  if (size <= CACHE_RESULT_LIMIT) setMetricsHistoryCache(cacheKey, hours, columns, rows, step);
  return rows;
}

async function readLegacyLabels(db) {
  const keys = [...LEGACY_LATENCY_SLOTS.map(slot => `${slot}_name`), 'extra_ping_nodes'];
  // Ask for only the legacy label settings; strip the targets from the extra-probe catalog below.
  const { success, results } = await db.prepare(`
    SELECT keys.value AS key, site.value -> ('$.' || keys.value) AS grouped, flat.value AS legacy
    FROM json_each(?) AS keys
    LEFT JOIN settings AS site ON site.key = 'site_options'
    LEFT JOIN settings AS flat ON flat.key = keys.value
  `).bind(JSON.stringify(keys)).all();
  if (!success) throw new Error('Monitor probe labels unavailable');
  const labels = Object.fromEntries(results.map(({ key, grouped, legacy }) => [key,
    grouped != null ? JSON.parse(grouped) : key === 'extra_ping_nodes' && legacy != null ? JSON.parse(legacy) : legacy
  ]));
  return [
    ...LEGACY_LATENCY_SLOTS.map((slot, index) => ({
      id: slot, taskId: index + 1, slot: legacyMetricSuffix(slot), name: labels[`${slot}_name`] || LEGACY_LABELS[index]
    })),
    ...publicExtraPingNodes(labels.extra_ping_nodes)
  ];
}

// Reserve 1–8 for legacy slots. An immutable CF metric generation maps to the same safe integer in every window.
function numericTaskId(id) {
  let hash = 0xcbf29ce484222325n;
  for (const char of id) hash = BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 0x100000001b3n);
  return 9 + Number(hash % (BigInt(Number.MAX_SAFE_INTEGER) - 8n));
}

function projectResources(rows) {
  return rows.flatMap(row => {
    if (!RESOURCE_COLUMNS.every(key => Number.isFinite(row[key]) && row[key] >= 0)) return [];
    // These are persisted CF samples (rates may be aggregation maxima), not Monitor mean/peak pairs.
    return [{ ts: Math.floor(row.timestamp / 1000), cpu: row.cpu,
      mem_used: Math.round(row.ram_used * MIB), disk_used: Math.round(row.disk_used * MIB),
      net_rx: Math.round(row.net_in_speed), net_tx: Math.round(row.net_out_speed) }];
  });
}

function projectPings(rows, serverId, document, labels) {
  const ids = new Set();
  const definitions = labels.map(def => {
    if (!def.slot && (typeof def.id !== 'string' || !EXTRA_PING_ID_PATTERN.test(def.id))) throw new Error('Monitor probe ID unavailable');
    const taskId = def.taskId ?? numericTaskId(def.id);
    if (ids.has(taskId)) throw new Error('Monitor probe ID collision');
    ids.add(taskId);
    return { ...def, taskId };
  });
  const ping = [], probes = {};
  for (const row of rows) {
    const extra = document ? withLegacyLatencyHistory(row, serverId, document).extra_probes : normalizeExtraProbes(row.extra_probes);
    for (const { id, name, slot, taskId } of definitions) {
      const point = slot ? { ping: row[`ping_${slot}`], loss: row[`loss_${slot}`] } : extra?.[id];
      if (!point || [false, 'false'].includes(point.ping) || [false, 'false'].includes(point.loss)) continue;
      const latency = Number.isFinite(point.ping) && point.ping > 0 ? point.ping : null;
      if (latency === null && point.loss !== 100) continue;
      const sample = { task_id: taskId, ts: Math.floor(row.timestamp / 1000), latency };
      if (Number.isFinite(point.loss) && point.loss > 0 && point.loss <= 100) sample.loss = point.loss;
      ping.push(sample);
      probes[taskId] = typeof name === 'string' && name ? name : id;
    }
  }
  return { ping, probes };
}

export async function loadMonitorCompatHistory(db, id, query) {
  const hours = integerParam(query, 'hours', 6, 1, 24);
  const points = integerParam(query, 'points', MAX_POINTS, 60, MAX_POINTS);
  const series = query.getAll('series');
  if (hours === null || points === null || series.length > 1) return false;
  const server = await db.prepare(`SELECT s.id, s.history_partition_id, s.timestamp
    FROM monitor_compat_ids AS m JOIN servers AS s ON s.id = m.server_id
    WHERE m.id = ? AND ${MONITOR_COMPAT_VISIBLE}`).bind(id).first();
  if (!server) return null;

  const wantMetrics = !series.length || series[0] === 'metrics';
  const wantPing = !series.length || series[0] === 'ping';
  // This is the sampling interval, not a claim that CF retains a full Monitor bucket per point.
  const step = 60 * Math.ceil(hours * 60 / points);
  const result = { metrics: [], ping: [], probes: {}, loss: {}, step };
  if (!wantMetrics && !wantPing) return result;
  if (pendingHistory >= HISTORY_SLOTS) throw new Error('Monitor history busy');
  pendingHistory++;
  try {
    const columns = [...(wantMetrics ? RESOURCE_COLUMNS : []), ...(wantPing ? PING_COLUMNS : [])].join(', ');
    const rows = await sampleHistory(db, server, hours, step, columns);
    if (wantMetrics) result.metrics = projectResources(rows);
    if (wantPing) {
      // Never cache the active catalog: removals and assignment changes apply even to cached samples.
      const document = await readLatencyTaskDocument(db);
      const labels = document ? publicLatencyNodes(document, server.id) : await readLegacyLabels(db);
      Object.assign(result, projectPings(rows, server.id, document, labels));
    }
    return result;
  } finally {
    pendingHistory--;
  }
}
