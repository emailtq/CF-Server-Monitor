import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture,invoke,counts,frame,sample,principal,session,at } from './helpers/monitorTelemetry.js';

test('D1 atomically persists original receipt, ledger, raw probes, resources, migration and exact ACK',async t=> {
  const {db,env}=await fixture(t);
  const activatedAfter=Date.now();
  const ack=await invoke('recordMonitorBatch',env,principal,session({facts:{os:'Windows'}}),frame());
  assert.deepEqual(ack,{version:1,stream:'stream-a',accepted:{from:1,to:1},durableThrough:1});
  const core=await invoke('readMonitorTelemetry',db,'uuid-a',{from:at-1000,to:at+60000});
  assert.equal(core.traffic.totalRx,'1');
  assert.equal(core.rawSamples.length,2);
  assert.equal(core.probeSeries[0].attempts,3);
  assert.ok(Math.abs(core.probeSeries[0].loss-100/3)<1e-10);
  assert.equal(core.resourceBuckets[0].fields.cpu.mean,20);
  assert.equal(core.facts.os,'Windows');
  assert.ok(core.migration.activatedAt>=activatedAfter && core.migration.activatedAt<=Date.now());
  assert.equal(core.migration.firstSampledAt,at);
  assert.equal(core.source,'cf-batch');
  assert.equal(core.latest.sampledAt,at+1000);
  assert.deepEqual(await counts(db),{monitor_telemetry_nodes:1,monitor_telemetry_receipts:1,monitor_telemetry_buckets:1});
});

test('same params with changed RPC id return original ACK; whitespace conflict and gap have no effect',async t=> {
  const {db,env}=await fixture(t);
  const ack=await invoke('recordMonitorBatch',env,principal,session(),frame());
  const before=await invoke('readMonitorTelemetry',db,'uuid-a',{from:at-1000,to:at+60000});
  assert.deepEqual(await invoke('recordMonitorBatch',env,principal,session(),frame(1,{},'http-retry')),ack);
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),frame().replace('"samples":','"samples" :')),/conflict/);
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),frame(3)),e=>e.code==='monitor_sequence_gap' && e.expectedSequence===2);
  assert.deepEqual(await invoke('readMonitorTelemetry',db,'uuid-a',{from:at-1000,to:at+60000}),before);
});

test('real D1 constraint abort after receipt insertion rolls back every write and leaves retry admissible',async t=> {
  const {db,env}=await fixture(t);
  await db.prepare("CREATE TRIGGER reject_bucket BEFORE INSERT ON monitor_telemetry_buckets BEGIN SELECT RAISE(ABORT,'injected constraint'); END").run();
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),frame()),/constraint/);
  assert.deepEqual(await counts(db),{monitor_telemetry_nodes:0,monitor_telemetry_receipts:0,monitor_telemetry_buckets:0});
  await db.prepare('DROP TRIGGER reject_bucket').run();
  assert.equal((await invoke('recordMonitorBatch',env,principal,session(),frame())).durableThrough,1);
});

test('multi-stream admission preserves old receipts without old replay stealing new owner',async t=> {
  const {db,env}=await fixture(t);
  await invoke('recordMonitorBatch',env,principal,session(),frame());
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),frame(2,{stream:'stream-c'})),e=>e.expectedSequence===1);
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session({admitStream:false}),frame(1,{stream:'stream-b'})),/admission/);
  await invoke('recordMonitorBatch',env,principal,session({generation:2}),frame(1,{stream:'stream-b',samples:[sample('9007199254740994',at+2000)],probes:[]}));
  const before=await db.prepare('SELECT * FROM monitor_telemetry_nodes').first();
  await invoke('recordMonitorBatch',env,principal,session({generation:2}),frame());
  assert.deepEqual(await db.prepare('SELECT * FROM monitor_telemetry_nodes').first(),before);
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session({generation:2}),frame(2)),/inactive stream/);
  assert.equal(JSON.parse(before.state).traffic.totalRx,'2');
});

