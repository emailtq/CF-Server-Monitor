// S2 laboratory only: no product imports, production bindings, secrets or network targets.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const START = Date.UTC(2026, 10, 24);
const EVIDENCE = fileURLToPath(new URL('../.planning/2026-11-20-monitor-theme-api/protocol-migration-stage1-20261123/evidence/', import.meta.url));

export function projectMessages(nodes, active) {
  const batches = nodes * 1440, realtime = active ? nodes * 43200 : 0;
  // One heartbeat/60s in addition to the batch, two reconnections/node/day,
  // four configuration replies/node/day, 1% uncertain delivery retried via HTTP.
  const heartbeat = nodes * 1440, upgrades = nodes * 2, config = nodes * 4;
  const httpFallback = Math.ceil(batches * 0.01);
  const incomingFrames = realtime + batches + heartbeat + nodes * 2 + config;
  const wsRequestUnits = Math.ceil(incomingFrames / 20);
  return {
    nodes, active, batches, realtime, samples: nodes * 43200, probes: nodes * 5760,
    heartbeat, upgrades, config, httpFallback, incomingFrames, wsRequestUnits,
    workerRequests: upgrades + httpFallback + 1440,
    doRequestUnits: wsRequestUnits + upgrades + httpFallback + 1440,
    assumptions: '1% extra HTTP retry, two upgrades and four config replies/node/day; 1440 frontend/admin Worker→DO requests/day. Outgoing ACK/config/broadcast frames not inbound WS request units. Hibernation auto-response heartbeat projection is conservatively counted, not measured.'
  };
}

export function generateBatches(nodes, minutes) {
  const batches = [];
  for (let minute = 0; minute < minutes; minute++) {
    for (let node = 1; node <= nodes; node++) {
      const samples = Array.from({ length: 30 }, (_, i) => {
        const k = minute * 30 + i, sampledAt = START + k * 2000;
        return {
          sampledAt, elapsedMs: 2000,
          report: {
            boot_id: `boot-${node}/eth0`, iface: 'eth0', uptime: 3600 + k * 2,
            cpu: ((node * 17 + k * 13) % 1000) / 10,
            load: [((k + node) % 21) / 10, 0.2, 0.3],
            mem_total: 8589934592, mem_used: 1073741824 + ((k * 7919 + node * 1201) % 1000000),
            swap_total: 1073741824, swap_used: (k % 3) * 4096,
            disk_total: 107374182400, disk_used: 53687091200 + k * 1024,
            net_rx_total: 1000000 + node * 10000 + k * (1000 + node),
            net_tx_total: 500000 + node * 1000 + k * (500 + node),
            net_rx: Math.floor((1000 + node) / 2), net_tx: Math.floor((500 + node) / 2),
            tcp: 5 + (k % 11), udp: 2 + (k % 4), procs: 30 + (k % 7)
          },
          extra: { diskIO: k % 7 === 0 ? null : { read_bps: k * 127 % 5000, write_bps: k * 251 % 8000, read_iops: 1.5, write_iops: 2, await_ms: 0.5, util: k % 100 }, gpu: null }
        };
      });
      const probes = Array.from({ length: 4 }, (_, task) => ({
        taskId: task + 1, metricId: `p_task_${task + 1}`, sampledAt: START + minute * 60000 + task * 11000,
        latencyMs: (node + minute + task) % 7 === 0 ? -1 : 3 + ((node * 19 + minute * 31 + task * 43) % 197)
      }));
      const params = { version: 1, stream: 's2-stream', sequence: minute + 1, samples, probes,
        clock: { local_ts: START + (minute + 1) * 60000, accurate_ts: null, offset_ms: null, source: null, round_trip_ms: null, sample_age_ms: null } };
      batches.push({ node, tokenVersion: 1, params, raw: JSON.stringify(params) });
    }
  }
  return batches;
}

// These functions are embedded verbatim into the isolated Worker below.
function emptyState() {
  return { through: 0, stream: 's2-stream', tokenVersion: 1, epoch: '', rx: 0, tx: 0,
    totalRx: 0, totalTx: 0, sampleCount: 0, cpuSum: 0, cpuMax: 0, elapsedMs: 0, probeCount: 0, timeoutCount: 0, latencySum: 0, latencyMax: 0 };
}

