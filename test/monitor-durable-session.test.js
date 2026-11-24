import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorRuntimeFixture, until, frames, send } from './fixtures/monitor-runtime.mjs';
import { readMonitorTelemetry } from '../src/database/monitorTelemetry.js';
import { changeLatencyTasks, readLatencyTaskDocument } from '../src/database/latencyTasks.js';
import { trafficCalendar } from '../src/services/monitorStatistics.js';

const supports = ['cf.report.batch','cf.ping.tasks','cf.reporting.configure'].map(method=>({method,version:1}));
const clock = {local_ts:Date.now(),accurate_ts:null,offset_ms:null,source:null,round_trip_ms:null,sample_age_ms:null};
const batch = (sequence=1) => ({version:1,stream:'session-test',sequence,clock,samples:[0,1].map(i=>({sampledAt:clock.local_ts+i*2000,elapsedMs:2000,report:{cpu:i?0:100,boot_id:'boot/eth',net_rx_total:100+i,net_tx_total:200+i},extra:{}})),probes:[]});

test('current WS commits atomic D1 ACK and disconnected same-origin HTTP replays original params', async t=>{
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  send(peer,'cf.capabilities',{version:1,supports},'caps');
  await until(()=>frames(peer).some(f=>f.id==='caps'));
  assert.deepEqual(frames(peer).find(f=>f.id==='caps').result.accepted,supports);
  assert.equal(frames(peer).find(f=>f.id==='caps').result.fallbackPath,'/api/agent/cf-report');
  const raw=JSON.stringify({jsonrpc:'2.0',method:'cf.report.batch',id:'batch',params:batch()});
  peer.ws.send(raw);await until(()=>frames(peer).some(f=>f.id==='batch'));
  const ack=frames(peer).find(f=>f.id==='batch').result;
  assert.equal(ack.durableThrough,1);
  const before=await readMonitorTelemetry(h.db,'node-a',{from:clock.local_ts-60000,to:clock.local_ts+60000});
  assert.equal(before.coverage.sampleCount,2);assert.equal(before.traffic.totalRx,'1');
  peer.ws.close();await until(()=>peer.ws.readyState===3);
  const response=await h.fetch('/api/agent/cf-report',{method:'POST',headers:{Authorization:`Bearer ${h.nodes['node-a'].token}`,'Content-Type':'application/json'},body:raw.replace('"batch"','"http"')});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).result,ack);
  assert.deepEqual(await readMonitorTelemetry(h.db,'node-a',{from:clock.local_ts-60000,to:clock.local_ts+60000}),before);
  assert.equal((await h.fetch('/api/agent/cf-report',{method:'POST',body:raw})).status,401);
});

test('actual CF WS and HTTP apply server reset31 without reporting intent or configuration ACK, clamping February',async t=> {
  const h=await createMonitorRuntimeFixture(t);await h.db.prepare("UPDATE servers SET reset_day=31 WHERE id='node-a'").run();
  const ts=Date.UTC(2026,1,28,12);
  const peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports},'caps');await until(()=>frames(peer).some(f=>f.id==='caps'));
  const params={...batch(),clock:{...clock,local_ts:ts},samples:[0,1].map(i=>({sampledAt:ts+i*1000,elapsedMs:1000,report:{boot_id:'b',net_rx_total:100+i,net_tx_total:0},extra:{}}))};
  send(peer,'cf.report.batch',params,'period');await until(()=>frames(peer).some(f=>f.id==='period'));
  assert.equal(frames(peer).find(f=>f.id==='period').result.durableThrough,1);
  assert.equal((await readMonitorTelemetry(h.db,'node-a',{from:ts,to:ts+2000})).traffic.monthStart,'2026-02-28');
  const next={...params,sequence:2,samples:[{...params.samples[1],sampledAt:ts+2000,report:{boot_id:'b',net_rx_total:102,net_tx_total:0}}]};
  const response=await h.fetch('/api/agent/cf-report',{method:'POST',headers:{Authorization:`Bearer ${h.nodes['node-a'].token}`},body:JSON.stringify({jsonrpc:'2.0',method:'cf.report.batch',id:'http-period',params:next})});
  assert.equal(response.status,200);assert.equal((await readMonitorTelemetry(h.db,'node-a',{from:ts,to:ts+3000})).traffic.monthStart,'2026-02-28');
  assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='monitor_reporting:node-a'").first(),null);
});

