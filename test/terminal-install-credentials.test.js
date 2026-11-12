import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './terminal-harness.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { verifyTerminalNodeToken, revokeTerminalNode } from '../src/database/terminal.js';
import { ensureNodeToken, issueNodeToken, readNodeToken, verifyNodeToken } from '../src/database/nodeCredentials.js';
import { handleTerminalAdminAction } from '../src/handlers/terminal.js';

test('reading an installation credential never rotates or enables it', async () => {
  const h = await harness();
  try {
    await h.action('terminal_prepare_install', {serverId:'node-a', terminal:true, acceptRisk:true});
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    const first = await h.action('terminal_read_install', {serverId:'node-a'});
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'no-store');
    const data = await first.json();
    assert.match(data.token, /^[a-f0-9]{64}$/);
    assert.equal(before.token_ciphertext.includes(data.token), false);
    assert.equal((await (await h.action('terminal_read_install', {serverId:'node-a'})).json()).token, data.token);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), before);
  } finally { await h.dispose(); }
});

test('opening a missing or hash-only installation does not create or replace credentials', async () => {
  const h = await harness();
  try {
    await h.db.prepare("INSERT INTO servers (id,name) VALUES ('new-node','new')").run();
    const data = await (await h.action('terminal_read_install', {serverId:'new-node'})).json();
    assert.equal(data.token, '');
    assert.equal(data.needsRotation, false);
    assert.equal(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='new-node'").first(), null);
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    const legacy = await (await h.action('terminal_read_install', {serverId:'node-a'})).json();
    assert.equal(legacy.needsRotation, true);
    assert.equal(legacy.token, '');
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), before);
  } finally { await h.dispose(); }
});

test('first opt-in creates a stable credential once, repeat opt-in does not rotate', async () => {
  const h = await harness();
  try {
    await saveSiteOptions(h.db, {theme_url:'https://github.com/test/theme/tree/main'});
    await h.db.prepare("INSERT INTO servers (id,name) VALUES ('new-node','new')").run();
    const payload = {serverId:'new-node', terminal:true, acceptRisk:true};
    const responses = await Promise.all([h.action('terminal_enable_install', payload), h.action('terminal_enable_install', payload)]);
    for (const response of responses) assert.equal(response.status, 200);
    const [a,b] = await Promise.all(responses.map(response => response.json()));
    assert.equal(a.token, b.token);
    assert.equal(a.version, 1);
    assert.equal((await verifyTerminalNodeToken(h.db, 'new-node', a.token)).version, 1);
    assert.equal((await (await h.action('terminal_enable_install', payload)).json()).token, a.token);
    assert.equal((await h.db.prepare("SELECT credential_version FROM terminal_nodes WHERE server_id='new-node'").first()).credential_version, 1);
  } finally { await h.dispose(); }
});

test('hash-only credentials require explicit reset; terminal re-enable preserves a usable token', async () => {
  const h = await harness();
  try {
    const payload = {serverId:'node-a', terminal:true, acceptRisk:true};
    assert.equal((await h.action('terminal_enable_install', payload)).status, 409);
    const issued = await (await h.action('terminal_prepare_install', payload)).json();
    await h.action('terminal_revoke_node', {serverId:'node-a'});
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    assert.equal(await verifyTerminalNodeToken(h.db, 'node-a', issued.token), null);
    const resumed = await h.action('terminal_enable_install', payload);
    assert.equal(resumed.status, 200);
    const data = await resumed.json();
    assert.equal(data.token, issued.token);
    assert.equal(data.version, before.credential_version);
    assert.equal(data.tokenVersion, before.token_version);
    const after = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    assert.equal(after.enabled, 1);
    assert.equal(after.token_hash, before.token_hash);
    assert.equal(after.token_ciphertext, before.token_ciphertext);
    assert.equal(after.token_version, before.token_version);
    assert.equal(after.credential_version, before.credential_version);
    assert.equal((await verifyTerminalNodeToken(h.db, 'node-a', issued.token)).version, before.credential_version);
    const fresh = await (await h.action('terminal_prepare_install', payload)).json();
    assert.notEqual(fresh.token, issued.token);
    assert.equal(fresh.tokenVersion, before.token_version + 1);
    assert.equal(fresh.version, before.credential_version + 1);
    assert.equal((await (await h.action('terminal_read_install', {serverId:'node-a'})).json()).token, fresh.token);
  } finally { await h.dispose(); }
});

