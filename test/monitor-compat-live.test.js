import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';
import workerEntry from '../src/index.js';
import { createHistoryTableSql } from '../src/utils/historyFields.js';

const HOST = 'theme.example.test';
const ORIGIN = `https://${HOST}`;
const LEGACY = 'https://monitor.example.test';
const UPGRADE = { Upgrade: 'websocket', Connection: 'Upgrade' };
const waitFor = async (predicate, timeout = 5000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  assert.fail('Timed out waiting for live WebSocket event');
};

const worker = build({
  stdin: { resolveDir: process.cwd(), contents: `
    import worker, { MetricsBroadcaster } from './src/index.js';
    export class TestHub extends MetricsBroadcaster {
      constructor(state, env) {
        const reads = { policy: 0, inventory: 0, persisted: 0 };
        super(state, { ...env, DB: {
          prepare(sql) {
            if (sql.includes('AS group_type')) reads.policy++;
            if (sql.includes('FROM servers WHERE is_hidden')) reads.inventory++;
            if (sql.includes('JOIN metrics_history AS m')) reads.persisted++;
            return env.DB.prepare(sql);
          },
          batch: statements => env.DB.batch(statements)
        } });
        this.reads = reads;
      }
      _monitorCompatFrame(force) {
        if (this.failFrame) return Symbol('test send failure');
        return super._monitorCompatFrame(force);
      }
      async fetch(request) {
        const { pathname, searchParams } = new URL(request.url);
        if (pathname === '/test/reads') {
          return Response.json({ ...this.reads, timerActive: this.monitorCompatTimer !== null });
        }
        if (pathname === '/test/frame-failure') {
          this.failFrame = searchParams.has('enabled');
          return new Response(null);
        }
        return super.fetch(request);
      }
    }
    export default worker;
  ` },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*']
});

async function fixture(t) {
  const mf = new Miniflare({
    modules: true, script: (await worker).outputFiles[0].text,
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'monitor-compat-live' },
    durableObjects: { METRICS_BROADCASTER: { className: 'TestHub', useSQLite: true } },
    bindings: { MONITOR_COMPAT_HOST: HOST, CORS_ALLOWED_ORIGINS: LEGACY }
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await mf.dispose();
  });
  const db = await mf.getD1Database('DB');
  const ns = await mf.getDurableObjectNamespace('METRICS_BROADCASTER');
  const hub = ns.get(ns.idFromName('global'));
  await db.batch([
    db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'),
    db.prepare(`CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, sort_order INTEGER DEFAULT 0,
      is_hidden TEXT DEFAULT '0', server_group TEXT, region TEXT, history_partition_id INTEGER,
      timestamp INTEGER DEFAULT 0, price TEXT DEFAULT '8.25', currency TEXT DEFAULT '¥',
      billing_cycle TEXT, expire_date TEXT, traffic_limit TEXT, traffic_calc_type TEXT, reset_day INTEGER)`),
    db.prepare(createHistoryTableSql('metrics_history')),
    db.prepare("INSERT INTO servers (id, name, history_partition_id) VALUES ('node-a', 'Alpha', 20), ('node-b', 'Beta', 21)"),
    db.prepare("INSERT INTO settings VALUES ('site_options', '{\"is_public\":\"true\"}')")
  ]);

  return {
    db,
    fetch: (path, options, origin = ORIGIN) => mf.dispatchFetch(origin + path, options),
    setSite: settings => db.prepare("UPDATE settings SET value = ? WHERE key = 'site_options'")
      .bind(JSON.stringify({ is_public: 'true', ...settings })).run(),
    reads: async () => (await hub.fetch('https://metrics.internal/test/reads')).json(),
    failFrames: enabled => hub.fetch(`https://metrics.internal/test/frame-failure${enabled ? '?enabled' : ''}`),
    health: async () => (await hub.fetch('http://internal/health')).json(),
    async upload(cpu, path = '/batch-push') {
      const ts = Date.now();
      const data = { cpu, load: [1, 2, 3], ram_total: 256, ram_used: 10, swap_total: 0, swap_used: 0,
        disk_total: 1024, disk_used: 50, net_in_speed: 32, net_out_speed: 64, tcp_conn: 4, udp_conn: 5,
        processes: 6, boot_time: String(ts - 60_000), secret: 'private-data' };
      const body = path === '/batch-push' ? { updates: [{ serverId: 'node-a', samples: [{ ts, data }] }] } : data;
      return (await hub.fetch(`http://internal${path}`, { method: 'POST', body: JSON.stringify(body) })).json();
    },
    async socket({ origin = ORIGIN, path = '/api/ws', headers } = {}) {
      const runtime = new URL(path, await mf.ready);
      runtime.protocol = runtime.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(runtime, { headers: { 'MF-Original-URL': origin + path, ...headers } });
      sockets.push(socket);
      const messages = [];
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.on('message', (data, binary) => messages.push(binary ? data : data.toString()));
      return new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () => resolve({ status: 101, socket, messages, closed }));
        socket.once('unexpected-response', (_, response) => {
          response.once('end', () => resolve({ status: response.statusCode }));
          response.resume();
        });
      });
    }
  };
}

