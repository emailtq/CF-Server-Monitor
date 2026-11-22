import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { getMonitorCompatIds } from '../src/database/monitorCompatIds.js';
import { createHistoryTableSql } from '../src/utils/historyFields.js';
import { clearAllCaches } from '../src/utils/cache.js';

const HOST = 'theme.example.test';
const SERVER = 'legacy-node';
const HOUR = 3_600_000;

async function fixture(t) {
  clearAllCaches();
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    d1Databases: { DB: 'monitor-compat-history' }
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const env = { DB: db, MONITOR_FRONTEND_MODE: 'legacy', MONITOR_COMPAT_HOST: HOST };
  await db.batch([
    db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'),
    db.prepare(`CREATE TABLE servers (
      id TEXT PRIMARY KEY, is_hidden TEXT DEFAULT '0', history_partition_id INTEGER,
      timestamp INTEGER DEFAULT 0
    )`),
    db.prepare(createHistoryTableSql('metrics_history')),
    db.prepare("INSERT INTO settings VALUES ('site_options', '{\"is_public\":\"true\"}')"),
    db.prepare('INSERT INTO servers (id, history_partition_id) VALUES (?, 29)').bind(SERVER)
  ]);
  const id = (await getMonitorCompatIds(db, [SERVER])).get(SERVER);
  return {
    db, env, id, now: Math.floor(Date.now() / 1000) * 1000,
    request: (path, init, host = HOST) => worker.fetch(new Request(`https://${host}${path}`, init), env),
    settings: (key, value) => db.prepare('REPLACE INTO settings VALUES (?, ?)').bind(key, value).run(),
    metrics(query = '') { return this.request(`/api/nodes/${id}/metrics${query}`); },
    sample(ts, { uuid = SERVER, cpu = 24.5, ping = null, loss = null, probes = {}, old = false } = {}) {
      return db.prepare(`INSERT INTO ${old ? 'metrics_history_old' : 'metrics_history'} (
        id, server_id, timestamp, cpu, ram_used, disk_used, net_in_speed, net_out_speed,
        net_rx, net_tx, ping_ct, loss_ct, extra_probes
      ) VALUES (?, ?, ?, ?, 6.25, 40.5, 375, 550, 1000000, 2000000, ?, ?, ?)`)
        .bind(buildHistoryId(29, ts), uuid, ts, cpu, ping, loss, JSON.stringify(probes)).run();
    }
  };
}

async function history(h, query) {
  const response = await h.metrics(query);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return response.json();
}

test('default six-hour history reads only the mapped UUID and projects sampled rates and MiB', async t => {
  const h = await fixture(t);
  const ts = h.now - 60_000;
  await h.sample(h.now - 7 * HOUR, { cpu: 7 });
  await h.sample(h.now - 5 * HOUR, { uuid: 'former-node', cpu: 99 });
  await h.sample(ts - 1000, { uuid: 'former-node', cpu: 98 });
  await h.sample(ts);
  assert.deepEqual(await history(h, '?series=metrics'), {
    metrics: [{ ts: ts / 1000, cpu: 24.5, mem_used: 6_553_600, disk_used: 42_467_328, net_rx: 375, net_tx: 550 }],
    ping: [], probes: {}, loss: {}, step: 120
  });
});

test('native hours and point budgets are capped, without sharing incompatible cached windows', async t => {
  const h = await fixture(t);
  const rows = Array.from({ length: 360 }, (_, i) => {
    const ts = h.now - (i + 1) * 60_000;
    return [buildHistoryId(29, ts), ts, i];
  });
  await h.db.prepare(`INSERT INTO metrics_history (server_id, id, timestamp, cpu)
    SELECT ?, value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)`)
    .bind(SERVER, JSON.stringify(rows)).run();
  await h.sample(h.now - 23 * HOUR, { cpu: 71 });
  await h.sample(h.now - 25 * HOUR, { cpu: 99 });
  const fine = await history(h, '?series=metrics&hours=6&points=9000');
  assert.equal(fine.step, 120);
  assert.ok(fine.metrics.length > 100 && fine.metrics.length <= 240);
  const coarse = await history(h, '?series=metrics&hours=6&points=60');
  assert.equal(coarse.step, 360);
  assert.ok(coarse.metrics.length > 45 && coarse.metrics.length <= 60);
  const capped = await history(h, '?series=metrics&hours=720&points=60');
  assert.equal(capped.step, 1440);
  assert.ok(capped.metrics.some(m => m.ts === (h.now - 23 * HOUR) / 1000));
  assert.ok(capped.metrics.every(m => m.ts > (h.now - 24 * HOUR) / 1000));
  assert.equal((await h.metrics('?hours=banana')).status, 400);
  assert.equal((await h.metrics('?points=3.5')).status, 400);
  const ignored = await history(h, '?series=other');
  assert.deepEqual(ignored, { metrics: [], ping: [], probes: {}, loss: {}, step: 120 });
});

