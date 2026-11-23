import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { handleMonitorCompat } from '../src/handlers/monitorCompat.js';
import { generateToken } from '../src/middleware/auth.js';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';

const ORIGIN = 'https://theme.example.test';
test('existing theme page mounts a separate Monitor manager with owned requests and schema-only settings', () => {
  const page = readFileSync('src/frontend/views/admin/index.vue', 'utf8');
  assert.match(page, /<MonitorThemeManager/);
  assert.ok(page.indexOf('<MonitorThemeManager') < page.indexOf('<SettingsPanel'), 'new theme actions are visible before the long legacy appearance form');
  const source = readFileSync('src/frontend/views/admin/components/MonitorThemeManager.vue', 'utf8');
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: 'monitor-manager' });
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'MonitorThemeManager.vue', id: 'monitor-manager', compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
  assert.match(source, /result.stale/);
  assert.match(source, /monitorConfigForm/);
  assert.match(source, /monitorConfigOverrides/);
  assert.match(source, /uploadMonitorTheme/);
  assert.match(source, /type="file"/);
  assert.match(source, /field.type === 'select'/);
  assert.match(source, /monitorThemeTrust/);
  assert.match(source, /theme\?\.builtin && short === 'default'/, 'builtin label follows admin locale, external manifests keep their own names');
  assert.match(source, /AdminDialog/);
});

