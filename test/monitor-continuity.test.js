import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,invoke,frame,sample,principal,session,at } from './helpers/monitorTelemetry.js';
import { getLatestMetrics, getLatestMetricsForAllServers, getLatestTimestampsForAllServers, getMetricsHistory, getDashboardLatencyHistory } from '../src/database/schema.js';
import { loadMonitorCompatHistory } from '../src/services/monitorCompatHistory.js';
import { getMonitorCompatIds } from '../src/database/monitorCompatIds.js';
import { clearAllCaches } from '../src/utils/cache.js';
import { createHistoryTableSql } from '../src/utils/historyFields.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { mergeMetricsIntoServer } from '../src/utils/metrics.js';
import { monitorReceiptText } from '../src/shared/monitorTelemetry.js';
import { createMonitorRuntimeFixture,send,frames,until } from './fixtures/monitor-runtime.mjs';
import { exportMonitorMetadata,importMonitorMetadata,validMonitorMetadata } from '../src/database/monitorBackup.js';
import { projectMonitorLatest } from '../src/database/monitorTelemetry.js';
import { evaluateTrafficAlert } from '../src/services/notification.js';
import { handleServerAPI,handleServersAPI } from '../src/handlers/dashboard.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';

async function legacy(db) {
  await db.prepare('ALTER TABLE servers ADD COLUMN sort_order INTEGER DEFAULT 0').run();
  await db.prepare('ALTER TABLE servers ADD COLUMN timestamp INTEGER DEFAULT 0').run();
  await db.prepare(createHistoryTableSql('metrics_history')).run();
  await db.prepare('INSERT INTO metrics_history(id,server_id,timestamp,net_rx_monthly,net_tx_monthly,cpu,ram_used) VALUES(?,?,?,?,?,?,?)')
    .bind(buildHistoryId(777,at-1000),'uuid-a',at-1000,1000,2000,55,17).run();
}

test('real hello reported IP facts reach CF private admin and latest, while public REST and realtime mask addresses and empty stays placeholder',async t=> {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  send(peer,'cf.capabilities',{version:1,supports:['cf.report.batch','cf.ping.tasks','cf.reporting.configure'].map(method=>({method,version:1}))},'caps');
  await until(()=>frames(peer).some(f=>f.id==='caps'));
  send(peer,'hello',{ipv4:'192.0.2.42',ipv6:'2001:db8::42',os:'fixture'});send(peer,'report',{cpu:12});
  await until(async()=>!!await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first());await h.control('drain');
  const latest=await getLatestMetrics(h.db,'node-a'),server={};mergeMetricsIntoServer(server,latest);
  assert.deepEqual([server.ip_v4,server.ip_v6],['192.0.2.42','2001:db8::42']);
  assert.equal(server.load_avg,null);
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {fetch:async(url,init)=>Response.json(await h.control('latest',JSON.parse(init.body)))};}}},sys={jwt_secret:'s'.repeat(64),is_public:'true'},token=await generateToken(env,sys);
  const admin=await handleAdminAPI(new Request('https://example.com/admin/api',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'list',metadataIds:['node-a'],metadataRefresh:true})}),env,sys,null,{waitUntil(){}});
  const adminNode=(await admin.json()).metadata['node-a'];assert.deepEqual([adminNode.ip_v4,adminNode.ip_v6],['192.0.2.42','2001:db8::42']);
  const publicOne=await (await handleServerAPI(new Request('https://example.com/api/server?id=node-a'),env,sys)).json();
  const publicAll=await (await handleServersAPI(new Request('https://example.com/api/servers'),env,sys)).json();
  assert.deepEqual([publicOne.ip_v4,publicOne.ip_v6],['1','1']);
  assert.equal(publicOne.load_avg,null);
  assert.deepEqual([publicOne.latestReportUpdates[0].samples[0].data.ip_v4,publicOne.latestReportUpdates[0].samples[0].data.ip_v6],['1','1']);
  assert.equal(JSON.stringify([publicOne,publicAll]).includes('192.0.2.42'),false);assert.equal(JSON.stringify([publicOne,publicAll]).includes('2001:db8::42'),false);
  send(peer,'hello',{ipv4:'',ipv6:''});await h.control('drain');
  const ts=Date.now()+61000;
  send(peer,'cf.report.batch',JSON.parse(frame(1,{samples:[{...sample('100',ts),report:{cpu:13}}],probes:[]})).params,'empty');
  await until(()=>frames(peer).some(f=>f.id==='empty'));assert.equal(frames(peer).find(f=>f.id==='empty').result.durableThrough,1);
  const empty=await getLatestMetrics(h.db,'node-a');const emptyServer={};mergeMetricsIntoServer(emptyServer,empty);
  assert.deepEqual([emptyServer.ip_v4,emptyServer.ip_v6],['0','0']);
  const known=projectMonitorLatest('node-a',{latest:{sampledAt:ts,elapsedMs:0,report:{load:[0.1,0.2,0.3]},source:'cf-live'}}),knownServer={};
  mergeMetricsIntoServer(knownServer,known);assert.equal(knownServer.load_avg,'0.1 0.2 0.3');
  const legacyServer={};mergeMetricsIntoServer(legacyServer,{load_avg:null});assert.equal(legacyServer.load_avg,'0 0 0');
  t.diagnostic(JSON.stringify({privateReported:[latest.ip_v4,latest.ip_v6],publicMask:[publicOne.ip_v4,publicOne.ip_v6],
    realtimeMask:[publicOne.latestReportUpdates[0].samples[0].data.ip_v4,publicOne.latestReportUpdates[0].samples[0].data.ip_v6],
    emptyPlaceholder:[emptyServer.ip_v4,emptyServer.ip_v6],nativeLoad:publicOne.load_avg,knownLoad:knownServer.load_avg,legacyLoad:legacyServer.load_avg}));
});

