import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, controls, until, openPair } from './terminal-harness.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import fs from 'node:fs';
import vm from 'node:vm';

async function apiCheck(args = [], env = {}, servers = []) {
  const requests = [];
  const context = vm.createContext({
    process:{argv:['node', 'test/api-check.js', ...args], env, arch:'x64', platform:'win32', exit() {}},
    console:{log() {}, error() {}}, AbortController, setTimeout, clearTimeout, URL,
    fetch:async (url, options) => {
      requests.push({url, ...options, body:options.body ? JSON.parse(options.body) : undefined});
      return Response.json({token:'synthetic-admin-jwt', servers});
    }
  });
  await vm.runInContext(fs.readFileSync('test/api-check.js', 'utf8'), context);
  requests.results = vm.runInContext('state.results', context);
  return requests;
}

test('API checker defaults to no metrics writes or node deletion', async () => {
  const requests = await apiCheck([], {API_SECRET:'admin-only'});
  assert.equal(requests.some(request => request.body?.action === 'add' || request.body?.action === 'delete' && request.body.id !== 'invalid-id'), false);
  assert.equal(requests.some(request => request.url.endsWith('/update') && request.body?.metrics?.cpu), false);
  assert.equal(requests.results.some(result => result.name.includes('agent_version')), false);
});

test('API checker only verifies versions of nodes actually reported, not an unrelated matching version', async () => {
  const requests = await apiCheck(['--include-write', '--server-id=synthetic-node', `--node-token=${'a'.repeat(64)}`], {}, [{id:'unrelated', agent_version:'1.3.0'}]);
  assert.ok(requests.results.some(result => result.name.includes('agent_version') && result.status === 'fail'));
});

test('API checker explicit reports use individual headers, retaining old-secret denial only', async () => {
  const token = 'a'.repeat(64);
  const requests = await apiCheck(['--include-write', '--server-id=synthetic-node', `--node-token=${token}`], {API_SECRET:'admin-only'});
  const reports = requests.filter(request => request.url.endsWith('/update') && request.body?.metrics?.cpu);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.id, 'synthetic-node');
  assert.equal(reports[0].headers.Authorization, `Bearer ${token}`);
  assert.equal('secret' in reports[0].body, false);
  assert.equal('token' in reports[0].body, false);
  assert.ok(requests.some(request => request.url.endsWith('/update') && request.body?.secret === 'admin-only' && !request.headers.Authorization));
});

const binary = peer => peer.messages.filter(value => typeof value !== 'string');
let sequence = 0;
const payload = (id, terminal = false) => {
  const at = Date.now() - 3600000 + ++sequence * 1000;
  return {id, terminal_enabled:terminal, time:{local_ts:Date.now()}, metrics:{cpu:'12', timestamp:at}};
};
const post = (h, body, headers, path = '/update') => h.fetch(path, {
  method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(body)
});
async function send(peer, body) {
  const before = peer.messages.length;
  peer.ws.send(JSON.stringify({type:'update', payload:body}));
  await until(() => controls(peer).slice(before).some(frame => frame.type === 'ack'));
}
async function registered() {
  const h = await harness({apiSecret:''});
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=CASE id WHEN 'node-a' THEN 1 ELSE 2 END").run();
    await saveSiteOptions(h.db, {auto_discovery:'true', wss_report_enabled:'true'});
    const keyResponse = await h.action('node_prepare_registration');
    assert.equal(keyResponse.status, 200);
    const {key} = await keyResponse.json();
    const response = await h.fetch('/api/agent/register', {
      method:'POST', headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:JSON.stringify({name:'node-a'})
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const node = await response.json();
    assert.notEqual(node.serverId, 'node-a');
    assert.notEqual(node.token, h.nodes['node-a'].token);
    h.nodes[node.serverId] = node;
    return {h, node, key};
  } catch (error) { await h.dispose(); throw error; }
}
async function shell(h, node) {
  const enabled = await h.action('terminal_enable_install', {serverId:node.serverId, terminal:true, acceptRisk:true});
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).token, node.token);
  const control = await h.control(node.serverId);
  assert.equal(control.response.status, 101);
  const pair = await openPair(h, control, crypto.randomUUID(), node.serverId);
  await until(() => controls(pair.agent).some(frame => frame.type === 'start'));
  pair.agent.ws.send('{"type":"ready"}');
  await until(() => controls(pair.browser).some(frame => frame.type === 'ready'));
  pair.browser.ws.send(Buffer.from('id\r'));
  await until(() => binary(pair.agent).length === 1);
  assert.equal(Buffer.from(binary(pair.agent)[0]).toString(), 'id\r');
  pair.agent.ws.send('{"type":"ack","bytes":3}');
  pair.agent.ws.send(Buffer.from('SYNTHETIC PTY OUTPUT\r\n'));
  await until(() => binary(pair.browser).length === 1);
  assert.equal(Buffer.from(binary(pair.browser)[0]).toString(), 'SYNTHETIC PTY OUTPUT\r\n');
  pair.browser.ws.send(JSON.stringify({type:'ack', bytes:Buffer.byteLength('SYNTHETIC PTY OUTPUT\r\n')}));
  return {control, pair};
}

