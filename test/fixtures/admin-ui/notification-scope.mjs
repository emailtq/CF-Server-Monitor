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
import { loadNotificationConfig } from '../../../src/database/notifications.js';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const mode = process.argv[2];
const boundary = mode?.startsWith('boundary-');
const out = path.resolve(process.env.TASK5_SCOPE_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/scope-repair-1/registered', mode);
fs.mkdirSync(out, { recursive: true });
const report = { pid: process.pid, node: process.version, mode, checks: [], errors: [], denied: [], saves: [], measurements: [], pageErrors: [], transport: [] };
const check = async (name, fn) => { await fn(); report.checks.push({ name, pass: true }); console.log(JSON.stringify({ name, pass: true })); };
const waitScopeReady = async page => {
  await page.waitForFunction(() => document.querySelector('#ready')?.textContent === 'true' || document.querySelector('#fixture-error')?.textContent);
  const error = await page.locator('#fixture-error').innerText();
  assert.equal(error, '', 'Scope fixture load failed: ' + error);
};
let server, browser, mf, page, releaseList;
try {
  let action, db, nodeCount = 3;
  if (mode === 'scopes' || boundary) {
    mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("OK")}}', d1Databases: { DB: crypto.randomUUID() } });
    db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY)').run();
    const sys = { jwt_secret: 's'.repeat(64), ['pass' + 'word']: 'synthetic-only-admin' };
    await db.prepare("INSERT INTO settings VALUES ('site_options', ?)").bind(JSON.stringify(sys)).run();
    clearSiteSettingsCache(); const settings = await loadSiteSettings(db, true), env = { DB: db, API_SECRET: 'synthetic-only-report' }, token = await generateToken(env, settings);
    action = data => handleAdminAPI(new Request('https://fixture.invalid/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `cfsm_auth=${encodeURIComponent(token)}` }, body: JSON.stringify(data) }), env, settings);
    assert.equal((await action({ action: 'save_notification_config', expectedRevision: 0, channels: [{ name: 'Fixture target', type: 'telegram', enabled: true, config: { chatId: '42' }, secrets: { botToken: '123:synthetic-only' }, template: '{{message}}' }], rules: [] })).status, 200);
  }
  const api = async (req, res, next) => {
    if (!req.url.endsWith('/admin/api')) return next();
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    report.transport.push({ action: data.action, phase: 'request' });
    assert.notEqual(data.action, 'test_notification_channel', 'Scope interaction must never deliver a notification');
    if (data.action === 'save_notification_config') report.saves.push({ expectedRevision: data.expectedRevision, rules: data.rules });
    if (mode === 'boundary-stale' && data.action === 'list') await new Promise(resolve => { releaseList = resolve; });
    const response = mode === 'boundary-error' && data.action === 'list' ? Response.json({ error: 'fixture_list_unavailable' }, { status: 503 })
      : mode === 'boundary-config-error' && data.action === 'get_notification_config' ? Response.json({ error: 'fixture_config_unavailable' }, { status: 503 })
      : mode === 'boundary-malformed' && data.action === 'list' ? Response.json({ servers: null })
      : data.action === 'list' ? Response.json({ servers: Array.from({ length: nodeCount }, (_, n) => ({ id: `node-${n}`, name: n === 2 ? '<script>alert(1)</script> & Node 2' : `Node ${n}` })) }) : await action(data);
    report.transport.push({ action: data.action, phase: 'response', status: response.status });
    res.statusCode = response.status; res.setHeader('Content-Type', 'application/json'); res.end(await response.text());
  };
  const apiMiddlewarePlugin = { name: 'scope-isolated-api', configureServer(s) { s.middlewares.use(api); } };
  server = await createServer({ fixtureEntries: [path.resolve('test/fixtures/admin-ui/scope.html')], apiMiddlewarePlugin, vueFixtureDevtools: true, configFile: false, cacheDir: path.join(out, '.vite-cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router'] }, plugins: [vue(), apiMiddlewarePlugin], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') }); await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  if (boundary) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page = await ctx.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(`${origin}/test/fixtures/admin-ui/scope.html?mode=scopes`);
    if (mode === 'boundary-stale') {
      await check('held actual list response cannot publish after actual Vue unmount', async () => {
        for (let n = 0; n < 100 && !releaseList; n++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(typeof releaseList, 'function');
        await page.evaluate(() => {
          const app = document.querySelector('#app').__vue_app__;
          window.boundaryInstance = app._instance;
          window.boundaryBefore = { config: !!app._instance.setupState.config, servers: app._instance.setupState.servers.length };
          app.unmount();
        });
        assert.deepEqual(await page.evaluate(() => window.boundaryBefore), { config: false, servers: 0 });
        const response = page.waitForResponse(res => res.url().endsWith('/admin/api') && res.request().postDataJSON().action === 'list');
        releaseList(); releaseList = null;
        await response; await page.waitForLoadState('networkidle');
        report.afterUnmount = await page.evaluate(() => ({ unmounted: window.boundaryInstance.isUnmounted, config: !!window.boundaryInstance.setupState.config, servers: window.boundaryInstance.setupState.servers.length, ready: document.querySelector('#ready')?.textContent || null }));
        assert.deepEqual(report.pageErrors, [], 'stale load must not dereference data or emit page errors');
        assert.deepEqual(report.afterUnmount, { unmounted: true, config: false, servers: 0, ready: null });
      });
    } else {
      await check('active failed or malformed load shows fixture error without false readiness', async () => {
        await page.waitForLoadState('networkidle');
        assert.deepEqual(report.pageErrors, [], 'active load must handle response failure without page errors');
        assert.equal(await page.locator('#ready').innerText(), 'false', 'configuration is not ready before both results validate');
        const message = await page.locator('#fixture-error').innerText();
        assert.ok(message.length > 0, 'failed load must surface a visible fixture error promptly');
        assert.equal(await page.locator('#fixture-error').getAttribute('role'), 'alert');
        assert.equal(await page.locator('#open-alert').isDisabled(), true);
        await assert.rejects(() => waitScopeReady(page), /Scope fixture load failed/);
        report.fixtureError = message;
        await page.screenshot({ path: path.join(out, 'fixture-load-error.png') });
      });
    }
    await ctx.close();
  } else {
  for (const coarse of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: coarse, colorScheme: 'light' });
    await ctx.route('**/*', async route => { const url = new URL(route.request().url()); if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); } return route.continue(); });
    page = await ctx.newPage(); page.on('pageerror', e => report.errors.push(e.message));
    const goto = async () => {
      await page.goto(`${origin}/test/fixtures/admin-ui/scope.html?mode=${mode}`);
      if (mode === 'scopes') await waitScopeReady(page);
    };
    const dialog = page.getByRole('dialog');
    const open = async () => { await page.locator(mode === 'picker' ? '#open' : '#open-alert').click(); await dialog.waitFor(); };
    const menu = () => dialog.locator('.admin-picker-menu');
    if (mode === 'picker') {
      await goto(); await open();
      await check(`escaped optional summary and bounded slot use real DOM/${coarse}`, async () => {
        const summary = dialog.locator('.admin-picker-summary').first();
        assert.equal(await summary.innerText(), '<img src=x onerror=alert(1)> & "fixture"');
        assert.equal(await summary.getAttribute('title'), '<img src=x onerror=alert(1)> & "fixture"');
        assert.equal(await summary.locator('img').count(), 0);
        await summary.click(); assert.equal(await menu().locator('#slot-option').count(), 1, 'bounded before-options slot missing');
        assert.equal(await menu().locator('img').count(), 0);
        assert.ok((await menu().locator('.admin-picker-options').boundingBox()).height <= 201);
        await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.id), 'slot-option');
        await page.keyboard.press('Space'); assert.equal(await menu().locator('#slot-option').isChecked(), true);
        assert.equal(await page.locator('#selected').innerText(), '["node-0","node-1"]', 'slot is presentation-owned, not a picker model value');
        await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.value), 'node-0');
        await page.keyboard.press('Escape'); assert.equal(await menu().count(), 0); assert.equal(await summary.evaluate(el => el === document.activeElement), true);
      });
      await check(`default title, tags, count, minimum, hidden selections and one menu unchanged/${coarse}`, async () => {
        const summary = dialog.locator('.admin-picker-summary').nth(1); assert.equal(await summary.innerText(), 'Node 0'); assert.equal(await summary.getAttribute('title'), 'Node 0');
        assert.equal(await dialog.locator('.admin-picker').nth(1).locator('.admin-picker-tags').innerText(), 'Node 0');
        await summary.click(); assert.equal(await menu().locator('.admin-picker-count').innerText(), '1 / 120 selected');
        assert.equal(await menu().locator('input[value="node-0"]').isDisabled(), true);
        await menu().locator('.admin-picker-search input').fill('Node 1'); await menu().locator('input[value="node-1"]').check();
        await menu().locator('.admin-picker-search input').fill('Node 2'); assert.equal(await page.locator('#default-selected').innerText(), '["node-0","node-1"]');
        await page.keyboard.press('Escape'); await dialog.locator('.admin-picker-summary').first().click();
        await summary.focus(); await page.keyboard.press('ArrowDown'); assert.equal(await menu().count(), 1); assert.equal(await menu().locator('#slot-option').count(), 0);
        await page.keyboard.press('Escape'); await dialog.locator('#clear-override').click(); assert.equal(await dialog.locator('.admin-picker-summary').first().innerText(), '2 / 120 selected');
        await dialog.locator('#empty-override').click(); assert.equal((await dialog.locator('.admin-picker-summary').first().innerText()).trim(), '');
        await dialog.locator('#clear-override').click(); assert.equal(await dialog.locator('.admin-picker-summary').first().getAttribute('title'), '2 / 120 selected');
      });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    } else if (mode === 'scopes') {
      const reset = async count => {
        nodeCount = count; await db.prepare('DELETE FROM servers').run();
        if (count) await db.batch(Array.from({ length: count }, (_, n) => db.prepare('INSERT INTO servers VALUES (?)').bind(`node-${n}`)));
        const current = await (await action({ action: 'get_notification_config' })).json();
        assert.equal((await action({ action: 'save_notification_config', expectedRevision: current.revision, channels: current.channels, rules: [] })).status, 200);
        await goto(); await open();
      };
      const draftScope = async () => JSON.parse(await page.locator('#draft-scope').innerText());
      const save = async expected => {
        const before = report.saves.length; await dialog.locator('[data-action=save-rule]').click(); await dialog.waitFor({ state: 'hidden' });
        assert.equal(report.saves.length, before + 1); assert.deepEqual(report.saves.at(-1).rules.at(-1).scope, expected);
        assert.deepEqual(JSON.parse(await page.locator('#saved-scope').innerText()), expected);
      };
      await reset(3);
      await check(`all/future is two compact pickers, projected real IDs, escaped label and canonical D1 save/${coarse}`, async () => {
        assert.equal(await dialog.locator('.admin-picker-summary').count(), 2, 'all mode must mount both compact pickers');
        assert.equal(await dialog.locator('[name=scope]').count(), 0);
        assert.deepEqual(await draftScope(), { mode: 'all', serverIds: [] });
        await dialog.locator('.admin-picker-summary').first().click(); assert.equal(await menu().locator('[data-scope-all]').isChecked(), true);
        const checked = await menu().locator('.admin-picker-options input:checked').evaluateAll(nodes => nodes.filter(n => !n.hasAttribute('data-scope-all')).map(n => n.value)); assert.deepEqual(checked, ['node-0', 'node-1', 'node-2']);
        assert.equal(await menu().locator('script').count(), 0); assert.match(await menu().innerText(), /<script>alert\(1\)<\/script>/);
        await page.keyboard.press('Escape'); await save({ mode: 'all', serverIds: [] });
        const stored = await loadNotificationConfig(db); assert.deepEqual(stored.rules.at(-1).scope, { mode: 'all', serverIds: [] });
        nodeCount = 4; await db.prepare('INSERT INTO servers VALUES (?)').bind('node-3').run(); await goto(); await page.locator('#edit-last').click(); await dialog.locator('.admin-picker-summary').first().click();
        assert.equal(await menu().locator('input[value="node-3"]').isChecked(), true, 'explicit all includes a later real node'); assert.deepEqual(await draftScope(), { mode: 'all', serverIds: [] });
        await page.keyboard.press('Escape'); await dialog.locator('[data-action=cancel]').click(); nodeCount = 3; await db.prepare('DELETE FROM servers WHERE id=?').bind('node-3').run(); await goto();
      });
      await check(`individual changes are exact selected; selected-full never promotes to all/${coarse}`, async () => {
        await open(); await dialog.locator('.admin-picker-summary').first().click(); await menu().locator('input[value="node-1"]').uncheck(); assert.deepEqual(await draftScope(), { mode: 'selected', serverIds: ['node-0', 'node-2'] });
        await menu().locator('input[value="node-1"]').check(); assert.deepEqual(await draftScope(), { mode: 'selected', serverIds: ['node-0', 'node-2', 'node-1'] });
        assert.equal(await menu().locator('[data-scope-all]').isChecked(), false); await page.keyboard.press('Escape'); await save({ mode: 'selected', serverIds: ['node-0', 'node-2', 'node-1'] });
        nodeCount = 4; await db.prepare('INSERT INTO servers VALUES (?)').bind('node-3').run(); await goto(); await page.locator('#edit-last').click(); await dialog.locator('.admin-picker-summary').first().click(); assert.equal(await menu().locator('input[value="node-3"]').isChecked(), false);
        assert.equal(await menu().locator('[data-scope-all]').isChecked(), false); await menu().locator('[data-scope-all]').check(); assert.deepEqual(await draftScope(), { mode: 'all', serverIds: [] }); await page.keyboard.press('Escape'); await save({ mode: 'all', serverIds: [] });
      });
      await check(`last-node guard and empty-node all stay valid without empty selected payload/${coarse}`, async () => {
        await reset(1); await dialog.locator('.admin-picker-summary').first().click(); assert.equal(await menu().locator('input[value="node-0"]').isDisabled(), true);
        await menu().locator('[data-scope-all]').uncheck(); assert.deepEqual(await draftScope(), { mode: 'selected', serverIds: ['node-0'] }); assert.equal(await menu().locator('input[value="node-0"]').isDisabled(), true);
        await page.keyboard.press('Escape'); await save({ mode: 'selected', serverIds: ['node-0'] });
        await reset(0); assert.equal(await dialog.locator('.admin-picker-summary').count(), 2); await dialog.locator('.admin-picker-summary').first().click(); assert.equal(await menu().locator('[data-scope-all]').isChecked(), true); assert.equal(await menu().locator('[data-scope-all]').isDisabled(), true); assert.deepEqual(await draftScope(), { mode: 'all', serverIds: [] }); await page.keyboard.press('Escape'); await save({ mode: 'all', serverIds: [] });
        await open(); await dialog.evaluate(el => { el.__vueParentComponent.parent.props.draft.scope = { mode: 'selected', serverIds: [] }; }); const before = report.saves.length;
        await dialog.locator('[data-action=save-rule]').click(); assert.equal(await dialog.locator('[role=alert]').count(), 1); assert.equal(report.saves.length, before, 'invalid empty-selected draft is never sent'); await dialog.locator('[data-action=cancel]').click();
      });
      await check(`missing import remains disabled and cannot widen until a separately saved exact repair/${coarse}`, async () => {
        await reset(3); await dialog.locator('[data-action=cancel]').click();
        const stored = await loadNotificationConfig(db); stored.rules = [{ id: 'imported', name: 'Imported scope', type: 'offline', enabled: false, options: { minutes: 3 }, scope: { mode: 'selected', serverIds: ['unresolved_fixture'] }, targetIds: [stored.channels[0].id] }];
        await db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(JSON.stringify(stored)).run(); await goto(); await page.locator('#edit-imported').click();
        assert.equal(await dialog.locator('[name=enabled]').isDisabled(), true); await dialog.locator('.admin-picker-summary').first().click(); assert.equal(await menu().locator('[data-scope-all]').isDisabled(), true);
        await menu().locator('.admin-picker-search input').fill('Node 0'); await menu().locator('input[value="node-0"]').check(); await menu().locator('.admin-picker-search input').fill('unresolved'); await menu().locator('input[value="unresolved_fixture"]').uncheck();
        assert.equal(await menu().locator('[data-scope-all]').isDisabled(), true, 'historical missing refs require saving repair before widening'); assert.deepEqual(await draftScope(), { mode: 'selected', serverIds: ['node-0'] });
        await page.keyboard.press('Escape'); assert.equal(await dialog.locator('[name=enabled]').isChecked(), false); await dialog.locator('[name=enabled]').check(); await save({ mode: 'selected', serverIds: ['node-0'] });
        await page.locator('#edit-imported').click(); await dialog.locator('.admin-picker-summary').first().click(); assert.equal(await menu().locator('[data-scope-all]').isDisabled(), false); await page.keyboard.press('Escape'); await dialog.locator('[data-action=cancel]').click();
      });
      await reset(120);
      for (const [width, height] of [[1440, 900], [390, 540], [320, 540]]) await check(`bounded scope menu, keyboard and effective touch/${width}x${height}/${coarse}`, async () => {
        await page.setViewportSize({ width, height }); assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
        const summary = dialog.locator('.admin-picker-summary').first(); await summary.scrollIntoViewIfNeeded(); await summary.focus(); await page.keyboard.press('ArrowDown');
        assert.equal(await menu().count(), 1); await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-scope-all')), true);
        const list = await menu().locator('.admin-picker-options').boundingBox(), box = await menu().boundingBox(); assert.ok(list.height <= 201); assert.ok(box.x >= 15 && box.x + box.width <= width - 15); assert.ok(box.y >= 15 && box.y + box.height <= height - 15);
        const option = menu().locator('[data-scope-all]').locator('..'); await option.scrollIntoViewIfNeeded();
        if (coarse) { const r = await option.boundingBox(); assert.ok(r.width >= 44 && r.height >= 44); assert.equal(await option.evaluate(el => { const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return [[x-21,y],[x+21,y],[x,y-21],[x,y+21]].every(([px,py]) => el.contains(document.elementFromPoint(px,py))); }), true); }
        report.measurements.push({ width, height, coarse, list, box }); await page.screenshot({ path: path.join(out, `scope-${width}x${height}-${coarse ? 'coarse' : 'fine'}.png`) }); assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
        await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1); assert.equal(await summary.evaluate(el => el === document.activeElement), true);
      });
      if (coarse) await check('collapsed routing preview has a real44px hit target and keyboard toggle', async () => {
        const summary = dialog.locator('.admin-routing-preview summary'); await summary.scrollIntoViewIfNeeded(); const box = await summary.boundingBox();
        assert.ok(box.height >= 44); assert.equal(await summary.evaluate(el => { const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return [[x-21,y],[x+21,y],[x,y-21],[x,y+21]].every(([px,py])=>el.contains(document.elementFromPoint(px,py))); }), true);
        await summary.focus(); await page.keyboard.press('Enter'); assert.equal(await dialog.locator('.admin-routing-preview').evaluate(el => el.open), true);
        await page.keyboard.press('Enter'); assert.equal(await dialog.locator('.admin-routing-preview').evaluate(el => el.open), false);
      });
    } else throw new Error('picker or scopes');
    await ctx.close();
  }
  }
} catch (error) { report.errors.push(error.stack); if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); }
finally { releaseList?.(); await browser?.close(); await server?.close(); await mf?.dispose(); report.stopped = true; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks.length, errors: report.errors, stopped: true })); if (report.errors.length) process.exitCode = 1; }
