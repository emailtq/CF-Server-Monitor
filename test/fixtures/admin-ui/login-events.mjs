import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness } from '../../terminal-harness.js';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.LOGIN_EVENTS_REPORT_DIR);
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], errors: [], screenshots: [], channelSends: 0, realD1: true, physicalDevice: false };
let h, server, browser, context;
try {
  h = await harness({ outboundService: async () => { report.channelSends++; return Response.json({ ok: true }); } });
  const config = { schema: 1, revision: 1, language: 'en', timezone: 'UTC', rules: [], channels: [{ id: 'fixture-channel', name: 'Fixture channel', type: 'telegram', enabled: true, config: { chatId: 'fixture' }, secrets: { botToken: 'fixture-token' }, template: '{{event}} {{message}} {{time}}' }] };
  await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(config)).run();
  server = await createServer({ frontendExports: true, cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith('/api/config') || url.pathname === '/theme') return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/admin/api')) {
      const data = route.request().postDataJSON();
      if (['get_notification_config', 'save_notification_config', 'get_login_event_status'].includes(data.action)) {
        const response = await h.action(data.action, Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'action')));
        return route.fulfill({ status: response.status, body: await response.text(), contentType: 'application/json' });
      }
      return route.fulfill({ json: { success: true, settings: { username: 'fixture', password_configured: true, site_title: 'CF Monitor' }, servers: ['node-a','node-b'].map(id => ({ id, name: id, net_rx_monthly: 0, net_tx_monthly: 0 })), stats: { total: 2 } } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.stack));
  for (const width of [360,390,1440,1920]) for (const theme of ['light','dark']) {
    const locale = width < 400 ? 'zh' : width === 1920 ? 'fr' : 'en';
    await page.setViewportSize({ width, height: width < 400 ? 844 : 1000 });
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=${locale}#/admin`);
    await page.evaluate(async theme => (await import('/src/frontend/composables/useTheme.js')).useTheme().setTheme(theme), theme);
    await page.locator('[data-page=alerts]').click();
    const dialog = page.getByRole('dialog');
    for (const type of ['sshLogin','panelLogin','terminalConnected']) {
      await page.locator('[data-action=add-rule]').click();
      await dialog.locator('[name=event]').selectOption(type);
      await dialog.locator('[name=name]').fill(`${width}-${theme}-${type}`);
      assert.equal(await dialog.locator('[name=threshold],[name=minutes],[name=days],[name=hour]').count(), 0);
      assert.equal(await dialog.locator('.admin-picker-summary').count(), type === 'panelLogin' ? 1 : 2);
      // Use the actual picker trigger, not a Vue draft mutation.
      await dialog.locator('.admin-picker-summary').last().click();
      const option = dialog.getByRole('checkbox', { name: /Fixture channel/ });
      await option.check();
      await page.keyboard.press('Escape');
      const shot = `${width}-${theme}-${type}.png`;
      await page.screenshot({ path: path.join(out, shot) }); report.screenshots.push(shot);
      const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await dialog.locator('[data-action=save-rule]').click(); await dialog.waitFor({ state: 'hidden' });
      const saved = await (await h.action('get_notification_config')).json();
      const rule = saved.rules.find(rule => rule.name === `${width}-${theme}-${type}`);
      assert.equal(rule.type, type); assert.equal(rule.scope.mode, type === 'panelLogin' ? 'site' : 'all'); assert.deepEqual(rule.options, {});
      await page.locator(`[data-rule-edit="${rule.id}"]`).first().click();
      assert.equal(await dialog.locator('[name=event]').inputValue(), type);
      await dialog.locator('[name=name]').fill(rule.name + '-edited'); await dialog.locator('[data-action=save-rule]').click(); await dialog.waitFor({ state: 'hidden' });
      report.checks.push({ width, theme, locale, type, pass: true });
    }
  }
  assert.equal(report.channelSends, 0, 'editing a rule must not invent a success event');
} catch (error) { report.errors.push(error.stack); }
finally {
  await context?.unrouteAll({ behavior: 'wait' }); await browser?.close(); await server?.close(); await h?.dispose(); report.closed = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
