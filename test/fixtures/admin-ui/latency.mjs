import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { PING_NODE_FIELDS, validatePingNode } from '../../../src/frontend/utils/pingNode.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { PNG } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pngjs');
const executablePath = process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe';
const evidenceRoot = path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/latency');
fs.mkdirSync(evidenceRoot, { recursive: true });
const out = process.env.ADMIN_UI_LATENCY_REPORT_DIR ? path.resolve(process.env.ADMIN_UI_LATENCY_REPORT_DIR) : fs.mkdtempSync(path.join(evidenceRoot, 'registered-'));
fs.mkdirSync(out, { recursive: true });
const red = process.argv.includes('--red');
const baseline = process.argv.includes('--baseline') ? execFileSync('git', ['show', '33ba2e3d9a1a7f5afe346331fd37f1fc8fcd6125:src/frontend/views/admin/components/CollectionSettings.vue'], { encoding: 'utf8', windowsHide: true }) : null;
const report = { node: process.version, pid: process.pid, red, baseline: baseline ? '33ba2e3d9a1a7f5afe346331fd37f1fc8fcd6125:CollectionSettings.vue via pre-Vue transform, no working-tree rewrite' : null, checks: [], layouts: [], actions: [], errors: [], denied: [] };
const targets = ['gd-ct-dualstack.ip.zstaticcdn.com:443', 'gd-cu-dualstack.ip.zstaticcdn.com', 'gd-cm-dualstack.ip.zstaticcdn.com', 'ip.zstaticcdn.com', '[2001:DB8:1234:5678:90ab:cdef:1234:5678]:65535', '2001:DB8::2', 'long-dualstack-monitoring-probe.example.test:443', '192.0.2.4:080'];
const seed = () => ({ site_title: 'CF Monitor', username: 'fixture', password_configured: true, auto_discovery: true, wss_report_enabled: true, wss_report_hours: [0, 8, 16], frontend_ws_timeout_minutes: '15', long_history_points: '288', ...Object.fromEntries(PING_NODE_FIELDS.flatMap((field, index) => [[field, targets[index]], [`${field}_name`, `Probe ${index + 1}`]])) });
let server, browser, currentPage;
const pageCdp = new WeakMap();
const check = async (name, fn) => {
  try { await fn(); report.checks.push({ name, pass: true }); }
  catch (error) {
    report.checks.push({ name, pass: false, error: error.stack });
    await currentPage?.screenshot({ path: path.join(out, `failure-${report.checks.length}.png`) }).catch(() => {});
  }
};
const screenshot = async (page, label) => {
  // Native viewport tiles preserve coarse-pointer CSS; captureBeyondViewport resets touch in this Chromium.
  const cdp = pageCdp.get(page);
  const { width, height } = page.viewportSize(), savedY = await page.evaluate(() => scrollY);
  const fullPage = height > 300;
  const contentHeight = fullPage ? await page.evaluate(() => document.documentElement.scrollHeight) : height;
  const image = new PNG({ width, height: contentHeight });
  const step = height - 90;
  for (let y = 0; y < contentHeight; y += step) {
    const desiredY = fullPage ? y : savedY;
    await page.evaluate(y => scrollTo(0, y), desiredY);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const actualY = await page.evaluate(() => scrollY);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const tile = PNG.sync.read(Buffer.from(data, 'base64'));
    const copyHeight = Math.min(fullPage ? step : height, contentHeight - y);
    PNG.bitblt(tile, image, 0, desiredY - actualY, width, copyHeight, 0, y);
    if (!fullPage) break;
  }
  fs.writeFileSync(path.join(out, `${label}.png`), PNG.sync.write(image));
  await page.evaluate(y => scrollTo(0, y), savedY);
  const after = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, hours: document.querySelector('.wss-hour-option')?.getBoundingClientRect().height }));
  (report.screenshotState ||= []).push({ label, method: fullPage ? 'scroll-stitched native viewport tiles, sticky save bar only at natural footer' : 'native short viewport', viewport: { width, height }, ...after });
  assert.equal(after.coarse, width < 640, 'capture must retain the verified pointer mode');
};
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
try {
  const plugins = baseline ? [{ name: 'read-only-collection-baseline', enforce: 'pre', transform(_code, id) { if (id.replaceAll('\\', '/').endsWith('/CollectionSettings.vue')) return baseline; } }, vue()] : [vue()];
  server = await createServer({ cacheDir: path.join(out, '.cache'), plugins, publicDir: path.resolve('public'), frontendExports: true });
  report.port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${report.port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = async (width, height, locale, scheme, timezoneId, coarse = width < 640) => {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: coarse, colorScheme: scheme, timezoneId, reducedMotion: 'reduce' });
    let saved = seed(), releaseSave;
    await ctx.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); }
      if (url.pathname.endsWith('/admin/api')) {
        const data = route.request().postDataJSON();
        report.actions.push({ locale, scheme, timezoneId, ...data });
        if (data.action === 'save_settings') {
          saved = { ...saved, ...data.settings };
          await new Promise(resolve => { releaseSave = resolve; });
        }
        return route.fulfill({ json: { success: true, settings: saved, servers: [{ id: 'fixture-node', name: 'Synthetic node', region: 'HK', os: 'Ubuntu 24.04', server_group: 'Synthetic', net_rx_monthly: 0, net_tx_monthly: 0 }], stats: { total: 1 } } });
      }
      if (url.pathname.endsWith('/api/config')) return route.fulfill({ json: { version: 'fixture-only', last_agent_version: '2.8.6' } });
      if (url.pathname.endsWith('/theme')) return route.fulfill({ json: { themes: [] } });
      return route.continue();
    });
    const page = await ctx.newPage(); currentPage = page;
    const cdp = await ctx.newCDPSession(page); pageCdp.set(page, cdp);
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.stack));
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=${locale}#/admin`, { waitUntil: 'domcontentloaded' });
    await page.locator('.server-row').waitFor();
    await page.locator('[data-page=collection]').click();
    await page.locator('.wss-hour-option').first().waitFor();
    return { ctx, page, release: () => releaseSave?.() };
  };
  const layout = async (page, label) => {
    const data = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const root = document.querySelector('.wss-schedule').closest('.settings-grid');
      return {
        viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, coarse: matchMedia('(pointer: coarse)').matches,
        pairs: [...root.querySelectorAll('.ping-node-fields')].map(el => ({ parent: rect(el), inputs: [...el.querySelectorAll('input')].map(rect) })),
        clipped: [...root.querySelectorAll('.admin-field-hint, .wss-schedule-meta, .wss-schedule-actions .btn, .wss-schedule-title')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className),
        hours: [...root.querySelectorAll('.wss-hour-option')].map(rect),
        toggles: [...root.querySelectorAll('.checkbox-item input')].map(rect),
        actions: [...root.querySelectorAll('.wss-schedule-actions .btn')].map(rect),
        inlineHelp: [...root.querySelectorAll('.admin-field-hint')].map(el => ({ text: el.textContent, ...rect(el) }))
      };
    });
    report.layouts.push({ label, ...data });
    await screenshot(page, label);
    await check(`${label}: complete-page geometry`, async () => {
      assert.ok(data.scrollWidth <= data.viewport.width, 'no horizontal page scrolling');
      assert.deepEqual(data.clipped, [], 'help/meta/actions must not clip');
      assert.equal(data.pairs.length, 8);
      for (const pair of data.pairs) {
        if (data.viewport.width < 640) {
          assert.ok(pair.inputs[1].y >= pair.inputs[0].bottom, 'mobile name and host need separate rows');
          for (const input of pair.inputs) assert.ok(input.width >= pair.parent.width - 1, 'both mobile fields use available width');
        } else assert.ok(Math.abs(pair.inputs[0].y - pair.inputs[1].y) <= 1, 'desktop fields keep natural columns');
        for (const input of pair.inputs) assert.ok(input.x >= pair.parent.x && input.right <= pair.parent.right + 1);
      }
      assert.ok(data.toggles.every(r => r.width >= 32 && r.height >= 18), 'switch must not be squeezed by help');
      assert.ok(data.inlineHelp.every(r => r.width >= 150 && r.text.trim()), 'help must have readable line length');
      if (data.viewport.width < 640) {
        assert.ok(data.hours.every(r => r.width >= 44 && r.height >= 44));
        assert.ok(data.actions.every(r => r.width >= 44 && r.height >= 44));
      }
    });
  };
  for (const locale of ['zh', 'en', 'ja']) for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await context(1440, 900, locale, scheme, 'Asia/Shanghai', false);
    try {
      await layout(page, `${locale}-${scheme}-1440`);
      await ctx.close();
      for (const width of [320, 360, 390]) {
        const mobile = await context(width, 800, locale, scheme, 'Asia/Shanghai');
        try {
          await layout(mobile.page, `${locale}-${scheme}-${width}`);
          if (width === 320) {
            await mobile.page.setViewportSize({ width, height: 300 });
            await pageCdp.get(mobile.page).send('Emulation.setTouchEmulationEnabled', { enabled: true });
            await layout(mobile.page, `${locale}-${scheme}-${width}-short`);
          }
        } finally { mobile.release(); await mobile.ctx.close(); }
      }
    } finally { await ctx.close(); }
  }
  if (!red) for (const timezoneId of ['Asia/Shanghai', 'UTC', 'Asia/Kathmandu']) {
    const { ctx, page, release } = await context(320, 300, 'en', 'light', timezoneId);
    const field = key => page.locator(`[data-setting-field=${key}]`);
    const save = page.locator('.settings-save-bar button');
    const saveRequests = () => report.actions.filter(action => action.action === 'save_settings' && action.timezoneId === timezoneId);
    try {
      await check(`${timezoneId}: keyboard hours / all / clear / disabled schedule`, async () => {
        const clear = page.locator('.wss-schedule-actions button').last();
        const all = page.locator('.wss-schedule-actions button').first();
        await clear.click(); assert.equal(await page.locator('.wss-hour-option input:checked').count(), 0);
        const hour = page.locator('.wss-hour-option input').first();
        await hour.focus(); await page.keyboard.press('Space'); assert.equal(await hour.isChecked(), true);
        await all.click(); assert.equal(await page.locator('.wss-hour-option input:checked').count(), 24);
        await field('wss_report_enabled').uncheck(); assert.equal(await page.locator('.wss-schedule:visible').count(), 0);
        await field('wss_report_enabled').check(); assert.equal(await page.locator('.wss-hour-option input:checked').count(), 24);
        await clear.click();
        for (let hour = 0; hour < 24; hour++) await page.locator('.wss-hour-option').nth(hour).tap();
        assert.equal(await page.locator('.wss-hour-option input:checked').count(), 24, 'every individual local hour is touch-selectable');
        await clear.click(); await page.locator('.wss-hour-option').first().tap();
        assert.equal(await page.locator('.wss-hour-option input:checked').count(), 1);
        const firstHour = await page.locator('.wss-hour-option').first().getAttribute('title');
        const expectedHour = timezoneId === 'UTC' ? 0 : timezoneId === 'Asia/Shanghai' ? 16 : 18;
        assert.ok(firstHour.includes(`${String(expectedHour).padStart(2, '0')}:00`), firstHour);
        const resolvedTimezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
        assert.ok((await page.locator('.wss-schedule-meta').innerText()).includes(resolvedTimezone));
      });
      await check(`${timezoneId}: 8 editable pairs / validation focus / full DTO / save ownership`, async () => {
        await field('auto_discovery').uncheck();
        for (const [index, key] of PING_NODE_FIELDS.entries()) {
          const host = field(key), name = host.locator('..').locator('.ping-node-name');
          await name.tap(); await name.fill(`  Edited probe ${index + 1}  `);
          await host.tap(); await host.fill(`  ${targets[index]}  `);
          await host.focus(); await page.keyboard.press('End');
          await page.waitForTimeout(100);
          const focus = await host.evaluate(el => {
            const r = el.getBoundingClientRect();
            const ancestors = []; for (let p = el.parentElement; p; p = p.parentElement) if (/(hidden|clip)/.test(getComputedStyle(p).overflowX + getComputedStyle(p).overflowY)) { const pr = p.getBoundingClientRect(); ancestors.push(r.left - 4 >= pr.left && r.right + 4 <= pr.right); }
            return { active: document.activeElement === el, visible: r.y >= 0 && r.bottom <= innerHeight, clippedRing: ancestors.some(ok => !ok), hit: el === document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2), rect: { y: r.y, bottom: r.bottom } };
          });
          (report.focus ||= []).push({ timezoneId, key, ...focus });
          assert.equal(focus.active, true); assert.equal(focus.visible, true); assert.equal(focus.clippedRing, false); assert.equal(focus.hit, true);
        }
        await field('node_4').fill('https://bad.example.test/path');
        await save.click(); await page.waitForFunction(() => document.activeElement?.dataset.settingField === 'node_4');
        await page.waitForTimeout(100);
        assert.equal(await field('node_4').evaluate(el => { const r = el.getBoundingClientRect(); return r.y >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; }), true, 'invalid focus remains visible above the save bar');
        assert.equal(saveRequests().length, 0); assert.equal(await page.locator('.ping-node-item .text-red:visible').count(), 1);
        await screenshot(page, `invalid-${timezoneId.replaceAll('/', '-')}`);
        await field('node_4').fill(targets[7]);
        await field('frontend_ws_timeout_minutes').fill('-1'); await save.click();
        await page.waitForFunction(() => document.activeElement?.dataset.settingField === 'frontend_ws_timeout_minutes');
        assert.equal(saveRequests().length, 0);
        await field('frontend_ws_timeout_minutes').fill('0');
        await field('long_history_points').selectOption({ index: 1 });
        const history = await field('long_history_points').inputValue();
        await save.click(); await page.waitForFunction(() => document.querySelector('.settings-fieldset')?.disabled);
        assert.equal(saveRequests().length, 1);
        const dto = saveRequests()[0].settings;
        assert.equal(dto.site_title, 'CF Monitor'); assert.equal(dto.username, 'fixture');
        assert.equal(dto.auto_discovery, 'false'); assert.equal(dto.wss_report_enabled, 'true');
        assert.deepEqual(dto.wss_report_hours, [timezoneId === 'UTC' ? 0 : timezoneId === 'Asia/Shanghai' ? 16 : 18]);
        assert.equal(dto.frontend_ws_timeout_minutes, '0'); assert.equal(dto.long_history_points, history);
        for (const [index, key] of PING_NODE_FIELDS.entries()) {
          assert.equal(dto[key], validatePingNode(targets[index]).value); assert.equal(dto[`${key}_name`], `Edited probe ${index + 1}`);
        }
        assert.ok(Object.keys(dto).length > 35, 'collection still saves the whole ordinary config');
        assert.equal(await page.locator('.settings-fieldset input:visible').evaluateAll(els => els.every(el => el.matches(':disabled'))), true);
        assert.equal(await page.locator('.settings-fieldset select:visible').evaluateAll(els => els.every(el => el.matches(':disabled'))), true);
        assert.equal(await page.locator('.wss-schedule-actions button').evaluateAll(els => els.every(el => el.matches(':disabled'))), true);
        assert.equal(await save.isDisabled(), true);
        await save.evaluate(el => el.click()); assert.equal(saveRequests().length, 1, 'disabled save cannot duplicate request');
        release(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await save.isEnabled(), true);
        assert.equal(await page.locator('.wss-hour-option input:checked').count(), 1);
        assert.equal(await field('node_4').inputValue(), '192.0.2.4:80');
        await page.locator('.wss-schedule-actions button').last().click();
        await save.click(); await page.waitForFunction(() => document.querySelector('.settings-fieldset')?.disabled);
        assert.deepEqual(saveRequests()[1].settings.wss_report_hours, [], 'clear persists an empty schedule rather than all hours'); release();
        await page.getByRole('dialog').waitFor(); await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
        assert.equal(await page.getByRole('dialog').count(), 0);
      });
    } finally { release(); await ctx.close(); }
  }
} catch (error) {
  report.errors.push(error.stack);
  await currentPage?.screenshot({ path: path.join(out, 'fatal.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); await server?.close();
  report.browserClosed = true; report.serverClosed = true; report.portListening = report.port ? await portOpen(report.port) : false;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, checks: report.checks.length, failed: report.checks.filter(check => !check.pass).length, errors: report.errors, closed: !report.portListening }));
  if (report.errors.length || report.checks.some(check => !check.pass) || report.portListening) process.exitCode = 1;
}
