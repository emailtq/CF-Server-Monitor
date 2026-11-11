import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { generateToken } from '../src/middleware/auth.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { saveSiteOptions, loadSiteSettings, clearSiteSettingsCache } from '../src/utils/settings.js';

const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('unexpected_test_network'); };
after(() => { globalThis.fetch = nativeFetch; });

const feature = await import('../src/database/notifications.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const { loadNotificationConfig: load, saveNotificationConfig: save } = feature;
const { evaluateTrafficAlert } = await import('../src/services/notification.js');
const channel = (id) => ({ ...(id ? { id } : {}), name: 'Ops', type: 'telegram', enabled: true, config: { chatId: '42' }, secrets: { botToken: 'fixture-secret' }, template: '{{message}}' });
const rule = id => ({ id: 'offline', name: 'Offline', type: 'offline', enabled: true, scope: { mode: 'all', serverIds: [] }, targetIds: [id], options: { minutes: 5 } });

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("OK")}}', d1Databases: { DB: crypto.randomUUID(), OTHER: crypto.randomUUID() } });
  const db = await mf.getD1Database('DB');
  const other = await mf.getD1Database('OTHER');
  for (const database of [db, other]) {
    await database.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    await database.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY)').run();
    await database.prepare('INSERT INTO servers VALUES (?)').bind(database === db ? 'node-a' : 'other-site-node').run();
    await database.prepare("INSERT INTO settings VALUES ('site_options', ?)").bind(JSON.stringify({ jwt_secret: 'a'.repeat(64), password: 'fixture-password', tg_bot_token: database === db ? 'legacy-secret' : 'other-legacy-secret', tg_chat_id: '42', tg_notify: '5' })).run();
  }
  clearSiteSettingsCache();
  const sys = await loadSiteSettings(db, true);
  const env = { DB: db, API_SECRET: 'fixture-report-secret' };
  const token = await generateToken(env, sys);
  const action = (action, data = {}, authenticated = true) => handleAdminAPI(new Request('https://fixture.test/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `cfsm_auth=${encodeURIComponent(token)}` } : {}) }, body: JSON.stringify({ action, ...data }) }), env, sys);
  const rawAction = body => handleAdminAPI(new Request('https://fixture.test/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `cfsm_auth=${encodeURIComponent(token)}` }, body }), env, sys);
  return { db, other, action, rawAction, close: () => mf.dispose() };
}

test('missing key loads a revision-zero view without writes; a saved empty object is authoritative', async () => {
  assert.equal(typeof load, 'function', 'D1 notification read is not implemented');
  const h = await fixture();
  try {
    const view = await load(h.db);
    assert.equal(view.revision, 0);
    assert.equal(view.channels[0].secrets.token, 'legacy-secret');
    assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='notification_config'").first(), null);
    const safe = await save(h.db, { expectedRevision: 0, channels: [], rules: [] });
    assert.equal(safe.revision, 1);
    assert.equal((await load(h.db)).channels.length, 0);
    assert.equal((await load(h.other)).channels[0].secrets.token, 'other-legacy-secret');
  } finally { await h.close(); }
});

test('real D1 first and existing CAS have exactly one winner and stale secret drafts cannot overwrite', async () => {
  assert.equal(typeof save, 'function', 'atomic CAS save is not implemented');
  const h = await fixture();
  try {
    const first = await Promise.allSettled([save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] }), save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] })]);
    assert.equal(first.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(first.find(r => r.status === 'rejected').reason.code, 'notification_revision_conflict');
    const safe = first.find(r => r.status === 'fulfilled').value;
    const id = safe.channels[0].id;
    assert.match(id, /^channel_[A-Za-z0-9_-]+$/);
    const draft = safe.channels[0];
    const results = await Promise.allSettled(['new-one', 'new-two'].map(botToken => save(h.db, { expectedRevision: 1, channels: [draft], rules: [], secretUpdates: { [id]: { botToken } } })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await load(h.db)).revision, 2);
    const winner = (await load(h.db)).channels[0].secrets.botToken;
    await assert.rejects(save(h.db, { expectedRevision: 1, channels: [draft], rules: [] }), { code: 'notification_revision_conflict' });
    assert.equal((await load(h.db)).channels[0].secrets.botToken, winner);
  } finally { await h.close(); }
});

