import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './terminal-harness.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { readNodeToken, verifyNodeToken } from '../src/database/nodeCredentials.js';
import { handleAgentRegistration, handlePrepareRegistration } from '../src/handlers/agentRegistration.js';

async function setup() {
  const h = await harness();
  await saveSiteOptions(h.db, {auto_discovery:'true'});
  await h.db.prepare("UPDATE servers SET history_partition_id=CASE id WHEN 'node-a' THEN 1 ELSE 2 END").run();
  return h;
}
async function prepare(h) {
  const response = await h.action('node_prepare_registration');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const issued = await response.json();
  assert.deepEqual(Object.keys(issued).sort(), ['expiresAt', 'key']);
  assert.match(issued.key, /^[a-f0-9]{64}$/);
  assert.ok(Math.abs(issued.expiresAt - Date.now() - 900000) < 5000);
  return issued;
}
const register = (h, key, body = {name:'web-01'}, headers = {}) => h.fetch('/api/agent/register', {
  method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${key}`, ...headers}, body:JSON.stringify(body)
});

test('registration creates independent canonical tokens, never reuses a same-name existing node', async () => {
  const h = await setup();
  try {
    const original = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    const {key} = await prepare(h);
    const results = [];
    for (let i = 0; i < 2; i++) {
      const response = await register(h, key, {name:'node-a'});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const result = await response.json();
      assert.deepEqual(Object.keys(result).sort(), ['serverId', 'token']);
      assert.notEqual(result.serverId, 'node-a');
      assert.match(result.token, /^[a-f0-9]{64}$/);
      assert.notEqual(result.token, h.nodes['node-a'].token);
      assert.equal((await verifyNodeToken(h.db, result.token)).serverId, result.serverId);
      const stored = await readNodeToken(h.db, result.serverId, 's'.repeat(64));
      assert.equal(stored.token, result.token);
      assert.equal(stored.enabled, false);
      assert.equal(stored.tokenVersion, 1);
      assert.equal(stored.version, 1);
      results.push(result);
    }
    assert.notEqual(results[0].serverId, results[1].serverId);
    assert.notEqual(results[0].token, results[1].token);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), original);
    const nodes = (await h.db.prepare('SELECT * FROM servers ORDER BY history_partition_id').all()).results;
    assert.deepEqual(nodes.map(node => node.history_partition_id), [1, 2, 3, 4]);
    assert.equal(nodes[2].name, 'node-a');
    assert.equal(nodes[2].server_group, 'Default');
  } finally { await h.dispose(); }
});

test('key issuance needs HTTPS exact Origin and a non-revoked administrator principal', async () => {
  const h = await setup();
  try {
    assert.equal((await h.fetch('/admin/api', {method:'POST', body:JSON.stringify({action:'node_prepare_registration'})})).status, 401);
    for (const Origin of ['', 'https://evil.example', 'https://example.com/', 'http://example.com']) {
      const response = await h.action('node_prepare_registration', {}, {headers:{Origin}});
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    const exp = Math.floor(Date.now() / 1000) + 3600;
    for (const principal of [{sub:'agent', exp, jti:'not-admin'}, {sub:'admin', exp}, {sub:'admin', exp:1, jti:'expired'}, {sub:'admin', exp:String(exp), jti:'invalid-expiry'}]) {
      const header = h.token.split('.')[0];
      const payload = Buffer.from(JSON.stringify(principal)).toString('base64').replace(/=/g, '');
      const signature = createHmac('sha256', 's'.repeat(64)).update(`${header}.${payload}`).digest('base64').replace(/=/g, '');
      assert.equal((await h.action('node_prepare_registration', {}, {headers:{Cookie:`cfsm_auth=${header}.${payload}.${signature}`}})).status, 401);
    }
    await prepare(h);
    await h.action('logout');
    assert.equal((await h.action('node_prepare_registration')).status, 401);
  } finally { await h.dispose(); }
});

test('only an enabled site and the current unexpired key can register', async () => {
  const h = await setup();
  try {
    const first = await prepare(h);
    const second = await prepare(h);
    for (const key of [first.key, '0'.repeat(64), 'test-report-secret', '', second.key.toUpperCase(), second.key + ' extra']) {
      assert.equal((await register(h, key)).status, 401);
    }
    await h.db.prepare('UPDATE agent_registration_keys SET expires_at=?').bind(Date.now() - 1).run();
    assert.equal((await register(h, second.key)).status, 401);
    const third = await prepare(h);
    await saveSiteOptions(h.db, {auto_discovery:'false'});
    assert.equal((await h.action('node_prepare_registration')).status, 403);
    assert.equal((await register(h, third.key)).status, 403);
    await saveSiteOptions(h.db, {auto_discovery:'true'});
    assert.equal((await register(h, third.key)).status, 401);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, 2);
  } finally { await h.dispose(); }
});

test('registration bounds JSON bytes and types, denies caller identity/credentials and plaintext transport', async () => {
  const h = await setup();
  try {
    const {key} = await prepare(h);
    for (const body of [null, [], 'string', 1, {name:123}, {name:[]}, {name:'a'.repeat(101)}, {serverId:'node-a'}, {id:'node-a'}, {hostname:'node-a'}, {sourceIP:'198.51.100.7'}, {requestId:'node-a'}, {secret:'test-report-secret'}, {token:key}, {terminal_enabled:true}]) {
      assert.equal((await register(h, key, body)).status, 400, JSON.stringify(body));
    }
    const raw = (body, headers = {}, path = '/api/agent/register') => h.fetch(path, {method:'POST', headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json', ...headers}, body});
    assert.equal((await raw('{')).status, 400);
    assert.equal((await raw('{}', {'Content-Type':'text/plain'})).status, 415);
    // Undici rejects forged Content-Length before the Worker; exercise the real handler with real D1.
    const declared = (body, length) => handleAgentRegistration(new Request('https://example.com/api/agent/register', {
      method:'POST', headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json', 'Content-Length':length}, body
    }), {DB:h.db});
    assert.equal((await declared('{}', '4097')).status, 413);
    assert.equal((await declared('{}', 'bogus')).status, 400);
    assert.equal((await declared('{}', '3')).status, 400);
    assert.equal((await declared(' '.repeat(4097), '2')).status, 413);
    assert.equal((await raw(JSON.stringify({name:'\u00e9'.repeat(2100)}))).status, 413);
    assert.equal((await raw(new Uint8Array([0xff]))).status, 400);
    assert.equal((await raw('{}', {}, '/api/agent/register?key=' + key)).status, 401);
    assert.equal((await h.fetch('/api/agent/register')).status, 405);
    assert.equal((await h.fetch('/api/agent/register', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{"secret":"test-report-secret","name":"old"}'})).status, 401);
    const plain = await h.mf.dispatchFetch('http://localhost/api/agent/register', {method:'POST', headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:'{}'});
    assert.equal(plain.status, 403);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, 2);
    assert.equal((await h.db.prepare('SELECT registration_count FROM agent_registration_keys').first()).registration_count, 0);
    const bounded = '{"name":"bounded"}';
    assert.equal((await raw(bounded.padEnd(4096, ' '))).status, 200);
  } finally { await h.dispose(); }
});

test('a key grants only fresh registration, not reports, terminal admission, admin reads, or public leaks', async () => {
  const h = await setup();
  try {
    const {key} = await prepare(h);
    const stored = await h.db.prepare('SELECT * FROM agent_registration_keys').first();
    assert.ok(!JSON.stringify(stored).includes(key));
    assert.match(stored.key_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(stored.key_hash, key);
    const agentHeaders = {Authorization:`Bearer ${key}`};
    assert.equal((await h.fetch('/update', {method:'POST', headers:{...agentHeaders, 'Content-Type':'application/json'}, body:JSON.stringify({id:'node-a', metrics:{cpu:'1'}})})).status, 401);
    assert.equal((await h.socket('/update', agentHeaders)).response.status, 401);
    assert.equal((await h.socket('/api/agent/terminal/control', {...agentHeaders, 'X-CFSM-Server-Id':'node-a'})).response.status, 401);
    assert.equal((await h.fetch('/admin/api', {method:'POST', headers:agentHeaders, body:JSON.stringify({action:'node_read_install', serverId:'node-a'})})).status, 401);
    await saveSiteOptions(h.db, {is_public:'true'});
    for (const response of [await h.action('get_settings'), await h.action('list'), await h.action('export_servers'), await h.fetch('/api/config'), await h.fetch('/api/servers')]) {
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(key));
      assert.ok(!text.includes(stored.key_hash));
      assert.ok(!text.includes('agent_registration_keys'));
    }
    const success = await register(h, key, {}, {'CF-Connecting-IP':'198.51.100.7'});
    assert.equal(success.status, 200);
    const node = await success.json();
    assert.equal((await h.db.prepare('SELECT name FROM servers WHERE id=?').bind(node.serverId).first()).name, '198.51.100.7');
    assert.equal((await h.fetch('/update', {method:'POST', headers:{Authorization:`Bearer ${node.token}`, 'Content-Type':'application/json'}, body:JSON.stringify({id:node.serverId, metrics:{cpu:'1', timestamp:Date.now()}})})).status, 200);
    assert.equal((await h.socket('/api/agent/terminal/control', {Authorization:`Bearer ${node.token}`, 'X-CFSM-Server-Id':node.serverId})).response.status, 401);
  } finally { await h.dispose(); }
});

test('concurrent registrations cannot exceed 100, including competing for the last slot', async () => {
  const h = await setup();
  try {
    const {key} = await prepare(h);
    // Consume each response immediately, not after every concurrent request finishes.
    const consume = async key => {
      const response = await register(h, key);
      return {status:response.status, body:await response.json()};
    };
    const responses = await Promise.all(Array.from({length:105}, () => consume(key)));
    assert.equal(responses.filter(response => response.status === 200).length, 100);
    assert.equal(responses.filter(response => response.status === 409).length, 5);
    const issued = responses.filter(response => response.status === 200).map(response => response.body);
    assert.equal(new Set(issued.map(node => node.token)).size, 100);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, 102);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM terminal_nodes').first()).count, 102);
    assert.equal((await h.db.prepare('SELECT COUNT(DISTINCT history_partition_id) AS count FROM servers').first()).count, 102);
    assert.equal((await h.db.prepare('SELECT registration_count FROM agent_registration_keys').first()).registration_count, 100);
    const next = await prepare(h);
    await h.db.prepare('UPDATE agent_registration_keys SET registration_count=99').run();
    const last = await Promise.all(Array.from({length:12}, () => consume(next.key)));
    assert.equal(last.filter(response => response.status === 200).length, 1);
    assert.equal(last.filter(response => response.status === 409).length, 11);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, 103);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM terminal_nodes').first()).count, 103);
  } finally { await h.dispose(); }
});

test('credential failures and authority changes inside D1 batch roll back nodes and consumed slots', async () => {
  const h = await setup();
  try {
    const {key} = await prepare(h);
    const before = async () => ({
      servers:(await h.db.prepare('SELECT * FROM servers ORDER BY id').all()).results,
      credentials:(await h.db.prepare('SELECT * FROM terminal_nodes ORDER BY server_id').all()).results,
      key:await h.db.prepare('SELECT * FROM agent_registration_keys').first(),
      settings:await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first()
    });
    const original = await before();
    const mutations = [
      ["CREATE TRIGGER fail_node BEFORE INSERT ON servers BEGIN SELECT RAISE(ABORT, 'test node failure'); END", 'fail_node'],
      ["CREATE TRIGGER fail_credential BEFORE INSERT ON terminal_nodes BEGIN SELECT RAISE(ABORT, 'test credential failure'); END", 'fail_credential'],
      ["CREATE TRIGGER expire_key AFTER UPDATE OF registration_count ON agent_registration_keys BEGIN UPDATE agent_registration_keys SET expires_at=1; END", 'expire_key'],
      ["CREATE TRIGGER replace_key AFTER UPDATE OF registration_count ON agent_registration_keys BEGIN UPDATE agent_registration_keys SET key_hash='replacement'; END", 'replace_key'],
      ["CREATE TRIGGER disable_site AFTER UPDATE OF registration_count ON agent_registration_keys BEGIN UPDATE settings SET value=json_set(value, '$.auto_discovery', 'false') WHERE key='site_options'; END", 'disable_site'],
      ["CREATE TRIGGER expire_after_node AFTER INSERT ON servers BEGIN UPDATE agent_registration_keys SET expires_at=1; END", 'expire_after_node'],
      ["CREATE TRIGGER change_encryption_key AFTER INSERT ON servers BEGIN UPDATE settings SET value=json_set(value, '$.jwt_secret', 'changed-signing-key-000000000000000000000000'); END", 'change_encryption_key']
    ];
    for (const [sql, trigger] of mutations) {
      await h.db.prepare(sql).run();
      const response = await register(h, key);
      assert.equal(response.status, 503, trigger);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await before(), original, trigger);
      await h.db.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    assert.equal((await register(h, key)).status, 200);
    await h.db.prepare(`WITH RECURSIVE partitions(p) AS (SELECT 4 UNION ALL SELECT p+1 FROM partitions WHERE p<900)
      INSERT INTO servers (id, name, history_partition_id) SELECT 'full-' || p, 'full', p FROM partitions`).run();
    assert.equal((await register(h, key)).status, 503);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, 900);
    assert.equal((await h.db.prepare('SELECT registration_count FROM agent_registration_keys').first()).registration_count, 1);
  } finally { await h.dispose(); }
});

test('paused preflight cannot bypass key replacement, disabling, expiry, or encryption authority changes', async () => {
  const h = await setup();
  try {
    for (const change of ['replace', 'disable', 'expire', 'encryption']) {
      await saveSiteOptions(h.db, {auto_discovery:'true'});
      const {key} = await prepare(h);
      let resume, arrived;
      const paused = new Promise(resolve => { arrived = resolve; });
      const gate = new Promise(resolve => { resume = resolve; });
      const db = new Proxy(h.db, {get(target, property) {
        if (property === 'batch') return async statements => { arrived(); await gate; return target.batch(statements); };
        return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      }});
      const pending = handleAgentRegistration(new Request('https://example.com/api/agent/register', {
        method:'POST', headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:'{"name":"paused"}'
      }), {DB:db});
      await paused;
      if (change === 'replace') await prepare(h);
      if (change === 'disable') await saveSiteOptions(h.db, {auto_discovery:'false'});
      if (change === 'expire') await h.db.prepare('UPDATE agent_registration_keys SET expires_at=1').run();
      if (change === 'encryption') await saveSiteOptions(h.db, {jwt_secret:'new-key'.padEnd(64, 'x')});
      resume();
      assert.equal((await pending).status, change === 'disable' ? 403 : change === 'encryption' ? 503 : 401);
      assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, 2);
      assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM terminal_nodes').first()).count, 2);
      const active = await h.db.prepare('SELECT registration_count FROM agent_registration_keys').first();
      if (active) assert.equal(active.registration_count, 0);
    }
  } finally { await h.dispose(); }
});

test('key issuance checks session revocation again at the D1 write, not just before it', async () => {
  const h = await setup();
  try {
    await prepare(h);
    const original = await h.db.prepare('SELECT * FROM agent_registration_keys').first();
    const db = new Proxy(h.db, {get(target, property) {
      if (property === 'prepare') return sql => {
        const statement = target.prepare(sql);
        if (!sql.startsWith('INSERT INTO agent_registration_keys')) return statement;
        return {bind(...values) {
          const bound = statement.bind(...values);
          return {async run() {
            await target.prepare('UPDATE terminal_auth_sessions SET revoked_at=?').bind(Date.now()).run();
            return bound.run();
          }};
        }};
      };
      return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    }});
    const response = await handlePrepareRegistration(new Request('https://example.com/admin/api', {
      method:'POST', headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`, Origin:'https://example.com'}
    }), {DB:db}, {action:'node_prepare_registration'});
    assert.equal(response.status, 403);
    assert.deepEqual(await h.db.prepare('SELECT * FROM agent_registration_keys').first(), original);
  } finally { await h.dispose(); }
});