test('native install input is visible on the theme page and submits bare repository links without browser URL validation', () => {
  const { descriptor } = parse(readFileSync('src/frontend/views/admin/components/MonitorThemeManager.vue', 'utf8'));
  const form = descriptor.template.ast.children[0].children.find(node => node.tag === 'template')?.children.find(node => node.tag === 'div' && node.props.some(prop => prop.name === 'class' && prop.value?.content === 'monitor-install-card'))?.children.find(node => node.tag === 'form');
  assert.ok(form, 'install form lives inline before the theme list, not inside AdminDialog');
  const input = form.children.find(node => node.tag === 'input' && node.props.some(prop => prop.name === 'id' && prop.value?.content === 'monitor-theme-repository'));
  assert.ok(input);
  for (const [name, value] of [['type', 'text'], ['inputmode', 'url'], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) {
    assert.ok(input.props.some(prop => prop.name === name && prop.value?.content === value), name);
  }
  assert.ok(form.props.some(prop => prop.name === 'on' && prop.arg?.content === 'submit' && prop.modifiers.some(mod => mod.content === 'prevent')));
});

test('theme management uses native current/builtin badges, metadata, icon actions and non-blocking toast', () => {
  const source=readFileSync('src/frontend/views/admin/components/MonitorThemeManager.vue','utf8');
  for (const name of ['monitorThemeUse','monitorThemeUsing','monitorThemeCurrent','monitorThemeBuiltin','theme.author','theme.url','monitorThemeSource','monitorThemeThumbnail','AdminToast']) assert.ok(source.includes(name),name);
  assert.match(source,/state.effective === theme.short/, 'effective default is visibly in use even without a saved selection');
  assert.match(source,/name="sliders-horizontal"/);
  assert.match(source,/name="refresh-cw"/);
  assert.doesNotMatch(source,/emit\('alert-message'/);
  assert.match(source,/reader.readAsDataURL/, 'thumbnail rendering uses the data: source already allowed by CF CSP');
  assert.doesNotMatch(source,/URL.createObjectURL/);
  assert.match(source,/v-if="theme.preview"/, 'native thumbnails reserve their layout from catalog metadata before image bytes arrive');
});
async function fixture(t) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch() {return new Response();}}', d1Databases: { DB: 'theme-management' } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  const sys = { jwt_secret: 'local-fixture-secret-not-a-real-credential', is_public: 'true' };
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').bind(key, JSON.stringify(value)).run();
  await set('site_options', sys);
  const env = { DB: db, MONITOR_FRONTEND_MODE: 'legacy', MONITOR_COMPAT_HOST: 'theme.example.test', ASSETS: { fetch: async req => {
    const p = new URL(req.url).pathname;
    return /\/(index.html|assets\/app.js)$/.test(p) ? new Response(p, { headers: { 'Content-Type': p.endsWith('.js') ? 'application/javascript' : 'text/html' } }) : new Response('Not Found', { status: 404 });
  } } };
  const token = await generateToken(env, sys);
  const admin = (data, authorized = true) => handleAdminAPI(new Request(`${ORIGIN}/admin/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) }), env, sys);
  const route = (path, headers = {}, origin = ORIGIN) => { const req = new Request(origin + path, { headers }); return handleMonitorCompat(req, env, new URL(req.url)); };
  return { env, db, set, sys, token, admin, route };
}

test('admin selects saved theme above deployment and Default fallback, without touching legacy settings', async t => {
  const h = await fixture(t);
  assert.match(await (await h.route('/')).text(), /default\/index.html/);
  h.env.MONITOR_COMPAT_THEME = 'serverstatus';
  assert.match(await (await h.route('/')).text(), /serverstatus\/index.html/);
  const list = await h.admin({ action: 'get_monitor_themes' });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.selected, null);
  assert.equal(body.effective, 'serverstatus');
  assert.deepEqual(body.themes.map(theme => [theme.short, theme.version]), [['default', '1.4.3'], ['serverstatus', '1.5.1']]);
  assert.equal((await h.admin({ action: 'select_monitor_theme', theme: 'default' })).status, 200);
  assert.match(await (await h.route('/')).text(), /default\/index.html/);
  assert.equal((await h.admin({ action: 'select_monitor_theme', theme: null })).status, 200);
  assert.match(await (await h.route('/')).text(), /serverstatus\/index.html/);
  assert.deepEqual(JSON.parse((await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first()).value), h.sys);
});

test('Default public overrides, reset and independent theme configuration are authoritative and validated', async t => {
  const h = await fixture(t);
  const config = async () => { const res = await h.route('/api/themes/default/config'); assert.equal(res.headers.get('Cache-Control'), 'no-store'); return res.json(); };
  assert.deepEqual(await config(), {});
  assert.equal((await h.admin({ action: 'save_monitor_theme_config', theme: 'default', config: { show_summary: false } })).status, 200);
  assert.deepEqual(await config(), { show_summary: false });
  assert.equal((await h.admin({ action: 'save_monitor_theme_config', theme: 'default', config: { show_summary: true } })).status, 200);
  assert.deepEqual(await config(), {}, 'manifest defaults are stored only as absent overrides');
  await h.admin({ action: 'save_monitor_theme_config', theme: 'default', config: { show_summary: false } });
  assert.equal((await h.admin({ action: 'save_monitor_theme_config', theme: 'serverstatus', config: {} })).status, 200);
  assert.deepEqual(await config(), { show_summary: false });
  assert.equal((await h.admin({ action: 'save_monitor_theme_config', theme: 'default', config: {} })).status, 200);
  assert.deepEqual(await config(), {});
  for (const data of [
    { action: 'select_monitor_theme', theme: '../default' },
    { action: 'select_monitor_theme', theme: '' },
    { action: 'save_monitor_theme_config', theme: 'default', config: { show_summary: 'false' } },
    { action: 'save_monitor_theme_config', theme: 'default', config: { secret: true } },
    { action: 'save_monitor_theme_config', theme: 'serverstatus', config: { show_summary: false } },
    { action: 'save_monitor_theme_config', theme: 'default', config: [] }
  ]) assert.equal((await h.admin(data)).status, 400, JSON.stringify(data));
  assert.deepEqual(await config(), {});
  await h.set('monitor_theme_config:default', { show_summary: 'false' });
  assert.equal((await h.route('/api/themes/default/config')).status, 503);
  assert.equal((await h.admin({ action: 'get_monitor_themes' })).status, 503);
  assert.equal((await h.admin({ action: 'save_monitor_theme_config', theme: 'default', config: {} })).status, 503, 'corrupt authority is not silently discarded');
});

test('authenticated previews keep original asset bytes and public selection isolated on an unmatched host', async t => {
  const h = await fixture(t);
  delete h.env.MONITOR_COMPAT_HOST;
  const origin = 'https://legacy.example.test';
  assert.equal(await h.route('/', {}, origin), null);
  for (const theme of ['default', 'serverstatus']) {
    const preview = await h.admin({ action: 'start_monitor_theme_preview', theme });
    assert.equal(preview.status, 200);
    const url = new URL((await preview.json()).preview_url);
    assert.equal(url.searchParams.get('monitor_preview'), theme);
    assert.equal(url.searchParams.has('token'), false);
    const auth = preview.headers.get('Set-Cookie');
    assert.match(auth, /HttpOnly/);
    const headers = { Cookie: `cfsm_theme_preview_auth=${encodeURIComponent(h.token)}; cfsm_monitor_preview=${theme}` };
    const query = `/?monitor_preview=${theme}`;
    assert.match(await (await h.route(query, headers, origin)).text(), new RegExp(`${theme}/index.html`));
    const redirect = await h.route('/assets/app.js', { ...headers, Referer: origin + query }, origin);
    assert.equal(redirect.status, 307, 'preview module URL retains context for nested imports');
    const assetUrl = new URL(redirect.headers.get('Location'));
    assert.equal(assetUrl.searchParams.get('monitor_preview'), theme);
    const asset = await h.route(assetUrl.pathname + assetUrl.search, headers, origin);
    assert.equal(await asset.text(), `/_monitor_theme/${theme}/assets/app.js`);
    assert.equal(asset.headers.get('Cache-Control'), 'no-store');
    const nested = await h.route('/assets/app.js', { ...headers, Referer: assetUrl.toString() }, origin);
    assert.equal(nested.status, 307, 'module referrer, not just the document, carries authenticated preview');
    assert.equal((await h.route('/api/themes/default/config', { ...headers, Referer: origin + query }, origin)).status, 200);
    assert.equal(await h.route('/', headers, origin), null, 'preview cookie does not select normal homepage');
    assert.equal(await h.route('/api/me', headers, origin), null, 'cookie alone does not open Monitor protocol');
    assert.equal((await h.admin({ action: 'get_monitor_themes' }).then(r => r.json())).selected, null);
    assert.equal((await h.route(query, {}, origin)).status, 401);
    assert.equal(await h.route('/api/me', { ...headers, Referer: `https://attacker.test/${query}` }, origin), null);
  }
  for (const action of ['get_monitor_themes', 'select_monitor_theme', 'save_monitor_theme_config', 'start_monitor_theme_preview']) {
    assert.equal((await h.admin({ action, theme: 'default', config: {} }, false)).status, 401);
  }
  await h.set('site_options', { ...h.sys, is_public: 'false' });
  assert.equal((await h.admin({ action: 'start_monitor_theme_preview', theme: 'default' })).status, 409);
  await h.set('site_options', { ...h.sys, turnstile_enabled: 'true' });
  assert.equal((await h.admin({ action: 'start_monitor_theme_preview', theme: 'default' })).status, 409);
});