test('late batches retain raw timestamps and are found without sequence-to-time assumptions',async t=> {
  const {db,env}=await fixture(t);
  await invoke('recordMonitorBatch',env,principal,session(),frame());
  const late=at-40*86400000;
  await invoke('recordMonitorBatch',env,principal,session(),frame(2,{samples:[sample('8',late)],probes:[{taskId:1,metricId:'p_a',sampledAt:late,latencyMs:-1}]}));
  const core=await invoke('readMonitorTelemetry',db,'uuid-a',{from:late-1000,to:late+1000});
  assert.equal(core.rawSamples[0].sampledAt,late);
  assert.equal(core.probeSeries[0].loss,100);
  assert.equal(core.traffic.totalRx,'1');
  assert.equal(core.latest.sampledAt,at+1000);
  assert.equal(core.coverage.lateSamples,1);
});

test('high-entropy near-512KiB frames and 300 samples remain bounded under repeated same bucket writes',async t=> {
  const {db,env}=await fixture(t);
  const name=randomBytes(360000).toString('base64');
  const samples=Array.from({length:300},(_,i)=>({...sample(String(1000+i),at+i*1000),extra:i===0?{gpu:[{id:'0',name,info:null}]}:{}}));
  const first=frame(1,{samples,probes:[]});
  assert.ok(Buffer.byteLength(first)>480000 && Buffer.byteLength(first)<=524288);
  for(let sequence=1;sequence<=6;sequence++) await invoke('recordMonitorBatch',env,principal,session(),frame(sequence,{samples,probes:[]}));
  const rows=await db.prepare('SELECT MAX(length(payload)) AS max,COUNT(*) AS n FROM monitor_telemetry_buckets').first();
  assert.ok(rows.max<=262144,JSON.stringify(rows));
  assert.ok(rows.n>=12);
  const core=await invoke('readMonitorTelemetry',db,'uuid-a',{from:at-1000,to:at+300000});
  assert.equal(core.rawSamples.length,1800);
  assert.equal(core.rawSamples[0].extra.gpu[0].name,name);
  t.diagnostic(JSON.stringify({wireBytes:Buffer.byteLength(first),batches:6,rawSamples:core.rawSamples.length,
    fragmentRows:rows.n,maxFragmentBytes:rows.max,restoredGpuNameBytes:Buffer.byteLength(core.rawSamples[0].extra.gpu[0].name)}));
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),first+' '.repeat(524288)),/Invalid request/);
  assert.equal((await counts(db)).monitor_telemetry_receipts,6);
});

test('node authority, generation, lease and immutable assignment checks deny before success ACK',async t=> {
  const {db,env}=await fixture(t);
  for(const s of [session({assertCurrent:async()=>false}),session({leaseUntil:1}),session({tasks:[]})]) await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,s,frame()));
  await db.prepare('UPDATE terminal_nodes SET token_version=2').run();
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),frame()),/authority/);
  assert.equal((await counts(db)).monitor_telemetry_receipts,0);
});

test('concurrent D1 CAS callers cannot double book or commit divergent sequence payloads',async t=> {
  const {db,env}=await fixture(t);
  const results=await Promise.allSettled([invoke('recordMonitorBatch',env,principal,session(),frame()),invoke('recordMonitorBatch',env,principal,session(),frame(1,{probes:[]}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await counts(db)).monitor_telemetry_receipts,1);
  const core=await invoke('readMonitorTelemetry',db,'uuid-a',{from:at-1000,to:at+60000});
  assert.equal(core.traffic.totalRx,'1');
  assert.equal(core.rawSamples.length,2);
});

test('a query beginning in the next batch retains its exact counter-derived rate',async t=> {
  const {db,env}=await fixture(t);
  await invoke('recordMonitorBatch',env,principal,session(),frame());
  await invoke('recordMonitorBatch',env,principal,session(),frame(2,{samples:[sample('9007199254740994',at+2000)],probes:[]}));
  const core=await invoke('readMonitorTelemetry',db,'uuid-a',{from:at+2000,to:at+3000});
  assert.equal(core.resourceBuckets[0].network.rxBytes,'1');
  assert.equal(core.resourceBuckets[0].network.coverageMs,1000);
  assert.equal(core.resourceBuckets[0].network.rxMean,1);
});

test('revocation during final awaited guard suppresses ACK while committed receipt stays replayable',async t=> {
  const {db,env}=await fixture(t);
  let live=true,checks=0;
  const owner=session({isCurrent:()=>live,assertCurrent:async()=> {
    checks++;
    if(checks===3) { await Promise.resolve(); live=false; }
    return true;
  }});
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,owner,frame()),/authority/);
  assert.equal((await counts(db)).monitor_telemetry_receipts,1);
  assert.equal((await invoke('recordMonitorBatch',env,principal,session({generation:2}),frame())).durableThrough,1);
});

