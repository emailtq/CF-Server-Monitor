import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness, until, controls, openPair } from './terminal-harness.js';

test('browser receives dimensioned start before ready exactly once across duplicate admission and reconstruction', async () => {
  const h = await harness();
  try {
    const pair = await openPair(h, await h.control());
    await until(() => controls(pair.agent).some(frame => frame.type === 'start'));
    await h.fetch('/test/rebuild');
    assert.equal((await h.socket(pair.session.browserPath, {Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`})).response.status, 409);
    assert.equal((await h.socket(`/api/agent/terminal/session/${pair.session.sessionId}`, {...h.agentHeaders(), 'X-CFSM-Terminal-Ticket':pair.open.ticket})).response.status, 409);
    pair.agent.ws.send('{"type":"ready"}');
    await until(() => controls(pair.browser).some(frame => frame.type === 'ready'));
    assert.deepEqual(controls(pair.browser).filter(frame => ['start','ready'].includes(frame.type)), [
      {type:'start', cols:80, rows:24}, {type:'ready'}
    ]);
    assert.equal(controls(pair.agent).filter(frame => frame.type === 'start').length, 1);
    await h.fetch('/test/rebuild');
    pair.agent.ws.send(new Uint8Array([65]));
    await until(() => pair.browser.messages.some(value => typeof value !== 'string'));
    assert.equal(controls(pair.browser).filter(frame => frame.type === 'start').length, 1);
    assert.equal(controls(pair.agent).filter(frame => frame.type === 'start').length, 1);
  } finally { await h.dispose(); }
});

test('two same-node sessions start only after pairing and ready, then route bytes independently', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    assert.equal(control.response.status, 101);
    const first = await openPair(h, control);
    const second = await openPair(h, control);
    for (const pair of [first, second]) {
      assert.equal(pair.browser.response.status, 101);
      assert.equal(pair.agent.response.status, 101);
      await until(() => controls(pair.agent).some(frame => frame.type === 'start'));
      pair.agent.ws.send('{"type":"ready"}');
      await until(() => controls(pair.browser).some(frame => frame.type === 'ready'));
    }
    first.browser.ws.send(new Uint8Array([65,66]));
    second.agent.ws.send(new Uint8Array([67]));
    await until(() => first.agent.messages.some(value => typeof value !== 'string') && second.browser.messages.some(value => typeof value !== 'string'));
    assert.deepEqual([...new Uint8Array(first.agent.messages.find(value => typeof value !== 'string'))], [65,66]);
    assert.equal(second.agent.messages.filter(value => typeof value !== 'string').length, 0);
    assert.equal(first.browser.messages.filter(value => typeof value !== 'string').length, 0);
    await h.fetch('/test/rebuild');
    first.agent.ws.send(new Uint8Array([68]));
    await until(() => first.browser.messages.some(value => typeof value !== 'string'));
    assert.deepEqual([...new Uint8Array(first.browser.messages.find(value => typeof value !== 'string'))], [68]);
    assert.equal(controls(first.agent).filter(frame => frame.type === 'start').length, 1);
    const before = await (await h.fetch('/test/stats')).json();
    const workerBefore = await (await h.fetch('/test/worker-stats')).json();
    first.browser.ws.send(new Uint8Array([69]));
    await until(() => first.agent.messages.filter(value => typeof value !== 'string').length === 2);
    const after = await (await h.fetch('/test/stats')).json();
    assert.deepEqual(after, before, 'terminal data must perform no storage/alarm/D1 operations');
    assert.deepEqual(await (await h.fetch('/test/worker-stats')).json(), workerBefore);
  } finally { await h.dispose(); }
});

test('browser must use same-origin Cookie ownership; tickets cannot cross nodes or be reused', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    assert.equal(control.response.status, 101);
    const pair = await openPair(h, control);
    for (const headers of [{Origin:'https://evil.example', Cookie:`cfsm_auth=${h.token}`}, {Origin:'https://example.com', Authorization:`Bearer ${h.token}`}, {Origin:'https://example.com', Cookie:`cfsm_auth=${h.otherToken}`}]) {
      assert.notEqual((await h.socket(pair.session.browserPath, headers)).response.status, 101);
    }
    assert.notEqual((await h.socket(`${pair.session.browserPath}?token=${h.token}`, {Origin:'https://example.com'})).response.status, 101);
    assert.equal((await h.socket(pair.session.browserPath, {Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`})).response.status, 409);
    const path = `/api/agent/terminal/session/${pair.session.sessionId}`;
    assert.notEqual((await h.socket(path, {...h.agentHeaders('node-b'), 'X-CFSM-Terminal-Ticket':pair.open.ticket})).response.status, 101);
    assert.equal((await h.socket(path, {...h.agentHeaders(), 'X-CFSM-Terminal-Ticket':pair.open.ticket})).response.status, 409);
  } finally { await h.dispose(); }
});

