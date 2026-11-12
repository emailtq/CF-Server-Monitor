import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, controls, until, openPair } from './terminal-harness.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { generateToken, checkAuth, getTerminalJwtPrincipal } from '../src/middleware/auth.js';
import { hashPassword } from '../src/utils/common.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';

async function setup() {
  const h = await harness();
  await h.db.prepare("UPDATE servers SET history_partition_id=CASE id WHEN 'node-a' THEN 1 ELSE 2 END").run();
  await saveSiteOptions(h.db, {wss_report_enabled:'true'});
  await h.db.prepare("UPDATE terminal_nodes SET enabled=0 WHERE server_id='node-a'").run();
  return h;
}
let sequence = 0;
const report = (extra = {}) => ({id:'node-a', metrics:{cpu:'12', timestamp:Date.now() - 3600000 + ++sequence * 1000}, ...extra});
const post = (h, body, headers = h.agentHeaders(), path = '/update') => h.fetch(path, {
  method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(body)
});

test('install reads provision once, preserve terminal-off monitoring, and demand explicit reset for unreadable ciphertext', async () => {
  const h = await setup();
  try {
    await h.db.prepare("DELETE FROM terminal_nodes WHERE server_id='node-a'").run();
    const first = await h.action('node_read_install', {serverId:'node-a'});
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'no-store');
    const issued = await first.json();
    assert.match(issued.token, /^[a-f0-9]{64}$/);
    assert.equal(issued.enabled, false);
    const second = await (await h.action('node_read_install', {serverId:'node-a'})).json();
    assert.equal(second.token, issued.token);
    assert.equal(second.tokenVersion, issued.tokenVersion);
    assert.equal((await post(h, report(), {Authorization:`Bearer ${issued.token}`})).status, 200);
    await h.db.prepare("UPDATE terminal_nodes SET token_ciphertext=NULL WHERE server_id='node-a'").run();
    assert.equal((await h.action('node_read_install', {serverId:'node-a'})).status, 409);
    assert.equal((await post(h, report(), {Authorization:`Bearer ${issued.token}`})).status, 200);
    const reset = await h.action('node_reset_token', {serverId:'node-a'});
    assert.equal(reset.status, 200);
    assert.equal(reset.headers.get('Cache-Control'), 'no-store');
    const replacement = await reset.json();
    assert.notEqual(replacement.token, issued.token);
    assert.ok(replacement.tokenVersion > issued.tokenVersion);
    assert.equal((await post(h, report(), {Authorization:`Bearer ${issued.token}`})).status, 401);
    assert.equal((await post(h, report(), {Authorization:`Bearer ${replacement.token}`})).status, 200);
    assert.equal((await h.action('node_read_install', {serverId:'node-a'}, {headers:{Origin:'https://evil.example'}})).status, 403);
    assert.equal((await h.fetch('/admin/api', {method:'POST', body:JSON.stringify({action:'node_read_install',serverId:'node-a'})})).status, 401);
  } finally { await h.dispose(); }
});

test('admin JWT has only persisted signing authority; API_SECRET and known defaults never sign', async () => {
  const fallback = 'test-report-secret'.padEnd(32, 'x');
  const env = {API_SECRET:'test-report-secret'};
  await assert.rejects(generateToken(env, {}), /jwt_secret/);
  const forged = await generateToken({}, {jwt_secret:fallback});
  assert.equal(await checkAuth(new Request('https://example.com/admin/api', {headers:{Authorization:`Bearer ${forged}`}}), env, {}), false);
  const sys = {jwt_secret:'s'.repeat(64)};
  const token = await generateToken({}, sys);
  const request = new Request('https://example.com/admin/api', {headers:{Cookie:`cfsm_auth=${token}`}});
  assert.equal(await checkAuth(request, {}, sys), true);
  assert.ok(await getTerminalJwtPrincipal(request, {}, sys));
});

test('logout and revoked jtis deny credential reads and resets without requiring global terminal enable', async () => {
  const h = await setup();
  try {
    await saveSiteOptions(h.db, {terminal_enabled:'false'});
    assert.equal((await h.action('node_reset_token', {serverId:'node-a'})).status, 200);
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    assert.equal((await h.action('logout')).status, 200);
    for (const action of ['node_read_install', 'node_reset_token']) {
      assert.equal((await h.action(action, {serverId:'node-a'})).status, 401);
    }
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), before);
  } finally { await h.dispose(); }
});

