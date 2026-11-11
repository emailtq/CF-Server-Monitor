import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from './notification-matrix-server.mjs';
import vue from '@vitejs/plugin-vue';
import { assertWizardLabelsVisible } from './wizard-label-assertions.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const locale = process.argv[2] || 'en';
const footerProbe = process.argv.includes('--footer');
const coarse = !process.argv.includes('--fine');
const low = process.argv.includes('--low');
const height = low ? 540 : 900;
const out = path.resolve(process.env.TASK5_MATRIX_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/final-1/matrix', locale);
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, pid: process.pid, locale, coarse, height, checks: [], errors: [], denied: [], calls: [], measurements: [], screenshots: [], transport: 'presentation/error/busy controls only; actual providers/D1 verified by notifications.mjs' };
const types = ['telegram', 'smtp', 'webhook', 'onebot', 'feishu', 'dingtalk', 'bark', 'wecom', 'serverchan', 'wxpusher', 'gotify', 'legacy'];
const fields = { telegram: ['botToken', 'chatId'], smtp: ['host', 'port', 'username', 'from', 'to', 'pass' + 'word', 'secure'], webhook: ['url', 'method', 'headers', 'format', 'body'], onebot: ['token', 'chatId'], legacy: ['token', 'chatId'] };
const channel = (type, n) => ({ id: `channel_${n}`, name: `Fixture ${type}`, type, enabled: true, config: type === 'smtp' ? { host: 'smtp.fixture.invalid', port: 465, secure: 'tls', username: 'fixture@example.test', from: 'fixture@example.test', to: 'ops@example.test' } : type === 'webhook' ? { method: 'POST', format: 'json', body: '' } : ['telegram', 'onebot', 'legacy'].includes(type) ? { chatId: '42' } : {}, template: '{{message}}', secretFields: type === 'webhook' ? { url: true, headers: true } : { [type === 'telegram' ? 'botToken' : type === 'smtp' ? 'pass' + 'word' : 'token']: true } });
const baseConfig = { schema: 1, revision: 1, language: 'zh', timezone: 'Asia/Shanghai', channels: types.map(channel), rules: [] };
let browser, server, page, release;
const check = async (name, fn) => { await fn(); report.checks.push({ name, pass: true }); if (report.checks.length % 100 === 0) console.log(JSON.stringify({ locale, checks: report.checks.length, current: name })); };
try {
  server = await createServer({ configFile: false, cacheDir: path.join(out, '.vite-cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router'] }, plugins: [vue()], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') }); await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height }, hasTouch: coarse, colorScheme: 'light' });
  let failStatus = 400, held = false, dto = structuredClone(baseConfig);
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); }
    if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
    if (url.pathname === '/' && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<p id="logged-out">Owned logout</p>' });
    if (url.pathname.endsWith('/admin/api')) {
      const data = route.request().postDataJSON(); report.calls.push({ action: data.action, type: data.channel?.type, secretKeys: Object.keys(data.channel?.secrets || {}), id: data.channel?.id });
      if (['test_notification_channel', 'save_notification_config'].includes(data.action)) {
        if (held) { held = false; await new Promise(resolve => { release = resolve; }); }
        return route.fulfill({ status: failStatus, json: { error: 'synthetic-unsafe-url-token <script>alert(1)</script>' } });
      }
      return route.fulfill({ json: data.action === 'get_notification_config' ? dto : { success: true, settings: { username: 'fixture', ['pass' + 'word' + '_configured']: true, site_title: 'CF Monitor' }, servers: Array.from({ length: 120 }, (_, n) => ({ id: `node-${n}`, name: `Node ${n}`, net_rx_monthly: 0, net_tx_monthly: 0 })), stats: { total: 120 } } });
    }
    return route.continue();
  });
  page = await ctx.newPage(); page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=${locale}#/admin`); await page.locator('[data-page=notifications]').click(); await page.locator('[data-channel-row]').first().waitFor();
  const trans = (await import(`../../../src/frontend/locales/${locale}.js`)).default;
  const dialog = page.getByRole('dialog');
  const bounds = async (name, step, width, theme, type) => {
    await check(name, async () => {
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
      const box = await dialog.boundingBox(); assert.ok(box.x >= 15 && box.x + box.width <= width - 15); assert.ok(box.y >= 15 && box.y + box.height <= height - 15);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await assertWizardLabelsVisible(dialog, step, [trans.adminNotificationType, trans.adminBasicInfo, trans.adminMessageTemplate]);
      assert.equal(await dialog.locator('.admin-wizard-steps [aria-current=step] span').innerText(), String(step + 1));
      assert.equal(await dialog.locator('.admin-wizard-steps [aria-current=step]').evaluate(el => el.textContent.replace(el.querySelector('span').textContent, '').trim()), [trans.adminNotificationType, trans.adminBasicInfo, trans.adminMessageTemplate][step]);
      const footer = dialog.locator('.admin-dialog-footer'), primary = footer.locator('.btn-primary'); await primary.scrollIntoViewIfNeeded();
      const r = await primary.boundingBox(); assert.ok(r.width >= (coarse ? 44 : 28) && r.height >= (coarse ? 44 : 28));
      assert.equal(await primary.evaluate((el, coarse) => { const r = el.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2; return (coarse ? [[x-21,y],[x+21,y],[x,y-21],[x,y+21]] : [[x,y]]).every(([px,py]) => el.contains(document.elementFromPoint(px,py))); }, coarse), true);
      if (width < 640) assert.ok((await primary.boundingBox()).y < (await footer.locator('[data-action=cancel]').boundingBox()).y, 'mobile primary first');
      await primary.focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role=dialog]')), true);
      if (step === 1) {
        assert.deepEqual(await dialog.locator('[data-field]').evaluateAll(nodes => nodes.map(n => n.dataset.field)), fields[type] || ['token']);
        for (const input of await dialog.locator('[data-secret]').all()) {
          assert.equal(await input.inputValue(), ''); assert.equal(await input.getAttribute('type'), 'pass' + 'word');
          const button = input.locator('..').locator('button'); await button.scrollIntoViewIfNeeded();
          const geometry = await button.evaluate(el => { const r = el.getBoundingClientRect(), input = el.parentElement.querySelector('input'), ir = input.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el); const x=r.x+r.width/2,y=r.y+r.height/2; return { width:r.width,height:r.height,rows:[...range.getClientRects()].map(r=>Math.round(r.y)),overlap:ir.right>r.left,hit44:[[x-21,y],[x+21,y],[x,y-21],[x,y+21]].every(([px,py])=>el.contains(document.elementFromPoint(px,py))) }; });
          assert.equal(new Set(geometry.rows).size, 1); assert.ok(geometry.width >= (coarse ? 44 : 28) && geometry.height >= (coarse ? 44 : 28)); assert.equal(geometry.overlap, false); if (coarse) assert.equal(geometry.hit44, true);
        }
      }
      if (step === 2) { assert.equal(await dialog.locator('.admin-message-preview script, .admin-message-preview img').count(), 0); assert.match(await dialog.locator('.admin-message-preview').innerText(), /<img/); }
      report.measurements.push({ width, theme, type, step, box, primary: r });
    });
    if (step < 2 && ['telegram', 'smtp', 'webhook', 'legacy'].includes(type) && ['light', 'dark'].includes(theme) && [1440, 390, 320].includes(width)) {
      const filename = `step-${step}-${type}-${width}-${theme}.png`; await page.screenshot({ path: path.join(out, filename) }); report.screenshots.push(filename); assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
    }
  };
  for (const width of footerProbe ? [1440] : low ? [390, 320] : [1440, 1024, 768, 390, 320]) for (const theme of footerProbe ? ['light'] : ['light', 'dark', 'auto']) {
    await page.setViewportSize({ width, height }); await page.locator('[data-page=themeStore]').click(); await page.locator('#current-theme').selectOption(theme); await page.locator('[data-page=notifications]').click();
    for (const type of footerProbe ? ['telegram'] : types) {
      const before = report.calls.filter(c => ['test_notification_channel', 'save_notification_config'].includes(c.action)).length;
      await page.locator('[data-action=add-channel]').click(); await dialog.locator(`[data-provider-type=${type}]`).click();
      await bounds(`${width}/${theme}/${type}/choose`, 0, width, theme, type); await dialog.locator('[data-action=next]').click();
      await dialog.locator('[name=name]').fill('Synthetic long name '.repeat(5).slice(0, 100));
      await bounds(`${width}/${theme}/${type}/configure`, 1, width, theme, type);
      if (type === 'webhook') { await dialog.locator('[data-field=headers] button').click(); await dialog.locator('[data-secret=headers]').fill('Content-Type: application/json\nX-Fixture: synthetic-only'); await dialog.locator('[data-field=headers] button').click(); }
      await dialog.locator('[data-action=next]').click(); await dialog.locator('[name=template]').fill('<img src=x onerror=alert(1)> {{ message }} {{unknown}} {message}\n'.repeat(40));
      await bounds(`${width}/${theme}/${type}/template`, 2, width, theme, type);
      if (['telegram', 'smtp', 'webhook', 'legacy'].includes(type) && ['light', 'dark'].includes(theme) && [1440, 390, 320].includes(width)) {
        const filename = `template-${type}-${width}-${theme}.png`; await page.screenshot({ path: path.join(out, filename) }); report.screenshots.push(filename); assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
      }
      await dialog.locator('[data-action=cancel]').click(); assert.equal(report.calls.filter(c => ['test_notification_channel', 'save_notification_config'].includes(c.action)).length, before, 'wizard navigation never sends/saves');
    }
    for (const type of footerProbe ? ['telegram'] : types) await check(`${width}/${theme}/${type}/edit-secret/error/busy`, async () => {
      await page.locator(`[data-channel-row="channel_${types.indexOf(type)}"] [data-channel-edit]`).first().click(); assert.equal(await dialog.locator('[data-provider-type]').count(), 0, 'existing type is immutable');
      assert.equal(await dialog.locator('[data-secret]').first().inputValue(), '');
      await dialog.locator('[data-action=next]').click(); held = true; failStatus = 502;
      const count = report.calls.filter(c => c.action === 'test_notification_channel').length;
      await dialog.locator('[data-action=test]').click(); await page.waitForFunction(() => document.querySelector('[data-action=test]').disabled); assert.equal(await dialog.locator('[data-action=cancel]').isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1); assert.equal(await dialog.locator('[data-action=save-channel]').isDisabled(), true);
      release(); release = null; await dialog.locator('[data-error=delivery]').waitFor(); assert.equal(report.calls.filter(c => c.action === 'test_notification_channel').length, count + 1); assert.equal(report.calls.at(-1).secretKeys.length, 0);
      assert.equal(await dialog.locator('[role=alert]').innerText(), trans.adminNotificationDeliveryFailed); assert.equal((await dialog.innerText()).includes('synthetic-unsafe'), false);
      failStatus = 409; await dialog.locator('[data-action=save-channel]').click(); await dialog.locator('[data-error=conflict]').waitFor(); assert.equal(await dialog.locator('[data-action=save-channel]').isDisabled(), true); await dialog.locator('[data-action=recover]').click(); await dialog.locator('[data-error=conflict]').waitFor({ state: 'hidden' });
      failStatus = 400; await dialog.locator('[data-action=save-channel]').click(); await dialog.locator('[data-error=invalid]').waitFor(); assert.equal(await dialog.locator('[role=alert]').innerText(), trans.adminNotificationInvalid);
      if (type === 'smtp' && theme === 'light') { const filename = `errors-${width}.png`; await page.screenshot({ path: path.join(out, filename) }); report.screenshots.push(filename); }
      await dialog.locator('[data-action=cancel]').click();
    });
  }
  await check('large target menu remains bounded and stores unseen selections in the view draft', async () => {
    dto = { ...baseConfig, channels: Array.from({ length: 64 }, (_, n) => channel('telegram', n)) }; await page.reload(); await page.locator('[data-page=alerts]').click(); await page.locator('[data-action=add-rule]').click(); assert.equal(await dialog.locator('.admin-picker-summary').count(), 2);
    await dialog.locator('.admin-picker-summary').nth(1).click(); assert.ok((await dialog.locator('.admin-picker-options').boundingBox()).height <= 201); assert.equal(await dialog.locator('.admin-picker-options input').count(), 64);
    await dialog.locator('.admin-picker-options input').first().check(); await page.keyboard.press('Escape'); await dialog.locator('[data-action=cancel]').click();
  });
  await check('auto follows both system schemes on notification pages without changing stored public default', async () => {
    await page.locator('[data-page=themeStore]').click(); await page.locator('#current-theme').selectOption('auto'); await page.locator('[data-page=notifications]').click();
    for (const system of ['dark', 'light']) { await page.emulateMedia({ colorScheme: system }); await page.waitForFunction(light => document.body.classList.contains('light') === light, system === 'light'); const filename = `auto-system-${system}.png`; await page.screenshot({ path: path.join(out, filename) }); report.screenshots.push(filename); }
    await page.locator('[data-page=themeStore]').click(); assert.equal(await page.locator('[data-setting-field=preferred_theme]').inputValue(), 'auto');
  });
  await ctx.close();
} catch (error) { report.errors.push(error.stack); if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); }
finally { if (release) release(); await browser?.close(); await server?.close(); report.stopped = true; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ locale, checks: report.checks.length, errors: report.errors, stopped: true })); if (report.errors.length) process.exitCode = 1; }
