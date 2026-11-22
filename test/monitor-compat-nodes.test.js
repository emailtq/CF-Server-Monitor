import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { toBroadcastSamples } from '../src/handlers/update.js';
import { loadMonitorCompatSnapshot } from '../src/services/monitorCompatSnapshot.js';
import { createHistoryTableSql } from '../src/utils/historyFields.js';

const HOST = 'theme.example.test';

async function fixture(t) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: { DB: 'monitor-compat-nodes' }
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'),
    db.prepare(`CREATE TABLE servers (
      id TEXT PRIMARY KEY, name TEXT, sort_order INTEGER DEFAULT 0, is_hidden TEXT DEFAULT '0',
      server_group TEXT, region TEXT, history_partition_id INTEGER, timestamp INTEGER DEFAULT 0,
      price TEXT DEFAULT '8.25', currency TEXT DEFAULT '¥', billing_cycle TEXT DEFAULT 'quarter',
      expire_date TEXT DEFAULT '2028-01-15', traffic_limit TEXT DEFAULT '2.5',
      traffic_calc_type TEXT DEFAULT 'ul', reset_day INTEGER DEFAULT 7, note TEXT DEFAULT 'private note',
      terminal_local_enabled INTEGER DEFAULT 1
    )`),
    db.prepare(createHistoryTableSql('metrics_history')),
    db.prepare("INSERT INTO settings VALUES ('site_options', '{\"is_public\":\"true\"}')")
  ]);
  const env = { DB: db, MONITOR_FRONTEND_MODE: 'legacy', MONITOR_COMPAT_HOST: HOST };
  return {
    db, env,
    request: options => worker.fetch(new Request(`https://${HOST}/api/nodes`, options), env),
    setSite: options => db.prepare("UPDATE settings SET value = ? WHERE key = 'site_options'")
      .bind(JSON.stringify({ is_public: 'true', ...options })).run(),
    server: (name, partition, sort = 0, hidden = '0') => db.prepare(`INSERT INTO servers
      (id, name, history_partition_id, sort_order, is_hidden, server_group, region)
      VALUES (?, ?, ?, ?, ?, 'Edge', '')`).bind(`uuid-${name}`, name, partition, sort, hidden).run(),
    report: (name, partition, ts, { cpu = 23, load = '1.25 0.95 0.5', bootTime = ts - 60_000 } = {}) =>
      db.prepare(`INSERT INTO metrics_history (
        id, server_id, timestamp, cpu, load_avg, ram_total, ram_used, swap_total, swap_used,
        disk_total, disk_used, net_in_speed, net_out_speed, net_rx, net_tx, net_rx_monthly, net_tx_monthly,
        processes, tcp_conn, udp_conn, cpu_cores, cpu_info, os, arch, kernel_version, boot_time,
        agent_version, region, ip_v4
      ) VALUES (?, ?, ?, ?, ?, 256, 12.5, 0, 0, 1024, 30, 11, 22, 440, 550, 123, 456,
        7, 3, 2, 4, 'AMD', 'Debian 12', 'x86_64', '6.1', ?, 'v2.0', 'us', '192.0.2.1')`)
        .bind(buildHistoryId(partition, ts), `uuid-${name}`, ts, cpu, load, bootTime).run()
  };
}

async function snapshot(h) {
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['admin', 'nodes']);
  assert.equal(body.admin, false);
  return body.nodes;
}

test('node IDs are stable across concurrent and repeated snapshots and are not recycled after deletion', async t => {
  const h = await fixture(t);
  await h.db.prepare(`INSERT INTO servers (id, name, history_partition_id, sort_order)
    SELECT 'uuid-' || value, value, value, value FROM json_each(?)`)
    .bind(JSON.stringify(Array.from({ length: 115 }, (_, i) => i + 120))).run();
  const [first, second] = await Promise.all([snapshot(h), snapshot(h)]);
  const ids = first.map(n => n.id);
  assert.equal(ids.length, 115);
  assert.ok(ids.every(id => Number.isSafeInteger(id) && id > 0));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(second.map(n => n.id), ids);

  await h.db.prepare("DELETE FROM servers WHERE id = 'uuid-120'").run();
  assert.deepEqual((await snapshot(h)).map(n => n.id), ids.slice(1));
  await h.server('replacement', 120, 120);
  const [replacement, ...survivors] = await snapshot(h);
  assert.equal(replacement.name, 'replacement');
  assert.equal(replacement.id, Math.max(...ids) + 1, 'repeat reads must not advance the sequence');
  assert.deepEqual(survivors.map(n => n.id), ids.slice(1));

  await h.server('120', 300, 500);
  assert.equal((await snapshot(h)).at(-1).id, ids[0], 'the removed UUID keeps its mapping');
});