test('a Sunday window samples both tables, with the same UUID scope on old rows', async t => {
  const sunday = Date.UTC(2026, 10, 22);
  t.mock.method(Date, 'now', () => sunday + 12 * 60_000);
  const h = await fixture(t);
  await h.db.prepare(createHistoryTableSql('metrics_history_old')).run();
  await h.sample(sunday - 180_000, { uuid: 'former-node', cpu: 99, old: true });
  await h.sample(sunday - 179_000, { cpu: 15, old: true });
  await h.sample(sunday + 30_000, { cpu: 23 });
  assert.deepEqual((await history(h, '?hours=1&series=metrics')).metrics.map(m => m.cpu), [15, 23]);
});

test('probe rows use public labels and keep timeout distinct from disabled or missing', async t => {
  const h = await fixture(t);
  const secret = 'not-public.internal';
  await h.settings('site_options', JSON.stringify({ is_public: 'true', custom_ct_name: 'Carrier A', custom_ct: secret }));
  await h.settings('extra_ping_nodes', JSON.stringify([{ id: 'p_extra', name: 'Extra', target: secret }]));
  await h.sample(h.now - 15 * 60_000, { ping: 25, loss: 20, probes: { p_extra: { ping: 19, loss: 0 } } });
  await h.sample(h.now - 12 * 60_000, { loss: 100, probes: { p_extra: { ping: null, loss: 100 } } });
  await h.sample(h.now - 9 * 60_000, { ping: 'false', loss: 'false', probes: { p_extra: { ping: false, loss: false } } });
  await h.sample(h.now - 6 * 60_000, { probes: { p_extra: { ping: null, loss: null }, p_unlisted: { ping: 47, loss: 0 } } });
  const reply = await history(h, '?series=ping');
  assert.deepEqual(reply.metrics, []);
  assert.deepEqual(reply.loss, {});
  assert.deepEqual(reply.ping.map(p => [reply.probes[p.task_id], p.latency, p.loss]), [
    ['Carrier A', 25, 20], ['Extra', 19, undefined], ['Carrier A', null, 100], ['Extra', null, 100]
  ]);
  assert.ok(reply.ping.every(p => Number.isSafeInteger(p.task_id) && !('band' in p)));
  assert.ok(!JSON.stringify(reply).includes(secret));
  assert.deepEqual(await history(h), { ...reply, metrics: (await history(h, '?series=metrics')).metrics });
});

test('active tasks use assigned metric generations and remap historical legacy slots read-only', async t => {
  const h = await fixture(t);
  const old = h.now - 2 * HOUR;
  const task = (id, name, nodes = [SERVER], metric_id = id) => ({ id, name, metric_id, nodes, target: 'private.internal' });
  const document = {
    version: 1, seen_nodes: [SERVER],
    tasks: [task('p_carrier', 'Renamed Carrier'), task('p_main', 'New probe', [SERVER], 'p_generation2'),
      task('p_other', 'Different node', ['other'])],
    sources: [{ id: 'p_carrier', node: SERVER, slot: 'custom_ct', target: 'private.internal', before: old }]
  };
  const raw = JSON.stringify(document);
  const header = '{"version":1,"chunked":true}';
  await h.settings('latency_tasks', header);
  await h.settings('latency_tasks:document:1', raw.slice(0, 71));
  await h.settings('latency_tasks:document:2', raw.slice(71));
  await h.sample(old, { ping: 37, loss: 0 });
  await h.sample(h.now - 70_000, {
    ping: 21, loss: 0, probes: { p_generation2: { ping: 42, loss: 0 }, p_other: { ping: 7, loss: 0 }, p_main: { ping: 12, loss: 0 } }
  });
  const long = await history(h, '?series=ping&hours=6');
  const short = await history(h, '?series=ping&hours=1');
  assert.deepEqual(long.ping.map(p => [long.probes[p.task_id], p.latency]), [['Renamed Carrier', 37], ['New probe', 42]]);
  assert.deepEqual(short.ping, [long.ping[1]], 'the same task keeps its ID when earlier tasks do not have points');
  assert.ok(!JSON.stringify(long).includes('private.internal'));
  assert.equal((await h.db.prepare("SELECT value FROM settings WHERE key = 'latency_tasks'").first()).value, header);
  await h.settings('latency_tasks', JSON.stringify({ ...document, tasks: [document.tasks[1]] }));
  const updated = await history(h, '?series=ping&hours=6');
  assert.deepEqual(updated.ping, [long.ping[1]], 'cached data never lets a removed task remain public');
});

