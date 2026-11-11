import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, controls, until, openPair } from './terminal-harness.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { verifyTerminalNodeToken } from '../src/database/terminal.js';
import { spawnSync } from 'node:child_process';

const prepare = h => h.action('terminal_prepare_install', {serverId:'node-a', terminal:true, acceptRisk:true});
const open = h => h.action('terminal_open', {serverId:'node-a', clientRequestId:crypto.randomUUID(), cols:80, rows:24});

test('confirmed install enables the site once but cannot open until the current-token capable Agent connects', async () => {
  const h = await harness();
  try {
    await saveSiteOptions(h.db, {terminal_enabled:'false'});
    const response = await prepare(h);
    assert.equal(response.status, 200);
    const issued = await response.json();
    assert.match(issued.token, /^[a-f0-9]{64}$/);
    assert.equal(issued.version, 2);
    assert.equal(await verifyTerminalNodeToken(h.db, 'node-a', h.nodes['node-a'].token), null);
    assert.equal((await open(h)).status, 409, 'preparation is not an installation');
    assert.equal((await (await h.action('terminal_status', {serverId:'node-a'})).json()).state, 'pending');
    h.nodes['node-a'] = issued;
    const control = await h.control();
    const pair = await openPair(h, control);
    assert.equal(pair.browser.response.status, 101);
    assert.equal(pair.agent.response.status, 101);
    assert.ok(controls(control).some(frame => frame.sessionId === pair.session.sessionId));
    assert.equal((await h.db.prepare("SELECT credential_version FROM terminal_nodes WHERE server_id='node-a'").first()).credential_version, 2, 'ordinary access never rotates');
    await h.action('terminal_close', {serverId:'node-a', sessionId:pair.session.sessionId});
    assert.equal((await (await h.action('terminal_status', {serverId:'node-a'})).json()).state, 'ready', 'disconnect is not revoke');
  } finally { await h.dispose(); }
});

test('prepare requires explicit consent, fresh Cookie, same origin and built-in frontend; rejected calls never rotate', async () => {
  const h = await harness();
  try {
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    for (const data of [{}, {terminal:false, acceptRisk:true}, {terminal:true}, {terminal:true, acceptRisk:'true'}]) {
      assert.equal((await h.action('terminal_prepare_install', {serverId:'node-a', ...data})).status, 400);
    }
    for (const [headers, status] of [[{Cookie:''},401], [{Authorization:`Bearer ${h.token}`},401], [{Origin:'https://evil.invalid'},403]]) {
      assert.equal((await h.action('terminal_prepare_install', {serverId:'node-a',terminal:true,acceptRisk:true}, {headers})).status, status);
    }
    await saveSiteOptions(h.db, {theme_url:'https://example.invalid/theme'});
    assert.equal((await prepare(h)).status, 409);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), before);
  } finally { await h.dispose(); }
});

test('old standalone authorization actions cannot revive an installation and rotation closes old real peers', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const pair = await openPair(h, control);
    for (const action of ['terminal_authorize_node','terminal_enable_site']) assert.equal((await h.action(action, {serverId:'node-a',password:'test-report-secret'})).status, 400);
    const old = h.nodes['node-a'];
    const issued = await (await prepare(h)).json();
    await until(() => pair.browser.ws.readyState !== 1 && pair.agent.ws.readyState !== 1 && control.ws.readyState !== 1);
    assert.equal((await h.socket('/api/agent/terminal/control', h.agentHeaders())).response.status, 401);
    assert.equal(await verifyTerminalNodeToken(h.db, 'node-a', old.token), null);
    assert.equal((await open(h)).status, 409);
    h.nodes['node-a'] = issued;
    await h.control();
    assert.equal((await open(h)).status, 200);
    await h.action('logout');
    assert.equal((await prepare(h)).status, 401);
    assert.equal((await open(h)).status, 401);
  } finally { await h.dispose(); }
});

test('bulk metadata distinguishes pending, ready, offline, unsupported and revoked without opening sessions', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    let response = await h.action('terminal_status', {serverIds:['node-a','node-b']});
    await h.fetch('/test/legacy-capability');
    response = await h.action('terminal_status', {serverIds:['node-a','node-b']});
    assert.equal(response.status, 200);
    let status = (await response.json()).nodes;
    assert.equal(status['node-a'].state, 'ready');
    assert.equal(status['node-b'].state, 'pending');
    assert.equal(status['node-a'].activeCount, 0);
    control.ws.close();
    await until(async () => !(await (await h.action('terminal_status', {serverId:'node-a'})).json()).connected);
    assert.equal((await (await h.action('terminal_status', {serverId:'node-a'})).json()).state,'offline');
    const unsupported = await h.socket('/api/agent/terminal/control', h.agentHeaders('node-b'));
    unsupported.ws.send(JSON.stringify({type:'hello',protocol:1,platform:'windows',capabilities:[]}));
    await until(() => unsupported.ws.readyState !== 1);
    assert.equal((await (await h.action('terminal_status', {serverId:'node-b'})).json()).state, 'unsupported');
    assert.notEqual((await h.action('terminal_open',{serverId:'node-b',clientRequestId:'unsupported',cols:80,rows:24})).status,200);
    await h.action('terminal_revoke_node', {serverId:'node-a'});
    assert.equal((await (await h.action('terminal_status', {serverId:'node-a'})).json()).state, 'revoked');
    await h.db.prepare("INSERT INTO servers (id,name) VALUES ('not-installed','pending')").run();
    assert.equal((await (await h.action('terminal_status', {serverId:'not-installed'})).json()).state, 'pending');
    status = await (await h.action('terminal_status',{serverIds:['node-a','node-b','not-installed']})).json();
    assert.equal(JSON.stringify(status).includes(h.nodes['node-b'].token), false);
    assert.equal((await h.action('terminal_status',{serverIds:['node-a','node-a']})).status,400);
  } finally { await h.dispose(); }
});

test('compiled real admin installation and terminal UI preserve consent, token ownership and seven locale layouts', {timeout:120000}, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/terminal-install-access.mjs'], {encoding:'utf8',windowsHide:true,timeout:120000,env:process.env});
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.error, undefined);
  assert.equal(result.status,0);
});
