import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import * as terminal from '../src/database/terminal.js';
import * as credentials from '../src/database/nodeCredentials.js';
const secret = 'node-credential-test-key';
const mf = new Miniflare({modules:true, script:'export default { fetch() { return new Response("OK"); } }', d1Databases:{DB:'node-credentials-test', LEGACY:'node-credentials-legacy', HASH_ONLY:'node-credentials-hash-only'}});
after(() => mf.dispose());
const db = await mf.getD1Database('DB');
await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT)').run();
await credentials.ensureNodeCredentialSchema(db);

test('a disabled terminal retains its live node credential, but cannot admit terminal connections', async () => {
  await db.prepare("INSERT INTO servers (id, name) VALUES ('node-a', 'a'), ('node-b', 'b')").run();
  const issued = await credentials.ensureNodeToken(db, 'node-a', secret, 1000);
  assert.equal(issued.enabled, false, 'generic issuance does not grant terminal permission');
  await terminal.revokeTerminalNode(db, 'node-a', 2000);
  assert.deepEqual(await credentials.verifyNodeToken(db, issued.token, 'node-a'), {serverId:'node-a', tokenVersion:1, version:1});
  assert.equal(await terminal.verifyTerminalNodeToken(db, 'node-a', issued.token), null);
  for (const token of ['', null, '0'.repeat(64), issued.token.toUpperCase()]) {
    assert.equal(await credentials.verifyNodeToken(db, token, 'node-a'), null);
  }
  assert.equal(await credentials.verifyNodeToken(db, issued.token, 'node-b'), null);
  assert.equal(await credentials.verifyNodeToken(db, issued.token, 'missing'), null);
  await db.prepare("DELETE FROM servers WHERE id = 'node-a'").run();
  assert.equal(await credentials.verifyNodeToken(db, issued.token, 'node-a'), null);
});