test('settings backup round-trips Monitor state without deployment bindings and rejects invalid input before writes', async t => {
  const h = await fixture(t);
  await h.db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, sort_order INTEGER)').run();
  await h.admin({ action: 'select_monitor_theme', theme: 'serverstatus' });
  await h.admin({ action: 'save_monitor_theme_config', theme: 'default', config: { show_summary: false } });
  const exported = await h.admin({ action: 'export_servers' }).then(res => res.json());
  assert.deepEqual(exported.settings.monitor_theme, { selected: 'serverstatus', configs: { default: { show_summary: false }, serverstatus: {} } });
  await h.admin({ action: 'select_monitor_theme', theme: 'default' });
  assert.equal((await h.admin({ action: 'import_servers', settings: { monitor_theme: exported.settings.monitor_theme } })).status, 200);
  assert.equal((await h.admin({ action: 'get_monitor_themes' }).then(res => res.json())).selected, 'serverstatus');
  assert.equal((await h.admin({ action: 'import_servers', settings: { monitor_theme: { selected: 'unknown', configs: {} }, site: { is_public: 'false' } } })).status, 400);
  assert.equal(JSON.parse((await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first()).value).is_public, 'true');
  assert.equal((await h.admin({ action: 'import_servers', settings: { monitor_theme: { selected: 'default', configs: { default: { show_summary: true }, serverstatus: {} } } } })).status, 200);
  assert.deepEqual((await h.admin({ action: 'get_monitor_themes' }).then(res => res.json())).configs.default, {}, 'import also stores only overrides');
});

