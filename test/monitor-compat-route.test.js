import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';
import { handleMonitorCompat, loadMonitorCompatAccess } from '../src/handlers/monitorCompat.js';

const HOST = 'theme.example.test';
const ORIGIN = `https://${HOST}`;
const LEGACY_ORIGIN = 'https://monitor.example.test';

function request(origin, path, env, options) {
  return worker.fetch(new Request(origin + path, options), env);
}

async function settingsFixture(t) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch() { return new Response(); }}',
    d1Databases: { DB: 'monitor-compat-settings' }
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();

  return {
    db,
    env: { DB: db, MONITOR_FRONTEND_MODE: 'legacy', MONITOR_COMPAT_HOST: HOST },
    set: (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind(key, typeof value === 'string' ? value : JSON.stringify(value)).run()
  };
}

test('only the configured exact hostname enters the compatibility router', async () => {
  for (const [host, origin] of [
    [undefined, ORIGIN],
    ['', ORIGIN],
    [`https://${HOST}`, ORIGIN],
    [`${HOST}:443`, ORIGIN],
    [` ${HOST}`, ORIGIN],
    [`*.${HOST}`, ORIGIN],
    [`${HOST}.`, `${ORIGIN}.`],
    ['localhost', 'https://localhost'],
    ['127.0.0.1', 'https://127.0.0.1'],
    ['-theme.example.test', 'https://-theme.example.test'],
    [`${'a'.repeat(64)}.example.test`, `https://${'a'.repeat(64)}.example.test`],
    [HOST, LEGACY_ORIGIN],
    [HOST, `https://sub.${HOST}`],
    [HOST, `${ORIGIN}.other.test`],
    [HOST, `${ORIGIN}.`]
  ]) {
    const response = await request(origin, '/admin/?tab=nodes', { MONITOR_COMPAT_HOST: host }, {
      headers: { Host: HOST, 'X-Forwarded-Host': HOST, Forwarded: `host=${HOST}` }
    });
    assert.equal(response.status, 302, `${host} / ${origin}`);
    assert.equal(response.headers.get('Location'), `${origin}/admin#/admin?tab=nodes`);
  }

  const response = await request(`${ORIGIN}:8443`, '/admin/', {
    MONITOR_FRONTEND_MODE: 'legacy', MONITOR_COMPAT_HOST: HOST.toUpperCase()
  }, { headers: { Host: 'monitor.example.test', 'X-Forwarded-Host': 'monitor.example.test' } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `${ORIGIN}:8443/admin#/admin`);

  for (const [configured, origin] of [
    [HOST, LEGACY_ORIGIN],
    [HOST, `https://sub.${HOST}`],
    ['other.example.test', ORIGIN]
  ]) {
    const url = new URL(`${origin}/not-a-monitor-route`);
    const compat = await handleMonitorCompat(new Request(url), { MONITOR_COMPAT_HOST: configured }, url);
    assert.equal(compat, null, `${configured} / ${origin}`);
  }

  const exactUrl = new URL(`${ORIGIN}/not-a-monitor-route`);
  const exactCompat = await handleMonitorCompat(new Request(exactUrl), { MONITOR_FRONTEND_MODE: 'legacy', MONITOR_COMPAT_HOST: HOST }, exactUrl);
  assert.equal(exactCompat.status, 404);
});

test('matched host keeps agent, legacy and unknown routes isolated', async () => {
  const env = {
    MONITOR_FRONTEND_MODE: 'legacy', MONITOR_COMPAT_HOST: HOST,
    CORS_ALLOWED_ORIGINS: LEGACY_ORIGIN,
    get DB() { assert.fail('unexpected settings or agent DB read'); },
    ASSETS: null
  };
  for (const [method, path] of [
    ['GET', '/'], ['GET', '/api/agent/terminal/example'],
    ['POST', '/api/agent/register'], ['POST', '/update'], ['GET', '/update'],
    ['GET', '/api/agent/status'], ['GET', '/api/unknown'], ['POST', '/api/config'],
    ['GET', '/api/server?id=missing'], ['GET', '/api/servers'],
    ['GET', '/api/history/all?id=missing&hours=1'], ['POST', '/api/theme_options'],
    ['GET', '/updateDatabase'], ['GET', '/clearHistory'],
    ['GET', '/admin/api'], ['POST', '/admin/api/terminal/node/session/ws'], ['GET', '/admin/api/unknown'],
    ['GET', '/__do/health'], ['GET', '/dashboard.html'],
    ['GET', '/assets/example.js'], ['GET', '/unknown'], ['OPTIONS', '/unknown']
  ]) {
    const response = await request(ORIGIN, path, env, { method, headers: { Origin: LEGACY_ORIGIN } });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const write = await request(ORIGIN, '/api/me', env, { method: 'POST' });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('Allow'), 'GET');
});

test('configured Monitor host keeps the CF admin route and its existing auth boundary', async t => {
  const h = await settingsFixture(t);
  h.env.ASSETS = {
    async fetch(request) {
      return new URL(request.url).pathname === '/dashboard.html'
        ? new Response('<!doctype html><html><head></head><body>CF admin shell</body></html>', {
          headers: { 'Content-Type': 'text/html' }
        })
        : new Response('Not Found', { status: 404 });
    }
  };

  const entry = await request(ORIGIN, '/admin/?tab=nodes', h.env);
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('Location'), `${ORIGIN}/admin#/admin?tab=nodes`);

  const admin = await request(ORIGIN, '/admin', h.env);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /CF admin shell/);

  const publicConfig = await request(ORIGIN, '/api/config', h.env);
  assert.equal(publicConfig.status, 200);
  assert.equal((await publicConfig.json()).authorization, false);

  t.mock.method(globalThis, 'fetch', async () => new Response('{"themes":[]}'));
  const themeStore = await request(ORIGIN, '/theme', h.env);
  assert.equal(themeStore.status, 200);
  assert.deepEqual(await themeStore.json(), { themes: [], schema: 1 });

  for (const path of ['/updateDatabase', '/clearHistory']) {
    const protectedRoute = await request(ORIGIN, path, h.env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(protectedRoute.status, 401, `${path} retains its existing authentication`);
  }

  const adminAction = await request(ORIGIN, '/admin/api', h.env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save_settings', settings: {} })
  });
  assert.equal(adminAction.status, 401, 'existing admin authentication still gates writes');

  const terminal = await request(ORIGIN, '/admin/api/terminal/node/session/ws', h.env);
  assert.equal(terminal.status, 426, 'the existing terminal handler still validates WebSocket upgrades');
});

