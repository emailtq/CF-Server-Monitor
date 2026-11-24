import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorRuntimeFixture, frames, send } from './fixtures/monitor-runtime.mjs';
import { changeLatencyTasks } from '../src/database/latencyTasks.js';
import { readMonitorTelemetry } from '../src/database/monitorTelemetry.js';

async function barrier(peer,id) {
  send(peer,'admission.barrier',{},id);
  for(let i=0;i<3000;i++) {
    if(frames(peer).some(f=>f.id===id)) return;
    await new Promise(r=>setTimeout(r,10));
  }
  throw new Error('Owned WS burst did not finish');
}
const core=h=>readMonitorTelemetry(h.db,'node-a',{from:Date.now()-60000,to:Date.now()+60000});

test('owned standard burst admits only 128 per fixed monotonic 5s window before D1 effects',{timeout:60000},async t=>{
  const h=await createMonitorRuntimeFixture(t);
  await changeLatencyTasks(h.db,{},'save',{name:'burst',target:'127.0.0.1:12345',interval:5,auto_join:false,nodes:['node-a']});
  const peer=await h.socket();await h.control('tick',{value:0});
  const before=(await h.snapshot()).counts.dbRowsWritten;
  for(let i=0;i<128;i++) send(peer,'ping.result',{task_id:1,latency_ms:i%3===0?-1:i+1});
  await barrier(peer,'admitted');
  const admitted=await core(h),writes128=(await h.snapshot()).counts.dbRowsWritten;
  assert.equal(admitted.coverage.probeCount,128);assert.equal(admitted.probeSeries[0].timeouts,43);assert.ok(writes128>before);
  for(let i=0;i<8;i++) send(peer,'ping.result',{task_id:1,latency_ms:-1});
  await barrier(peer,'excess');
  assert.deepEqual(await core(h).then(c=>c.probeSeries),admitted.probeSeries);
  assert.equal((await h.snapshot()).counts.dbRowsWritten,writes128);
  await h.control('tick',{value:4999});send(peer,'ping.result',{task_id:1,latency_ms:-1});await barrier(peer,'still-window');
  assert.equal((await core(h)).coverage.probeCount,128);assert.equal((await h.snapshot()).counts.dbRowsWritten,writes128);
  await h.control('tick',{value:5000});send(peer,'ping.result',{task_id:1,latency_ms:17});await barrier(peer,'next-window');
  assert.equal((await core(h)).coverage.probeCount,129);
  const nextWrites=(await h.snapshot()).counts.dbRowsWritten;
  const replacement=await h.socket();send(replacement,'ping.result',{task_id:1,latency_ms:19});await barrier(replacement,'new-session');
  assert.equal((await core(h)).coverage.probeCount,130);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM monitor_telemetry_receipts').first()).n,0);
  t.diagnostic(JSON.stringify({controlledClock:'performance tick only; Date.now unchanged',before,writes128,excessWrites:0,nextWrites,attempts:[128,128,128,129,130],timeoutsAt128:43}));
});

test('standard report spacing drops sub500ms before latest, held interval, traffic or D1 write',async t=>{
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  const report=(cpu,rx)=>({cpu,boot_id:'boot',net_rx_total:rx,net_tx_total:0});
  await h.control('tick',{value:0});send(peer,'report',report(10,100));await barrier(peer,'first');
  const before=(await h.snapshot()).counts.dbRowsWritten;
  await h.control('tick',{value:499});send(peer,'report',report(99,999));await barrier(peer,'drop499');
  assert.equal((await h.snapshot()).inputs[0][1].latest.report.cpu,10);assert.equal((await h.snapshot()).counts.dbRowsWritten,before);
  await h.control('tick',{value:500});send(peer,'report',report(20,101));await barrier(peer,'accept500');
  const accepted=await core(h),written=(await h.snapshot()).counts.dbRowsWritten;
  assert.equal(accepted.traffic.totalRx,'1');assert.equal(accepted.coverage.elapsedMs,500);
  await h.control('tick',{value:999});send(peer,'report',report(77,777));await barrier(peer,'drop999');
  assert.equal((await h.snapshot()).inputs[0][1].latest.report.cpu,20);assert.equal((await h.snapshot()).counts.dbRowsWritten,written);
  await h.control('tick',{value:1000});send(peer,'report',report(30,102));await barrier(peer,'accept1000');
  const last=await core(h);assert.equal(last.traffic.totalRx,'2');assert.equal(last.coverage.elapsedMs,1000);
  assert.ok(last.rawSamples.every(s=>![99,77].includes(s.report.cpu)));
  const replacement=await h.socket();send(replacement,'report',report(40,103));await barrier(replacement,'fresh-first');
  assert.equal((await h.snapshot()).inputs[0][1].latest.report.cpu,40);
  t.diagnostic(JSON.stringify({ticks:[0,499,500,999,1000],accepted:[0,500,1000],elapsedMs:last.coverage.elapsedMs,rx:last.traffic.totalRx,rejectedD1Writes:0}));
});

test('CF batch retains all 200 raw probes independently of the standard window limit',async t=>{
  const h=await createMonitorRuntimeFixture(t);
  const doc=await changeLatencyTasks(h.db,{},'save',{name:'CF',target:'127.0.0.1:12345',interval:5,auto_join:false,nodes:['node-a']});
  const peer=await h.socket();await h.control('tick',{value:0});
  send(peer,'cf.capabilities',{version:1,supports:['cf.report.batch','cf.ping.tasks'].map(method=>({method,version:1}))},'caps');await barrier(peer,'cap-done');
  const now=Date.now();
  send(peer,'cf.report.batch',{version:1,stream:'cf-burst',sequence:1,samples:[],
    probes:Array.from({length:200},(_,i)=>({taskId:1,metricId:doc.tasks[0].id,sampledAt:now,latencyMs:i%2?-1:7})),
    clock:{local_ts:now,accurate_ts:null,offset_ms:null,source:null,round_trip_ms:null,sample_age_ms:null}},'batch');
  await barrier(peer,'batch-done');assert.equal(frames(peer).find(f=>f.id==='batch').result.durableThrough,1);
  const saved=await core(h);assert.equal(saved.coverage.probeCount,200);assert.equal(saved.probeSeries[0].timeouts,100);
  t.diagnostic(JSON.stringify({cfRawProbes:200,timeouts:100,loss:saved.probeSeries[0].loss,standardCapApplied:false}));
});

test('empty CF negotiation retains the first standard held reading and its observed interval',async t=>{
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  await h.control('tick',{value:0});
  send(peer,'report',{cpu:100,boot_id:'std',net_rx_total:10,net_tx_total:0});await barrier(peer,'std-first');
  send(peer,'cf.capabilities',{version:1,supports:[]},'std-caps');await barrier(peer,'std-profile');
  await h.control('tick',{value:500});send(peer,'report',{cpu:0,boot_id:'std',net_rx_total:11,net_tx_total:0});await barrier(peer,'std-second');
  const saved=await core(h);assert.equal(saved.coverage.elapsedMs,500);assert.equal(saved.traffic.totalRx,'1');
  assert.ok(saved.rawSamples.some(s=>s.elapsedMs===500&&s.report.cpu===100));
  assert.equal((await h.db.prepare('SELECT count(*) n FROM monitor_telemetry_receipts').first()).n,0);
});
