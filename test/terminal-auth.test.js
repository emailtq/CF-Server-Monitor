import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import {
  ensureTerminalSchema,
  verifyTerminalNodeToken,
  revokeTerminalNode,
  revokeTerminalAdmin,
  writeTerminalAudit
} from '../src/database/terminal.js';
import { issueTestTerminalToken } from './terminal-harness.js';
import { issueNodeToken } from '../src/database/nodeCredentials.js';
import { initDatabase } from '../src/database/schema.js';
import { updateDatabase } from '../src/database/updateDatabase.js';
import { generateToken, checkAuth, getTerminalAdminPrincipal } from '../src/middleware/auth.js';
import {
  loadSiteSettings,
  saveSiteOptions,
  clearSiteSettingsCache,
  clearAppearanceSettingsCache
} from '../src/utils/settings.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("OK"); } }',
  d1Databases: { DB: 'terminal-auth-test' }
});
after(async () => {
  clearSiteSettingsCache();
  clearAppearanceSettingsCache();
  await miniflare.dispose();
});
const db = await miniflare.getD1Database('DB');
await initDatabase(db);
const env = { DB: db, API_SECRET: 'test-reporting-secret' };
const sys = { jwt_secret: 't'.repeat(64) };

function requestWithToken(token, { cookie = false, body = null } = {}) {
  return new Request('https://example.com/admin/api', {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(cookie ? { Cookie: `cfsm_auth=${encodeURIComponent(token)}` } : { Authorization: `Bearer ${token}` }),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function signTestJwt(payload, secret = sys.jwt_secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '')}`;
}

test('terminal tables are additive in initialization and repeatable database upgrades', async () => {
  await initDatabase(db);
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'terminal_%' ORDER BY name").all();
  assert.deepEqual(tables.results.map(row => row.name), ['terminal_audit', 'terminal_auth_sessions', 'terminal_nodes']);
  await db.prepare("INSERT INTO servers (id, name) VALUES ('old-server', 'preserved')").run();
  await issueTestTerminalToken(db, 'old-server', 1000);
  const before = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'old-server'").first();
  await db.prepare('DROP TABLE terminal_audit').run();
  assert.equal((await updateDatabase(db)).success, true);
  await ensureTerminalSchema(db);
  assert.deepEqual(await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'old-server'").first(), before);
  assert.equal((await db.prepare("SELECT name FROM servers WHERE id = 'old-server'").first()).name, 'preserved');
  assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'terminal_audit_created_at'").first());
});

test('node credentials never persist plaintext and cannot authorize another node', async () => {
  await db.prepare("INSERT INTO servers (id) VALUES ('node-a'), ('node-b')").run();
  const issued = await issueTestTerminalToken(db, 'node-a', 2000);
  const secondNode = await issueTestTerminalToken(db, 'node-b', 2000);
  assert.match(issued.token, /^[a-f0-9]{64}$/);
  assert.notEqual(issued.token, secondNode.token);
  assert.deepEqual(issued.version, 1);
  const row = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'node-a'").first();
  assert.deepEqual(row, {
    server_id: 'node-a',
    token_hash: createHash('sha256').update(issued.token).digest('hex'),
    token_ciphertext: null,
    token_version: 1,
    credential_version: 1,
    enabled: 1,
    updated_at: 2000
  });
  assert.equal(JSON.stringify(row).includes(issued.token), false);
  assert.deepEqual(await verifyTerminalNodeToken(db, 'node-a', issued.token), { serverId: 'node-a', version: 1 });
  assert.equal(await verifyTerminalNodeToken(db, 'node-b', issued.token), null);
  assert.equal(await verifyTerminalNodeToken(db, 'missing-node', issued.token), null);
  for (const token of [env.API_SECRET, '', null, issued.token.toUpperCase(), 'x'.repeat(64)]) {
    assert.equal(await verifyTerminalNodeToken(db, 'node-a', token), null);
  }
});

test('rotation versions are atomic and revoked node credentials stay unusable', async () => {
  await db.prepare("INSERT INTO servers (id) VALUES ('node-rotate')").run();
  const first = await issueTestTerminalToken(db, 'node-rotate', 3000);
  const rotated = await Promise.all([issueNodeToken(db, 'node-rotate', 4000), issueNodeToken(db, 'node-rotate', 4001)]);
  assert.deepEqual(rotated.map(row => row.version).sort(), [2, 3]);
  assert.deepEqual(rotated.map(row => row.tokenVersion).sort(), [2, 3]);
  assert.equal(await verifyTerminalNodeToken(db, 'node-rotate', first.token), null);
  const latest = rotated.find(row => row.version === 3);
  assert.deepEqual(await verifyTerminalNodeToken(db, 'node-rotate', latest.token), { serverId: 'node-rotate', version: 3 });
  await revokeTerminalNode(db, 'node-rotate', 5000);
  const revoked = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'node-rotate'").first();
  await revokeTerminalNode(db, 'node-rotate', 6000);
  assert.deepEqual(await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'node-rotate'").first(), revoked);
  assert.equal(await verifyTerminalNodeToken(db, 'node-rotate', latest.token), null);
  const fresh = await issueTestTerminalToken(db, 'node-rotate', 7000);
  assert.ok(fresh.version > revoked.credential_version);
  assert.equal(await verifyTerminalNodeToken(db, 'node-rotate', latest.token), null);
  assert.ok(await verifyTerminalNodeToken(db, 'node-rotate', fresh.token));
});

test('new admin JWTs have independent random jtis and create authorization from signed expiry', async () => {
  const first = await generateToken(env, sys);
  const second = await generateToken(env, sys);
  const payload = JSON.parse(atob(first.split('.')[1]));
  const secondPayload = JSON.parse(atob(second.split('.')[1]));
  assert.match(payload.jti, /^[a-f0-9]{64}$/);
  assert.notEqual(payload.jti, secondPayload.jti);
  assert.equal(await checkAuth(requestWithToken(first), env, sys), true);
  assert.equal(await db.prepare('SELECT jti FROM terminal_auth_sessions WHERE jti = ?').bind(payload.jti).first(), null);
  assert.deepEqual(await getTerminalAdminPrincipal(requestWithToken(first, { cookie: true }), env, sys), { jti: payload.jti, exp: payload.exp });
  assert.deepEqual(await db.prepare('SELECT * FROM terminal_auth_sessions WHERE jti = ?').bind(payload.jti).first(), { jti: payload.jti, expires_at: payload.exp, revoked_at: null });
  assert.deepEqual(await getTerminalAdminPrincipal(requestWithToken(first), env, sys), { jti: payload.jti, exp: payload.exp });
});

test('terminal authorization rejects legacy, non-admin, expired and malformed JWT identities', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (const payload of [
    { sub: 'admin', exp },
    { sub: 'admin', exp, jti: '' },
    { sub: 'admin', exp, jti: 123 },
    { sub: 'agent', exp, jti: 'not-admin' },
    { sub: 'admin', exp: Math.floor(Date.now() / 1000), jti: 'expired' },
    { sub: 'admin', jti: 'no-expiry' },
    { sub: 'admin', exp: String(exp), jti: 'string-expiry' },
    { sub: 'admin', exp: exp + 0.5, jti: 'fraction-expiry' }
  ]) {
    assert.equal(await getTerminalAdminPrincipal(requestWithToken(await signTestJwt(payload)), env, sys), null);
  }
  const legacy = await signTestJwt({ sub: 'admin', exp });
  assert.equal(await checkAuth(requestWithToken(legacy), env, sys), true);
  assert.equal(await getTerminalAdminPrincipal(requestWithToken('invalid-token'), env, sys), null);
  const valid = await generateToken(env, sys);
  assert.equal(await getTerminalAdminPrincipal(new Request(`https://example.com/admin/api?token=${valid}`), env, sys), null);
});