test('actual owner legacy rollback history remains in shared/dashboard/compat reads after native return, without duplicate native coverage',async t=> {
  const h=await createMonitorRuntimeFixture(t),minute=Math.floor(Date.now()/60000)*60000;
  const firstTs=minute-40*60000,rollbackTs=minute-20*60000,lastTs=minute-5*60000;
  const post=async(cpu,ts,ping=17)=>{
    const response=await h.post({id:'node-a',metrics:{cpu:String(cpu),timestamp:ts,ram_used:17,disk_used:21,net_in_speed:10,net_out_speed:20,ping_ct:String(ping)}});
    assert.equal(response.status,200);
  };
  await post(11,firstTs-60000);
  const native=async()=>{const p=await h.socket();send(p,'cf.capabilities',{version:1,supports:['cf.report.batch','cf.ping.tasks','cf.reporting.configure'].map(method=>({method,version:1}))},'caps');await until(()=>frames(p).some(f=>f.id==='caps'));return p;};
  const first=await native();
  send(first,'cf.report.batch',JSON.parse(frame(1,{samples:[{...sample('100',firstTs+1000),report:{cpu:22}}],probes:[]})).params,'first');
  await until(()=>frames(first).some(f=>f.id==='first'));assert.equal(frames(first).find(f=>f.id==='first').result.durableThrough,1);
  first.ws.close();await until(()=>first.ws.readyState===3);await h.control('drain');
  await post(33,rollbackTs,19);
  await post(99,firstTs+2000,99); // The physical legacy row overlaps native's first minute and must not double count.
  const returned=await native();send(returned,'cf.report.batch',JSON.parse(frame(2,{samples:[{...sample('101',lastTs+1000),report:{cpu:44}}],probes:[]})).params,'returned');
  await until(()=>frames(returned).some(f=>f.id==='returned'));assert.equal(frames(returned).find(f=>f.id==='returned').result.durableThrough,2);
  const rows=await getMetricsHistory(h.db,'node-a',1,'cpu,ram_used,ping_ct,loss_ct');
  const rollback=rows.find(r=>r.timestamp===rollbackTs);assert.ok(rollback,'rollback row must survive the first activation boundary');
  assert.equal(rollback.cpu,33);assert.equal(rollback.monitor.source,'metrics_history');assert.equal(rollback.monitor.precision,'legacy-MiB/summary');
  assert.equal(rollback.loss_ct,null);assert.equal(rows.some(r=>r.cpu===99),false);
  assert.deepEqual(rows.filter(r=>r.monitor?.resource).map(r=>r.cpu),[22,44]);
  for(const hours of [6,48]) {
    const longRows=await getMetricsHistory(h.db,'node-a',hours,'cpu,ram_used,ping_ct,loss_ct');
    assert.ok(longRows.some(r=>r.timestamp===rollbackTs && r.cpu===33),`rollback retained in sparse ${hours}h query`);
    assert.equal(longRows.some(r=>r.cpu===99),false);
  }
  // Rotation changes the physical source, not the rollback point's precision or availability.
  await h.db.prepare("CREATE TABLE metrics_history_old AS SELECT * FROM metrics_history WHERE 0").run();
  const rotatedTs=minute-3*86400000;
  await h.db.prepare('INSERT INTO metrics_history_old(id,server_id,timestamp,cpu,ram_used,ping_ct,loss_ct) SELECT ?,server_id,?,cpu,ram_used,ping_ct,loss_ct FROM metrics_history WHERE timestamp=?')
    .bind(buildHistoryId(1,rotatedTs),rotatedTs,rollbackTs).run();
  const rotated=await getMetricsHistory(h.db,'node-a',168,'cpu,ram_used,ping_ct,loss_ct');
  assert.ok(rotated.some(r=>r.timestamp===rotatedTs && r.monitor?.source==='metrics_history_old'));
  const server=await h.db.prepare("SELECT * FROM servers WHERE id='node-a'").first();
  const dashboard=(await getDashboardLatencyHistory(h.db,[server],{cache:false})).get('node-a');
  assert.ok(dashboard.ping.some(p=>p.ct===19 && p.monitor?.source==='metrics_history'),'dashboard retains rollback legacy latency source');
  const id=(await getMonitorCompatIds(h.db,['node-a'])).get('node-a');
  const compat=await loadMonitorCompatHistory(h.db,id,new URLSearchParams('hours=1&series=metrics'));
  assert.ok(compat.metrics.some(p=>p.cpu===33 && p.monitor?.source==='metrics_history'),'compat history must consume the same rollback source');
  t.diagnostic(JSON.stringify({history:rows.map(r=>({ts:r.timestamp,cpu:r.cpu,source:r.monitor?.source,precision:r.monitor?.precision,loss:r.loss_ct})),
    rollbackDashboard:dashboard.ping.filter(p=>p.ct===19),rollbackCompat:compat.metrics.filter(p=>p.cpu===33),
    rotatedHistory:rotated.filter(r=>r.timestamp===rotatedTs).map(r=>({ts:r.timestamp,cpu:r.cpu,source:r.monitor.source})),nativeOverlapRemoved:!rows.some(r=>r.cpu===99)}));
});