test('D1 secret omission preserves, nonempty update replaces, explicit clear removes; IDs cannot steal credentials', async () => {
  assert.equal(typeof save, 'function');
  const h = await fixture();
  try {
    let safe = await save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] });
    const id = safe.channels[0].id;
    safe = await save(h.db, { expectedRevision: 1, channels: safe.channels, rules: [] });
    assert.equal((await load(h.db)).channels[0].secrets.botToken, 'fixture-secret');
    safe = await save(h.db, { expectedRevision: 2, channels: safe.channels, rules: [], secretUpdates: { [id]: { botToken: 'replacement-secret' } } });
    assert.equal((await load(h.db)).channels[0].secrets.botToken, 'replacement-secret');
    await assert.rejects(save(h.db, { expectedRevision: 3, channels: [{ ...safe.channels[0], type: 'legacy', config: {} }], rules: [] }), { code: 'notification_config_invalid' });
    await assert.rejects(save(h.db, { expectedRevision: 3, channels: [channel('client-chosen')], rules: [] }), { code: 'notification_config_invalid' });
    await assert.rejects(save(h.db, { expectedRevision: 3, channels: [safe.channels[0]], rules: [], secretUpdates: { missing: { botToken: 'x' } } }), { code: 'notification_config_invalid' });
    safe = await save(h.db, { expectedRevision: 3, channels: [{ ...safe.channels[0], enabled: false, clearSecrets: ['botToken'] }], rules: [] });
    assert.deepEqual((await load(h.db)).channels[0].secrets, {});
    assert.deepEqual(safe.channels[0].secretFields, {});
  } finally { await h.close(); }
});

test('disabled channels retain rules; re-enable/new rule requires active targets and referenced deletion is blocked', async () => {
  assert.equal(typeof save, 'function');
  const h = await fixture();
  try {
    let safe = await save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] });
    const id = safe.channels[0].id;
    safe = await save(h.db, { expectedRevision: 1, channels: safe.channels, rules: [rule(id)] });
    safe = await save(h.db, { expectedRevision: 2, channels: [{ ...safe.channels[0], enabled: false }], rules: safe.rules });
    assert.equal(safe.rules[0].enabled, true);
    await assert.rejects(save(h.db, { expectedRevision: 3, channels: [], rules: [] }), { code: 'notification_channel_referenced' });
    await assert.rejects(save(h.db, { expectedRevision: 3, channels: safe.channels, rules: [rule(id), { ...rule(id), id: 'new' }] }), { code: 'notification_config_invalid' });
    safe = await save(h.db, { expectedRevision: 3, channels: safe.channels, rules: [{ ...rule(id), enabled: false }] });
    await assert.rejects(save(h.db, { expectedRevision: 4, channels: safe.channels, rules: [rule(id)] }), { code: 'notification_config_invalid' });
  } finally { await h.close(); }
});

test('bad JSON/future schemas fail closed, current selected IDs are validated on real D1', async () => {
  assert.equal(typeof load, 'function');
  const h = await fixture();
  try {
    for (const value of ['{bad', '{"schema":2,"revision":0,"channels":[],"rules":[]}']) {
      await h.db.prepare("INSERT OR REPLACE INTO settings VALUES ('notification_config', ?)").bind(value).run();
      await assert.rejects(load(h.db), { code: 'notification_config_invalid' });
      await assert.rejects(save(h.db, { expectedRevision: 0, channels: [], rules: [] }), { code: 'notification_config_invalid' });
    }
    await h.db.prepare("DELETE FROM settings WHERE key='notification_config'").run();
    const safe = await save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] });
    await assert.rejects(save(h.db, { expectedRevision: 1, channels: safe.channels, rules: [{ ...rule(safe.channels[0].id), scope: { mode: 'selected', serverIds: ['foreign'] } }] }), { code: 'notification_config_invalid' });
  } finally { await h.close(); }
});

