import { reduceTrafficLedger, reduceNetworkMark, trafficCounter, trafficCalendar, aggregateMinuteSamples, aggregateProbeSamples, mergeResourceBuckets } from '../services/monitorStatistics.js';
import { clearTelemetryCaches, clearAllCaches } from '../utils/cache.js';
import { getHistoryIdRange } from './indexOptimization.js';
import { flattenDiskMetrics,attachDiskMetricsObject,DISK_IO_FIELD_TO_COLUMN } from '../utils/metrics.js';
import { MONITOR_BYTE_FIELDS } from '../shared/monitorAgentProtocol.js';
export { exportMonitorMetadata, importMonitorMetadata } from './monitorBackup.js';
import { isValidMonitorPrincipal, MonitorTelemetryError, parseMonitorBatch, packMonitorBucket, unpackMonitorBucket, compressMonitorBytes, monitorReceiptText, monitorBytes,
  MONITOR_BUCKET_BYTES, MONITOR_STATE_BYTES, MONITOR_BUCKET_MS } from '../shared/monitorTelemetry.js';

export async function ensureMonitorTelemetrySchema(db) {
  const results = await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_telemetry_nodes (
      server_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
      token_version INTEGER NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0),
      active_stream TEXT NOT NULL, durable_through INTEGER NOT NULL CHECK(durable_through > 0),
      state TEXT NOT NULL CHECK(length(CAST(state AS BLOB)) <= ${MONITOR_STATE_BYTES})
    )`),
    // No expiry or cascading FK: ACK may have been lost indefinitely, and old scopes remain recoverable.
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_telemetry_receipts (
      server_id TEXT NOT NULL, token_version INTEGER NOT NULL, stream TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0), admitted INTEGER NOT NULL CHECK(admitted = 1),
      params TEXT NOT NULL CHECK(length(CAST(params AS BLOB)) <= 524288), ack TEXT NOT NULL,
      min_ts INTEGER, max_ts INTEGER, parts INTEGER NOT NULL CHECK(parts > 0), received_at INTEGER NOT NULL,
      PRIMARY KEY(server_id,token_version,stream,sequence)
    ) WITHOUT ROWID`),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_telemetry_buckets (
      server_id TEXT NOT NULL, token_version INTEGER NOT NULL, stream TEXT NOT NULL, sequence INTEGER NOT NULL,
      part INTEGER NOT NULL CHECK(part >= 0), bucket_start INTEGER NOT NULL,
      min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL,
      payload BLOB NOT NULL CHECK(length(payload) <= ${MONITOR_BUCKET_BYTES}),
      PRIMARY KEY(server_id,max_ts,token_version,stream,sequence,part)
    ) WITHOUT ROWID`),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_telemetry_rollups (
      server_id TEXT NOT NULL, hour_start INTEGER NOT NULL, revision INTEGER NOT NULL,
      payload BLOB NOT NULL CHECK(length(payload)<=${MONITOR_BUCKET_BYTES}),
      PRIMARY KEY(server_id,hour_start)
    ) WITHOUT ROWID`)
  ]);
  if (results.some(r=>!r.success)) throw new Error('Monitor telemetry schema unavailable');
  const columns = (await db.prepare('PRAGMA table_info(monitor_telemetry_buckets)').all()).results;
  if (!columns.find(c=>c.name==='max_ts')?.pk) {
    // A single SQLite transaction migrates already ACKed data, including every fragment, before publishing the layout.
    await db.batch([
      db.prepare(`CREATE TABLE monitor_telemetry_buckets_layout (
        server_id TEXT NOT NULL, token_version INTEGER NOT NULL, stream TEXT NOT NULL, sequence INTEGER NOT NULL,
        part INTEGER NOT NULL CHECK(part>=0),bucket_start INTEGER NOT NULL,min_ts INTEGER NOT NULL,max_ts INTEGER NOT NULL,
        payload BLOB NOT NULL CHECK(length(payload)<=${MONITOR_BUCKET_BYTES}),
        PRIMARY KEY(server_id,max_ts,token_version,stream,sequence,part)) WITHOUT ROWID`),
      db.prepare('INSERT INTO monitor_telemetry_buckets_layout SELECT * FROM monitor_telemetry_buckets'),
      db.prepare('DROP TABLE monitor_telemetry_buckets'),
      db.prepare('ALTER TABLE monitor_telemetry_buckets_layout RENAME TO monitor_telemetry_buckets')
    ]);
  }
  await db.prepare('DROP INDEX IF EXISTS monitor_telemetry_window').run();
}

const error = (code,message,expected) => {throw new MonitorTelemetryError(code,message,expected);};
const standardCounters = report => {
  if (!report.boot_id) return false;
  try {trafficCounter(report.net_rx_total);trafficCounter(report.net_tx_total);return true;} catch (_) {return false;}
};

