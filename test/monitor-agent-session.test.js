import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createMonitorRuntimeFixture, until, frames, send } from './fixtures/monitor-runtime.mjs';
import { changeLatencyTasks } from '../src/database/latencyTasks.js';
import { issueNodeToken } from '../src/database/nodeCredentials.js';

const standard = JSON.parse(await readFile(new URL('./fixtures/monitor-protocol/standard.json',import.meta.url),'utf8'));
const extensions = JSON.parse(await readFile(new URL('./fixtures/monitor-protocol/extensions.json',import.meta.url),'utf8'));
const rawExample = method => standard.methods.find(entry=>entry.name===method).examples[0].raw;
const input = (snapshot,id='node-a') => snapshot.inputs.find(([node])=>node===id)?.[1];
let legacySequence=0;
const legacy = cpu => ({id:'node-a',metrics:{cpu:String(cpu),timestamp:Date.now() - 3600000 + ++legacySequence * 1000}});

test('real Worker native upgrade authenticates TLS/header/origin before global DO standard frames', async t => {
  const h=await createMonitorRuntimeFixture(t);
  assert.equal((await h.socket('/api/agent/ws',null)).status,401);
  assert.equal((await h.socket('/api/agent/ws',null,{Authorization:`Bearer ${'0'.repeat(64)}`})).status,401);
  assert.equal((await h.socket('/api/agent/ws?authToken=marker')).status,401);
  assert.equal((await h.socket('/api/agent/ws','node-a',{'MF-Original-URL':'http://example.com/api/agent/ws','X-Forwarded-Proto':'https'})).status,403);
  assert.equal((await h.fetch('/api/agent/ws',{headers:{Authorization:`Bearer ${h.nodes['node-a'].token}`}})).status,426);
  const peer=await h.socket(); assert.equal(peer.status,101);
  peer.ws.send(rawExample('hello'));peer.ws.send(rawExample('report'));
  await until(async()=>input(await h.snapshot())?.latest?.report?.net_rx_total==='9007199254740993');
  const snapshot=await h.snapshot();
  assert.equal(input(snapshot).latest.trafficReading.rx,'9007199254740993');
  assert.equal(input(snapshot).facts.os,'Debian GNU/Linux 12');
  assert.equal(input(snapshot).latest.source,'monitor');
  assert.ok(Number.isSafeInteger(input(snapshot).latest.receivedAt));
  assert.equal(frames(peer).some(frame=>frame.type==='hello'||frame.type==='ack'||frame.result?.durableThrough),false);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count,0);
  assert.equal(JSON.stringify(snapshot).includes(h.nodes['node-a'].token),false);
  t.diagnostic(JSON.stringify({route:'Worker /api/agent/ws -> global MetricsBroadcaster',anonymous:401,wrong:401,query:401,plaintext:403,nonUpgrade:426,valid:peer.status,
    report:rawExample('report'),rx:input(snapshot).latest.trafficReading.rx,ack:false,attachment:snapshot.attachments.find(a=>a.kind==='monitor-agent')}));
});

test('capabilities advertise no unimplemented batch/SSH/terminal and unknown requests never echo payload', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  send(peer,'cf.capabilities',{version:1,supports:[{method:'cf.report.batch',version:1},{method:'cf.ssh.events',version:1},{method:'cf.terminal.open',version:1}]},'caps');
  await until(()=>frames(peer).some(frame=>frame.id==='caps'));
  assert.deepEqual(frames(peer).find(frame=>frame.id==='caps').result.accepted,[]);
  assert.equal(frames(peer).find(frame=>frame.id==='caps').result.fallbackPath,null);
  send(peer,'not.implemented',{token:'payload-marker'},'unknown');
  send(peer,'not.implemented',{token:'notification-marker'});
  peer.ws.send(extensions.methods.find(entry=>entry.name==='cf.report.batch').examples[0].raw);
  const batchId=JSON.parse(extensions.methods.find(entry=>entry.name==='cf.report.batch').examples[0].raw).id;
  await until(()=>frames(peer).some(frame=>frame.id===batchId));
  for (const id of ['unknown',batchId]) assert.equal(frames(peer).find(frame=>frame.id===id).error.code,-32601);
  assert.equal(peer.messages.join('').includes('marker'),false);
  peer.ws.send(rawExample('report'));await until(async()=>!!input(await h.snapshot())?.latest);
});