function applyBatch(previous, params) {
  const next = { ...previous, through: params.sequence };
  for (const sample of params.samples) {
    const r = sample.report;
    if (next.epoch === r.boot_id && r.net_rx_total >= next.rx && r.net_tx_total >= next.tx) {
      next.totalRx += r.net_rx_total - next.rx;
      next.totalTx += r.net_tx_total - next.tx;
    }
    next.epoch = r.boot_id; next.rx = r.net_rx_total; next.tx = r.net_tx_total;
    next.sampleCount++; next.cpuSum += r.cpu; next.cpuMax = Math.max(next.cpuMax, r.cpu); next.elapsedMs += sample.elapsedMs;
  }
  for (const p of params.probes) {
    next.probeCount++;
    if (p.latencyMs < 0) next.timeoutCount++;
    else { next.latencySum += p.latencyMs; next.latencyMax = Math.max(next.latencyMax, p.latencyMs); }
  }
  return next;
}

async function pack(value) {
  return [...new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())];
}

async function unpack(value) {
  return JSON.parse(await new Response(new Blob([new Uint8Array(value)]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
}

const WORKER = `
${emptyState.toString()}
${applyBatch.toString()}
${pack.toString()}
${unpack.toString()}
const schema = [
  'CREATE TABLE IF NOT EXISTS buckets (id INTEGER PRIMARY KEY, payload BLOB NOT NULL CHECK(length(payload)>0))',
  'CREATE TABLE IF NOT EXISTS node_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)'
];
export class LocalStorageProbe {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.tail = Promise.resolve();
    this.d1 = {}; this.doSql = { rowsRead: 0, rowsWritten: 0, categories: {} };
    this.ready = ctx.blockConcurrencyWhile(async () => {
      for (const name of ['DIRECT', 'CHECKPOINT']) for (const q of schema) this.countD1('schema', [await env[name].prepare(q).run()]);
      this.sql('setup', 'CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY, node INTEGER NOT NULL, seq INTEGER NOT NULL, payload BLOB NOT NULL)');
      this.sql('setup', 'CREATE TABLE IF NOT EXISTS journal_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, checkpoint INTEGER NOT NULL DEFAULT 0)');
      this.sql('setup', 'CREATE INDEX IF NOT EXISTS journal_node_seq ON journal(node,seq)');
    });
  }
  sql(category, query, ...args) {
    const c = this.ctx.storage.sql.exec(query, ...args), rows = c.toArray();
    const counts = { rowsRead: c.rowsRead, rowsWritten: c.rowsWritten };
    if (!Number.isFinite(counts.rowsRead) || !Number.isFinite(counts.rowsWritten)) throw new Error('SQL cursor metering unavailable');
    const into = this.doSql.categories[category] ||= { rowsRead: 0, rowsWritten: 0 };
    for (const key of ['rowsRead', 'rowsWritten']) { into[key] += counts[key]; this.doSql[key] += counts[key]; }
    return rows;
  }
  async dbRun(db, category, query, args = []) {
    const result = await db.prepare(query).bind(...args).all();
    this.countD1(category, [result]); return result.results;
  }
  countD1(category, results) {
    const into = this.d1[category] ||= { rowsRead: 0, rowsWritten: 0, statements: 0 };
    for (const result of results) {
      if (!Number.isFinite(result.meta.rows_read) || !Number.isFinite(result.meta.rows_written)) throw new Error('D1 meta unavailable');
      into.rowsRead += result.meta.rows_read; into.rowsWritten += result.meta.rows_written; into.statements++;
    }
  }
  // The bounded workload has a fixed sequence→sampling-minute relation. Task4
  // must supply a persisted scope/receipt locator for arbitrary delayed batches.
  key(node, seq) { return node * 1000000000 + Math.floor((1795478400000 + (seq - 1) * 60000) / 300000); }
  async getBucket(db, node, seq, category) {
    const rows = await this.dbRun(db, category, 'SELECT payload FROM buckets WHERE id=?', [this.key(node, seq)]);
    return rows.length ? await unpack(rows[0].payload) : [];
  }
  async commit(db, node, seq, bucket, state, category, fault) {
    const bytes = await pack(bucket);
    const queries = [
      db.prepare('INSERT INTO buckets(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(this.key(node, seq), bytes),
      db.prepare('INSERT INTO node_state(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(node, JSON.stringify(state))
    ];
    if (fault === 'rollback') queries.push(db.prepare('INSERT INTO buckets(id,payload) VALUES(-1,NULL)'));
    const results = await db.batch(queries);
    this.countD1(category, results);
  }
  async direct(body) {
    const { node, raw, fault, category = 'ingest' } = body, p = JSON.parse(raw), db = this.env.DIRECT;
    const saved = await this.dbRun(db, category, 'SELECT payload FROM node_state WHERE id=?', [node]);
    const state = saved.length ? JSON.parse(saved[0].payload) : emptyState();
    const bucket = await this.getBucket(db, node, p.sequence, category);
    if (p.sequence <= state.through) {
      const old = bucket.find(b => b.sequence === p.sequence);
      if (!old) throw new Error('receipt_expired');
      if (old.raw !== raw) throw new Error('replay_conflict');
      return this.ack(p, state.through);
    }
    if (p.sequence !== state.through + 1) throw new Error('sequence_gap');
    if (fault === 'before') throw new Error('before_durability');
    bucket.push({ sequence: p.sequence, raw });
    await this.commit(db, node, p.sequence, bucket, applyBatch(state, p), category, fault);
    if (fault === 'after') throw new Error('ack_lost_after_commit');
    return this.ack(p, p.sequence);
  }
  ack(p, through) { return { version: 1, stream: p.stream, accepted: { from: p.sequence, to: p.sequence }, durableThrough: through }; }
  async journal(body) {
    const { node, raw, fault, category = 'ingest' } = body, p = JSON.parse(raw);
    const rows = this.sql(category, 'SELECT payload,checkpoint FROM journal_state WHERE id=?', node);
    const state = rows.length ? JSON.parse(rows[0].payload) : emptyState();
    if (p.sequence <= state.through) {
      const old = this.sql(category, 'SELECT payload FROM journal WHERE node=? AND seq=?', node, p.sequence);
      if (!old.length) throw new Error('receipt_expired');
      if ((await unpack(old[0].payload)).raw !== raw) throw new Error('replay_conflict');
      return this.ack(p, state.through);
    }
    if (p.sequence !== state.through + 1) throw new Error('sequence_gap');
    if (fault === 'before') throw new Error('before_durability');
    const next = applyBatch(state, p), bytes = new Uint8Array(await pack({ raw, state: next }));
    this.ctx.storage.transactionSync(() => {
      this.sql(category, 'INSERT INTO journal(id,node,seq,payload) VALUES(?,?,?,?)', node * 1000000000 + p.sequence, node, p.sequence, bytes);
      this.sql(category, 'INSERT INTO journal_state(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', node, JSON.stringify(next));
      if (fault === 'rollback') this.sql('failedTransactionAttempt', 'INSERT INTO journal(id,node,seq,payload) VALUES(-1,0,0,NULL)');
    });
    // SQL transaction is durable before response; D1 query materialization may lag.
    if (fault === 'after') throw new Error('ack_lost_after_journal');
    if (p.sequence % 5 === 0) await this.checkpoint(node, category);
    return this.ack(p, p.sequence);
  }
  async checkpoint(node, category = 'checkpoint', fault) {
    const saved = this.sql(category, 'SELECT payload,checkpoint FROM journal_state WHERE id=?', node);
    if (!saved.length) return;
    const state = JSON.parse(saved[0].payload), cp = saved[0].checkpoint;
    const pending = this.sql(category, 'SELECT seq,payload FROM journal WHERE node=? AND seq>? ORDER BY seq', node, cp);
    const grouped = new Map();
    for (const row of pending) {
      const key = this.key(node, row.seq);
      if (!grouped.has(key)) grouped.set(key, await this.getBucket(this.env.CHECKPOINT, node, row.seq, category));
      const bucket = grouped.get(key), record = await unpack(row.payload);
      if (!bucket.some(b => b.sequence === row.seq)) bucket.push({ sequence: row.seq, raw: record.raw });
    }
    for (const bucket of grouped.values()) {
      const last = bucket.at(-1).sequence;
      // Absolute snapshots and immutable identities, never additive UPDATEs on retry.
      const end = this.sql(category, 'SELECT payload FROM journal WHERE node=? AND seq=?', node, last);
      await this.commit(this.env.CHECKPOINT, node, last, bucket, (await unpack(end[0].payload)).state, category);
    }
    if (fault === 'afterD1') throw new Error('checkpoint_marker_lost');
    if (pending.length) this.sql(category, 'UPDATE journal_state SET checkpoint=? WHERE id=?', state.through, node);
  }
  async snapshot(mode, category = 'query') {
    const db = this.env[mode === 'direct' ? 'DIRECT' : 'CHECKPOINT'];
    const states = await this.dbRun(db, category, 'SELECT id,payload FROM node_state ORDER BY id');
    const buckets = await this.dbRun(db, category, 'SELECT id,payload FROM buckets ORDER BY id');
    const records = [];
    for (const row of buckets) for (const b of await unpack(row.payload)) records.push({ node: Math.floor(row.id / 1000000000), ...b });
    return { states: states.map(s => ({ node: s.id, ...JSON.parse(s.payload) })), records,
      logicalBytes: buckets.reduce((n, b) => n + b.payload.length, 0) + states.reduce((n, s) => n + new TextEncoder().encode(s.payload).length, 0),
      sqlitePageBytes: null, doDatabaseBytes: this.ctx.storage.sql.databaseSize };
  }
  async handle(request) {
    await this.ready;
    const body = await request.json();
    try {
      if (body.op === 'direct') return Response.json(await this.direct(body));
      if (body.op === 'journal') return Response.json(await this.journal(body));
      if (body.op === 'checkpoint') { await this.checkpoint(body.node, body.category, body.fault); return Response.json({ ok: true }); }
      if (body.op === 'snapshot') return Response.json(await this.snapshot(body.mode, body.category));
      if (body.op === 'durableState') {
        const rows = body.mode === 'direct'
          ? await this.dbRun(this.env.DIRECT, 'resume', 'SELECT payload FROM node_state WHERE id=?', [body.node])
          : this.sql('resume', 'SELECT payload FROM journal_state WHERE id=?', body.node);
        return Response.json(rows.length ? JSON.parse(rows[0].payload) : null);
      }
      if (body.op === 'range') {
        const db = this.env[body.mode === 'direct' ? 'DIRECT' : 'CHECKPOINT'];
        return Response.json(await this.dbRun(db, 'range', 'SELECT payload FROM buckets WHERE id BETWEEN ? AND ? ORDER BY id', [this.key(body.node, 1), this.key(body.node, body.minutes)]));
      }
      if (body.op === 'queryPlan') {
        const db = this.env[body.mode === 'direct' ? 'DIRECT' : 'CHECKPOINT'];
        return Response.json(await this.dbRun(db, 'queryPlan', 'EXPLAIN QUERY PLAN SELECT payload FROM buckets WHERE id BETWEEN ? AND ? ORDER BY id', [this.key(1, 1), this.key(1, 10)]));
      }
      if (body.op === 'cleanup') {
        const db = this.env[body.mode === 'direct' ? 'DIRECT' : 'CHECKPOINT'];
        for (let node = 1; node <= body.nodes; node++) {
          await this.dbRun(db, 'cleanup', 'DELETE FROM buckets WHERE id BETWEEN ? AND ?', [this.key(node, 1), this.key(node, body.minutes)]);
          if (body.mode === 'journal') this.sql('cleanup', 'DELETE FROM journal WHERE node=? AND seq<=?', node, body.minutes);
        }
        return Response.json({ ok: true });
      }
      if (body.op === 'meters') return Response.json({ d1: this.d1, doSql: this.doSql });
      throw new Error('unknown_local_op');
    } catch (e) { return Response.json({ error: e.message }, { status: 409 }); }
  }
  fetch(request) {
    const job = this.tail.then(() => this.handle(request));
    this.tail = job.catch(() => {}); return job;
  }
}
export default { fetch(request, env) {
  const mode = new URL(request.url).pathname.split('/')[1];
  return env.LOCAL.get(env.LOCAL.idFromName(mode)).fetch(request);
} };
`;

async function filesAt(directory) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push({ path: path.slice(directory.length + 1), bytes: (await stat(path)).size });
    }
  }
  await walk(directory);
  const groups = {};
  for (const file of files) {
    const backend = file.path.split(/[\\/]/)[0];
    const kind = file.path.endsWith('-wal') ? 'wal' : file.path.endsWith('-shm') ? 'shm' : 'sqlite';
    const key = backend + ':' + kind;
    groups[key] = (groups[key] || 0) + file.bytes;
  }
  return { bytes: files.reduce((n, file) => n + file.bytes, 0), groups, files };
}