test('known legacy month seeds only a proven same-period baseline; switching back never rebooks or renumbers',async t=> {
  const h=await fixture(t);await legacy(h.db);
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(1,{samples:[sample('100',at),sample('101',at+1000)],probes:[]}));
  let core=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-1,to:at+2000});
  assert.equal(core.traffic.monthRx,'1001');assert.equal(core.traffic.totalRx,'1');
  assert.equal(core.migration.knownMonth.rx,'1000');assert.equal(core.migration.knownMonth.precision,'legacy-number');
  await invoke('markMonitorLegacy',h.db,principal.serverId,2);
  await h.db.prepare('UPDATE metrics_history SET net_rx_monthly=999999').run();
  await invoke('recordMonitorBatch',h.env,principal,session({generation:3}),frame(2,{samples:[sample('10000',at+2000),sample('10001',at+3000)],probes:[]}));
  core=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at,to:at+5000});
  assert.equal(core.traffic.totalRx,'2');assert.equal(core.traffic.monthRx,'1002');
  assert.equal((await h.db.prepare('SELECT history_partition_id FROM servers').first()).history_partition_id,777);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM metrics_history').first()).n,1);
  assert.equal(core.migration.transitions,2);
});

test('fractional legacy month remains retrievable at original precision without inventing exact native bytes',async t=> {
  const h=await fixture(t);await legacy(h.db);
  await h.db.prepare('UPDATE metrics_history SET net_rx_monthly=1000.5').run();
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(1,{samples:[sample('100',at),sample('101',at+1000)],probes:[]}));
  const core=await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:at-1,to:at+2000});
  assert.equal(core.migration.knownMonth.rx,'1000.5');assert.equal(core.traffic.monthRx,'1');
  const latest=await getLatestMetrics(h.db,'uuid-a');assert.equal(latest.net_rx_monthly,null);
  assert.equal(latest.monitor.month.source,'unknown-legacy-baseline');
  const live=projectMonitorLatest('uuid-a',{latest:core.latest,traffic:core.traffic,migration:core.migration});
  assert.equal(live.net_tx_monthly,null);
  await h.db.prepare('UPDATE metrics_history SET net_rx_monthly=9007199254740992').run();
  await h.db.prepare('DELETE FROM monitor_telemetry_nodes').run();
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(1,{stream:'unsafe-month',samples:[sample('100',at),sample('101',at+1000)],probes:[]}));
  assert.equal((await getLatestMetrics(h.db,'uuid-a')).net_rx_monthly,null);
});

