import { ensureMonitorTelemetrySchema } from './monitorTelemetry.js';
import { ensureMonitorCompatIdSchema } from './monitorCompatIds.js';
import { EXTRA_PING_ID_PATTERN } from '../shared/extraPing.js';
import { trafficCounter } from '../services/monitorStatistics.js';
import { MONITOR_STATE_BYTES,monitorBytes } from '../shared/monitorTelemetry.js';

const object=value=>!!value && typeof value==='object' && !Array.isArray(value);
const time=value=>Number.isSafeInteger(value) && value>=0 && value<=8640000000000000;
const nonnegative=value=>typeof value==='number' && Number.isFinite(value) && value>=0;
const date=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0,10)===value;
const counter=value=>{try{trafficCounter(value);return true;}catch(_){return false;}};
const source=value=>['cf-batch','cf-live','standard'].includes(value);
const legacySource=value=>['metrics_history','metrics_history_old'].includes(value);
const unique=(rows,key)=>new Set(rows.map(r=>r[key])).size===rows.length;
const decimalObservation=value=>typeof value==='string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && nonnegative(Number(value));

function validLedger(value) {
  return object(value) && typeof value.epoch==='string' &&
    ['rx','tx','totalRx','totalTx','dayRx','dayTx','monthRx','monthTx'].every(k=>counter(value[k])) &&
    time(value.observedAt) && date(value.dayStart) && date(value.monthStart) && value.monthStart<=value.dayStart;
}

function validSample(value) {
  if(!object(value) || !time(value.sampledAt) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs<0 || !source(value.source) || !object(value.report))return false;
  const r=value.report;
  for(const key of ['cpu','uptime','mem_total','mem_used','swap_total','swap_used','disk_total','disk_used','tcp','udp','procs','net_rx','net_tx']) {
    if(Object.hasOwn(r,key) && !nonnegative(r[key]))return false;
  }
  if(Object.hasOwn(r,'load') && (!Array.isArray(r.load) || r.load.length!==3 || !r.load.every(nonnegative)))return false;
  for(const key of ['boot_id','iface'])if(Object.hasOwn(r,key) && typeof r[key]!=='string')return false;
  // Standard readings are retained observations, not authoritative ledger counters.
  for(const key of ['net_rx_total','net_tx_total'])if(Object.hasOwn(r,key) &&
    (value.source==='cf-batch' ? !counter(r[key]) : !decimalObservation(r[key])))return false;
  if(value.network!=null && (!object(value.network) || !counter(value.network.rxBytes) || !counter(value.network.txBytes) ||
    !Number.isSafeInteger(value.network.coverageMs) || value.network.coverageMs<0 ||
    ['rxMean','txMean'].some(k=>value.network[k]!=null && !nonnegative(value.network[k]))))return false;
  const io=value.extra?.diskIO,gpu=value.extra?.gpu;
  if(io!=null && (!object(io) || !['read_bps','write_bps','read_iops','write_iops','await_ms','util'].every(k=>nonnegative(io[k])) || io.util>100))return false;
  if(gpu!=null && (!Array.isArray(gpu) || !gpu.every(g=>object(g) && typeof g.id==='string' && typeof g.name==='string' &&
    ['info','mem_used','mem_total','sm_clock','power'].every(k=>g[k]==null || nonnegative(g[k])))))return false;
  return value.extra===undefined || value.extra===null || object(value.extra);
}

function validState(state) {
  if(!object(state) || monitorBytes(JSON.stringify(state)).length>MONITOR_STATE_BYTES)return false;
  if(state.traffic!=null && !validLedger(state.traffic))return false;
  for(const key of ['receivedAt','liveCheckpointAt'])if(state[key]!==undefined && !time(state[key]))return false;
  if(state.lateSamples!==undefined && (!Number.isSafeInteger(state.lateSamples) || state.lateSamples<0))return false;
  if(state.source!==undefined && !source(state.source))return false;
  for(const key of ['latest','live'])if(state[key]!=null && !validSample(state[key]))return false;
  const mark=state.networkMark;
  if(mark!=null && (!object(mark) || !time(mark.sampledAt) || !Number.isSafeInteger(mark.pendingElapsedMs) || mark.pendingElapsedMs<0 ||
    !object(mark.report) || typeof mark.report.boot_id!=='string' || !mark.report.boot_id ||
    !counter(mark.report.net_rx_total) || !counter(mark.report.net_tx_total)))return false;
  const m=state.migration;
  if(m!=null) {
    if(!object(m) || !['monitor','legacy'].includes(m.mode))return false;
    for(const key of ['activatedAt','firstSampledAt','returnedAt','restoredAt'])if(m[key]!==undefined && !time(m[key]))return false;
    if(m.transitions!==undefined && (!Number.isSafeInteger(m.transitions) || m.transitions<0))return false;
    if(m.needsBaseline!==undefined && typeof m.needsBaseline!=='boolean')return false;
    if(m.legacySource!=null && (!object(m.legacySource) || !legacySource(m.legacySource.table) || !time(m.legacySource.timestamp)))return false;
    const known=m.knownMonth;
    if(known!=null) {
      if(!object(known) || !date(known.monthStart) || !time(known.observedAt) || !legacySource(known.source) || known.precision!=='legacy-number' ||
        !['rx','tx'].every(k=>decimalObservation(known[k])) ||
        known.exactBaseline!==undefined && typeof known.exactBaseline!=='boolean')return false;
      if(known.exactBaseline!==false && !['rx','tx'].every(k=>counter(known[k]) && Number.isSafeInteger(Number(known[k]))))return false;
    }
  }
  if(state.facts!=null && (!object(state.facts) || state.facts.cpu_cores!==undefined &&
    !(typeof state.facts.cpu_cores==='number' && Number.isSafeInteger(state.facts.cpu_cores) || typeof state.facts.cpu_cores==='string' &&
      /^-?(?:0|[1-9]\d*)$/.test(state.facts.cpu_cores) && BigInt(state.facts.cpu_cores)>=-9223372036854775808n && BigInt(state.facts.cpu_cores)<=9223372036854775807n)))return false;
  if(state.clock!=null) {
    const c=state.clock;
    if(!object(c))return false;
    if(c.source==='receiver') {if(!time(c.receivedAt))return false;}
    else if(![null,'date'].includes(c.source) || !time(c.local_ts) || c.accurate_ts!=null && !time(c.accurate_ts) ||
      c.offset_ms!=null && !Number.isInteger(c.offset_ms) ||
      ['round_trip_ms','sample_age_ms'].some(k=>c[k]!=null && (!Number.isInteger(c[k]) || c[k]<0)))return false;
  }
  return true;
}

