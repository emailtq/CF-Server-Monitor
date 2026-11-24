import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { getMonitorCompatIds } from '../src/database/monitorCompatIds.js';
import { changeLatencyTasks } from '../src/database/latencyTasks.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const idsModule = await import('../src/database/monitorProbeIds.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const getIds = (...args) => {
  assert.equal(typeof idsModule.getMonitorProbeIds, 'function', 'persistent probe ID API must be implemented');
  return idsModule.getMonitorProbeIds(...args);
};
async function fixture(t) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(); } }', d1Databases: { DB: 'probe-ids' } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'),
    db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, history_partition_id INTEGER)'),
    db.prepare("INSERT INTO servers VALUES ('uuid-a', 999)")
  ]);
  return db;
}

test('D1 concurrent mapping is persistent, positive, unique and does not burn IDs on repeated lookup', async t => {
  const db = await fixture(t);
  const metrics = Array.from({ length: 120 }, (_, i) => `p_generation_${i}`);
  const maps = await Promise.all(Array.from({ length: 6 }, () => getIds(db, [...metrics, metrics[0]])));
  assert.equal(maps[0].size, 120);
  assert.equal(new Set(maps[0].values()).size, 120);
  for (const id of maps[0].values()) assert.ok(Number.isSafeInteger(id) && id > 0);
  for (const map of maps) for (const metric of metrics) assert.equal(map.get(metric), maps[0].get(metric));
  const before = await db.prepare("SELECT seq FROM sqlite_sequence WHERE name='monitor_probe_ids'").first();
  assert.deepEqual(await getIds(db, metrics), maps[0]);
  assert.deepEqual(await db.prepare("SELECT seq FROM sqlite_sequence WHERE name='monitor_probe_ids'").first(), before);
  const rows = await db.prepare('SELECT metric_id,id FROM monitor_probe_ids').all();
  assert.equal(rows.results.length, 120);
  for (const row of rows.results) assert.equal(row.id, maps[0].get(row.metric_id));
});

test('real task target edit/delete/recreate preserves old generation IDs and leaves UUID/history/public node ID stable', async t => {
  const db = await fixture(t);
  const nodeId = (await getMonitorCompatIds(db, ['uuid-a'])).get('uuid-a');
  const initial = { version: 1, revision: 1, tasks: [], archives: [], sources: [], seen_nodes: ['uuid-a'] };
  await db.prepare("INSERT INTO settings VALUES ('latency_tasks', ?)").bind(JSON.stringify(initial)).run();
  const input = { name: 'Probe', target: 'example.com:443', interval: 60, nodes: ['uuid-a'], auto_join: true };
  let document = await changeLatencyTasks(db, {}, 'save', input);
  const firstTask = document.tasks[0];
  const firstId = (await getIds(db, [firstTask.metric_id || firstTask.id])).get(firstTask.id);
  document = await changeLatencyTasks(db, {}, 'save', { ...input, id: firstTask.id, base: ['uuid-a'], target: 'next.example.com:443' });
  const generation = document.tasks[0].metric_id;
  const nextId = (await getIds(db, [generation])).get(generation);
  assert.notEqual(nextId, firstId);
  assert.equal(document.archives[0].id, firstTask.id);
  await changeLatencyTasks(db, {}, 'delete', { id: firstTask.id });
  document = await changeLatencyTasks(db, {}, 'save', input);
  const recreated = document.tasks[0].id;
  const recreatedId = (await getIds(db, [recreated])).get(recreated);
  assert.ok(recreatedId > nextId);
  const old = await getIds(db, [firstTask.id, generation]);
  assert.equal(old.get(firstTask.id), firstId);
  assert.equal(old.get(generation), nextId);
  await db.prepare("DELETE FROM servers WHERE id='uuid-a'").run();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM monitor_probe_ids').first()).n, 3);
  await db.prepare("INSERT INTO servers VALUES ('uuid-a', 1000)").run();
  assert.equal((await getMonitorCompatIds(db, ['uuid-a'])).get('uuid-a'), nodeId);
  assert.deepEqual(await db.prepare('SELECT * FROM servers').first(), { id: 'uuid-a', history_partition_id: 1000 });
});

test('old hash-shaped numeric mappings cannot overwrite AUTOINCREMENT generations or node ID namespace', async t => {
  const db = await fixture(t);
  await getIds(db, ['p_prior']);
  await db.prepare("INSERT INTO monitor_probe_ids(id,metric_id) VALUES (314159, 'p_old_hash')").run();
  const map = await getIds(db, ['p_old_hash', 'p_new_generation']);
  assert.equal(map.get('p_old_hash'), 314159);
  assert.equal(map.get('p_new_generation'), 314160);
  assert.equal((await getMonitorCompatIds(db, ['uuid-a'])).get('uuid-a'), 1);
  await assert.rejects(() => db.prepare("UPDATE monitor_probe_ids SET metric_id='p_new_generation' WHERE metric_id='p_old_hash'").run(), /UNIQUE/);
  assert.equal((await getIds(db, ['p_old_hash'])).get('p_old_hash'), 314159);
});

test('invalid metric inputs fail before any schema/write and empty lists do not require DB', async t => {
  assert.deepEqual(await getIds(null, []), new Map());
  const db = await fixture(t);
  for (const input of [null, 'p_a', [null], ['p_ok', 'invalid'], ['p_' + 'x'.repeat(65)], ['p_secret\n']]) await assert.rejects(() => getIds(db, input));
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='monitor_probe_ids'").first(), null);
  await getIds(db, ['p_max']);
  await db.prepare("UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='monitor_probe_ids'").run();
  await assert.rejects(() => getIds(db, ['p_overflow']), /CHECK/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM monitor_probe_ids').first()).n, 1);
});

test('probe and public node mappings survive disposal and reopening the same persisted D1', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cfsm-monitor-probe-ids-'));
  const options = { modules: true, script: 'export default { fetch() { return new Response(); } }', d1Databases: { DB: 'probe-restart' }, resourcePersistencePath: root };
  let mf = new Miniflare(options);
  try {
    let db = await mf.getD1Database('DB');
    const probes = await getIds(db, ['p_first', 'p_second']);
    const nodes = await getMonitorCompatIds(db, ['uuid-a']);
    await mf.dispose();
    mf = new Miniflare(options);
    db = await mf.getD1Database('DB');
    assert.deepEqual(await getIds(db, ['p_first', 'p_second']), probes);
    assert.deepEqual(await getMonitorCompatIds(db, ['uuid-a']), nodes);
    assert.equal((await getIds(db, ['p_third'])).get('p_third'), 3);
  } finally {
    await mf.dispose();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cfsm-monitor-probe-ids-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