test('real authenticated admin actions enforce auth, strict input, CAS 409, masking and legacy write protection', async () => {
  const h = await fixture();
  try {
    assert.equal((await h.action('get_notification_config', {}, false)).status, 401);
    const get = await h.action('get_notification_config');
    assert.equal(get.status, 200, 'notification admin action is missing');
    assert.equal(JSON.stringify(await get.json()).includes('legacy-secret'), false);
    assert.equal((await h.action('save_notification_config', { expectedRevision: '0', channels: [], rules: [] })).status, 400);
    const response = await h.action('save_notification_config', { expectedRevision: 0, channels: [channel()], rules: [] });
    assert.equal(response.status, 200);
    const safe = await response.json();
    assert.equal(JSON.stringify(safe).includes('fixture-secret'), false);
    assert.equal((await h.action('save_notification_config', { expectedRevision: 0, channels: [], rules: [] })).status, 409);
    assert.equal((await h.action('save_notification_config', { expectedRevision: 1, channels: safe.channels, rules: [{ ...rule(safe.channels[0].id), scope: { mode: 'selected', serverIds: ['other-site-node'] } }] })).status, 400);
    assert.equal((await h.action('save_settings', { settings: { tg_bot_token: 'do-not-write' } })).status, 409);
    await assert.rejects(saveSiteOptions(h.db, { tg_notify: '9' }), /notification_config_authoritative/);
    await saveSiteOptions(h.db, { show_price: 'false' });
    assert.equal((await load(h.db)).revision, 1);
  } finally { await h.close(); }
});

test('draft tests merge only same-ID stored secrets, call real sender via fixture fetch and never persist or leak errors', async () => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url: String(url), options }); return new Response('{"ok":true}'); };
  try {
    const response = await h.action('save_notification_config', { expectedRevision: 0, channels: [channel()], rules: [] });
    assert.equal(response.status, 200);
    const safe = await response.json();
    assert.equal(requests.length, 0);
    assert.equal((await h.action('test_notification_channel', { channel: safe.channels[0] }, false)).status, 401);
    assert.equal((await h.action('test_notification_channel', { channel: safe.channels[0] })).status, 200);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /fixture-secret/);
    assert.match(JSON.parse(requests[0].options.body).text, /CF|test|测试/);
    assert.equal((await load(h.db)).revision, 1);
    assert.equal((await h.action('test_notification_channel', { channel: { ...safe.channels[0], id: 'foreign-channel' } })).status, 400);
    globalThis.fetch = async () => new Response('secret-url-and-token', { status: 400 });
    const failure = await h.action('test_notification_channel', { channel: safe.channels[0] });
    assert.equal(failure.status, 502);
    const text = await failure.text();
    assert.equal(text.includes('fixture-secret'), false);
    assert.equal(text.includes('secret-url-and-token'), false);
  } finally { globalThis.fetch = originalFetch; await h.close(); }
});

test('authoritative migration cannot expose its same credentials through the older get_settings DTO', async () => {
  const h = await fixture();
  try {
    const migrated = await load(h.db);
    await save(h.db, { expectedRevision: 0, channels: migrated.channels.map(({ secrets, ...c }) => c), rules: migrated.rules });
    const legacyDto = await (await h.action('get_settings')).json();
    assert.equal(JSON.stringify(legacyDto).includes('legacy-secret'), false);
    assert.equal('notification_config' in legacyDto.settings, false);
    assert.equal('notification_config' in await loadSiteSettings(h.db, true), false);
    const row = await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first();
    assert.equal(JSON.parse(row.value).notification_config, undefined);
  } finally { await h.close(); }
});