test('numeric tasks/result use actual node assignment and immutable deleted/recreated metric generation', async t => {
  const h=await createMonitorRuntimeFixture(t);
  const task={name:'TCP',target:'example.com:443',interval:5,auto_join:false,nodes:['node-a']};
  const document=await changeLatencyTasks(h.db,{},'save',task),first=document.tasks[0];
  const peer=await h.socket();assert.equal(peer.status,101);
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params.length===1));
  const tasks=frames(peer).find(frame=>frame.method==='ping.tasks'&&frame.params.length===1).params;
  assert.deepEqual(tasks,[{id:1,target:'example.com:443',interval:5}]);
  send(peer,'ping.result',{task_id:1,latency_ms:42});
  await until(async()=>input(await h.snapshot())?.probes?.length===1);
  assert.equal(input(await h.snapshot()).probes[0].metricId,first.id);
  const other=await h.socket('/api/agent/ws','node-b');send(other,'ping.result',{task_id:1,latency_ms:8});
  send(other,'report',{cpu:3});await until(async()=>input(await h.snapshot(),'node-b')?.latest?.report?.cpu===3);
  assert.equal(input(await h.snapshot(),'node-b').probes.length,0);
  await changeLatencyTasks(h.db,{},'delete',{id:first.id});
  await changeLatencyTasks(h.db,{},'save',task);
  send(peer,'ping.result',{task_id:2,latency_ms:8});send(peer,'report',{cpu:4});
  await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===4);
  assert.equal(input(await h.snapshot()).probes.length,1);
  await h.fetch('/test/control',{method:'POST',body:JSON.stringify({op:'config'})});
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===2));
  send(peer,'ping.result',{task_id:1,latency_ms:99});send(peer,'ping.result',{task_id:2,latency_ms:-1});
  await until(async()=>input(await h.snapshot()).probes.length===2);
  assert.deepEqual(input(await h.snapshot()).probes.map(probe=>[probe.taskId,probe.latencyMs]),[[1,'42'],[2,'-1']]);
});

test('native/native replacement and legacy/POST competition share one actual write owner', async t => {
  const h=await createMonitorRuntimeFixture(t);
  assert.equal((await h.post(legacy(1))).status,200);
  const old=await h.socket();assert.equal(old.status,101);old.ws.send(rawExample('report'));
  await until(async()=>!!input(await h.snapshot())?.latest);
  const peer=await h.socket();assert.equal(peer.status,101);send(peer,'report',{cpu:77});
  await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===77);
  old.ws.close();
  assert.equal((await h.post(legacy(2))).status,409);
  assert.equal(input(await h.snapshot()).latest.report.cpu,77);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count,1);
  const legacyPeer=await h.socket('/update');assert.equal(legacyPeer.status,101);
  legacyPeer.ws.send(JSON.stringify({type:'update',payload:legacy(3)}));
  await until(()=>frames(legacyPeer).some(frame=>frame.type==='ack'));
  await until(()=>peer.ws.readyState!==1);
  const replacement=await h.socket();send(replacement,'report',{cpu:88});
  await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===88);
  legacyPeer.ws.close();assert.equal(input(await h.snapshot()).latest.report.cpu,88);
});

test('native fails closed on missing alarm/auth/expired lease while credential-version-only changes retain monitoring', async t => {
  const h=await createMonitorRuntimeFixture(t);
  await h.control('fault',{missingAlarm:true});assert.equal((await h.socket()).status,503);
  await h.control('fault',{missingAlarm:false});const peer=await h.socket();assert.equal(peer.status,101);
  await h.db.prepare("UPDATE terminal_nodes SET credential_version = credential_version + 1 WHERE server_id='node-a'").run();
  peer.ws.send(rawExample('report'));await until(async()=>!!input(await h.snapshot())?.latest);
  await h.control('fault',{auth:true});await h.control('alarm');await until(()=>peer.ws.readyState!==1);
  await h.control('fault',{auth:false});const next=await h.socket();assert.equal(next.status,101);
  await h.control('expire');await h.control('alarm');await until(()=>next.ws.readyState!==1);
});

test('upgrade await cannot revive a rotated token, and delete/alarm invalidates native authority', async t => {
  const h=await createMonitorRuntimeFixture(t);
  await h.control('fault',{pauseAlarm:true});const pending=h.socket();
  await until(async()=>(await h.snapshot()).fault.paused);
  const replacement=await issueNodeToken(h.db,'node-a');
  await h.control('release');assert.equal((await pending).status,401);
  h.nodes['node-a']=replacement;const peer=await h.socket();assert.equal(peer.status,101);
  await h.db.prepare("DELETE FROM servers WHERE id='node-a'").run();
  await h.control('alarm');await until(()=>peer.ws.readyState!==1);
});

