import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, until, controls, openPair } from './terminal-harness.js';

const binary = peer => peer.messages.filter(value => typeof value !== 'string');
const snapshot = async h => (await h.fetch('/test/snapshot')).json();
async function running(h, control) {
  const pair = await openPair(h, control);
  await until(() => controls(pair.agent).some(f => f.type === 'start'));
  pair.agent.ws.send('{"type":"ready"}');
  await until(() => controls(pair.browser).some(f => f.type === 'ready'));
  return pair;
}
async function fill(sender, receiver) {
  const before = binary(receiver).length;
  for (let i = 0; i < 16; i++) sender.ws.send(new Uint8Array(16384));
  await until(() => binary(receiver).length === before + 16);
}

for (const role of ['browser', 'agent']) {
  test(`${role} exact 256KiB credit, cumulative ACK and restored counters`, async () => {
    const h = await harness();
    try {
      const pair = await running(h, await h.control());
      const sender = pair[role], receiver = pair[role === 'browser' ? 'agent' : 'browser'];
      await fill(sender, receiver);
      await h.fetch('/test/rebuild');
      receiver.ws.send('{"type":"ack","bytes":16384}');
      await until(() => controls(sender).some(f => f.type === 'ack' && f.bytes === 16384));
      sender.ws.send(new Uint8Array(16384));
      await until(() => binary(receiver).length === 17);
      sender.ws.send(new Uint8Array([1]));
      await until(() => sender.ws.readyState !== 1);
      assert.equal(binary(receiver).length, 17, 'over-credit byte is never forwarded');
      assert.equal(controls(pair.agent).filter(f => f.type === 'start').length, 1);
      assert.equal((await snapshot(h)).meta.sessions.length, 0);
    } finally { await h.dispose(); }
  });

  for (const badAck of [0, 3, 9007199254740992]) {
    test(`${role} rejects backward, beyond-forwarded or unsafe ACK ${badAck}`, async () => {
      const h = await harness();
      try {
        const control = await h.control();
        const pair = await running(h, control), other = await running(h, control);
        const receiver = pair[role], sender = pair[role === 'browser' ? 'agent' : 'browser'];
        sender.ws.send(new Uint8Array([1, 2]));
        await until(() => binary(receiver).length === 1);
        receiver.ws.send('{"type":"ack","bytes":1}');
        await until(() => controls(sender).some(f => f.type === 'ack'));
        receiver.ws.send(JSON.stringify({type:'ack', bytes:badAck}));
        await until(() => receiver.ws.readyState !== 1);
        other.browser.ws.send(new Uint8Array([7]));
        await until(() => binary(other.agent).length === 1);
        assert.equal(sender.ws.readyState === 1, false);
        assert.equal(other.agent.ws.readyState, 1);
      } finally { await h.dispose(); }
    });
  }
}

test('four sessions hold at most 2MiB outstanding; hot data/ACK have zero D1/storage/alarm/timer operations', async () => {
  const h = await harness();
  try {
    const control = await h.control(), pairs = [];
    for (let i = 0; i < 4; i++) pairs.push(await running(h, control));
    const before = await (await h.fetch('/test/stats')).json();
    const workerBefore = await (await h.fetch('/test/worker-stats')).json();
    const attachmentBefore = (await (await h.fetch('/test/attachment-stats')).json()).writes;
    for (const pair of pairs) {
      await fill(pair.browser, pair.agent);
      await fill(pair.agent, pair.browser);
    }
    assert.deepEqual(await (await h.fetch('/test/stats')).json(), before);
    const attachments = (await snapshot(h)).attachments;
    const producers = attachments.filter(a => a.role !== 'agent-control');
    assert.equal(producers.length, 8);
    assert.equal(producers.reduce((n, a) => n + a.forwarded - a.acked, 0), 2097152);
    const beforeAck = await (await h.fetch('/test/stats')).json();
    for (const pair of pairs) for (const role of ['browser', 'agent']) pair[role].ws.send('{"type":"ack","bytes":262144}');
    await until(() => pairs.every(p => controls(p.browser).some(f => f.type === 'ack') && controls(p.agent).some(f => f.type === 'ack')));
    assert.deepEqual(await (await h.fetch('/test/stats')).json(), beforeAck);
    assert.deepEqual(await (await h.fetch('/test/worker-stats')).json(), workerBefore);
    assert.equal((await (await h.fetch('/test/attachment-stats')).json()).writes - attachmentBefore,136);
  } finally { await h.dispose(); }
});

test('duplicate ACK, heartbeat and more output cannot postpone 30s stall; another session remains responsive', async () => {
  const h = await harness();
  try {
    const control = await h.control(), stalled = await running(h, control), healthy = await running(h, control);
    stalled.agent.ws.send(new Uint8Array([1, 2]));
    await until(() => binary(stalled.browser).length === 1);
    stalled.browser.ws.send('{"type":"ack","bytes":1}');
    await until(() => controls(stalled.agent).some(f => f.type === 'ack'));
    await h.fetch('/test/clock?advance=29000');
    stalled.browser.ws.send('{"type":"ack","bytes":1}');
    stalled.agent.ws.send(new Uint8Array([3]));
    await until(() => binary(stalled.browser).length === 2);
    await h.fetch('/test/rebuild');
    await h.fetch('/test/clock?advance=1001');
    await h.fetch('/test/alarm');
    await until(() => stalled.browser.ws.readyState !== 1);
    healthy.browser.ws.send(new Uint8Array([9]));
    await until(() => binary(healthy.agent).length === 1);
    assert.equal(healthy.browser.ws.readyState, 1);
    assert.ok(controls(control).some(f => f.sessionId === stalled.session.sessionId && f.reason === 'ack_stalled'));
  } finally { await h.dispose(); }
});

