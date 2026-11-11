import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from '../test/fixtures/admin-ui/notification-matrix-server.mjs';
import vue from '@vitejs/plugin-vue';
import en from '../src/frontend/locales/en.js';

if (process.argv.includes('--task4')) {
  await import('../test/fixtures/admin-ui/task4.mjs');
  process.exit(process.exitCode || 0);
}

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const executablePath = process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe';
const out = path.resolve(process.env.ADMIN_UI_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-3/browser');
fs.mkdirSync(out, { recursive: true });
const report = { stage: 'Task3 only; table/settings/notifications/terminal lifecycle deferred', node: process.version, executablePath, dpr: 1, font: 'ui-sans-serif,sans-serif', results: [], networkDenied: [], errors: [] };
const baselineReplay = process.env.ADMIN_UI_BASELINE === '1';
report.baselineReplay = baselineReplay;
const seed = JSON.parse(fs.readFileSync('docs/superpowers/admin-ui-refactor/evidence/task-0/reference-data-viewport-tokens.json', 'utf8'));
report.data = seed.nodes;
const initialServers = seed.nodes.map(n => ({ id: `node-${n.id}`, name: n.name, server_group: n.group, region: n.country, os: n.os, ip_v4: n.ip, price: n.price, expire_date: n.expires, billing_cycle: n.price.includes('年') ? 'year' : 'month', currency: n.price[0], note: n.note, tags: n.tag, is_online: n.online, agent_version: n.version, traffic_limit: n.limit, rx: n.used * 1024 ** 3, tx: 0 }));
const servers = initialServers.map(server => ({ ...server }));
report.fixtureServers = initialServers;
let holdAction = '', releaseAction, loginFails = false, usageSucceeds = false;
const usageDay = { rowsRead: 120, rowsWritten: 30, workersRequests: 40, durableObjectsRequests: 12, durableObjectsDuration: 5 };
const actions = [];
let server, browser;
run: try {
  const baselinePlugin = {
    name: 'admin-ui-accepted-baseline', enforce: 'pre',
    load(id) {
      if (!baselineReplay || id.includes('?')) return;
      const relative = path.relative(process.cwd(), id).replaceAll('\\', '/');
      const saved = path.resolve('docs/superpowers/admin-ui-refactor/evidence/task-3/source-before', relative);
      if (relative.startsWith('src/') && fs.existsSync(saved)) return fs.readFileSync(saved, 'utf8');
    },
    transform(source, id) {
      if (baselineReplay && id.endsWith('/test/fixtures/admin-ui/Fixture.vue')) return source.replace(/import\.meta\.glob\([^\n]+\)/, '{}');
    }
  };
  server = await createServer({ frontendExports: true, configFile: false, cacheDir: path.join(out, '.vite-cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router'] }, plugins: [baselinePlugin, vue()], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') });
  await server.listen();
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 768, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', hasTouch: true });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.fixtureClipboard = text; }, readText: async () => window.fixtureClipboard || '' } });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.networkDenied.push(url.origin); await route.abort(); return; }
    if (url.pathname.endsWith('/admin-ui-approved/preview.html')) {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync('docs/superpowers/references/admin-ui-approved/preview.html') }); return;
    }
    if (url.pathname === '/' && route.request().isNavigationRequest()) { await route.fulfill({ contentType: 'text/html', body: '<p id="fixture-public-redirect">Fixture public redirect</p>' }); return; }
    if (url.pathname.endsWith('/admin/api')) {
      const data = route.request().postDataJSON() || {};
      actions.push({ action: data.action, site: url.pathname, id: data.id });
      if (data.action === holdAction) await new Promise(resolve => { releaseAction = resolve; });
      if (data.action === 'login' && loginFails) { await route.fulfill({ status: 401, json: { error: 'Fixture invalid login' } }); return; }
      if (data.action === 'edit') Object.assign(servers.find(s => s.id === data.id), data);
      if (data.action === 'delete') servers.splice(servers.findIndex(s => s.id === data.id), 1);
      if (data.action === 'add') servers.push({ id: 'fixture-added', name: data.name, server_group: data.server_group });
      const result = data.action === 'd1_usage' ? (usageSucceeds ? { success: true, usage: { today: usageDay, yesterday: usageDay } } : { success: false, error: 'Fixture usage error' })
        : data.action === 'terminal_status' ? { enabled: false, connected: false, supported: false }
        : { success: true, settings: { site_title: url.pathname.startsWith('/site-b') ? 'Site B' : 'CF Monitor', auto_discovery: true, username: 'fixture', password_configured: true }, servers, stats: { total: servers.length, online: 4, offline: 2, avg_cpu: 12 }, last_agent_version: '2.8.6', action: data.action };
      await route.fulfill({ json: result }); return;
    }
    if (url.pathname.endsWith('/theme')) { await route.fulfill({ json: { schema: 1, themes: [] } }); return; }
    if (url.pathname.endsWith('/api/config')) { await route.fulfill({ json: { last_agent_version: '2.8.6' } }); return; }
    if (url.pathname.endsWith('/clearHistory') || url.pathname.endsWith('/updateDatabase')) { await route.fulfill({ json: { success: true, message: 'Fixture database result' } }); return; }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(baselineReplay ? 3000 : 10000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', e => report.errors.push(e.message));
  const fixture = (mode = '', extra = '') => `${origin}/test/fixtures/admin-ui/index.html?mode=${mode}${extra}#/admin`;
  const check = async (name, fn) => {
    try { await fn(); report.results.push({ name, pass: true }); }
    catch (error) {
      const key = `failure-${report.results.length}`;
      await page.screenshot({ path: `${out}/${key}.png` }).catch(() => {});
      report.results.push({ name, pass: false, error: error.message, screenshot: key, focus: await page.evaluate(() => ({ active: document.activeElement.outerHTML.slice(0, 400), bodyClass: document.body.className })).catch(() => null) });
    }
  };
  const effective44 = async locator => {
    const result = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hits = [[x - 21, y], [x + 21, y], [x, y - 21], [x, y + 21]].map(([px, py]) => {
        const target = document.elementFromPoint(px, py);
        return { px, py, owned: element.contains(target), target: target?.outerHTML.slice(0, 200) };
      });
      return { element: element.outerHTML.slice(0, 200), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hits, pass: hits.every(hit => hit.owned) };
    });
    if (!result.pass) (report.targetDiagnostics ||= []).push(result);
    return result.pass;
  };
  const visibleMenu = async () => {
    const menu = page.locator('.admin-picker-menu');
    assert.equal(await menu.count(), 1);
    assert.equal(await menu.evaluate(element => {
      const r = element.getBoundingClientRect();
      return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight &&
        [[r.x + r.width / 2, r.y + 2], [r.x + r.width / 2, r.bottom - 3]].every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    }), true, 'popup must be unclipped and actually hit-testable');
  };
  if (process.argv.includes('--correction-probe')) {
    report.lowViewport = [];
    for (const size of [{ width: 390, height: 540 }, { width: 320, height: 440 }]) {
      await page.setViewportSize(size);
      await page.goto(fixture('', `&lowViewport=1&caseWidth=${size.width}`));
      await check(`coarse header44 hit areas ${size.width}`, async () => {
        for (const selector of ['.admin-theme-button', '.admin-header-actions button:last-child', size.width > 360 ? '.admin-public-link' : '.admin-site-name']) assert.equal(await effective44(page.locator(selector)), true, selector);
        if (size.width <= 360) assert.equal(await page.locator('.admin-public-link').isVisible(), false);
      });
      await check(`coarse navigation and site link44 ${size.width}`, async () => {
        assert.equal(await effective44(page.locator('.admin-site-name')), true);
        assert.equal(await effective44(page.locator('.admin-nav-item').first()), true);
      });
      await page.locator('#open-dialog').click();
      await check(`coarse dialog close44 ${size.width}`, async () => assert.equal(await effective44(page.locator('.admin-dialog-close')), true));
      await check(`coarse dialog footer44 ${size.width}`, async () => {
        for (const selector of ['.admin-dialog-footer .btn:first-child', '.admin-dialog-footer .btn:last-child']) assert.equal(await effective44(page.locator(selector)), true, selector);
      });
      await page.locator('.admin-dialog-body').evaluate(body => {
        body.querySelector('#before-picker').style.height = `${Math.max(24, (body.clientHeight - 36) / 2 - 50)}px`;
        body.scrollTop = 0;
      });
      await page.getByRole('button', { name: 'Dialog channels', exact: true }).click();
      await check(`selected tags no-description popup visible and44 ${size.width}x${size.height}`, async () => {
        await visibleMenu();
        assert.equal(await effective44(page.getByRole('button', { name: 'Dialog channels', exact: true })), true, 'picker trigger effective44');
        assert.equal(await effective44(page.getByRole('searchbox')), true, 'picker search effective44');
        assert.equal(await effective44(page.locator('.admin-picker-option').first()), true);
        assert.equal(await effective44(page.locator('.admin-picker-option').nth(1)), true, 'adjacent44px rows must not overlap');
        const bottom = page.locator('.admin-picker-options');
        await bottom.evaluate(e => { e.scrollTop = e.scrollHeight; });
        await page.locator('.admin-picker-options input[value="node-119"]').check();
        await page.getByRole('searchbox').fill('node-1');
        await page.getByLabel('node-1', { exact: true }).check();
        await page.getByRole('searchbox').fill('');
        assert.equal(await page.getByLabel('node-0', { exact: true }).isChecked(), true);
        await page.getByRole('searchbox').focus(); await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.type), 'checkbox');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true);
        await visibleMenu();
      });
      await page.screenshot({ path: `${out}/selected-tags-${size.width}x${size.height}-before-resize.png` });
      await check(`popup anchor tracks body scroll and viewport resize ${size.width}`, async () => {
        await page.getByRole('searchbox').focus();
        await page.locator('.admin-dialog-body').evaluate(e => { e.scrollTop += 12; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await visibleMenu();
        await page.setViewportSize({ ...size, height: size.height - 60 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await visibleMenu();
        const anchor = await page.getByRole('button', { name: 'Dialog channels', exact: true }).boundingBox();
        const popup = await page.locator('.admin-picker-menu').boundingBox();
        assert.ok(Math.abs(anchor.x - popup.x) <= 1);
        assert.ok(Math.min(Math.abs(popup.y - anchor.y - anchor.height - 4), Math.abs(popup.y + popup.height - anchor.y + 4)) <= 2, 'menu remains tied to its visible trigger');
        assert.ok((await page.locator('.admin-picker-options').boundingBox()).height <= 200);
      });
      await page.screenshot({ path: `${out}/selected-tags-${size.width}x${size.height - 60}-after-resize.png` });
      report.lowViewport.push({ initialViewport: size, measuredViewport: page.viewportSize(), menu: await page.locator('.admin-picker-menu').boundingBox(), body: await page.locator('.admin-dialog-body').boundingBox(), coarse: await page.evaluate(() => matchMedia('(pointer: coarse)').matches) });
      await page.keyboard.press('Escape');
      await check(`menu Escape restores trigger before dialog ${size.width}`, async () => {
        assert.equal(await page.getByRole('dialog').count(), 1);
        assert.equal(await page.locator('.admin-picker-menu').count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Dialog channels');
      });
      await check(`outside closes popup and scroll-out removes orphaned popup ${size.width}`, async () => {
        await page.getByRole('button', { name: 'Dialog channels', exact: true }).click();
        await page.getByRole('heading', { name: 'Fixture dialog', exact: true }).click();
        assert.equal(await page.locator('.admin-picker-menu').count(), 0);
        await page.getByRole('button', { name: 'Dialog channels', exact: true }).click();
        await page.locator('.admin-dialog-body').evaluate(e => { e.scrollTop = e.scrollHeight; });
        await page.locator('.admin-picker-menu').waitFor({ state: 'detached' });
      });
      await page.keyboard.press('Escape');
    }
    const fine = await context.browser().newContext({ viewport: { width: 390, height: 540 }, hasTouch: false, colorScheme: 'light' });
    await fine.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { report.networkDenied.push(new URL(route.request().url()).origin); await route.abort(); return; }
      await route.continue();
    });
    const finePage = await fine.newPage();
    try {
      await finePage.goto(fixture('', '&lowViewport=1'));
      await check('fine pointer keeps compact38px rows and32px close', async () => {
        assert.equal(await finePage.evaluate(() => matchMedia('(pointer: fine)').matches), true);
        await finePage.getByRole('button', { name: 'Select servers', exact: true }).click();
        assert.equal((await finePage.locator('.admin-picker-option').first().boundingBox()).height, 38);
        await finePage.keyboard.press('Escape');
        await finePage.locator('#open-dialog').click();
        assert.equal((await finePage.locator('.admin-dialog-close').boundingBox()).width, 32);
        await finePage.screenshot({ path: `${out}/fine-pointer-390x540.png` });
      });
    } finally { await fine.close(); }
    await page.goto(`${origin}/docs/superpowers/references/admin-ui-approved/preview.html`);
    await check('reference response is UTF-8 with original Chinese labels', async () => {
      assert.equal(await page.evaluate(() => document.characterSet), 'UTF-8');
      assert.match(await page.locator('.rep-nav').innerText(), /节点/);
      assert.match(await page.locator('.rep-nav').innerText(), /通知/);
    });
    await context.close(); break run;
  }
  await page.goto(fixture());
  await check('768 sidebar is 176px', async () => {
    const nav = page.locator('.admin-nav');
    assert.equal(await nav.count(), 1, 'missing real AdminLayout navigation');
    assert.equal(Math.round((await nav.boundingBox()).width), 176);
    assert.equal(await nav.evaluate(e => getComputedStyle(e).flexDirection), 'column');
  });
  await check('390 single row horizontally scrolling nav', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.admin-nav').evaluate(e => getComputedStyle(e).flexDirection), 'row');
    assert.equal(await page.locator('.admin-nav').evaluate(e => getComputedStyle(e).overflowX), 'auto');
  });
  await check('dialog trap, restore, Escape and viewport scroll', async () => {
    await page.locator('#open-dialog').click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.count(), 1, 'current dialog lacks shared accessible container');
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 1, 'dialog must be horizontally centered');
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) <= 1, 'dialog must be vertically centered');
    assert.ok((await page.locator('#dialog-last').boundingBox()).y < (await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()).y, 'mobile primary action must appear first');
    await page.locator('#dialog-last').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('[role="dialog"]') !== null), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dialog-last');
    const body = page.locator('.admin-dialog-body');
    assert.equal(await body.evaluate(e => e.scrollHeight > e.clientHeight), true);
    assert.ok((await dialog.boundingBox()).height <= 812);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-dialog');
  });
  if (process.argv.includes('--dialog-probe')) { await context.close(); break run; }
  await check('busy prevents Escape and backdrop close', async () => {
    await page.locator('#open-busy').click(); await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.locator('.admin-dialog-overlay').click({ position: { x: 2, y: 2 } });
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await page.locator('.admin-dialog-close').isDisabled(), true);
    await page.locator('#dialog-last').click(); await page.keyboard.press('Escape');
  });
  await check('idle backdrop close restores trigger focus', async () => {
    await page.locator('#open-dialog').click();
    await page.locator('.admin-dialog-overlay').click({ position: { x: 2, y: 2 } });
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-dialog');
  });
  await check('120 options bounded, search retains hidden selection, last and disabled', async () => {
    const picker = page.getByRole('button', { name: 'Select servers', exact: true });
    await picker.click();
    const list = page.locator('.admin-picker-options');
    assert.equal(await list.locator('input').count(), 120);
    assert.ok((await list.boundingBox()).height <= 200);
    await page.getByRole('searchbox').fill('node-0');
    await page.getByLabel('node-0', { exact: true }).uncheck();
    assert.equal(await page.locator('#selected').textContent(), '["node-1"]');
    await page.getByRole('searchbox').fill('');
    assert.equal(await page.getByLabel('node-1', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('node-1', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('node-3', { exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await picker.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Select servers');
  });
  await check('single menu and keyboard at 320 viewport', async () => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('button', { name: 'Select servers', exact: true }).click();
    await page.getByRole('button', { name: 'Select channels', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.admin-picker-menu').count(), 1);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.type), 'checkbox');
    await page.keyboard.press('Space');
    assert.equal(await page.getByLabel('node-0', { exact: true }).isChecked(), true);
    assert.ok((await page.locator('.admin-picker-menu').boundingBox()).x >= 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
  });
  await check('dialog menu flips inside scrolling body and Escape closes only menu', async () => {
    await page.locator('#open-dialog').click();
    await page.locator('.admin-dialog-body').evaluate(e => { e.scrollTop = e.scrollHeight; });
    await page.getByRole('button', { name: 'Dialog channels', exact: true }).click();
    await visibleMenu();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await page.locator('.admin-picker-menu').count(), 0);
    await page.keyboard.press('Escape');
  });
  await check('touch row selection and outside dismissal', async () => {
    await page.getByRole('button', { name: 'Select servers', exact: true }).tap();
    const option = page.locator('.admin-picker-option').filter({ has: page.getByLabel('node-2', { exact: true }) });
    assert.equal(await effective44(option), true, '44px effective touch row including description-free options');
    await option.tap();
    assert.equal(await page.getByLabel('node-2', { exact: true }).isChecked(), true);
    await page.locator('#last-page').tap();
    assert.equal(await page.locator('.admin-picker-menu').count(), 0);
  });
  await check('long label remains bounded and hidden selections survive search', async () => {
    await page.getByRole('button', { name: 'Select servers', exact: true }).click();
    await page.getByRole('searchbox').fill('Long option label');
    await page.locator('.admin-picker-options input[value="node-119"]').check();
    const selection = JSON.parse(await page.locator('#selected').textContent());
    assert.ok(selection.includes('node-1') && selection.includes('node-2') && selection.includes('node-119'));
    assert.ok((await page.locator('.admin-picker-options').boundingBox()).height <= 200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${out}/long-label-320.png` });
  });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
    await page.goto(fixture());
    await page.screenshot({ path: `${out}/components-${width}.png`, fullPage: true });
  }
  report.publicStyles = {};
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(fixture('public'));
    await page.getByRole('button', { name: scheme === 'dark' ? 'Dark Mode' : 'Light Mode', exact: true }).click();
    report.publicStyles[scheme] = await page.evaluate(() => {
      const values = e => { const c = getComputedStyle(e); return { color: c.color, background: c.backgroundColor, font: c.fontFamily, fontSize: c.fontSize, border: c.border, padding: c.padding, overflow: c.overflow }; };
      return { body: values(document.body), button: values(document.querySelector('#public-control .btn')), input: values(document.querySelector('#public-control .form-input')), header: values(document.querySelector('.terminal-header')), scanline: getComputedStyle(document.body, '::before').display, marker: document.body.classList.contains('admin-ui-surface') };
    });
    await page.screenshot({ path: `${out}/public-${scheme}-320.png` });
  }
  if (!baselineReplay) {
    const baselinePath = path.resolve('docs/superpowers/admin-ui-refactor/evidence/task-3/browser-red-final/report.json');
    await check('public computed styles equal exact Task2 baseline', async () => {
      assert.ok(fs.existsSync(baselinePath), 'run baseline replay in browser-red-final first');
      assert.deepEqual(report.publicStyles, JSON.parse(fs.readFileSync(baselinePath)).publicStyles);
    });
    await check('actual admin mounts nine real panels and preserves shared settings draft', async () => {
      await page.goto(fixture('admin'));
      await page.locator('.server-row').first().waitFor();
      assert.equal(await page.locator('.server-row').count(), 6);
      assert.equal(await page.locator('.admin-nav button').count(), 9);
      await page.locator('.admin-nav-item').filter({ hasText: /^SETTINGS$/i }).click();
      const title = page.locator('[data-setting-field=site_title]');
      await title.fill('Unsaved shared draft');
      await page.locator('.admin-nav-item').filter({ hasText: /^Data$/i }).click();
      await page.locator('.admin-nav-item').filter({ hasText: /^SETTINGS$/i }).click();
      assert.equal(await title.inputValue(), 'Unsaved shared draft');
    });
    await check('below 640 toolbar fields fill one row and actions wrap below', async () => {
      await page.locator('[data-page=servers]').click();
      for (const width of [390, 320, 639]) {
        await page.setViewportSize({ width, height: 844 });
        const input = await page.locator('#tab-servers .admin-search').boundingBox();
        const group = await page.locator('#tab-servers .admin-filter-group .toolbar-select').boundingBox();
        const add = await page.locator('#tab-servers .toolbar').getByRole('button', { name: new RegExp(en.adminAddNode) }).boundingBox();
        assert.ok(Math.abs(input.y - group.y) <= 1);
        assert.ok(input.width >= width - 32 - 169, `mobile name field must not shrink beside the actions at ${width}`);
        assert.ok(add.y >= input.y + input.height, 'actions belong on their own mobile row');
      }
      await page.setViewportSize({ width: 320, height: 844 });
    });
    await check('actual edit handler, cancel, busy close gate and response feedback', async () => {
      await page.locator('[data-page=servers]').click();
      const row = page.locator('.server-row').first();
      await row.getByRole('button', { name: en.edit, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.cancel, 'i'), exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await row.getByRole('button', { name: en.edit, exact: true }).click();
      holdAction = 'edit';
      const request = page.waitForRequest(r => r.url().endsWith('/admin/api') && r.postDataJSON()?.action === 'edit');
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.save, 'i'), exact: true }).click();
      await request;
      assert.equal(await page.getByRole('dialog').getAttribute('aria-busy'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 1);
      assert.equal(await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.cancel, 'i'), exact: true }).isDisabled(), true);
      holdAction = ''; releaseAction();
      await page.getByRole('dialog', { name: new RegExp(en.save, 'i'), exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.ok(actions.some(a => a.action === 'edit' && a.id === 'node-1'));
    });
    await check('actual installation, delete warning, database and usage dialog containers', async () => {
      const row = page.locator('.server-row').first();
      await row.getByRole('button', { name: en.copy, exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 1);
      assert.equal(await page.getByRole('dialog').locator('select').first().inputValue(), 'linux');
      await page.keyboard.press('Escape');
      await row.getByRole('button', { name: en.delete, exact: true }).click();
      assert.match(await page.getByRole('dialog').textContent(), /uninstall/i);
      await page.keyboard.press('Escape');
      await page.locator('.admin-nav-item').filter({ hasText: /^Data$/i }).click();
      await page.locator('#tab-database').getByRole('button', { name: /Clear History Data/i }).click();
      assert.match(await page.getByRole('dialog').textContent(), /history/i);
      await page.keyboard.press('Escape');
      assert.equal(actions.filter(a => a.action === 'delete').length, 0);
      await page.locator('.admin-nav-item').filter({ hasText: /^SETTINGS$/i }).click();
      await page.getByRole('button', { name: /Query CF Account Usage/i }).click();
      assert.match(await page.getByRole('dialog').textContent(), /Fixture usage error/);
      await page.keyboard.press('Escape');
    });
    await check('successful usage body stays neutral with Mikus', async () => {
      usageSucceeds = true;
      await page.getByRole('button', { name: /Query CF Account Usage/i }).click();
      await page.getByRole('dialog').locator('.quota-section').first().waitFor();
      const styles = () => page.locator('.quota-section').evaluateAll(elements => elements.map(e => {
        const c = getComputedStyle(e); return { background: c.backgroundColor, border: c.borderColor, shadow: c.boxShadow, filter: c.backdropFilter };
      }));
      const before = await styles();
      await page.evaluate(async () => { const { applyMikusThemeOptions } = await import('/src/frontend/utils/themeOptions.js'); applyMikusThemeOptions({ mikus: true }); });
      await page.screenshot({ path: `${out}/usage-success-320.png` });
      try { assert.deepEqual(await styles(), before); }
      finally { usageSucceeds = false; await page.keyboard.press('Escape'); }
    });
    await check('real add/delete handlers and batch/auto-discovery/terminal security containers', async () => {
      await page.locator('[data-page=servers]').click();
      await page.locator('#tab-servers .toolbar').getByRole('button', { name: new RegExp(en.adminAddNode) }).click();
      await page.locator('#add-server-name').fill('Fixture added');
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(en.adminAddNode) }).click();
      const added = page.locator('.server-row').filter({ hasText: 'Fixture added' });
      await added.waitFor();
      await page.getByRole('dialog', { name: new RegExp(en.save, 'i'), exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await added.getByRole('button', { name: en.delete, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: en.confirmDelete, exact: true }).click();
      await added.waitFor({ state: 'detached' });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.server-row').count(), 6);
      assert.ok(actions.some(a => a.action === 'delete' && a.id === 'fixture-added'));
      await page.getByRole('button', { name: en.group, exact: true }).click();
      await page.locator('.server-checkbox').first().check();
      await page.getByRole('dialog').locator('summary').click();
      await page.getByRole('button', { name: /Batch Edit/i }).click();
      assert.match(await page.getByRole('dialog').getAttribute('aria-labelledby'), /admin-dialog/);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: new RegExp(en.adminBulkAdd, 'i') }).click();
      assert.equal(await page.getByRole('dialog').locator('select').first().inputValue(), 'linux');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.server-row').first().getByRole('button', { name: en.terminalOpen, exact: true }).isDisabled(), true, 'HTTP fixture must not bypass HTTPS terminal gate');
      await page.goto(fixture());
      await page.locator('#open-terminal-access').click();
      await page.locator('.terminal-consent').waitFor();
      assert.match(await page.getByRole('dialog').textContent(), /privilege|root/i);
      assert.equal(await page.getByRole('dialog').getAttribute('aria-describedby'), 'terminal-risk');
      assert.equal(await page.locator('.terminal-consent input').isChecked(), false);
      await page.keyboard.press('Escape');
      assert.equal(actions.some(a => ['terminal_authorize_node', 'terminal_enable_site', 'terminal_open'].includes(a.action)), false);
    });
    await check('site switch uses selected apiIndex and cleans old node modal', async () => {
      await page.goto(fixture('admin', '&sites=1'));
      await page.locator('.server-row').first().waitFor();
      await page.locator('[data-page=settings]').click();
      const select = page.locator('#admin-site');
      await page.evaluate(async () => {
        const { applyMikusThemeOptions } = await import('/src/frontend/utils/themeOptions.js');
        applyMikusThemeOptions({ mikus: true });
      });
      holdAction = 'get_settings';
      await select.selectOption('1');
      await page.locator('.admin-loading-overlay').waitFor();
      const loading = await page.locator('.admin-loading-overlay').evaluate(e => getComputedStyle(e).backgroundColor);
      const expectedLoading = await page.evaluate(() => {
        const e = document.createElement('div'); e.className = 'admin-ui'; e.style.background = 'color-mix(in srgb, var(--cf-panel) 90%, transparent)';
        document.body.append(e); const color = getComputedStyle(e).backgroundColor; e.remove(); return color;
      });
      try { assert.equal(loading, expectedLoading, 'Mikus must not tint the site-loading overlay'); }
      finally { holdAction = ''; releaseAction(); }
      await page.locator('.admin-site-name').filter({ hasText: 'Site B' }).waitFor();
      assert.ok(actions.some(a => a.site === '/site-b/admin/api' && a.action === 'list'));
      assert.equal(await page.getByRole('dialog').count(), 0);
    });
    await check('route unmount removes admin marker and leaves public controls intact', async () => {
      assert.equal(await page.evaluate(() => document.body.classList.contains('admin-ui-surface')), true);
      await page.evaluate(() => { location.hash = '#/public'; });
      await page.locator('#public-control').waitFor();
      assert.equal(await page.evaluate(() => document.body.classList.contains('admin-ui-surface')), false);
      assert.equal(await page.locator('.terminal-header').count(), 1);
    });
    await check('actual login retains validation, failed login feedback and successful handler', async () => {
      await context.clearCookies();
      await page.goto(fixture('login'));
      assert.equal(await page.locator('#login-overlay').count(), 1);
      await page.locator('input[name="username"]').fill('fixture');
      await page.locator('input[name="password"]') .fill('fixture-only');
      loginFails = true;
      await page.locator('.login-btn').click();
      await page.locator('#login-error').waitFor();
      assert.equal(await page.locator('input[name="password"]') .inputValue(), '');
      loginFails = false;
      await page.locator('input[name="password"]') .fill('fixture-only');
      await page.locator('.login-btn').click();
      await page.locator('.admin-nav').waitFor();
      assert.ok(actions.filter(a => a.action === 'login').length >= 2);
    });
    await check('header logout emits original logout action and public redirect', async () => {
      await page.getByRole('button', { name: en.logout, exact: true }).click();
      await page.locator('#fixture-public-redirect').waitFor();
      assert.ok(actions.some(a => a.action === 'logout'));
    });
    if (process.argv.includes('--interactions-probe')) { await context.close(); break run; }
    servers.splice(0, servers.length, ...initialServers.map(server => ({ ...server })));
    report.geometry = [];
    for (const width of [1440, 1024, 768, 390, 320]) {
      for (const theme of ['light', 'dark', 'auto']) {
        await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
        await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' });
        await page.goto(fixture('admin', `&locale=${width === 320 ? 'fr' : 'zh'}`));
        await page.locator('.server-row').first().waitFor();
        await page.locator('[data-page=themeStore]').click();
        await page.locator('.admin-theme-select').selectOption(theme);
        await page.locator('[data-page=servers]').click();
        const before = await page.evaluate(() => {
          const header = document.querySelector('.admin-header');
          const button = getComputedStyle(document.querySelector('.toolbar .btn'));
          return { color: getComputedStyle(header).backgroundColor, height: header.getBoundingClientRect().height, button: { color: button.color, background: button.backgroundColor, shadow: button.boxShadow }, tableShadow: getComputedStyle(document.querySelector('.table-wrapper')).boxShadow };
        });
        await page.evaluate(async () => {
          const { applyMikusThemeOptions } = await import('/src/frontend/utils/themeOptions.js');
          applyMikusThemeOptions({ mikus: true });
          document.body.style.backgroundImage = 'linear-gradient(red, blue)';
        });
        await check(`neutral admin ${width}/${theme} with Mikus and custom background`, async () => {
          const after = await page.evaluate(() => {
            const header = document.querySelector('.admin-header');
            const button = getComputedStyle(document.querySelector('.toolbar .btn'));
            return { color: getComputedStyle(header).backgroundColor, height: header.getBoundingClientRect().height, button: { color: button.color, background: button.backgroundColor, shadow: button.boxShadow }, tableShadow: getComputedStyle(document.querySelector('.table-wrapper')).boxShadow };
          });
          assert.deepEqual(after, before);
          assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundImage), 'none');
          assert.equal(await page.locator('.mikus-global-sakura').evaluate(e => getComputedStyle(e).display), 'none');
          assert.equal(await page.locator('.admin-content').evaluate(e => getComputedStyle(e).fontFamily), 'ui-sans-serif, sans-serif');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          if (width < 1280) assert.equal(await page.locator('.table-wrapper').evaluate(e => e.scrollWidth > e.clientWidth), true, 'preview table scrolls below the wide desktop breakpoint');
          assert.equal(await page.locator('.terminal-table th').count(), 7, 'Task4 replaces legacy columns with approved default columns');
          assert.equal(await page.locator('.admin-expiry-column').first().isVisible(), width >= 1280);
          assert.equal(await page.locator('.server-name-link').first().evaluate(e => { const r = e.getBoundingClientRect(); return r.height >= 44 && r.width >= 40 && e.scrollWidth <= e.clientWidth + 1; }), true, 'coarse node name retains an effective target and readable wrapping');
        });
        report.geometry.push({ width, theme, systemScheme: theme === 'dark' ? 'dark' : 'light', header: await page.locator('.admin-header-inner').boundingBox(), workspace: await page.locator('.admin-main').boundingBox(), nav: await page.locator('.admin-nav').boundingBox(), colors: before });
        await page.screenshot({ path: `${out}/admin-${width}-${theme}.png` });
      }
    }
    await check('auto follows both system schemes without changing admin appearance settings', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(fixture('admin', '&locale=ja'));
      await page.locator('[data-page=themeStore]').click();
      await page.locator('.admin-theme-select').selectOption('auto');
      await page.locator('[data-page=servers]').click();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => !document.body.classList.contains('light'));
      assert.equal(await page.locator('.admin-header').evaluate(e => getComputedStyle(e).backgroundColor), report.geometry.find(g => g.width === 390 && g.theme === 'dark').colors.color);
      await page.screenshot({ path: `${out}/admin-390-auto-system-dark-ja.png` });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => document.body.classList.contains('light'));
      assert.equal(await page.locator('.admin-header').evaluate(e => getComputedStyle(e).backgroundColor), report.geometry.find(g => g.width === 390 && g.theme === 'light').colors.color);
    });
    await check('Mikus and public custom background return on route unmount', async () => {
      await page.evaluate(async () => {
        const { applyMikusThemeOptions } = await import('/src/frontend/utils/themeOptions.js');
        applyMikusThemeOptions({ mikus: true });
        document.body.style.backgroundImage = 'linear-gradient(red, blue)';
        location.hash = '#/public';
      });
      await page.locator('#public-control').waitFor();
      assert.equal(await page.evaluate(() => document.body.classList.contains('admin-ui-surface')), false);
      assert.equal(await page.evaluate(() => document.body.style.backgroundImage), 'linear-gradient(red, blue)');
      assert.notEqual(await page.locator('.mikus-global-sakura').evaluate(e => getComputedStyle(e).display), 'none');
      await page.screenshot({ path: `${out}/public-mikus-restored-390.png` });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const size of ['default', 'add', 'edit']) {
      await page.goto(fixture('', `&size=${size}`));
      await page.locator('#open-dialog').click();
      await check(`dialog ${size} frozen max width and padding`, async () => {
        assert.equal(Math.round((await page.getByRole('dialog').boundingBox()).width), { default: 512, add: 448, edit: 672 }[size]);
        assert.equal(await page.getByRole('dialog').evaluate(e => getComputedStyle(e).padding), '24px');
      });
      await page.screenshot({ path: `${out}/dialog-${size}-1440.png` });
    }
    report.reference = [];
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
      await page.goto(`${origin}/docs/superpowers/references/admin-ui-approved/preview.html`);
      await page.addStyleTag({ content: 'body { margin:0; color-scheme:light; }' });
      await page.locator('.rep-nav').waitFor();
      const geometry = { width, header: await page.locator('.rep-header-inner').boundingBox(), workspace: await page.locator('.rep-main').boundingBox(), nav: await page.locator('.rep-nav').boundingBox() };
      geometry.charset = await page.evaluate(() => document.characterSet);
      geometry.navText = await page.locator('.rep-nav').innerText();
      report.reference.push(geometry);
      await page.locator('.rep-product').screenshot({ path: `${out}/reference-${width}.png` });
      await check(`frozen reference shell geometry ${width}`, async () => {
        assert.equal(geometry.charset, 'UTF-8');
        assert.match(geometry.navText, /节点/);
        assert.match(geometry.navText, /通知/);
        const actual = report.geometry.find(g => g.width === width && g.theme === 'light');
        assert.ok(Math.abs(actual.workspace.width - geometry.workspace.width) <= 2, 'preview frame border accounts for at most 2px');
        assert.equal(actual.nav.width, width >= 768 ? 176 : width - 32);
        if (width >= 768) assert.equal(actual.nav.width, geometry.nav.width);
      });
    }
  }
  report.actions = actions;
  await context.close();
} catch (error) { report.errors.push(error.stack); }
finally {
  await browser?.close(); await server?.close();
  report.pass = report.results.length > 0 && report.results.every(r => r.pass) && report.errors.length === 0;
  fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
