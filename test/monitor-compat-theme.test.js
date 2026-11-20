import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const HOST = 'theme.example.test';
const ORIGIN = `https://${HOST}`;

function createAssets(files, seen = []) {
  return {
    async fetch(request) {
      seen.push({ method: request.method, url: request.url });
      const file = files[new URL(request.url).pathname];
      return file === undefined
        ? new Response('Not Found', { status: 404 })
        : new Response(file.body, { headers: file.headers });
    }
  };
}

function request(path, env, method = 'GET') {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method }), env);
}

test('opt-in default theme serves only original allowlisted bytes through the private asset namespace', async () => {
  const seen = [];
  const index = '<html><script src="/assets/app.js"></script></html>';
  const js = new Uint8Array([0, 1, 2, 255]);
  const env = {
    MONITOR_COMPAT_HOST: HOST,
    MONITOR_COMPAT_THEME: 'default',
    ASSETS: createAssets({
      '/_monitor_theme/default/index.html': { body: index, headers: { 'Content-Type': 'text/html' } },
      '/_monitor_theme/default/assets/app.js': { body: js, headers: { 'Content-Type': 'application/javascript' } },
      '/_monitor_theme/default/favicon.svg': { body: '<svg/>', headers: { 'Content-Type': 'image/svg+xml' } },
      '/_monitor_theme/default/apple-touch-icon.png': { body: 'png', headers: { 'Content-Type': 'image/png' } }
    }, seen)
  };

  const landing = await request('/', env);
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get('Content-Type'), 'text/html');
  assert.equal(await landing.text(), index, 'HTML is served unchanged');
  const asset = await request('/assets/app.js?v=7', env);
  assert.equal(asset.status, 200);
  assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), js, 'asset bytes are served unchanged');
  assert.equal(asset.headers.get('Content-Type'), 'application/javascript');
  assert.equal((await request('/favicon.svg', env)).status, 200);
  assert.equal((await request('/apple-touch-icon.png', env)).status, 200);
  assert.deepEqual(seen.map(({ url }) => new URL(url).pathname), [
    '/_monitor_theme/default/index.html',
    '/_monitor_theme/default/assets/app.js',
    '/_monitor_theme/default/favicon.svg',
    '/_monitor_theme/default/apple-touch-icon.png'
  ]);
  assert.equal(new URL(seen[1].url).search, '?v=7');
});

test('serverstatus serves its own landing and numeric node deep links; HEAD omits the body', async () => {
  const seen = [];
  const env = {
    MONITOR_COMPAT_HOST: HOST,
    MONITOR_COMPAT_THEME: 'serverstatus',
    ASSETS: createAssets({
      '/_monitor_theme/serverstatus/index.html': { body: 'serverstatus index' }
    }, seen)
  };

  for (const path of ['/', '/node/1', '/node/987654321']) {
    const response = await request(path, env);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), 'serverstatus index');
  }
  const head = await request('/node/42', env, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(seen.length, 4);
  assert.ok(seen.every(({ url }) => new URL(url).pathname === '/_monitor_theme/serverstatus/index.html'));
});

test('unknown, unsafe, missing, disabled and invalid theme routes never fall back to HTML', async () => {
  let calls = 0;
  const env = {
    MONITOR_COMPAT_HOST: HOST,
    MONITOR_COMPAT_THEME: 'default',
    ASSETS: { async fetch() { calls++; return new Response('Not Found', { status: 404 }); } }
  };

  for (const path of [
    '/api/unknown', '/admin/api/unknown', '/api/agent/register', '/__do/health',
    '/_monitor_theme/default/index.html', '/assets/missing.js', '/not-a-page',
    '/node/0', '/node/01', '/node/1/extra', '/assets/%2e%2e/index.html'
  ]) {
    const response = await request(path, env);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.headers.get('Content-Type') || '', /text\/html/i, path);
  }
  assert.equal(calls, 1, 'only the missing static resource reaches ASSETS');

  for (const method of ['POST', 'OPTIONS']) {
    assert.equal((await request('/', env, method)).status, 404);
  }
  for (const theme of ['Default', 'server-status', 'other', '']) {
    const invalid = { ...env, MONITOR_COMPAT_THEME: theme };
    assert.equal((await request('/', invalid)).status, 404, theme);
  }
  const disabled = { MONITOR_COMPAT_HOST: HOST, ASSETS: env.ASSETS };
  assert.equal((await request('/', disabled)).status, 404);
  assert.equal(calls, 1);
});

test('theme routes remain gated by the exact host and do not replace the compatibility API', async () => {
  let calls = 0;
  const env = {
    MONITOR_COMPAT_HOST: HOST,
    MONITOR_COMPAT_THEME: 'default',
    ASSETS: { async fetch() { calls++; return new Response('should not fetch'); } }
  };

  for (const origin of ['https://sub.theme.example.test', 'https://other.example.test']) {
    const response = await worker.fetch(new Request(`${origin}/admin/`), env);
    assert.equal(response.status, 302);
  }
  assert.equal((await request('/api/unknown', env)).status, 404);
  assert.equal(calls, 0);
});