test('terminal authentication never uses the reporting-secret fallback or a missing independent secret', async () => {
  await assert.rejects(generateToken(env, {}), /jwt_secret_missing/);
  const fallbackToken = await generateToken({}, {jwt_secret:env.API_SECRET.padEnd(32, 'x').substring(0, 64)});
  assert.equal(await checkAuth(requestWithToken(fallbackToken), env, {}), false);
  assert.equal(await getTerminalAdminPrincipal(requestWithToken(fallbackToken), env, {}), null);
  assert.equal(await getTerminalAdminPrincipal(requestWithToken(fallbackToken), env, sys), null);
  const valid = await generateToken(env, sys);
  assert.equal(await getTerminalAdminPrincipal(requestWithToken(valid), env, { jwt_secret: 'short' }), null);
});

test('revocation before and after first use is persistent and duplicate revoke is idempotent', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (const firstUse of [false, true]) {
    const jti = firstUse ? 'revoke-used' : 'revoke-unused';
    const token = await signTestJwt({ sub: 'admin', exp, jti });
    if (firstUse) assert.ok(await getTerminalAdminPrincipal(requestWithToken(token), env, sys));
    await revokeTerminalAdmin(db, jti, exp, 10000);
    await revokeTerminalAdmin(db, jti, exp + 100, 20000);
    assert.equal(await getTerminalAdminPrincipal(requestWithToken(token), env, sys), null);
    assert.deepEqual(await db.prepare('SELECT * FROM terminal_auth_sessions WHERE jti = ?').bind(jti).first(), { jti, expires_at: exp, revoked_at: 10000 });
    assert.equal(await checkAuth(requestWithToken(token), env, sys), true);
  }
});