test('same durable state reconstruction restores principal/generation but never invents durable latest or ACK', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  peer.ws.send(rawExample('report'));await until(async()=>!!input(await h.snapshot())?.latest);
  const before=await h.snapshot();await h.control('rebuild');const after=await h.snapshot();
  assert.notEqual(after.helperIdentity,before.helperIdentity);
  assert.deepEqual(after.owners,before.owners);
  assert.deepEqual(after.durable,before.durable);
  assert.equal(after.inputs.length,0);
  send(peer,'report',{cpu:9});await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===9);
  const steady=await h.snapshot();send(peer,'report',{cpu:10});
  await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===10);
  assert.equal((await h.snapshot()).counts.puts,steady.counts.puts);
});

test('a removed durable alarm cannot authorize another native frame or strand the POST owner', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  await h.control('removeAlarm');send(peer,'report',{cpu:19});
  await until(()=>peer.ws.readyState!==1);
  assert.equal(input(await h.snapshot())?.latest ?? null,null);
  assert.equal((await h.post(legacy(20))).status,200);
});

test('queued unowned Worker batch cannot overwrite current native latest cache', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  send(peer,'report',{cpu:51});await until(async()=>!!input(await h.snapshot())?.latest);
  await h.control('batch',{updates:[{serverId:'node-a',samples:[{ts:Date.now()+1000,payload:{cpu:99}}]}]});
  assert.equal((await h.snapshot()).latest.some(([node])=>node==='node-a'),false);
  assert.equal(input(await h.snapshot()).latest.report.cpu,51);
});

test('native tasks read failures, ICMP and 65 tasks are accurate errors, never fake empty or truncated arrays', async t => {
  const h=await createMonitorRuntimeFixture(t);
  const task={name:'TCP',target:'example.com:443',interval:3600,auto_join:false,nodes:['node-a']};
  await changeLatencyTasks(h.db,{},'save',task);
  await h.control('fault',{tasks:true});assert.equal((await h.socket()).status,503);
  await h.control('fault',{tasks:false});
  await h.db.prepare("UPDATE servers SET ping_mode='icmp' WHERE id='node-a'").run();
  const icmp=await h.socket();assert.equal(icmp.status,101);
  assert.equal(icmp.headers['x-cfsm-monitor-probes'],'monitor_icmp_tasks_unavailable');
  send(icmp,'report',{cpu:41});await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===41);
  assert.equal(input(await h.snapshot()).probeAvailability.error,'monitor_icmp_tasks_unavailable');
  assert.equal(frames(icmp).some(frame=>frame.method==='ping.tasks'),false);
  icmp.ws.close();
  await h.db.prepare("UPDATE servers SET ping_mode='tcp' WHERE id='node-a'").run();
  const document=await (await h.db.prepare("SELECT value FROM settings WHERE key='latency_tasks'").first());
  // Use the supported mutation caller rather than replacing a chunked catalog with a partial fixture.
  for(let i=1;i<65;i++) await changeLatencyTasks(h.db,{},'save',{...task,name:`TCP ${i}`});
  const tooMany=await h.socket();assert.equal(tooMany.status,101);
  assert.equal(tooMany.headers['x-cfsm-monitor-probes'],'monitor_tcp_tasks_limit');
  send(tooMany,'report',{cpu:42});await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===42);
  assert.equal(input(await h.snapshot()).probeAvailability.count,65);
  assert.equal(frames(tooMany).some(frame=>frame.method==='ping.tasks'),false);
  tooMany.ws.close();
  const read=await import('../src/database/latencyTasks.js');assert.equal((await read.readLatencyTaskDocument(h.db)).tasks.length,65);
  assert.ok(document);
  const catalog=await read.readLatencyTaskDocument(h.db);
  await changeLatencyTasks(h.db,{},'delete',{id:catalog.tasks[64].id});
  const peer=await h.socket();assert.equal(peer.status,101);
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params.length===64));
  assert.ok(frames(peer).find(frame=>frame.method==='ping.tasks').params.every(task=>typeof task.id==='number'&&task.interval===3600));
});