test('unknown legacy month prevents native traffic alert recovery from consuming a partial month',async t=> {
  const h=await fixture(t);await legacy(h.db);const prior='{"schema":2,"rules":{"traffic":{"u":1001}}}';
  await h.db.prepare('ALTER TABLE servers ADD COLUMN traffic_alert_state TEXT').run();
  await h.db.prepare('UPDATE servers SET traffic_alert_state=?').bind(prior).run();
  await h.db.prepare('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)').run();
  await h.db.prepare("INSERT INTO settings VALUES('site_options',?)").bind(JSON.stringify({jwt_secret:'s'.repeat(64)})).run();
  await h.db.prepare("INSERT INTO settings VALUES('notification_config',?)").bind(JSON.stringify({schema:1,revision:1,timezone:'UTC',language:'en',channels:[],
    rules:[{id:'traffic',name:'traffic',type:'traffic',enabled:true,scope:{mode:'all',serverIds:[]},targetIds:[],options:{threshold:80}}]})).run();
  await h.db.prepare('UPDATE metrics_history SET net_rx_monthly=1000.5').run();
  await invoke('recordMonitorBatch',h.env,principal,session(),frame());
  await evaluateTrafficAlert(h.env,{id:'uuid-a',traffic_limit:'100',traffic_calc_type:'total',traffic_alert_percent:null},{net_rx_monthly:1,net_tx_monthly:0});
  assert.equal((await h.db.prepare('SELECT traffic_alert_state FROM servers').first()).traffic_alert_state,prior);
});