test('atomic four-slot reservation, retry idempotency, timeout and late admission denial', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    assert.equal(control.response.status, 101);
    const data = {serverId:'node-a', clientRequestId:'same-request', cols:80, rows:24};
    const retries = await Promise.all([h.action('terminal_open', data), h.action('terminal_open', data)]);
    assert.deepEqual(retries.map(r => r.status), [200,200]);
    const sessions = await Promise.all(retries.map(r => r.json()));
    assert.equal(sessions[0].sessionId, sessions[1].sessionId);
    assert.equal((await h.action('terminal_open', {...data, cols:81})).status, 409);
    assert.equal((await h.action('terminal_open', data, {headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.otherToken)}`}})).status, 409);
    const responses = await Promise.all([1,2,3,4].map(i => h.action('terminal_open', {...data, clientRequestId:`request-${i}`})));
    assert.deepEqual(responses.map(r => r.status).sort(), [200,200,200,409]);
    await h.fetch('/test/expire');
    await until(async () => (await (await h.action('terminal_status', {serverId:'node-a'})).json()).activeCount === 0);
    assert.equal((await h.socket(sessions[0].browserPath, {Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`})).response.status, 409);
    assert.equal((await h.action('terminal_status', {serverId:'node-a'})).status, 200);
    assert.equal((await (await h.action('terminal_status', {serverId:'node-a'})).json()).activeCount, 0);
  } finally { await h.dispose(); }
});

test('failed admission audit releases slots and sends no open/start to agent', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    assert.equal(control.response.status, 101);
    await h.fetch('/test/fail-audit');
    assert.equal((await h.action('terminal_open', {serverId:'node-a', clientRequestId:'audit-fail', cols:80, rows:24})).status, 503);
    assert.equal(controls(control).filter(frame => frame.type === 'open').length, 0);
    assert.equal((await (await h.action('terminal_status', {serverId:'node-a'})).json()).activeCount, 0);
  } finally { await h.dispose(); }
});

