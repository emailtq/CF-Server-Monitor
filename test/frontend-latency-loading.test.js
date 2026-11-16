import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { harness } from './terminal-harness.js';
import { loadLatencyTasks, changeLatencyTasks } from '../src/database/latencyTasks.js';

test('first activation reads the missing catalog once and reloads only its atomic migration result', async () => {
  const h = await harness();
  try {
    const sql = [];
    const db = new Proxy(h.db, { get(target, key) {
      if (key === 'prepare') return query => { sql.push(query); return target.prepare(query); };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
    const migrated = await changeLatencyTasks(db, { custom_ct: 'migration.test:443' }, 'reconcile');
    assert.equal(migrated.tasks[0].target, 'migration.test:443');
    assert.equal(sql.filter(query => query.includes("key='latency_tasks' OR")).length, 2);
    assert.equal(migrated.legacy.settings.custom_ct, 'migration.test:443');
  } finally { await h.dispose(); }
});

test('warm canonical reads reconcile once without rereading the recovery document', async () => {
  const h = await harness();
  try {
    await h.action('latency_list');
    const sql = [];
    const db = new Proxy(h.db, { get(target, key) {
      if (key === 'prepare') return query => { sql.push(query); return target.prepare(query); };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
    for (const read of [() => loadLatencyTasks(db), () => changeLatencyTasks(db, null, 'reconcile')]) {
      sql.length = 0;
      assert.equal((await read()).tasks.length, 3);
      assert.equal(sql.filter(query => query.includes("key='latency_tasks' OR")).length, 1, 'one complete recovery read per reconciliation');
      assert.equal(sql.filter(query => query === 'SELECT id FROM servers').length, 1, 'registration/delete reconciliation is retained');
    }
    await h.db.prepare("INSERT INTO servers(id,name) VALUES('fresh-loading','Fresh')").run();
    assert.ok((await loadLatencyTasks(db)).tasks.every(task => task.nodes.includes('fresh-loading')));
    await h.db.prepare("DELETE FROM servers WHERE id='fresh-loading'").run();
    assert.ok((await loadLatencyTasks(db)).tasks.every(task => !task.nodes.includes('fresh-loading')));
  } finally { await h.dispose(); }
});

test('an unchanged authenticated latency read preserves warm server/settings caches', async () => {
  const h = await harness({ traceD1: true });
  try {
    await h.action('latency_list');
    await h.action('list');
    const before = (await (await h.fetch('/test/worker-stats')).json()).queryTrace.length;
    await h.action('latency_list');
    await h.action('list');
    const trace = (await (await h.fetch('/test/worker-stats')).json()).queryTrace.slice(before);
    assert.equal(trace.filter(item => item.sql === 'SELECT * FROM servers ORDER BY sort_order ASC').length, 0, 'reading the catalog must not evict the server list');
  } finally { await h.dispose(); }
});

test('ordinary admin requests forward cancellation without changing current auth semantics', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  try {
    globalThis.window = { location: { origin: 'https://fixture.test', pathname: '/admin' } };
    globalThis.localStorage = { getItem: () => null };
    const { adminApi } = await vite.ssrLoadModule('/src/frontend/utils/api.js');
    const controller = new AbortController();
    globalThis.fetch = (_url, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      setTimeout(() => resolve(Response.json({ tasks: [], revision: 1 })), 30);
    });
    const pending = adminApi({ action: 'latency_list' }, 0, () => !controller.signal.aborted, controller.signal);
    controller.abort();
    assert.equal((await pending).stale, true);
    // A missing signal waits for the response; the decisive cancellation evidence is checked at the transport boundary.
    let receivedSignal;
    globalThis.fetch = async (_url, options) => { receivedSignal = options.signal; return Response.json({}); };
    await adminApi({ action: 'latency_list' }, 0, () => true, controller.signal);
    assert.equal(receivedSignal, controller.signal);
  } finally { Object.assign(globalThis, saved); await vite.close(); }
});

test('actual latency first frame, refresh, node race, mutation race, error and site ownership', { timeout: 180000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/latency-loading.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 170000, env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

test('first-error and initial-in-flight catalogs keep Add reachable and save authoritative', { timeout: 60000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/latency-loading.mjs', '--add-recovery-only'], { encoding: 'utf8', windowsHide: true, timeout: 55000, env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

test('revisited latency stays visible and first reports patch node metadata without replacing node ownership', { timeout: 180000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/latency-loading.mjs', '--phase43-only'], { encoding: 'utf8', windowsHide: true, timeout: 170000, env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

test('metadata rejection and transport exceptions preserve adopted terminal state and recover without leaking requests', { timeout: 60000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/latency-loading.mjs', '--metadata-errors-only'], { encoding: 'utf8', windowsHide: true, timeout: 55000, env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});