test('registration -> stable install credential -> HTTP/WSS off -> authenticated status -> owner/ticket/data flow', async () => {
  const {h, node, key} = await registered();
  try {
    const headers = h.agentHeaders(node.serverId);
    const install = await h.action('node_read_install', {serverId:node.serverId});
    assert.equal(install.headers.get('Cache-Control'), 'no-store');
    assert.equal((await install.json()).token, node.token);
    assert.equal((await post(h, payload(node.serverId), headers)).status, 200);
    const reporting = await h.socket('/update', headers);
    assert.equal(reporting.response.status, 101);
    await send(reporting, payload(node.serverId));
    assert.equal((await h.socket('/api/agent/terminal/control', headers)).response.status, 401);
    for (const badHeaders of [{}, {Authorization:`Bearer ${'0'.repeat(64)}`}, {Authorization:`Bearer ${key}`}]) {
      assert.equal((await post(h, payload(node.serverId, true), badHeaders)).status, 401);
      assert.equal((await h.socket('/update', badHeaders)).response.status, 401);
      assert.equal((await h.socket('/api/agent/terminal/control', badHeaders)).response.status, 401);
    }
    for (const body of [payload('node-a', true), {...payload(node.serverId, true), secret:'test-report-secret'}, {...payload(node.serverId, true), token:node.token}]) {
      assert.equal((await post(h, body, headers)).status, 401);
    }
    assert.equal((await post(h, {...payload(node.serverId, true), secret:'test-report-secret'}, {})).status, 401);
    assert.equal((await post(h, payload(node.serverId, true), headers, `/update?token=${node.token}`)).status, 401);
    assert.equal((await h.socket('/update', {...headers, 'X-CFSM-Server-Id':'node-a'})).response.status, 401);
    assert.equal((await (await h.action('terminal_status', {serverId:node.serverId})).json()).localEnabled, false);
    await send(reporting, payload(node.serverId, true));
    assert.equal((await (await h.action('terminal_status', {serverId:node.serverId})).json()).localEnabled, true);
    const {control, pair} = await shell(h, node);
    assert.equal((await h.socket(pair.session.browserPath)).response.status, 403);
    assert.equal((await h.socket(pair.session.browserPath, {Authorization:`Bearer ${node.token}`, Origin:'https://example.com'})).response.status, 403);
    const agentPath = `/api/agent/terminal/session/${pair.session.sessionId}`;
    assert.equal((await h.socket(agentPath, {...headers, 'X-CFSM-Terminal-Ticket':pair.open.ticket})).response.status, 409);
    const pendingResponse = await h.action('terminal_open', {serverId:node.serverId, clientRequestId:crypto.randomUUID(), cols:80, rows:24});
    assert.equal(pendingResponse.status, 200);
    const pending = await pendingResponse.json();
    await until(() => controls(control).some(frame => frame.sessionId === pending.sessionId));
    const ticket = controls(control).find(frame => frame.sessionId === pending.sessionId).ticket;
    assert.equal((await h.socket(pending.browserPath, {Cookie:`cfsm_auth=${h.otherToken}`, Origin:'https://example.com'})).response.status, 403);
    const pendingPath = `/api/agent/terminal/session/${pending.sessionId}`;
    assert.equal((await h.socket(pendingPath, {...h.agentHeaders('node-a'), 'X-CFSM-Terminal-Ticket':ticket})).response.status, 403);
    assert.equal((await h.socket(pendingPath, {...headers, 'X-CFSM-Terminal-Ticket':'0'.repeat(64)})).response.status, 403);
    assert.equal((await h.action('terminal_close', {serverId:node.serverId, sessionId:pending.sessionId})).status, 200);
    assert.equal((await h.socket(`/api/agent/terminal/control?token=${node.token}`, headers)).response.status, 400);
    const attachment = await (await h.fetch('/test/report-snapshot')).json();
    assert.equal(JSON.stringify(attachment).includes(node.token), false);
    assert.equal(reporting.ws.readyState, 1);
  } finally { await h.dispose(); }
});

for (const action of ['node_reset_token', 'delete', 'terminal_revoke_node']) {
  test(`registered running HTTP/WSS and PTY channels: ${action} has the right revocation scope`, async () => {
    const {h, node} = await registered();
    try {
      const headers = h.agentHeaders(node.serverId);
      assert.equal((await post(h, payload(node.serverId, true), headers)).status, 200);
      const reporting = await h.socket('/update', headers);
      await send(reporting, payload(node.serverId, true));
      const {control, pair} = await shell(h, node);
      const response = await h.action(action, action === 'delete' ? {id:node.serverId} : {serverId:node.serverId});
      assert.equal(response.status, 200);
      await until(() => [control, pair.agent, pair.browser].every(peer => peer.ws.readyState !== 1));
      if (action === 'terminal_revoke_node') {
        assert.equal(reporting.ws.readyState, 1);
        await send(reporting, payload(node.serverId));
        assert.equal((await post(h, payload(node.serverId), headers)).status, 200);
        assert.equal((await (await h.action('node_read_install', {serverId:node.serverId})).json()).token, node.token);
        assert.equal((await h.socket('/api/agent/terminal/control', headers)).response.status, 401);
      } else {
        await until(() => reporting.ws.readyState !== 1);
        assert.equal((await post(h, payload(node.serverId), headers)).status, 401);
        assert.equal((await h.socket('/update', headers)).response.status, 401);
        assert.equal((await h.socket('/api/agent/terminal/control', headers)).response.status, 401);
        if (action === 'node_reset_token') {
          const replacement = await response.json();
          assert.notEqual(replacement.token, node.token);
          h.nodes[node.serverId] = replacement;
          assert.equal((await post(h, payload(node.serverId), h.agentHeaders(node.serverId))).status, 200);
        }
      }
    } finally { await h.dispose(); }
  });
}