test('concurrent ensure and repeated reads return one encrypted token without mutations', async () => {
  await db.prepare("INSERT INTO servers (id) VALUES ('stable')").run();
  const results = await Promise.all(Array.from({length:8}, (_, index) => credentials.ensureNodeToken(db, 'stable', secret, 3000 + index)));
  for (const result of results) {
    assert.equal(result.token, results[0].token);
    assert.match(result.token, /^[a-f0-9]{64}$/);
    assert.equal(result.version, 1);
    assert.equal(result.tokenVersion, 1);
    assert.equal(result.enabled, false);
    assert.equal(result.needsRotation, false);
  }
  const before = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'stable'").first();
  assert.equal(before.token_hash, createHash('sha256').update(results[0].token).digest('hex'));
  assert.match(before.token_ciphertext, /^[a-f0-9]{184}$/);
  assert.equal(JSON.stringify(before).includes(results[0].token), false);
  assert.equal((await credentials.readNodeToken(db, 'stable', secret)).token, results[0].token);
  assert.equal((await credentials.ensureNodeToken(db, 'stable', secret, 9000)).token, results[0].token);
  assert.deepEqual(await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'stable'").first(), before);
  assert.deepEqual(await credentials.verifyNodeToken(db, results[0].token), {serverId:'stable', tokenVersion:1, version:1});
});

test('terminal disable changes only its epoch; explicit reset increments both epochs and preserves permission', async () => {
  await db.prepare("INSERT INTO servers (id) VALUES ('epochs')").run();
  const initial = await credentials.ensureNodeToken(db, 'epochs', secret, 1000);
  await db.prepare("UPDATE terminal_nodes SET enabled = 1 WHERE server_id = 'epochs'").run();
  assert.deepEqual(await terminal.verifyTerminalNodeToken(db, 'epochs', initial.token), {serverId:'epochs', version:1});
  const before = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'epochs'").first();
  await terminal.revokeTerminalNode(db, 'epochs', 2000);
  const disabled = await credentials.readNodeToken(db, 'epochs', secret);
  assert.deepEqual(disabled, {token:initial.token, version:2, tokenVersion:1, enabled:false, needsRotation:false});
  const revoked = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'epochs'").first();
  assert.equal(revoked.token_hash, before.token_hash);
  assert.equal(revoked.token_ciphertext, before.token_ciphertext);
  await terminal.revokeTerminalNode(db, 'epochs', 3000);
  assert.deepEqual(await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'epochs'").first(), revoked);
  const reset = await credentials.issueNodeToken(db, 'epochs', 4000, secret);
  assert.notEqual(reset.token, initial.token);
  assert.equal(reset.version, 3);
  assert.equal(reset.tokenVersion, 2);
  assert.equal(reset.enabled, false);
  assert.equal(await credentials.verifyNodeToken(db, initial.token), null);
  assert.equal(await terminal.verifyTerminalNodeToken(db, 'epochs', reset.token), null);
  await db.prepare("UPDATE terminal_nodes SET enabled = 1 WHERE server_id = 'epochs'").run();
  const enabledReset = await credentials.issueNodeToken(db, 'epochs', 5000, secret);
  assert.equal(enabledReset.enabled, true);
  assert.equal(enabledReset.version, 4);
  assert.equal(enabledReset.tokenVersion, 3);
  assert.deepEqual(await terminal.verifyTerminalNodeToken(db, 'epochs', enabledReset.token), {serverId:'epochs', version:4});
});

test('hash-only, wrong-key and tampered reads require explicit reset without altering authority', async () => {
  for (const id of ['hash-only', 'wrong-key', 'tampered']) {
    await db.prepare('INSERT INTO servers (id) VALUES (?)').bind(id).run();
    const issued = await credentials.issueNodeToken(db, id, 1000, id === 'hash-only' ? '' : secret);
    if (id === 'tampered') await db.prepare('UPDATE terminal_nodes SET token_ciphertext = ? WHERE server_id = ?').bind('0'.repeat(184), id).run();
    const before = await db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(id).first();
    const key = id === 'wrong-key' ? 'different-key' : secret;
    for (const read of [credentials.readNodeToken, credentials.ensureNodeToken]) {
      assert.deepEqual(await read(db, id, key), {token:'', version:1, tokenVersion:1, enabled:false, needsRotation:true});
      assert.deepEqual(await db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(id).first(), before);
    }
    assert.deepEqual(await credentials.verifyNodeToken(db, issued.token, id), {serverId:id, tokenVersion:1, version:1});
    const reset = await credentials.issueNodeToken(db, id, 2000, secret);
    assert.equal((await credentials.readNodeToken(db, id, secret)).token, reset.token);
    assert.equal(await credentials.verifyNodeToken(db, issued.token, id), null);
  }
});

test('ciphertext cannot be transplanted to another node or detached from its hash', async () => {
  for (const id of ['bound-a', 'bound-b']) await db.prepare('INSERT INTO servers (id) VALUES (?)').bind(id).run();
  const a = await credentials.ensureNodeToken(db, 'bound-a', secret);
  await credentials.ensureNodeToken(db, 'bound-b', secret);
  const row = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'bound-a'").first();
  await db.prepare("UPDATE terminal_nodes SET token_ciphertext = ? WHERE server_id = 'bound-b'").bind(row.token_ciphertext).run();
  assert.equal((await credentials.readNodeToken(db, 'bound-b', secret)).needsRotation, true);
  assert.equal((await credentials.readNodeToken(db, 'bound-b', secret)).token, '');
  await db.prepare("UPDATE terminal_nodes SET token_hash = ? WHERE server_id = 'bound-a'").bind('0'.repeat(64)).run();
  assert.equal((await credentials.readNodeToken(db, 'bound-a', secret)).token, '');
  assert.equal(await credentials.verifyNodeToken(db, a.token, 'bound-a'), null);
});

test('a token hash cannot authenticate multiple nodes and duplicate legacy hashes fail migration without resets', async () => {
  for (const id of ['unique-a', 'unique-b']) await db.prepare('INSERT INTO servers (id) VALUES (?)').bind(id).run();
  const a = await credentials.ensureNodeToken(db, 'unique-a', secret);
  const b = await credentials.ensureNodeToken(db, 'unique-b', secret);
  const before = await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'unique-b'").first();
  const hash = createHash('sha256').update(a.token).digest('hex');
  await assert.rejects(() => db.prepare("UPDATE terminal_nodes SET token_hash = ? WHERE server_id = 'unique-b'").bind(hash).run(), /UNIQUE constraint failed/);
  assert.deepEqual(await db.prepare("SELECT * FROM terminal_nodes WHERE server_id = 'unique-b'").first(), before);
  assert.equal((await credentials.verifyNodeToken(db, a.token)).serverId, 'unique-a');
  assert.equal(await credentials.verifyNodeToken(db, a.token, 'unique-b'), null);
  assert.equal((await credentials.verifyNodeToken(db, b.token)).serverId, 'unique-b');

  await db.prepare('DROP INDEX terminal_nodes_token_hash_unique').run();
  await db.prepare("UPDATE terminal_nodes SET token_hash = ? WHERE server_id = 'unique-b'").bind(hash).run();
  const duplicated = (await db.prepare("SELECT * FROM terminal_nodes WHERE server_id IN ('unique-a', 'unique-b') ORDER BY server_id").all()).results;
  await assert.rejects(() => credentials.ensureNodeCredentialSchema(db), /UNIQUE constraint failed/);
  assert.deepEqual((await db.prepare("SELECT * FROM terminal_nodes WHERE server_id IN ('unique-a', 'unique-b') ORDER BY server_id").all()).results, duplicated);
  for (const id of [undefined, 'unique-a', 'unique-b']) assert.equal(await credentials.verifyNodeToken(db, a.token, id), null);
  await db.prepare("UPDATE terminal_nodes SET token_hash = ? WHERE server_id = 'unique-b'").bind(before.token_hash).run();
  await credentials.ensureNodeCredentialSchema(db);
});

test('terminal permission updates cannot revive a stale epoch or a deleted server', async () => {
  for (const id of ['enable-revoked', 'enable-deleted']) {
    await db.prepare('INSERT INTO servers (id) VALUES (?)').bind(id).run();
    const token = await credentials.ensureNodeToken(db, id, secret);
    assert.equal(await terminal.enableTerminalNode(db, id, token.version, 1000), true);
    if (id === 'enable-revoked') await terminal.revokeTerminalNode(db, id, 2000);
    else await db.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
    const before = await db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(id).first();
    assert.equal(await terminal.enableTerminalNode(db, id, token.version, 3000), false);
    assert.deepEqual(await db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(id).first(), before);
  }
});

test('migration preserves legacy ciphertext and terminal epochs and is concurrently idempotent', async () => {
  const legacy = await mf.getD1Database('LEGACY');
  await legacy.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY)').run();
  await legacy.prepare("INSERT INTO servers (id) VALUES ('legacy')").run();
  await legacy.prepare('CREATE TABLE terminal_nodes (server_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, token_ciphertext TEXT, credential_version INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)').run();
  const token = 'a'.repeat(64);
  const hash = createHash('sha256').update(token).digest('hex');
  const digest = createHash('sha256').update(`cfsm-terminal-install:${secret}`).digest();
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(7);
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:new TextEncoder().encode('legacy')}, key, new TextEncoder().encode(token));
  const ciphertext = Buffer.from(iv).toString('hex') + Buffer.from(encrypted).toString('hex');
  await legacy.prepare('INSERT INTO terminal_nodes VALUES (?, ?, ?, 9, 0, 1234)').bind('legacy', hash, ciphertext).run();
  await Promise.all([credentials.ensureNodeCredentialSchema(legacy), credentials.ensureNodeCredentialSchema(legacy)]);
  assert.deepEqual(await credentials.readNodeToken(legacy, 'legacy', secret), {token, version:9, tokenVersion:1, enabled:false, needsRotation:false});
  const before = await legacy.prepare('SELECT * FROM terminal_nodes').first();
  assert.equal(before.token_hash, hash);
  assert.equal(before.token_ciphertext, ciphertext);
  assert.equal(before.updated_at, 1234);
  await credentials.ensureNodeCredentialSchema(legacy);
  assert.deepEqual(await legacy.prepare('SELECT * FROM terminal_nodes').first(), before);

  const hashOnly = await mf.getD1Database('HASH_ONLY');
  await hashOnly.prepare('CREATE TABLE terminal_nodes (server_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, credential_version INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)').run();
  await hashOnly.prepare('INSERT INTO terminal_nodes VALUES (?, ?, 6, 1, 1234)').bind('old', hash).run();
  await Promise.all([credentials.ensureNodeCredentialSchema(hashOnly), credentials.ensureNodeCredentialSchema(hashOnly)]);
  assert.deepEqual(await hashOnly.prepare('SELECT * FROM terminal_nodes').first(), {server_id:'old', token_hash:hash, token_ciphertext:null, credential_version:6, token_version:1, enabled:1, updated_at:1234});
});

