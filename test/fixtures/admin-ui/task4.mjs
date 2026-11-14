import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from './notification-matrix-server.mjs';
import vue from '@vitejs/plugin-vue';
import en from '../../../src/frontend/locales/en.js';
import zh from '../../../src/frontend/locales/zh.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const lucideRoot = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/lucide';
const { icons: referenceIcons } = require(lucideRoot);
const executablePath = process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe';
const out = path.resolve(process.env.ADMIN_UI_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-4/browser');
fs.mkdirSync(out, { recursive: true });
const seed = JSON.parse(fs.readFileSync('docs/superpowers/admin-ui-refactor/evidence/task-0/reference-data-viewport-tokens.json', 'utf8'));
const initialServers = seed.nodes.map(n => ({ id: `node-${n.id}`, name: n.name, server_group: n.group, region: n.country, os: n.os, ip_v4: n.ip, price: n.price, expire_date: n.expires, billing_cycle: n.price.includes('\u5e74') ? 'year' : 'month', currency: n.price[0], note: n.note, tags: n.tag, is_online: n.online, agent_version: n.version, traffic_limit: n.limit, net_rx_monthly: n.used * 1024 ** 3, net_tx_monthly: 0, is_hidden: n.id === 6 ? '1' : '0', ...(n.online ? {} : { timestamp: Date.now() - 7200000 }) }));
const report = { node: process.version, pid: process.pid, fixtureServers: initialServers, results: [], actions: [], networkDenied: [], errors: [], downloads: [] };
let server, browser, context, page;
let servers = structuredClone(initialServers), hold, failedAction = '';
const holds = [];
const settings = site => ({ site_title: site === 'b' ? 'Site B' : 'CF Monitor', username: 'fixture', password_configured: true, auto_discovery: true, tg_notify: '5', tg_bot_token: 'smtp:incomplete', notification_config: { schema: 1, revision: 2, channels: [], rules: [] } });
const check = async (name, fn) => {
  try { await fn(); report.results.push({ name, pass: true }); }
  catch (e) { const screenshot = `failure-${report.results.length}.png`; await page?.screenshot({ path: path.join(out, screenshot) }).catch(() => {}); report.results.push({ name, pass: false, error: e.stack, screenshot }); }
  finally { hold = null; holds.splice(0).forEach(resolve => resolve()); }
};
try {
  server = await createServer({ frontendExports: true, configFile: false, cacheDir: path.join(out, '.vite-cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router'] }, plugins: [vue()], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const secureOrigin = origin.replace('http:','https:');
  browser = await chromium.launch({ executablePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: !process.argv.includes('--visual-probe'), deviceScaleFactor: 1, colorScheme: 'light' });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.fixtureClipboard = text; } } });
    window.fixtureBlobs = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = function(blob) { blob.text().then(text => window.fixtureBlobs.push(text)); return create.call(this, blob); };
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://api.github.com') {
      const tag=url.pathname.includes('/tags/') ? decodeURIComponent(url.pathname.split('/tags/')[1]) : 'task5.synthetic';
      if (url.pathname.includes('/contents/')) return route.fulfill({json:{encoding:'base64',content:Buffer.from('fs.StringVar(&token,"token-file","",""); fs.StringVar(&key,"register-key","","")').toString('base64')}});
      return route.fulfill({json:{tag_name:tag,draft:false,assets:['linux-amd64','darwin-arm64','windows-amd64.exe','freebsd-amd64'].map(platform=>({name:'cf-probe-'+platform,state:'uploaded',browser_download_url:'https://github.com/emailtq/cfsm-agent/releases/download/'+tag+'/cf-probe-'+platform}))}});
    }
    if (url.origin !== origin && url.origin !== secureOrigin) { report.networkDenied.push(url.origin); await route.abort(); return; }
    if (url.origin === secureOrigin && url.pathname === '/admin' && url.searchParams.get('mode') === 'admin') {
      const response=await route.fetch({url:origin+'/test/fixtures/admin-ui/index.html'+url.search});
      return route.fulfill({response});
    }
    if (url.pathname.endsWith('/admin-ui-approved/preview.html')) { await route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync('docs/superpowers/references/admin-ui-approved/preview.html') }); return; }
    if (url.pathname === '/admin' && route.request().isNavigationRequest()) { await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>Owned fixture auth redirect</p>' }); return; }
    if (url.pathname === '/' && route.request().isNavigationRequest()) { await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p id="fixture-public-redirect">Owned public redirect</p>' }); return; }
    if (url.pathname.endsWith('/admin/api')) {
      const data = route.request().postDataJSON();
      if (data.action === 'node_read_install') return route.fulfill({json:{token:'a'.repeat(64),version:1,tokenVersion:1,enabled:false,needsRotation:false}});
      if (data.action === 'node_prepare_registration') return route.fulfill({json:{key:'b'.repeat(64),expiresAt:Date.now()+900000}});
      const site = url.pathname.startsWith('/site-b') ? 'b' : 'a';
      report.actions.push({ site, ...data });
      const held = hold?.action === data.action && hold.site === site ? hold : null;
      if (held) await new Promise(resolve => holds.push(resolve));
      if (held?.failureStatus) { await route.fulfill({ status: held.failureStatus, json: { error: 'fixture_expired_old_site_auth' } }); return; }
      if (failedAction === data.action) { await route.fulfill({ status: 400, json: { error: 'fixture_failure' } }); return; }
      if (data.action === 'save_settings' && Object.keys(data.settings).some(key => key.startsWith('notification_') || ['tg_notify', 'tg_bot_token', 'tg_chat_id', 'expire_reminder', 'expire_notification_time', 'resource_alert_rules', 'traffic_alert_threshold'].includes(key))) { await route.fulfill({ status: 400, json: { error: 'notification_config_authoritative' } }); return; }
      if (data.action === 'add') servers.push({ id: 'fixture-added', name: data.name, server_group: data.server_group });
      if (data.action === 'delete') servers = servers.filter(server => server.id !== data.id);
      if (data.action === 'edit') Object.assign(servers.find(s => s.id === data.id), data);
      if (data.action === 'save_order') servers = data.orders.map(id => servers.find(s => s.id === id));
      const result = data.action === 'export_servers' ? { servers, settings: { site: { cloudflare_token: 'fixture-cloudflare' }, appearance: { site_title: site }, ...(data.includeNotificationSecrets ? { notification_config: { schema: 1, channels: [{ secrets: { botToken: 'fixture-notification' } }], rules: [] } } : {}) }, ...(data.includeNotificationSecrets ? { notificationBackup: { sensitive: true, warning: 'notification_backup_contains_credentials' } } : {}) }
        : data.action === 'import_servers' ? { success: true, imported: 1, skipped: 1, skippedIds: ['skipped-node'], settings: { imported: true, ignoredFields: ['jwt_secret'], notification: { unresolvedRuleIds: ['rule-missing'], unresolvedReferences: [{ ruleId: 'rule-missing', serverIds: ['missing-node'] }] } } }
        : { success: true, ...(data.action === 'login' ? { token: 'fixture-login-token' } : {}), ...(data.action === 'start_theme_preview' ? { preview_url: `${origin}/fixture-preview` } : {}), settings: settings(site), servers: site === 'b' ? [{ id: 'site-b-node', name: 'Site B node' }] : servers, stats: { total: servers.length, online: 4, offline: 2, avg_cpu: 12 } };
      await route.fulfill({ json: result }); return;
    }
    for (const endpoint of ['/api/config', '/theme', '/updateDatabase', '/clearHistory']) {
      if (!url.pathname.endsWith(endpoint)) continue;
      const site = url.pathname.startsWith('/site-b') ? 'b' : 'a';
      const held = hold?.action === endpoint && hold.site === site ? hold : null;
      if (held) await new Promise(resolve => holds.push(resolve));
      if (held?.failureStatus) await route.fulfill({ status: held.failureStatus, json: { error: 'fixture_expired_old_site_auth' } });
      else await route.fulfill({ json: endpoint === '/api/config' ? { version: 'fixture-worker', last_agent_version: '2.8.6' } : endpoint === '/theme' ? { schema: 1, themes: [] } : { success: true } });
      return;
    }
    if (url.origin === secureOrigin) return route.fulfill({response:await route.fetch({url:origin+url.pathname+url.search})});
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', e => report.errors.push(e.message));
  let visit = 0;
  const goto = async (extra = '') => { await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&visit=${visit++}${extra}#/admin`); await page.locator('.server-row').first().waitFor(); };
  const pageNames = new Map([[en.adminNodes, 'servers'], [en.adminCollection, 'collection'], [en.adminData, 'database'], [en.theme, 'themeStore'], [en.adminSecurity, 'security'], [en.settings, 'settings'], [en.adminUpdates, 'updates']]);
  const nav = label => page.locator(`[data-page=${pageNames.get(label)}]`);
  if (process.argv.includes('--auth-scope-probe')) {
    for (const status of [401, 403]) {
      await goto('&sites=1');
      await check(`late site A HTTP ${status} must not clear site B auth or discard its draft`, async () => {
        await nav(en.settings).click();
        await page.waitForFunction(() => document.querySelector('[data-setting-field=site_title]')?.value === 'CF Monitor');
        hold = { action: 'get_settings', site: 'a', failureStatus: status };
        await Promise.all([page.waitForRequest(request => request.url().includes('/site-a/admin/api') && request.postDataJSON()?.action === 'get_settings'), page.getByRole('button', { name: new RegExp(en.saveConfig, 'i') }).click()]);
        await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
        await page.locator('#admin-site').selectOption('1');
        await page.waitForFunction(() => document.querySelector('[data-setting-field=site_title]')?.value === 'Site B');
        await page.locator('[data-setting-field=site_title]').fill('Unsaved Site B draft');
        await page.evaluate(() => { localStorage.setItem('jwt_token', 'fixture-site-b-auth'); localStorage.setItem('turnstile_token', 'fixture-site-b-turnstile'); localStorage.setItem('turnstile_verified', 'true'); });
        hold = null; holds.splice(0).forEach(resolve => resolve());
        await new Promise(resolve => setTimeout(resolve, 700));
        const observed = await page.evaluate(() => ({ token: localStorage.getItem('jwt_token'), turnstile: localStorage.getItem('turnstile_token'), draft: document.querySelector('[data-setting-field=site_title]')?.value, url: location.href }));
        (report.authRaces ||= []).push({ status, observed });
        assert.equal(observed.token, 'fixture-site-b-auth');
        assert.equal(observed.turnstile, 'fixture-site-b-turnstile');
        assert.equal(observed.draft, 'Unsaved Site B draft');
      });
    }
    for (const scenario of ['A-B-A', 'unmount', 'logout']) {
      await goto('&sites=1');
      await check(`real admin lifecycle ${scenario} invalidates old authenticated work`, async () => {
        await nav(en.settings).click();
        hold = { action: 'get_settings', site: 'a', failureStatus: 401 };
        await Promise.all([page.waitForRequest(request => request.url().includes('/site-a/admin/api') && request.postDataJSON()?.action === 'get_settings'), page.getByRole('button', { name: new RegExp(en.saveConfig, 'i') }).click()]);
        await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
        if (scenario === 'A-B-A') {
          await page.locator('#admin-site').selectOption('1'); await page.waitForFunction(() => document.querySelector('[data-setting-field=site_title]')?.value === 'Site B');
          hold = null;
          await page.locator('#admin-site').selectOption('0'); await page.waitForFunction(() => document.querySelector('[data-setting-field=site_title]')?.value === 'CF Monitor');
          await page.locator('[data-setting-field=site_title]').fill('New A draft');
        } else if (scenario === 'unmount') { await page.evaluate(() => { location.hash = '#/public'; }); await page.locator('#public-control').waitFor(); }
        else { await page.getByRole('button', { name: en.logout }).click(); await page.locator('#fixture-public-redirect').waitFor(); }
        await page.evaluate(() => localStorage.setItem('jwt_token', 'new-context-token'));
        hold = null; holds.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await page.evaluate(() => localStorage.getItem('jwt_token')), 'new-context-token');
        if (scenario === 'A-B-A') assert.equal(await page.locator('[data-setting-field=site_title]').inputValue(), 'New A draft');
      });
    }
    for (const action of ['/api/config', '/theme', '/updateDatabase', '/clearHistory', 'start_theme_preview', 'save_settings']) {
      await goto('&sites=1');
      await check(`late old-site ${action} cannot mutate current auth, versions, theme preview or database feedback`, async () => {
        hold = { action, site: action === '/api/config' ? 'b' : 'a', failureStatus: action === 'start_theme_preview' ? undefined : 403 };
        const requestPredicate = request => action.startsWith('/') ? request.url().endsWith(action) : request.url().endsWith('/admin/api') && request.postDataJSON()?.action === action;
        if (action === '/api/config') {
          await Promise.all([page.waitForRequest(requestPredicate), (async () => { await nav(en.settings).click(); await page.locator('#admin-site').selectOption('1'); })()]);
          await page.waitForFunction(() => document.querySelector('[data-setting-field=site_title]')?.value === 'Site B');
          await page.evaluate(() => { location.hash = '#/admin?apiIndex=0'; });
        } else if (action === '/theme' || !action.startsWith('/')) {
          await Promise.all([page.waitForRequest(requestPredicate), (async () => {
            await nav(en.theme).click();
            if (action !== '/theme') {
              await page.locator('.theme-custom-form input').fill('https://github.com/fixture/theme/tree/main');
              await page.locator('.theme-custom-form').getByRole('button', { name: action === 'start_theme_preview' ? en.preview : en.applyCustomTheme, exact: true }).click();
            }
          })()]);
          await nav(en.settings).click(); await page.locator('#admin-site').selectOption('1');
        } else {
          await Promise.all([page.waitForRequest(requestPredicate), (async () => {
            await nav(en.adminData).click();
            await page.getByRole('button', { name: action === '/updateDatabase' ? en.upgradeDatabase : en.clearHistory, exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: action === '/updateDatabase' ? en.upgradeDatabase : en.confirmClear, exact: true }).click();
          })()]);
          await page.evaluate(() => { location.hash = '#/admin?apiIndex=1'; });
          await nav(en.settings).click();
        }
        await page.waitForFunction(expected => document.querySelector('[data-setting-field=site_title]')?.value === expected, action === '/api/config' ? 'CF Monitor' : 'Site B');
        await page.locator('[data-setting-field=site_title]').fill('Owned current draft');
        await page.evaluate(() => { localStorage.setItem('jwt_token', 'current-jwt'); localStorage.setItem('turnstile_token', 'current-turnstile'); window.fixtureOpened = []; window.open = (...args) => window.fixtureOpened.push(args); });
        hold = null; holds.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await page.evaluate(() => localStorage.getItem('jwt_token')), 'current-jwt');
        assert.equal(await page.evaluate(() => localStorage.getItem('turnstile_token')), 'current-turnstile');
        assert.equal(await page.locator('[data-setting-field=site_title]').inputValue(), 'Owned current draft');
        assert.equal(await page.getByRole('dialog').count(), 0); assert.deepEqual(await page.evaluate(() => window.fixtureOpened), []);
      });
    }
    await check('late real login success after pre-login site switch cannot store its old token', async () => {
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=login&sites=1&visit=${visit++}#/admin`);
      await page.locator('#login-overlay').waitFor();
      await page.locator('input[name=username]').fill('fixture'); await page.locator('.login-form-group.last input').fill('fixture-pass');
      hold = { action: 'login', site: 'a' };
      await Promise.all([page.waitForRequest(request => request.postDataJSON()?.action === 'login'), page.locator('.login-btn').click()]);
      await page.locator('#login-overlay select').selectOption('1');
      hold = null; holds.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(await page.evaluate(() => localStorage.getItem('jwt_token')), null); assert.equal(await page.locator('#login-overlay').count(), 1);
    });
  } else if (process.argv.includes('--presentation-probe')) {
    await goto();
    await check('frozen node presentation has only grouping/bulk-add/add toolbar and no permanent selection', async () => {
      assert.equal(await page.locator('#tab-servers .batch-actions').count(), 0);
      assert.equal(await page.locator('.server-checkbox').count(), 0);
      assert.equal(await page.locator('.toolbar > button').count(), 3);
      assert.equal(await page.locator('.admin-filter-group button[aria-haspopup="listbox"]').count(), 1);
      assert.equal(await page.locator('.admin-header select').count(), 0);
      assert.equal(await page.locator('.admin-header [data-reference-icon=moon]').count(), 1);
      await page.locator('.server-name-link').first().click();
      assert.equal(await page.locator('[name=edit_name]').count(), 1);
      await page.keyboard.press('Escape');
      await page.locator('.server-row').first().getByRole('button', { name: en.adminRenew }).click();
      assert.equal(await page.locator('[name=edit_name]').count(), 0);
      assert.equal(await page.locator('[name=renew_expire_date]').count(), 1);
      assert.equal(await page.locator('.admin-dialog-close [data-reference-icon=x]').count(), 1);
      const renewalText = await page.getByRole('dialog').innerText();
      await page.keyboard.press('Escape');
      assert.ok(renewalText.includes(initialServers[0].name), 'focused renewal identifies its target node');
    });
    await check('ordinary validation then node/batch validation stays in the active form, not hidden', async () => {
      await nav(en.adminSecurity).click(); await page.locator('[data-setting-field=jwt_secret]').fill('short'); await page.getByRole('button', { name: new RegExp(en.saveConfig, 'i') }).click();
      await nav(en.adminNodes).click(); await page.locator('.server-name-link').first().click();
      assert.equal(await page.getByRole('dialog').count(), 1); assert.equal(await page.getByRole('dialog').getByRole('alert').count(), 0);
      await page.getByRole('dialog').locator('details').last().locator('summary').click();
      await page.locator('[name=edit_custom_ct]').fill('bad host');
      assert.ok((await page.getByRole('dialog').innerText()).includes(en.invalidPingNodeFormat));
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: en.group, exact: true }).click(); await page.locator('.server-checkbox').first().check(); await page.getByRole('dialog').locator('summary').click(); await page.getByRole('button', { name: en.batchEdit, exact: true }).click();
      const block = page.getByRole('dialog').locator('.batch-edit-field').filter({ has: page.locator('input[placeholder="gd-ct-dualstack.ip.zstaticcdn.com"]') }).first();
      await block.locator('input[type=checkbox]').check(); await block.locator('input[type=text]').fill('bad host');
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.save, 'i'), exact: true }).click();
      await page.getByRole('dialog').getByRole('alert').waitFor(); assert.equal(await page.getByRole('dialog').count(), 1);
      await page.keyboard.press('Escape');
    });
    await check('full-list deletion prunes selection while search alone does not', async () => {
      await page.getByRole('button', { name: en.group, exact: true }).click();
      assert.equal(await page.locator('.server-checkbox').first().isChecked(), true);
      await page.keyboard.press('Escape');
      const id = await page.locator('.server-row').first().getAttribute('data-server-id');
      await page.locator('.server-row').first().getByRole('button', { name: en.delete, exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: en.confirmDelete }).click(); await page.locator(`[data-server-id="${id}"]`).waitFor({ state: 'detached' }); await page.keyboard.press('Escape');
      await page.getByRole('button', { name: en.group, exact: true }).click(); assert.match(await page.getByRole('dialog').innerText(), /0\/5/); await page.keyboard.press('Escape');
    });
    await check('renewal validation closes with its form instead of leaving an orphan error dialog', async () => {
      servers = [{ ...initialServers[0], custom_ct: 'bad host' }];
      await goto();
      await page.locator('.server-row').first().getByRole('button', { name: en.adminRenew }).click();
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.save, 'i'), exact: true }).click();
      await page.getByRole('dialog').getByRole('alert').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
    });
    await check('missing traffic is unavailable; measured zero and per-direction calculation stay real', async () => {
      servers = [
        { id: 'missing', name: 'Missing', net_rx_monthly: null, net_tx_monthly: null },
        { id: 'zero', name: 'Zero', net_rx_monthly: 0, net_tx_monthly: 0, rx: 9000, tx: 8000 },
        { id: 'upload', name: 'Upload', net_rx_monthly: 1024 ** 3, net_tx_monthly: 2 * 1024 ** 3, traffic_calc_type: 'ul' },
        { id: 'invalid', name: 'Invalid', net_rx_monthly: 'bad', net_tx_monthly: 0 },
        { id: 'download', name: 'Download', net_rx_monthly: 1024 ** 3, net_tx_monthly: null, traffic_calc_type: 'dl' },
        { id: 'max', name: 'Max', net_rx_monthly: 1024 ** 3, net_tx_monthly: 2 * 1024 ** 3, traffic_calc_type: 'max' },
        { id: 'unsupported', name: 'Unsupported', net_rx_monthly: false, net_tx_monthly: 0 },
        { id: 'empty', name: 'Empty', net_rx_monthly: '', net_tx_monthly: 0 },
        { id: 'negative', name: 'Negative', net_rx_monthly: -1, net_tx_monthly: 0 }
      ];
      await goto();
      assert.equal(await page.locator('[data-server-id=missing] .admin-traffic-used').innerText(), '-');
      assert.equal(await page.locator('[data-server-id=zero] .admin-traffic-used').innerText(), '0 B');
      assert.equal(await page.locator('[data-server-id=upload] .admin-traffic-used').innerText(), '2 GB');
      assert.equal(await page.locator('[data-server-id=invalid] .admin-traffic-used').innerText(), '-');
      assert.equal(await page.locator('[data-server-id=download] .admin-traffic-used').innerText(), '1 GB');
      assert.equal(await page.locator('[data-server-id=max] .admin-traffic-used').innerText(), '2 GB');
      for (const id of ['unsupported', 'empty', 'negative']) assert.equal(await page.locator(`[data-server-id=${id}] .admin-traffic-used`).innerText(), '-');
    });
    await check('sensitive export failure is visible inside the still-open confirmation', async () => {
      await nav(en.adminData).click(); await page.locator('#include-notification-secrets').check();
      await page.getByRole('button', { name: new RegExp(en.exportServers) }).click();
      failedAction = 'export_servers'; await page.getByRole('button', { name: en.adminConfirmSensitiveExport }).click();
      await page.getByRole('dialog').getByRole('alert').waitFor();
      assert.ok((await page.getByRole('dialog').innerText()).includes(en.serversExportFailed));
      await page.keyboard.press('Escape'); failedAction = '';
    });
    await check('theme enable and disable controls use reference text buttons, not Unicode icon substitutes', async () => {
      await nav(en.theme).click();
      assert.equal((await page.locator('.theme-card').first().getByRole('button', { name: new RegExp(en.enable), exact: false }).innerText()).trim(), en.enable);
      assert.equal((await page.locator('.theme-card').first().getByRole('button', { name: new RegExp(en.close), exact: false }).innerText()).trim(), en.close);
    });
  } else if (process.argv.includes('--visual-probe')) {
    const reference = await context.newPage();
    for (const width of [1440, 1024, 768, 390, 320]) for (const theme of ['light', 'dark', 'auto']) {
      await page.setViewportSize({ width, height: 900 }); await goto('&locale=zh');
      await nav(en.theme).click(); await page.locator('.admin-theme-select').selectOption(theme); await nav(en.adminNodes).click();
      await reference.setViewportSize({ width, height: 900 });
      await reference.goto(`${origin}/docs/superpowers/references/admin-ui-approved/preview.html`);
      await reference.addScriptTag({ content: fs.readFileSync(`${lucideRoot}/dist/umd/lucide.min.js`, 'utf8') });
      await reference.evaluate(() => globalThis.lucide.createIcons({ attrs: { width: 16, height: 16 } }));
      await reference.addStyleTag({ content: `body { margin:0; color-scheme:${theme === 'dark' ? 'dark' : 'light'} }` });
      const measure = (target, selectors) => target.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => { const el = document.querySelector(selector), r = el.getBoundingClientRect(), c = getComputedStyle(el); return [key, { width: r.width, height: r.height, gap: c.gap, ...(key === 'row' ? { heights: [...document.querySelectorAll(selector)].map(row => row.getBoundingClientRect().height) } : {}), font: c.fontFamily, fontSize: c.fontSize, fontWeight: c.fontWeight, lineHeight: c.lineHeight, appearance: c.appearance, justifyContent: c.justifyContent, color: c.color, borderRadius: c.borderRadius, background: c.backgroundColor }]; })), selectors);
      const actual = await measure(page, { header: '.admin-header-inner', headerActions: '.admin-header-actions', site: '.admin-site-name', headerLabel: '.admin-header-label', public: '.admin-public-link', workspace: '.admin-main', nav: '.admin-nav', toolbar: '.toolbar', name: '.server-name-link', ip: '.admin-copy-value', ipLong: '.server-row:nth-child(2) .admin-copy-value', status: '.admin-node-status', private: '.admin-private-status', row: '.server-row', search: '.admin-search', group: '.toolbar-select', action: '.action-btns button' });
      const expected = await measure(reference, { header: '.rep-header-inner', headerActions: '.rep-header-inner', site: '.rep-site-name', headerLabel: '.rep-admin-label', public: '.rep-public', workspace: '.rep-main', nav: '.rep-nav', toolbar: '.rep-toolbar', name: '.cf-node-name', ip: '.rep-ip-button', ipLong: '.rep-table tbody tr:nth-child(2) .rep-ip-button', status: '.rep-badge', private: '.rep-badge.is-private', row: '.rep-table tbody tr', search: '.cf-search', group: '.cf-select', action: '.rep-actions button' });
      await check(`same-locale fine geometry, typography and icons ${width}/${theme}`, async () => {
        assert.equal(await reference.evaluate(() => document.characterSet), 'UTF-8');
        assert.equal(Math.round(actual.nav.width), width >= 768 ? 176 : width - 32);
        assert.ok(Math.abs(actual.workspace.width - expected.workspace.width) <= 2);
        assert.equal(actual.name.fontSize, expected.name.fontSize); assert.equal(actual.name.font, expected.name.font);
        for (const key of ['site', 'public', 'name', 'ip', 'status', 'private']) for (const field of ['fontSize', 'fontWeight', 'lineHeight', 'color']) assert.equal(actual[key][field], expected[key][field], `${key}.${field}`);
        const group = page.locator('.admin-toolbar-group-trigger');
        assert.equal(await group.locator('[data-reference-icon="chevron-down"]').count(), 1, 'approved single select keeps the reference chevron');
        await group.click(); assert.ok(await page.getByRole('option').count()); await page.keyboard.press('Escape');
        assert.equal(await group.evaluate(element => element === document.activeElement), true, 'single select restores focus without committing a preview');
        assert.equal(actual.headerLabel.width, expected.headerLabel.width, 'reference admin label remains visible on mobile');
        assert.equal(actual.header.gap, expected.header.gap, 'reference header spacing');
        assert.equal(actual.headerActions.gap, expected.headerActions.gap, 'reference header action spacing');
        assert.equal(actual.toolbar.justifyContent, expected.toolbar.justifyContent, 'reference right-aligned action row');
        assert.equal(actual.ipLong.height, expected.ipLong.height, 'IP copy text never wraps digits');
        assert.ok(Math.abs(actual.row.height - expected.row.height) <= 1, 'fine row density');
        for (let index = 0; index < actual.row.heights.length; index++) assert.ok(Math.abs(actual.row.heights[index] - expected.row.heights[index]) <= 1, `all fine rows retain reference density: row ${index + 1}`);
        assert.equal(actual.action.width, expected.action.width); assert.equal(actual.action.height, expected.action.height);
        assert.equal(actual.search.height, expected.search.height);
        assert.equal(actual.header.background, expected.header.background);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const iconNames = await page.locator('.server-row').first().locator('svg[data-reference-icon]').evaluateAll(nodes => nodes.map(node => node.dataset.referenceIcon));
        assert.deepEqual(iconNames, ['grip-vertical', 'terminal', 'download', 'pencil', 'calendar-clock', 'trash-2']);
      });
      (report.comparisons ||= []).push({ width, theme, locale: 'zh', actual, expected });
      await page.screenshot({ path: path.join(out, `actual-${width}-${theme}.png`), fullPage: true });
      await reference.locator('.rep-product').screenshot({ path: path.join(out, `reference-${width}-${theme}.png`) });
      await page.getByRole('button', { name: zh.group, exact: true }).click();
      await reference.locator('.rep-toolbar [data-action=rep-groups]').click();
      const dialogGeometry = (target, selectors) => target.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
        const element = document.querySelector(selector), rect = element.getBoundingClientRect(), css = getComputedStyle(element);
        return [key, { width: rect.width, height: rect.height, padding: css.padding, fontSize: css.fontSize, fontWeight: css.fontWeight, textAlign: css.textAlign, marginBottom: css.marginBottom, display: css.display, columns: css.gridTemplateColumns, direction: css.flexDirection }];
      })), selectors);
      const actualDialog = await dialogGeometry(page, { dialog: '.admin-dialog', head: '.admin-dialog-head', input: '#group-name', grid: '.admin-node-picker', icon: '.admin-dialog-close svg', footer: '.admin-dialog-footer', button: '.admin-dialog-footer button' });
      const referenceDialog = await dialogGeometry(reference, { dialog: '.cf-dialog', head: '.cf-dialog-head', input: '.cf-dialog input:not([type=checkbox])', grid: '.cf-node-picker', icon: '.cf-dialog-head svg', footer: '.cf-dialog-footer', button: '.cf-dialog-footer button' });
      await check(`same-locale grouping field/dialog geometry ${width}/${theme}`, async () => {
        assert.ok(Math.abs(actualDialog.dialog.width - referenceDialog.dialog.width) <= 2);
        assert.equal(actualDialog.dialog.padding, referenceDialog.dialog.padding);
        assert.equal(actualDialog.button.height, referenceDialog.button.height);
        assert.equal(actualDialog.button.fontWeight, referenceDialog.button.fontWeight);
        assert.equal(actualDialog.head.textAlign, referenceDialog.head.textAlign);
        assert.equal(actualDialog.head.marginBottom, referenceDialog.head.marginBottom);
        assert.equal(actualDialog.input.height, referenceDialog.input.height);
        assert.ok(Math.abs(actualDialog.input.width - referenceDialog.input.width) <= 2);
        assert.equal(actualDialog.input.fontSize, referenceDialog.input.fontSize);
        assert.equal(actualDialog.grid.display, referenceDialog.grid.display);
        assert.equal(actualDialog.grid.columns.split(' ').length, referenceDialog.grid.columns.split(' ').length);
        assert.equal(actualDialog.icon.width, referenceDialog.icon.width); assert.equal(actualDialog.icon.height, referenceDialog.icon.height);
        assert.equal(actualDialog.footer.direction, referenceDialog.footer.direction);
      });
      (report.dialogComparisons ||= []).push({ width, theme, actual: actualDialog, expected: referenceDialog });
      await page.screenshot({ path: path.join(out, `actual-group-${width}-${theme}.png`) });
      await reference.locator('.rep-product').screenshot({ path: path.join(out, `reference-group-${width}-${theme}.png`) });
      await page.keyboard.press('Escape'); await reference.locator('.cf-dialog-head [data-action=close-dialog]').click();
    }
    await reference.close();
  } else {
  await goto();
  await check('Task5 nine working navigation pages and auxiliary donation', async () => {
    assert.equal(await page.locator('.admin-nav-item').count(), 9);
    assert.ok(await nav(en.adminCollection).count()); assert.ok(await nav(en.adminSecurity).count()); assert.ok(await nav(en.adminUpdates).count());
  });
  await check('frozen Lucide symbol names replace interim Unicode row controls and navigation', async () => {
    assert.deepEqual(await page.locator('.admin-nav-item svg').evaluateAll(nodes => nodes.map(node => node.dataset.referenceIcon)), ['server', 'radio', 'bell', 'list-filter', 'database', 'palette', 'shield', 'settings', 'circle-arrow-up']);
    assert.deepEqual(await page.locator('.server-row').first().locator('.action-btns svg').evaluateAll(nodes => nodes.map(node => node.dataset.referenceIcon)), ['terminal', 'download', 'pencil', 'calendar-clock', 'trash-2']);
    assert.equal(await page.locator('.server-row').first().locator('.drag-handle svg').getAttribute('data-reference-icon'), 'grip-vertical');
    assert.equal(await page.locator('.toolbar .btn-primary svg').getAttribute('data-reference-icon'), 'plus');
    assert.deepEqual(await page.locator('.server-row').first().locator('.action-btns button').evaluateAll(buttons => buttons.map(button => button.textContent.trim())), ['', '', '', '', '']);
    const controls = await page.locator('[data-reference-icon]').evaluateAll(nodes => nodes.map(node => ({ name: node.dataset.referenceIcon, width: node.getAttribute('width'), height: node.getAttribute('height'), children: [...node.children].map(child => [child.tagName, Object.fromEntries([...child.attributes].map(attr => [attr.name, attr.value]))]) })));
    for (const control of controls) {
      const name = control.name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
      assert.deepEqual(control.children, referenceIcons[name], `exact Lucide nodes: ${control.name}`);
      assert.equal(control.width, '16'); assert.equal(control.height, '16');
    }
    report.iconControls = controls;
  });
  await check('preview columns, secondary OS/group and real add dialog', async () => {
    assert.equal(await page.locator('.terminal-table th').count(), 7);
    assert.ok((await page.locator('.server-secondary').first().innerText()).includes(initialServers[0].server_group));
    await page.getByRole('button', { name: new RegExp(en.adminAddNode) }).click();
    assert.equal(Math.round((await page.getByRole('dialog').boundingBox()).width), 448);
    await page.keyboard.press('Escape');
  });
  await check('ordinary save with authoritative notifications does not validate or send legacy fields', async () => {
    await nav(en.settings).click();
    await page.getByRole('button', { name: new RegExp(en.saveConfig, 'i') }).click();
    await page.waitForFunction(() => document.querySelector('.admin-dialog')?.textContent.includes('successfully'), null, { timeout: 2500 });
    const action = report.actions.find(a => a.action === 'save_settings');
    assert.ok(action); assert.equal('tg_bot_token' in action.settings, false); assert.equal('notification_config' in action.settings, false);
    await page.keyboard.press('Escape');
  });
  await goto();
  await check('data deliberate sensitive export opt-in and ordinary credential warning', async () => {
    await nav(en.adminData).click();
    assert.equal(await page.locator('#include-notification-secrets').count(), 1);
    assert.match(await page.locator('#tab-database').innerText(), /Cloudflare/);
  });
  const save = () => page.getByRole('button', { name: new RegExp(en.saveConfig, 'i') }).click();
  const waitAction = async (name, after = 0) => { for (let n = 0; n < 100 && !report.actions.slice(after).some(a => a.action === name); n++) await new Promise(r => setTimeout(r, 20)); assert.ok(report.actions.slice(after).some(a => a.action === name), name); };
  const nodeIds = () => page.locator('.server-row').evaluateAll(rows => rows.map(row => row.dataset.serverId));
  const effective44 = locator => locator.evaluate(element => {
    const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    return [[x - 21, y], [x + 21, y], [x, y - 21], [x, y + 21]].every(([a, b]) => element.contains(document.elementFromPoint(a, b)));
  });
  const downloadExport = async sensitive => {
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: sensitive ? en.adminConfirmSensitiveExport : new RegExp(en.exportServers) }).click()]);
    const payload = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    report.downloads.push({ filename: file.suggestedFilename(), payload });
    const blobs = await page.evaluate(() => window.fixtureBlobs);
    assert.deepEqual(JSON.parse(blobs.at(-1)), payload);
    return payload;
  };
  const upload = () => page.locator('#tab-database input[type=file]').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ servers: [{ id: 'imported', name: 'Imported fixture' }], settings: { site: {} } })) });
  await check('default export actual download retains Cloudflare but not notification credentials', async () => {
    assert.equal(await page.locator('#include-notification-secrets').isChecked(), false);
    const data = await downloadExport(false);
    assert.equal(data.settings.site.cloudflare_token, 'fixture-cloudflare');
    assert.equal('notification_config' in data.settings, false);
    assert.equal('includeNotificationSecrets' in report.actions.filter(a => a.action === 'export_servers').at(-1), false);
  });
  await check('sensitive export cancel sends nothing, confirmed Blob retains warning marker', async () => {
    await page.locator('#include-notification-secrets').check();
    const count = report.actions.length;
    await page.getByRole('button', { name: new RegExp(en.exportServers) }).click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: path.join(out, 'sensitive-confirm.png') });
    await page.keyboard.press('Escape');
    assert.equal(report.actions.length, count);
    await page.getByRole('button', { name: new RegExp(en.exportServers) }).click();
    const data = await downloadExport(true);
    assert.equal(data.notificationBackup.sensitive, true); assert.equal(data.notificationBackup.warning, 'notification_backup_contains_credentials');
    assert.equal(data.settings.notification_config.channels[0].secrets.botToken, 'fixture-notification');
    assert.equal(report.actions.filter(a => a.action === 'export_servers').at(-1).includeNotificationSecrets, true);
  });
  await check('import exposes unresolved IDs, original references and skipped/ignored report before acknowledge reload', async () => {
    const oldURL = page.url();
    await upload();
    await page.getByRole('button', { name: en.adminAcknowledgeReload }).waitFor();
    const text = await page.locator('#tab-database').innerText();
    for (const word of ['rule-missing', 'missing-node', 'skipped-node', 'jwt_secret']) assert.ok(text.includes(word));
    assert.equal(page.url(), oldURL);
    await page.screenshot({ path: path.join(out, 'unresolved-import.png') });
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: en.adminAcknowledgeReload }).click()]);
  });
  await goto();
  await check('add cancellation/busy/failure and actual CRUD payloads preserve original handlers', async () => {
    const before = report.actions.length;
    await page.locator('.toolbar .btn-primary').click(); await page.locator('#add-server-name').fill('Cancelled fixture'); await page.keyboard.press('Escape');
    assert.equal(report.actions.slice(before).filter(a => a.action === 'add').length, 0);
    await page.locator('.toolbar .btn-primary').click(); assert.equal(await page.locator('#add-server-name').inputValue(), '');
    await page.locator('#add-server-name').fill('New fixture'); await page.locator('#add-server-group').fill('Fixture group');
    failedAction = 'add';
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.adminAddNode) }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    assert.equal(await page.locator('#add-server-name').inputValue(), 'New fixture');
    failedAction = ''; hold = { action: 'add', site: 'a' };
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.adminAddNode) }).click();
    await page.getByRole('dialog').locator('button:disabled').first().waitFor();
    await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 1);
    hold = null; holds.splice(0).forEach(resolve => resolve());
    await page.locator('.server-row[data-server-id="fixture-added"]').waitFor();
    const data = report.actions.filter(a => a.action === 'add').at(-1); assert.deepEqual(Object.keys(data).sort(), ['action', 'name', 'server_group', 'site']); assert.equal(data.name, 'New fixture'); assert.equal(data.server_group, 'Fixture group');
    await page.keyboard.press('Escape');
    await page.locator('.server-row[data-server-id="fixture-added"]').getByRole('button', { name: en.delete, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: en.confirmDelete }).click(); await page.locator('.server-row[data-server-id="fixture-added"]').waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
  });
  await goto();
  await check('search/group preserves selection and disables pointer ordering; clearing restores full order', async () => {
    const initial = await nodeIds();
    await page.getByRole('button', { name: en.group, exact: true }).click();
    await page.locator('.server-checkbox').first().check();
    await page.keyboard.press('Escape');
    await page.locator('#tab-servers .admin-search input').fill(initialServers[1].ip_v4);
    assert.equal(await page.locator('.server-row').count(), 1);
    assert.equal(await page.locator('.drag-handle').first().isDisabled(), true);
    await page.getByRole('button', { name: en.group, exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), /1\/6/);
    await page.keyboard.press('Escape');
    await page.locator('#tab-servers .admin-search input').fill('');
    assert.deepEqual(await nodeIds(), initial); await page.getByRole('button', { name: en.group, exact: true }).click(); assert.equal(await page.locator('.server-checkbox').first().isChecked(), true); await page.keyboard.press('Escape');
    await page.locator('.admin-toolbar-group-trigger').click();
    await page.getByRole('option', { name: initialServers[0].server_group, exact: true }).click();
    assert.equal(await page.locator('.server-row').count(), 3);
    await page.locator('.admin-toolbar-group-trigger').click();
    await page.getByRole('option', { name: en.adminAllGroups, exact: true }).click();
    await page.locator('.admin-toolbar-group-menu').waitFor({ state: 'detached' });
    assert.deepEqual(await nodeIds(), initial);
    const before = report.actions.length;
    const a = await page.locator('.drag-handle').first().boundingBox(), b = await page.locator('.drag-handle').nth(1).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await page.mouse.up();
    await waitAction('save_order', before);
    const orders = report.actions.slice(before).find(a => a.action === 'save_order').orders;
    assert.deepEqual(orders, [initial[1], initial[0], ...initial.slice(2)]);
  });
  await check('batch changes only enabled fields for actual selected IDs with the existing full-row API', async () => {
    await page.getByRole('button', { name: en.group, exact: true }).click();
    await page.getByRole('dialog').locator('summary').click();
    await page.getByRole('button', { name: en.batchEdit, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const enable = dialog.locator('input[type=checkbox]').first(); await enable.check();
    await dialog.locator('input[type=text]').first().fill('Changed group');
    const before = report.actions.length;
    await dialog.getByRole('button', { name: new RegExp(en.save, 'i'), exact: false }).last().click();
    await waitAction('edit', before);
    const payloads = report.actions.slice(before).filter(a => a.action === 'edit');
    assert.equal(payloads.length, 1); assert.equal(payloads[0].id, initialServers[0].id);
    assert.equal(payloads[0].server_group, 'Changed group');
    for (const field of ['name', 'region', 'tags', 'note', 'traffic_limit', 'expire_date']) assert.equal(payloads[0][field], initialServers[0][field], `disabled ${field} is preserved by full-row edit`);
    assert.equal(payloads[0].price, '38.00');
    await page.keyboard.press('Escape');
  });
  await goto();
  await check('shared ordinary draft and validation navigate/focus CSP, latency and security fields', async () => {
    await nav(en.settings).click(); await page.locator('[data-setting-field=site_title]').fill('Shared draft');
    await nav(en.adminCollection).click(); await page.locator('[data-setting-field=frontend_ws_timeout_minutes]').fill('-1');
    await nav(en.theme).click(); await save();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.settingField), 'frontend_ws_timeout_minutes');
    await page.locator('[data-setting-field=frontend_ws_timeout_minutes]').fill('15');
    await nav(en.theme).click(); await page.locator('[data-setting-field=csp_static]').fill('http://invalid.test');
    await nav(en.settings).click(); assert.equal(await page.locator('[data-setting-field=site_title]').inputValue(), 'Shared draft'); await save();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.settingField), 'csp_static');
    await page.locator('[data-setting-field=csp_static]').fill('');
    await nav(en.adminSecurity).click(); await page.locator('[data-setting-field=jwt_secret]').fill('short');
    await nav(en.settings).click(); await save();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.settingField), 'jwt_secret');
    await page.locator('[data-setting-field=jwt_secret]').fill('');
  });
  await check('credential-change cancellation does not submit credentials and whole draft saves', async () => {
    await page.getByRole('button', { name: en.changePassword, exact: true }).click();
    await page.locator('[data-setting-field=password]').fill('fixture-new-pass');
    await page.locator('[data-setting-field=confirm_password]').fill('fixture-new-pass');
    await page.getByRole('button', { name: en.cancelPasswordChange, exact: true }).click();
    const before = report.actions.length; await save(); await waitAction('save_settings', before);
    const data = report.actions.slice(before).find(a => a.action === 'save_settings').settings;
    assert.equal('password' in data, false); assert.equal(data.site_title, 'Shared draft'); assert.equal(data.frontend_ws_timeout_minutes, '15');
    await page.keyboard.press('Escape');
  });
  const switchSite = async () => { await nav(en.settings).click(); await page.locator('#admin-site').selectOption('1'); await nav(en.adminNodes).click(); await page.locator('.server-row').filter({ hasText: 'Site B node' }).waitFor(); };
  for (const action of ['list', 'get_settings', 'save_settings', 'export_servers', 'import_servers']) {
    await goto('&sites=1');
    await check(`late site A ${action} cannot overwrite site B drafts, feedback or downloads`, async () => {
      const before = report.actions.length;
      hold = { action, site: 'a' };
      if (action === 'list') { await page.getByRole('button', { name: en.group, exact: true }).click(); await page.getByRole('dialog').locator('summary').click(); await page.getByRole('button', { name: new RegExp(en.refreshCache, 'i'), exact: true }).click(); await page.keyboard.press('Escape'); }
      if (action === 'get_settings') { await nav(en.settings).click(); await save(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape'); }
      if (action === 'save_settings') { await nav(en.settings).click(); await page.locator('[data-setting-field=site_title]').fill('Old site draft'); await save(); }
      if (['export_servers', 'import_servers'].includes(action)) { await nav(en.adminData).click(); if (action === 'export_servers') await page.getByRole('button', { name: new RegExp(en.exportServers) }).click(); else await upload(); }
      await waitAction(action, before);
      if (action === 'list') { await page.evaluate(() => { location.hash = '#/admin?apiIndex=1'; }); await page.locator('.server-row').filter({ hasText: 'Site B node' }).waitFor(); } else await switchSite();
      const downloadCount = report.downloads.length;
      hold = null; holds.splice(0).forEach(resolve => resolve());
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 120)));
      assert.equal(await page.getByRole('dialog').count(), 0);
      await nav(en.settings).click(); assert.equal(await page.locator('[data-setting-field=site_title]').inputValue(), 'Site B');
      assert.equal(await page.evaluate(() => window.fixtureBlobs.length), 0);
      assert.equal(report.downloads.length, downloadCount);
      await nav(en.adminData).click(); assert.equal(await page.getByRole('button', { name: en.adminAcknowledgeReload }).count(), 0);
      report.races ||= []; report.races.push({ action, preservedSite: 'b' });
    });
  }
  await goto();
  await check('mobile right-side actions remain hit-testable after table scroll; install/uninstall all platforms', async () => {
    await page.goto(`${secureOrigin}/admin?mode=admin#/admin`); await page.locator('.server-row').first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.table-wrapper').evaluate(e => { e.scrollLeft = e.scrollWidth; });
    const row = page.locator('.server-row[data-server-id="node-1"]');
    for (const label of [en.copy, en.edit, en.adminRenew, en.delete]) assert.equal(await effective44(row.getByRole('button', { name: label, exact: true })), true, label);
    await row.getByRole('button', { name: en.copy, exact: true }).click();
    const dialog = page.getByRole('dialog');
    for (const os of ['linux', 'unix', 'mac', 'windows', 'docker']) {
      await dialog.locator('select').first().selectOption(os);
      if (os === 'docker') {
        await dialog.locator('[data-install-blocked]').waitFor();
        assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
        assert.equal((await dialog.locator('.cmd-output').innerText()).includes('docker run'),false);
        continue;
      }
      await page.waitForFunction(()=>document.querySelector('[data-copy-command]')?.disabled === false);
      const command = await dialog.locator('.cmd-output').innerText();
      assert.match(command, os === 'windows' ? /powershell|Invoke-WebRequest|\.ps1/i : os === 'docker' ? /docker/ : /curl|wget/);
      if (os !== 'windows' && os !== 'docker') assert.match(command, /\.sh/);
      report.commands ||= []; report.commands.push({ operation: 'install', os, command });
    }
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: en.delete, exact: true }).click();
    assert.ok((await dialog.innerText()).includes(en.deleteConfirm));
    for (const os of ['linux', 'unix', 'mac', 'windows']) {
      await dialog.locator('select').first().selectOption(os);
      const command = await dialog.locator('.cmd-input').inputValue();
      assert.match(command, os === 'windows' ? /powershell|Invoke-WebRequest|\.ps1/i : /curl|wget/);
      report.commands.push({ operation: 'uninstall', os, command });
    }
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: en.adminRenew, exact: true }).click();
    assert.equal(await dialog.locator('input[name=renew_expire_date]').inputValue(), '2026-12-06');
    await dialog.locator('input[name=renew_expire_date]').fill('2027-01-06');
    const before = report.actions.length;
    await dialog.getByRole('button', { name: new RegExp(en.save, 'i'), exact: true }).click(); await waitAction('edit', before);
    assert.equal(report.actions.slice(before).find(a => a.action === 'edit').expire_date, '2027-01-06');
    await page.keyboard.press('Escape');
  });
  await goto();
  await check('mobile install footer primary first, contiguous stack without empty text rows', async () => {
    await page.setViewportSize({ width: 390, height: 540 });
    await page.locator('.table-wrapper').evaluate(e => { e.scrollLeft = e.scrollWidth; });
    await page.locator('.server-row').first().getByRole('button', { name: en.copy, exact: true }).click();
    const boxes = await page.locator('.admin-dialog-footer button').evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { y: r.y, bottom: r.bottom, height: r.height, primary: button.classList.contains('btn-primary') }; }).sort((a, b) => a.y - b.y));
    assert.equal(boxes[0].primary, true);
    assert.ok(boxes.every(box => box.height >= 44));
    for (let n = 1; n < boxes.length; n++) assert.ok(boxes[n].y - boxes[n - 1].bottom <= 10, 'footer has only the intended 8px gap');
    await page.keyboard.press('Escape');
  });
  if (!process.argv.includes('--smoke')) {
    servers = structuredClone(initialServers);
    for (const width of [1440, 1024, 768, 390, 320]) for (const theme of ['light', 'dark', 'auto']) {
      await page.setViewportSize({ width, height: 900 }); await goto('&locale=zh');
      await nav(en.theme).click(); await page.locator('.admin-theme-select').selectOption(theme); await nav(en.adminNodes).click();
      await check(`nodes ${width} ${theme} preview columns and local overflow`, async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('.admin-expiry-column').first().isVisible(), width >= 1280);
        if (width < 1280) assert.equal(await page.locator('.table-wrapper').evaluate(e => e.scrollWidth > e.clientWidth), true);
      });
      await page.screenshot({ path: path.join(out, `nodes-${width}-${theme}.png`), fullPage: true });
      for (const label of [en.adminCollection, en.settings, en.adminSecurity, en.theme, en.adminData, en.adminUpdates]) {
        await nav(label).click();
        await page.screenshot({ path: path.join(out, `page-${width}-${theme}-${label.replace(/\W+/g, '-')}.png`), fullPage: true });
        await check(`page ${width} ${theme} ${label} scoped overflow`, async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label));
      }
      await nav(en.adminNodes).click();
      await page.locator('.toolbar .btn-primary').click(); await page.screenshot({ path: path.join(out, `add-${width}-${theme}.png`) }); await page.keyboard.press('Escape');
      await page.locator('.server-row').first().locator('.server-name-link').click(); await page.screenshot({ path: path.join(out, `detail-${width}-${theme}.png`) }); await page.keyboard.press('Escape');
      await page.locator('.table-wrapper').evaluate(e => { e.scrollLeft = e.scrollWidth; });
      await page.locator('.server-row').first().getByRole('button', { name: zh.edit, exact: true }).click(); await page.screenshot({ path: path.join(out, `edit-${width}-${theme}.png`) }); await page.keyboard.press('Escape');
      await page.locator('.server-row').first().getByRole('button', { name: zh.delete, exact: true }).click(); await page.screenshot({ path: path.join(out, `risk-${width}-${theme}.png`) }); await page.keyboard.press('Escape');
      await nav(en.adminData).click();
      failedAction = 'export_servers'; await page.getByRole('button', { name: new RegExp(zh.exportServers) }).click(); await page.locator('#tab-database').getByText(zh.serversExportFailed, { exact: false }).waitFor(); failedAction = '';
      await page.screenshot({ path: path.join(out, `backup-error-${width}-${theme}.png`) });
      await page.locator('#include-notification-secrets').check(); await page.getByRole('button', { name: new RegExp(zh.exportServers) }).click(); await page.screenshot({ path: path.join(out, `backup-confirm-${width}-${theme}.png`) }); await page.keyboard.press('Escape');
      await upload(); await page.getByRole('button', { name: zh.adminAcknowledgeReload }).waitFor(); await page.screenshot({ path: path.join(out, `import-report-${width}-${theme}.png`), fullPage: true });
      const reference = await context.newPage();
      await reference.setViewportSize({ width, height: 900 });
      await reference.goto(`${origin}/docs/superpowers/references/admin-ui-approved/preview.html`);
      await reference.addScriptTag({ content: fs.readFileSync(`${lucideRoot}/dist/umd/lucide.min.js`, 'utf8') });
      await reference.evaluate(() => globalThis.lucide.createIcons({ attrs: { width: 16, height: 16 } }));
      await reference.addStyleTag({ content: `body { margin:0; color-scheme:${theme === 'dark' ? 'dark' : 'light'} }` });
      const encoding = await reference.evaluate(() => document.characterSet);
      const navText = await reference.locator('.rep-nav').innerText();
      assert.equal(encoding, 'UTF-8'); assert.match(navText, /节点/); assert.match(navText, /通知/);
      await reference.screenshot({ path: path.join(out, `reference-${width}-${theme}.png`), fullPage: true });
      assert.equal(await reference.evaluate(() => innerWidth), width);
      report.references ||= []; report.references.push({ width, theme, encoding, navText, icons: await reference.locator('.rep-actions svg').first().getAttribute('class') }); await reference.close();
    }
    for (const locale of ['en', 'es', 'fr', 'id', 'ja', 'zh', 'zh-TW']) {
      await page.setViewportSize({ width: 320, height: 540 }); await goto(`&locale=${locale}`);
      await check(`locale ${locale} native 36px targets and long names no document overflow`, async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
        const targets = [];
        for (const selector of ['.toolbar-input', '.toolbar-select', '.btn-primary']) {
          const target = await page.locator(`#tab-servers .toolbar ${selector}`).evaluate((element, selector) => {
            const rect = element.getBoundingClientRect();
            const points = [rect.top + 0.5, rect.top + rect.height / 2, rect.bottom - 0.5].map(y => ({ x: rect.x + rect.width / 2, y, hit: element.contains(document.elementFromPoint(rect.x + rect.width / 2, y)) }));
            return { selector, tag: element.tagName, height: rect.height, points };
          }, selector);
          targets.push(target);
        }
        (report.toolbarTouch ||= []).push({ locale, targets });
        const search = page.locator('#tab-servers .admin-search input');
        const before = await search.inputValue(), ids = await nodeIds();
        for (const target of targets) {
          assert.equal(target.tag, target.selector === '.toolbar-input' ? 'INPUT' : 'BUTTON');
          assert.equal(target.height, 36, `${locale} ${target.selector} native height`);
          assert.ok(target.points.every(point => point.hit), `${locale} ${target.selector} inside top/center/bottom hit testing`);
          for (const point of target.points) {
            if (target.selector === '.toolbar-input') await search.evaluate(element => element.blur());
            await page.touchscreen.tap(point.x, point.y);
            if (target.selector === '.toolbar-input') {
              assert.equal(await search.evaluate(element => document.activeElement === element), true, `${locale} inside search tap focuses the native input`);
              assert.equal(await search.inputValue(), before);
            } else {
              const popup = page.getByRole(target.selector === '.toolbar-select' ? 'listbox' : 'dialog');
              await popup.waitFor();
              await page.keyboard.press('Escape');
              await popup.waitFor({ state: 'detached' });
              assert.equal(await page.locator(`#tab-servers .toolbar ${target.selector}`).evaluate(element => document.activeElement === element), true);
            }
          }
        }
        assert.deepEqual(await nodeIds(), ids);
      });
      await page.screenshot({ path: path.join(out, `locale-${locale}-320.png`), fullPage: true });
      await page.locator('.toolbar .btn-primary').click(); await page.screenshot({ path: path.join(out, `add-${locale}-320.png`) }); await page.keyboard.press('Escape');
      for (const label of await page.locator('.admin-nav-item').allTextContents()) {
        await page.locator('.admin-nav-item').filter({ hasText: new RegExp(`^${label.trim()}$`) }).click();
        await check(`locale ${locale} page ${label.trim()} overflow`, async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true));
        await page.screenshot({ path: path.join(out, `locale-${locale}-${(await page.locator('.admin-nav-item[aria-current=page]').getAttribute('class')).includes('is-active') ? (await page.locator('.admin-nav-item').allTextContents()).indexOf(label) : 'page'}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await goto(); await nav(en.theme).click(); await page.locator('.admin-theme-select').selectOption('auto'); await nav(en.adminNodes).click();
    for (const colorScheme of ['dark', 'light']) { await page.emulateMedia({ colorScheme }); await page.screenshot({ path: path.join(out, `auto-system-${colorScheme}-390.png`) }); }
  }
  }
} catch (error) { report.fatal = error.stack; }
finally {
  holds.splice(0).forEach(resolve => resolve());
  await context?.close(); await browser?.close(); await server?.close();
  report.stopped = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.results.filter(r => r.pass).length, failed: report.results.filter(r => !r.pass).length, errors: report.errors, fatal: report.fatal, report: path.join(out, 'report.json'), stopped: true }));
  if (report.fatal || report.results.some(r => !r.pass) || report.errors.length) process.exitCode = 1;
}