test('agent waits for browser and admission audit; wrong ticket/role and input before ready never start a PTY', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const response = await h.action('terminal_open', {serverId:'node-a', clientRequestId:'pair-gate', cols:80, rows:24});
    const session = await response.json();
    await until(() => controls(control).some(f => f.type === 'open'));
    const open = controls(control).find(f => f.type === 'open');
    const path = `/api/agent/terminal/session/${session.sessionId}`;
    assert.equal((await h.socket(path, {...h.agentHeaders(), 'X-CFSM-Terminal-Ticket':'0'.repeat(64)})).response.status, 403);
    const agent = await h.socket(path, {...h.agentHeaders(), 'X-CFSM-Terminal-Ticket':open.ticket});
    assert.equal(agent.response.status, 101);
    agent.ws.send('{"type":"ping"}');
    await until(() => controls(agent).some(f => f.type === 'pong'));
    assert.equal(controls(agent).filter(f => f.type === 'start').length, 0);
    await h.fetch('/test/fail-audit');
    const browser = await h.socket(session.browserPath, {Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`});
    await until(() => agent.ws.readyState !== 1);
    assert.equal(controls(agent).filter(f => f.type === 'start').length, 0);
    assert.equal(controls(browser).filter(f => f.type === 'start').length, 0);
  } finally { await h.dispose(); }
});

test('control generation replacement invalidates old tickets; malformed frames close only their session', async () => {
  const h = await harness();
  try {
    const oldControl = await h.control();
    const old = await openPair(h, oldControl);
    const control = await h.control();
    await until(() => old.agent.ws.readyState !== 1);
    assert.notEqual((await h.socket(`/api/agent/terminal/session/${old.session.sessionId}`, {...h.agentHeaders(), 'X-CFSM-Terminal-Ticket':old.open.ticket})).response.status, 101);
    const first = await openPair(h, control);
    const second = await openPair(h, control);
    await until(() => controls(first.agent).some(f => f.type === 'start'));
    first.browser.ws.send(new Uint8Array([65]));
    await until(() => first.agent.ws.readyState !== 1);
    assert.equal(first.agent.messages.filter(m => typeof m !== 'string').length, 0);
    second.agent.ws.send('{"type":"ready"}');
    await until(() => controls(second.browser).some(f => f.type === 'ready'));
    second.browser.ws.send(new Uint8Array(16385));
    await until(() => second.agent.ws.readyState !== 1);
    assert.equal(second.agent.messages.filter(m => typeof m !== 'string').length, 0);
  } finally { await h.dispose(); }
});

test('idle control auto-heartbeats do not invoke broker code, D1, storage or alarms', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const before = await (await h.fetch('/test/stats')).json();
    const workerBefore = await (await h.fetch('/test/worker-stats')).json();
    for (let i=0; i<3; i++) control.ws.send('{"type":"ping"}');
    await until(() => controls(control).filter(f => f.type === 'pong').length === 3);
    assert.deepEqual(await (await h.fetch('/test/stats')).json(), before);
    assert.deepEqual(await (await h.fetch('/test/worker-stats')).json(), workerBefore);
    assert.equal(before.alarms, 0);
    assert.equal(workerBefore.timeouts, 0);
    assert.equal(workerBefore.intervals, 0);
  } finally { await h.dispose(); }
});

test('ready racing a slow admission audit cannot grant input or start, and does not lock status requests', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const session = await (await h.action('terminal_open', {serverId:'node-a', clientRequestId:'slow-audit', cols:80, rows:24})).json();
    await until(() => controls(control).some(f => f.type === 'open'));
    const open = controls(control).find(f => f.type === 'open');
    const agent = await h.socket(`/api/agent/terminal/session/${session.sessionId}`, {...h.agentHeaders(), 'X-CFSM-Terminal-Ticket':open.ticket});
    await h.fetch('/test/pause-audit');
    const browserPromise = h.socket(session.browserPath, {Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`});
    await until(async () => (await (await h.fetch('/test/audit-pending')).json()).pending);
    assert.equal((await h.action('terminal_status', {serverId:'node-a'})).status, 200);
    agent.ws.send('{"type":"ready"}');
    await until(async () => (await (await h.action('terminal_status', {serverId:'node-a'})).json()).activeCount === 0);
    await h.fetch('/test/release-audit');
    const browser = await browserPromise;
    assert.equal(controls(agent).filter(f => f.type === 'start').length, 0);
    assert.equal(controls(browser).filter(f => f.type === 'start').length, 0);
    assert.equal(controls(browser).filter(f => f.type === 'ready').length, 0);
  } finally { await h.fetch('/test/release-audit'); await h.dispose(); }
});

test('rotation invalidation is a monotonic credential barrier even for already-validated old requests', async () => {
  const h = await harness();
  try {
    await h.control();
    assert.equal((await h.action('terminal_prepare_install', {serverId:'node-a', terminal:true,acceptRisk:true})).status, 200);
    const response = await h.fetch('/test/internal?op=control', {headers:{Upgrade:'websocket', 'X-CFSM-Terminal-Context':JSON.stringify({serverId:'node-a', role:'agent', credentialVersion:1})}});
    assert.equal(response.status, 403);
  } finally { await h.dispose(); }
});

test('ticket plaintext never persists and the 30-second ticket deadline survives construction rebuild', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const before = Date.now();
    const session = await (await h.action('terminal_open', {serverId:'node-a', clientRequestId:'persist-ticket', cols:80, rows:24})).json();
    await until(() => controls(control).some(f=>f.type==='open'));
    const open = controls(control).find(f=>f.type==='open');
    const snapshot = await (await h.fetch('/test/snapshot')).json();
    const pending = snapshot.meta.sessions[0];
    assert.equal(pending.id, session.sessionId);
    assert.equal(pending.ticketHash, createHash('sha256').update(open.ticket).digest('hex'));
    assert.equal(JSON.stringify(snapshot).includes(open.ticket), false);
    assert.ok(pending.deadline >= before+30000 && pending.deadline <= Date.now()+30000);
    assert.equal(snapshot.alarm, pending.deadline);
    await h.fetch('/test/rebuild');
    await h.fetch('/test/expire');
    await until(async ()=>(await (await h.action('terminal_status', {serverId:'node-a'})).json()).activeCount === 0);
    assert.equal((await h.socket(`/api/agent/terminal/session/${session.sessionId}`, {...h.agentHeaders(), 'X-CFSM-Terminal-Ticket':open.ticket})).response.status, 409);
    assert.equal(controls(control).filter(f=>f.type==='open').length, 1);
  } finally { await h.dispose(); }
});