test('real D1 CAS rejects a removed snapshot instead of recreating it at a stale revision', async () => {
  const h = await fixture();
  try {
    const safe = await save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] });
    const db = { prepare(sql) {
      const stmt = h.db.prepare(sql);
      if (!sql.startsWith('INSERT INTO settings')) return stmt;
      return { bind(...args) { return { async run() {
        await h.db.prepare("DELETE FROM settings WHERE key='notification_config'").run();
        return stmt.bind(...args).run();
      } }; } };
    } };
    await assert.rejects(save(db, { expectedRevision: 1, channels: safe.channels, rules: [] }), { code: 'notification_revision_conflict' });
    assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='notification_config'").first(), null);
  } finally { await h.close(); }
});

test('SMTP parser boundary and Webhook sender formats are reused without network during save', async () => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('OK'); };
  try {
    const smtp = { name: 'Mail', type: 'smtp', enabled: true, config: { host: 'mail.example.test', port: 587, username: 'user@example.test', from: 'user@example.test', to: 'ops@example.test', secure: 'starttls' }, secrets: { password: 'mail-fixture-secret' }, template: '{{message}}' };
    for (const config of [{ ...smtp.config, port: 25 }, { ...smtp.config, to: 'invalid' }, { ...smtp.config, secure: 'off' }, { ...smtp.config, host: 'user:{{PASSWORD_68lwi01z}}@example.test' }]) {
      assert.equal((await h.action('save_notification_config', { expectedRevision: 0, channels: [{ ...smtp, config }], rules: [] })).status, 400);
    }
    assert.equal((await h.action('save_notification_config', { expectedRevision: 0, channels: [smtp], rules: [] })).status, 200);
    assert.equal(calls.length, 0);
    for (const [method, format, body] of [['POST', 'json', '{"text":"{{message}}"}'], ['POST', 'form', '{"text":"{{message}}"}'], ['GET', 'text', 'text={{message}}']]) {
      const webhook = { name: 'Hook', type: 'webhook', enabled: true, config: { method, format, body }, secrets: { url: 'https://fixture.example.test/hook?token=fixture-url-secret', headers: 'X-Fixture: header-fixture-secret' }, template: '{{event}} {{message}}' };
      const result = await h.action('test_notification_channel', { channel: webhook });
      assert.equal(result.status, 200);
      const call = calls.at(-1);
      assert.equal(call.options.method, method);
      assert.equal(call.options.headers['X-Fixture'], 'header-fixture-secret');
      if (method === 'GET') assert.ok(new URL(call.url).searchParams.has('text'));
      else if (format === 'json') assert.equal(typeof JSON.parse(call.options.body).text, 'string');
      else assert.ok(new URLSearchParams(call.options.body).has('text'));
    }
    assert.equal((await load(h.db)).revision, 1);
    assert.equal((await load(h.db)).channels[0].type, 'smtp');
  } finally { globalThis.fetch = originalFetch; await h.close(); }
});

test('malformed API JSON never returns or logs secret-bearing syntax error fragments', async () => {
  const h = await fixture();
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const response = await h.rawAction('{"action":"save_notification_config","token":"fixture-syntax-secret"} trailing');
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes('fixture-syntax-secret'), false);
    assert.equal(errors.join('').includes('fixture-syntax-secret'), false);
    assert.equal(errors.length, 0);
  } finally { console.error = originalError; await h.close(); }
});

test('old scalar writes cannot race the first new-config save on actual D1', async () => {
  const h = await fixture();
  try {
    const db = { prepare(sql) {
      const stmt = h.db.prepare(sql);
      if (!sql.includes('INSERT INTO settings')) return stmt;
      return { bind(...args) { return { async run() {
        await save(h.db, { expectedRevision: 0, channels: [], rules: [] });
        return stmt.bind(...args).run();
      } }; } };
    } };
    await assert.rejects(saveSiteOptions(db, { tg_notify: '9' }), /notification_config_authoritative/);
    const stored = await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first();
    assert.equal(JSON.parse(stored.value).tg_notify, '5');
  } finally { await h.close(); }
});

