import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { serializeAgentRpc } from '../../src/shared/monitorAgentProtocol.js';

export const telemetry = await import('../../src/database/monitorTelemetry.js').catch(e=> {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
export const invoke = (name,...args) => {
  assert.equal(typeof telemetry[name],'function',`${name} must be implemented`);
  return telemetry[name](...args);
};
export const at = Date.UTC(2026,10,24,12);
export const principal = {serverId:'uuid-a',tokenVersion:1};
export const session = (overrides={}) => ({generation:1,leaseUntil:Date.now()+60000,admitStream:true,
  assertCurrent:async()=>true,isCurrent:()=>true,calendar:{timeZone:'UTC',resetDay:1},
  tasks:[{taskId:1,metricId:'p_a',assignedAt:1,retiredAt:null}],...overrides});
export const sample = (rx='9007199254740992',ts=at) => ({sampledAt:ts,elapsedMs:1000,report:{boot_id:'k/a',cpu:20,net_rx_total:rx,net_tx_total:'0'},extra:{}});
export const frame = (sequence=1,overrides={},id=1) => serializeAgentRpc({method:'cf.report.batch',id,params:{version:1,stream:'stream-a',sequence,
  samples:[sample(),sample('9007199254740993',at+1000)],probes:[10,20,-1].map((latencyMs,i)=>({taskId:1,metricId:'p_a',sampledAt:at+i*1000,latencyMs})),
  clock:{local_ts:at,accurate_ts:null,offset_ms:null,source:null,round_trip_ms:null,sample_age_ms:null},...overrides}},
  {implemented:[{method:'cf.report.batch',version:1}],negotiated:[{method:'cf.report.batch',version:1}]});

export async function fixture(t,options={}) {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response();}}',d1Databases:{DB:'telemetry'},...options});
  t?.after(()=>mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, reset_day INTEGER, history_partition_id INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS terminal_nodes (server_id TEXT PRIMARY KEY, token_version INTEGER)'),
    db.prepare("INSERT OR IGNORE INTO servers VALUES ('uuid-a',1,777)"),
    db.prepare("INSERT OR IGNORE INTO terminal_nodes VALUES ('uuid-a',1)")
  ]);
  try { await invoke('ensureMonitorTelemetrySchema',db); }
  catch (error) { if (!t) await mf.dispose(); throw error; }
  return {mf,db,env:{DB:db}};
}
export const counts = async db => Object.fromEntries(await Promise.all(['monitor_telemetry_nodes','monitor_telemetry_receipts','monitor_telemetry_buckets'].map(async name=>[name,(await db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first()).n])));
