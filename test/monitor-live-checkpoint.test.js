import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorRuntimeFixture,send,frames,until } from './fixtures/monitor-runtime.mjs';
import { changeLatencyTasks } from '../src/database/latencyTasks.js';
import { frame,sample } from './helpers/monitorTelemetry.js';
import { issueNodeToken } from '../src/database/nodeCredentials.js';

async function connect(h) {
  const peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports:['cf.report.batch','cf.ping.tasks','cf.reporting.configure'].map(method=>({method,version:1}))},'cap');
  await until(()=>frames(peer).some(f=>f.id==='cap'));await h.control('drain');return peer;
}
async function report(h,peer,cpu) {
  send(peer,'report',{cpu});
  await until(async()=>(await h.snapshot()).latest.find(([id])=>id==='node-a')?.[1]?.samples[0].data.cpu===cpu);
  await h.control('drain');
}
const nodeState=async h=>JSON.parse((await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first()).state);
const delta=(a,b)=>Object.fromEntries(Object.keys(b).map(k=>[k,b[k]-a[k]]));

test('actual four-task 2s CF live skips within-minute D1 hot reads, keeps exact cadence, and rebuild/reconnect initialize only from persisted D1',async t=> {
  const h=await createMonitorRuntimeFixture(t);
  for(let i=0;i<4;i++)await changeLatencyTasks(h.db,{},'save',{name:'live-'+i,target:`127.0.0.1:${4000+i}`,interval:60,auto_join:false,nodes:['node-a']});
  const peer=await connect(h);send(peer,'hello',{os:'live fixture'});await h.control('drain');
  let before=(await h.snapshot()).counts;await report(h,peer,1);let after=(await h.snapshot()).counts;
  const firstDelta=delta(before,after),first=await nodeState(h);
  assert.equal(first.live.report.cpu,1);assert.ok(firstDelta.dbRowsWritten>=1);
  const hot=[],checkpoints=[];
  for(let i=1;i<=30;i++) {
    await h.control('advance',{ms:2000});before=(await h.snapshot()).counts;
    await report(h,peer,i+1);after=(await h.snapshot()).counts;
    const d=delta(before,after);hot.push({second:i*2,...d});if(d.dbRowsWritten)checkpoints.push(i*2);
  }
  assert.deepEqual(checkpoints,[60]);
  t.diagnostic(JSON.stringify({first:firstDelta,live2s:hot,checkpointSeconds:checkpoints}));
  // Lease renewal at 30s still does its real authority reads; ordinary 2s live does none.
  assert.equal(hot[0].dbRowsRead,0);assert.equal(hot[0].dbRowsWritten,0);
  assert.ok(hot.slice(0,29).filter(r=>r.dbRowsRead===0).length>=27);
  const checkpoint=await nodeState(h);assert.equal(checkpoint.live.report.cpu,31);
  assert.ok(checkpoint.liveCheckpointAt-first.liveCheckpointAt>=60000);
  await h.control('rebuild');await h.control('advance',{ms:2000});before=(await h.snapshot()).counts;
  await report(h,peer,32);const rebuilt=delta(before,(await h.snapshot()).counts);
  assert.ok(rebuilt.dbRowsRead>0);assert.equal(rebuilt.dbRowsWritten,0);
  assert.equal((await nodeState(h)).liveCheckpointAt,checkpoint.liveCheckpointAt);
  assert.equal((await h.snapshot()).inputs[0][1].liveCheckpoint.persistedAt,checkpoint.liveCheckpointAt);
  await h.control('advance',{ms:2000});before=(await h.snapshot()).counts;await report(h,peer,33);
  assert.equal(delta(before,(await h.snapshot()).counts).dbRowsRead,0);
  peer.ws.close();await until(()=>peer.ws.readyState===3);await h.control('drain');
  const reconnected=await connect(h);before=(await h.snapshot()).counts;await report(h,reconnected,34);
  const reconnect=delta(before,(await h.snapshot()).counts);assert.equal(reconnect.dbRowsWritten,1);
  assert.equal((await nodeState(h)).live.report.cpu,34);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_buckets').first()).n,0);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_receipts').first()).n,0);
  t.diagnostic(JSON.stringify({first:firstDelta,live2s:hot,checkpointSeconds:checkpoints,firstPersistedAt:first.liveCheckpointAt,lastPersistedAt:checkpoint.liveCheckpointAt,rebuild:rebuilt,reconnect}));
});

test('failed live checkpoint never advances hint, same D1 rebuild recovers freshness, and batch ledger changes invalidate only live cache',async t=> {
  const h=await createMonitorRuntimeFixture(t),peer=await connect(h);await report(h,peer,1);
  const original=await nodeState(h);
  await h.db.prepare("CREATE TRIGGER fail_live BEFORE UPDATE ON monitor_telemetry_nodes BEGIN SELECT RAISE(ABORT,'test live outage');END").run();
  await h.control('advance',{ms:30000});await report(h,peer,2);
  await h.control('advance',{ms:30000});send(peer,'report',{cpu:3});await until(()=>peer.ws.readyState===3);await h.control('drain');
  assert.equal((await nodeState(h)).liveCheckpointAt,original.liveCheckpointAt);
  assert.equal((await h.snapshot()).inputs[0][1].liveCheckpoint.persistedAt,original.liveCheckpointAt);
  await h.db.prepare('DROP TRIGGER fail_live').run();await h.control('rebuild');
  const recovered=await connect(h);await report(h,recovered,3);assert.equal((await nodeState(h)).live.report.cpu,3);
  const ts=Date.now();recovered.ws.send(frame(1,{samples:[sample('0',ts),sample('9007199254740993',ts+2000)],probes:[]},'batch'));
  await until(()=>frames(recovered).some(f=>f.id==='batch'));assert.equal(frames(recovered).find(f=>f.id==='batch').result.durableThrough,1);
  await h.control('advance',{ms:2000});await report(h,recovered,4);
  assert.equal((await h.snapshot()).latest[0][1].samples[0].data.net_rx,'9007199254740993');
  assert.equal((await nodeState(h)).traffic.totalRx,'9007199254740993');
  t.diagnostic(JSON.stringify({failedPersistedAt:original.liveCheckpointAt,recoveredCPU:3,exactBatchTotal:'9007199254740993',noFailedHint:true}));
});

test('hot live checkpoint hint cannot bypass revocation or expired lease',async t=> {
  const h=await createMonitorRuntimeFixture(t),peer=await connect(h);await report(h,peer,1);
  const original=await nodeState(h);
  const rotated=await issueNodeToken(h.db,'node-a');h.nodes['node-a']=rotated;
  await h.control('invalidate',{serverId:'node-a',tokenVersion:rotated.tokenVersion});send(peer,'report',{cpu:2});await until(()=>peer.ws.readyState===3);
  assert.equal((await nodeState(h)).liveCheckpointAt,original.liveCheckpointAt);
  const next=await connect(h);await report(h,next,3);const before=await nodeState(h);
  await h.control('expire');send(next,'report',{cpu:4});await until(()=>next.ws.readyState===3);
  assert.equal((await nodeState(h)).liveCheckpointAt,before.liveCheckpointAt);
});