function expectedFromInput(batches, nodes) {
  return Array.from({ length: nodes }, (_, n) => {
    const own = batches.filter(b => b.node === n + 1), samples = own.flatMap(b => b.params.samples), probes = own.flatMap(b => b.params.probes);
    const first = samples[0].report, last = samples.at(-1).report, successes = probes.filter(p => p.latencyMs >= 0);
    return { node: n + 1, through: own.length, sampleCount: samples.length, elapsedMs: samples.length * 2000,
      cpuSum: Number(samples.reduce((s, v) => s + v.report.cpu, 0).toFixed(6)), cpuMax: Math.max(...samples.map(s => s.report.cpu)),
      totalRx: last.net_rx_total - first.net_rx_total, totalTx: last.net_tx_total - first.net_tx_total,
      probeCount: probes.length, timeoutCount: probes.length - successes.length,
      latencySum: successes.reduce((s, p) => s + p.latencyMs, 0), latencyMax: Math.max(...successes.map(p => p.latencyMs)),
      // Retain task/generation/timestamp/order; not merely a histogram or median.
      distribution: probes.map(p => [p.taskId, p.metricId, p.sampledAt, p.latencyMs]) };
  });
}

function reconstruct(snapshot) {
  return snapshot.states.map(state => {
    const records = snapshot.records.filter(r => r.node === state.node).sort((a, b) => a.sequence - b.sequence);
    const probes = records.flatMap(r => JSON.parse(r.raw).probes);
    return Object.fromEntries([
      ...['node', 'through', 'sampleCount', 'elapsedMs', 'cpuSum', 'cpuMax', 'totalRx', 'totalTx', 'probeCount', 'timeoutCount', 'latencySum', 'latencyMax']
        .map(key => [key, key === 'cpuSum' ? Number(state[key].toFixed(6)) : state[key]]),
      ['distribution', probes.map(p => [p.taskId, p.metricId, p.sampledAt, p.latencyMs])]
    ]);
  });
}

