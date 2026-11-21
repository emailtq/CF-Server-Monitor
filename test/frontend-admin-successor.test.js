import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('group assignment is one atomic group-only mutation, including rename, dissolve and stale IDs', async () => {
  const { Miniflare } = await import('miniflare');
  const { handleAdminAPI } = await import('../src/handlers/admin.js');
  const { generateToken } = await import('../src/middleware/auth.js');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("OK"); } }', d1Databases: { DB: 'groups' } });
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, server_group TEXT, note TEXT, node_token TEXT, expire_date TEXT)').run();
    const ids = [1, 2, 3].map(i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const [i, id] of ids.entries()) await db.prepare('INSERT INTO servers VALUES (?, ?, ?, ?, ?)').bind(id, i < 2 ? 'Asia' : 'Europe', `note-${i}`, `token-${i}`, '2027-01-01').run();
    const env = { DB: db }, sys = { password: 'fixture-hash', jwt_secret: 'x'.repeat(32) }, token = await generateToken(env, sys);
    const post = (data, authenticated = true) => handleAdminAPI(new Request('https://fixture.invalid/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ action: 'batch_group', ...data }) }), env, sys);
    const rows = async () => (await db.prepare('SELECT * FROM servers ORDER BY id').all()).results;
    const original = await rows();
    assert.equal((await post({ ids: ids.slice(0, 2), server_group: 'New Asia' }, false)).status, 401);
    const rename = await post({ ids: ids.slice(0, 2), server_group: '  New Asia  ' });
    assert.equal(rename.status, 200, 'the real authenticated batch action exists');
    assert.equal((await rename.json()).updated, 2);
    assert.deepEqual(await rows(), original.map((row, i) => ({ ...row, server_group: i < 2 ? 'New Asia' : 'Europe' })), 'only selected group fields change, no credential/billing round trip');
    const beforeInvalid = await rows();
    for (const data of [{ ids: [], server_group: '' }, { ids: ['bad'], server_group: '' }, { ids: [ids[0], ids[0]], server_group: '' }, { ids: [ids[0], '00000000-0000-4000-8000-999999999999'], server_group: '' }, { ids: [ids[0]], server_group: {} }]) {
      assert.equal((await post(data)).status, 400); assert.deepEqual(await rows(), beforeInvalid, 'rejected or stale selection must change no rows');
    }
    await db.prepare("CREATE TRIGGER group_failure BEFORE UPDATE ON servers WHEN NEW.id = '" + ids[1] + "' AND NEW.server_group = 'fail' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END").run();
    const failed = await post({ ids: ids.slice(0, 2), server_group: 'fail' }); assert.equal(failed.status, 500);
    assert.deepEqual(await rows(), beforeInvalid, 'a database failure on the second selected row rolls back the first');
    assert.equal((await post({ ids: ids.slice(0, 2), server_group: '' })).status, 200);
    assert.deepEqual((await rows()).map(r => r.server_group), ['', '', 'Europe'], 'dissolve stores genuine ungrouped values, not a new Default group');
    const existingLongName = '已有分组'.repeat(30);
    assert.equal((await post({ ids: [ids[0]], server_group: existingLongName })).status, 200, 'CF existing long group names remain valid');
  } finally { await mf.dispose(); }
});

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

test('Android half-overlap reversal, name-only add, actual minimal grouping and persisted unlimited tasks', { timeout: 240000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/successor.mjs'], { encoding: 'utf8', timeout: 230000, windowsHide: true, env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});