test('history authorization and node lookups recheck visible servers after warming the cache', async t => {
  const h = await fixture(t);
  await h.sample(h.now - 60_000);
  assert.equal((await history(h)).metrics.length, 1);
  const path = `/api/nodes/${h.id}/metrics`;
  for (const suffix of ['0001', '0', '9007199254740992', '42', SERVER]) {
    assert.equal((await h.request(`/api/nodes/${suffix}/metrics`)).status, 404);
  }
  assert.equal((await h.request(path, { method: 'HEAD' })).status, 405);
  await h.db.prepare("UPDATE servers SET is_hidden = '1'").run();
  assert.equal((await h.request(path)).status, 404);
  await h.db.prepare('UPDATE servers SET is_hidden = NULL').run();
  assert.equal((await h.request(path)).status, 404);
  await h.db.prepare("UPDATE servers SET is_hidden = '0'").run();
  await h.settings('site_options', '{"is_public":"false"}');
  assert.equal((await h.request(path, { headers: { Cookie: 'cfsm_auth=ignored' } })).status, 401);
  await h.settings('site_options', '{"is_public":"true","turnstile_enabled":true}');
  assert.equal((await h.request(path)).status, 403);
  await h.settings('site_options', '{"is_public":"true"}');
  await h.db.prepare('DELETE FROM servers').run();
  assert.equal((await h.request(path)).status, 404);
});

test('query faults do not look like successful empty results or poison another series', async t => {
  const h = await fixture(t);
  assert.deepEqual((await history(h, '?series=metrics')).metrics, []);
  await h.settings('latency_tasks', 'broken JSON');
  assert.equal((await h.metrics('?series=ping')).status, 503);
  assert.equal((await h.metrics('?series=metrics')).status, 200);
  await h.db.prepare('DROP TABLE metrics_history').run();
  assert.equal((await h.metrics('?series=metrics&hours=1')).status, 503);
  await h.db.prepare('DROP TABLE settings').run();
  assert.equal((await h.metrics()).status, 503);
});

test('busy history rejects an additional scan rather than queueing it', { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let count = 0;
  h.env.DB = {
    prepare(sql) {
      const statement = h.db.prepare(sql);
      if (!sql.includes('WITH RECURSIVE sample_ranges')) return statement;
      return { bind: (...args) => ({ all: async () => {
        if (++count === 4) started.resolve();
        await release.promise;
        return statement.bind(...args).all();
      } }) };
    }
  };
  const requests = [1, 2, 3, 4].map(hours => h.metrics(`?hours=${hours}&series=metrics`));
  try {
    await started.promise;
    assert.equal((await h.metrics('?hours=5&series=metrics')).status, 503);
  } finally {
    release.resolve();
  }
  assert.deepEqual((await Promise.all(requests)).map(r => r.status), [200, 200, 200, 200]);
  assert.equal((await h.metrics('?hours=5&series=metrics')).status, 200);
});

test('known theme configuration is read-only and isolated from legacy history and global options', async t => {
  const h = await fixture(t);
  const path = '/api/themes/default/config';
  await h.settings('appearance_options', '{"theme_options":{"private":"not for this theme"}}');
  await h.settings('theme_config:default', '{"themeOverride":true}');
  const response = await h.request(path);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal((await h.request(path, { method: 'PUT' })).status, 405);
  assert.equal((await h.request('/api/themes/other/config')).status, 404);
  const legacyPath = `/api/history/all?id=${SERVER}&hours=1`;
  await h.sample(h.now - 60_000);
  const legacy = await h.request(legacyPath, {}, 'legacy.example.test');
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json())[0].ram_used, 6.25, 'legacy history still returns a bare array in MiB');
  assert.equal((await h.request(legacyPath)).status, 404);
  await h.settings('site_options', '{"is_public":"false"}');
  assert.equal((await h.request(path)).status, 401);
});
