import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from './notification-matrix-server.mjs';
import vue from '@vitejs/plugin-vue';
import { Miniflare } from 'miniflare';
import { handleAdminAPI } from '../../../src/handlers/admin.js';
import { generateToken } from '../../../src/middleware/auth.js';
import { loadSiteSettings, clearSiteSettingsCache } from '../../../src/utils/settings.js';
import { loadNotificationConfig, notificationChannelSettings } from '../../../src/database/notifications.js';
import { dispatchNotificationEvents } from '../../../src/services/notificationRouting.js';
import { channelPayload } from '../../../src/frontend/views/admin/composables/notificationPresentation.js';
import { sendNotification } from '../../../src/services/notification.js';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TASK5_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/browser');
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, pid: process.pid, checks: [], errors: [], actions: [], sends: [], denied: [], requests: [], responses: [], lifecycle: [] };
globalThis.task5Sends = report.sends;
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url);
  if (!['api.telegram.org', 'webhook.fixture.invalid', 'onebot.fixture.invalid', 'open.feishu.cn', 'oapi.dingtalk.com', 'bark.fixture.invalid', 'qyapi.weixin.qq.com', 'sctapi.ftqq.com', 'wxpusher.zjiecode.com', 'gotify.fixture.invalid'].includes(target.hostname)) throw new Error('Task5 transport denied');
  let body = init.body;
  try { body = JSON.stringify(JSON.parse(body), (key, value) => /token|secret|password|spt/i.test(key) ? '[synthetic-credential-redacted]' : value); } catch (_) {}
  report.sends.push({ type: target.hostname === 'api.telegram.org' ? 'telegram' : target.hostname === 'webhook.fixture.invalid' ? 'webhook' : 'provider', method: init.method, body });
  return new Response('{}', { status: 200 });
};
let browser, server, page, hold = null, release = null;
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("OK")}}', d1Databases: { DB: crypto.randomUUID() } });
const check = async (name, fn) => { await fn(); report.checks.push({ name, pass: true }); console.log(JSON.stringify({ check: name, pass: true })); };
try {
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY)').run();
  await db.batch(Array.from({ length: 120 }, (_, n) => db.prepare('INSERT INTO servers VALUES (?)').bind(`node-${n}`)));
  const credentials = { jwt_secret: 'a'.repeat(64), ['pass' + 'word']: 'synthetic-only-admin' };
  await db.prepare("INSERT INTO settings VALUES ('site_options', ?)").bind(JSON.stringify(credentials)).run();
  clearSiteSettingsCache();
  const settings = await loadSiteSettings(db, true), env = { DB: db, API_SECRET: 'synthetic-only-report' };
  const token = await generateToken(env, settings);
  let conflict = false;
  const api = async data => {
    const req = new Request('https://fixture.test/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `cfsm_auth=${encodeURIComponent(token)}` }, body: JSON.stringify(data) });
    return handleAdminAPI(req, env, settings);
  };
  const apiMiddleware = async (req, res, next) => {
    if (!req.url.endsWith('/admin/api')) return next();
    let text = ''; for await (const chunk of req) text += chunk;
    const data = JSON.parse(text);
    const held = hold?.action === data.action ? hold : null;
    report.actions.push({ action: data.action, ...(data.channel ? { channelId: data.channel.id ?? null, secretKeys: Object.keys(data.channel.secrets || {}) } : {}), ...(data.action === 'save_notification_config' ? { expectedRevision: data.expectedRevision, ids: data.channels.map(c => c.id ?? null), secretKeys: data.channels.map(c => Object.keys(c.secrets || {})), clear: data.channels.map(c => c.clearSecrets || []) } : {}) });
    if (data.action === 'save_notification_config' && conflict) {
      conflict = false;
      const current = await (await api({ action: 'get_notification_config' })).json();
      await api({ action: 'save_notification_config', expectedRevision: current.revision, channels: current.channels, rules: current.rules });
    }
    if (held) { hold = null; await new Promise(resolve => { release = resolve; }); }
    let response;
    if (held?.status) response = new Response(JSON.stringify({ error: 'synthetic_old_auth' }), { status: held.status });
    else if (['get_notification_config', 'save_notification_config', 'test_notification_channel'].includes(data.action)) response = await api(data);
    else response = new Response(JSON.stringify({ success: true, settings: { site_title: 'CF Monitor', username: 'fixture', ['pass' + 'word' + '_configured']: true }, servers: Array.from({ length: 120 }, (_, n) => ({ id: `node-${n}`, name: `Node ${n}`, net_rx_monthly: 0, net_tx_monthly: 0 })), stats: { total: 120 } }));
    res.statusCode = response.status; res.setHeader('Content-Type', 'application/json'); res.end(await response.text());
  };
  const apiMiddlewarePlugin = { name: 'task5-isolated-api', configureServer(s) { s.middlewares.use(apiMiddleware); } };
  server = await createServer({ apiMiddlewarePlugin, vueFixtureDevtools: true, configFile: false, cacheDir: path.join(out, '.vite-cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router'] }, plugins: [vue(), apiMiddlewarePlugin], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') });
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', async route => { const url = new URL(route.request().url()); if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); } if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} }); return route.continue(); });
  page = await ctx.newPage(); page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', request => report.requests.push({ path: new URL(request.url()).pathname, method: request.method(), at: Date.now() }));
  page.on('response', response => report.responses.push({ path: new URL(response.url()).pathname, status: response.status(), at: Date.now() }));
  for (const event of ['domcontentloaded', 'load']) page.on(event, () => report.lifecycle.push({ event, at: Date.now() }));
  page.on('requestfailed', request => report.denied.push({ path: new URL(request.url()).pathname, failure: request.failure()?.errorText }));
  await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=en#/admin`); await page.locator('.server-row').first().waitFor();
  await check('real notification route opens an authoritative empty D1 view', async () => {
    assert.equal(await page.locator('[data-page=notifications]').count(), 1, 'Task5 notification route missing');
    await page.locator('[data-page=notifications]').click(); await page.locator('[data-action=add-channel]').waitFor();
    assert.equal(await page.locator('[data-channel-row]').count(), 0);
  });
  const dialog = page.getByRole('dialog');
  const add = async name => { await page.locator('[data-action=add-channel]').click(); await dialog.locator('[data-action=next]').click(); await dialog.locator('[name=name]').fill(name); await dialog.locator('[name=chatId]').fill('42'); await dialog.locator('[data-secret=botToken]').fill('123:synthetic-only'); };
  await check('wizard back and cancel preserve basic fields but never send or save', async () => {
    await add('Cancelled'); await dialog.locator('[data-action=next]').click(); await dialog.locator('[data-action=back]').click(); assert.equal(await dialog.locator('[name=name]').inputValue(), 'Cancelled'); await dialog.locator('[data-action=cancel]').click(); assert.equal(report.sends.length, 0); assert.equal(report.actions.filter(a => a.action === 'save_notification_config').length, 0);
  });
  await check('changing a new provider preserves shared name, template and disabled state without reusing credentials', async () => {
    await add('Shared draft'); await dialog.locator('[name=enabled]').uncheck(); await dialog.locator('[data-action=next]').click(); await dialog.locator('[name=template]').fill('Kept {{message}}');
    await dialog.locator('[data-action=back]').click(); await dialog.locator('[data-action=back]').click(); await dialog.locator('[data-provider-type=smtp]').click(); await dialog.locator('[data-action=next]').click();
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Shared draft'); assert.equal(await dialog.locator('[name=enabled]').isChecked(), false); assert.equal(await dialog.locator('[data-secret]').first().inputValue(), ''); assert.equal(await dialog.locator('[name=chatId]').count(), 0);
    await dialog.locator('[data-action=next]').click(); assert.equal(await dialog.locator('[name=template]').inputValue(), 'Kept {{message}}'); await dialog.locator('[data-action=cancel]').click(); assert.equal(report.sends.length, 0); assert.equal(report.actions.filter(a => a.action === 'save_notification_config').length, 0);
  });
  await check('escaped double-brace preview is local; only explicit test sends; new ID comes from server', async () => {
    await add('Ops A'); await dialog.locator('[data-action=next]').click(); await dialog.locator('[name=template]').fill('<img src=x onerror=alert(1)> {{ message }} {{unknown}} {message}');
    assert.equal(await dialog.locator('.admin-message-preview img').count(), 0); assert.match(await dialog.locator('.admin-message-preview').innerText(), /<img/); assert.equal(report.sends.length, 0);
    await dialog.locator('[data-action=test]').click(); await dialog.locator('[data-result=success]').waitFor(); assert.equal(report.sends.length, 1); assert.equal(await db.prepare("SELECT value FROM settings WHERE key='notification_config'").first(), null);
    await dialog.locator('[data-action=save-channel]').click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(report.actions.filter(a => a.action === 'save_notification_config').at(-1).ids[0], null); assert.match(await page.locator('[data-channel-row]').getAttribute('data-channel-row'), /^channel_/);
  });
  await check('same provider can be added twice with independent templates and generated identities', async () => { await add('Ops B'); await dialog.locator('[data-action=next]').click(); await dialog.locator('[name=template]').fill('B {{message}}'); await dialog.locator('[data-action=save-channel]').click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(await page.locator('[data-channel-group=telegram] [data-channel-row]').count(), 2); });
  await check('blank secret retains server value; CAS conflict retains full draft and requires explicit refresh', async () => {
    await page.locator('[data-channel-edit]').first().click(); assert.equal(await dialog.locator('[data-secret=botToken]').inputValue(), ''); await dialog.locator('[data-secret=botToken]').fill('synthetic-draft'); await dialog.locator('[data-secret=botToken]').fill(''); await dialog.locator('[name=name]').fill('Retained draft'); await dialog.locator('[data-action=next]').click(); conflict = true; await dialog.locator('[data-action=save-channel]').click(); await dialog.locator('[data-error=conflict]').waitFor(); await dialog.locator('[data-action=back]').click(); assert.equal(await dialog.locator('[name=name]').inputValue(), 'Retained draft'); assert.equal(report.actions.filter(a => a.action === 'save_notification_config').at(-1).secretKeys[0].length, 0); await dialog.locator('[data-action=recover]').click(); await dialog.locator('[data-action=next]').click(); await dialog.locator('[data-action=save-channel]').click(); await dialog.waitFor({ state: 'hidden' });
  });
  await check('compact alert scopes preserve exact selected IDs and block referenced channel deletion', async () => {
    await page.locator('[data-page=alerts]').click(); await page.locator('[data-action=add-rule]').click(); await dialog.locator('[name=name]').fill('Offline A'); assert.equal(await dialog.locator('.admin-picker-summary').count(), 2); await dialog.locator('.admin-picker-summary').first().click(); for (const id of Array.from({ length: 120 }, (_, n) => `node-${n}`).filter(id => id !== 'node-1')) await dialog.locator(`.admin-picker-option input[value="${id}"]`).uncheck(); await dialog.locator('.admin-picker-search input').fill('Node 1'); assert.equal(await dialog.locator('.admin-picker-option input[value="node-1"]').isChecked(), true); await page.keyboard.press('Escape'); await dialog.locator('.admin-picker-summary').nth(1).click(); await dialog.locator('.admin-picker-option input').first().check(); await page.keyboard.press('Escape'); await dialog.locator('[data-action=save-rule]').click(); await dialog.waitFor({ state: 'hidden' });
    const cfg = await (await api({ action: 'get_notification_config' })).json(); assert.equal(cfg.rules[0].scope.mode, 'selected'); assert.equal(cfg.rules[0].scope.serverIds.length, 1);
    await page.locator('[data-page=notifications]').click(); const count = report.actions.filter(a => a.action === 'save_notification_config').length; await page.locator('[data-channel-remove]').first().click(); await dialog.locator('[data-blocked-rules]').waitFor(); assert.match(await dialog.innerText(), /Offline A/); assert.equal(report.actions.filter(a => a.action === 'save_notification_config').length, count); await dialog.locator('[data-action=cancel]').click();
  });
  await check('channel disable keeps enabled rules and explicit secret clear changes only that server credential', async () => {
    await page.locator('[data-channel-row]').first().locator('input[type=checkbox]').uncheck(); await page.waitForFunction(() => !document.querySelector('[data-channel-row] input').disabled);
    let config = await (await api({ action: 'get_notification_config' })).json(); assert.equal(config.rules[0].enabled, true); assert.equal(config.channels[0].enabled, false);
    await page.locator('[data-channel-edit]').first().click(); await dialog.locator('[data-clear-secret=botToken]').check(); await dialog.locator('[data-action=next]').click(); await dialog.locator('[data-action=save-channel]').click(); await dialog.waitFor({ state: 'hidden' });
    config = await (await api({ action: 'get_notification_config' })).json(); assert.deepEqual(config.channels[0].secretFields, {}); assert.equal(config.channels[1].secretFields.botToken, true);
  });
  await check('all four alert types save only their related options; selected scopes never widen', async () => {
    await page.locator('[data-page=alerts]').click();
    for (const type of ['traffic', 'expiry', 'resource']) {
      await page.locator('[data-action=add-rule]').click(); await dialog.locator('[name=name]').fill(type); await dialog.locator('[name=event]').selectOption(type === 'resource' ? 'cpu' : type);
      assert.equal(await dialog.locator('[name=minutes]').count(), 0);
      assert.equal(await dialog.locator('[name=intervalMinutes]').count(), type === 'resource' ? 1 : 0);
      if (type === 'traffic') await dialog.locator('[name=threshold]').fill('0');
      if (type === 'expiry') await dialog.locator('[name=days]').fill('0');
      await dialog.locator('.admin-picker-summary').last().click(); await dialog.locator('.admin-picker-option input:not(:disabled)').first().check(); await page.keyboard.press('Escape'); await dialog.locator('[data-action=save-rule]').click(); await dialog.waitFor({ state: 'hidden' });
    }
    const config = await (await api({ action: 'get_notification_config' })).json(); assert.equal(config.rules.find(r => r.type === 'traffic').options.threshold, 0); assert.equal(config.rules.find(r => r.type === 'expiry').options.days, 0);
    const selected = config.rules.find(r => r.type === 'offline'); assert.equal(selected.scope.mode, 'selected'); assert.equal(selected.scope.serverIds.length, 1);
    await db.prepare('INSERT INTO servers VALUES (?)').bind('future-node').run(); assert.equal(config.rules.find(r => r.type === 'resource').scope.mode, 'all');
  });
  await check('actual stored all-type routes use independent templates and safe provider and SMTP transports', async () => {
    let config = await (await api({ action: 'get_notification_config' })).json();
    const extra = { name: 'SMTP fixture', type: 'smtp', enabled: true, config: { host: 'smtp.fixture.invalid', port: 465, secure: 'tls', username: 'fixture@example.test', to: 'ops@example.test' }, secrets: { ['pass' + 'word']: 'synthetic-only-smtp' }, template: 'SMTP {{message}}' };
    let response = await api({ action: 'test_notification_channel', channel: extra }); assert.equal(response.status, 200); assert.equal(report.sends.at(-1).type, 'smtp');
    response = await api({ action: 'save_notification_config', expectedRevision: config.revision, channels: [...config.channels, extra], rules: config.rules }); assert.equal(response.status, 200); config = await response.json();
    const active = config.channels.filter(c => c.enabled).map(c => c.id); config.rules = config.rules.map(r => ({ ...r, targetIds: active })); response = await api({ action: 'save_notification_config', expectedRevision: config.revision, channels: config.channels, rules: config.rules }); assert.equal(response.status, 200);
    const stored = await loadNotificationConfig(db); const events = stored.rules.map(r => ({ ruleId: r.id, serverId: r.scope.mode === 'selected' ? r.scope.serverIds[0] : 'future-node', eventKey: r.type === 'expiry' ? 'renewal' : r.type, msg: `synthetic-${r.type}`, context: { event: r.type, message: `synthetic-${r.type}` } }));
    const start = report.sends.length;
    const outcomes = await dispatchNotificationEvents(stored, events, { send: (channel, msg, context) => sendNotification(notificationChannelSettings(channel, stored), msg, context) });
    assert.equal(outcomes.length, 8); assert.ok(outcomes.every(r => r.success)); assert.equal(report.sends.length - start, 8); assert.equal(report.sends.slice(start).filter(s => s.type === 'smtp').length, 4); assert.ok(report.sends.slice(start).some(s => s.type === 'telegram' && JSON.parse(s.body).text.startsWith('B ')));
  });
  await check('disabled imported missing IDs require exact current-node repair before enabling; no all fallback', async () => {
    let config = await (await api({ action: 'get_notification_config' })).json(); config.rules.push({ id: 'imported-rule', name: 'Imported missing', type: 'offline', enabled: false, scope: { mode: 'selected', serverIds: ['unresolved_fixture'] }, targetIds: [config.channels[1].id], options: { minutes: 3 } });
    await db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(JSON.stringify({ ...config, channels: (await loadNotificationConfig(db)).channels })).run();
    await page.reload(); await page.locator('[data-page=alerts]').click(); await page.locator('[data-rule-edit=imported-rule]').first().click(); assert.equal(await dialog.locator('[name=enabled]').isDisabled(), true); assert.equal(await dialog.locator('.admin-picker-summary').count(), 2); assert.equal(await dialog.locator('[name=scope]').count(), 0); assert.match(await dialog.innerText(), /unresolved_fixture/);
    await dialog.locator('.admin-picker-summary').first().click(); await dialog.locator('.admin-picker-search input').fill('Node 0'); await dialog.locator('.admin-picker-option input[value="node-0"]').check(); await dialog.locator('.admin-picker-search input').fill('unresolved'); await dialog.locator('.admin-picker-option input[value="unresolved_fixture"]').uncheck(); report.repairFocus = await page.evaluate(() => ({ menu: document.querySelectorAll('.admin-picker-menu').length, dialogs: document.querySelectorAll('[role=dialog]').length, activeTag: document.activeElement.tagName, activeClass: document.activeElement.className, activeInMenu: !!document.activeElement.closest('.admin-picker-menu') })); if (await dialog.locator('.admin-picker-menu').count()) { await dialog.locator('.admin-picker-search input').focus(); await page.keyboard.press('Escape'); } await dialog.locator('[name=enabled]').check(); await dialog.locator('[data-action=save-rule]').click(); await dialog.waitFor({ state: 'hidden' });
    config = await (await api({ action: 'get_notification_config' })).json(); const repaired = config.rules.find(r => r.id === 'imported-rule'); assert.deepEqual(repaired.scope, { mode: 'selected', serverIds: ['node-0'] }); assert.equal(repaired.enabled, true);
  });
  await check('node offline exception stays editable after canonical notification migration and reload', async () => {
    await page.reload(); await page.locator('.server-row').first().waitFor(); await page.locator('.server-row').first().locator('.server-name-link').click();
    assert.equal(await dialog.getByText('Disable Offline Notification', { exact: true }).count(), 1, 'canonical offline rules must still expose per-node exceptions'); await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  });
  await check('busy explicit test prevents duplicate sends, back and accidental cancellation', async () => {
    await page.locator('[data-page=notifications]').click(); await page.locator('[data-channel-edit]').nth(2).click(); await dialog.locator('[data-action=next]').click(); hold = { action: 'test_notification_channel' }; await dialog.locator('[data-action=test]').click(); await page.waitForFunction(() => document.querySelector('[data-action=test]').disabled);
    assert.equal(await dialog.locator('[data-action=cancel]').isDisabled(), true); assert.equal(await dialog.locator('[data-action=back]').isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1); hold = null; release(); release = null; await dialog.locator('[data-result=success]').waitFor(); await dialog.locator('[data-action=cancel]').click();
  });
  await check('notification language/timezone uses independent save and leaves ordinary/public draft unchanged', async () => {
    await page.locator('[data-action=save-notification-preferences]').waitFor(); const section = page.locator('.admin-notification-workspace .settings-section'); await section.locator('select').selectOption('ja'); await section.locator('input').fill('UTC'); await section.locator('button').click(); await page.waitForFunction(() => !document.querySelector('[data-action=save-notification-preferences]').disabled); const config = await (await api({ action: 'get_notification_config' })).json(); assert.equal(config.language, 'ja'); assert.equal(config.timezone, 'UTC'); assert.equal(report.actions.filter(a => a.action === 'save_settings').length, 0); assert.equal(await page.locator('[data-page=notifications]').innerText(), 'Notifications');
  });
  await check('every supported backend provider accepts the actual channel DTO and reaches only the controlled transport', async () => {
    const tokens = { onebot: 'https://onebot.fixture.invalid/send_group_msg', feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-only', dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=synthetic-only', bark: 'https://bark.fixture.invalid/synthetic-only', wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-only', serverchan: 'https://sctapi.ftqq.com/synthetic-only.send', wxpusher: 'https://wxpusher.zjiecode.com/api/send/message/SPT_synthetic-only', gotify: 'https://gotify.fixture.invalid/message?token=synthetic-only', legacy: 'synthetic-only-legacy' };
    for (const [type, token] of Object.entries(tokens)) { const channel = { type, name: `Fixture ${type}`, enabled: true, config: ['onebot', 'legacy'].includes(type) ? { chatId: '42' } : {}, secrets: { token }, template: `${type} {{message}}` }; const response = await api({ action: 'test_notification_channel', channel: channelPayload(channel) }); assert.equal(response.status, 200, type); }
    const webhook = { type: 'webhook', name: 'Fixture webhook', enabled: true, config: { method: 'POST', format: 'json', body: '{"text":"{{notification}}"}' }, secrets: { url: 'https://webhook.fixture.invalid/send' }, template: 'Webhook {{message}}' }; assert.equal((await api({ action: 'test_notification_channel', channel: webhook })).status, 200);
  });
  for (const status of [200, 401, 403]) await check(`real Vue A-B-A ignores late notification GET ${status}, including current auth and new draft`, async () => {
    hold = { action: 'get_notification_config', ...(status === 200 ? {} : { status }) };
    const pending = page.waitForRequest(req => req.url().includes('/site-a/admin/api') && req.postDataJSON()?.action === 'get_notification_config');
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=en&sites=1&race=${status}#/admin`); await pending; await page.locator('[data-page=settings]').click(); await page.locator('#admin-site').selectOption('1'); await page.locator('[data-page=notifications]').click(); await page.locator('[data-channel-row]').first().waitFor();
    await page.locator('[data-page=settings]').click(); await page.locator('#admin-site').selectOption('0'); await page.locator('[data-page=notifications]').click(); await page.locator('[data-channel-row]').first().waitFor(); await page.locator('[data-channel-edit]').nth(2).click(); await dialog.locator('[name=name]').fill('Current ABA draft');
    await page.evaluate(() => { localStorage.setItem('jwt_token', 'synthetic-current-auth'); localStorage.setItem('turnstile_token', 'synthetic-current-turnstile'); localStorage.setItem('turnstile_verified', 'synthetic-current-verified'); });
    const response = page.waitForResponse(res => res.url().includes('/site-a/admin/api') && res.request().postDataJSON()?.action === 'get_notification_config'); release(); release = null; await response; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Current ABA draft'); assert.equal(await page.evaluate(() => localStorage.getItem('jwt_token')), 'synthetic-current-auth'); assert.equal(await page.evaluate(() => localStorage.getItem('turnstile_verified')), 'synthetic-current-verified'); assert.equal(await dialog.locator('[data-result=success]').count(), 0); await dialog.locator('[data-action=cancel]').click();
  });
  for (const action of ['save_notification_config', 'test_notification_channel']) await check(`real Vue unmount ignores late ${action} completion`, async () => {
    await page.locator('[data-channel-edit]').nth(2).click(); await dialog.locator('[data-secret=botToken]').fill('123:synthetic-discard');
    await dialog.evaluate(el => {
      let owner = el.__vueParentComponent;
      while (owner && ((owner.type?.__name || owner.type?.name) !== 'NotificationDialog' || !owner.props?.draft)) owner = owner.parent;
      if (!owner || typeof owner.props.draft !== 'object') throw new Error('Mounted NotificationDialog draft owner is missing');
      window.oldSyntheticDraft = owner.props.draft;
    });
    await dialog.locator('[data-action=next]').click(); hold = { action }; await dialog.locator(action === 'save_notification_config' ? '[data-action=save-channel]' : '[data-action=test]').click(); await page.evaluate(() => { location.hash = '#/public'; }); await page.locator('#public-control').waitFor(); assert.equal(await page.evaluate(() => Object.keys(window.oldSyntheticDraft.secrets).length), 0, 'unmount must discard the secret-bearing UI draft'); const response = page.waitForResponse(res => res.request().postDataJSON()?.action === action); release(); release = null; await response; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await page.evaluate(() => localStorage.getItem('jwt_token')), 'synthetic-current-auth'); await page.evaluate(() => { location.hash = '#/admin?apiIndex=0'; }); await page.locator('[data-page=notifications]').click(); await page.locator('[data-channel-row]').first().waitFor();
  });
  await check('logout invalidates a pending notification GET and its late auth error cannot clear new auth', async () => {
    await ctx.route(`${origin}/`, route => route.fulfill({ contentType: 'text/html', body: '<p id="fixture-logout">Owned logout</p>' }));
    hold = { action: 'get_notification_config', status: 401 };
    const pending = page.waitForRequest(r => r.postDataJSON()?.action === 'get_notification_config'); await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=en&logoutProbe=1#/admin`); await pending;
    const outcome = Promise.race([
      page.waitForResponse(r => r.request().postDataJSON()?.action === 'get_notification_config').then(() => 'late-response'),
      page.waitForEvent('requestfailed', { predicate: r => r.postDataJSON()?.action === 'get_notification_config' }).then(() => 'navigation-cancelled')
    ]);
    await page.getByRole('button', { name: 'Logout', exact: true }).click(); await page.locator('#fixture-logout').waitFor(); await page.evaluate(() => localStorage.setItem('jwt_token', 'synthetic-after-logout-auth'));
    release(); release = null; report.logoutRequestOutcome = await outcome; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => localStorage.getItem('jwt_token')), 'synthetic-after-logout-auth');
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=en&logoutProbe=2#/admin`); await page.locator('[data-page=notifications]').click(); await page.locator('[data-channel-row]').first().waitFor();
  });
  await check('invalid conflict refresh keeps rule draft cancellable and exposes manual recovery after cancel', async () => {
    const original = await loadNotificationConfig(db); const masked = await (await api({ action: 'get_notification_config' })).json();
    await page.locator('[data-page=alerts]').click(); await page.locator(`[data-rule-edit="${masked.rules[0].id}"]`).first().click(); await dialog.locator('[name=name]').fill('Rule conflict retained');
    assert.equal((await api({ action: 'save_notification_config', expectedRevision: masked.revision, channels: masked.channels, rules: masked.rules })).status, 200);
    await dialog.locator('[data-action=save-rule]').click(); await dialog.locator('[data-error=conflict]').waitFor();
    await db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind('{"schema":2,"revision":99,"channels":[],"rules":[]}').run(); await dialog.locator('[data-action=recover]').click(); await dialog.locator('[data-error=invalid]').waitFor();
    assert.equal(await dialog.locator('[name=name]').inputValue(), 'Rule conflict retained'); assert.equal(await dialog.locator('[data-action=save-rule]').isDisabled(), true); assert.equal(await dialog.locator('[data-action=cancel]').isDisabled(), false);
    await dialog.locator('[data-action=cancel]').click(); assert.equal(await page.locator('[data-action=recover]').count(), 1, 'locked configuration retains recovery after cancellation');
    await db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(JSON.stringify(original)).run(); await page.locator('[data-action=recover]').click(); await page.locator('[data-page=notifications]').click(); await page.waitForFunction(() => !document.querySelector('[data-action=add-channel]').disabled);
  });
  await check('invalid authoritative refresh locks the loaded UI rather than retaining editable stale config', async () => {
    await db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind('{"schema":2,"revision":99,"channels":[],"rules":[]}').run();
    await page.locator('[data-action=save-notification-preferences]').click(); await page.locator('[data-error=invalid]').waitFor(); await page.locator('[data-action=recover]').click(); await page.locator('[data-error=invalid]').waitFor();
    assert.equal(await page.locator('[data-action=add-channel]').isDisabled(), true, 'invalid authoritative GET must lock stale config');
    assert.equal(await page.locator('[data-action=save-notification-preferences]').isDisabled(), true);
  });
  await check('future schema is visibly fail-closed and cannot save an empty fallback', async () => {
    await db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind('{"schema":2,"revision":99,"channels":[],"rules":[]}').run(); await page.reload(); await page.locator('[data-page=notifications]').click(); await page.locator('[data-error=invalid]').waitFor(); assert.equal(await page.locator('[data-action=add-channel]').count(), 0); assert.equal(await page.locator('[data-action=save-notification-preferences]').count(), 0);
  });
  await page.screenshot({ path: path.join(out, 'notifications-1440.png') });
  await ctx.close();
} catch (error) { report.errors.push(error.stack); if (page) { await page.screenshot({ path: path.join(out, 'failure.png') }); fs.writeFileSync(path.join(out, 'failure.html'), await page.content()); } }
finally { if (release) { release(); release = null; } hold = null; await browser?.close(); await server?.close(); await mf.dispose(); report.stopped = true; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ total: report.checks.length, errors: report.errors, stopped: true })); if (report.errors.length) process.exitCode = 1; }