async function legacyMigration(db,serverId,calendar) {
  const migration={mode:'monitor',legacySource:null,knownMonth:null,transitions:0};
  if(!await db.prepare("SELECT name FROM sqlite_master WHERE name='metrics_history'").first())return migration;
  const server=await db.prepare('SELECT * FROM servers WHERE id=?').bind(serverId).first();
  if(!server?.history_partition_id)return migration;
  const range=getHistoryIdRange(server.history_partition_id);
  let latest=null;
  for(const table of ['metrics_history','metrics_history_old']) {
    if(table.endsWith('_old') && !await db.prepare("SELECT name FROM sqlite_master WHERE name='metrics_history_old'").first())continue;
    const row=await db.prepare(`SELECT * FROM ${table} WHERE id BETWEEN ? AND ? AND server_id=? ORDER BY id DESC LIMIT 1`)
      .bind(range.startId,range.endId,serverId).first();
    if(row && (!latest || row.timestamp>latest.timestamp))latest={...row,table};
  }
  if(!latest)return migration;
  migration.legacySource={table:latest.table,timestamp:latest.timestamp,resourcePrecision:'legacy-MiB/summary',probePrecision:'legacy-summary/nullable-loss'};
  if([latest.net_rx_monthly,latest.net_tx_monthly].every(v=>typeof v==='number' && Number.isFinite(v) && v>=0)) {
    migration.knownMonth={rx:String(latest.net_rx_monthly),tx:String(latest.net_tx_monthly),
      monthStart:trafficCalendar(latest.timestamp,calendar).monthStart,observedAt:latest.timestamp,source:latest.table,precision:'legacy-number',
      exactBaseline:[latest.net_rx_monthly,latest.net_tx_monthly].every(Number.isSafeInteger)};
  }
  return migration;
}

function monthBaseline(migration,ts,calendar) {
  const known=migration.knownMonth,period=trafficCalendar(ts,calendar);
  if(!known || known.exactBaseline===false || known.monthStart!==period.monthStart || ts<known.observedAt)return null;
  return {epoch:'',rx:'0',tx:'0',observedAt:ts-1,...period,totalRx:'0',totalTx:'0',dayRx:'0',dayTx:'0',monthRx:known.rx,monthTx:known.tx};
}

export async function markMonitorLegacy(db,serverId,generation) {
  if(!await db.prepare("SELECT name FROM sqlite_master WHERE name='monitor_telemetry_nodes'").first())return;
  const row=await db.prepare('SELECT * FROM monitor_telemetry_nodes WHERE server_id=?').bind(serverId).first();
  if(!row)return;
  const state=JSON.parse(row.state);
  if(state.migration?.mode==='legacy')return;
  state.migration={...state.migration,mode:'legacy',transitions:(state.migration?.transitions || 0)+1,returnedAt:Date.now()};
  delete state.live;state.networkMark=null;
  await db.prepare('UPDATE monitor_telemetry_nodes SET state=?,revision=revision+1,generation=? WHERE server_id=? AND revision=?')
    .bind(JSON.stringify(state),generation,serverId,row.revision).run();
  clearAllCaches();
}

/** Persist at most one latest-only checkpoint/minute; CF live never books counters or raw history. */
export async function recordMonitorLive(env,principal,session,event) {
  await guard(principal,session);await authority(env.DB,principal);
  const db=env.DB,row=await db.prepare('SELECT * FROM monitor_telemetry_nodes WHERE server_id=?').bind(principal.serverId).first();
  if(row && (row.token_version>principal.tokenVersion || row.generation>session.generation))error('monitor_authority_denied','Node authority unavailable');
  const previous=row ? JSON.parse(row.state) : {};
  if(row && row.token_version===principal.tokenVersion && row.generation===session.generation && previous.migration?.mode!=='legacy' &&
    event.receivedAt-(previous.liveCheckpointAt || previous.receivedAt || 0)<60000) {
    return {persistedAt:previous.liveCheckpointAt || previous.receivedAt || 0,latest:projectMonitorLatest(principal.serverId,previous)};
  }
  const migration=previous.migration || await legacyMigration(db,principal.serverId,session.calendar);
  const returning=migration.mode==='legacy';
  const state={...previous,live:{sampledAt:event.receivedAt,elapsedMs:0,report:event.report,byteTokens:event.byteTokens,extra:{},source:'cf-live'},
    liveCheckpointAt:event.receivedAt,receivedAt:event.receivedAt,facts:event.facts ?? previous.facts ?? null,
    source:previous.source || 'cf-live',migration:{...migration,mode:'monitor',needsBaseline:migration.needsBaseline || returning,
      transitions:(migration.transitions || 0)+(returning ? 1 : 0),activatedAt:previous.migration?.activatedAt ?? event.receivedAt}};
  if(monitorBytes(JSON.stringify(state)).length>MONITOR_STATE_BYTES)error('monitor_storage_overflow','Node state storage overflow');
  await guard(principal,session);
  await db.prepare(`INSERT INTO monitor_telemetry_nodes(server_id,revision,token_version,generation,active_stream,durable_through,state)
    VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=?)
      ${session.calendarResetDay===undefined ? '' : 'AND EXISTS(SELECT 1 FROM servers WHERE id=? AND reset_day IS ?)'}
      AND COALESCE((SELECT revision FROM monitor_telemetry_nodes WHERE server_id=?),0)=? THEN ? ELSE 0 END,?,?,?,?,?)
    ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,token_version=excluded.token_version,generation=excluded.generation,state=excluded.state`)
    .bind(principal.serverId,principal.serverId,principal.tokenVersion,...(session.calendarResetDay===undefined ? [] : [principal.serverId,session.calendarResetDay]),principal.serverId,row?.revision || 0,(row?.revision || 0)+1,
      principal.tokenVersion,session.generation,row?.active_stream || '',row?.durable_through || 1,JSON.stringify(state)).run();
  await guard(principal,session);clearTelemetryCaches();
  return {persistedAt:state.liveCheckpointAt,latest:projectMonitorLatest(principal.serverId,state)};
}