test('HTTP authenticates every report by node bearer, not terminal permission or shared secret', async () => {
  const h = await setup();
  try {
    assert.equal((await post(h, report())).status, 200);
    assert.equal((await post(h, report({id:undefined}))).status, 200);
    assert.equal((await post(h, report(), {})).status, 401);
    assert.equal((await post(h, report(), {Authorization:`Bearer ${'0'.repeat(64)}`})).status, 401);
    assert.equal((await post(h, report({id:'node-b'}))).status, 401);
    assert.equal((await post(h, report({secret:'test-report-secret'}), {})).status, 401);
    assert.equal((await post(h, report({token:h.nodes['node-a'].token}))).status, 401);
    assert.equal((await post(h, report(), h.agentHeaders(), `/update?token=${h.nodes['node-a'].token}`)).status, 401);
    const count = await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first();
    assert.equal((await post(h, report({id:undefined, secret:'test-report-secret'}), {})).status, 401);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, count.count);
  } finally { await h.dispose(); }
});

test('actual WSS handshake rejects anonymous/wrong/query credentials before accepting a socket', async () => {
  const h = await setup();
  try {
    assert.equal((await h.socket('/update')).response.status, 401);
    assert.equal((await h.socket('/update', {Authorization:`Bearer ${'0'.repeat(64)}`})).response.status, 401);
    assert.equal((await h.socket(`/update?token=${h.nodes['node-a'].token}`, h.agentHeaders())).response.status, 401);
    assert.equal((await h.socket('/update', {...h.agentHeaders(), 'X-CFSM-Server-Id':'node-b'})).response.status, 401);
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal(peer.response.status, 101);
    peer.ws.send(JSON.stringify({type:'update', payload:report()}));
    await until(() => controls(peer).some(frame => frame.type === 'ack'));
    peer.ws.send(JSON.stringify({type:'update', payload:report({id:'node-b'})}));
    await until(() => peer.ws.readyState !== 1);
    assert.ok(controls(peer).some(frame => frame.type === 'error' && frame.code === 403));
  } finally { await h.dispose(); }
});

test('external HTTP and upgrade reject remote plaintext even with a valid bearer and forged secure headers', async () => {
  const h = await setup();
  try {
    const headers = {...h.agentHeaders(), 'Content-Type':'application/json', 'X-Forwarded-Proto':'https', 'X-Real-Origin':'https://example.com'};
    const response = await h.mf.dispatchFetch('http://example.com/update', {method:'POST', headers, body:JSON.stringify(report())});
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'node_https_required');
    const rejected = await h.socket('/update', {...headers, 'MF-Original-URL':'http://example.com/update'});
    assert.equal(rejected.response.status, 403);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count, 0);
    assert.equal((await snapshot(h)).attachments.length, 0);
    assert.equal((await post(h, report())).status, 200);
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal(peer.response.status, 101);
    assert.equal((await send(peer)).type, 'ack');
  } finally { await h.dispose(); }
});

test('missing storage or setAlarm never reports a scheduled authorization lease', async () => {
  globalThis.WebSocketRequestResponsePair = class {};
  for (const storage of [undefined, {}]) {
    const broadcaster = new MetricsBroadcaster({setWebSocketAutoResponse() {}, getWebSockets:() => [], storage}, {DB:{}});
    assert.equal(await broadcaster._scheduleAgentWssHourAlarm(), false);
  }
});

test('real reporting upgrade denies missing storage and missing setAlarm capabilities', async () => {
  for (const storage of [0, 1]) {
    const h = await setup();
    try {
      await h.fetch(`/test/report-alarm-missing?storage=${storage}`);
      assert.equal((await h.socket('/update', h.agentHeaders())).response.status, 503);
    } finally { await h.dispose(); }
  }
});

test('sensitive node actions reject array server IDs without coercion or credential mutation', async () => {
  const h = await setup();
  try {
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    for (const action of ['node_read_install', 'node_reset_token']) {
      const response = await h.action(action, {serverId:['node-a']});
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'node_invalid_id');
    }
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), before);
  } finally { await h.dispose(); }
});

