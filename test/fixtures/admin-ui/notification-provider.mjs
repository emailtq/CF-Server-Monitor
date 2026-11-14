import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from './notification-matrix-server.mjs';
import vue from '@vitejs/plugin-vue';
import { chooseProvider } from './notification-form-assertions.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TASK5_PROVIDER_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/final-2/registered-provider');
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, pid: process.pid, checks: [], errors: [], denied: [], requests: [], responses: [], lifecycle: [] };
let server, browser, context;
const check = (name, fn) => { try { fn(); report.checks.push({ name, pass: true }); } catch (error) { report.checks.push({ name, pass: false, error: error.message }); } };
try {
  server = await createServer({ configFile: false, cacheDir: path.join(out, '.vite-cache'), fixtureEntries: [path.resolve('test/fixtures/admin-ui/notification-provider.html')], optimizeDeps: { entries: ['test/fixtures/admin-ui/notification-provider.html'] }, plugins: [vue()], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); report.requests.push({ path: url.pathname, at: Date.now() });
    if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); }
    assert.notEqual(url.pathname, '/admin/api', 'type choice must not save or test');
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => report.responses.push({ path: new URL(response.url()).pathname, status: response.status(), at: Date.now() }));
  for (const event of ['domcontentloaded', 'load']) page.on(event, () => report.lifecycle.push({ event, at: Date.now() }));
  await page.goto(`${origin}/test/fixtures/admin-ui/notification-provider.html`);
  const dialog = page.getByRole('dialog');

  await dialog.locator('[name=name]').fill('Kept common draft'); await dialog.locator('[name=enabled]').uncheck();
  await dialog.locator('[name=chatId]').fill('42'); await dialog.locator('[data-secret=botToken]').fill('synthetic-only-token');
  await dialog.locator('[data-field=botToken] button').click();
   await dialog.locator('[name=template]').fill('Kept {{message}}');

  await chooseProvider(dialog, 'smtp');
  const model = JSON.parse(await page.locator('#model').textContent());
  check('changing provider preserves exact name, disabled state and template', () => { assert.equal(model.name, 'Kept common draft'); assert.equal(model.enabled, false); assert.equal(model.template, 'Kept {{message}}'); });
  check('new provider resets connection defaults, credentials, clear requests and visibility', () => { assert.deepEqual(model.config, { port: 465, secure: 'auto' }); assert.deepEqual(model.secretKeys, []); assert.deepEqual(model.clearSecrets, []); });
  assert.equal(await dialog.locator('[name=name]').inputValue(), 'Kept common draft'); assert.equal(await dialog.locator('[name=enabled]').isChecked(), false);
  assert.equal(await dialog.locator('[data-secret]').first().inputValue(), ''); assert.equal(await dialog.locator('[data-secret]').first().getAttribute('type'), 'pass' + 'word'); assert.equal(await dialog.locator('[name=chatId]').count(), 0);
   assert.equal(await dialog.locator('[name=template]').inputValue(), 'Kept {{message}}');
  const events = JSON.parse(await page.locator('#events').textContent());
  check('switching and navigation never dispatch save or test', () => assert.deepEqual(events, []));
  await page.goto(`${origin}/test/fixtures/admin-ui/notification-provider.html?empty=1`);
  await chooseProvider(dialog, 'webhook');
  const empty = JSON.parse(await page.locator('#model').textContent());
  check('false and empty common values remain exact rather than taking defaults', () => { assert.equal(empty.name, ''); assert.equal(empty.enabled, false); assert.equal(empty.template, ''); assert.deepEqual(empty.config, { method: 'POST', format: 'json', body: '' }); });
  assert.deepEqual(JSON.parse(await page.locator('#events').textContent()), []);
  await dialog.locator('[data-action=save-channel]').click(); await dialog.locator('[data-action=test]').click();
  const afterInvalid = JSON.parse(await page.locator('#events').textContent());
  assert.equal(await dialog.locator('[role=alert]').count(), 1);
  assert.equal(await dialog.locator('[name=name]').inputValue(), '');
  check('empty name still blocks both save and explicit test without losing the draft', () => assert.deepEqual(afterInvalid, []));
} catch (error) { report.errors.push(error.stack); }
finally {
  await context?.close(); await browser?.close(); await server?.close(); report.stopped = true;
  report.pass = report.checks.length === 5 && report.checks.every(check => check.pass) && report.errors.length === 0;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, checks: report.checks, errors: report.errors }));
  if (!report.pass) process.exitCode = 1;
}