test('delayed native result finishes before takeover; old close/error cannot revive old principal or facts', async t => {
  const h=await createMonitorRuntimeFixture(t);
  await changeLatencyTasks(h.db,{},'save',{name:'TCP',target:'example.com:443',interval:5,auto_join:false,nodes:['node-a']});
  const old=await h.socket();assert.equal(old.status,101);
  send(old,'hello',{os:'old'});send(old,'report',{cpu:1});await until(async()=>!!input(await h.snapshot())?.latest);
  await h.control('fault',{pauseTasks:true});send(old,'ping.result',{task_id:1,latency_ms:6});
  await until(async()=>(await h.snapshot()).fault.paused);
  const pending=h.socket();await h.control('release');const peer=await pending;assert.equal(peer.status,101);
  send(peer,'hello',{os:'new'});send(peer,'report',{cpu:2});await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===2);
  old.ws.terminate();
  assert.equal(input(await h.snapshot()).facts.os,'new');assert.deepEqual(input(await h.snapshot()).probes,[]);
});

test('native sensitive/wrong-role/malformed notifications close safely; exact counters and sanitized facts survive normal frames', async t => {
  const h=await createMonitorRuntimeFixture(t);
  for (const raw of ['{not json','{"jsonrpc":"2.0","method":"ping.tasks","params":[]}',
    '{"jsonrpc":"2.0","method":"report","params":{"nested":{"node_token":"secret-marker"}}}']) {
    const peer=await h.socket();assert.equal(peer.status,101);peer.ws.send(raw);await until(()=>peer.ws.readyState!==1);
    assert.equal(peer.messages.join('').includes('secret-marker'),false);
  }
  const peer=await h.socket();send(peer,'hello',{os:'<a>\u0000"'+ '界'.repeat(150),cpu_cores:'2',unexpected:'do-not-store'});
  peer.ws.send('{"jsonrpc":"2.0","method":"report","params":{"boot_id":"epoch","net_rx_total":9223372036854775807,"net_tx_total":0}}');
  await until(async()=>input(await h.snapshot())?.latest?.report?.net_rx_total==='9223372036854775807');
  const received=input(await h.snapshot());assert.equal([...received.facts.os].length,128);assert.equal(received.facts.cpu_cores,0);
  assert.equal(received.facts.unexpected,undefined);assert.equal(received.latest.trafficReading.tx,'0');
});

test('native token revocation notification is generation-safe and policy queries fail closed', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  const rotated=await issueNodeToken(h.db,'node-a');
  await h.control('invalidate',{serverId:'node-a',tokenVersion:rotated.tokenVersion});
  await until(()=>peer.ws.readyState!==1);h.nodes['node-a']=rotated;
  const next=await h.socket();assert.equal(next.status,101);
  await h.control('invalidate',{serverId:'node-a',tokenVersion:rotated.tokenVersion - 1});
  send(next,'report',{cpu:29});await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===29);
  await h.control('fault',{policy:true});await h.control('alarm');await until(()=>next.ws.readyState!==1);
});

test('dispose/reopen the same persisted D1/global DO restores numeric IDs and generation, not transient facts', async t => {
  const root=await mkdtemp(join(tmpdir(),'cfsm-s2-session-'));
  let first,second;
  try {
    first=await createMonitorRuntimeFixture(null,{persistencePath:root});
    await changeLatencyTasks(first.db,{},'save',{name:'TCP',target:'example.com:443',interval:60,auto_join:false,nodes:['node-a']});
    const peer=await first.socket();assert.equal(peer.status,101);
    await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===1));
    send(peer,'report',{cpu:1});await until(async()=>!!input(await first.snapshot())?.latest);
    const snapshot=await first.snapshot(),owner=snapshot.owners.find(([id])=>id==='node-a')[1],nodes=first.nodes;
    await first.dispose();first=null;
    assert.ok((await readdir(root)).length>0);
    second=await createMonitorRuntimeFixture(null,{persistencePath:root,nodes,seed:false});
    const restored=await second.snapshot(),previous=restored.owners.find(([id])=>id==='node-a')[1];
    assert.equal(previous.generation,owner.generation);assert.equal(previous.tokenVersion,owner.tokenVersion);
    assert.deepEqual(restored.inputs,[]);
    const next=await second.socket();assert.equal(next.status,101);
    await until(()=>frames(next).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===1));
    const nextOwner=(await second.snapshot()).owners.find(([id])=>id==='node-a')[1];
    assert.equal(nextOwner.generation,owner.generation+1);
    assert.equal((await second.db.prepare('SELECT COUNT(*) AS count FROM monitor_probe_ids').first()).count,1);
    t.diagnostic(JSON.stringify({samePersistence:true,oldGeneration:owner.generation,restoredGeneration:previous.generation,newGeneration:nextOwner.generation,taskId:1,transientLatestRestored:false}));
  } finally {
    await first?.dispose();await second?.dispose();
    const absolute=resolve(root),base=resolve(tmpdir());
    assert.ok(dirname(absolute) === base && absolute.split(/[\\/]/).at(-1).startsWith('cfsm-s2-session-'));
    await rm(absolute,{recursive:true,force:true});
  }
});

