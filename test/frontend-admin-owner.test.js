import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('optional admin ownership isolates delayed transport effects without changing default/current/terminal callers', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch, document: globalThis.document };
  try {
    const api = await vite.ssrLoadModule('/src/frontend/utils/api.js');
    const { http } = await vite.ssrLoadModule('/src/frontend/utils/http.js');
    const { fetchAllTurnstileConfigs, fetchTurnstileConfigByIndex } = await vite.ssrLoadModule('/src/frontend/utils/turnstile.js');
    const { useTurnstile } = await vite.ssrLoadModule('/src/frontend/views/admin/composables/useTurnstile.js');
    const store = new Map(); const redirects = []; const callbacks = [];
    globalThis.localStorage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
    globalThis.window = { location: { origin: 'https://fixture.test', pathname: '/admin', reload: () => redirects.push('reload'), assign: url => redirects.push(url) }, turnstile: { render: (_selector, options) => { callbacks.push(options); return 'fixture-widget'; }, remove() {}, reset() {} } };
    globalThis.document = { querySelector: () => ({ innerHTML: '' }) };
    let generation = 0;
    const owner = () => { const at = generation; return () => generation === at; };
    const seed = () => { store.set('jwt_token', 'current-jwt'); store.set('turnstile_token', 'current-turnstile'); store.set('turnstile_verified', 'current-verified'); redirects.length = 0; };
    for (const status of [401, 403]) {
      seed(); let release;
      globalThis.fetch = () => new Promise(resolve => { release = () => resolve(Response.json({ error: 'old-auth' }, { status })); });
      const pending = api.adminApi({ action: 'list' }, 0, owner()); generation += 2; release();
      const stale = await pending;
      assert.equal(stale.stale, true); assert.equal(store.get('jwt_token'), 'current-jwt'); assert.equal(store.get('turnstile_token'), 'current-turnstile'); assert.deepEqual(redirects, []);
      globalThis.fetch = async () => Response.json({}, { status });
      await api.adminApi({ action: 'list' }, 0, owner());
      assert.deepEqual(redirects, ['reload']); assert.equal(store.has(status === 401 ? 'jwt_token' : 'turnstile_token'), false);
      seed(); await http.post('/admin/api', {}); assert.deepEqual(redirects, ['reload'], 'ownerless legacy behavior stays authoritative');
      seed(); await http.post('/admin/api', {}, { responsePolicy: 'terminal' }); assert.deepEqual(redirects, []); assert.equal(store.get('jwt_token'), 'current-jwt');
    }
    for (const operation of ['login', 'config', 'database', 'history', 'theme']) {
      seed(); api.VERSION.value = 'current-version'; api.LAST_AGENT_VERSION.value = 'current-agent'; let release;
      globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { release = () => resolve({ token: 'old-token', turnstile_verified: 'old-verified', version: 'old-version', last_agent_version: 'old-agent', success: true }); }) });
      const requestOwner = owner();
      const pending = operation === 'login' ? api.login('fixture', 'fixture-pass', '', 0, requestOwner) : operation === 'config' ? api.fetchConfig(0, requestOwner) : operation === 'database' ? api.upgradeDatabase(0, requestOwner) : operation === 'history' ? api.clearHistory(0, requestOwner) : http.getByIndex('/theme', 0, { requestOwner });
      while (!release) await new Promise(resolve => setImmediate(resolve));
      generation++; release(); const stale = await pending;
      assert.equal(stale.stale, true, operation); assert.equal(store.get('jwt_token'), 'current-jwt'); assert.equal(store.get('turnstile_verified'), 'current-verified'); assert.equal(store.get('turnstile_token'), 'current-turnstile'); assert.equal(api.VERSION.value, 'current-version'); assert.equal(api.LAST_AGENT_VERSION.value, 'current-agent');
    }
    seed(); globalThis.fetch = async () => Response.json({ token: 'new-token', turnstile_verified: 'new-verified', version: 'new-version' });
    await api.login('fixture', 'fixture-pass', '', 0, owner()); assert.equal(store.get('jwt_token'), 'new-token'); assert.equal(store.get('turnstile_verified'), 'new-verified');
    await api.fetchConfig(0, owner()); assert.equal(api.VERSION.value, 'new-version');
    seed(); await api.login('fixture', 'fixture-pass'); assert.equal(store.get('jwt_token'), 'new-token');
    assert.equal((await api.fetchConfig()).version, 'new-version');
    globalThis.fetch = async () => Response.json({ success: true });
    assert.equal((await api.upgradeDatabase()).success, true); assert.equal((await api.clearHistory()).success, true);
    for (const status of [401, 403]) {
      globalThis.fetch = async () => Response.json({ error: 'current-auth' }, { status });
      for (const operation of [api.upgradeDatabase, api.clearHistory]) {
        seed(); assert.equal((await operation(0, owner())).success, false);
        assert.equal(store.has(status === 401 ? 'jwt_token' : 'turnstile_token'), false);
        assert.deepEqual(redirects, [], 'database helpers keep their existing autoRedirect=false policy');
      }
    }
    seed(); let configRequests = 0;
    globalThis.fetch = async () => { configRequests++; return Response.json({ turnstile_login_enabled: true, turnstile_site_key: 'compatible-key' }); };
    assert.equal((await fetchTurnstileConfigByIndex()).data.turnstile_site_key, 'compatible-key');
    assert.equal((await fetchAllTurnstileConfigs())[0].data.turnstile_site_key, 'compatible-key');
    assert.equal(configRequests, 2, 'public all-site and ownerless indexed config remain compatible');
    const compatibleTurnstile = useTurnstile(); await compatibleTurnstile.loadTurnstileConfig(0, false);
    assert.equal(compatibleTurnstile.turnstileSiteKey.value, 'compatible-key');
    compatibleTurnstile.renderTurnstile('#fixture', 'compatible-key'); callbacks.at(-1).callback('compatible-token');
    assert.equal(store.get('turnstile_token'), 'compatible-token');
    seed(); const turnstile = useTurnstile(); let release;
    globalThis.fetch = () => new Promise(resolve => { release = () => resolve(Response.json({ turnstile_login_enabled: true, turnstile_site_key: 'old-key' })); });
    const pending = turnstile.loadTurnstileConfig(0, false, null, owner()); generation++; release(); await pending;
    assert.equal(turnstile.turnstileSiteKey.value, '');
    const requestOwner = owner(); turnstile.renderTurnstile('#fixture', 'fixture-key', { requestOwner }); generation++;
    callbacks.at(-1).callback('old-widget-token'); assert.equal(store.get('turnstile_token'), 'current-turnstile');
    callbacks.at(-1).errorCallback(); callbacks.at(-1).expiredCallback(); assert.equal(store.get('turnstile_token'), 'current-turnstile');
    turnstile.renderTurnstile('#fixture', 'fixture-key', { requestOwner: owner() }); callbacks.at(-1).callback('new-widget-token'); assert.equal(store.get('turnstile_token'), 'new-widget-token');
  } finally { Object.assign(globalThis, saved); await vite.close(); }
});