export function projectMonitorMonth(state) {
  const traffic=state.traffic;
  const known=state.migration?.knownMonth;
  const knownPeriod=traffic && known?.monthStart===traffic.monthStart;
  const unknownMonth=knownPeriod && (known.exactBaseline===false ||
    ![known.rx,known.tx].every(v=>Number.isSafeInteger(Number(v)) && /^(?:0|[1-9]\d*)$/.test(v)));
  return {rx:unknownMonth ? null : traffic?.monthRx ?? null,tx:unknownMonth ? null : traffic?.monthTx ?? null,
    source:unknownMonth ? 'unknown-legacy-baseline' : knownPeriod ? 'legacy-baseline+native-delta' : 'ledger',
    precision:unknownMonth ? 'unknown' : knownPeriod ? 'legacy-number+exact-bytes' : 'exact-bytes',periodStart:traffic?.monthStart ?? null};
}

export function projectMonitorLatest(serverId,state) {
  const latest=state.live && state.live.sampledAt>(state.latest?.sampledAt || 0) ? state.live : state.latest;
  if(!latest)return null;
  const r=latest.report,f=state.facts || {},traffic=state.traffic,month=projectMonitorMonth(state);
  const byteTokens = Object.fromEntries(MONITOR_BYTE_FIELDS.map(key => [key,latest.byteTokens?.[key] ??
    (Number.isSafeInteger(r[key]) && r[key]>=0 ? String(r[key]) : null)]));
  const row={server_id:serverId,timestamp:state.receivedAt ?? latest.sampledAt,cpu:r.cpu ?? null,load_avg:r.load?.join(' ') ?? null,
    net_in_speed:r.net_rx ?? null,net_out_speed:r.net_tx ?? null,processes:r.procs ?? null,tcp_conn:r.tcp ?? null,udp_conn:r.udp ?? null,
    net_rx:traffic?.totalRx ?? null,net_tx:traffic?.totalTx ?? null,net_rx_monthly:month.rx,net_tx_monthly:month.tx,
    os:f.os || '',arch:f.arch || '',virt:f.virt || '',kernel_version:f.kernel || '',cpu_info:f.cpu_name || '',cpu_cores:f.cpu_cores ?? null,
    ip_v4:f.ipv4 || '0',ip_v6:f.ipv6 || '0',
    agent_version:f.agent_version || '',boot_time:r.uptime == null ? null : latest.sampledAt-r.uptime*1000,
    monitor:{source:latest.source,sampledAt:latest.sampledAt,byteTokens,precision:latest.source==='standard' ? 'receiver-held' : 'native-bytes',coverageMs:latest.elapsedMs,migration:state.migration,traffic,month}};
  for(const [target,key] of Object.entries({ram_total:'mem_total',ram_used:'mem_used',swap_total:'swap_total',swap_used:'swap_used',disk_total:'disk_total',disk_used:'disk_used'}))row[target]=r[key]==null ? null : r[key]/1048576;
  const extra=latest.source==='cf-live' ? state.latest?.extra || latest.extra : latest.extra;
  Object.assign(row,flattenDiskMetrics({disk:extra?.diskIO},{preserveUnknown:true}));
  row.gpu_info=Array.isArray(extra?.gpu) ? JSON.stringify(extra.gpu) : null;
  row.monitor.gpu={source:'last-observed-snapshot',precision:'legacy-GPU-units'};
  return attachDiskMetricsObject(row);
}