test('invalid Webhook transport is rejected using the existing parser and no secret exception text escapes', async () => {
  const h = await fixture();
  try {
    const c = { name: 'Hook', type: 'webhook', enabled: true, config: { method: 'POST', format: 'json', body: 'bad-json-fixture-secret' }, secrets: { url: 'https://fixture.example.test/hook?token=fixture-url-secret', headers: '{bad-secret-header' }, template: '{{message}}' };
    const response = await h.action('save_notification_config', { expectedRevision: 0, channels: [c], rules: [] });
    assert.equal(response.status, 400);
    const text = await response.text();
    for (const value of ['fixture-url-secret', 'bad-json-fixture-secret', 'bad-secret-header']) assert.equal(text.includes(value), false);
  } finally { await h.close(); }
});

test('draft testing rejects coerced enabled flags and save rejects null secret/clear/update metadata', async () => {
  const h = await fixture();
  try {
    assert.equal((await h.action('test_notification_channel', { channel: { ...channel(), enabled: 'true' } })).status, 400);
    for (const input of [
      { channels: [{ ...channel(), secrets: null }] }, { channels: [{ ...channel(), clearSecrets: null }] },
      { secretUpdates: null }, { timezone: null }, { language: null }
    ]) assert.equal((await h.action('save_notification_config', { expectedRevision: 0, channels: [channel()], rules: [], ...input })).status, 400);
    assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='notification_config'").first(), null);
  } finally { await h.close(); }
});

test('untrusted storage error properties never become credential-bearing API output', async () => {
  const db = { prepare() { const error = new Error('fixture-storage-secret'); error.status = 400; error.code = 'fixture-error-secret'; throw error; } };
  const sys = { jwt_secret: 'a'.repeat(64), password: 'fixture-password' };
  const env = { DB: db, API_SECRET: 'fixture-report-secret' };
  const token = await generateToken(env, sys);
  const response = await handleAdminAPI(new Request('https://fixture.test/admin/api', { method: 'POST', headers: { Cookie: `cfsm_auth=${encodeURIComponent(token)}` }, body: '{"action":"get_notification_config"}' }), env, sys);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes('fixture-storage-secret'), false);
  assert.equal(text.includes('fixture-error-secret'), false);
});

