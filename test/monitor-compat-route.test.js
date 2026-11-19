import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';
import { loadMonitorCompatAccess } from '../src/handlers/monitorCompat.js';

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
    env: { DB: db, MONITOR_COMPAT_HOST: HOST },
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
    MONITOR_COMPAT_HOST: HOST.toUpperCase()
  }, { headers: { Host: 'monitor.example.test', 'X-Forwarded-Host': 'monitor.example.test' } });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Location'), null);
});

test('matched host never dispatches admin, agent, legacy API, assets or unknown routes', async () => {
  const env = {
    MONITOR_COMPAT_HOST: HOST,
    CORS_ALLOWED_ORIGINS: LEGACY_ORIGIN,
    get DB() { assert.fail('unexpected settings or agent DB read'); },
    get ASSETS() { assert.fail('unexpected asset fallback'); }
  };
  for (const [method, path] of [
    ['GET', '/'], ['GET', '/admin/'], ['POST', '/admin/api'],
    ['GET', '/admin/api/terminal/example'], ['GET', '/api/agent/terminal/example'],
    ['POST', '/api/agent/register'], ['POST', '/update'], ['GET', '/update'],
    ['GET', '/api/config'], ['GET', '/__do/health'], ['GET', '/dashboard.html'],
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