async function send(peer, body = report()) {
  const count = peer.messages.length;
  peer.ws.send(JSON.stringify({type:'update', payload:body}));
  await until(() => controls(peer).slice(count).some(frame => frame.type === 'ack' || frame.type === 'error'));
  return controls(peer).slice(count).find(frame => frame.type === 'ack' || frame.type === 'error');
}
const snapshot = async h => (await h.fetch('/test/report-snapshot')).json();

test('WSS attachments omit bearer, outage consumes but never renews lease, alarm expires silent sockets', async () => {
  const h = await setup();
  try {
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal((await send(peer)).type, 'ack');
    const before = await snapshot(h);
    assert.equal(before.attachments[0].tokenVersion, h.nodes['node-a'].tokenVersion);
    assert.equal(JSON.stringify(before).includes(h.nodes['node-a'].token), false);
    assert.ok(before.alarm <= before.attachments[0].leaseUntil);
    await h.fetch('/test/report-auth-fail');
    await h.fetch('/test/report-clock?advance=31000');
    assert.equal((await send(peer)).type, 'ack');
    assert.equal((await snapshot(h)).attachments[0].leaseUntil, before.attachments[0].leaseUntil);
    await h.fetch('/test/report-clock?advance=30000');
    await h.fetch('/test/report-alarm');
    await until(() => peer.ws.readyState !== 1);
    assert.ok(controls(peer).some(frame => frame.type === 'error' && frame.code === 401));
  } finally { await h.dispose(); }
});

test('expired credentials cannot report or receive config, stale attachments cannot use cached details', async () => {
  for (const corrupt of [false, true]) {
    const h = await setup();
    try {
      const peer = await h.socket('/update', {...h.agentHeaders(), 'X-Agent-Config-Schema':'7'});
      assert.equal((await send(peer)).type, 'ack');
      if (corrupt) await h.fetch('/test/report-corrupt');
      else {
        await h.fetch('/test/report-auth-fail');
        await h.fetch('/test/report-clock?advance=61000');
      }
      const count = peer.messages.length;
      await h.fetch('/test/report-config');
      await until(() => peer.ws.readyState !== 1);
      assert.equal(controls(peer).slice(count).some(frame => frame.type === 'config'), false);
    } finally { await h.dispose(); }
  }
});

test('alarms for other sockets do not renew a silent authorization lease', async () => {
  const h = await setup();
  try {
    const peer = await h.socket('/update', h.agentHeaders());
    const before = (await snapshot(h)).attachments[0].leaseUntil;
    await h.fetch('/test/report-clock?advance=1000');
    await h.fetch('/test/report-alarm');
    assert.equal((await snapshot(h)).attachments[0].leaseUntil, before);
    await h.fetch('/test/report-clock?advance=60000');
    await h.fetch('/test/report-alarm');
    await until(() => peer.ws.readyState !== 1);
  } finally { await h.dispose(); }
});

test('failed alarm scheduling denies admission and a delayed D1 read cannot mint an already-expired lease', async () => {
  const h = await setup();
  try {
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal((await send(peer)).type, 'ack');
    await h.fetch('/test/report-clock?advance=31000');
    await h.fetch('/test/report-auth-delay?advance=61000');
    await send(peer);
    await until(() => peer.ws.readyState !== 1);
    await h.fetch('/test/report-alarm-fail');
    assert.equal((await h.socket('/update', h.agentHeaders())).response.status, 503);
  } finally { await h.dispose(); }
});

test('D1 token reset closes live reports and terminal control, old cached identities never revive', async () => {
  const h = await harness();
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=1 WHERE id='node-a'").run();
    await saveSiteOptions(h.db, {wss_report_enabled:'true'});
    const control = await h.control();
    const pair = await openPair(h, control);
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal((await send(peer)).type, 'ack');
    const old = h.nodes['node-a'].token;
    const result = await h.action('node_reset_token', {serverId:'node-a'});
    assert.equal(result.status, 200);
    const replacement = await result.json();
    await until(() => peer.ws.readyState !== 1 && control.ws.readyState !== 1 && pair.browser.ws.readyState !== 1 && pair.agent.ws.readyState !== 1);
    assert.equal((await post(h, report(), {Authorization:`Bearer ${old}`})).status, 401);
    assert.equal((await h.socket('/update', {Authorization:`Bearer ${old}`})).response.status, 401);
    assert.equal((await post(h, report(), {Authorization:`Bearer ${replacement.token}`})).status, 200);
    h.nodes['node-a'] = replacement;
    const current = await h.control();
    assert.equal(current.response.status, 101);
  } finally { await h.dispose(); }
});

