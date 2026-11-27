import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { writeFileSync } from 'node:fs';
import { projectMonitorNode, stringifyMonitor } from '../src/services/monitorProjection.js';
import { loadMonitorStandardHistory } from '../src/services/monitorCompatHistory.js';
import { getMonitorCompatIds } from '../src/database/monitorCompatIds.js';
import { getMonitorProbeIds } from '../src/database/monitorProbeIds.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { createHistoryTableSql } from '../src/utils/historyFields.js';
import { ensureMonitorTelemetrySchema, recordMonitorBatch, readMonitorTelemetry } from '../src/database/monitorTelemetry.js';
import { parseAgentRpc, serializeAgentRpc } from '../src/shared/monitorAgentProtocol.js';
import { exportMonitorMetadata, validMonitorMetadata } from '../src/database/monitorBackup.js';
import { createMonitorRuntimeFixture, frames, send, until } from './fixtures/monitor-runtime.mjs';
import { frame, sample, session, principal } from './helpers/monitorTelemetry.js';

const now = Date.UTC(2026,10,25,12);
const display = { showTraffic:true };
function evidence(name, data) {
  if (process.env.CFSM_S1_REPAIR_EVIDENCE) writeFileSync(`${process.env.CFSM_S1_REPAIR_EVIDENCE}/S1-REPAIR-${name}.json`,JSON.stringify(data,null,2));
}

test('missing, invalid and future full-month periods remain unknown; only a proven past period resets',()=>{
  const cases = [
    [undefined,null], [{rx:'42',tx:'7',periodStart:null},null], [{rx:'42',tx:'7',periodStart:''},null],
    [{rx:'42',tx:'7',periodStart:'2026-11-31'},null], [{rx:'42',tx:'7',periodStart:'2026-12-01'},null],
    [{rx:null,tx:null,periodStart:'2026-11-01',source:'unknown-legacy-baseline'},null],
    [{rx:'42',tx:'7',periodStart:'2026-10-01'},0], [{rx:'42',tx:'7',periodStart:'2026-11-01'},42]
  ];
  for (const [month, expected] of cases) {
    const persisted = {timestamp:now,monitor:{traffic:{totalRx:'42',totalTx:'7',dayRx:'3',dayTx:'4',dayStart:'2026-11-25'},month}};
    const node=JSON.parse(stringifyMonitor(projectMonitorNode({server:{id:'a',reset_day:1},id:1,persisted},{display},now)));
    assert.equal(node.month_rx,expected,JSON.stringify(month));
    if(expected===null) {assert.equal(node.month_used,null);assert.match(node.traffic_source.month,/unknown/);}
  }
});

