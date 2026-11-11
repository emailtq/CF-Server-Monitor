import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { assertWizardLabelsVisible } from './wizard-label-assertions.mjs';

const { chromium } = createRequire(import.meta.url)('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TASK5_LABEL_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/final-4/registered-labels');
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, pid: process.pid, checks: [], errors: [], requests: [], denied: [], geometry: [] };
let server, browser, context;
try {
  server = await createServer({ cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  for (const coarse of [true, false]) {
    context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch: coarse, colorScheme: 'light' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); }
      if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
      if (url.pathname.endsWith('/admin/api')) {
        const data = route.request().postDataJSON(); report.requests.push({ action: data.action });
        assert.notEqual(data.action, 'test_notification_channel'); assert.notEqual(data.action, 'save_notification_config');
        return route.fulfill({ json: data.action === 'get_notification_config' ? { schema: 1, revision: 1, language: 'fr', timezone: 'Asia/Shanghai', rules: [], channels: [] } : { success: true, settings: { username: 'fixture', password_configured: true, site_title: 'CF Monitor' }, servers: [{ id: 'node-0', name: 'Node 0' }], stats: { total: 1 } } });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    for (const locale of ['fr', 'en', 'zh', 'zh-TW', 'ja', 'es', 'id']) {
      await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=${locale}#/admin`);
      await page.locator('[data-page=notifications]').click();
      const trans = (await import(`../../../src/frontend/locales/${locale}.js`)).default;
      for (const [width, height] of [[320, 900], [390, 900], [1440, 900], [320, 540], [390, 540]]) {
        await page.setViewportSize({ width, height }); await page.locator('[data-action=add-channel]').click();
        const dialog = page.getByRole('dialog');
        for (const step of [0, 1, 2]) {
          if (step === 1) await dialog.locator('[name=name]').fill('Fixture label');
          const geometry = await assertWizardLabelsVisible(dialog, step, [trans.adminNotificationType, trans.adminBasicInfo, trans.adminMessageTemplate]);
          assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
          report.geometry.push({ locale, width, height, coarse, step, ...geometry });
          report.checks.push({ name: `${locale}/${width}x${height}/${coarse}/step${step}: real glyph visibility and marker semantics`, pass: true });
          if (step === 2 && locale === 'fr' && width === 320 && height === 900 && coarse) await page.screenshot({ path: path.join(out, 'fr320-visible.png') });
          if (step < 2) await dialog.locator('[data-action=next]').click();
        }
        await dialog.locator('[data-action=cancel]').click();
      }
    }
    await context.close(); context = null;
  }
} catch (error) { report.errors.push(error.stack); }
finally {
  await context?.close(); await browser?.close(); await server?.close(); report.stopped = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks.length, errors: report.errors, stopped: true }));
  if (report.errors.length) process.exitCode = 1;
}
