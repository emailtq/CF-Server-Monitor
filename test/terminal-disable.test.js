import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, until, controls, openPair } from './terminal-harness.js';
import { parseTerminalControl } from '../src/shared/terminalProtocol.js';

async function capable(h) {
  const peer = await h.socket('/api/agent/terminal/control', h.agentHeaders());
  peer.ws.send(JSON.stringify({type:'hello', protocol:1, platform:'linux', capabilities:['terminal.pty.v1', 'terminal.disable.v1']}));
  await until(() => controls(peer).some(frame => frame.type === 'bound'));
  return peer;
}
const acknowledge = frame => ({...frame, type:'disabled'});

test('disable protocol binds role, operation, node, connection, generation and version without remote enable', () => {
  const frame = {type:'disable', operationId:'operation-1', serverId:'node-a', connectionId:'control-1', generation:2, credentialVersion:1};
  assert.deepEqual(parseTerminalControl(JSON.stringify(frame), 'broker-control'), frame);
  assert.deepEqual(parseTerminalControl(JSON.stringify(acknowledge(frame)), 'agent-control'), acknowledge(frame));
  for (const bad of [{...frame,type:'enable'}, {...frame,unknown:1}, {...frame,generation:0}, {...frame,credentialVersion:'1'}, {...frame,operationId:'x'.repeat(129)}]) {
    assert.throws(() => parseTerminalControl(JSON.stringify(bad), 'broker-control'), RangeError);
  }
  for (const role of ['agent-control','browser','agent','broker']) assert.throws(() => parseTerminalControl(JSON.stringify(frame), role), RangeError);
});

test('current Cookie disable persists server revoke and closes old sessions BEFORE bounded matched local ACK', async () => {
  const h = await harness();
  try {
    const control = await capable(h);
    const pair = await openPair(h, control);
    const pending = h.action('terminal_revoke_node', {serverId:'node-a'});
    await until(() => controls(control).some(frame => frame.type === 'disable'));
    const frame = controls(control).find(frame => frame.type === 'disable');
    assert.equal(frame.credentialVersion, h.nodes['node-a'].version);
    assert.equal((await h.db.prepare("SELECT enabled FROM terminal_nodes WHERE server_id='node-a'").first()).enabled, 0);
    await until(() => pair.agent.ws.readyState !== 1 && pair.browser.ws.readyState !== 1);
    assert.equal(control.ws.readyState, 1, 'capture must stay open until ACK, not invalidate first');
    assert.equal((await h.socket('/api/agent/terminal/control', h.agentHeaders())).response.status, 401);
    control.ws.send(JSON.stringify(acknowledge(frame)));
    const response = await pending;
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.serverRevoked, true);
    assert.equal(result.localConfirmed, true);
    await until(() => control.ws.readyState !== 1);
    await h.fetch('/test/rebuild');
    assert.equal((await h.socket('/api/agent/terminal/control', h.agentHeaders())).response.status, 401);
    const unused = await (await h.action('terminal_prepare_install', {serverId:'node-a',terminal:true,acceptRisk:true})).json();
    assert.ok(unused.token);
    assert.equal((await h.socket('/api/agent/terminal/control', h.agentHeaders())).response.status, 401);
    h.nodes['node-a'] = unused;
    const reinstalled = await capable(h);
    assert.equal((await (await h.action('terminal_status', {serverId:'node-a'})).json()).supported, true);
    assert.equal(reinstalled.response.status, 101);
  } finally { await h.dispose(); }
});

test('offline and legacy disable never fabricate local confirmation; duplicate and logout stay honest', async () => {
  for (const legacy of [false, true]) {
    const h = await harness();
    try {
      if (legacy) await h.control();
      const result = await (await h.action('terminal_revoke_node', {serverId:'node-a'})).json();
      assert.equal(result.serverRevoked, true);
      assert.equal(result.localConfirmed, false);
      assert.equal(result.localReason, legacy ? 'unsupported' : 'offline');
      assert.equal((await h.socket('/api/agent/terminal/control', h.agentHeaders())).response.status, 401);
      const duplicate = await (await h.action('terminal_revoke_node', {serverId:'node-a'})).json();
      assert.equal(duplicate.serverRevoked, true);
      assert.equal(duplicate.localConfirmed, false);
      await h.action('logout');
      assert.equal((await h.action('terminal_revoke_node', {serverId:'node-a'})).status, 401);
    } finally { await h.dispose(); }
  }
});

