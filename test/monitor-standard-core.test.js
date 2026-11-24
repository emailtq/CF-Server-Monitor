import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, session, invoke, frame, sample } from './helpers/monitorTelemetry.js';

test('standard held receiver intervals split minutes and days while missing restart coverage is not fabricated',async t=>{
  const h=await fixture(t),s=session(),at=Date.UTC(2026,10,24,23,59,59);
  const report={cpu:100,boot_id:'k/nic',net_rx_total:'9007199254740992',net_tx_total:'0',uptime:3600};
  await invoke('recordMonitorStandard',h.env,principal,s,{report,receivedAt:at});
  await invoke('recordMonitorStandard',h.env,principal,s,{held:{report,elapsedMs:2000},receivedAt:at+2000});
  await invoke('recordMonitorStandard',h.env,principal,s,{report:{...report,cpu:0,net_rx_total:'9007199254740993'},receivedAt:at+2000});
  await invoke('recordMonitorStandard',h.env,principal,s,{held:{report:{...report,cpu:0,net_rx_total:'9007199254740993'},elapsedMs:58000},receivedAt:at+60000});
  const core=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-60000,to:at+120000});
  assert.equal(core.coverage.elapsedMs,60000);assert.equal(core.traffic.totalRx,'1');assert.equal(core.traffic.dayRx,'1');
  assert.equal(core.clock.source,'receiver');
  assert.equal(core.traffic.dayStart,'2026-11-25');assert.equal(core.resourceBuckets.length,2);
  const fields=core.resourceBuckets.map(b=>b.fields.cpu);assert.equal(fields.reduce((n,f)=>n+f.weightedSum,0),200000);
  assert.equal(Math.max(...fields.map(f=>f.max)),100);
  const reopened=session({generation:2});
  await invoke('recordMonitorStandard',h.env,principal,reopened,{report:{...report,net_rx_total:'9007199254740994'},receivedAt:at+3600000});
  const after=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-60000,to:at+7200000});
  assert.equal(after.coverage.elapsedMs,60000);
  assert.equal(after.traffic.totalRx,'2');
  assert.equal(after.rawSamples.some(s=>s.sampledAt===at+3600000),false);
});

test('same-token CF backlog across standard fallback preserves one traffic ledger and original CF highwater',async t=>{
  const h=await fixture(t),at=Date.UTC(2026,10,24,12);
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(1,{samples:[sample('100',at),sample('101',at+1000)],probes:[]}));
  const current=session({generation:2});
  const report={cpu:0,boot_id:'k/a',net_rx_total:'104',net_tx_total:'0'};
  await invoke('recordMonitorStandard',h.env,principal,current,{report,receivedAt:at+4000});
  await invoke('recordMonitorStandard',h.env,principal,current,{held:{report,elapsedMs:2000},receivedAt:at+6000});
  await invoke('recordMonitorBatch',h.env,principal,current,frame(2,{samples:[sample('102',at+2000),sample('103',at+3000)],probes:[]}));
  await invoke('recordMonitorStandard',h.env,principal,current,{report:{...report,net_rx_total:'106'},receivedAt:at+6000});
  const core=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-1,to:at+60001});
  assert.equal(core.traffic.totalRx,'6');
  assert.equal((await h.db.prepare('SELECT durable_through FROM monitor_telemetry_nodes').first()).durable_through,2);
  assert.ok(core.rawSamples.some(s=>s.sampledAt===at+2000));assert.ok(core.rawSamples.some(s=>s.source==='standard'));
});

test('standard fractional and out-of-i64 counters remain unknown readings, not CF prerequisites or invented zero',async t=>{
  const h=await fixture(t),s=session(),at=Date.UTC(2026,10,24,12);
  const report={cpu:8,boot_id:'boot',net_rx_total:'1.5',net_tx_total:'9223372036854775808'};
  await invoke('recordMonitorStandard',h.env,principal,s,{report,receivedAt:at});
  await invoke('recordMonitorStandard',h.env,principal,s,{held:{report,elapsedMs:1000},receivedAt:at+1000});
  const core=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-1,to:at+60001});
  assert.equal(core.traffic,null);assert.equal(core.latest.report.net_rx_total,'1.5');
  assert.equal(core.resourceBuckets[0].fields.cpu.mean,8);assert.equal(core.resourceBuckets[0].network.rxMean,null);
  const resumed=[sample('100',at+60000),sample('101',at+61000)].map(s=>({...s,report:{...s.report,boot_id:'boot'}}));
  await invoke('recordMonitorBatch',h.env,principal,s,frame(1,{samples:resumed,probes:[]}));
  const mixed=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-1,to:at+120000});
  assert.equal(mixed.traffic.totalRx,'1');
});

test('receiptless standard bucket names cannot reserve a client-valid CF stream or invent its sequence',async t=>{
  const h=await fixture(t),s=session(),at=Date.UTC(2026,10,24,12);
  await invoke('recordMonitorStandard',h.env,principal,s,{report:{cpu:1},receivedAt:at});
  const ack=await invoke('recordMonitorBatch',h.env,principal,s,frame(1,{stream:'standard-1',probes:[]}));
  assert.equal(ack.durableThrough,1);assert.equal(ack.stream,'standard-1');
});

test('fresh standard transition probe does not reset the CF counter mark or book resource intervals',async t=>{
  const h=await fixture(t),at=Date.UTC(2026,10,24,12);
  await invoke('recordMonitorBatch',h.env,principal,session(),frame(1,{samples:[sample('100',at),sample('101',at+1000)],probes:[]}));
  const before=JSON.parse((await h.db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state);
  const next=session({generation:2});
  await invoke('recordMonitorStandard',h.env,principal,next,{receivedAt:at+1500,probe:{taskId:1,metricId:'p_a',sampledAt:at+1500,latencyMs:0}});
  const after=JSON.parse((await h.db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state);
  assert.deepEqual(after.networkMark,before.networkMark);assert.deepEqual(after.traffic,before.traffic);
  await invoke('recordMonitorBatch',h.env,principal,next,frame(2,{samples:[sample('102',at+2000),sample('103',at+3000)],probes:[]}));
  const core=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-1,to:at+60001});
  assert.equal(core.coverage.sampleCount,4);assert.equal(core.coverage.probeCount,1);
  assert.equal(core.resourceBuckets[0].network.rxBytes,'3');assert.equal(core.resourceBuckets[0].network.coverageMs,3000);
});

test('standard unseen kernel reboot books whole reading only with positive upstream boot evidence',async t=>{
  const h=await fixture(t),s=session(),at=Date.UTC(2026,10,24,12);
  await invoke('recordMonitorStandard',h.env,principal,s,{report:{boot_id:'old/nic',net_rx_total:'100',net_tx_total:'0',uptime:3600},receivedAt:at});
  await invoke('recordMonitorStandard',h.env,principal,s,{report:{boot_id:'new/nic',net_rx_total:'7',net_tx_total:'0',uptime:1},receivedAt:at+5000});
  const core=await invoke('readMonitorTelemetry',h.db,principal.serverId,{from:at-60000,to:at+60000});assert.equal(core.traffic.totalRx,'7');
});