test('compaction commits only while all cached raw fragments are still unconsumed; failure rolls back rollup and raw',async t=> {
  const h=await fixture(t),base=at-10*86400000;
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(1,{samples:[{...sample('100',base),elapsedMs:60000}],probes:[]}));
  let reached,release;const paused=new Promise(r=>reached=r),gate=new Promise(r=>release=r);let held=false;
  const delayed=new Proxy(h.db,{get(db,key){
    if(key==='prepare')return sql=>{const s=db.prepare(sql);if(!sql.startsWith('SELECT revision,payload FROM monitor_telemetry_rollups'))return s;
      return {bind(...v){const b=s.bind(...v);return {async first(){if(!held){held=true;reached();await gate;}return b.first();}};}};};
    return typeof db[key]==='function'?db[key].bind(db):db[key];
  }});
  const second=invoke('maintainMonitorTelemetry',delayed,{now:at});await paused;
  await invoke('maintainMonitorTelemetry',h.db,{now:at});const before=await h.db.prepare('SELECT * FROM monitor_telemetry_rollups').all();release();
  await assert.rejects(()=>second);assert.deepEqual(await h.db.prepare('SELECT * FROM monitor_telemetry_rollups').all().then(r=>r.results),before.results);
  assert.equal((await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:base,to:base+3600000})).coverage.elapsedMs,60000);
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(2,{samples:[sample('101',base+1000)],probes:[]}));
  await h.db.prepare("CREATE TRIGGER reject_rollup BEFORE UPDATE ON monitor_telemetry_rollups BEGIN SELECT RAISE(ABORT,'injected rollup failure'); END").run();
  await assert.rejects(()=>invoke('maintainMonitorTelemetry',h.db,{now:at}),/injected rollup failure/);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_buckets').first()).n,1);
});

test('atomic calendar gate rejects a reset edit between final guard and D1 batch without a receipt',async t=> {
  const h=await fixture(t);await h.db.prepare('UPDATE servers SET reset_day=31').run();
  const db=new Proxy(h.db,{get(db,key){if(key==='batch')return async statements=>{
    await h.db.prepare('UPDATE servers SET reset_day=1').run();return db.batch(statements);
  };return typeof db[key]==='function'?db[key].bind(db):db[key];}});
  await assert.rejects(()=>invoke('recordMonitorBatch',{DB:db},principal,session({calendar:{resetDay:31},calendarResetDay:31}),frame()),/CHECK/);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_receipts').first()).n,0);
});

test('backup validates authoritative ledger/time/period/state and internal identity uniqueness before any restore write',async t=> {
  const h=await fixture(t);await invoke('recordMonitorBatch',h.env,principal,session(),frame());
  const original=await exportMonitorMetadata(h.db,['uuid-a']);
  const mutations=[b=>b.nodes[0].state.traffic.totalRx='-1',b=>b.nodes[0].state.traffic.dayTx='9223372036854775808',
    b=>b.nodes[0].state.traffic.rx='1.5',b=>b.nodes[0].state.traffic.monthStart='2026-02-30',
    b=>b.nodes[0].state.traffic.observedAt=-1,b=>b.nodes[0].state.latest.sampledAt=1.5,
    b=>b.nodes[0].state.networkMark.pendingElapsedMs=-2,b=>b.nodes[0].state.latest.report.cpu=-1,
    b=>b.ids=[{id:43,server_id:'a'},{id:43,server_id:'b'}],b=>b.ids=[{id:43,server_id:'a'},{id:44,server_id:'a'}],
    b=>b.probeIds=[{id:1,metric_id:'p_a'},{id:1,metric_id:'p_b'}],b=>b.nodes.push(structuredClone(b.nodes[0]))];
  const before=await h.db.prepare('SELECT * FROM monitor_telemetry_nodes').all();
  for(const mutate of mutations){const b=structuredClone(original);mutate(b);assert.equal(validMonitorMetadata(b),false);await assert.rejects(()=>importMonitorMetadata(h.db,b,['uuid-a']),/Invalid monitor metadata/);}
  assert.deepEqual((await h.db.prepare('SELECT * FROM monitor_telemetry_nodes').all()).results,before.results);
  await invoke('recordMonitorStandard',h.env,principal,session(),{report:{cpu:8,boot_id:'boot',net_rx_total:'1.5',net_tx_total:'9223372036854775808'},receivedAt:at+5000});
  assert.equal(validMonitorMetadata(await exportMonitorMetadata(h.db,['uuid-a'])),true);
});