test('actual standard-only receiver applies server reset31 with no CF capabilities',async t=> {
  const h=await createMonitorRuntimeFixture(t);await h.db.prepare("UPDATE servers SET reset_day=31 WHERE id='node-a'").run();
  const peer=await h.socket();
  send(peer,'report',{cpu:8,boot_id:'b',net_rx_total:100,net_tx_total:0});await until(async()=>!!(await h.snapshot()).inputs[0]?.[1]?.latest);
  await new Promise(r=>setTimeout(r,550));send(peer,'report',{cpu:9,boot_id:'b',net_rx_total:101,net_tx_total:0});
  await until(async()=>!!await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first());await h.control('drain');
  const state=JSON.parse((await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first()).state);
  assert.equal(state.traffic.monthStart,trafficCalendar(state.traffic.observedAt,{resetDay:31}).monthStart);assert.equal(state.traffic.totalRx,'1');
});

test('reset-day config changed after captured calendar await rejects old-period admission; fresh retry uses new config',async t=> {
  const h=await createMonitorRuntimeFixture(t);await h.db.prepare("UPDATE servers SET reset_day=31 WHERE id='node-a'").run();
  const peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports},'caps');await until(()=>frames(peer).some(f=>f.id==='caps'));
  await h.control('fault',{pauseReset:true});send(peer,'cf.report.batch',batch(),'stale-reset');await until(async()=>(await h.snapshot()).fault.paused);
  await h.db.prepare("UPDATE servers SET reset_day=1 WHERE id='node-a'").run();await h.control('release');
  await until(()=>frames(peer).some(f=>f.id==='stale-reset'));
  assert.ok(frames(peer).find(f=>f.id==='stale-reset').error);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_receipts').first()).n,0);
  send(peer,'cf.report.batch',batch(),'fresh-reset');await until(()=>frames(peer).some(f=>f.id==='fresh-reset'));
  assert.equal(frames(peer).find(f=>f.id==='fresh-reset').result.durableThrough,1);
});

test('standard-only report and probe persist without CF receipt or public ACK',async t=>{
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  send(peer,'report',{cpu:100,boot_id:'boot/eth',net_rx_total:100,net_tx_total:200});
  await until(async()=>!!(await h.snapshot()).inputs[0]?.[1]?.latest);
  await new Promise(r=>setTimeout(r,550));
  send(peer,'report',{cpu:0,boot_id:'boot/eth',net_rx_total:101,net_tx_total:202});
  await until(async()=>JSON.parse((await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first())?.state||'null')?.traffic?.totalRx==='1');
  peer.ws.close();await until(()=>peer.ws.readyState===3);
  await until(async()=> (await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-60000,to:Date.now()+60000})).coverage.sampleCount>0);
  const core=await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-60000,to:Date.now()+60000});
  assert.equal(core.source,'standard');assert.ok(core.coverage.elapsedMs>0);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM monitor_telemetry_receipts').first()).n,0);
  assert.ok(!frames(peer).some(f=>f.result?.durableThrough));
});

test('single standard report end flush is durable',async t=>{
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  send(peer,'report',{cpu:42,boot_id:'single',net_rx_total:100,net_tx_total:100});
  await until(async()=>!!(await h.snapshot()).inputs[0]?.[1]?.latest);
  peer.ws.close();await until(()=>peer.ws.readyState===3);
  await until(async()=>!!await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first());
  const core=await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-60000,to:Date.now()+60000});
  assert.ok(core.rawSamples.some(s=>s.report.cpu===42));
});

