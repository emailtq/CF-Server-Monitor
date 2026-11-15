import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness } from '../../terminal-harness.js';
import { saveSiteOptions } from '../../../src/utils/settings.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const out = path.resolve(process.env.NAMED_PAGES_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `round4-named-pages-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
const baseline = process.argv.includes('--baseline');
const themesOnly = process.argv.includes('--themes-only');
const report = { baseline, realD1: true, physicalAndroid: false, checks: [], bounds: [], screenshots: [], errors: [], requests: [] };
let a, b, server, browser, context, page;
const holds = [], pending = new Set();
const hold = (site, action, status) => {
  const item = { site, action, status, arrived: false };
  item.promise = new Promise(resolve => { item.release = resolve; }); holds.push(item); return item;
};
const waitHold = async item => { for (let i = 0; i < 500; i++) { if (item.arrived) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Missing held request ${item.site}/${item.action}`); };
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const shot = async (name, viewportOnly = false) => {
  const file = path.join(out, `${name}.png`), coarse = await page.evaluate(() => matchMedia('(pointer:coarse)').matches);
  // Playwright fullPage metrics override disables Chromium touch emulation; use the actual mobile screen.
  await page.screenshot({ path: file, fullPage: !coarse && !viewportOnly }); report.screenshots.push(file);
  assert.equal(await page.evaluate(() => matchMedia('(pointer:coarse)').matches), coarse, 'capture preserves actual pointer mode');
};
const enter = async name => { await page.locator(`[data-page=${name}]`).click(); await frames(); };
const fields = { turnstile_secret_key: 'turnstileSecret', jwt_secret: 'jwtSecret', ua: 'ua', password: 'password', confirm_password: 'confirmPassword', cloudflare_token: 'cloudflareToken' };

async function measure(pageName, caseName) {
  const bounds = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.settings-section .btn,.settings-save-bar .btn')].filter(el => el.checkVisibility());
    return buttons.map(el => {
      const box = el.getBoundingClientRect(), css = getComputedStyle(el), rects = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (walker.currentNode.textContent.trim()) {
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        rects.push(...[...range.getClientRects()].map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })));
      }
      const svg = el.querySelector('svg')?.getBoundingClientRect();
      const padding = [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(parseFloat);
      const wrapsThemeRow = !!el.closest('.theme-actions') && [...el.parentElement.children].some(button => { const range = document.createRange(); range.selectNodeContents(button); return range.getClientRects().length > 1; });
      return { text: el.textContent.trim(), class: el.className, box: { x: box.x, y: box.y, width: box.width, height: box.height }, padding, fontSize: css.fontSize,
        wrapsThemeRow,
        textFits: rects.every(r => r.x >= box.x + 1 && r.right <= box.right - 1 && r.y >= box.y + 1 && r.bottom <= box.bottom - 1),
        paddingFits: rects.every(r => r.y >= box.y + padding[0] - 1 && r.bottom <= box.bottom - padding[2] + 1 && r.x >= box.x + padding[3] - 1 && r.right <= box.right - padding[1] + 1),
        iconGap: svg && rects.length ? Math.min(...rects.map(r => r.x)) - svg.right : null,
        withinViewport: box.x >= 0 && box.right <= innerWidth,
        innerRects: rects };
    });
  });
  report.bounds.push({ caseName, pageName, buttons: bounds, pointer: await page.evaluate(() => ({ coarse: matchMedia('(pointer:coarse)').matches, touch: navigator.maxTouchPoints })) });
  if (!baseline) {
    assert.ok(bounds.every(b => b.textFits && b.withinViewport), `${caseName}/${pageName}: ${JSON.stringify(bounds.filter(b => !b.textFits || !b.withinViewport))}`);
    assert.ok(bounds.every(b => b.paddingFits), `${caseName}/${pageName}: text keeps control padding: ${JSON.stringify(bounds.filter(b => !b.paddingFits))}`);
    assert.ok(bounds.every(b => b.iconGap === null || b.iconGap >= 7.5), 'icon/text gap');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page has no horizontal overflow');
    const coarse = await page.evaluate(() => matchMedia('(pointer:coarse)').matches);
    assert.ok(bounds.filter(b => b.innerRects.length === 1 && !b.wrapsThemeRow).every(b => b.box.height === (coarse ? 44 : 36)), 'unaffected single-line controls retain accepted 36/44px height');
  }
}

async function eyes(caseName, touch) {
  for (const [field, key] of Object.entries(fields)) {
    await enter(field === 'cloudflare_token' ? 'settings' : 'security');
    const input = page.locator(`[data-setting-field=${field}]`);
    const eye = input.locator('..').locator('.admin-secret-eye');
    assert.equal(await eye.count(), 1, `${field} is an inset eye`);
    assert.equal(await eye.evaluate(el => el.getBoundingClientRect().height), touch ? 44 : 36);
    assert.equal(await input.evaluate(el => el.getBoundingClientRect().height), touch ? 44 : 36);
    await input.fill('abcdefghi'); await input.focus();
    await input.evaluate(el => { window.eyeInput = el; el.setSelectionRange(2, 5); });
    const paint = () => eye.evaluate(el => { const css = getComputedStyle(el); return { background: css.backgroundColor, border: css.borderWidth, outline: css.outlineStyle, shadow: css.boxShadow, color: css.color }; });
    await eye.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await input.evaluate(el => el.focus({ preventScroll: true }));
    const base = await paint();
    if (touch) await eye.tap();
    else {
      const box = await eye.boundingBox();
      assert.equal(await eye.evaluate(el => { const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }), true, 'mouse click is on the actual eye, not sticky save bar');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      assert.deepEqual(await paint(), base, 'pointer down changes no button paint'); await page.mouse.up();
    }
    await frames();
    assert.deepEqual(await input.evaluate(el => ({ same: window.eyeInput === el, focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd })), { same: true, focused: true, start: 2, end: 5 });
    assert.equal(await eye.getAttribute('aria-pressed'), 'true');
    assert.equal(await eye.locator('svg').count(), 1); assert.equal(await eye.textContent(), '');
    assert.deepEqual(await paint(), base, 'click only changes glyph');
    await page.keyboard.insertText('Z'); assert.equal(await input.inputValue(), 'abZfghi');
    await input.evaluate(el => el.setSelectionRange(1, 3));
    if (touch) await eye.tap(); else await eye.click();
    await frames(); assert.equal(await eye.getAttribute('aria-pressed'), 'false');
    assert.equal(await input.evaluate(el => el.type === 'password' || getComputedStyle(el).webkitTextSecurity === 'disc'), true, 'hidden input is actually masked');
    assert.deepEqual(await input.evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 1, 3]);
    await page.keyboard.insertText('Q'); assert.equal(await input.inputValue(), 'aQfghi');
    await page.keyboard.press('Tab'); assert.equal(await eye.evaluate(el => document.activeElement === el), true);
    assert.notEqual((await paint()).color, base.color, 'keyboard focus has the accepted color cue');
    await page.keyboard.press('Space'); assert.equal(await eye.getAttribute('aria-pressed'), 'true');
    assert.equal(await eye.evaluate(el => document.activeElement === el), true, 'keyboard activation stays on control');
    await page.keyboard.press('Space'); await input.fill(field === 'ua' ? 'cfsm' : '');
    if (['360-light-fr', '390-dark-es'].includes(caseName) && ['confirm_password', 'cloudflare_token'].includes(field)) await shot(`${caseName}-${field}-eye`);
    report.checks.push(`${caseName}: ${key} inset, glyph-only click/tap, focus/selection/type and keyboard cue`);
  }
}

try {
  const upstream = async request => {
    const url = new URL(request.url);
    if (url.pathname.includes('/releases/latest')) return Response.json({ tag_name: 'v9.8.7' });
    if (url.pathname.endsWith('/version.json')) return Response.json({ workers: '2.8.7 Beta6', agent: '1.1.1' });
    if (url.pathname.endsWith('/themes.json')) return Response.json({ schema: 1, themes: [{ id: 'fixture', title: 'Fixture theme', cover: '/favicon.png', author: 'Fixture', description: { en: 'Local controlled theme metadata', fr: 'Thème local pour vérifier les actions', es: 'Tema local de verificación' }, url: 'https://github.com/example/theme', versions: [{ title: 'Fixture version', theme_url: 'https://github.com/example/theme/tree/main' }] }] });
    if (url.href === 'https://raw.githubusercontent.com/example/theme/main/index.html') return new Response('<!doctype html><title>Local fixture theme</title>', { headers: { 'Content-Type': 'text/html' } });
    return new Response('', { status: 404 });
  };
  a = await harness({ outboundService: upstream }); b = await harness({ outboundService: upstream });
  for (const [h, title] of [[a, 'Site A'], [b, 'Site B']]) {
    await saveSiteOptions(h.db, { is_public: 'true', site_title: title, username: 'fixture', theme_url: '', last_agent_version: 'v9.8.7' });
    assert.equal((await h.action('save_settings', { settings: { username: 'fixture', password: 'fixture-password' } })).status, 200);
  }
  server = await createServer({ plugins: [vue()], publicDir: path.resolve('public'), vueFixtureDevtools: true, frontendExports: true, fixtureEntries: [path.resolve('test/fixtures/admin-ui/named-pages.html')], cacheDir: path.join(out, '.cache'), apiMiddlewarePlugin: { name: 'named-pages-authenticated-worker-d1', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      const url = new URL(request.url, 'http://fixture.invalid'), match = url.pathname.match(/^\/site-(a|b)(\/.*)$/);
      if (!match) return next();
      const job = (async () => {
        const h = match[1] === 'a' ? a : b;
        let body = ''; for await (const chunk of request) body += chunk;
        const action = (body && JSON.parse(body).action) || match[2];
        const item = holds.find(item => item.site === match[1] && item.action === action && !item.arrived);
        const headers = { ...request.headers, Cookie: `cfsm_auth=${h.token}`, Authorization: `Bearer ${h.token}`, Origin: 'https://example.com' }; delete headers.host;
        const result = item?.status ? Response.json({ error: 'injected_failure' }, { status: item.status }) : await h.fetch(match[2] + url.search, { method: request.method, headers, ...(body ? { body } : {}) });
        const payload = Buffer.from(await result.arrayBuffer()); report.requests.push({ site: match[1], action, status: item?.status || result.status });
        if (action === 'start_theme_preview' && result.ok) report.previewUrl = JSON.parse(payload.toString()).preview_url;
        if (item) { item.arrived = true; await item.promise; }
        response.writeHead(item?.status || result.status, { 'Content-Type': result.headers.get('Content-Type') || 'application/json' });
        response.end(item?.status ? JSON.stringify({ error: 'injected_failure' }) : payload);
      })().catch(error => { report.errors.push(error.stack); response.writeHead(500); response.end(); });
      pending.add(job); job.finally(() => pending.delete(job));
    });
  } } });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ADMIN_UI_CHROMIUM || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe') });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const cases = baseline ? [[360, false, 'fr'], [390, true, 'es'], [1440, false, 'fr'], [1920, true, 'fr']] : [[360, false, 'fr'], [360, true, 'fr'], [390, false, 'es'], [390, true, 'es'], [1440, false, 'zh'], [1440, true, 'zh'], [1920, false, 'fr'], [1920, true, 'fr'], [390, false, 'ja'], [390, true, 'zh-TW'], [1920, false, 'en'], [1920, true, 'id']];
  for (const [width, dark, locale] of process.argv.includes('--actions-only') ? [] : cases) {
    const name = `${width}-${dark ? 'dark' : 'light'}-${locale}`, touch = width < 640;
    context = await browser.newContext({ viewport: { width, height: touch ? 844 : 1000 }, hasTouch: touch, isMobile: touch });
    page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.stack));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/test/fixtures/admin-ui/named-pages.html?locale=${locale}#/admin`);
    await page.waitForFunction(() => window.adminState?.().servers.length === 2 && window.adminState().settings.username === 'fixture');
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
    assert.equal(await page.evaluate(() => matchMedia('(pointer:coarse)').matches), touch, 'real touch/fine media, not only width');
    for (const pageName of themesOnly ? ['themeStore'] : ['database', 'themeStore', 'security', 'settings', 'updates']) {
      await enter(pageName);
      if (pageName === 'themeStore') { await page.locator('.theme-card').first().waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.theme-cover')].every(image => image.complete && image.naturalWidth > 0)); }
      if (pageName === 'security') await page.evaluate(() => window.adminState().changeAdminPassword = true);
      await frames(); await measure(pageName, name);
      if (locale === 'fr' || locale === 'es' || width === 1440 && !dark || pageName === 'security' && width === 390) { await page.evaluate(() => scrollTo(0, 0)); await shot(`${name}-${pageName}`); }
      if (['fr', 'es'].includes(locale) && ['themeStore', 'database'].includes(pageName)) {
        const target = pageName === 'themeStore' ? page.locator('.theme-card').last() : page.locator('#tab-database .settings-section .btn').last();
        await target.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await shot(`${name}-${pageName}-actions`, true);
      }
      if (pageName === 'updates') {
        const spacing = await page.locator('section.settings-section:visible').evaluate(el => {
          const a = el.querySelector('a.btn').getBoundingClientRect(), b = el.querySelector('button.btn').getBoundingClientRect(); return b.x - a.right;
        });
        report.checks.push({ name, pageName, actionGap: spacing });
        if (!baseline) { assert.ok(spacing >= 7.5); assert.equal(await page.locator('section.settings-section:visible a.btn').getAttribute('href'), 'https://github.com/emailtq/CF-Server-Monitor/tree/terminal'); }
      }
    }
    if (!baseline && !themesOnly) {
      await eyes(name, touch);
      assert.equal(await page.locator('[data-setting-field=jwt_secret]').inputValue(), '', 'existing JWT never refilled');
      assert.equal(await page.locator('[data-setting-field=password]').inputValue(), '', 'configured password never refilled');
      report.checks.push(`${name}: five pages real text bounds and six secrets`);
    }
    await context.close(); context = null;
  }
  if (!baseline && !themesOnly) {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.stack));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/test/fixtures/admin-ui/named-pages.html?locale=fr#/admin`);
    await page.waitForFunction(() => window.adminState?.().settings.username === 'fixture');
    const t = await page.evaluate(() => window.adminState().trans);
    await enter('security');
    const save = () => page.locator('.settings-save-bar:visible .btn').click();
    const closeMessage = async () => { const dialog = page.getByRole('dialog'); await dialog.waitFor(); await dialog.locator('.admin-dialog-close').click(); await dialog.waitFor({ state: 'hidden' }); };
    const field = key => page.locator(`[data-setting-field=${key}]`);
    const savesBefore = report.requests.filter(r => r.action === 'save_settings').length;
    await field('jwt_secret').fill('too-short'); await save(); await page.waitForFunction(() => window.adminState().validationField === 'jwt_secret');
    await field('jwt_secret').fill(''); await field('ua').fill('invalid\"agent'); await save(); await page.waitForFunction(() => window.adminState().validationField === 'ua');
    await field('ua').fill('cfsm');
    await page.locator('.inline-help-action .btn').click();
    await field('password').fill('new-fixture-password'); await field('confirm_password').fill('mismatch'); await save();
    await page.waitForFunction(() => window.adminState().validationField === 'confirm_password');
    assert.equal(report.requests.filter(r => r.action === 'save_settings').length, savesBefore, 'invalid secrets never sent');
    await page.locator('.inline-help-action .btn').click();
    assert.equal(await field('password').count(), 0, 'cancel revokes password-change consent');
    assert.equal(await page.evaluate(() => window.adminState().settings.password), '');
    await page.locator('.inline-help-action .btn').click();
    await field('password').fill('new-fixture-password'); await field('confirm_password').fill('new-fixture-password');
    const failedSave = hold('a', 'save_settings', 503); await save(); await waitHold(failedSave);
    assert.equal(await field('password').isDisabled(), true); await measure('security-saving', '390-light-fr');
    failedSave.release(); await page.waitForFunction(() => window.adminState().saveResult?.success === false && !window.adminState().saving);
    assert.equal(await field('password').inputValue(), 'new-fixture-password', 'save failure retains draft');
    await closeMessage();
    await save(); await page.waitForFunction(() => window.adminState().saveResult?.success === true && !window.adminState().changeAdminPassword);
    assert.equal(await page.evaluate(() => window.adminState().settings.password), '');
    assert.equal(await page.evaluate(() => window.adminState().settings.jwt_secret), '');
    assert.equal((await (await a.action('get_settings')).json()).settings.password_configured, true);
    await closeMessage();
    await enter('settings'); await field('site_title').fill('Named pages accepted'); await save();
    await page.waitForFunction(() => window.adminState().saveResult?.success === true && !window.adminState().saving);
    assert.equal((await (await a.action('get_settings')).json()).settings.site_title, 'Named pages accepted');
    await closeMessage();
    await page.getByRole('button', { name: t.queryD1Quota, exact: true }).click();
    await page.waitForFunction(() => !!window.adminState().alertMessage && !window.adminState().d1UsageLoading); await closeMessage();
    report.checks.push('real security validation, password consent/cancel, disabled busy form, failed-save draft recovery and successful authenticated D1 save');

    await enter('database');
    const exportButton = page.getByRole('button', { name: t.exportServers, exact: true });
    const download = async click => { const waiting = page.waitForEvent('download'); await click(); const file = await waiting; const target = path.join(out, file.suggestedFilename()); await file.saveAs(target); return JSON.parse(fs.readFileSync(target, 'utf8')); };
    const backup = await download(() => exportButton.click());
    assert.equal(backup.format, 'cfsm-backup'); assert.equal(backup.version, 1); assert.equal(backup.servers.length, 2);
    const exportFailure = hold('a', 'export_servers', 503); await exportButton.click(); await waitHold(exportFailure); exportFailure.release();
    await page.getByText(t.serversExportFailed, { exact: true }).waitFor(); await download(() => exportButton.click());
    await page.locator('#include-notification-secrets').check(); await exportButton.click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    await download(() => dialog.getByRole('button', { name: t.adminConfirmSensitiveExport, exact: true }).click()); await dialog.waitFor({ state: 'hidden' });
    const upload = page.locator('#tab-database input[type=file]');
    await upload.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
    await page.getByText(t.adminImportFailed, { exact: true }).waitFor();
    const importedId = '00000000-0000-4000-8000-000000000011';
    await upload.setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ servers: [{ id: importedId, name: 'Imported fixture' }] })) });
    await page.getByRole('button', { name: t.adminAcknowledgeReload, exact: true }).waitFor();
    assert.equal((await a.db.prepare('SELECT name FROM servers WHERE id=?').bind(importedId).first()).name, 'Imported fixture');
    await measure('database-import-result', '390-light-fr');
    await page.getByRole('button', { name: t.adminAcknowledgeReload, exact: true }).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await shot('390-light-fr-import-result');
    // Reload is an explicit acknowledgement, never automatic on receiving the import response.
    await page.getByRole('button', { name: t.adminAcknowledgeReload, exact: true }).click();
    await page.waitForFunction(() => window.adminState?.().servers.length === 3);
    await enter('database');
    for (const [label, confirm, endpoint] of [[t.upgradeDatabase, t.upgradeDatabase, '/updateDatabase'], [t.clearHistory, t.confirmClear, '/clearHistory']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const modal = page.getByRole('dialog'); await modal.waitFor();
      const failed = hold('a', endpoint, 503); await modal.getByRole('button', { name: confirm, exact: true }).click(); await waitHold(failed); failed.release();
      await page.waitForFunction(() => window.adminState().dbResult?.success === false);
      await modal.getByRole('button', { name: t.cancel, exact: true }).click(); await modal.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: label, exact: true }).click(); await modal.getByRole('button', { name: confirm, exact: true }).click();
      await page.waitForFunction(() => window.adminState().dbResult?.success === true);
      await modal.locator('.admin-dialog-close').click(); await modal.waitFor({ state: 'hidden' });
    }
    report.checks.push('real downloaded backup, export retry, sensitive-export consent, invalid JSON recovery, D1 import/report acknowledgement, database upgrade and clear failure/reopen/success');

    await enter('themeStore'); await page.locator('.theme-card').first().waitFor();
    const custom = page.locator('.theme-custom-form .form-input');
    await custom.fill('javascript:invalid'); await page.locator('.theme-custom-form .btn-primary').click();
    await page.waitForFunction(() => !!window.adminState().alertMessage);
    await closeMessage();
    await custom.fill('https://github.com/example/theme/tree/main');
    const popupWaiting = page.waitForEvent('popup'); await page.locator('.theme-custom-form .btn').first().click();
    const popup = await popupWaiting; assert.ok(report.previewUrl.startsWith('https://example.com/?theme_url=')); await popup.close();
    await page.locator('.theme-custom-form .btn-primary').click(); await page.waitForFunction(() => window.adminState().settings.theme_url.includes('/example/theme/tree/main'));
    assert.equal((await (await a.action('get_settings')).json()).settings.theme_url, 'https://github.com/example/theme/tree/main');
    await closeMessage();
    await page.locator('.theme-custom-form .btn').last().click(); await page.waitForFunction(() => !window.adminState().settings.theme_url);
    await closeMessage();
    const mikus = page.locator('.theme-card').first();
    await mikus.getByRole('button', { name: t.enable, exact: true }).click();
    await page.waitForFunction(() => JSON.parse(window.adminState().settings.theme_options).mikus === 1);
    await closeMessage();
    await mikus.getByRole('button', { name: t.close, exact: true }).click();
    await page.waitForFunction(() => !JSON.parse(window.adminState().settings.theme_options).mikus);
    await closeMessage();
    report.checks.push('real theme URL validation, preview action, D1 apply/reset, built-in theme enable/disable; view links remain navigation');

    await enter('updates');
    assert.deepEqual(await page.evaluate(() => window.namedVersions()), { worker: '2.8.7 Beta6', latestWorker: '2.8.7 Beta6', agent: 'v9.8.7' });
    const oldConfig = hold('a', '/api/config', 403);
    await page.evaluate(() => { const state = window.adminState(); window.oldNamedRequest = window.namedConfig(0, state.requestOwner); }); await waitHold(oldConfig);
    await page.evaluate(() => { const state = window.adminState(); state.selectedApiIndex = 1; void state.switchAdminSite(); });
    await page.waitForFunction(() => !window.adminState().adminSiteLoading && window.adminState().selectedApiIndex === 1);
    const currentVersions = await page.evaluate(() => window.namedVersions()); oldConfig.release();
    assert.equal(await page.evaluate(async () => (await window.oldNamedRequest).stale), true);
    assert.deepEqual(await page.evaluate(() => window.namedVersions()), currentVersions); assert.ok(await page.locator('.admin-ui').count());
    assert.equal(await page.evaluate(() => window.adminState().servers.length), 2, 'site B does not adopt site A imported rows');
    await shot('390-light-fr-updates-site-b');
    report.checks.push('actual version strings from authenticated config, latest Agent not stale version.json agent, stale config/403 discarded after site switch');
  }
} catch (error) { report.errors.push(error.stack); }
finally {
  for (const item of holds) item.release();
  await Promise.allSettled([...pending]);
  await browser?.close(); await server?.close(); await a?.dispose(); await b?.dispose(); report.closed = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