function meterTotals(categories) {
  return Object.values(categories).reduce((s, v) => ({ rowsRead: s.rowsRead + v.rowsRead, rowsWritten: s.rowsWritten + v.rowsWritten }), { rowsRead: 0, rowsWritten: 0 });
}

function mergeMeters(into, observed) {
  for (const [category, values] of Object.entries(observed.d1)) {
    const target = into.d1[category] ||= { rowsRead: 0, rowsWritten: 0, statements: 0 };
    for (const key of Object.keys(target)) target[key] += values[key];
  }
  for (const [category, values] of Object.entries(observed.doSql.categories)) {
    const target = into.doSql.categories[category] ||= { rowsRead: 0, rowsWritten: 0 };
    for (const key of Object.keys(target)) target[key] += values[key];
  }
  Object.assign(into.doSql, meterTotals(into.doSql.categories));
}

function dailyProjection(path, nodes, minutes) {
  const factor = 1440 / minutes, ingest = path.d1.categories.ingest;
  const cleanup = path.d1.categories.cleanup, range = path.d1.categories.range;
  const buckets = nodes * Math.ceil(minutes / 5);
  const retainedLogicalBytes = Math.ceil(path.logicalBytes * factor * 7);
  // Real measured cleanup per occupied bucket; steady-state expiry is one bucket/5m.
  const cleanupWrites = cleanup.rowsWritten / buckets * nodes * 288;
  const cleanupReads = cleanup.rowsRead / buckets * nodes * 288;
  // 1% retries + 2 reconnect recoveries/node/day; indexed 24h history/node once/day.
  const replay = path.d1.categories.replay || { rowsRead: 0, rowsWritten: 0 };
  const retryReads = replay.rowsRead / 2 * Math.ceil(nodes * 1440 * 0.01);
  const rangeReads = range.rowsRead / Math.ceil(minutes / 5) * nodes * 288;
  const rowsWritten = ingest.rowsWritten * factor + cleanupWrites;
  const rowsRead = ingest.rowsRead * factor + cleanupReads + retryReads + rangeReads + nodes * 2;
  const journal = path.doSql.categories.ingest || { rowsRead: 0, rowsWritten: 0 };
  const journalCleanup = path.doSql.categories.cleanup || { rowsRead: 0, rowsWritten: 0 };
  const journalReplay = path.doSql.categories.replay || { rowsRead: 0, rowsWritten: 0 };
  const doSqlDaily = {
    localCursorRowsWritten: journal.rowsWritten * factor + journalCleanup.rowsWritten * factor,
    localCursorRowsRead: journal.rowsRead * factor + journalCleanup.rowsRead * factor + journalReplay.rowsRead / 2 * Math.ceil(nodes * 1440 * 0.01),
    modeledCloudFloorWrites: journal.rowsWritten * factor + journalCleanup.rowsWritten * factor,
    cloudMeaning: 'SQL row counts rather than KV byte request-unit pricing, including index/checkpoint/deletion costs exposed by local cursor. Cloud SQL Free allowance is 100000 rows written/day per official pricing; actual cloud counts remain Task7.'
  };
  return { rowsWritten, rowsRead, ingestWrites: ingest.rowsWritten * factor, cleanupWrites, retryReads, rangeReads, doSqlDaily,
    retainedLogicalBytes, logicalBytesPerDay: Math.ceil(path.logicalBytes * factor), retentionDays: 7,
    storageHeadroomBytes: 400000000 - retainedLogicalBytes,
    d1WriteHeadroom: 80000 - rowsWritten, d1ReadHeadroom: 4000000 - rowsRead,
    model: 'Measured local meta × 1440/minutes plus measured deletion/indexed range/replay costs. Logical 7d extrapolation includes repeated node state conservatively; not cloud billed capacity.' };
}

