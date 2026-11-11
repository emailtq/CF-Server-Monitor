import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './terminal-harness.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { verifyTerminalNodeToken } from '../src/database/terminal.js';

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

test('hash-only and revoked credentials require deliberate reissue, not silent replacement', async () => {
  const h = await harness();
  try {
    const payload = {serverId:'node-a', terminal:true, acceptRisk:true};
    assert.equal((await h.action('terminal_enable_install', payload)).status, 409);
    const issued = await (await h.action('terminal_prepare_install', payload)).json();
    await h.action('terminal_revoke_node', {serverId:'node-a'});
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    assert.equal((await h.action('terminal_enable_install', payload)).status, 409);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), before);
    assert.equal(await verifyTerminalNodeToken(h.db, 'node-a', issued.token), null);
    const fresh = await (await h.action('terminal_prepare_install', payload)).json();
    assert.notEqual(fresh.token, issued.token);
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