test('leases renew only for the owner and normal close is idempotent without affecting another node', async () => {
  const h = await harness();
  try {
    const a = await h.control();
    const b = await h.control('node-b');
    const first = await openPair(h, a);
    const other = await openPair(h, b, 'other-node-session', 'node-b');
    const input = {serverId:'node-a', sessionId:first.session.sessionId};
    assert.equal((await h.action('terminal_renew', input, {headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.otherToken)}`}})).status, 403);
    assert.equal((await h.action('terminal_renew', input)).status, 200);
    assert.equal((await h.action('terminal_close', input)).status, 200);
    assert.equal((await h.action('terminal_close', input)).status, 200);
    await until(()=>first.agent.ws.readyState !== 1);
    other.agent.ws.send('{"type":"ready"}');
    await until(()=>controls(other.browser).some(f=>f.type==='ready'));
    other.browser.ws.send(new Uint8Array([88]));
    await until(()=>other.agent.messages.some(m=>typeof m!=='string'));
    assert.deepEqual([...new Uint8Array(other.agent.messages.find(m=>typeof m!=='string'))], [88]);
  } finally { await h.dispose(); }
});

test('duplicate admission and idempotent close do not write unchanged broker state or reset alarms', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const pair = await openPair(h, control);
    await until(()=>controls(pair.agent).some(f=>f.type==='start'));
    const before = await (await h.fetch('/test/stats')).json();
    assert.equal((await h.socket(pair.session.browserPath, {Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`})).response.status, 409);
    const after = await (await h.fetch('/test/stats')).json();
    assert.equal(after.writes, before.writes);
    assert.equal(after.alarms, before.alarms);
    const close = {serverId:'node-a', sessionId:pair.session.sessionId};
    await h.action('terminal_close', close);
    const closed = await (await h.fetch('/test/stats')).json();
    await h.action('terminal_close', close);
    const repeated = await (await h.fetch('/test/stats')).json();
    assert.equal(repeated.writes, closed.writes);
    assert.equal(repeated.alarms, closed.alarms);
  } finally { await h.dispose(); }
});

test('closed-session and retry history remains bounded and constructor restores only live peers', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const first = await openPair(h, control, 'closed-peer');
    await h.action('terminal_close', {serverId:'node-a',sessionId:first.session.sessionId});
    await until(()=>first.agent.ws.readyState !== 1 && first.browser.ws.readyState !== 1);
    for (let i=0;i<34;i++) {
      const session = await (await h.action('terminal_open', {serverId:'node-a',clientRequestId:`history-${i}`,cols:80,rows:24})).json();
      assert.ok(session.sessionId);
      assert.equal((await h.action('terminal_close', {serverId:'node-a',sessionId:session.sessionId})).status,200);
    }
    await h.fetch('/test/rebuild');
    const snapshot = await (await h.fetch('/test/snapshot')).json();
    assert.equal(snapshot.meta.sessions.length,0);
    assert.equal(snapshot.meta.closed.length,32);
    assert.equal(snapshot.peers,1);
    assert.equal(snapshot.alarm,null);
    assert.equal(controls(control).filter(f=>f.type==='open').length,35);
  } finally {await h.dispose();}
});

test('failed reservation persistence releases the uncommitted slot', async () => {
  const h=await harness();
  try {
    await h.control();
    assert.equal((await h.fetch('/test/fail-storage-once')).status,200);
    assert.equal((await h.action('terminal_open',{serverId:'node-a',clientRequestId:'failed-reservation',cols:80,rows:24})).status,503);
    assert.equal((await (await h.action('terminal_status',{serverId:'node-a'})).json()).activeCount,0);
    assert.equal((await (await h.fetch('/test/snapshot')).json()).meta.sessions.length,0);
  } finally {await h.dispose();}
});

test('validated normal exit reaches the browser before close with the exit code intact', async () => {
  const h=await harness();
  try {
    const pair=await openPair(h,await h.control());
    await until(()=>controls(pair.agent).some(f=>f.type==='start'));
    pair.agent.ws.send('{"type":"ready"}');
    await until(()=>controls(pair.browser).some(f=>f.type==='ready'));
    pair.agent.ws.send('{"type":"exit","code":7}');
    await until(()=>pair.browser.ws.readyState!==1);
    assert.deepEqual(controls(pair.browser).find(f=>f.type==='exit'),{type:'exit',code:7});
  } finally {await h.dispose();}
});