test('CF task periods survive reconnect and retired generation accepts only its historical time range',async t=>{
  const h=await createMonitorRuntimeFixture(t);
  const doc=await changeLatencyTasks(h.db,{},'save',{name:'probe',target:'127.0.0.1:12345',interval:5,auto_join:false,nodes:['node-a']});
  const period=doc.monitorAssignments[0],metricId=doc.tasks[0].id;
  let peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports},'caps');await until(()=>frames(peer).some(f=>f.method==='cf.ping.tasks'));
  peer.ws.close();await until(()=>peer.ws.readyState===3);
  peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports},'caps');await until(()=>frames(peer).some(f=>f.method==='cf.ping.tasks'));
  assert.equal((await readLatencyTaskDocument(h.db)).monitorAssignments[0].assignedAt,period.assignedAt);
  await changeLatencyTasks(h.db,{},'delete',{id:metricId});
  const retired=(await readLatencyTaskDocument(h.db)).monitorAssignments[0];assert.ok(retired.retiredAt>=retired.assignedAt);
  const b=batch();b.samples=[];b.probes=[{taskId:1,metricId,sampledAt:period.assignedAt,latencyMs:-1}];
  send(peer,'cf.report.batch',b,'old-valid');await until(()=>frames(peer).some(f=>f.id==='old-valid'));
  assert.equal(frames(peer).find(f=>f.id==='old-valid').result?.durableThrough,1);
  const bad={...b,sequence:2,probes:[{...b.probes[0],sampledAt:retired.retiredAt}]};
  send(peer,'cf.report.batch',bad,'retired');await until(()=>frames(peer).some(f=>f.id==='retired'));
  assert.ok(frames(peer).find(f=>f.id==='retired').error);
});

test('probe transport handoff retains standard results until CF tasks confirmation, and incomplete CF probe profiles stay standard',async t=>{
  const h=await createMonitorRuntimeFixture(t);
  await changeLatencyTasks(h.db,{},'save',{name:'handoff',target:'127.0.0.1:12345',interval:5,auto_join:false,nodes:['node-a']});
  let peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports:[{method:'cf.report.batch',version:1}]},'incomplete');
  await until(()=>frames(peer).some(f=>f.id==='incomplete'));
  assert.deepEqual(frames(peer).find(f=>f.id==='incomplete').result.accepted,[]);
  send(peer,'cf.capabilities',{version:1,supports:[{method:'cf.ping.tasks',version:1},{method:'cf.reporting.configure',version:1}]},'no-batch');
  await until(()=>frames(peer).some(f=>f.id==='no-batch'));
  assert.deepEqual(frames(peer).find(f=>f.id==='no-batch').result.accepted,[]);
  peer.ws.close();await until(()=>peer.ws.readyState===3);
  peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports},'cap');
  await until(()=>frames(peer).some(f=>f.method==='cf.ping.tasks'));
  send(peer,'ping.result',{task_id:1,latency_ms:42});
  await until(async()=> (await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-60000,to:Date.now()+60000})).coverage.probeCount===1);
  const job=frames(peer).find(f=>f.method==='cf.ping.tasks');
  peer.ws.send(JSON.stringify({jsonrpc:'2.0',id:job.id,result:{version:1,revision:job.params.revision,persisted:true,taskCount:1}}));
  await until(async()=>!!(await h.snapshot()).owners[0][1].tasksApplied);
  send(peer,'ping.result',{task_id:1,latency_ms:99});send(peer,'report',{cpu:1});
  await until(async()=> (await h.snapshot()).inputs[0]?.[1]?.latest?.report?.cpu===1);
  const core=await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-60000,to:Date.now()+60000});
  assert.equal(core.coverage.probeCount,1);assert.equal(core.probeSeries[0].samples[0].source,'standard');
});