async function fixture(t, script='export default {fetch(){return new Response()}}', durableObjects) {
  const mf = new Miniflare({modules:true,script,compatibilityDate:'2024-12-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'s1-repair'},...(durableObjects ? {durableObjects} : {})});
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)'),
    db.prepare("CREATE TABLE servers(id TEXT PRIMARY KEY,name TEXT,sort_order INTEGER DEFAULT 0,is_hidden TEXT DEFAULT '0',server_group TEXT,region TEXT,history_partition_id INTEGER,timestamp INTEGER DEFAULT 0,price TEXT,currency TEXT,billing_cycle TEXT,expire_date TEXT,traffic_limit TEXT,traffic_calc_type TEXT,reset_day INTEGER)"),
    db.prepare(createHistoryTableSql('metrics_history')),
    db.prepare("INSERT INTO servers(id,name,history_partition_id,reset_day) VALUES('uuid-a','A',777,1)"),
    db.prepare('CREATE TABLE terminal_nodes(server_id TEXT PRIMARY KEY,token_version INTEGER)'),
    db.prepare("INSERT INTO terminal_nodes VALUES('uuid-a',1)"),
    db.prepare('INSERT INTO settings VALUES(?,?)').bind('site_options',JSON.stringify({is_public:'true'}))
  ]);
  const id=(await getMonitorCompatIds(db,['uuid-a'])).get('uuid-a');return {mf,db,id};
}
async function dense(db) {
  const rows=Array.from({length:360},(_,i)=>{const ts=now-(i+1)*60000;return [buildHistoryId(777,ts),ts,i%100]});
  await db.prepare(`INSERT INTO metrics_history(id,server_id,timestamp,cpu,ram_used,disk_used,net_in_speed,net_out_speed,ping_ct,loss_ct)
    SELECT value->>0,'uuid-a',value->>1,value->>2,1,2,3,4,10,20 FROM json_each(?)`).bind(JSON.stringify(rows)).run();
}
test('dense legacy and mixed core windows align to the standard budget without made-up weights or probe counts',async t=>{
  const {db,id}=await fixture(t);await dense(db);
  const query=new URLSearchParams('hours=6&points=60');
  const legacy=await loadMonitorStandardHistory(db,id,query,{accessDays:30,now});
  assert.equal(legacy.step,360);assert.equal(legacy.metrics.length,60);assert.equal(legacy.ping.length,60);
  assert.ok(legacy.metrics.every(p=>p.ts%360===0 && p.cpu_max===null && p.minutes===null && p.source==='legacy-MiB/summary'));
  assert.ok(legacy.ping.every(p=>p.ts%360===0 && p.source==='legacy-summary/unknown-denominator'));
  assert.equal(legacy.coverage.legacySamples,360);assert.equal(legacy.loss['1'],null);
  assert.equal(legacy.coverage.firstAvailableAt,now-6*3600000);assert.equal(legacy.coverage.lastAvailableAt,now-60000);
  await ensureMonitorTelemetrySchema(db);
  await db.prepare('INSERT INTO settings VALUES(?,?)').bind('latency_tasks',JSON.stringify({version:1,revision:1,tasks:[{id:'p_a',metric_id:'p_a',name:'A',nodes:['uuid-a'],legacy_slot:'custom_ct'}],sources:[{id:'p_a',node:'uuid-a',slot:'custom_ct',before:now}]})).run();
  await getMonitorProbeIds(db,['p_a']);
  const ts=now-60000;
  await recordMonitorBatch({DB:db},principal,session(),frame(1,{samples:[{...sample('10',ts),elapsedMs:1000,report:{...sample('10',ts).report,cpu:100}},{...sample('11',ts+1000),elapsedMs:59000,report:{...sample('11',ts+1000).report,cpu:0}}],probes:[10,20,-1].map((latencyMs,i)=>({taskId:1,metricId:'p_a',sampledAt:ts+i*1000,latencyMs}))}));
  const mixed=await loadMonitorStandardHistory(db,id,query,{accessDays:30,now});
  assert.equal(mixed.metrics.length,60);assert.ok(mixed.metrics.every(p=>p.ts%360===0));
  assert.ok(mixed.ping.length<=60);assert.deepEqual(mixed.attempts['1'],{attempts:3,timeouts:1,mean:15});
  const mixedPoint=mixed.metrics.find(p=>p.source==='native-weighted/legacy-summary-unweighted');
  assert.ok(mixedPoint);assert.ok(Math.abs(mixedPoint.cpu-100/60)<1e-10);assert.equal(mixedPoint.minutes,1);
  assert.equal(mixed.loss['1'],null,'unknown legacy denominator cannot turn into the native-only whole-window loss');
  const core=await readMonitorTelemetry(db,'uuid-a',{from:now-6*3600000,to:now+1});
  assert.equal(core.probeSeries[0].attempts,3);assert.equal(core.resourceBuckets[0].fields.cpu.max,100);
  assert.equal(mixed.coverage.legacySamples,359);
  evidence('dense-history',{legacy,mixed,coreProbe:core.probeSeries[0]});
});

test('actual native bytes retain HTTP and standard WS original integer tokens; unavailable capacities stay null',async t=>{
  const built=await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:*']});
  const {mf,db}=await fixture(t,built.outputFiles[0].text,{METRICS_BROADCASTER:{className:'MetricsBroadcaster',useSQLite:true}});
  await ensureMonitorTelemetrySchema(db);
  const values=['0','9007199254740993','9223372036854775807'];const results=[];
  for(let i=0;i<values.length;i++) {
    const value=values[i],ts=Date.now()+i;
    const raw=frame(i+1,{samples:[sample('10',ts)],probes:[]}).replace('"cpu":20',`"cpu":20,"mem_total":${value},"mem_used":${value},"swap_total":${value},"swap_used":${value},"disk_total":${value},"disk_used":${value}`);
    await recordMonitorBatch({DB:db},principal,session(),raw);
    const response=await mf.dispatchFetch('https://repair.test/api/nodes'),http=await response.text();assert.equal(response.status,200);
    for(const key of ['mem_total','mem_used','swap_total','swap_used','disk_total','disk_used']) assert.match(http,new RegExp(`"${key}":${value}(?:[,}])`));
    const socketResponse=await mf.dispatchFetch('https://repair.test/api/ws?monitor_protocol=1',{headers:{Upgrade:'websocket'}});
    assert.equal(socketResponse.status,101);const ws=socketResponse.webSocket;ws.accept();
    const wire=await new Promise((resolve,reject)=>{ws.addEventListener('message',event=>resolve(event.data),{once:true});ws.addEventListener('error',reject,{once:true})});
    ws.close();for(const key of ['mem_total','mem_used','swap_total','swap_used','disk_total','disk_used']) assert.match(wire,new RegExp(`"${key}":${value}(?:[,}])`));
    results.push({value,http,ws:wire});
  }
  await recordMonitorBatch({DB:db},principal,session(),frame(4,{samples:[sample('11',Date.now()+100)],probes:[]}));
  const unknown=await (await mf.dispatchFetch('https://repair.test/api/nodes')).json();
  for(const key of ['mem_total','swap_total','disk_total'])assert.equal(unknown.nodes[0][key],null);
  for(const key of ['mem_used','swap_used','disk_used'])assert.equal(unknown.nodes[0].metrics[key],null);
  evidence('capacity-wire',{results,unknown});
});