test('deleted stored selected nodes remain readable/editable without broadening or transplanting history', async () => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}'); };
  try {
    await h.db.prepare("INSERT INTO servers VALUES ('node-b')").run();
    let safe = await save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] });
    const selected = { ...rule(safe.channels[0].id), scope: { mode: 'selected', serverIds: ['node-a'] } };
    safe = await save(h.db, { expectedRevision: 1, channels: safe.channels, rules: [selected] });
    await h.db.prepare("DELETE FROM servers WHERE id='node-a'").run();
    const before = await h.db.prepare("SELECT value FROM settings WHERE key='notification_config'").first();
    const queries = [];
    const tracked = { prepare(sql) { queries.push(sql); return h.db.prepare(sql); } };
    const loaded = await load(tracked);
    assert.equal(loaded.revision, 2);
    assert.deepEqual(loaded.rules[0].scope, { mode: 'selected', serverIds: ['node-a'] });
    assert.deepEqual(await h.db.prepare("SELECT value FROM settings WHERE key='notification_config'").first(), before);
    assert.ok(queries.every(sql => !/WHERE\s+(?:servers\.)?id\s*=/i.test(sql)), 'read only current ID list, never a missing-node lookup');
    const get = await h.action('get_notification_config');
    assert.equal(get.status, 200);
    assert.deepEqual((await get.json()).rules[0].scope, selected.scope);
    const unrelated = { ...rule(safe.channels[0].id), id: 'unrelated', name: 'Other rule', scope: { mode: 'selected', serverIds: ['node-b'] } };
    const edit = await h.action('save_notification_config', { expectedRevision: 2, channels: [{ ...safe.channels[0], name: 'Renamed', template: '{{event}}' }], rules: [...safe.rules, unrelated] });
    assert.equal(edit.status, 200);
    safe = await edit.json();
    assert.equal(safe.revision, 3);
    assert.equal(safe.channels[0].name, 'Renamed');
    assert.deepEqual(safe.rules[0].scope, selected.scope);
    assert.deepEqual(safe.rules.find(r => r.id === 'unrelated').scope.serverIds, ['node-b']);
    assert.equal(calls.length, 0);
    assert.equal((await h.action('test_notification_channel', { channel: safe.channels[0] })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await load(h.db)).revision, 3);
    for (const changed of [
      { ...safe.rules[0], id: 'copied' }, { ...safe.rules[0], type: 'traffic', options: { threshold: 80 } },
      { ...safe.rules[0], scope: { mode: 'selected', serverIds: ['node-a', 'node-b'] } },
      { ...safe.rules[0], scope: { mode: 'selected', serverIds: ['node-a', 'foreign'] } },
      { ...safe.rules[0], scope: { mode: 'all', serverIds: [] } }
    ]) {
      await assert.rejects(save(h.db, { expectedRevision: 3, channels: safe.channels, rules: [changed] }), { code: 'notification_config_invalid' });
      assert.equal((await load(h.db)).revision, 3);
    }
    safe = await save(h.db, { expectedRevision: 3, channels: safe.channels, rules: [{ ...safe.rules[0], name: 'Rule rename', scope: { mode: 'selected', serverIds: ['node-b'] } }] });
    assert.deepEqual(safe.rules[0].scope.serverIds, ['node-b']);
  } finally { globalThis.fetch = originalFetch; await h.close(); }
});

test('stale legacy resource selection retains revision-zero read-only scope and can be confirmed safely', async () => {
  const h = await fixture();
  try {
    await h.db.prepare("UPDATE settings SET value=? WHERE key='site_options'").bind(JSON.stringify({ tg_bot_token: '123:fixture', tg_chat_id: '42', resource_alert_rules: [{ id: 'resource-stale', name: 'CPU', metric: 'cpu', threshold: 80, servers: ['deleted-node'], intervalMinutes: 5, mode: 'average' }] })).run();
    const rawBefore = await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first();
    const get = await h.action('get_notification_config');
    assert.equal(get.status, 200);
    const view = await get.json();
    assert.equal(view.revision, 0);
    assert.deepEqual(view.rules.find(r => r.type === 'resource').scope, { mode: 'selected', serverIds: ['deleted-node'] });
    assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='notification_config'").first(), null);
    assert.deepEqual(await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first(), rawBefore);
    const saved = await h.action('save_notification_config', { expectedRevision: 0, channels: [{ ...view.channels[0], template: '{{event}}' }], rules: view.rules });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).rules.find(r => r.type === 'resource').scope.serverIds, ['deleted-node']);
  } finally { await h.close(); }
});

test('explicit null channel secretUpdates reject in D1 and API without advancing revision', async () => {
  const h = await fixture();
  try {
    const safe = await save(h.db, { expectedRevision: 0, channels: [channel()], rules: [] });
    for (const value of [null, undefined, [], 'not-an-object', 0]) {
      const input = { expectedRevision: 1, channels: safe.channels, rules: [], secretUpdates: { [safe.channels[0].id]: value } };
      await assert.rejects(save(h.db, input), { code: 'notification_config_invalid' });
      if (value !== undefined) assert.equal((await h.action('save_notification_config', input)).status, 400);
      assert.equal((await load(h.db)).revision, 1);
    }
    assert.equal((await load(h.db)).channels[0].secrets.botToken, 'fixture-secret');
  } finally { await h.close(); }
});