test('terminal-only enable/disable preserves monitoring, explicit terminal prepare resets both channels', async () => {
  const h = await setup();
  try {
    const issued = await (await h.action('node_reset_token', {serverId:'node-a'})).json();
    h.nodes['node-a'] = issued;
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal((await send(peer)).type, 'ack');
    const enabled = await (await h.action('terminal_enable_install', {serverId:'node-a',terminal:true,acceptRisk:true})).json();
    assert.equal(enabled.token, issued.token);
    const control = await h.control();
    assert.equal((await h.action('terminal_revoke_node', {serverId:'node-a'})).status, 200);
    await until(() => control.ws.readyState !== 1);
    assert.equal(peer.ws.readyState, 1);
    assert.equal((await send(peer)).type, 'ack');
    assert.equal((await post(h, report())).status, 200);
    const replacement = await h.action('terminal_prepare_install', {serverId:'node-a',terminal:true,acceptRisk:true});
    assert.equal(replacement.status, 200);
    assert.notEqual((await replacement.json()).token, issued.token);
    await until(() => peer.ws.readyState !== 1);
    assert.equal((await post(h, report())).status, 401);
  } finally { await h.dispose(); }
});

test('reset commits revocation before fresh minimal notifications, failed delivery cannot outlive the report lease', async () => {
  const h = await setup();
  try {
    await h.db.prepare("UPDATE terminal_nodes SET enabled=1 WHERE server_id='node-a'").run();
    const control = await h.control();
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal((await send(peer)).type, 'ack');
    const old = h.nodes['node-a'];
    const seen = [];
    const env = {DB:h.db,
      METRICS_BROADCASTER:{idFromName:id=>id,get:()=>({async fetch(request) {
        seen.push({url:request.url,headers:Object.fromEntries(request.headers),body:await request.json()});
        const current = await h.db.prepare("SELECT token_version FROM terminal_nodes WHERE server_id='node-a'").first();
        assert.ok(current.token_version > old.tokenVersion);
        return new Response('outage', {status:503});
      }})},
      TERMINAL_BROKER:{idFromName:id=>id,get:()=>({fetch:request=>h.fetch('/test/internal?op=invalidate', {headers:Object.fromEntries(request.headers)})})}
    };
    const sys = JSON.parse((await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first()).value);
    const result = await handleAdminAPI(new Request('https://example.com/admin/api', {method:'POST', headers:{Origin:'https://example.com',Cookie:`cfsm_auth=${h.token}`,'X-CFSM-Terminal-Context':'forged'},body:JSON.stringify({action:'node_reset_token',serverId:'node-a'})}), env, sys);
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal((await result.json()).revoked, true);
    assert.deepEqual(seen[0].headers, {'content-type':'application/json'});
    assert.deepEqual(Object.keys(seen[0].body).sort(), ['serverId','tokenVersion']);
    assert.equal(JSON.stringify(seen).includes(old.token), false);
    assert.equal((await post(h, report())).status, 401);
    await until(() => control.ws.readyState !== 1);
    await h.fetch('/test/report-clock?advance=31000');
    assert.equal((await send(peer)).code, 401);
    await until(() => peer.ws.readyState !== 1);
  } finally { await h.dispose(); }
});

test('forced config push checks D1 epochs independently of cached details and ACK preserves negotiated configuration', async () => {
  const h = await setup();
  try {
    const peer = await h.socket('/update', {...h.agentHeaders(), 'X-Agent-Config-Schema':'7'});
    const ack = await send(peer, report({config_schema:7, config_md5:'none'}));
    assert.equal(ack.has_config, true);
    assert.equal(ack.payload.schema_version, 7);
    await h.db.prepare("UPDATE servers SET report_interval=120 WHERE id='node-a'").run();
    await h.fetch('/test/report-config');
    await until(() => controls(peer).some(frame => frame.type === 'config' && frame.payload.report_interval === 120));
    const count = peer.messages.length;
    await h.db.prepare("UPDATE terminal_nodes SET token_version = token_version + 1 WHERE server_id='node-a'").run();
    await h.fetch('/test/report-config');
    await until(() => peer.ws.readyState !== 1);
    assert.equal(controls(peer).slice(count).some(frame => frame.type === 'config'), false);
  } finally { await h.dispose(); }
});