test('credential reads and opt-in preserve administrator, Origin and consent boundaries with a trusted theme', async () => {
  const h = await harness();
  try {
    await saveSiteOptions(h.db, {theme_url:'https://github.com/test/theme/tree/main'});
    for (const action of ['terminal_read_install','terminal_enable_install']) {
      const payload = {serverId:'node-a', terminal:true, acceptRisk:true};
      assert.equal((await h.action(action, payload, {headers:{Cookie:''}})).status, 401);
      assert.equal((await h.action(action, payload, {headers:{Origin:'https://other.invalid'}})).status, 403);
    }
    assert.equal((await h.action('terminal_enable_install', {serverId:'node-a',terminal:false,acceptRisk:true})).status, 400);
    assert.equal((await h.action('terminal_read_install', {serverId:'node-a'})).status, 200);
    assert.equal((await h.action('terminal_enable_install', {serverId:'node-a',terminal:true,acceptRisk:true})).status, 409, 'hash-only credentials still require deliberate reissue');
  } finally { await h.dispose(); }
});

test('tampered encrypted credentials fail closed without replacing a running credential', async () => {
  const h = await harness();
  try {
    const issued = await (await h.action('terminal_prepare_install', {serverId:'node-a',terminal:true,acceptRisk:true})).json();
    await h.db.prepare("UPDATE terminal_nodes SET token_ciphertext = ? WHERE server_id='node-a'").bind('0'.repeat(184)).run();
    const data = await (await h.action('terminal_read_install', {serverId:'node-a'})).json();
    assert.equal(data.token, '');
    assert.equal(data.needsRotation, true);
    assert.equal((await verifyTerminalNodeToken(h.db, 'node-a', issued.token)).version, issued.version);
  } finally { await h.dispose(); }
});