test('GET /api/me returns native read-only metadata with grouped settings taking precedence', async t => {
  const h = await settingsFixture(t);
  await h.set('is_public', 'false');
  await h.set('turnstile_enabled', 'true');
  await h.set('site_title', 'Legacy title');
  await h.set('site_options', { is_public: 'true', turnstile_enabled: 'false', turnstile_login_enabled: 'true' });
  await h.set('appearance_options', { site_title: '公开节点' });
  const response = await request(ORIGIN, '/api/me', h.env, {
    headers: { Cookie: 'cfsm_auth=ignored', Authorization: 'Bearer ignored' }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^application\/json\b/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    authed: false, github: false, public_page: true, site_name: '公开节点', history_days: 1
  });
  assert.equal((await h.db.prepare("SELECT value FROM settings WHERE key = 'site_options'").first()).value,
    '{"is_public":"true","turnstile_enabled":"false","turnstile_login_enabled":"true"}');
});

test('legacy settings are respected; only explicitly public unchallenged sites are advertised', async t => {
  const h = await settingsFixture(t);
  const me = async () => {
    const response = await request(ORIGIN, '/api/me', h.env, {
      headers: { Cookie: 'cfsm_auth=ignored', 'X-Turnstile-Verified': 'ignored' }
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await me()).public_page, false);
  assert.equal((await loadMonitorCompatAccess(h.db)).status, 401);
  await h.set('is_public', 'true');
  await h.set('site_title', 'Legacy title');
  assert.deepEqual(await me(), {
    authed: false, github: false, public_page: true, site_name: 'Legacy title', history_days: 1
  });
  assert.equal((await loadMonitorCompatAccess(h.db)).status, 200);
  await h.set('turnstile_enabled', 'true');
  assert.equal((await me()).public_page, false);
  assert.equal((await loadMonitorCompatAccess(h.db)).status, 403);
  await h.set('site_options', { is_public: 'true' });
  assert.equal((await me()).public_page, false, 'partial grouped settings still honor legacy Turnstile');
  await h.set('site_options', { is_public: 'false', turnstile_enabled: 'false' });
  assert.equal((await me()).public_page, false, 'grouped private setting overrides legacy public');
  assert.equal((await loadMonitorCompatAccess(h.db)).status, 401);
});

test('malformed settings or a failed D1 read never advertise the site as public', async t => {
  const h = await settingsFixture(t);
  const publicPage = async () => {
    const response = await request(ORIGIN, '/api/me', h.env);
    assert.equal(response.status, 200);
    return (await response.json()).public_page;
  };
  await h.set('is_public', 'true');
  assert.equal(await publicPage(), true);
  for (const value of ['{', '[]', { is_public: 'true', turnstile_enabled: 'unexpected' }]) {
    await h.set('site_options', value);
    assert.equal(await publicPage(), false);
    assert.equal((await loadMonitorCompatAccess(h.db)).status, 503);
  }
  await h.db.prepare('DROP TABLE settings').run();
  assert.equal(await publicPage(), false);
  assert.equal((await loadMonitorCompatAccess(h.db)).status, 503);
});