test('provider mismatches reject before save/test transport and legitimate providers retain real payload shape', async () => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('OK'); };
  try {
    for (const [type, token] of [['feishu', 'onebot:https://fixture.example.test/send_group_msg'], ['dingtalk', 'bark:https://self-hosted.example.test/key'], ['feishu', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture'], ['dingtalk', 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture']]) {
      const c = { name: 'Wrong', type, enabled: true, config: {}, secrets: { token }, template: '{{message}}' };
      assert.equal((await h.action('save_notification_config', { expectedRevision: 0, channels: [c], rules: [] })).status, 400);
      assert.equal((await h.action('test_notification_channel', { channel: c })).status, 400);
    }
    assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='notification_config'").first(), null);
    assert.equal(calls.length, 0);
    const providers = [
      { name: 'OneBot', type: 'onebot', enabled: true, config: { chatId: '42' }, secrets: { token: 'onebot:http://127.0.0.1:3000/send_group_msg?access_token=fixture' }, template: '{{message}}' },
      { name: 'Feishu', type: 'feishu', enabled: true, config: {}, secrets: { token: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture' }, template: '{{message}}' },
      { name: 'Bark', type: 'bark', enabled: true, config: {}, secrets: { token: 'bark:https://self-hosted.example.test/key' }, template: '{{message}}' }
    ];
    for (const c of providers) assert.equal((await h.action('test_notification_channel', { channel: c })).status, 200);
    assert.equal(JSON.parse(calls[0].options.body).group_id, '42');
    assert.equal(JSON.parse(calls[1].options.body).msg_type, 'interactive');
    assert.equal(calls[2].url, 'https://self-hosted.example.test/key');
    assert.equal(typeof JSON.parse(calls[2].options.body).markdown, 'string');
    assert.equal((await h.action('save_notification_config', { expectedRevision: 0, channels: providers, rules: [] })).status, 200);
    assert.equal(calls.length, 3, 'save is never a transport probe');
  } finally { globalThis.fetch = originalFetch; await h.close(); }
});

test('zero global migration is routing metadata: only positive per-node traffic overrides emit existing alerts', async () => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}'); };
  try {
    await h.db.prepare('ALTER TABLE servers ADD COLUMN traffic_alert_state TEXT').run();
    await saveSiteOptions(h.db, { traffic_alert_threshold: '0', tg_bot_token: '123:fixture' });
    const view = await load(h.db);
    assert.ok(view.rules.find(r => r.type === 'traffic'), 'global-zero migration must preserve the traffic route');
    assert.deepEqual(view.rules.find(r => r.type === 'traffic').options, { threshold: 0 });
    assert.equal(view.rules.find(r => r.type === 'traffic').enabled, true);
    for (const [id, pct] of [['override', 80], ['follow', null], ['off', 0]]) {
      await h.db.prepare('INSERT INTO servers (id) VALUES (?)').bind(id).run();
      await evaluateTrafficAlert({ DB: h.db }, { id, name: id, traffic_limit: '100', traffic_calc_type: 'total', traffic_alert_percent: pct, traffic_alert_state: null }, { net_rx_monthly: 90 * 1024 ** 3, net_tx_monthly: 0 });
    }
    assert.equal(calls.length, 1);
    assert.match(JSON.parse(calls[0].options.body).text, /override/);
    assert.ok((await h.db.prepare("SELECT traffic_alert_state FROM servers WHERE id='override'").first()).traffic_alert_state);
    for (const id of ['follow', 'off']) assert.equal((await h.db.prepare('SELECT traffic_alert_state FROM servers WHERE id=?').bind(id).first()).traffic_alert_state, null);
  } finally { globalThis.fetch = originalFetch; await h.close(); }
});