/** Missing native schema is valid only for an unmigrated database; other D1 errors propagate. */
export async function readMonitorLatest(db,serverIds) {
  const result=new Map();
  if(!(await db.prepare("SELECT name FROM sqlite_master WHERE name='monitor_telemetry_nodes'").all()).results.length)return result;
  for(let offset=0;offset<serverIds.length;offset+=100) {
    const rows=await db.prepare('SELECT server_id,state FROM monitor_telemetry_nodes WHERE server_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(serverIds.slice(offset,offset+100))).all();
    for(const row of rows.results) {const state=JSON.parse(row.state);if(state.migration?.mode!=='legacy')result.set(row.server_id,projectMonitorLatest(row.server_id,state));}
  }
  return result;
}

export async function readMonitorHistoryRows(db,serverId,{from,to,step=60}) {
  const native=await readMonitorLatest(db,[serverId]);
  if(!native.has(serverId))return null;
  const core=await readMonitorTelemetry(db,serverId,{from,to,step}),rows=new Map();
  for(const bucket of core.resourceBuckets) {
    const report=Object.fromEntries(Object.entries(bucket.fields).map(([key,f])=>[key,f.mean]));
    const row=projectMonitorLatest(serverId,{latest:{sampledAt:bucket.ts,elapsedMs:bucket.coverageMs,report,source:core.source}});
    for(const column of Object.values(DISK_IO_FIELD_TO_COLUMN))row[column]=bucket.fields[column]?.mean ?? null;
    row.gpu_info=bucket.gpuSnapshot?.value==null ? null : JSON.stringify(bucket.gpuSnapshot.value);
    row.monitor.gpu=bucket.gpuSnapshot || {source:'unknown',precision:'legacy-GPU-units'};
    row.net_in_speed=bucket.network.rxMean;row.net_out_speed=bucket.network.txMean;row.monitor.resource=bucket;
    rows.set(bucket.ts,attachDiskMetricsObject(row));
  }
  const probeMinutes=new Map();
  for(const series of core.probeSeries)for(const p of series.samples){const ts=Math.floor(p.sampledAt/60000)*60000,list=probeMinutes.get(ts)||[];list.push(p);probeMinutes.set(ts,list);}
  for(const [ts,probes] of probeMinutes) {
    const row=rows.get(ts)||{timestamp:ts,extra_probes:{},monitor:{source:probes[0].source || 'cf-batch'}};row.extra_probes ||= {};
    for(const g of aggregateProbeSamples(probes))row.extra_probes[g.metricId]={ping:g.mean,loss:g.loss};rows.set(ts,row);
  }
  return [...rows.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

/** Bounded hourly compaction: rollup CAS and removal of its exact raw fragments share one transaction. */
export async function maintainMonitorTelemetry(db,{now=Date.now(),rawDays=7,rollupDays=30,limit=1200}={}) {
  const cutoff=Math.floor((now-rawDays*86400000)/3600000)*3600000;
  // Select metadata first, then fetch <=4 MiB packed bytes plus at most one complete boundary batch.
  limit=Math.min(limit,120);
  const rows=(await db.prepare(`SELECT server_id,token_version,stream,sequence,part,max_ts,length(payload) AS bytes FROM monitor_telemetry_buckets WHERE max_ts<? ORDER BY server_id,max_ts LIMIT ?`).bind(cutoff,limit).all()).results;
  const groups=new Map();
  const selectedHours=new Set();
  let stopped=false,packedBytes=0;
  for(const row of rows) {
    const hour=JSON.stringify([row.server_id,Math.floor(row.max_ts/3600000)]);
    if((!selectedHours.has(hour) && selectedHours.size>=60) || packedBytes+row.bytes>4194304){stopped=true;break;}
    packedBytes+=row.bytes;
    selectedHours.add(hour);
    const key=JSON.stringify([row.server_id,row.token_version,row.stream,row.sequence]);const list=groups.get(key)||[];list.push(row);groups.set(key,list);
  }
  const keys=[...groups.values()].map(g=>{const r=g[0];return [r.server_id,r.max_ts,r.token_version,r.stream,r.sequence];});
  const packed=keys.length ? (await db.prepare(`SELECT * FROM monitor_telemetry_buckets WHERE
    (server_id,max_ts,token_version,stream,sequence) IN(SELECT value->>0,value->>1,value->>2,value->>3,value->>4 FROM json_each(?))
    ORDER BY server_id,max_ts,token_version,stream,sequence,part`).bind(JSON.stringify(keys)).all()).results : [];
  const complete=new Map();
  for(const r of packed){const key=JSON.stringify([r.server_id,r.token_version,r.stream,r.sequence]),g=complete.get(key)||[];g.push(r);complete.set(key,g);}
  const hours=new Map(),deleteKeys=[],fragmentKeys=[];
  let decodedBytes=0;
  for(const group of complete.values()) {
    const first=group[0];
    const decoded=await unpackMonitorBucket(group.map(r=>new Uint8Array(r.payload)));
    const size=monitorBytes(JSON.stringify(decoded)).length;
    if(decodedBytes+size>4194304 && deleteKeys.length){stopped=true;break;}
    decodedBytes+=size;
    for(const [kind,items] of [['samples',decoded.samples],['probes',decoded.probes]])for(const item of items) {
      const ts=Math.floor(item.sampledAt/3600000)*3600000,key=JSON.stringify([first.server_id,ts]);
      const hour=hours.get(key)||{serverId:first.server_id,ts,samples:[],probes:[]};hour[kind].push(item);hours.set(key,hour);
    }
    deleteKeys.push([first.server_id,first.max_ts,first.token_version,first.stream,first.sequence]);
    fragmentKeys.push(...group.map(r=>[r.server_id,r.max_ts,r.token_version,r.stream,r.sequence,r.part]));
  }
  const writes=[];
  for(const hour of hours.values()) {
    const old=await db.prepare('SELECT revision,payload FROM monitor_telemetry_rollups WHERE server_id=? AND hour_start=?').bind(hour.serverId,hour.ts).first();
    const previous=old ? await unpackMonitorBucket([new Uint8Array(old.payload)]) : {samples:[],probes:[]};
    const minutes=new Map(previous.samples.map(b=>[b.ts,b]));
    const incoming=new Map();for(const s of hour.samples){const ts=Math.floor(s.sampledAt/60000)*60000;const list=incoming.get(ts)||[];list.push(s);incoming.set(ts,list);}
    for(const [ts,samples] of incoming){const b=aggregateMinuteSamples(samples);minutes.set(ts,{ts,...mergeResourceBuckets([...(minutes.has(ts)?[minutes.get(ts)]:[]),b])});}
    const parts=await packMonitorBucket([...minutes.values()].sort((a,b)=>a.ts-b.ts),[...previous.probes,...hour.probes]);
    if(parts.length!==1)error('monitor_storage_overflow','Hour rollup storage overflow');
    writes.push(db.prepare(`INSERT INTO monitor_telemetry_rollups(server_id,hour_start,revision,payload)
      VALUES(?,?,CASE WHEN COALESCE((SELECT revision FROM monitor_telemetry_rollups WHERE server_id=? AND hour_start=?),0)=? THEN ? ELSE NULL END,?)
      ON CONFLICT(server_id,hour_start) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`)
      .bind(hour.serverId,hour.ts,hour.serverId,hour.ts,old?.revision || 0,(old?.revision || 0)+1,parts[0]));
  }
  if(writes.length>90)throw new Error('Monitor retention chunk spans too many hours');
  // An atomic SQL assertion precedes every mutation: hour CAS alone cannot detect raw consumed before the hour read.
  const rawGuard=fragmentKeys.length ? [db.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM monitor_telemetry_buckets WHERE
    (server_id,max_ts,token_version,stream,sequence,part) IN
      (SELECT value->>0,value->>1,value->>2,value->>3,value->>4,value->>5 FROM json_each(?)))=?
    THEN 1 ELSE json('monitor_raw_already_consumed') END AS raw_unconsumed`).bind(JSON.stringify(fragmentKeys),fragmentKeys.length)] : [];
  const results=await db.batch([...rawGuard,...writes,db.prepare(`DELETE FROM monitor_telemetry_buckets WHERE
    (server_id,max_ts,token_version,stream,sequence) IN (SELECT value->>0,value->>1,value->>2,value->>3,value->>4 FROM json_each(?))`).bind(JSON.stringify(deleteKeys)),
    db.prepare('DELETE FROM monitor_telemetry_rollups WHERE hour_start<?').bind(now-rollupDays*86400000)]);
  if(results.some(r=>!r.success))throw new Error('Monitor retention failed');
  return {rawBatches:deleteKeys.length,hours:hours.size,decodedBytes,meta:results.map(r=>r.meta),pending:rows.length===limit || stopped};
}

async function guard(principal,session) {
  if (!isValidMonitorPrincipal(principal) || !Number.isSafeInteger(session?.generation) || session.generation <= 0 ||
      !Number.isSafeInteger(session.leaseUntil) || session.leaseUntil <= Date.now() || typeof session.assertCurrent !== 'function' ||
      typeof session.isCurrent !== 'function' || !await session.assertCurrent(principal) ||
      !session.isCurrent(principal) || session.leaseUntil <= Date.now()) error('monitor_authority_denied','Node authority unavailable');
}

async function authority(db,principal) {
  const row = await db.prepare(`SELECT n.token_version FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=?`).bind(principal.serverId).first();
  if (row?.token_version !== principal.tokenVersion) error('monitor_authority_denied','Node authority unavailable');
}

/** Call directly INSIDE the existing session.run owner interval, never nest another run. */
export async function recordMonitorBatch(env,principal,session,batch) {
  const {params,paramsRaw} = parseMonitorBatch(typeof batch === 'string' ? batch : batch?.raw);
  const db = env.DB, {serverId,tokenVersion} = principal;
  await guard(principal,session);
  await authority(db,principal);
  const [lookup,node] = await db.batch([
    db.prepare('SELECT params,ack FROM monitor_telemetry_receipts WHERE server_id=? AND token_version=? AND stream=? AND sequence=?').bind(serverId,tokenVersion,params.stream,params.sequence),
    db.prepare('SELECT * FROM monitor_telemetry_nodes WHERE server_id=?').bind(serverId)
  ]);
  if (!lookup.success || !node.success) throw new Error('Monitor telemetry lookup failed');
  const receipt = lookup.results[0], current = node.results[0];
  if (receipt) {
    if (await monitorReceiptText(receipt.params) !== paramsRaw) error('monitor_receipt_conflict','Batch receipt conflict');
    await guard(principal,session);
    await authority(db,principal);
    await guard(principal,session);
    return JSON.parse(receipt.ack);
  }
  if (current && (current.token_version > tokenVersion || current.generation > session.generation)) error('monitor_authority_denied','Node authority unavailable');
  const sameStream = current && current.token_version === tokenVersion && current.active_stream === params.stream;
  if (!sameStream) {
    const old = await db.prepare('SELECT sequence FROM monitor_telemetry_receipts WHERE server_id=? AND token_version=? AND stream=? LIMIT 1').bind(serverId,tokenVersion,params.stream).first();
    if (old) error('monitor_inactive_stream','Cannot append inactive stream');
    if (params.sequence !== 1) error('monitor_sequence_gap','Batch sequence gap',1);
    if (session.admitStream !== true) error('monitor_stream_admission','Stream admission required');
  } else if (params.sequence !== current.durable_through+1) error('monitor_sequence_gap','Batch sequence gap',current.durable_through+1);

  for (const p of params.probes) {
    if (!session.tasks?.some(task=>task.taskId === p.taskId && task.metricId === p.metricId &&
        Number.isSafeInteger(task.assignedAt) && p.sampledAt >= task.assignedAt && (task.retiredAt == null || p.sampledAt < task.retiredAt))) {
      error('monitor_probe_generation','Probe assignment unavailable');
    }
  }
  const previous = current ? JSON.parse(current.state) : null;
  const migration = previous?.migration || await legacyMigration(db,serverId,session.calendar);
  const rebased = current && (current.token_version !== tokenVersion || previous?.migration?.mode === 'legacy' || migration.needsBaseline);
  let traffic = previous?.traffic || null, latest = previous?.latest || null, lateSamples = previous?.lateSamples || 0;
  let networkMark = rebased ? null : previous?.networkMark || null;
  const bookedSamples = [];
  if (rebased && traffic) traffic = {...traffic,epoch:''};
  for (const s of params.samples) {
    const {network,mark} = reduceNetworkMark(networkMark,s);
    networkMark = mark;
    bookedSamples.push({...s,network});
    if (latest && s.sampledAt <= latest.sampledAt) lateSamples++;
    if (s.report.boot_id && typeof s.report.net_rx_total === 'string' && typeof s.report.net_tx_total === 'string') {
      if (!traffic) traffic = monthBaseline(migration,s.sampledAt,session.calendar);
      traffic = reduceTrafficLedger(traffic,{epoch:s.report.boot_id,rx:s.report.net_rx_total,tx:s.report.net_tx_total,observedAt:s.sampledAt,
        ...trafficCalendar(s.sampledAt,session.calendar),resetDay:session.calendar?.resetDay ?? 1,
        today:trafficCalendar(Date.now(),session.calendar).dayStart,source:'cf-batch'});
    }
    if (!latest || s.sampledAt > latest.sampledAt) latest = {...s,source:'cf-batch'};
  }
  const timestamps = [...params.samples.map(s=>s.sampledAt),...params.probes.map(p=>p.sampledAt)];
  const minTs = timestamps.length ? Math.min(...timestamps) : Date.now(), maxTs = timestamps.length ? Math.max(...timestamps) : minTs;
  const state = JSON.stringify({...previous,traffic,latest,networkMark,facts:session.facts ?? previous?.facts ?? null,lateSamples,source:'cf-batch',
    receivedAt:Date.now(),clock:params.clock,migration:{legacySource:null,knownMonth:null,...migration,mode:'monitor',
      needsBaseline:false,transitions:(migration.transitions || 0)+(migration.mode === 'legacy' ? 1 : 0),
      activatedAt:previous?.migration?.activatedAt ?? Date.now(),firstSampledAt:previous?.migration?.firstSampledAt ?? minTs}});
  if (monitorBytes(state).length > MONITOR_STATE_BYTES) error('monitor_storage_overflow','Node state storage overflow');
  const parts = await packMonitorBucket(bookedSamples,params.probes);
  const storedParams = await compressMonitorBytes(monitorBytes(paramsRaw));
  const ack = {version:1,stream:params.stream,accepted:{from:params.sequence,to:params.sequence},durableThrough:params.sequence};
  const revision = current?.revision || 0;
  await guard(principal,session);
  // This CHECK is an atomic SQL compare-and-swap and token/deletion gate. A zero-row UPDATE would silently succeed.
  const writes = [db.prepare(`INSERT INTO monitor_telemetry_receipts
    (server_id,token_version,stream,sequence,admitted,params,ack,min_ts,max_ts,parts,received_at)
    VALUES (?,?,?,?,CASE WHEN
      EXISTS(SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=?)
      ${session.calendarResetDay===undefined ? '' : 'AND EXISTS(SELECT 1 FROM servers WHERE id=? AND reset_day IS ?)'}
      AND COALESCE((SELECT revision FROM monitor_telemetry_nodes WHERE server_id=?),0)=?
      ${session.catalogRaw == null ? '' : "AND EXISTS(SELECT 1 FROM settings WHERE key='latency_tasks' AND value=?)"}
      THEN 1 ELSE 0 END,?,?,?,?,?,?)`).bind(serverId,tokenVersion,params.stream,params.sequence,serverId,tokenVersion,
        ...(session.calendarResetDay===undefined ? [] : [serverId,session.calendarResetDay]),serverId,revision,
        ...(session.catalogRaw == null ? [] : [session.catalogRaw]),storedParams,JSON.stringify(ack),minTs,maxTs,parts.length,Date.now())];
  parts.forEach((payload,part)=>writes.push(db.prepare(`INSERT INTO monitor_telemetry_buckets
    (server_id,token_version,stream,sequence,part,bucket_start,min_ts,max_ts,payload) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(serverId,tokenVersion,params.stream,params.sequence,part,Math.floor(minTs/MONITOR_BUCKET_MS)*MONITOR_BUCKET_MS,minTs,maxTs,payload)));
  writes.push(db.prepare(`INSERT INTO monitor_telemetry_nodes (server_id,revision,token_version,generation,active_stream,durable_through,state)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,token_version=excluded.token_version,
    generation=excluded.generation,active_stream=excluded.active_stream,durable_through=excluded.durable_through,state=excluded.state`)
    .bind(serverId,revision+1,tokenVersion,session.generation,params.stream,params.sequence,state));
  const persisted = await db.batch(writes);
  if (persisted.some(r=>!r.success)) throw new Error('Monitor telemetry commit failed');
  // Revocation after the atomic commit suppresses ACK, not receipt; same-scope retry can recover it later.
  await guard(principal,session);
  await authority(db,principal);
  await guard(principal,session);
  clearTelemetryCaches();
  return ack;
}

/** Receiver-clock standard notifications share the core; internal bucket ordinals are not CF sequences/receipts. */
export async function recordMonitorStandard(env,principal,session,event) {
  const db=env.DB,{serverId,tokenVersion}=principal;
  await guard(principal,session);await authority(db,principal);
  const current=await db.prepare('SELECT * FROM monitor_telemetry_nodes WHERE server_id=?').bind(serverId).first();
  const previous=current ? JSON.parse(current.state) : {};
  if (current && (current.token_version > tokenVersion || current.generation > session.generation)) error('monitor_authority_denied','Node authority unavailable');
  const revision=current?.revision || 0;
  const migration=previous.migration || await legacyMigration(db,serverId,session.calendar);
  const state={...previous,source:'standard',receivedAt:event.receivedAt,facts:event.facts ?? session.facts ?? previous.facts ?? null,
    clock:{source:'receiver',receivedAt:event.receivedAt},
    migration:{...migration,mode:'monitor',transitions:(migration.transitions || 0)+(migration.mode === 'legacy' ? 1 : 0),activatedAt:previous.migration?.activatedAt ?? event.receivedAt}};
  const switched=event.report && (previous.latest?.source === 'cf-batch' || current && current.generation !== session.generation) || current && current.token_version !== tokenVersion;
  if(switched) state.networkMark=null;
  if(current && current.token_version !== tokenVersion && state.traffic) state.traffic={...state.traffic,epoch:''};
  if(migration.mode==='legacy') {state.networkMark=null;if(state.traffic)state.traffic={...state.traffic,epoch:''};}
  if(migration.needsBaseline){state.networkMark=null;if(state.traffic)state.traffic={...state.traffic,epoch:''};state.migration.needsBaseline=false;}
  const samples=[],probes=event.probe ? [{...event.probe,source:'standard'}] : [];
  if(event.held) {
    const held=event.held;
    let remaining=held.elapsedMs,start=event.receivedAt-remaining;
    while(remaining>0) {
      const elapsedMs=Math.min(remaining,60000-start%60000),end=start+elapsedMs;
      samples.push({sampledAt:end-1,elapsedMs,report:held.report,byteTokens:held.byteTokens,extra:{},network:null,source:'standard'});
      if(state.traffic && standardCounters(held.report)) {
        state.traffic=reduceTrafficLedger(state.traffic,{epoch:held.report.boot_id,rx:held.report.net_rx_total,tx:held.report.net_tx_total,
          observedAt:end-1,...trafficCalendar(end-1,session.calendar),source:'standard'});
      }
      remaining-=elapsedMs;start=end;
    }
    if(state.networkMark) state.networkMark={...state.networkMark,pendingElapsedMs:(state.networkMark.pendingElapsedMs || 0)+held.elapsedMs};
  }
  if(event.report) {
    const report=event.report;
    const sample={sampledAt:event.receivedAt,elapsedMs:0,report,byteTokens:event.byteTokens,extra:{},source:'standard'};
    const comparable=standardCounters(report);
    const reduced=reduceNetworkMark(state.networkMark,comparable ? sample : {...sample,report:{}});state.networkMark=reduced.mark;
    if(reduced.network) samples.push({...sample,network:reduced.network});
    if(comparable) {
      if(!state.traffic)state.traffic=monthBaseline(migration,event.receivedAt,session.calendar);
      state.traffic=reduceTrafficLedger(state.traffic,{epoch:report.boot_id,rx:report.net_rx_total,tx:report.net_tx_total,
        observedAt:event.receivedAt,...trafficCalendar(event.receivedAt,session.calendar),source:'standard',
        lastSeen:previous.latest?.sampledAt ?? 0,bootedAt:typeof report.uptime === 'number' ? event.receivedAt-report.uptime*1000 : 0});
    }
    state.latest={...sample,source:'standard'};
  }
  const stream=`standard:${session.generation}`,parts=samples.length || probes.length ? await packMonitorBucket(samples,probes) : [];
  const timestamps=[...samples.map(s=>s.sampledAt),...probes.map(p=>p.sampledAt)];
  const min=timestamps.length ? Math.min(...timestamps) : event.receivedAt,max=timestamps.length ? Math.max(...timestamps) : min;
  await guard(principal,session);
  const writes=[db.prepare(`INSERT INTO monitor_telemetry_nodes(server_id,revision,token_version,generation,active_stream,durable_through,state)
    VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=?)
      ${session.calendarResetDay===undefined ? '' : 'AND EXISTS(SELECT 1 FROM servers WHERE id=? AND reset_day IS ?)'}
      AND COALESCE((SELECT revision FROM monitor_telemetry_nodes WHERE server_id=?),0)=?
      ${session.catalogRaw == null ? '' : "AND EXISTS(SELECT 1 FROM settings WHERE key='latency_tasks' AND value=?)"}
      THEN ? ELSE 0 END,?,?,?,?,?)
    ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,token_version=excluded.token_version,generation=excluded.generation,
      active_stream=excluded.active_stream,durable_through=excluded.durable_through,state=excluded.state`)
    .bind(serverId,serverId,tokenVersion,...(session.calendarResetDay===undefined ? [] : [serverId,session.calendarResetDay]),serverId,revision,...(session.catalogRaw == null ? [] : [session.catalogRaw]),
      revision+1,tokenVersion,session.generation,current?.active_stream || stream,current?.durable_through || 1,JSON.stringify(state))];
  parts.forEach((payload,part)=>writes.push(db.prepare(`INSERT INTO monitor_telemetry_buckets
    (server_id,token_version,stream,sequence,part,bucket_start,min_ts,max_ts,payload) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(serverId,tokenVersion,stream,revision+1,part,Math.floor(min/MONITOR_BUCKET_MS)*MONITOR_BUCKET_MS,min,max,payload)));
  if((await db.batch(writes)).some(r=>!r.success)) throw new Error('Standard telemetry commit failed');
  await guard(principal,session);
  clearTelemetryCaches();
}

/** Internal reader: viewer authorization belongs to the existing caller, not params or this core. */
export async function readMonitorTelemetry(db,serverId,{from,to,step=60}) {
  if (typeof serverId !== 'string' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new RangeError('Invalid telemetry window');
  const rows = await db.batch([
    db.prepare('SELECT state FROM monitor_telemetry_nodes WHERE server_id=?').bind(serverId),
    db.prepare(`SELECT token_version,stream,sequence,part,payload FROM monitor_telemetry_buckets
      WHERE server_id=? AND max_ts>=? AND min_ts<? ORDER BY token_version,stream,sequence,part`).bind(serverId,from,to)
  ]);
  if (rows.some(r=>!r.success)) throw new Error('Monitor telemetry read failed');
  const state = rows[0].results[0] ? JSON.parse(rows[0].results[0].state) : null;
  const grouped = new Map();
  for (const row of rows[1].results) {
    const key = JSON.stringify([row.token_version,row.stream,row.sequence]);
    const parts = grouped.get(key) || [];
    if (row.part !== parts.length) throw new Error('Monitor telemetry fragment missing');
    parts.push(new Uint8Array(row.payload)); grouped.set(key,parts);
  }
  const rawSamples = [], probes = [];
  for (const parts of grouped.values()) {
    const decoded = await unpackMonitorBucket(parts);
    rawSamples.push(...decoded.samples.filter(s=>s.sampledAt >= from && s.sampledAt < to));
    probes.push(...decoded.probes.filter(p=>p.sampledAt >= from && p.sampledAt < to));
  }
  rawSamples.sort((a,b)=>a.sampledAt-b.sampledAt); probes.sort((a,b)=>a.sampledAt-b.sampledAt);
  const minutes = new Map();
  for (const s of rawSamples) {
    const ts = Math.floor(s.sampledAt/60000)*60000;
    const bucket = minutes.get(ts) || [];
    bucket.push(s); minutes.set(ts,bucket);
  }
  // Stored samples already carry their booked network fact, including cross-batch weights.
  let resourceBuckets = [...minutes].map(([ts,samples])=>({ts,...aggregateMinuteSamples(samples)}));
  const rollups = await db.prepare('SELECT hour_start,payload FROM monitor_telemetry_rollups WHERE server_id=? AND hour_start>=? AND hour_start<? ORDER BY hour_start')
    .bind(serverId,Math.floor(from/3600000)*3600000,to).all();
  const archived=[];
  for(const row of rollups.results) {
    const decoded=await unpackMonitorBucket([new Uint8Array(row.payload)]);
    archived.push(...decoded.samples.filter(b=>b.ts>=from && b.ts<to));
    probes.push(...decoded.probes.filter(p=>p.sampledAt>=from && p.sampledAt<to));
  }
  const mergedMinutes=new Map();
  for(const b of [...resourceBuckets,...archived]) {
    const previous=mergedMinutes.get(b.ts);
    mergedMinutes.set(b.ts,previous ? {ts:b.ts,...mergeResourceBuckets([previous,b])} : b);
  }
  resourceBuckets=[...mergedMinutes.values()].sort((a,b)=>a.ts-b.ts);
  if(step===3600) {
    const hours=new Map();
    for(const b of resourceBuckets) {const ts=Math.floor(b.ts/3600000)*3600000;const list=hours.get(ts)||[];list.push(b);hours.set(ts,list);}
    resourceBuckets=[...hours].map(([ts,b])=>({ts,...mergeResourceBuckets(b),coveredMinutes:b.map(minute=>minute.ts)}));
  }
  return {from,to,step,source:state?.source || null,traffic:state?.traffic || null,month:projectMonitorMonth(state || {}),latest:state?.live && state.live.sampledAt>(state.latest?.sampledAt || 0) ? state.live : state?.latest || null,
    facts:state?.facts || null,migration:state?.migration || null,clock:state?.clock || null,rawSamples,resourceBuckets,
    probeSeries:aggregateProbeSamples(probes),coverage:{rawAvailable:archived.length===0,rawRetentionDays:7,rollupRetentionDays:30,
      sampleCount:rawSamples.length+archived.reduce((n,b)=>n+b.count,0),probeCount:probes.length,
      elapsedMs:rawSamples.reduce((n,s)=>n+s.elapsedMs,0)+archived.reduce((n,b)=>n+b.coverageMs,0),lateSamples:state?.lateSamples || 0,
      firstSampledAt:rawSamples[0]?.sampledAt ?? null,lastSampledAt:rawSamples.at(-1)?.sampledAt ?? null}};
}
