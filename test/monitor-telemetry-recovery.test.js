import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture,invoke,frame,sample,principal,session,at } from './helpers/monitorTelemetry.js';

test('ACK lost then same persisted D1 reopened returns original ACK and no second reduction',async()=> {
  const root=await mkdtemp(path.join(tmpdir(),'cfsm-telemetry-recovery-'));
  let mf;
  try {
    let f=await fixture(null,{resourcePersistencePath:root}); mf=f.mf;
    const raw=frame();
    const lostAck=await invoke('recordMonitorBatch',f.env,principal,session(),raw);
    const before=await invoke('readMonitorTelemetry',f.db,'uuid-a',{from:at-1000,to:at+60000});
    await mf.dispose(); mf=null;
    f=await fixture(null,{resourcePersistencePath:root}); mf=f.mf;
    assert.deepEqual(await invoke('recordMonitorBatch',f.env,principal,session({generation:2}),raw.replace('"id":1','"id":2')),lostAck);
    assert.deepEqual(await invoke('readMonitorTelemetry',f.db,'uuid-a',{from:at-1000,to:at+60000}),before);
    assert.equal((await invoke('recordMonitorBatch',f.env,principal,session({generation:2}),frame(2,{samples:[sample('9007199254740994',at+2000)],probes:[]}))).durableThrough,2);
    const after=await invoke('readMonitorTelemetry',f.db,'uuid-a',{from:at-1000,to:at+60000});
    assert.equal(after.traffic.totalRx,'2');
    assert.equal(after.rawSamples.length,3);
    assert.equal(after.probeSeries[0].attempts,3);
    // Receipt is recovery state, not history: no timestamp expiry or cascade on node deletion.
    await f.db.prepare('DELETE FROM servers').run();
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM monitor_telemetry_receipts').first()).n,2);
    await assert.rejects(()=>invoke('recordMonitorBatch',f.env,principal,session(),raw),/authority/);
  } finally {
    await mf?.dispose();
    const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cfsm-telemetry-recovery-'));
    await rm(resolved,{recursive:true,force:true});
  }
});

test('pending network elapsed survives same D1 reconstruction and ACK replay without doubling weights',async()=> {
  const root=await mkdtemp(path.join(tmpdir(),'cfsm-telemetry-recovery-'));
  let mf;
  try {
    let f=await fixture(null,{resourcePersistencePath:root}); mf=f.mf;
    const raw=frame(1,{samples:[{...sample('100',at),elapsedMs:2000},
      {sampledAt:at+2000,elapsedMs:2000,report:{cpu:10},extra:{}}],probes:[]});
    await invoke('recordMonitorBatch',f.env,principal,session(),raw);
    const before=await f.db.prepare('SELECT state FROM monitor_telemetry_nodes').first();
    assert.equal(JSON.parse(before.state).networkMark.pendingElapsedMs,2000);
    await mf.dispose(); mf=null;
    f=await fixture(null,{resourcePersistencePath:root}); mf=f.mf;
    await invoke('recordMonitorBatch',f.env,principal,session({generation:2}),raw.replace('"id":1','"id":2'));
    assert.deepEqual(await f.db.prepare('SELECT state FROM monitor_telemetry_nodes').first(),before);
    await invoke('recordMonitorBatch',f.env,principal,session({generation:2}),frame(2,{samples:[{...sample('104',at+4000),elapsedMs:2000}],probes:[]}));
    const core=await invoke('readMonitorTelemetry',f.db,principal.serverId,{from:at,to:at+6000});
    assert.equal(core.traffic.totalRx,'4');
    assert.equal(core.resourceBuckets[0].network.coverageMs,4000);
    assert.equal(core.resourceBuckets[0].network.rxMean,1);
    assert.equal(JSON.parse((await f.db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state).networkMark.pendingElapsedMs,0);
  } finally {
    await mf?.dispose();
    const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cfsm-telemetry-recovery-'));
    await rm(resolved,{recursive:true,force:true});
  }
});

test('late CPU raw and the unchanged active network mark survive same D1 reconstruction and replay',async t=> {
  const root=await mkdtemp(path.join(tmpdir(),'cfsm-telemetry-recovery-'));
  let mf;
  try {
    let f=await fixture(null,{resourcePersistencePath:root}); mf=f.mf;
    await invoke('recordMonitorBatch',f.env,principal,session(),frame(1,{samples:[{...sample('100',at),elapsedMs:2000}],probes:[]}));
    const mark=JSON.parse((await f.db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state).networkMark;
    const lateAt=at-40*86400000;
    const samples=[{sampledAt:lateAt,elapsedMs:1000,report:{cpu:10,boot_id:'old'},extra:{}},
      {sampledAt:lateAt+1000,elapsedMs:1000,report:{cpu:10},extra:{}}];
    const raw=frame(2,{samples,probes:[]});
    await invoke('recordMonitorBatch',f.env,principal,session(),raw);
    assert.deepEqual(JSON.parse((await f.db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state).networkMark,mark);
    await mf.dispose(); mf=null;
    f=await fixture(null,{resourcePersistencePath:root}); mf=f.mf;
    await invoke('recordMonitorBatch',f.env,principal,session({generation:2}),raw.replace('"id":1','"id":2'));
    assert.deepEqual(JSON.parse((await f.db.prepare('SELECT state FROM monitor_telemetry_nodes').first()).state).networkMark,mark);
    const historical=await invoke('readMonitorTelemetry',f.db,principal.serverId,{from:lateAt,to:lateAt+2000});
    assert.deepEqual(historical.rawSamples,samples.map(s=>({...s,network:null})));
    assert.equal(historical.coverage.sampleCount,2);
    assert.equal(historical.coverage.elapsedMs,2000);
    assert.equal(historical.resourceBuckets[0].fields.cpu.count,2);
    assert.equal(historical.resourceBuckets[0].fields.cpu.coverageMs,2000);
    assert.equal(historical.resourceBuckets[0].fields.cpu.mean,10);
    await invoke('recordMonitorBatch',f.env,principal,session({generation:2}),frame(3,{samples:[{...sample('102',at+2000),elapsedMs:2000}],probes:[]}));
    const core=await invoke('readMonitorTelemetry',f.db,principal.serverId,{from:at,to:at+4000});
    assert.equal(core.traffic.totalRx,'2');
    assert.equal(core.resourceBuckets[0].network.rxBytes,'2');
    assert.equal(core.resourceBuckets[0].network.coverageMs,2000);
    assert.equal(core.resourceBuckets[0].network.rxMean,1);
    t.diagnostic(JSON.stringify({retainedLateSamples:historical.rawSamples.length,lateCpuCoverageMs:historical.coverage.elapsedMs,
      persistedPendingElapsedMs:mark.pendingElapsedMs,activeRxBytes:core.resourceBuckets[0].network.rxBytes,
      activeCoverageMs:core.resourceBuckets[0].network.coverageMs,activeRxMean:core.resourceBuckets[0].network.rxMean}));
  } finally {
    await mf?.dispose();
    const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cfsm-telemetry-recovery-'));
    await rm(resolved,{recursive:true,force:true});
  }
});