test('collect0 live survives D1 rebuild, refreshes actual shared callers, and creates no resource history or traffic',async t=> {
  const h=await fixture(t);await legacy(h.db);clearAllCaches();t.after(clearAllCaches);
  await getLatestMetricsForAllServers(h.db);
  const now=Date.now();
  await invoke('recordMonitorLive',h.env,principal,session(),{report:{cpu:71,mem_total:1048576,mem_used:524288},facts:{os:'Fixture OS'},receivedAt:now});
  const latest=await getLatestMetrics(h.db,'uuid-a');assert.equal(latest.cpu,71);assert.equal(latest.ram_used,0.5);
  assert.equal(latest.net_rx_monthly,null);assert.equal(latest.monitor.source,'cf-live');
  assert.equal((await getLatestMetricsForAllServers(h.db)).get('uuid-a').timestamp,now);
  assert.equal((await getLatestTimestampsForAllServers(h.db)).get('uuid-a'),now);
  const core=await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:now-1000,to:now+1000});
  assert.equal(core.rawSamples.length,0);assert.equal(core.traffic,null);assert.equal(core.latest.report.cpu,71);
  assert.deepEqual(await getMetricsHistory(h.db,'uuid-a',1,'cpu'),[]);
});

test('native extras reach existing CF latest/history consumers with weighted disk and last GPU snapshot, preserving unknown',async t=> {
  const h=await fixture(t);await legacy(h.db);const now=Date.now(),minute=Math.floor(now/60000)*60000-120000;
  const gpu=[{id:'0',name:'fixture GPU',info:73,mem_used:128,mem_total:2048,power:null}];
  const io={read_bps:100,write_bps:80,read_iops:3,write_iops:4,await_ms:2,util:17};
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(1,{samples:[
    {...sample('100',minute+1000),elapsedMs:1000,extra:{diskIO:io,gpu}},
    {...sample('101',minute+2000),elapsedMs:3000,extra:{diskIO:{...io,read_bps:300},gpu}}
  ],probes:[]}));
  let latest=await getLatestMetrics(h.db,'uuid-a'),server={};mergeMetricsIntoServer(server,latest);
  assert.equal(server.disk.read_bps,300);assert.equal(server.disk_read_bps,300);assert.equal(JSON.parse(server.gpu_info)[0].mem_used,128);
  let rows=await getMetricsHistory(h.db,'uuid-a',1,'disk_read_bps, gpu_info');const row=rows.find(r=>r.timestamp===minute);
  assert.equal(row.disk_read_bps,250);assert.deepEqual(JSON.parse(row.gpu_info),gpu);assert.equal(row.monitor.gpu.source,'last-observed-snapshot');
  await invoke('recordMonitorLive',h.env,principal,session(),{report:{cpu:20},receivedAt:now});
  latest=await getLatestMetrics(h.db,'uuid-a');assert.equal(latest.disk_read_bps,300);
  await invoke('maintainMonitorTelemetry',h.db,{now:minute+8*86400000});
  const historical=await invoke('readMonitorHistoryRows',h.db,'uuid-a',{from:minute,to:minute+3600000,step:3600});
  assert.equal(historical[0].disk_read_bps,250);assert.deepEqual(JSON.parse(historical[0].gpu_info),gpu);
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(2,{samples:[{...sample('102',now+1000),extra:{diskIO:null,gpu:null}}],probes:[]}));
  latest=await getLatestMetrics(h.db,'uuid-a');server={};mergeMetricsIntoServer(server,latest);
  assert.equal(latest.disk_read_bps,null);assert.equal(server.gpu_info,null);assert.equal(server.disk,undefined);
});