test('actual POST history/cache effects stay inside the owner queue across an awaited D1 insert', async t => {
  const h=await createMonitorRuntimeFixture(t);
  await h.control('fault',{pauseHistory:true});
  const pendingPost=h.post(legacy(61));
  await until(async()=>(await h.snapshot()).fault.paused);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count,0);
  const takeover=h.socket();
  await h.control('release');assert.equal((await pendingPost).status,200);
  const peer=await takeover;assert.equal(peer.status,101);
  send(peer,'report',{cpu:62});await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===62);
  assert.equal((await h.snapshot()).latest.some(([node])=>node==='node-a'),false);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count,1);
  assert.equal((await h.post(legacy(63))).status,409);
});

test('reconstruction relinquishes orphaned native ownership, keeping its persisted generation for the next socket', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  const generation=(await h.snapshot()).owners[0][1].generation;
  peer.ws.close();await until(async()=>(await h.snapshot()).owners[0][1].active===false);
  await h.control('orphanOwner');await h.control('rebuild');
  assert.equal((await h.post(legacy(64))).status,200);
  const next=await h.socket();assert.equal(next.status,101);
  assert.equal((await h.snapshot()).owners[0][1].generation,generation+1);
});

test('hello cores preserve Rust i64 admission: float token falls back to zero, exact large integer stays exact', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  peer.ws.send('{"jsonrpc":"2.0","method":"hello","params":{"cpu_cores":1.0}}');
  await until(async()=>!!input(await h.snapshot())?.facts);
  assert.equal(input(await h.snapshot()).facts.cpu_cores,0);
  peer.ws.send('{"jsonrpc":"2.0","method":"hello","params":{"cpu_cores":9007199254740993}}');
  await until(async()=>input(await h.snapshot()).facts.cpu_cores==='9007199254740993');
});

test('an in-progress shared alarm does not mistake its consumed deadline for missing authorization on another node', async t => {
  const h=await createMonitorRuntimeFixture(t),a=await h.socket(),b=await h.socket('/api/agent/ws','node-b');
  assert.equal(a.status,101);assert.equal(b.status,101);
  await h.control('fault',{pauseAuthorityNode:'node-a'});const pending=h.control('alarm');
  await until(async()=>(await h.snapshot()).fault.pausedNode==='node-a');
  send(b,'report',{cpu:72});
  try { await until(async()=>input(await h.snapshot(),'node-b')?.latest?.report?.cpu===72,'other-node report during alarm'); }
  finally {await h.control('release');await pending;}
  assert.equal(b.ws.readyState,1);
});

test('an incompatible probe config revokes prior tasks without stopping standard monitoring, and TCP recovery keeps numeric identity', async t => {
  const h=await createMonitorRuntimeFixture(t);
  await changeLatencyTasks(h.db,{},'save',{name:'TCP',target:'example.com:443',interval:5,auto_join:false,nodes:['node-a']});
  const peer=await h.socket();assert.equal(peer.status,101);
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===1));
  await h.db.prepare("UPDATE servers SET ping_mode='icmp' WHERE id='node-a'").run();await h.control('config');
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params.length===0));
  send(peer,'ping.result',{task_id:1,latency_ms:5});send(peer,'report',{cpu:81});
  await until(async()=>input(await h.snapshot())?.latest?.report?.cpu===81);
  assert.equal(input(await h.snapshot()).probes.length,0);
  assert.equal(input(await h.snapshot()).probeAvailability.available,false);assert.equal(peer.ws.readyState,1);
  await h.db.prepare("UPDATE servers SET ping_mode='tcp' WHERE id='node-a'").run();await h.control('config');
  send(peer,'ping.result',{task_id:1,latency_ms:6});
  await until(async()=>input(await h.snapshot()).probes.length===1);
  assert.equal(input(await h.snapshot()).probeAvailability.available,true);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM monitor_probe_ids').first()).count,1);
});