test('enable and prepare cannot restore permission after an intervening revoke, reset or deletion', async () => {
  const h = await harness();
  try {
    for (const action of ['terminal_enable_install', 'terminal_prepare_install']) {
      for (const mutation of ['revoke', 'reset', 'delete']) {
        const serverId = `${action}-${mutation}`;
        await h.db.prepare('INSERT INTO servers (id, name) VALUES (?, ?)').bind(serverId, serverId).run();
        assert.equal((await h.action('terminal_prepare_install', {serverId, terminal:true, acceptRisk:true})).status, 200);
        let intervened = false;
        let afterMutation;
        const db = new Proxy(h.db, {get(target, key) {
          if (key !== 'prepare') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
          return sql => {
            const statement = target.prepare(sql);
            if (!sql.includes('UPDATE terminal_nodes SET enabled = 1')) return statement;
            return {bind(...values) {
              const bound = statement.bind(...values);
              return {async first() {
                intervened = true;
                if (mutation === 'revoke') await revokeTerminalNode(h.db, serverId);
                if (mutation === 'reset') await issueNodeToken(h.db, serverId, Date.now(), 's'.repeat(64));
                if (mutation === 'delete') await h.db.prepare('DELETE FROM servers WHERE id = ?').bind(serverId).run();
                afterMutation = await h.db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(serverId).first();
                return bound.first();
              }};
            }};
          };
        }});
        const env = {DB:db, TERMINAL_BROKER:{idFromName:id=>id, get:()=>({fetch() { throw new Error('stale permission must not reach the broker'); }})}};
        const request = new Request('https://example.com/admin/api', {headers:{Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
        const result = await handleTerminalAdminAction({request, env, sys:{}, data:{action, serverId, terminal:true, acceptRisk:true}});
        assert.equal(intervened, true);
        assert.equal(result.status, 409);
        assert.deepEqual(await h.db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(serverId).first(), afterMutation);
        if (mutation === 'revoke') {
          const credential = await readNodeToken(h.db, serverId, 's'.repeat(64));
          assert.equal(credential.enabled, false);
          assert.ok(await verifyNodeToken(h.db, credential.token, serverId), 'terminal revoke preserves generic authentication');
          assert.equal(await verifyTerminalNodeToken(h.db, serverId, credential.token), null);
        }
      }
    }
  } finally { await h.dispose(); }
});

test('explicit administrator revoke fences pending first-enable and prepare on already disabled nodes', async () => {
  const h = await harness();
  try {
    for (const action of ['terminal_enable_install', 'terminal_prepare_install']) {
      for (const previouslyEnabled of [false, true]) {
        for (const brokerAvailable of [true, false]) {
          const serverId = `disabled-${action}-${previouslyEnabled}-${brokerAvailable}`;
          await h.db.prepare('INSERT INTO servers (id, name) VALUES (?, ?)').bind(serverId, serverId).run();
          await ensureNodeToken(h.db, serverId, 's'.repeat(64));
          if (previouslyEnabled) {
            assert.equal((await h.action('terminal_enable_install', {serverId, terminal:true, acceptRisk:true})).status, 200);
            assert.equal((await h.action('terminal_revoke_node', {serverId})).status, 200);
          }
          assert.equal((await readNodeToken(h.db, serverId, 's'.repeat(64))).enabled, false);
          const beforeMaintenance = await h.db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(serverId).first();
          await revokeTerminalNode(h.db, serverId);
          assert.deepEqual(await h.db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(serverId).first(), beforeMaintenance, 'no-context cleanup is an idempotent no-op when already off');
          let afterRevoke;
          const db = new Proxy(h.db, {get(target, key) {
            if (key !== 'prepare') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
            return sql => {
              const statement = target.prepare(sql);
              if (!sql.includes('UPDATE terminal_nodes SET enabled = 1')) return statement;
              return {bind(...values) {
                const bound = statement.bind(...values);
                return {async first() {
                  const beforeRevoke = await h.db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(serverId).first();
                  const request = new Request('https://example.com/admin/api', {headers:{Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
                  const revoked = brokerAvailable
                    ? await h.action('terminal_revoke_node', {serverId})
                    : await handleTerminalAdminAction({request, env:{DB:h.db}, sys:{}, data:{action:'terminal_revoke_node', serverId}});
                  assert.equal(revoked.status, brokerAvailable ? 200 : 503);
                  assert.equal((await revoked.json()).serverRevoked, true);
                  afterRevoke = await h.db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(serverId).first();
                  assert.equal(afterRevoke.enabled, 0);
                  assert.equal(afterRevoke.credential_version, beforeRevoke.credential_version + 1);
                  assert.equal(afterRevoke.token_hash, beforeRevoke.token_hash);
                  assert.equal(afterRevoke.token_ciphertext, beforeRevoke.token_ciphertext);
                  assert.equal(afterRevoke.token_version, beforeRevoke.token_version);
                  return bound.first();
                }};
              }};
            };
          }});
          const env = {DB:db, TERMINAL_BROKER:{idFromName:id=>id, get:()=>({fetch() { throw new Error('stale enable must not reach the broker'); }})}};
          const request = new Request('https://example.com/admin/api', {headers:{Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
          const result = await handleTerminalAdminAction({request, env, sys:{}, data:{action, serverId, terminal:true, acceptRisk:true}});
          assert.ok(afterRevoke);
          assert.equal(result.status, 409, 'an explicit later revoke must defeat the earlier enable intent');
          assert.deepEqual(await h.db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(serverId).first(), afterRevoke);
          const credential = await readNodeToken(h.db, serverId, 's'.repeat(64));
          assert.ok(await verifyNodeToken(h.db, credential.token, serverId));
          assert.equal(await verifyTerminalNodeToken(h.db, serverId, credential.token), null);
          const duplicate = await h.action('terminal_revoke_node', {serverId});
          assert.equal(duplicate.status, 200);
          assert.deepEqual(await duplicate.json(), {enabled:false, serverRevoked:true, localConfirmed:false, localReason:'already_revoked'});
          const afterDuplicate = await readNodeToken(h.db, serverId, 's'.repeat(64));
          assert.equal(afterDuplicate.token, credential.token);
          assert.equal(afterDuplicate.tokenVersion, credential.tokenVersion);
          assert.equal(afterDuplicate.version, credential.version + 1);
          assert.equal(afterDuplicate.enabled, false);
        }
      }
    }
  } finally { await h.dispose(); }
});