test('standard report parser/serializer and metadata preserve unsafe capacity tokens without adding a safe-byte sidecar',async t=>{
  const safe=parseAgentRpc('{"jsonrpc":"2.0","method":"report","params":{"mem_total":123}}');
  assert.equal(safe.byteTokens,undefined);assert.equal(safe.params.mem_total,123);
  const report=parseAgentRpc('{"jsonrpc":"2.0","method":"report","params":{"mem_total":9007199254740993,"disk_total":9223372036854775807}}');
  assert.equal(report.byteTokens.mem_total,'9007199254740993');
  assert.match(serializeAgentRpc(report),/"mem_total":9007199254740993/);
  const {db}=await fixture(t);await ensureMonitorTelemetrySchema(db);
  const raw=frame(1,{samples:[sample('10',now)],probes:[]}).replace('"cpu":20','"cpu":20,"mem_total":9007199254740993');
  await recordMonitorBatch({DB:db},principal,session(),raw);
  const backup=await exportMonitorMetadata(db,['uuid-a']);assert.equal(validMonitorMetadata(backup),true);
  const state=backup.nodes[0].state;assert.equal(state.latest.byteTokens.mem_total,'9007199254740993');
  state.latest.byteTokens.mem_total='999';assert.equal(validMonitorMetadata(backup),false);
});

test('real Agent report session preserves capacity tokens through live cache and standard browser socket',async t=>{
  const h=await createMonitorRuntimeFixture(t);
  await h.db.prepare("UPDATE settings SET value=json_set(value,'$.is_public','true') WHERE key='site_options'").run();
  const agent=await h.socket();send(agent,'cf.capabilities',{version:1,supports:[{method:'cf.report.batch',version:1}]},'cap');
  await until(()=>frames(agent).some(f=>f.id==='cap'));
  agent.ws.send('{"jsonrpc":"2.0","method":"report","params":{"cpu":5,"mem_total":9007199254740993,"mem_used":9007199254740993,"swap_total":9223372036854775807,"disk_total":9223372036854775807}}');
  await until(async()=> (await h.control('drain')).latest.some(([id,entry])=>id==='node-a' && entry.samples[0].data.monitor.byteTokens?.mem_total==='9007199254740993'));
  const raw=await (await h.fetch('/api/nodes')).text();assert.match(raw,/"mem_total":9007199254740993/);assert.match(raw,/"disk_total":9223372036854775807/);
  const viewer=await h.socket('/api/ws?monitor_protocol=1',null);await until(()=>viewer.messages.length>0);
  assert.match(viewer.messages[0],/"mem_total":9007199254740993/);assert.match(viewer.messages[0],/"swap_total":9223372036854775807/);
  const state=JSON.parse((await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first()).state);
  assert.equal(state.live.byteTokens.mem_total,'9007199254740993');
  const standard=await h.socket('/api/agent/ws','node-b');
  standard.ws.send('{"jsonrpc":"2.0","method":"report","params":{"mem_total":9007199254740993}}');
  await until(async()=> (await h.control('drain',{serverId:'node-b'})).latest.some(([id,entry])=>id==='node-b' && entry.samples[0].data.monitor.byteTokens?.mem_total==='9007199254740993'));
  await h.control('advance',{ms:1000});
  standard.ws.send('{"jsonrpc":"2.0","method":"report","params":{"mem_total":9007199254740993}}');
  await until(async()=>!!await h.db.prepare("SELECT server_id FROM monitor_telemetry_nodes WHERE server_id='node-b'").first());
  const standardState=JSON.parse((await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-b'").first()).state);
  assert.equal(standardState.latest.byteTokens.mem_total,'9007199254740993');
  evidence('agent-live',{http:raw,ws:viewer.messages[0],persistedTokens:state.live.byteTokens});
});