test('expired generation and revoked assignment after awaits cannot write a newer owner',async t=> {
  const {db,env}=await fixture(t);
  await invoke('recordMonitorBatch',env,principal,session({generation:2}),frame());
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),frame(2)),/authority/);
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session({generation:2,tasks:[{taskId:1,metricId:'p_a',assignedAt:1,retiredAt:at}]}),frame(2)),/assignment/);
  assert.equal((await counts(db)).monitor_telemetry_receipts,1);
});

test('SQL token gate rejects rotation between authorization read and atomic commit',async t=> {
  const {db,env}=await fixture(t);
  let checks=0;
  const owner=session({assertCurrent:async()=> {
    if(++checks===2) await db.prepare('UPDATE terminal_nodes SET token_version=2').run();
    return true;
  }});
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,owner,frame()),/CHECK/);
  assert.deepEqual(await counts(db),{monitor_telemetry_nodes:0,monitor_telemetry_receipts:0,monitor_telemetry_buckets:0});
});

test('receiver rejects 301 samples and node-state overflow without allocating any receipt',async t=> {
  const {db,env}=await fixture(t);
  const object=JSON.parse(frame(1,{samples:[],probes:[]}));
  object.params.samples=Array.from({length:301},()=>({...sample('1'),report:{cpu:1}}));
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session(),JSON.stringify(object)),/Invalid params/);
  await assert.rejects(()=>invoke('recordMonitorBatch',env,principal,session({facts:{os:'x'.repeat(1048576)}}),frame()),e=>e.code==='monitor_storage_overflow');
  assert.equal((await counts(db)).monitor_telemetry_receipts,0);
});

test('receipt equality uses nested escaped params bytes while envelope whitespace and order may differ',async t=> {
  const {db,env}=await fixture(t);
  const original=frame(1,{samples:[{...sample(),extra:{gpu:[{id:'x',name:'quotes " } [, 中文',info:null}]}}],probes:[]});
  const ack=await invoke('recordMonitorBatch',env,principal,session(),original);
  const params=original.slice(original.indexOf('"params":')+9,original.lastIndexOf(',"id":'));
  assert.deepEqual(await invoke('recordMonitorBatch',env,principal,session(),` { "id":"new", "params": ${params}, "method":"cf.report.batch", "jsonrpc":"2.0" } `),ack);
});

test('resource-only late observations retain real coverage without inventing a traffic zero',async t=> {
  const {db,env}=await fixture(t);
  const resource=ts=>({sampledAt:ts,elapsedMs:1000,report:{cpu:10},extra:{}});
  await invoke('recordMonitorBatch',env,principal,session(),frame(1,{samples:[resource(at)],probes:[]}));
  await invoke('recordMonitorBatch',env,principal,session(),frame(2,{samples:[resource(at-10000)],probes:[]}));
  const core=await invoke('readMonitorTelemetry',db,'uuid-a',{from:at-20000,to:at+1000});
  assert.equal(core.traffic,null);
  assert.equal(core.latest.sampledAt,at);
  assert.equal(core.coverage.lateSamples,1);
  assert.equal(core.coverage.elapsedMs,2000);
});

test('D1 network counter gaps carry monotonic elapsed weights across missing observations and batches',async t=> {
  const {db,env}=await fixture(t);
  const missing={sampledAt:at+2000,elapsedMs:2000,report:{cpu:10},extra:{}};
  await invoke('recordMonitorBatch',env,principal,session(),frame(1,{samples:[{...sample('100',at),elapsedMs:2000},missing],probes:[]}));
  const unknown=await invoke('readMonitorTelemetry',db,principal.serverId,{from:at,to:at+3000});
  assert.equal(unknown.resourceBuckets[0].network.rxMean,null);
  await invoke('recordMonitorBatch',env,principal,session(),frame(2,{samples:[{...sample('104',at+4000),elapsedMs:2000}],probes:[]}));
  const core=await invoke('readMonitorTelemetry',db,principal.serverId,{from:at,to:at+6000});
  assert.equal(core.traffic.totalRx,'4');
  assert.equal(core.resourceBuckets[0].network.rxBytes,'4');
  assert.equal(core.resourceBuckets[0].network.coverageMs,4000);
  assert.equal(core.resourceBuckets[0].network.rxMean,1);
  t.diagnostic(JSON.stringify({rxBytes:core.resourceBuckets[0].network.rxBytes,coverageMs:core.resourceBuckets[0].network.coverageMs,rxMean:core.resourceBuckets[0].network.rxMean}));
});