test('invalid deployment and corrupt selection fail without mutation; private config and lost D1 stay closed', async t => {
  const h = await fixture(t);
  h.env.MONITOR_COMPAT_THEME = 'invalid';
  assert.equal((await h.route('/')).status, 503);
  assert.equal((await h.admin({ action: 'select_monitor_theme', theme: 'serverstatus' })).status, 503);
  assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='monitor_theme_selection'").first(), null);
  delete h.env.MONITOR_COMPAT_THEME;
  await h.set('monitor_theme_selection', 1);
  assert.equal((await h.route('/')).status, 503);
  await h.db.prepare("UPDATE settings SET value=NULL WHERE key='monitor_theme_selection'").run();
  assert.equal((await h.route('/')).status, 503, 'SQL NULL is corrupt state, not an explicitly saved JSON null');
  await h.set('monitor_theme_selection', null);
  await h.set('site_options', { ...h.sys, is_public: 'false' });
  assert.equal((await h.route('/api/themes/default/config')).status, 401);
  await h.set('site_options', { ...h.sys, turnstile_enabled: 'true' });
  assert.equal((await h.route('/api/themes/default/config')).status, 403);
  await h.db.prepare('DROP TABLE settings').run();
  assert.equal((await h.route('/')).status, 503);
  assert.equal((await h.route('/?monitor_preview=default', { Cookie: `cfsm_theme_preview_auth=${h.token}` })).status, 503);
});

test('preview session bootstrap requires Bearer login just like the existing CF preview contract', async t => {
  const h = await fixture(t);
  const res = await handleAdminAPI(new Request(`${ORIGIN}/admin/api`, { method: 'POST', headers: { Cookie: `cfsm_auth=${h.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start_monitor_theme_preview', theme: 'default' }) }), h.env, h.sys);
  assert.equal(res.status, 401);
});

test('preview WebSocket authenticates context and forwards no browser credentials to the public broadcaster', async t => {
  const h = await fixture(t);
  delete h.env.MONITOR_COMPAT_HOST;
  const path = '/api/ws?monitor_preview=default';
  const headers = { Cookie: `cfsm_theme_preview_auth=${h.token}`, Origin: ORIGIN, Upgrade: 'websocket' };
  assert.equal((await h.route(path, { Origin: ORIGIN, Upgrade: 'websocket' })).status, 401);
  assert.equal((await h.route(path, { ...headers, Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await h.route(path, { Cookie: headers.Cookie, Origin: ORIGIN })).status, 426);
  let forwarded;
  h.env.METRICS_BROADCASTER = {
    idFromName: name => name,
    get: name => { assert.equal(name, 'global'); return { fetch: (url, options) => { forwarded = { url, options }; return new Response('fixture socket'); } }; }
  };
  assert.equal((await h.route(path, headers)).status, 200);
  assert.equal(forwarded.url, 'https://metrics.internal/monitor-compat-live');
  assert.deepEqual(forwarded.options.headers, { Upgrade: 'websocket' });
});
