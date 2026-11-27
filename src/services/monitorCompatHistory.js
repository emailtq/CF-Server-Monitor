import { buildSparseHistoryQuery } from '../database/historySampling.js';
import { getHistoryIdRange, getServerHistoryInfo } from '../database/indexOptimization.js';
import { readLatencyTaskDocument } from '../database/latencyTasks.js';
import { MONITOR_COMPAT_VISIBLE } from '../database/monitorCompatIds.js';
import { EXTRA_PING_ID_PATTERN, normalizeExtraProbes, publicExtraPingNodes } from '../shared/extraPing.js';
import { LEGACY_LATENCY_SLOTS, legacyMetricSuffix, publicLatencyNodes, withLegacyLatencyHistory } from '../shared/latencyTasks.js';
import { getMetricsHistoryCache, setMetricsHistoryCache } from '../utils/cache.js';
import { PROBE_METRIC_FIELDS } from '../utils/historyFields.js';
import { readMonitorHistoryRows, readMonitorLatest } from '../database/monitorTelemetry.js';
import { getMonitorProbeIds } from '../database/monitorProbeIds.js';
import { getMetricsHistory } from '../database/schema.js';
import { readMonitorTelemetry } from '../database/monitorTelemetry.js';
import { projectMonitorHistory } from './monitorProjection.js';

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
  const native=await readMonitorHistoryRows(db,server.id,{from:Date.now()-hours*HOUR_MS,to:Date.now()+1});
  if(native!==null)return getMetricsHistory(db,server.id,hours,columns,server);
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
      net_rx: Math.round(row.net_in_speed), net_tx: Math.round(row.net_out_speed),...(row.monitor ? {monitor:row.monitor} : {}) }];
  });
}

function projectPings(rows, serverId, document, labels, nativeIds=null) {
  const ids = new Set();
  const definitions = labels.map(def => {
    if (!def.slot && (typeof def.id !== 'string' || !EXTRA_PING_ID_PATTERN.test(def.id))) throw new Error('Monitor probe ID unavailable');
    const taskId = nativeIds?.get(def.id) ?? def.taskId ?? numericTaskId(def.id);
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
      const latency = Number.isFinite(point.ping) && point.ping >= (nativeIds ? 0 : Number.MIN_VALUE) ? point.ping : null;
      if (latency === null && point.loss !== 100) continue;
      const sample = { task_id: taskId, ts: Math.floor(row.timestamp / 1000), latency };
      if(row.monitor)sample.monitor=row.monitor;
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
      const native=(await readMonitorLatest(db,[server.id])).has(server.id);
      const ids=native ? await getMonitorProbeIds(db,labels.map(p=>p.id)) : null;
      Object.assign(result, projectPings(rows, server.id, document, labels,ids));
    }
    return result;
  } finally {
    pendingHistory--;
  }
}