test('ACK progress refreshes stall only while outstanding; exhausted windows do not queue', async () => {
  const h = await harness();
  try {
    const pair = await running(h, await h.control());
    await fill(pair.agent, pair.browser);
    await h.fetch('/test/clock?advance=29000');
    pair.browser.ws.send('{"type":"ack","bytes":1}');
    await until(() => controls(pair.agent).some(f => f.type === 'ack'));
    await h.fetch('/test/clock?advance=2000');
    await h.fetch('/test/alarm');
    assert.equal(pair.agent.ws.readyState, 1);
    pair.browser.ws.send('{"type":"ack","bytes":262144}');
    await until(() => controls(pair.agent).some(f => f.bytes === 262144));
    await h.fetch('/test/clock?advance=28001');
    await h.fetch('/test/alarm');
    assert.equal(pair.agent.ws.readyState, 1);
  } finally { await h.dispose(); }
});

test('binary typed JSON stays data; valid resize only forwards to its own peer', async () => {
  const h = await harness();
  try {
    const pair = await running(h, await h.control());
    pair.browser.ws.send(new TextEncoder().encode('{"type":"exit","code":0}'));
    await until(() => binary(pair.agent).length === 1);
    assert.equal(new TextDecoder().decode(binary(pair.agent)[0]), '{"type":"exit","code":0}');
    pair.browser.ws.send('{"type":"resize","cols":500,"rows":1}');
    await until(() => controls(pair.agent).some(f => f.type === 'resize'));
    const browser = (await snapshot(h)).attachments.find(a => a.role === 'browser');
    assert.ok(browser.lastUserActivity > 0);
    pair.browser.ws.send('{"type":"resize","cols":501,"rows":1}');
    await until(() => pair.agent.ws.readyState !== 1);
  } finally { await h.dispose(); }
});

test('a synchronous peer send failure frees only that session and never waits on another writer', async () => {
  const h = await harness();
  try {
    const control = await h.control(), bad = await running(h, control), good = await running(h, control);
    await h.fetch('/test/fail-send?session=' + bad.session.sessionId);
    bad.browser.ws.send(new Uint8Array([1]));
    good.browser.ws.send(new Uint8Array([2]));
    await until(() => bad.browser.ws.readyState !== 1 && binary(good.agent).length === 1);
    assert.equal(good.browser.ws.readyState, 1);
  } finally { await h.dispose(); }
});

test('first outstanding alarm failure and attachment persistence failure close only their session', async () => {
  for (const fault of ['alarm', 'attachment']) {
    const h=await harness();
    try {
      const control=await h.control(), bad=await running(h,control), good=await running(h,control);
      await h.fetch('/test/clock?advance=45000');
      for (const p of [bad,good]) assert.equal((await h.action('terminal_renew',{serverId:'node-a',sessionId:p.session.sessionId})).status,200);
      await h.fetch('/test/clock?advance=16000');
      await h.fetch('/test/alarm');
      if (fault==='alarm') await h.fetch('/test/fail-storage-once?kind=setAlarm');
      else await h.fetch('/test/fail-attachment?session='+bad.session.sessionId);
      bad.browser.ws.send(new Uint8Array([1]));
      await until(()=>bad.browser.ws.readyState!==1);
      good.browser.ws.send(new Uint8Array([2]));
      await until(()=>binary(good.agent).length===1);
      assert.equal((await snapshot(h)).meta.sessions.length,1);
      assert.equal((await snapshot(h)).blocked,false);
      await h.fetch('/test/rebuild');
      good.agent.ws.send(new Uint8Array([3]));
      await until(()=>binary(good.browser).length===1);
    } finally {await h.dispose();}
  }
});

test('reconstruction fails closed on impossible or oversized saved credit counters', async () => {
  for (const forwarded of [-1, 262145, 9007199254740992]) {
    const h=await harness();
    try {
      const p=await running(h,await h.control());
      await h.fetch('/test/corrupt-attachment?session='+p.session.sessionId+'&role=browser&forwarded='+forwarded);
      await h.fetch('/test/rebuild');
      await until(()=>p.browser.ws.readyState!==1 && p.agent.ws.readyState!==1);
      assert.equal((await snapshot(h)).meta.sessions.length,0);
    } finally {await h.dispose();}
  }
});

test('concurrent first-outstanding transitions deduplicate a pending earliest alarm without blocking another session', async () => {
  const h=await harness();
  try {
    const control=await h.control(), first=await running(h,control), second=await running(h,control);
    await h.fetch('/test/clock?advance=45000');
    for (const p of [first,second]) assert.equal((await h.action('terminal_renew',{serverId:'node-a',sessionId:p.session.sessionId})).status,200);
    await h.fetch('/test/clock?advance=16000');
    await h.fetch('/test/alarm');
    const before=await (await h.fetch('/test/stats')).json();
    await h.fetch('/test/pause-alarm');
    first.browser.ws.send(new Uint8Array([1]));
    await until(async()=> (await (await h.fetch('/test/alarm-pending')).json()).pending);
    second.browser.ws.send(new Uint8Array([2]));
    await until(()=>binary(second.agent).length===1);
    const after=await (await h.fetch('/test/stats')).json();
    await h.fetch('/test/release-alarm');
    assert.equal(after.alarms-before.alarms,1);
    assert.equal(after.writes,before.writes);
    assert.equal(second.browser.ws.readyState,1);
  } finally {await h.fetch('/test/release-alarm'); await h.dispose();}
});
