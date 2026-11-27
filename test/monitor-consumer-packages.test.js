import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare } from 'miniflare';
import { packageConsumer } from '../scripts/package-monitor-consumer.mjs';
import { parseMonitorThemeArchive } from '../src/shared/monitorThemeArchive.js';
import { installMonitorTheme, loadMonitorRelease, loadMonitorPackageRegistry, readMonitorThemeFile, removeMonitorTheme } from '../src/services/monitorThemePackages.js';
import { installMonitorRepository } from '../src/services/monitorThemeRepository.js';
import { loadMonitorThemes, selectMonitorTheme, saveMonitorThemeConfig } from '../src/services/monitorThemes.js';
import worker from '../src/index.js';
import { generateToken } from '../src/middleware/auth.js';

const stream = bytes => new Blob([bytes]).stream();
const source = 'monitor-themes/default/source';
const upstream = JSON.parse(fs.readFileSync(`${source}/theme.json`, 'utf8'));
const revised = { ...upstream, short: 'consumer-test', version: '1.4.3-cf.1', cf_revision: 'nullable.1', upstream: { version: upstream.version } };
async function fixture(t) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response();}}', d1Databases: { DB: 'consumer-packages' } });
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  await DB.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT)').run();
  return { DB };
}

test('CF package is reproducible and accepted by the production archive parser', async () => {
  const bytes = packageConsumer(source, revised, ['LICENSE']);
  assert.deepEqual(bytes, packageConsumer(source, revised, ['LICENSE']));
  const parsed = await parseMonitorThemeArchive(stream(bytes));
  assert.equal(parsed.manifest.cf_revision, 'nullable.1');
  assert.ok(parsed.files['index.html']);
});

test('CF revision cannot be silently replaced by an unreviewed upstream update or repository reinstall', async t => {
  const env = await fixture(t);
  const cf = await installMonitorTheme(env, stream(packageConsumer(source, revised)));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 404 }); });
  await assert.rejects(installMonitorRepository(env, upstream.url, cf.short, cf.revision, cf.version), { message: 'monitorThemeConsumerRevisionRequired', code: 409 });
  assert.equal(calls, 0);
  const raw = { ...upstream, short: cf.short, version: '99.0.0' };
  await assert.rejects(installMonitorTheme(env, stream(packageConsumer(source, raw)), { repository: 'monitor-probe/monitor-theme-default' }), { message: 'monitorThemeConsumerRevisionRequired', code: 409 });
  assert.equal((await loadMonitorPackageRegistry(env.DB)).registry[cf.short], cf.revision);
  // Removing the runtime revision is the explicit choice to reinstall original upstream.
  await removeMonitorTheme(env, cf.short);
  const installed = await installMonitorTheme(env, stream(packageConsumer(source, raw)));
  assert.equal(installed.version, '99.0.0');
  await assert.rejects(installMonitorTheme(env, stream(packageConsumer(source, upstream)), { repository: 'monitor-probe/monitor-theme-default' }), { message: 'monitorThemeConsumerRevisionRequired', code: 409 });
  const explicitOriginal = await installMonitorTheme(env, stream(packageConsumer(source, upstream)));
  assert.equal(explicitOriginal.version, '1.4.3', 'explicit local upload retains original builtin installation');
});

test('new builtin revision and legacy pinned builtin retain distinct manifest/assets', async () => {
  const current = await loadMonitorRelease(null, 'builtin-default-cf-nullable-1');
  const legacy = await loadMonitorRelease(null, 'builtin-default');
  assert.equal(current.manifest.version, '1.4.3-cf.1');
  assert.equal(legacy.manifest.version, '1.4.3');
  assert.equal(legacy.manifest.cf_revision, undefined);
  const seen = [];
  const env = { ASSETS: { fetch: async request => { seen.push(new URL(request.url).pathname); return new Response('asset'); } } };
  await readMonitorThemeFile(env, 'default', 'index.html', current.revision);
  await readMonitorThemeFile(env, 'default', 'index.html', legacy.revision);
  assert.deepEqual(seen, ['/_monitor_theme/default/index.html', '/_monitor_theme/default/upstream/index.html']);
});

test('all six product archives install/select/update/delete with old pinned assets and config intact', async t => {
  const env = await fixture(t);
  const settings = { is_public: 'true', jwt_secret: 'ephemeral-consumer-package-fixture-authority-only' };
  await env.DB.prepare("INSERT INTO settings VALUES ('site_options',?)").bind(JSON.stringify(settings)).run();
  const token = await generateToken(env, settings);
  const lock = JSON.parse(fs.readFileSync('monitor-themes/consumer-revisions.json', 'utf8'));
  for (const [name, baseline] of Object.entries(lock.themes)) {
    const bytes = fs.readFileSync(`monitor-themes/${name}/release/theme.tar.gz`);
    const parsed = await parseMonitorThemeArchive(stream(bytes));
    assert.equal(parsed.manifest.version, `${baseline.version}-cf.1`);
    assert.equal(parsed.manifest.upstream.commit, baseline.commit);
    const first = await installMonitorTheme(env, stream(bytes));
    const preview = await worker.fetch(new Request(`https://consumer.test/?monitor_preview=${first.short}&monitor_revision=${first.revision}`, { headers: { Cookie: `cfsm_theme_preview_auth=${token}` } }), env);
    assert.equal(preview.status, 200, `${name} production preview route`);
    assert.match(await preview.text(), new RegExp(first.revision));
    await selectMonitorTheme(env.DB, first.short);
    await saveMonitorThemeConfig(env.DB, first.short, { cf_fixture_retained: 7 });
    assert.equal((await loadMonitorThemes(env.DB)).effective, first.short);
    const html = await (await readMonitorThemeFile(env, first.short, 'index.html', first.revision)).text();
    const asset = html.match(/src="([^"]+\.js)"/)[1].replace(/^\//, '');
    const served = Buffer.from(await (await readMonitorThemeFile(env, first.short, asset, first.revision)).arrayBuffer());
    assert.deepEqual(served, fs.readFileSync(`monitor-themes/${name}/source/dist/${asset}`));
    const repaired = Object.keys(parsed.files).find(file => file.endsWith('.js') && fs.readFileSync(`monitor-themes/${name}/source/dist/${file}`, 'utf8').includes('丢包未知'));
    assert.ok(repaired, `${name}: compiled consumer contains the repaired loss presentation`);
    assert.deepEqual(Buffer.from(await (await readMonitorThemeFile(env, first.short, repaired, first.revision)).arrayBuffer()), fs.readFileSync(`monitor-themes/${name}/source/dist/${repaired}`));
    const second = await installMonitorTheme(env, stream(bytes), { expectedShort: first.short, expectedRevision: first.revision });
    assert.notEqual(second.revision, first.revision);
    assert.equal(await (await readMonitorThemeFile(env, first.short, 'index.html', first.revision)).text(), html);
    await removeMonitorTheme(env, first.short);
    assert.equal((await loadMonitorThemes(env.DB)).effective, baseline.builtin ? first.short : 'default');
    assert.equal((await loadMonitorThemes(env.DB)).configs[first.short].cf_fixture_retained, 7);
  }
});