test('native revocation accepts the same 128-character node principal contract as nodeAuth', async t => {
  const h=await createMonitorRuntimeFixture(t),id='n'.repeat(128);
  await h.db.prepare('INSERT INTO servers(id,name,history_partition_id) VALUES(?,?,3)').bind(id,'long-node').run();
  h.nodes[id]=await issueNodeToken(h.db,id);
  const peer=await h.socket('/api/agent/ws',id);assert.equal(peer.status,101);
  const rotated=await issueNodeToken(h.db,id);
  await h.control('invalidate',{serverId:id,tokenVersion:rotated.tokenVersion});
  await until(()=>peer.ws.readyState!==1,'long principal token revocation');
});

test('a delayed alarm read cannot let the cached native authorization path outlive its lease', async t => {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();assert.equal(peer.status,101);
  await h.control('fault',{delayedAlarmRead:true});send(peer,'report',{cpu:90});
  await until(()=>peer.ws.readyState!==1,'native lease expiry after alarm await');
  assert.equal(input(await h.snapshot())?.latest ?? null,null);
});

test('128-character native principal receives task generation refresh and revocation through the original config caller', async t => {
  const h=await createMonitorRuntimeFixture(t),id='n'.repeat(128);
  await h.db.prepare('INSERT INTO servers(id,name,history_partition_id) VALUES(?,?,3)').bind(id,'long-node').run();
  h.nodes[id]=await issueNodeToken(h.db,id);
  const task={name:'TCP',target:'example.com:443',interval:5,auto_join:false,nodes:[id]};
  const document=await changeLatencyTasks(h.db,{},'save',task);
  const peer=await h.socket('/api/agent/ws',id);assert.equal(peer.status,101);
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===1));
  await changeLatencyTasks(h.db,{},'save',{...task,id:document.tasks[0].id,base:[id],target:'next.example.com:443'});
  await h.control('config');
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===2),'long principal task generation refresh');
  send(peer,'ping.result',{task_id:1,latency_ms:7});send(peer,'ping.result',{task_id:2,latency_ms:8});
  await until(async()=>input(await h.snapshot(),id)?.probes.length===1);
  assert.equal(input(await h.snapshot(),id).probes[0].taskId,2);
  await h.db.prepare('UPDATE servers SET ping_mode=? WHERE id=?').bind('icmp',id).run();await h.control('config');
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params.length===0),'long principal task revocation');
  send(peer,'report',{cpu:91});await until(async()=>input(await h.snapshot(),id)?.latest?.report.cpu===91);
  assert.equal(input(await h.snapshot(),id).probeAvailability.available,false);
  assert.equal(peer.ws.readyState,1);
});

test('native probe catalog await rechecks the current lease before accepting a probe fact', async t => {
  const h=await createMonitorRuntimeFixture(t);
  await changeLatencyTasks(h.db,{},'save',{name:'TCP',target:'example.com:443',interval:5,auto_join:false,nodes:['node-a']});
  const peer=await h.socket();assert.equal(peer.status,101);
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===1));
  await h.control('fault',{pauseTasks:true});send(peer,'ping.result',{task_id:1,latency_ms:9});
  await until(async()=>(await h.snapshot()).fault.paused);
  await h.control('expire');await h.control('release');
  await until(()=>peer.ws.readyState!==1,'probe await lease expiry');
  assert.equal(input(await h.snapshot())?.probes.length??0,0);
});

test('native config task catalog await cannot dispatch or save refreshed tasks after lease expiry', async t => {
  const h=await createMonitorRuntimeFixture(t);
  const task={name:'TCP',target:'example.com:443',interval:5,auto_join:false,nodes:['node-a']};
  const document=await changeLatencyTasks(h.db,{},'save',task);
  const peer=await h.socket();assert.equal(peer.status,101);
  await until(()=>frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===1));
  await changeLatencyTasks(h.db,{},'save',{...task,id:document.tasks[0].id,base:['node-a'],target:'next.example.com:443'});
  await h.control('fault',{pauseTasks:true});const pending=h.control('config');
  await until(async()=>(await h.snapshot()).fault.paused);
  await h.control('expire');await h.control('release');await pending;
  await until(()=>peer.ws.readyState!==1,'config await lease expiry');
  assert.equal(frames(peer).some(frame=>frame.method==='ping.tasks'&&frame.params[0]?.id===2),false);
  const attachment=(await h.snapshot()).attachments.find(value=>value.kind==='monitor-agent');
  if (attachment) assert.equal(attachment.tasks.some(value=>value.taskId===2),false);
});