test('wrong operation ACK and lost ACK cannot confirm local shutdown; fresh reinstall survives delayed finalization', async () => {
  const h = await harness();
  try {
    const control = await capable(h);
    const pending = h.action('terminal_revoke_node', {serverId:'node-a'});
    await until(() => controls(control).some(frame => frame.type === 'disable'));
    const frame = controls(control).find(frame => frame.type === 'disable');
    control.ws.send(JSON.stringify({...acknowledge(frame), operationId:'wrong-operation'}));
    const result = await (await pending).json();
    assert.equal(result.serverRevoked, true);
    assert.equal(result.localConfirmed, false);
    const installed = await (await h.action('terminal_prepare_install', {serverId:'node-a',terminal:true,acceptRisk:true})).json();
    h.nodes['node-a'] = installed;
    const next = await capable(h);
    const lost = h.action('terminal_revoke_node', {serverId:'node-a'});
    await until(() => controls(next).some(frame => frame.type === 'disable'));
    const fresh = await (await h.action('terminal_prepare_install', {serverId:'node-a',terminal:true,acceptRisk:true})).json();
    h.nodes['node-a'] = fresh;
    const freshControl = await capable(h);
    const lostResult = await (await lost).json();
    assert.equal(lostResult.localConfirmed, false);
    assert.equal(lostResult.serverRevoked, false, 'a fresh installation must not be reported as currently revoked by stale completion');
    assert.equal(freshControl.ws.readyState, 1, 'stale finalization cannot invalidate fresh control');
  } finally { await h.dispose(); }
});

test('concurrent revoke cannot let a conflicting operation consume the matched ACK', async () => {
  const h = await harness();
  try {
    const control = await capable(h);
    const first = h.action('terminal_revoke_node', {serverId:'node-a'});
    await until(() => controls(control).some(frame => frame.type === 'disable'));
    const duplicate = await (await h.action('terminal_revoke_node', {serverId:'node-a'})).json();
    assert.equal(duplicate.localConfirmed, false);
    const frame = controls(control).find(frame => frame.type === 'disable');
    control.ws.send(JSON.stringify(acknowledge(frame)));
    assert.equal((await (await first).json()).localConfirmed, true);
  } finally { await h.dispose(); }
});

test('bad role, unknown field, oversize and old identity ACKs remain unconfirmed after real D1 revoke', async () => {
  for (const kind of ['role','extra','oversize','generation','version','connection']) {
    const h = await harness();
    try {
      const control = await capable(h);
      const result = h.action('terminal_revoke_node', {serverId:'node-a'});
      await until(() => controls(control).some(frame => frame.type === 'disable'));
      const ack = acknowledge(controls(control).find(frame => frame.type === 'disable'));
      if (kind === 'role') ack.type = 'disable';
      if (kind === 'extra') ack.extra = true;
      if (kind === 'generation') ack.generation++;
      if (kind === 'version') ack.credentialVersion++;
      if (kind === 'connection') ack.connectionId = 'other-control';
      control.ws.send(kind === 'oversize' ? JSON.stringify(ack).padEnd(4097) : JSON.stringify(ack));
      const response = await (await result).json();
      assert.equal(response.serverRevoked, true);
      assert.equal(response.localConfirmed, false);
      assert.equal((await h.socket('/api/agent/terminal/control', h.agentHeaders())).response.status, 401);
    } finally { await h.dispose(); }
  }
});

test('storage transition failure and cold reconstruction during disable never fabricate local ACK or preserve old authority', async () => {
  for (const kind of ['storage','rebuild','timeout']) {
    const h = await harness();
    try {
      const control = await capable(h);
      const pair = await openPair(h,control);
      if (kind === 'storage') await h.fetch('/test/fail-storage-once');
      const pending = h.action('terminal_revoke_node',{serverId:'node-a'});
      if (kind === 'rebuild') {
        await until(()=>controls(control).some(frame=>frame.type==='disable'));
        await h.fetch('/test/rebuild');
      }
      const result = await (await pending).json();
      assert.equal(result.serverRevoked,true);
      assert.equal(result.localConfirmed,false);
      await until(()=>pair.agent.ws.readyState!==1 && pair.browser.ws.readyState!==1);
      assert.equal((await h.socket('/api/agent/terminal/control',h.agentHeaders())).response.status,401);
    } finally {await h.dispose();}
  }
});