export async function exportMonitorMetadata(db,serverIds) {
  const backup={version:1,kind:'metadata-not-raw-history',nodes:[],ids:[],probeIds:[],reporting:[]};
  const tables=new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(r=>r.name));
  for(const [table,key] of [['monitor_telemetry_nodes','nodes'],['monitor_compat_ids','ids'],['monitor_probe_ids','probeIds']]) {
    if(!tables.has(table))continue;
    const rows=(await db.prepare(`SELECT * FROM ${table}`).all()).results;
    backup[key]=key==='probeIds' ? rows : rows.filter(r=>serverIds.includes(r.server_id));
  }
  backup.nodes=backup.nodes.map(r=>({server_id:r.server_id,state:JSON.parse(r.state)}));
  // Reserved IDs include deleted nodes: restoring them must not restore tokens or server rows.
  if(tables.has('monitor_compat_ids'))backup.ids=(await db.prepare('SELECT * FROM monitor_compat_ids').all()).results;
  if(tables.has('settings'))backup.reporting=(await db.prepare("SELECT key,value FROM settings WHERE key GLOB 'monitor_reporting:*'").all()).results
    .filter(r=>serverIds.includes(r.key.slice('monitor_reporting:'.length)));
  return backup;
}

export function validMonitorMetadata(value) {
  const id=v=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  const numeric=v=>Number.isSafeInteger(v) && v>0;
  try {
    if(!value || value.version!==1 || value.kind!=='metadata-not-raw-history' || !['nodes','ids','probeIds','reporting'].every(k=>Array.isArray(value[k])) ||
      monitorBytes(JSON.stringify(value)).length>1048576)return false;
    return value.nodes.every(r=>object(r) && id(r.server_id) && validState(r.state)) && unique(value.nodes,'server_id') &&
      value.ids.every(r=>object(r) && id(r.server_id) && numeric(r.id)) && unique(value.ids,'id') && unique(value.ids,'server_id') &&
      value.probeIds.every(r=>object(r) && EXTRA_PING_ID_PATTERN.test(r.metric_id) && numeric(r.id)) && unique(value.probeIds,'id') && unique(value.probeIds,'metric_id') &&
      value.reporting.every(r=>object(r) && typeof r.key==='string' && r.key.startsWith('monitor_reporting:') && id(r.key.slice(18)) && typeof r.value==='string') && unique(value.reporting,'key');
  }catch(_){return false;}
}

export async function importMonitorMetadata(db,backup,serverIds) {
  if(!validMonitorMetadata(backup))throw new TypeError('Invalid monitor metadata');
  await ensureMonitorTelemetrySchema(db);await ensureMonitorCompatIdSchema(db);
  await db.prepare(`CREATE TABLE IF NOT EXISTS monitor_probe_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 9007199254740991),metric_id TEXT NOT NULL UNIQUE)`).run();
  const writes=[];
  for(const [table,key,identity] of [['monitor_compat_ids','ids','server_id'],['monitor_probe_ids','probeIds','metric_id']]) {
    for(const row of backup[key]) {
      const existing=await db.prepare(`SELECT * FROM ${table} WHERE id=? OR ${identity}=?`).bind(row.id,row[identity]).all();
      if(existing.results.some(r=>r.id!==row.id || r[identity]!==row[identity]))throw new Error('Monitor identity conflict');
      writes.push(db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${table} WHERE (id=? OR ${identity}=?) AND (id<>? OR ${identity}<>?))
        THEN 1 ELSE json('monitor_identity_conflict') END`).bind(row.id,row[identity],row.id,row[identity]));
      writes.push(db.prepare(`INSERT INTO ${table}(id,${identity}) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM ${table} WHERE ${identity}=?)`)
        .bind(row.id,row[identity],row[identity]));
    }
  }
  for(const row of backup.nodes) {
    if(!serverIds.includes(row.server_id))continue;
    const authority=await db.prepare('SELECT n.token_version FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=?').bind(row.server_id).first();
    if(!authority)continue;
    const state={...row.state,networkMark:null,traffic:row.state.traffic ? {...row.state.traffic,epoch:''} : null,
      migration:{...row.state.migration,restoredAt:Date.now()}};
    writes.push(db.prepare(`INSERT INTO monitor_telemetry_nodes(server_id,revision,token_version,generation,active_stream,durable_through,state)
      VALUES(?,1,?,1,'',1,?) ON CONFLICT(server_id) DO NOTHING`).bind(row.server_id,authority.token_version,JSON.stringify(state)));
  }
  for(const r of backup.reporting)if(serverIds.includes(r.key.slice(18)))writes.push(db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').bind(r.key,r.value));
  if(writes.length && (await db.batch(writes)).some(r=>!r.success))throw new Error('Monitor metadata restore failed');
}