test('public snapshot projects real CF data and fresh DO samples into the Monitor allowlist', async t => {
  const h = await fixture(t);
  const ts = Math.floor(Date.now() / 1000) * 1000 - 20_000;
  await h.server('live', 20, 7);
  await h.server('offline', 21, 2);
  await h.server('never', 22, 0);
  await h.server('hidden', 23, -1, '1');
  await h.server('invalid-visibility', 24, -2, null);
  await h.report('live', 20, ts);
  await h.report('offline', 21, ts - 301_000);
  await h.report('hidden', 23, ts);
  // Simulate a leftover row from another server that used this partition before.
  await h.report('deleted', 22, ts);

  const liveTs = ts + 8000;
  const reportMetrics = {
    cpu: '41.5', load_avg: '1.2 0.8 0.2', ram_total: 256, ram_used: '6.25', swap_total: 0, swap_used: 0,
    disk_total: 1024, disk_used: 31, net_in_speed: '222', net_out_speed: 333, net_rx: 700, net_tx: 800,
    processes: 8, tcp_conn: 4, udp_conn: 1, ip_v4: '192.0.2.42', ssh_token: 'private-token', terminal_enabled: true
  };
  const samples = toBroadcastSamples('uuid-live', [{ ts: liveTs, metrics: reportMetrics }], 'us', 'v2.1');
  h.env.METRICS_BROADCASTER = {
    idFromName: name => name,
    get: id => ({ fetch: async (url, init) => {
      assert.equal(id, 'global');
      assert.equal(url, 'http://internal/latest-report-updates');
      assert.deepEqual(JSON.parse(init.body).serverIds, ['uuid-never', 'uuid-offline', 'uuid-live']);
      return Response.json({ updates: [
        { serverId: 'uuid-live', samples: [...samples, { ts: ts - 1000, data: { cpu: 99 } }] },
        { serverId: 'uuid-hidden', samples }
      ] });
    } })
  };
  const [never, offline, live] = await snapshot(h);
  assert.deepEqual([never.name, offline.name, live.name], ['never', 'offline', 'live']);
  assert.deepEqual([never.online, never.last_seen, never.last_seen_ago, never.metrics], [false, 0, null, null]);
  assert.deepEqual([offline.online, offline.last_seen, offline.metrics, offline.mem_total],
    [false, (ts - 301_000) / 1000, null, 268_435_456]);
  assert.deepEqual(live, {
    id: live.id, name: 'live', sort: 7, public: true, online: true,
    country: 'US', group: 'Edge', last_seen: liveTs / 1000, last_seen_ago: live.last_seen_ago,
    metrics: {
      uptime: 68, cpu: 41.5, load: [1.2, 0.8, 0.2], mem_total: 268_435_456, mem_used: 6_553_600,
      swap_total: 0, swap_used: 0, disk_total: 1_073_741_824, disk_used: 32_505_856,
      net_rx: 222, net_tx: 333, total_rx: 700, total_tx: 800, month_rx: 123, month_tx: 456, tcp: 4, udp: 1, procs: 8
    },
    os: 'Debian 12', kernel: '6.1', arch: 'x86_64', virt: '', cpu_name: 'AMD', cpu_cores: 4,
    mem_total: 268_435_456, swap_total: 0, disk_total: 1_073_741_824, agent_version: 'v2.1',
    price: 8.25, currency: 'CNY', billing_cycle: 'quarterly', expires_at: '2028-01-15',
    traffic_limit: 2_684_354_560, traffic_mode: 'up', traffic_reset_day: 7,
    total_rx: 700, total_tx: 800, month_rx: 123, month_tx: 456, month_used: 456,
    month_start: '', day_rx: null, day_tx: null
  });
  assert.ok(live.last_seen_ago >= 12 && live.last_seen_ago < 300);
});