export async function runStorageProbe({ scenarios = [{ nodes: 20, minutes: 10 }, { nodes: 100, minutes: 10 }] } = {}) {
  const report = { runtime: process.version, evidence: 'real local Miniflare D1 and SQLite-backed DO; deterministic synthetic telemetry, not production measurements',
    strategy: 'd1-node-buckets', scenarios: [], messages: { active20: projectMessages(20, true), idle20: projectMessages(20, false), stress100: projectMessages(100, true), idle100: projectMessages(100, false) },
    officialDoSqlPricing: { source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/', retrieved: '2026-11-24', freeRowsReadPerDay: 5000000, freeRowsWrittenPerDay: 100000, sqlStoredBytesTotal: 5000000000, deletesCountAsWrites: true },
    cloudPending: ['DO duration/CPU/hibernation including mixed legacy sockets', 'Worker CPU for real frame sizes and gzip work', 'actual billed D1/DO storage and remaining existing site capacity'],
    duration: { targetGBSeconds: 10400, modeledResident128MB24hGBSeconds: 10800, maximumResidentSecondsAt128MB: 83200, localDurationIsNotCloudBilling: true } };
  for (const { nodes, minutes } of scenarios) {
    assert.ok(Number.isInteger(nodes) && nodes >= 1 && nodes <= 100);
    assert.ok(Number.isInteger(minutes) && minutes >= 5 && minutes <= 60 && minutes % 5 === 0);
    const temp = await mkdtemp(join(tmpdir(), 'cfsm-s2-'));
    let mf;
    const options = { modules: true, script: WORKER, compatibilityDate: '2026-08-01',
      d1Databases: { DIRECT: 's2-direct', CHECKPOINT: 's2-checkpoint' },
      durableObjects: { LOCAL: { className: 'LocalStorageProbe', useSQLite: true } },
      resourcePersistencePath: temp };
    const batches = generateBatches(nodes, minutes), expected = expectedFromInput(batches, nodes);
    const scenario = { nodes, minutes, input: { sampleCount: nodes * minutes * 30, probeCount: nodes * minutes * 4,
      rawBytes: batches.reduce((n, b) => n + Buffer.byteLength(b.raw), 0), maximumBatchBytes: Math.max(...batches.map(b => Buffer.byteLength(b.raw))),
      virtualStart: START, virtualEnd: START + minutes * 60000, minuteCadence: 60, resourceCadenceSeconds: 2 }, expected };
    const started = performance.now();
    try {
      async function call(mode, body, ok = true) {
        const response = await mf.dispatchFetch('https://s2.invalid/' + mode, { method: 'POST', body: JSON.stringify(body) });
        const value = await response.json();
        if (ok) assert.equal(response.status, 200, JSON.stringify(value));
        else assert.equal(response.status, 409, JSON.stringify(value));
        return value;
      }
      for (const mode of ['direct', 'journal']) {
        if (mf) await mf.dispose();
        options.resourcePersistencePath = join(temp, mode);
        mf = new Miniflare(options);
        const first = batches[0], last = batches.filter(b => b.node === 1).at(-1);
        const checks = {};
        let lastAcknowledged, acknowledgedRecovery;
        const allMeters = { d1: {}, doSql: { categories: {} } };
        await call(mode, { op: 'snapshot', mode });
        const filesBefore = await filesAt(options.resourcePersistencePath);
        assert.match((await call(mode, { op: mode, ...first, fault: 'before', category: 'failure' }, false)).error, /before_durability/);
        assert.equal((await call(mode, { op: 'snapshot', mode })).states.length, 0);
        checks.beforeDurabilityNoAck = true;
        await call(mode, { op: mode, ...first, fault: 'rollback', category: 'failure' }, false);
        assert.equal((await call(mode, { op: 'snapshot', mode })).states.length, 0);
        checks.atomicRollback = true;
        // Observe a real committed failure before response: no forged ACK object.
        await call(mode, { op: mode, ...first, fault: 'after' }, false);
        if (mode === 'journal') {
          const stale = await call(mode, { op: 'snapshot', mode });
          assert.equal(stale.states.length, 0); checks.journalBeforeCheckpoint = true;
        }
        const persistedBefore = await call(mode, { op: 'durableState', mode, node: 1 });
        assert.equal(persistedBefore.through, 1);
        mergeMeters(allMeters, await call(mode, { op: 'meters' }));
        await mf.dispose(); mf = new Miniflare(options);
        assert.deepEqual(await call(mode, { op: 'durableState', mode, node: 1 }), persistedBefore);
        checks.restartedSamePersistedDatabase = true;
        const ack = await call(mode, { op: mode, ...first, category: 'replay' });
        assert.deepEqual(ack, { version: 1, stream: first.params.stream, accepted: { from: 1, to: 1 }, durableThrough: 1 });
        for (const b of batches.slice(1)) {
          const response = await call(mode, { op: mode, ...b });
          assert.equal(response.durableThrough, b.params.sequence);
          if (b.node === last.node && b.params.sequence === last.params.sequence) {
            assert.deepEqual(response, { version: 1, stream: last.params.stream,
              accepted: { from: last.params.sequence, to: last.params.sequence }, durableThrough: last.params.sequence });
            lastAcknowledged = response;
          }
        }
        const commonSnapshot = await call(mode, { op: 'snapshot', mode });
        const filesAfter = await filesAt(options.resourcePersistencePath);
        assert.deepEqual(reconstruct(commonSnapshot), expected);
        if (mode === 'direct') {
          assert.ok(lastAcknowledged);
          assert.equal(commonSnapshot.states.length, nodes);
          assert.ok(commonSnapshot.states.every(state => state.through === minutes));
          mergeMeters(allMeters, await call(mode, { op: 'meters' }));
          await mf.dispose(); mf = new Miniflare(options);
          const restored = await call(mode, { op: 'snapshot', mode, category: 'acknowledgedResume' });
          assert.deepEqual(restored, commonSnapshot);
          const replayAck = await call(mode, { op: mode, ...last, category: 'acknowledgedReplay' });
          assert.deepEqual(replayAck, lastAcknowledged);
          assert.deepEqual(await call(mode, { op: 'snapshot', mode, category: 'acknowledgedResume' }), restored);
          acknowledgedRecovery = { observedAck: lastAcknowledged, replayAck,
            persistedStates: restored.states, rawBatchCount: restored.records.length };
          checks.acknowledgedRestartReplayNoSecondBooking = true;
        }
        if (mode === 'journal') {
          // A separate five-minute tail exercises the two-store crash boundary.
          const tail = generateBatches(1, minutes + 5).slice(minutes);
          for (const b of tail.slice(0, 4)) await call(mode, { op: mode, ...b, category: 'recoveryBoundary' });
          const b = tail[4];
          await call(mode, { op: mode, ...b, fault: 'after', category: 'recoveryBoundary' }, false);
          await call(mode, { op: 'checkpoint', node: 1, fault: 'afterD1', category: 'recoveryBoundary' }, false);
          const checkpointed = await call(mode, { op: 'snapshot', mode });
          mergeMeters(allMeters, await call(mode, { op: 'meters' }));
          await mf.dispose(); mf = new Miniflare(options);
          await call(mode, { op: 'checkpoint', node: 1, category: 'recoveryBoundary' });
          assert.deepEqual(await call(mode, { op: 'snapshot', mode }), checkpointed);
          checks.checkpointCommittedBeforeMarkerReplay = true;
          // The extra tail is a separately measured boundary, not the comparison workload.
          scenario.journalTailExpected = expectedFromInput(generateBatches(1, minutes + 5), 1)[0];
          assert.deepEqual(reconstruct(checkpointed)[0], scenario.journalTailExpected);
        }
        const conflict = JSON.stringify({ ...last.params, clock: { ...last.params.clock, local_ts: 1 } });
        assert.match((await call(mode, { op: mode, node: 1, raw: conflict, category: 'rejection' }, false)).error, /replay_conflict/);
        const gap = JSON.stringify({ ...last.params, sequence: minutes + 100 });
        assert.match((await call(mode, { op: mode, node: 1, raw: gap, category: 'rejection' }, false)).error, /sequence_gap/);
        checks.conflictAndGapRejected = true;
        const snapshot = commonSnapshot;
        const projected = reconstruct(snapshot);
        assert.deepEqual(projected, expected);
        const prior = await call(mode, { op: 'snapshot', mode });
        await call(mode, { op: mode, ...last, category: 'replay' });
        assert.deepEqual(await call(mode, { op: 'snapshot', mode }), prior);
        checks.ackLostReplayNoSecondBooking = true;
        for (const b of batches) assert.equal(snapshot.records.find(r => r.node === b.node && r.sequence === b.params.sequence)?.raw, b.raw);
        checks.rawDistributionRecovered = true;
        await call(mode, { op: 'range', mode, node: 1, minutes });
        const queryPlan = await call(mode, { op: 'queryPlan', mode });
        assert.ok(queryPlan.some(row => /INTEGER PRIMARY KEY/.test(row.detail)));
        await call(mode, { op: 'cleanup', mode, minutes, nodes });
        const expired = await call(mode, { op: mode, ...last, category: 'expiredReplay' }, false);
        assert.match(expired.error, /receipt_expired/);
        mergeMeters(allMeters, await call(mode, { op: 'meters' }));
        const meters = allMeters;
        if (mode === 'direct') assert.equal(meters.d1.acknowledgedReplay.rowsWritten, 0);
        const path = { checks, acknowledgedRecovery, reconstructed: projected, d1: { categories: meters.d1, ...meterTotals(meters.d1) }, doSql: meters.doSql,
          logicalBytes: snapshot.logicalBytes, sqlitePageBytes: snapshot.sqlitePageBytes,
          doDatabaseBytes: snapshot.doDatabaseBytes, filesBefore, filesAfter, queryPlan,
          allocationPoint: 'Before common workload and after common workload, before the separately metered recovery tail; each candidate has its own resourcePersistencePath.',
          meteringLimits: 'D1 totals cover returned meta only; failed atomic batch has no result meta. DO SQL cursor failure-category counters are attempted operations inside a rolled-back transaction, separately excluded from daily successful ingestion projection.' };
        scenario[mode === 'direct' ? 'd1Only' : 'journal'] = path;
      }
      scenario.localWallMs = Math.round(performance.now() - started);
      for (const name of ['d1Only', 'journal']) scenario[name].daily = dailyProjection(scenario[name], nodes, minutes);
      scenario.localBudget = {
        d1FitsWriteReadLogicalTargets: scenario.d1Only.daily.rowsWritten < 80000 && scenario.d1Only.daily.rowsRead < 4000000 && scenario.d1Only.daily.retainedLogicalBytes < 400000000,
        journalExceedsOfficialDoSqlWriteAllowance: scenario.journal.daily.doSqlDaily.modeledCloudFloorWrites > 100000,
        durationAndCpuAccepted: false
      };
      report.scenarios.push(scenario);
    } finally {
      try {
        if (mf) await mf.dispose();
      } finally {
        const absolute = resolve(temp), root = resolve(tmpdir());
        assert.ok(absolute.startsWith(root + '\\') || absolute.startsWith(root + '/'));
        assert.ok(basename(absolute).startsWith('cfsm-s2-'));
        await rm(absolute, { recursive: true, force: true });
      }
    }
  }
  return report;
}

export async function writeStorageReport(report, path = join(EVIDENCE, 'S2-storage-probe.json')) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runStorageProbe();
  await writeStorageReport(report);
  console.log(JSON.stringify({ runtime: report.runtime, strategy: report.strategy, messages: report.messages, duration: report.duration,
    scenarios: report.scenarios.map(s => ({ nodes: s.nodes, minutes: s.minutes, input: s.input, localWallMs: s.localWallMs,
      localBudget: s.localBudget,
      d1Only: { checks: s.d1Only.checks, d1: s.d1Only.d1, daily: s.d1Only.daily, logicalBytes: s.d1Only.logicalBytes, allocationBefore: s.d1Only.filesBefore.groups, allocationAfter: s.d1Only.filesAfter.groups, queryPlan: s.d1Only.queryPlan },
      journal: { checks: s.journal.checks, d1: s.journal.d1, daily: s.journal.daily, doSql: s.journal.doSql, doDatabaseBytes: s.journal.doDatabaseBytes, allocationBefore: s.journal.filesBefore.groups, allocationAfter: s.journal.filesAfter.groups } })),
    cloudPending: report.cloudPending }, null, 2));
}