test('real WS and HTTP expose safe gap expectedSequence, conflict and D1 failure as matching RPC errors',async t=>{
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  send(peer,'cf.capabilities',{version:1,supports},'caps');await until(()=>frames(peer).some(f=>f.id==='caps'));
  const post=(params,id)=>h.fetch('/api/agent/cf-report',{method:'POST',headers:{Authorization:`Bearer ${h.nodes['node-a'].token}`,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',method:'cf.report.batch',id,params})});
  send(peer,'cf.report.batch',batch(2),'ws-gap');await until(()=>frames(peer).some(f=>f.id==='ws-gap'));
  const wsGap=frames(peer).find(f=>f.id==='ws-gap');
  const httpGap=await post(batch(2),'http-gap');assert.equal(httpGap.status,409);
  assert.deepEqual((await httpGap.json()).error,wsGap.error);
  assert.equal(wsGap.error.code,-32602);assert.equal(wsGap.error.message,'monitor_sequence_gap expectedSequence=1');
  assert.deepEqual(Object.keys(wsGap.error).sort(),['code','message']);
  send(peer,'cf.report.batch',batch(),'one');await until(()=>frames(peer).some(f=>f.id==='one'));
  const conflict=batch();conflict.samples[0].extra={gpu:[{id:'dummy',info:0,name:h.nodes['node-a'].token}]};
  send(peer,'cf.report.batch',conflict,'ws-conflict');await until(()=>frames(peer).some(f=>f.id==='ws-conflict'));
  const httpConflict=await post(conflict,'http-conflict');assert.equal(httpConflict.status,409);
  assert.deepEqual((await httpConflict.json()).error,frames(peer).find(f=>f.id==='ws-conflict').error);
  assert.equal(frames(peer).find(f=>f.id==='ws-conflict').error.message,'monitor_receipt_conflict');
  send(peer,'cf.report.batch',batch(3),'ws-gap2');await until(()=>frames(peer).some(f=>f.id==='ws-gap2'));
  const secondGap=await post(batch(3),'http-gap2');assert.equal(secondGap.status,409);
  assert.deepEqual((await secondGap.json()).error,frames(peer).find(f=>f.id==='ws-gap2').error);
  assert.equal(frames(peer).find(f=>f.id==='ws-gap2').error.message,'monitor_sequence_gap expectedSequence=2');
  await h.control('fault',{telemetryRead:true});
  send(peer,'cf.report.batch',batch(2),'ws-d1');await until(()=>frames(peer).some(f=>f.id==='ws-d1'));
  const failure=await post(batch(2),'http-d1');assert.equal(failure.status,500);
  assert.deepEqual((await failure.json()).error,frames(peer).find(f=>f.id==='ws-d1').error);
  assert.equal(frames(peer).find(f=>f.id==='ws-d1').error.code,-32603);
  assert.equal(frames(peer).find(f=>f.id==='ws-d1').error.message,'monitor_persistence_unavailable');
  await h.control('fault',{telemetryRead:false,pauseAuthorityNode:'node-a'});
  const denied=post(batch(2),'http-permission');
  await until(async()=>(await h.snapshot()).fault.paused);
  await h.db.prepare("UPDATE terminal_nodes SET token_version=2 WHERE server_id='node-a'").run();
  await h.control('release');const permission=await denied;
  assert.equal(permission.status,403);
  assert.deepEqual((await permission.json()).error,{code:-32001,message:'monitor_authority_denied'});
  assert.ok(!peer.messages.join('').includes(h.nodes['node-a'].token));
  assert.equal((await h.db.prepare('SELECT count(*) n FROM monitor_telemetry_receipts').first()).n,1);
  t.diagnostic(JSON.stringify({gap:wsGap.error,nextExpected:2,conflict:frames(peer).find(f=>f.id==='ws-conflict').error,d1:frames(peer).find(f=>f.id==='ws-d1').error,httpStatus:[409,409,500,403]}));
});