test('an existing authorization record cannot be extended by reusing its jti in another JWT', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jti = 'same-jti-different-exp';
  assert.ok(await getTerminalAdminPrincipal(requestWithToken(await signTestJwt({ sub: 'admin', exp, jti })), env, sys));
  assert.equal(await getTerminalAdminPrincipal(requestWithToken(await signTestJwt({ sub: 'admin', exp: exp + 60, jti })), env, sys), null);
  assert.equal((await db.prepare('SELECT expires_at FROM terminal_auth_sessions WHERE jti = ?').bind(jti).first()).expires_at, exp);
});

test('terminal authority fails closed on D1 read errors without affecting ordinary monitor auth', async () => {
  const token = await generateToken(env, sys);
  const unavailable = { ...env, DB: { prepare() { throw new Error('test D1 outage'); } } };
  assert.equal(await getTerminalAdminPrincipal(requestWithToken(token), unavailable, sys), null);
  assert.equal(await checkAuth(requestWithToken(token), unavailable, sys), true);
  await assert.rejects(() => verifyTerminalNodeToken(unavailable.DB, 'node-a', 'a'.repeat(64)), /test D1 outage/);
});

test('terminal validation uses only indexed authority queries and ordinary auth adds no D1 work', async () => {
  await db.prepare("INSERT INTO servers (id) VALUES ('node-query')").run();
  const issued = await issueTestTerminalToken(db, 'node-query', 1000);
  const token = await generateToken(env, sys);
  const queries = [];
  const observedDb = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = db.prepare(sql).bind(...values);
          return {
            first() {
              queries.push(sql);
              return statement.first();
            },
            run() {
              queries.push(sql);
              return statement.run();
            }
          };
        }
      };
    }
  };
  assert.equal(await checkAuth(requestWithToken(token), { ...env, DB: observedDb }, sys), true);
  assert.equal(queries.length, 0);
  assert.deepEqual(await verifyTerminalNodeToken(observedDb, 'node-query', issued.token), { serverId: 'node-query', version: 1 });
  assert.equal(queries.length, 2, 'canonical token validation and terminal permission each read authority without schema creation');
  const nodePlan = await db.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).bind('a'.repeat(64), 'node-query', 'node-query').all();
  assert.match(nodePlan.results.map(row => row.detail).join('\n'), /SEARCH n USING INDEX terminal_nodes_token_hash_unique \(token_hash=\?\)/);
  assert.match(nodePlan.results.map(row => row.detail).join('\n'), /SEARCH s USING .*\(id=\?\)/);
  const permissionPlan = await db.prepare(`EXPLAIN QUERY PLAN ${queries[1]}`).bind('node-query').all();
  assert.match(permissionPlan.results.map(row => row.detail).join('\n'), /SEARCH terminal_nodes USING INDEX .*\(server_id=\?\)/);
  queries.length = 0;
  const principal = await getTerminalAdminPrincipal(requestWithToken(token), { ...env, DB: observedDb }, sys);
  assert.ok(principal);
  assert.equal(queries.length, 3, 'first authorization reads, inserts without replacement, then reads back');
  const adminPlan = await db.prepare(`EXPLAIN QUERY PLAN ${queries.at(-1)}`).bind(principal.jti).all();
  assert.match(adminPlan.results.map(row => row.detail).join('\n'), /SEARCH terminal_auth_sessions USING INDEX .*\(jti=\?\)/);
  queries.length = 0;
  assert.deepEqual(await getTerminalAdminPrincipal(requestWithToken(token), { ...env, DB: observedDb }, sys), principal);
  assert.equal(queries.length, 1, 'existing authorization does one read on every renewal');
  assert.match(queries[0].trim(), /^SELECT expires_at, revoked_at FROM terminal_auth_sessions WHERE jti = \?$/);
});

