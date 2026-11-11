import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';

test('Task4 real Vue ordinary settings, nodes and backup boundaries', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/task4.mjs', '--smoke'], { encoding: 'utf8', timeout: 240000, windowsHide: true, env: { ...process.env, ADMIN_UI_REPORT_DIR: process.env.ADMIN_UI_TASK4_NODE_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-4/correction-1/node-browser' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('late old-site HTTP auth errors must not affect the new site session or draft', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/task4.mjs', '--auth-scope-probe'], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, ADMIN_UI_REPORT_DIR: process.env.ADMIN_UI_TASK4_AUTH_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-4/correction-1/auth-scope' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('frozen presentation and missing-metric behaviors use real Vue controls', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/task4.mjs', '--presentation-probe'], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, ADMIN_UI_REPORT_DIR: process.env.ADMIN_UI_TASK4_PRESENTATION_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-4/correction-1/presentation' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('decomposed settings and add/version presentation compile without backend browser imports', () => {
  for (const name of ['AdminIcon', 'AdminHelp', 'GroupServersModal', 'RenewServerModal', 'SettingsPanel', 'AppearanceSettings', 'CollectionSettings', 'SecuritySettings', 'SiteSettings', 'AddServerModal', 'UpdatesPanel', 'ServerTable', 'DatabasePanel', 'ThemeStorePanel']) {
    const filename = `src/frontend/views/admin/components/${name}.vue`;
    const source = fs.readFileSync(filename, 'utf8');
    const { descriptor, errors } = parse(source);
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: name });
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: name, compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
    assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/\.\.\/\.\.\/(?:utils|handlers|database)\//);
  }
});

test('ordinary save reaches actual authenticated API with an authoritative notification configuration', async () => {
  const { Miniflare } = await import('miniflare');
  const { handleAdminAPI } = await import('../src/handlers/admin.js');
  const { generateToken } = await import('../src/middleware/auth.js');
  const { clearSiteSettingsCache, clearAppearanceSettingsCache } = await import('../src/utils/settings.js');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("OK"); } }', d1Databases: { DB: 'task4-settings' } });
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    const config = { schema: 1, revision: 2, channels: [], rules: [], timezone: 'Asia/Shanghai', language: 'en' };
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind('notification_config', JSON.stringify(config)).run();
    const sys = { password: 'fixture-hash', jwt_secret: 'x'.repeat(32), tg_notify: '5', tg_bot_token: 'smtp://fixture:fixture-secret@smtp.example.test:465?to=ops%40example.test', expire_reminder: '0' };
    const env = { DB: db, API_SECRET: 'fixture-only' };
    const token = await generateToken(env, sys);
    const call = async settings => {
      const response = await handleAdminAPI(new Request('https://fixture.test/admin/api', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save_settings', settings }) }), env, sys, null, { waitUntil() {} });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await call({ site_title: 'Task4 ordinary', username: 'fixture', frontend_ws_timeout_minutes: '15' })).status, 200);
    assert.equal((await call({ tg_bot_token: 'ignored-edit' })).status, 409);
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'notification_config'").first();
    assert.deepEqual(JSON.parse(row.value), config);
  } finally { clearSiteSettingsCache(); clearAppearanceSettingsCache(); await mf.dispose(); }
});