async function snapshot(peer, predicate = () => true, timeout) {
  assert.equal(peer.status, 101);
  return waitFor(() => {
    while (peer.messages.length) {
      const message = peer.messages.shift();
      assert.equal(typeof message, 'string');
      assert.ok(!message.includes('private-data'));
      const body = JSON.parse(message);
      assert.deepEqual(Object.keys(body).sort(), ['admin', 'nodes']);
      assert.equal(body.admin, false);
      assert.ok(Array.isArray(body.nodes));
      if (predicate(body.nodes)) return body;
    }
  }, timeout);
}

test('dual Monitor sockets share D1, get full live snapshots, and stay separate from CF clients', async t => {
  const h = await fixture(t);
  const [a, b] = await Promise.all([
    h.socket({ path: '/api/ws?gzip', headers: { Origin: ORIGIN } }), h.socket()
  ]);
  const [first, second] = await Promise.all([snapshot(a), snapshot(b)]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.nodes.map(n => n.name), ['Alpha', 'Beta']);
  const stableId = first.nodes[0].id;
  assert.equal((await h.reads()).inventory, 1);
  assert.equal((await h.reads()).persisted, 1);
  assert.equal((await h.health()).subscribers, 2);

  // Both existing report paths must ingest when only Monitor viewers are connected.
  assert.equal((await h.upload(24)).subscribers, 2);
  await Promise.all([snapshot(a, n => n[0].metrics?.cpu === 24), snapshot(b, n => n[0].metrics?.cpu === 24)]);
  assert.equal((await h.upload(28, '/push/node-a')).subscribers, 2);
  const updated = await snapshot(a, n => n[0].metrics?.cpu === 28);
  assert.equal(updated.nodes[0].id, stableId);
  assert.equal((await h.reads()).inventory, 1, 'do not fetch D1 on every frame');

  const legacy = await h.socket({ origin: LEGACY, path: '/api/ws?gzip&subscribe=all', headers: { Origin: LEGACY } });
  assert.equal(legacy.status, 101);
  assert.equal(JSON.parse(await waitFor(() => legacy.messages.shift())).type, 'hello');
  legacy.socket.send(JSON.stringify({ type: 'subscribe', ids: ['node-a'] }));
  assert.equal(JSON.parse(await waitFor(() => legacy.messages.shift())).type, 'subscribed');
  assert.equal((await h.upload(33)).subscribers, 3);
  const batch = JSON.parse(await waitFor(() => legacy.messages.shift()));
  assert.equal(batch.type, 'batchUpdate');
  assert.equal(batch.updates[0].samples[0].data.cpu, 33);
  await snapshot(b, n => n[0].metrics?.cpu === 33);

  a.socket.send('{"type":"ping"}');
  const afterPing = await snapshot(a, n => n[0].metrics?.cpu === 33);
  assert.equal(afterPing.nodes[0].id, stableId);
  a.socket.send('{"type":"subscribe","ids":["node-b"]}');
  await snapshot(a, n => n.length === 2);

  await h.db.prepare("UPDATE servers SET is_hidden = '1' WHERE id = 'node-b'").run();
  await h.setSite({ show_price: false });
  const hidden = await snapshot(a, n => n.length === 1, 13_000);
  assert.deepEqual(hidden.nodes.map(n => [n.id, n.price]), [[stableId, 0]]);
  await snapshot(b, n => n.length === 1 && n[0].price === 0);
  assert.equal((await h.reads()).inventory, 2, 'one metadata refresh across both viewers');

  a.socket.close();
  await waitFor(async () => (await h.health()).subscribers === 2);
  b.messages.length = 0;
  await snapshot(b, n => n.length === 1);
  b.socket.close();
  await waitFor(async () => (await h.health()).subscribers === 1);
  const idle = await h.reads();
  assert.equal(idle.timerActive, false);
  const reconnected = await h.socket();
  assert.deepEqual((await snapshot(reconnected)).nodes.map(n => n.id), [stableId]);
});

