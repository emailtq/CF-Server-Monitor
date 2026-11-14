import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('real get_settings distinguishes persisted ping slots without changing settings defaults', async () => {
  const { Miniflare } = await import('miniflare');
  const { handleAdminAPI } = await import('../src/handlers/admin.js');
  const { generateToken } = await import('../src/middleware/auth.js');
  const { loadSettings, clearSiteSettingsCache, clearAppearanceSettingsCache } = await import('../src/utils/settings.js');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("OK"); } }', d1Databases: { DB: 'successor-ping' } });
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    const env = { DB: db, API_SECRET: 'fixture-only' }, sys = { password: 'fixture-hash', jwt_secret: 'x'.repeat(32) };
    const token = await generateToken(env, sys);
    const read = async () => {
      clearSiteSettingsCache(); clearAppearanceSettingsCache();
      const response = await handleAdminAPI(new Request('https://fixture.invalid/admin/api', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_settings' }) }), env, sys, () => loadSettings(db));
      assert.equal(response.status, 200); return response.json();
    };
    const empty = await read();
    assert.equal(empty.settings.custom_ct_name, '电信'); assert.equal(empty.settings.node_1_name, 'Node 1');
    assert.deepEqual(empty.configuredPingNodes, ['custom_ct', 'custom_cu', 'custom_cm'], 'three built-in targets are usable defaults, spare default labels are not configured rows');
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind('custom_cm_name', 'Legacy name only').run();
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind('custom_cu_name', 'Legacy overridden').run();
    await db.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(JSON.stringify({ username: 'fixture', jwt_secret: 'x'.repeat(32), custom_ct: 'target.test', custom_cu: '', custom_cm: '', custom_cu_name: '', node_1_name: 'Node 1' }), 'site_options').run();
    const configured = await read();
    assert.deepEqual(configured.configuredPingNodes, ['custom_ct', 'custom_cm', 'node_1']);
    assert.equal(configured.settings.custom_ct_name, '电信', 'target without name keeps fallback');
    assert.equal(configured.settings.custom_cm_name, 'Legacy name only');
    assert.equal(configured.settings.custom_cu_name, '', 'site_options empty overrides legacy');
    assert.equal(configured.settings.node_2_name, 'Node 2', 'settings DTO retains old defaults');
  } finally { clearSiteSettingsCache(); clearAppearanceSettingsCache(); await mf.dispose(); }
});

test('Android half-overlap reversal, name-only add, actual minimal grouping and incremental ping slots', { timeout: 240000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/successor.mjs'], { encoding: 'utf8', timeout: 230000, windowsHide: true, env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});