test('concurrent first-use authorization does not replace its signed expiry or revive a tombstone', { timeout: 30000 }, async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jti = 'concurrent-first-use';
  const token = await signTestJwt({ sub: 'admin', exp, jti });
  const results = await Promise.all([
    getTerminalAdminPrincipal(requestWithToken(token), env, sys),
    getTerminalAdminPrincipal(requestWithToken(token), env, sys)
  ]);
  assert.deepEqual(results, [{ jti, exp }, { jti, exp }]);
  const initial = await db.prepare('SELECT * FROM terminal_auth_sessions WHERE jti = ?').bind(jti).first();
  assert.deepEqual(initial, { jti, expires_at: exp, revoked_at: null });
  const extendedToken = await signTestJwt({ sub: 'admin', exp: exp + 100, jti });
  assert.equal(await getTerminalAdminPrincipal(requestWithToken(extendedToken), env, sys), null);
  assert.deepEqual(await db.prepare('SELECT * FROM terminal_auth_sessions WHERE jti = ?').bind(jti).first(), initial);

  const raceJti = 'concurrent-revocation';
  const raceToken = await signTestJwt({ sub: 'admin', exp, jti: raceJti });
  let releaseReads;
  let missingReads = 0;
  const readsReleased = new Promise(resolve => { releaseReads = resolve; });
  const racingDb = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = db.prepare(sql).bind(...values);
          return {
            async first() {
              const row = await statement.first();
              if (!row && missingReads < 2) {
                missingReads++;
                if (missingReads === 2) {
                  // Both real D1 reads observed absence; revoke before either INSERT runs.
                  await revokeTerminalAdmin(db, raceJti, exp, 0);
                  releaseReads();
                }
                await readsReleased;
              }
              return row;
            },
            run() { return statement.run(); }
          };
        }
      };
    }
  };
  const racingEnv = { ...env, DB: racingDb };
  assert.deepEqual(await Promise.all([
    getTerminalAdminPrincipal(requestWithToken(raceToken), racingEnv, sys),
    getTerminalAdminPrincipal(requestWithToken(raceToken), racingEnv, sys)
  ]), [null, null]);
  assert.equal(missingReads, 2);
  assert.deepEqual(await db.prepare('SELECT * FROM terminal_auth_sessions WHERE jti = ?').bind(raceJti).first(), { jti: raceJti, expires_at: exp, revoked_at: 0 });
  assert.equal(await getTerminalAdminPrincipal(requestWithToken(raceToken), env, sys), null);
});

test('terminal audit stores bounded lifecycle metadata and rejects data or credential fields', async () => {
  await writeTerminalAudit(db, { serverId: 'node-a', sessionId: 'session-1', actorJti: 'audit-admin', event: 'session_open', reason: null, createdAt: 8000 });
  assert.deepEqual(await db.prepare("SELECT server_id, session_id, actor_jti, event, reason, created_at FROM terminal_audit WHERE server_id = 'node-a'").first(), {
    server_id: 'node-a', session_id: 'session-1', actor_jti: 'audit-admin', event: 'session_open', reason: null, created_at: 8000
  });
  for (const extra of [{ input: 'secret input' }, { output: 'shell output' }, { token: 'secret' }, { reason: 'raw output\n' }]) {
    await assert.rejects(() => writeTerminalAudit(db, { serverId: 'node-a', event: 'session_close', createdAt: 9000, ...extra }), RangeError);
  }
});

test('terminal defaults off and ordinary setting saves cannot activate the dedicated feature', async () => {
  await saveSiteOptions(db, { jwt_secret: sys.jwt_secret });
  clearSiteSettingsCache();
  const settings = await loadSiteSettings(db, { forceRefresh: true });
  assert.equal(settings.terminal_enabled, 'false');
  const token = await generateToken(env, sys);
  const response = await handleAdminAPI(requestWithToken(token, { body: { action: 'save_settings', settings: { terminal_enabled: true } } }), env, { ...settings, password: 'test-only-hash' });
  assert.equal(response.status, 200);
  clearSiteSettingsCache();
  assert.equal((await loadSiteSettings(db, { forceRefresh: true })).terminal_enabled, 'false');
});

test('real D1 backup exports omit terminal credentials and malicious imports cannot activate them', async () => {
  await saveSiteOptions(db, { terminal_enabled: 'true' });
  clearSiteSettingsCache();
  clearAppearanceSettingsCache();
  const token = await generateToken(env, sys);
  const response = await handleAdminAPI(requestWithToken(token, { body: { action: 'export_servers' } }), env, sys);
  assert.equal(response.status, 200);
  const backup = await response.json();
  assert.equal(Object.hasOwn(backup.settings.site, 'terminal_enabled'), false);
  for (const field of ['terminal_nodes', 'terminal_auth_sessions', 'terminal_audit', 'token_hash', 'credential_version']) {
    assert.equal(Object.hasOwn(backup, field), false);
    assert.equal(JSON.stringify(backup).includes(field), false);
  }
  await saveSiteOptions(db, { terminal_enabled: 'false' });
  const imported = await handleAdminAPI(requestWithToken(token, { body: {
    action: 'import_servers',
    servers: [],
    terminal_nodes: [{ server_id: 'attacker', token_hash: 'a'.repeat(64) }],
    settings: { site: { terminal_enabled: 'true', token_hash: 'a'.repeat(64), is_public: 'false' } }
  } }), env, sys);
  assert.equal(imported.status, 200);
  clearSiteSettingsCache();
  const restored = await loadSiteSettings(db, { forceRefresh: true });
  assert.equal(restored.terminal_enabled, 'false');
  assert.equal(restored.is_public, 'false');
  assert.equal(await db.prepare("SELECT server_id FROM terminal_nodes WHERE server_id = 'attacker'").first(), null);
});