test('only upgrades from the exact compatibility origin may opt in and access fails closed', async t => {
  const h = await fixture(t);
  assert.equal((await h.fetch('/api/ws')).status, 426);
  assert.equal((await h.fetch('/api/ws', { method: 'POST' })).status, 405);
  for (const origin of [LEGACY, 'null', 'http://' + HOST, ORIGIN + ':9443', ORIGIN + '/']) {
    const response = await h.fetch('/api/ws', { headers: { ...UPGRADE, Origin: origin,
      'X-Real-Origin': origin, 'X-Forwarded-Host': origin, 'X-Forwarded-Proto': 'http' } });
    assert.equal(response.status, 403, `Origin=${origin}`);
  }
  // Miniflare's network proxy drops empty header values; exercise the handler directly for this value.
  const emptyOrigin = new Request(ORIGIN + '/api/ws', { headers: { ...UPGRADE, Origin: '' } });
  assert.equal((await workerEntry.fetch(emptyOrigin, { MONITOR_COMPAT_HOST: HOST })).status, 403);
  const internalPath = '/monitor-compat-live';
  assert.equal((await h.socket({ path: internalPath })).status, 404);
  for (const origin of [LEGACY, 'https://metrics.internal']) {
    assert.notEqual((await h.socket({ origin, path: internalPath })).status, 101);
  }
  const peer = await h.socket();
  await snapshot(peer);

  const credentials = { Cookie: 'cfsm_auth=not-used', Authorization: 'Bearer not-used', 'X-Turnstile-Verified': 'not-used' };
  await h.setSite({ turnstile_enabled: true });
  assert.equal(await waitFor(() => peer.socket.readyState === WebSocket.CLOSED, 13_000), true);
  assert.equal(await peer.closed, 1008);
  assert.equal((await h.socket({ headers: credentials })).status, 403);

  await h.setSite({});
  const reconnected = await h.socket();
  await snapshot(reconnected);
  await h.setSite({ is_public: 'false' });
  assert.equal(await waitFor(() => reconnected.socket.readyState === WebSocket.CLOSED, 13_000), true);
  assert.equal(await reconnected.closed, 1008);
  assert.equal((await h.socket({ headers: credentials })).status, 401);

  await h.setSite({});
  const beforeFailure = await h.socket();
  await snapshot(beforeFailure);
  await h.db.prepare('DROP TABLE settings').run();
  assert.equal((await h.socket()).status, 503);
  assert.equal(await beforeFailure.closed, 1013);
  assert.equal((await h.health()).subscribers, 0);
});

test('the hub caps Monitor connections and frees a slot on close', async t => {
  const h = await fixture(t);
  const viewers = await Promise.all(Array.from({ length: 64 }, () => h.socket()));
  assert.ok(viewers.every(viewer => viewer.status === 101));
  assert.equal((await h.health()).subscribers, 64);
  const before = await h.reads();
  assert.equal((await h.socket()).status, 503);
  assert.equal((await h.reads()).policy, before.policy, 'reject excess viewers before reading D1');
  assert.equal(before.persisted, 1);
  viewers[0].socket.close();
  await waitFor(async () => (await h.health()).subscribers === 63);
  await snapshot(await h.socket());
  assert.equal((await h.health()).subscribers, 64);
});

test('opening and periodic send failures release Monitor sockets', async t => {
  const h = await fixture(t);
  await h.failFrames(true);
  assert.equal((await h.socket()).status, 503);
  assert.equal((await h.health()).subscribers, 0);
  assert.equal((await h.reads()).timerActive, false);

  await h.failFrames(false);
  const viewer = await h.socket();
  await snapshot(viewer);
  await h.failFrames(true);
  await waitFor(() => viewer.socket.readyState === WebSocket.CLOSED);
  assert.equal(await viewer.closed, 1013);
  assert.equal((await h.health()).subscribers, 0);
  assert.equal((await h.reads()).timerActive, false);
});