test('missing/deleted nodes cannot provision or read retained credentials', async () => {
  assert.deepEqual(await credentials.readNodeToken(db, 'missing', secret), {token:'', version:0, tokenVersion:0, enabled:false, needsRotation:false});
  await assert.rejects(() => credentials.ensureNodeToken(db, 'missing', secret));
  await assert.rejects(() => credentials.issueNodeToken(db, 'missing', 1000, secret));
  await db.prepare("INSERT INTO servers (id) VALUES ('deleted')").run();
  const issued = await credentials.ensureNodeToken(db, 'deleted', secret);
  await db.prepare("DELETE FROM servers WHERE id = 'deleted'").run();
  assert.equal(await credentials.verifyNodeToken(db, issued.token), null);
  assert.equal(await terminal.verifyTerminalNodeToken(db, 'deleted', issued.token), null);
  assert.equal((await credentials.readNodeToken(db, 'deleted', secret)).token, '');
  await assert.rejects(() => credentials.ensureNodeToken(db, 'deleted', secret));
  await assert.rejects(() => credentials.issueNodeToken(db, 'deleted', 1000, secret));
});

test('invalid inputs, failed database reads and exhausted epochs fail closed', async () => {
  for (const id of ['', '../node', null, 'a'.repeat(129)]) {
    await assert.rejects(() => credentials.readNodeToken(db, id, secret), RangeError);
    await assert.rejects(() => credentials.ensureNodeToken(db, id, secret), RangeError);
    await assert.rejects(() => credentials.issueNodeToken(db, id, 1000, secret), RangeError);
    assert.equal(await credentials.verifyNodeToken(db, 'a'.repeat(64), id), null);
  }
  for (const now of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => credentials.ensureNodeToken(db, 'stable', secret, now), RangeError);
    await assert.rejects(() => credentials.issueNodeToken(db, 'stable', now, secret), RangeError);
  }
  const unavailable = {prepare() { throw new Error('test D1 outage'); }};
  await assert.rejects(() => credentials.verifyNodeToken(unavailable, 'a'.repeat(64)), /test D1 outage/);
  for (const field of ['token_version', 'credential_version']) {
    const id = `exhausted-${field}`;
    await db.prepare('INSERT INTO servers (id) VALUES (?)').bind(id).run();
    await credentials.ensureNodeToken(db, id, secret);
    await db.prepare(`UPDATE terminal_nodes SET ${field} = 9007199254740991 WHERE server_id = ?`).bind(id).run();
    const before = await db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(id).first();
    if (field === 'credential_version') assert.equal(await terminal.enableTerminalNode(db, id, Number.MAX_SAFE_INTEGER), false, 'an exhausted terminal epoch cannot be safely re-enabled');
    await assert.rejects(() => credentials.issueNodeToken(db, id, 2000, secret), RangeError);
    assert.deepEqual(await db.prepare('SELECT * FROM terminal_nodes WHERE server_id = ?').bind(id).first(), before);
  }
});