test('failed admission and attach writes keep persisted ownership, reject orphan peers and allow safe retry', async () => {
  const h=await harness();
  try {
    const control=await h.control();
    await h.fetch('/test/fail-storage-once?nth=2');
    assert.equal((await h.action('terminal_open',{serverId:'node-a',clientRequestId:'pending-write-fail',cols:80,rows:24})).status,503);
    assert.equal((await (await h.fetch('/test/snapshot')).json()).meta.sessions.length,0);
    assert.equal(controls(control).filter(f=>f.type==='open').length,0);
    const session=await (await h.action('terminal_open',{serverId:'node-a',clientRequestId:'attach-write-fail',cols:80,rows:24})).json();
    await until(()=>controls(control).some(f=>f.sessionId===session.sessionId&&f.type==='open'));
    const open=controls(control).find(f=>f.sessionId===session.sessionId&&f.type==='open');
    const browserHeaders={Origin:'https://example.com',Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`};
    await h.fetch('/test/fail-storage-once');
    assert.equal((await h.socket(session.browserPath,browserHeaders)).response.status,503);
    let snapshot=await (await h.fetch('/test/snapshot')).json();
    assert.equal(snapshot.meta.sessions[0].browser,null);
    assert.equal(snapshot.peers,1);
    const browser=await h.socket(session.browserPath,browserHeaders);
    assert.equal(browser.response.status,101);
    const path=`/api/agent/terminal/session/${session.sessionId}`;
    const headers={...h.agentHeaders(),'X-CFSM-Terminal-Ticket':open.ticket};
    await h.fetch('/test/fail-storage-once');
    assert.equal((await h.socket(path,headers)).response.status,503);
    snapshot=await (await h.fetch('/test/snapshot')).json();
    assert.equal(snapshot.meta.sessions[0].agent,null);
    assert.ok(snapshot.meta.sessions[0].ticketHash);
    assert.equal(snapshot.peers,2);
    const agent=await h.socket(path,headers);
    assert.equal(agent.response.status,101);
    await until(()=>controls(agent).some(f=>f.type==='start'));
    assert.equal(controls(agent).filter(f=>f.type==='start').length,1);
  } finally {await h.dispose();}
});

test('a failed second reservation or close preserves unrelated committed running peers', async () => {
  const h=await harness();
  try {
    const control=await h.control();
    const pair=await openPair(h,control);
    await until(()=>controls(pair.agent).some(f=>f.type==='start'));
    pair.agent.ws.send('{"type":"ready"}');
    await until(()=>controls(pair.browser).some(f=>f.type==='ready'));
    await h.fetch('/test/fail-storage-once');
    assert.equal((await h.action('terminal_open',{serverId:'node-a',clientRequestId:'second-failed-slot',cols:80,rows:24})).status,503);
    const snapshot=await (await h.fetch('/test/snapshot')).json();
    assert.equal(snapshot.meta.sessions.length,1);
    assert.equal(snapshot.meta.sessions[0].id,pair.session.sessionId);
    const close={serverId:'node-a',sessionId:pair.session.sessionId};
    await h.fetch('/test/fail-storage-once');
    assert.equal((await h.action('terminal_close',close)).status,503);
    assert.equal(pair.agent.ws.readyState,1);
    assert.equal(pair.browser.ws.readyState,1);
    pair.browser.ws.send(new Uint8Array([90]));
    await until(()=>pair.agent.messages.some(m=>typeof m!=='string'));
    assert.equal((await h.action('terminal_close',close)).status,200);
    await until(()=>pair.agent.ws.readyState!==1&&pair.browser.ws.readyState!==1);
    assert.equal((await (await h.fetch('/test/snapshot')).json()).meta.sessions.length,0);
  } finally {await h.dispose();}
});

test('pairing/start/ready persistence failures close only the affected session without early start or ready', async () => {
  const h=await harness();
  try {
    const control=await h.control();
    for (const nth of [2,3]) {
      const session=await (await h.action('terminal_open',{serverId:'node-a',clientRequestId:`pair-write-${nth}`,cols:80,rows:24})).json();
      await until(()=>controls(control).some(f=>f.type==='open'&&f.sessionId===session.sessionId));
      const open=controls(control).find(f=>f.type==='open'&&f.sessionId===session.sessionId);
      const browser=await h.socket(session.browserPath,{Origin:'https://example.com',Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`});
      await h.fetch(`/test/fail-storage-once?nth=${nth}`);
      const agent=await h.socket(`/api/agent/terminal/session/${session.sessionId}`,{...h.agentHeaders(),'X-CFSM-Terminal-Ticket':open.ticket});
      assert.equal(agent.response.status,101);
      await until(()=>browser.ws.readyState!==1&&agent.ws.readyState!==1);
      assert.equal(controls(agent).filter(f=>f.type==='start').length,0);
      assert.equal(controls(browser).filter(f=>f.type==='start').length,0);
      assert.equal((await (await h.fetch('/test/snapshot')).json()).meta.sessions.length,0);
    }
    const pair=await openPair(h,control,'ready-write-fail');
    await until(()=>controls(pair.agent).some(f=>f.type==='start'));
    await h.fetch('/test/fail-storage-once');
    pair.agent.ws.send('{"type":"ready"}');
    await until(()=>pair.browser.ws.readyState!==1);
    assert.equal(controls(pair.browser).filter(f=>f.type==='ready').length,0);
    assert.equal((await (await h.fetch('/test/snapshot')).json()).meta.sessions.length,0);
  } finally {await h.dispose();}
});