test('D1 gap weights use elapsedMs through wallclock steps without bridging epoch or descent',async t=> {
  const {db,env}=await fixture(t);
  const reading=(rx,ts,elapsedMs=2000,epoch='k/a')=>({...sample(rx,ts),elapsedMs,report:{boot_id:epoch,net_rx_total:rx,net_tx_total:'0'}});
  await invoke('recordMonitorBatch',env,principal,session(),frame(1,{samples:[reading('100',at),
    {sampledAt:at+3600000,elapsedMs:1000,report:{cpu:10},extra:{}},
    {sampledAt:at+1000,elapsedMs:3000,report:{cpu:10},extra:{}},reading('106',at+4000)],probes:[]}));
  const core=await invoke('readMonitorTelemetry',db,principal.serverId,{from:at,to:at+6000});
  assert.equal(core.resourceBuckets[0].network.rxBytes,'6');
  assert.equal(core.resourceBuckets[0].network.coverageMs,6000);
  assert.equal(core.resourceBuckets[0].network.rxMean,1);
  await invoke('recordMonitorBatch',env,principal,session(),frame(2,{samples:[
    {sampledAt:at+6000,elapsedMs:2000,report:{boot_id:'new',cpu:10},extra:{}},reading('10',at+8000,2000,'new')],probes:[]}));
  const reset=await invoke('readMonitorTelemetry',db,principal.serverId,{from:at+6000,to:at+10000});
  assert.equal(reset.resourceBuckets[0].network.coverageMs,0);
  assert.equal(reset.resourceBuckets[0].network.rxMean,null);
  await invoke('recordMonitorBatch',env,principal,session(),frame(3,{samples:[reading('1',at-40000,2000,'new')],probes:[]}));
  await invoke('recordMonitorBatch',env,principal,session(),frame(4,{samples:[reading('12',at+12000,2000,'new')],probes:[]}));
  const afterLate=await invoke('readMonitorTelemetry',db,principal.serverId,{from:at+12000,to:at+14000});
  assert.equal(afterLate.resourceBuckets[0].network.rxBytes,'2');
  assert.equal(afterLate.resourceBuckets[0].network.coverageMs,2000);
  assert.equal(afterLate.resourceBuckets[0].network.rxMean,1);
});

test('late missing counters leave D1 networkMark intact while raw CPU coverage remains queryable',async t=> {
  const {db,env}=await fixture(t);
  await invoke('recordMonitorBatch',env,principal,session(),frame(1,{samples:[{...sample('100',at),elapsedMs:2000}],probes:[]}));
  const before=JSON.parse((await db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state).networkMark;
  const lateAt=at-40*86400000;
  const late={sampledAt:lateAt,elapsedMs:1000,report:{cpu:10},extra:{}};
  await invoke('recordMonitorBatch',env,principal,session(),frame(2,{samples:[late,
    {sampledAt:at,elapsedMs:1000,report:{cpu:10,boot_id:'old'},extra:{}}],probes:[]}));
  const after=JSON.parse((await db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state).networkMark;
  assert.deepEqual(after,before);
  const historical=await invoke('readMonitorTelemetry',db,principal.serverId,{from:lateAt-1,to:lateAt+1});
  assert.deepEqual(historical.rawSamples,[{...late,network:null}]);
  assert.equal(historical.coverage.elapsedMs,1000);
  assert.equal(historical.resourceBuckets[0].fields.cpu.coverageMs,1000);
  assert.equal(historical.resourceBuckets[0].fields.cpu.mean,10);
  assert.equal(historical.resourceBuckets[0].network.rxMean,null);
  await invoke('recordMonitorBatch',env,principal,session(),frame(3,{samples:[{...sample('102',at+2000),elapsedMs:2000}],probes:[]}));
  const core=await invoke('readMonitorTelemetry',db,principal.serverId,{from:at,to:at+4000});
  assert.equal(core.traffic.totalRx,'2');
  assert.equal(core.resourceBuckets[0].network.rxBytes,'2');
  assert.equal(core.resourceBuckets[0].network.coverageMs,2000);
  assert.equal(core.resourceBuckets[0].network.rxMean,1);
});