test('a delayed older invalidation cannot erase a new token generation history throttle or close its socket', async () => {
  const h = await setup();
  try {
    const first = await (await h.action('node_reset_token', {serverId:'node-a'})).json();
    const second = await (await h.action('node_reset_token', {serverId:'node-a'})).json();
    h.nodes['node-a'] = second;
    const peer = await h.socket('/update', h.agentHeaders());
    assert.equal((await send(peer)).persisted, true);
    const namespace = await h.mf.getDurableObjectNamespace('METRICS_BROADCASTER');
    const response = await namespace.get(namespace.idFromName('global')).fetch('https://metrics.internal/node-invalidated', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({serverId:'node-a',tokenVersion:first.tokenVersion})
    });
    assert.equal(response.status, 200);
    assert.equal((await send(peer)).persisted, false);
    assert.equal(peer.ws.readyState, 1);
  } finally { await h.dispose(); }
});

test('add/import provision stable non-exported tokens and deletion tombstones survive same-ID reimport', async () => {
  const h = await setup();
  try {
    const added = await (await h.action('add', {name:'new node'})).json();
    assert.equal(added.success, true);
    const first = await (await h.action('node_read_install', {serverId:added.id})).json();
    assert.match(first.token, /^[a-f0-9]{64}$/);
    const auth = {Authorization:`Bearer ${first.token}`, 'X-CFSM-Server-Id':added.id};
    const peer = await h.socket('/update', auth);
    assert.equal((await send(peer, report({id:added.id}))).type, 'ack');
    const backup = await (await h.action('export_servers')).json();
    assert.equal(JSON.stringify(backup).includes(first.token), false);
    const nodeBackup = backup.servers.find(node => node.id === added.id);
    assert.equal((await h.action('delete', {id:added.id})).status, 200);
    await until(() => peer.ws.readyState !== 1);
    assert.equal((await post(h, report({id:added.id}), auth)).status, 401);
    assert.equal((await h.action('import_servers', {servers:[{...nodeBackup, token:first.token, token_hash:'forged', enabled:1}]})).status, 200);
    const second = await (await h.action('node_read_install', {serverId:added.id})).json();
    assert.notEqual(second.token, first.token);
    assert.ok(second.tokenVersion > first.tokenVersion);
    assert.equal(second.enabled, false);
    assert.equal((await post(h, report({id:added.id}), auth)).status, 401);
    assert.equal((await post(h, report({id:added.id}), {Authorization:`Bearer ${second.token}`})).status, 200);
    for (const path of ['/node-invalidated', '/__do/node-invalidated', '/terminal.internal/invalidate']) {
      assert.notEqual((await h.fetch(path, {method:'POST', headers:{'X-CFSM-Terminal-Context':JSON.stringify({serverId:added.id})}, body:JSON.stringify({serverId:added.id,tokenVersion:999})})).status, 200);
    }
    const live = await h.socket('/update', {Authorization:`Bearer ${second.token}`});
    assert.equal((await h.action('batch_delete', {ids:[added.id]})).status, 200);
    await until(() => live.ws.readyState !== 1);
  } finally { await h.dispose(); }
});

test('configured site logs in without API_SECRET using persisted JWT and no data API leaks credentials', async () => {
  const h = await harness({apiSecret:false});
  try {
    await saveSiteOptions(h.db, {username:'admin-test', password:await hashPassword('fixture-password'), is_public:'true'});
    const response = await h.fetch('/admin/api', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'login',username:'admin-test',password:'fixture-password'})});
    assert.equal(response.status, 200);
    const {token} = await response.json();
    const sys = JSON.parse((await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first()).value);
    assert.equal(await checkAuth(new Request('https://example.com/admin', {headers:{Authorization:`Bearer ${token}`}}), {}, sys), true);
    const issued = await (await h.action('node_reset_token', {serverId:'node-a'})).json();
    for (const path of ['/api/config', '/api/servers']) {
      const result = await h.fetch(path);
      assert.equal(result.status, 200);
      assert.equal((await result.text()).includes(issued.token), false);
    }
    const settings = await (await h.action('get_settings')).json();
    assert.equal(Object.hasOwn(settings, 'api_secret'), false);
    assert.equal(JSON.stringify(settings).includes(sys.jwt_secret), false);
  } finally { await h.dispose(); }
});