test('expired derived raw materializes weighted hours, merges late reopened hours, and retains exact receipt replay forever',async t=> {
  const h=await fixture(t),base=at-10*86400000;
  const raw=frame(1,{samples:[{...sample('100',base),elapsedMs:1000,report:{cpu:100}},
    {...sample('100',base+1000),elapsedMs:59000,report:{cpu:0}}],probes:[10,20,-1].map((latencyMs,i)=>({taskId:1,metricId:'p_a',sampledAt:base+i*1000,latencyMs}))});
  const ack=await invoke('recordMonitorBatch',h.env,principal,session(),raw);
  await invoke('maintainMonitorTelemetry',h.db,{now:at});
  let core=await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:base,to:base+3600000,step:3600});
  assert.equal(core.resourceBuckets[0].fields.cpu.mean,100/60);assert.equal(core.resourceBuckets[0].fields.cpu.max,100);
  assert.equal(core.rawSamples.length,0);assert.equal(core.probeSeries[0].attempts,3);assert.equal(core.probeSeries[0].timeouts,1);
  assert.equal(core.coverage.rawAvailable,false);
  assert.deepEqual(await invoke('recordMonitorBatch',h.env,principal,session(),raw),ack);
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(2,{samples:[{...sample('100',base+2000),elapsedMs:1000,report:{cpu:100}}],probes:[]}));
  const reopened=await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:base,to:base+60000});
  assert.equal(reopened.resourceBuckets.length,1);assert.equal(reopened.resourceBuckets[0].fields.cpu.mean,200/61);
  await invoke('maintainMonitorTelemetry',h.db,{now:at});
  core=await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:base,to:base+3600000,step:3600});
  assert.equal(core.resourceBuckets[0].fields.cpu.mean,200/61);assert.equal(core.resourceBuckets[0].coverageMs,61000);
  await invoke('maintainMonitorTelemetry',h.db,{now:at+31*86400000});
  assert.deepEqual(await invoke('recordMonitorBatch',h.env,principal,session(),raw),ack);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM monitor_telemetry_receipts').first()).n,2);
});

test('optimized schema migrates already ACKed S1/S2 buckets in-place and reads original uncompressed fragments',async t=> {
  const h=await fixture(t);
  await invoke('recordMonitorBatch',h.env,principal,session(),frame());
  const before=await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:at-1,to:at+60000});
  // Recreate the accepted S1/S2 physical table/UTF-8 encoding, not merely an empty old schema.
  const row=await h.db.prepare('SELECT * FROM monitor_telemetry_buckets').first();
  const receipt=await h.db.prepare('SELECT params FROM monitor_telemetry_receipts').first();
  await h.db.batch([
    h.db.prepare('ALTER TABLE monitor_telemetry_buckets RENAME TO preserved_native_buckets'),
    h.db.prepare(`CREATE TABLE monitor_telemetry_buckets(server_id TEXT,token_version INTEGER,stream TEXT,sequence INTEGER,
      part INTEGER,bucket_start INTEGER,min_ts INTEGER,max_ts INTEGER,payload BLOB,PRIMARY KEY(server_id,token_version,stream,sequence,part)) WITHOUT ROWID`),
    h.db.prepare('INSERT INTO monitor_telemetry_buckets VALUES(?,?,?,?,?,?,?,?,?)').bind(row.server_id,row.token_version,row.stream,row.sequence,0,row.bucket_start,row.min_ts,row.max_ts,
      new TextEncoder().encode(JSON.stringify({samples:before.rawSamples,probes:before.probeSeries.flatMap(p=>p.samples.map(({timeout,...p})=>p))}))),
    h.db.prepare('DROP TABLE preserved_native_buckets'),
    h.db.prepare('UPDATE monitor_telemetry_receipts SET params=?').bind(await monitorReceiptText(receipt.params))
  ]);
  await invoke('ensureMonitorTelemetrySchema',h.db);
  const pk=(await h.db.prepare('PRAGMA table_info(monitor_telemetry_buckets)').all()).results.filter(r=>r.pk).sort((a,b)=>a.pk-b.pk).map(r=>r.name);
  assert.deepEqual(pk,['server_id','max_ts','token_version','stream','sequence','part']);
  await invoke('ensureMonitorTelemetrySchema',h.db);
  assert.deepEqual(await invoke('readMonitorTelemetry',h.db,'uuid-a',{from:at-1,to:at+60000}),before);
  assert.equal((await invoke('recordMonitorBatch',h.env,principal,session(),frame())).durableThrough,1);
});