test('newer D1 reports win; a malformed load is not replaced with a fabricated metric', async t => {
  const h = await fixture(t);
  const ts = Math.floor(Date.now() / 1000) * 1000 - 3000;
  await h.server('live', 31);
  await h.report('live', 31, ts - 1000, { cpu: 23 });
  await h.report('live', 31, ts, { cpu: 43, load: '0.5 -1 3' });
  h.env.METRICS_BROADCASTER = {
    idFromName: name => name,
    get: () => ({ fetch: async () => Response.json({ updates: [
      { serverId: 'uuid-live', samples: [{ ts: ts - 500, data: { cpu: 91 } }] }
    ] }) })
  };
  const [node] = await snapshot(h);
  assert.equal(node.online, true);
  assert.equal(node.last_seen, ts / 1000);
  assert.equal(node.metrics, null);
});

test('the hub can build from preloaded samples without fetching itself', async t => {
  const h = await fixture(t);
  const ts = Math.floor(Date.now() / 1000) * 1000 - 10_000;
  await h.server('live', 31);
  await h.report('live', 31, ts - 1000);
  let internalReads = 0;
  h.env.METRICS_BROADCASTER = { idFromName() { internalReads++; } };
  const payload = Object.freeze({ cpu: 30, load: Object.freeze([1, 2, 3]),
    ram_total: 17, ram_used: 4, swap_total: 0, swap_used: 0, disk_total: 50, disk_used: 6,
    net_in_speed: 100, net_out_speed: 200, tcp_conn: 4, udp_conn: 4, processes: 60 });
  const updates = [{ serverId: 'uuid-live', samples: [{ ts, payload }] }];
  const read = async now => (await loadMonitorCompatSnapshot(h.env, {
    display: { showPrice: false, showExpire: false, showTraffic: false }, latestReportUpdates: updates, now
  })).nodes[0];
  const online = await read(ts + 299_999);
  assert.deepEqual([online.online, online.metrics.cpu, online.metrics.load, online.last_seen], [true, 30, [1, 2, 3], ts / 1000]);
  const offline = await read(ts + 300_000);
  assert.deepEqual([offline.online, offline.metrics, offline.last_seen_ago], [false, null, 300]);
  assert.equal(internalReads, 0);
});

test('billing and traffic switches mask their respective fields without discarding network rates', async t => {
  const h = await fixture(t);
  const ts = Math.floor(Date.now() / 1000) * 1000 - 3000;
  await h.server('live', 31);
  await h.report('live', 31, ts);
  await h.db.prepare("INSERT INTO settings VALUES ('show_expire', 'false')").run();
  await h.setSite({ show_price: 'false', show_tf: false });
  const [node] = await snapshot(h);
  assert.deepEqual([node.price, node.currency, node.billing_cycle, node.expires_at], [0, '', '', null]);
  assert.deepEqual([node.traffic_limit, node.total_rx, node.total_tx, node.month_rx, node.month_tx, node.month_used],
    [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([node.metrics.net_rx, node.metrics.net_tx, node.metrics.total_rx, node.metrics.month_tx],
    [11, 22, 0, 0]);
  assert.equal((await h.db.prepare("SELECT value FROM settings WHERE key = 'site_options'").first()).value,
    '{"is_public":"true","show_price":"false","show_tf":false}');
});

test('data requests are gated and fail closed after a hide or database failure', async t => {
  const h = await fixture(t);
  const options = { headers: { Cookie: 'cfsm_auth=ignored', Authorization: 'Bearer ignored' } };
  await h.server('visible', 20);
  assert.equal((await snapshot(h)).length, 1);
  await h.db.prepare("UPDATE servers SET is_hidden = '1'").run();
  assert.deepEqual(await snapshot(h), []);
  await h.db.prepare("UPDATE servers SET is_hidden = '0'").run();

  await h.setSite({ is_public: 'false' });
  assert.equal((await h.request(options)).status, 401);
  await h.setSite({ turnstile_enabled: true });
  assert.equal((await h.request(options)).status, 403);
  assert.equal((await h.request({ method: 'POST' })).status, 405);
  await h.setSite({});

  await h.db.prepare('DROP TABLE metrics_history').run();
  assert.equal((await h.request()).status, 503, 'metric query failure does not claim success with no samples');
  await h.db.prepare('DROP TABLE servers').run();
  assert.equal((await h.request()).status, 503);
  await h.db.prepare('DROP TABLE settings').run();
  assert.equal((await h.request()).status, 503);
});