test('failed alarm persistence or ambiguous reservation acknowledgement leaves no client-unowned slot', async () => {
  const h=await harness();
  try {
    const control=await h.control();
    for (const query of ['kind=setAlarm','commit=1']) {
      await h.fetch(`/test/fail-storage-once?${query}`);
      assert.equal((await h.action('terminal_open',{serverId:'node-a',clientRequestId:query.replace('=','-'),cols:80,rows:24})).status,503);
      assert.equal((await (await h.action('terminal_status',{serverId:'node-a'})).json()).activeCount,0);
      assert.equal((await (await h.fetch('/test/snapshot')).json()).meta.sessions.length,0);
      assert.equal(controls(control).filter(f=>f.type==='open').length,0);
    }
  } finally {await h.dispose();}
});

test('failed recovery read blocks admission and forwarding until a healthy durable-state recovery', async () => {
  const h=await harness();
  try {
    const control=await h.control();
    const pair=await openPair(h,control);
    await until(()=>controls(pair.agent).some(f=>f.type==='start'));
    pair.agent.ws.send('{"type":"ready"}');
    await until(()=>controls(pair.browser).some(f=>f.type==='ready'));
    await h.fetch('/test/fail-storage-read');
    await h.fetch('/test/fail-storage-once');
    assert.equal((await h.action('terminal_open',{serverId:'node-a',clientRequestId:'blocked-reservation',cols:80,rows:24})).status,503);
    assert.equal((await h.action('terminal_status',{serverId:'node-a'})).status,503);
    const blocked=await (await h.fetch('/test/snapshot')).json();
    assert.equal(blocked.blocked,true);
    assert.equal(blocked.peers,0);
    assert.equal(blocked.meta.sessions.length,1);
    await until(()=>pair.agent.ws.readyState!==1&&pair.browser.ws.readyState!==1);
    await h.fetch('/test/restore-storage');
    const response=await h.action('terminal_status',{serverId:'node-a'});
    assert.equal(response.status,200);
    assert.equal((await response.json()).activeCount,0);
    const recovered=await (await h.fetch('/test/snapshot')).json();
    assert.equal(recovered.blocked,false);
    assert.equal(recovered.meta.sessions.length,0);
    assert.equal(recovered.alarm,null);
  } finally {await h.fetch('/test/restore-storage'); await h.dispose();}
});

test('construction after a compound storage outage cleans an abandoned committed reservation', async () => {
  const h=await harness();
  try {
    await h.control();
    await h.fetch('/test/fail-storage-read');
    await h.fetch('/test/fail-storage-once?kind=setAlarm');
    assert.equal((await h.action('terminal_open',{serverId:'node-a',clientRequestId:'abandoned-after-outage',cols:80,rows:24})).status,503);
    const stranded=await (await h.fetch('/test/snapshot')).json();
    assert.equal(stranded.meta.sessions.length,1);
    assert.equal(stranded.meta.sessions[0].status,'reserved');
    assert.equal(stranded.blocked,true);
    await h.fetch('/test/restore-storage');
    await h.fetch('/test/rebuild');
    const rebuilt=await (await h.fetch('/test/snapshot')).json();
    assert.equal(rebuilt.meta.sessions.length,0);
    assert.equal(rebuilt.alarm,null);
  } finally {await h.fetch('/test/restore-storage'); await h.dispose();}
});