// Standard viewer history uses the actual core tiers, not the old CF sparse-history ceiling.
export async function loadMonitorStandardHistory(db, id, query, { accessDays = 1, now = Date.now() } = {}) {
  const hours = integerParam(query,'hours',6,1,accessDays*24);
  const points = integerParam(query,'points',1440,60,1440), series = query.getAll('series');
  if (hours === null || points === null || series.length > 1 || !Number.isSafeInteger(id)) return false;
  const server = await db.prepare(`SELECT s.* FROM monitor_compat_ids m JOIN servers s ON s.id=m.server_id WHERE m.id=? AND ${MONITOR_COMPAT_VISIBLE}`).bind(id).first();
  if (!server) return null;
  if (pendingHistory >= HISTORY_SLOTS) throw new Error('Monitor history busy');
  pendingHistory++;
  try {
    const unit = hours > 7*24 ? 3600 : 60;
    const step = unit*Math.max(1,Math.ceil(hours*3600/unit/points));
    const from = Math.floor((now-hours*HOUR_MS)/(step*1000))*step*1000, to = now+1;
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE name IN('monitor_telemetry_nodes','metrics_history','metrics_history_old')").all()).results.map(r=>r.name);
    const native = tables.includes('monitor_telemetry_nodes') ? await readMonitorTelemetry(db,server.id,{from,to,step:60}) : null;
    const document = await readLatencyTaskDocument(db);
    const labels = document ? publicLatencyNodes(document,server.id) : await readLegacyLabels(db);
    const allowed = new Map(labels.map(label=>[label.id,label]));
    if (native) native.probeSeries = native.probeSeries.filter(p=>allowed.has(p.metricId)).map(p=>({...p,name:allowed.get(p.metricId).name}));
    // The projection groups the requested epoch-aligned span; the core stays minute-weighted.
    const result = projectMonitorHistory(native ? {...native,step} : {step,resourceBuckets:[],probeSeries:[],coverage:{rawRetentionDays:7,rollupRetentionDays:30}});
    const covered = new Set(native?.resourceBuckets.flatMap(b=>b.coveredMinutes || [b.ts]) || []);
    const legacy = [];
    if (tables.includes('metrics_history') && server.history_partition_id) {
      const range = getHistoryIdRange(server.history_partition_id,Math.max(from,Number(server.timestamp)||0),to);
      for (const table of ['metrics_history','metrics_history_old']) {
        if (!tables.includes(table)) continue;
        const rows = await db.prepare(`SELECT * FROM ${table} WHERE id BETWEEN ? AND ? AND server_id=? AND timestamp>=? AND timestamp<? ORDER BY id`)
          .bind(range.startId,range.endId,server.id,from,to).all();
        for (const row of rows.results) if (!covered.has(Math.floor(row.timestamp/60000)*60000)) legacy.push(row);
      }
    }
    // Old summaries cannot reconstruct denominators or weighted peaks. Keep their precision visible.
    legacy.sort((a,b)=>a.timestamp-b.timestamp);
    const legacyMetrics = new Map();
    for (const p of projectResources(legacy)) {
      const ts = Math.floor(p.ts/step)*step;
      if (!legacyMetrics.has(ts)) legacyMetrics.set(ts,{...p,ts,sampled_ts:p.ts,cpu_max:null,net_rx_max:null,net_tx_max:null,minutes:null,source:'legacy-MiB/summary'});
    }
    // One row per span: mixed buckets retain known native weight and mark the unweighted legacy observations.
    for (const p of result.metrics) {
      if (legacyMetrics.has(p.ts)) p.source='native-weighted/legacy-summary-unweighted';
      legacyMetrics.delete(p.ts);
    }
    result.metrics.push(...legacyMetrics.values());
    const probeIds = legacy.length && native && document ? await getMonitorProbeIds(db,labels.map(p=>p.id)) : null;
    const legacyPing = legacy.length ? projectPings(legacy,server.id,document,labels,probeIds) : {ping:[],probes:{}};
    const legacyPings = new Map();
    for (const p of legacyPing.ping) {
      const ts = Math.floor(p.ts/step)*step, key = `${p.task_id}:${ts}`;
      if (!legacyPings.has(key)) legacyPings.set(key,{...p,ts,sampled_ts:p.ts,source:'legacy-summary/unknown-denominator'});
    }
    for (const p of result.ping) {
      const key = `${p.task_id}:${p.ts}`;
      if (legacyPings.has(key)) p.source='native-probes/legacy-summary-unknown-denominator';
      legacyPings.delete(key);
    }
    result.ping.push(...legacyPings.values());
    Object.assign(result.probes,legacyPing.probes);
    for (const p of legacyPing.ping) result.loss[p.task_id] = null;
    result.metrics.sort((a,b)=>a.ts-b.ts); result.ping.sort((a,b)=>a.task_id-b.task_id || a.ts-b.ts);
    result.step = step;
    const availableTimes = [...legacy.map(row=>row.timestamp),
      ...(native?.rawSamples.map(s=>s.sampledAt) || []), ...(native?.resourceBuckets.map(b=>b.ts) || []),
      ...(native?.probeSeries.flatMap(p=>p.samples.map(s=>s.sampledAt)) || [])];
    result.coverage = {...result.coverage,from,to,accessDays,legacySamples:legacy.length,legacyProbeDenominator:'unknown',
      firstAvailableAt:Math.min(...availableTimes,Infinity), lastAvailableAt:Math.max(...availableTimes,-Infinity)};
    if (!Number.isFinite(result.coverage.firstAvailableAt)) result.coverage.firstAvailableAt=null;
    if (!Number.isFinite(result.coverage.lastAvailableAt)) result.coverage.lastAvailableAt=null;
    if (series.length) {
      if (series[0] !== 'metrics') result.metrics=[];
      if (series[0] !== 'ping') {result.ping=[];result.probes={};result.loss={};result.attempts={};}
    }
    return result;
  } finally {pendingHistory--;}
}