test('native caller merge keeps unknown measurements null instead of legacy default zero',()=> {
  const server={};mergeMetricsIntoServer(server,{cpu:9,ram_used:null,net_rx_monthly:null,monitor:{source:'cf-live'}});
  assert.equal(server.ram_used,null);assert.equal(server.net_rx_monthly,null);assert.equal(server.monitor.source,'cf-live');
});

test('real collect0 WS checkpoints no raw history and resource alert consumer reconstructs weighted native minutes',async t=> {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket(),supports=['cf.report.batch','cf.ping.tasks','cf.reporting.configure'].map(method=>({method,version:1}));
  send(peer,'cf.capabilities',{version:1,supports},'caps');await until(()=>frames(peer).some(f=>f.id==='caps'));
  send(peer,'hello',{os:'Test system'});send(peer,'report',{cpu:71,mem_total:1048576,mem_used:524288});
  await until(async()=>!!await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first());
  await h.control('rebuild');
  const latest=await getLatestMetrics(h.db,'node-a');assert.equal(latest.cpu,71);assert.equal(latest.os,'Test system');
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM monitor_telemetry_buckets').first()).n,0);
  const minute=Math.floor(Date.now()/60000)*60000,samples=[];
  for(let m=4;m>=0;m--)samples.push({sampledAt:minute-m*60000+1000,elapsedMs:60000,report:{cpu:90},extra:{}});
  send(peer,'cf.report.batch',JSON.parse(frame(1,{samples,probes:[]})).params,'history');
  await until(()=>frames(peer).some(f=>f.id==='history'));assert.equal(frames(peer).find(f=>f.id==='history').result.durableThrough,1);
  const response=await h.control('resource',{rules:[{ruleId:'native',serverIds:['node-a'],windowMinutes:5,mode:'average',thresholds:{cpuPercent:80}}]});
  assert.equal(response.results[0].alerts[0].serverId,'node-a');assert.equal(response.results[0].alerts[0].metrics[0].avg,90);
});

test('metadata backup restores reserved identities and ledger with fresh authority, never revives revoked credentials',async t=> {
  const h=await fixture(t);await legacy(h.db);
  await h.db.prepare('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)').run();
  await h.db.prepare("INSERT INTO settings VALUES('monitor_reporting:uuid-a','{\"version\":1}')").run();
  await h.db.prepare('CREATE TABLE monitor_compat_ids(id INTEGER PRIMARY KEY,server_id TEXT UNIQUE)').run();
  await h.db.prepare("INSERT INTO monitor_compat_ids VALUES(43,'uuid-a')").run();
  await h.db.prepare('CREATE TABLE monitor_probe_ids(id INTEGER PRIMARY KEY,metric_id TEXT UNIQUE)').run();
  await h.db.prepare("INSERT INTO monitor_probe_ids VALUES(27,'p_a')").run();
  await invoke('recordMonitorBatch',h.env,principal,session(),frame());
  const backup=await invoke('exportMonitorMetadata',h.db,['uuid-a']);
  assert.equal(backup.nodes[0].state.traffic.totalRx,'1');assert.equal(backup.ids[0].id,43);
  assert.equal(JSON.stringify(backup).includes('token_hash'),false);assert.equal(JSON.stringify(backup).includes('params'),false);
  await h.db.prepare('UPDATE terminal_nodes SET token_version=5').run();
  await h.db.prepare('DELETE FROM monitor_telemetry_nodes').run();
  await invoke('importMonitorMetadata',h.db,backup,['uuid-a']);
  const node=await h.db.prepare('SELECT * FROM monitor_telemetry_nodes').first();assert.equal(node.token_version,5);
  assert.equal(node.active_stream,'');assert.equal(JSON.parse(node.state).traffic.totalRx,'1');
  await assert.rejects(()=>invoke('recordMonitorBatch',h.env,principal,session(),frame()),/authority/);
  assert.equal((await h.db.prepare('SELECT id FROM monitor_compat_ids').first()).id,43);
});
