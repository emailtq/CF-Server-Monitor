import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from './notification-matrix-server.mjs';
import vue from '@vitejs/plugin-vue';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const mode = process.argv[2];
const out = path.resolve(process.env.ADMIN_UI_CORRECTION2_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-4/correction-2/browser', mode);
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, mode, checks: [], errors: [], denied: [], measurements: [] };
const server = await createServer({ cacheDir: path.join(out, '.cache'), frontendExports: true, configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  const check = async (name, fn) => {
    try { await fn(); report.checks.push({ name, pass: true }); }
    catch (error) { report.checks.push({ name, pass: false, error: error.stack }); }
  };
  const context = async (coarse, scheme = 'light') => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: coarse, colorScheme: scheme });
    await ctx.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.denied.push(url.origin); await route.abort(); return; }
      if (url.pathname.endsWith('/admin/api')) {
        await route.fulfill({ json: { success: true, settings: { site_title: 'CF Monitor', username: 'fixture', password_configured: true, preferred_theme: 'auto' }, servers: [{ id: 'fixture', name: 'Fixture node', net_rx_monthly: 0, net_tx_monthly: 0 }], stats: { total: 1 } } }); return;
      }
      if (url.pathname.endsWith('/api/config')) { await route.fulfill({ json: {} }); return; }
      if (url.pathname.endsWith('/theme')) { await route.fulfill({ json: { themes: [] } }); return; }
      await route.continue();
    });
    return ctx;
  };
  const goto = async (page, login = false, locale = 'en') => {
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=${login ? 'login' : 'admin'}&locale=${locale}#/admin`, { waitUntil: 'domcontentloaded' });
    await page.locator(login ? '#login-overlay' : '.server-row').waitFor();
  };
  if (mode === 'themes') {
    for (const scheme of ['dark', 'light']) {
      const ctx = await context(true, scheme), page = await ctx.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await goto(page); await page.locator('[data-page=themeStore]').click();
      for (const preference of ['auto', 'dark', 'light']) await check(`${scheme} system / ${preference}: first and next moon clicks toggle resolved scheme without changing public default`, async () => {
        await page.locator('[data-setting-field=preferred_theme]').selectOption('auto');
        await page.locator('#current-theme').selectOption(preference);
        const startLight = preference === 'light' || (preference === 'auto' && scheme === 'light');
        assert.equal(await page.locator('body').evaluate(el => el.classList.contains('light')), startLight);
        for (const expectedLight of [!startLight, startLight]) {
          const before = await page.locator('.admin-header').evaluate(el => getComputedStyle(el).backgroundColor);
          await page.locator('.admin-theme-button').click();
          assert.equal(await page.locator('body').evaluate(el => el.classList.contains('light')), expectedLight);
          assert.notEqual(await page.locator('.admin-header').evaluate(el => getComputedStyle(el).backgroundColor), before);
          assert.equal(await page.locator('#current-theme').inputValue(), expectedLight ? 'light' : 'dark');
          assert.equal(await page.locator('[data-setting-field=preferred_theme]').inputValue(), 'auto');
        }
        await page.locator('[data-setting-field=preferred_theme]').selectOption(startLight ? 'dark' : 'light');
        assert.equal(await page.locator('body').evaluate(el => el.classList.contains('light')), startLight, 'saved public default is not current interface appearance');
        assert.equal(await page.locator('.admin-theme-button [data-reference-icon=moon]').count(), 1);
      });
      await ctx.close();
    }
  } else if (mode === 'secrets') {
    for (const coarse of [false, true]) {
      const ctx = await context(coarse), page = await ctx.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      for (const locale of ['en', 'es', 'fr', 'id', 'ja', 'zh', 'zh-TW']) {
        await goto(page, false, locale);
        for (const width of [1440, 1024, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse, 'fixture pointer mode must survive resizing and screenshots');
          for (const section of ['settings', 'security']) {
            await page.locator(`[data-page=${section}]`).click();
            if (section === 'security') {
              await page.locator('[data-setting-field=username]').locator('..').locator('..').getByRole('button').first().click();
            }
            const wrappers = page.locator(`#tab-settings .password-input-wrapper:visible`);
            const count = await wrappers.count();
            assert.equal(count, section === 'settings' ? 1 : 5);
            for (let index = 0; index < count; index++) await check(`${locale}/${width}/${coarse ? 'coarse' : 'fine'}/${section}/${index}: text geometry, keyboard and masking`, async () => {
              const wrapper = wrappers.nth(index), input = wrapper.locator('input'), button = wrapper.locator('button');
              await input.fill('synthetic-only-long-fixture-value'.repeat(3)); await button.scrollIntoViewIfNeeded();
              await button.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
              const measure = await button.evaluate(el => {
                const rect = el.getBoundingClientRect(), input = el.parentElement.querySelector('input'), css = getComputedStyle(input), range = document.createRange(); range.selectNodeContents(el);
                const rows = [...range.getClientRects()].map(r => Math.round(r.y));
                const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
                const points = [[x-21,y],[x+21,y],[x,y-21],[x,y+21]].map(([px,py]) => ({ x: px, y: py, hit: el.contains(document.elementFromPoint(px,py)), target: document.elementFromPoint(px,py)?.tagName }));
                const hit44 = points.every(point => point.hit);
                const ir = input.getBoundingClientRect();
                return { width: rect.width, height: rect.height, rows, hit44, points, overlap: ir.right - parseFloat(css.paddingRight) > rect.left, label: el.getAttribute('aria-label'), pressed: el.getAttribute('aria-pressed'), masked: input.type === 'password' || input.classList.contains('secret-input-masked') };
              });
              report.measurements.push({ locale, viewportWidth: width, coarse, section, index, ...measure });
              assert.equal(new Set(measure.rows).size, 1); assert.ok(measure.width >= (coarse ? 44 : 36)); assert.ok(measure.height >= (coarse ? 44 : 36));
              if (coarse) assert.equal(measure.hit44, true);
              assert.equal(measure.overlap, false); assert.ok(measure.label && !measure.label.includes('undefined')); assert.equal(measure.pressed, 'false'); assert.equal(measure.masked, true);
              const label = measure.label; await button.focus(); await page.keyboard.press('Enter');
              assert.equal(await button.getAttribute('aria-pressed'), 'true'); assert.notEqual(await button.getAttribute('aria-label'), label);
              assert.equal(await input.evaluate(el => el.type === 'password' || el.classList.contains('secret-input-masked')), false);
              await page.keyboard.press('Space'); assert.equal(await button.getAttribute('aria-pressed'), 'false');
              assert.equal(await input.evaluate(el => el.type === 'password' || el.classList.contains('secret-input-masked')), true);
            });
            if (section === 'security') await page.locator('[data-setting-field=username]').locator('..').locator('..').getByRole('button').first().click();
            if (['en', 'zh'].includes(locale) && [1440, 390, 320].includes(width)) await page.screenshot({ path: path.join(out, `${section}-${locale}-${width}-${coarse ? 'coarse' : 'fine'}.png`) });
          }
        }
        await page.evaluate(() => localStorage.clear()); await goto(page, true, locale);
        for (const width of [1440, 1024, 768, 390, 320]) await check(`${locale}/${width}/${coarse ? 'coarse' : 'fine'}/login: text geometry and masked keyboard toggle`, async () => {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
          const input = page.locator('.login-form-group.last input'), button = page.locator('.login-form-group.last button');
          await input.fill('synthetic-only-login-fixture'); await button.scrollIntoViewIfNeeded();
          const data = await button.evaluate(el => { const r=el.getBoundingClientRect(), input=el.parentElement.querySelector('input'), ir=input.getBoundingClientRect(), range=document.createRange();range.selectNodeContents(el);const x=r.x+r.width/2,y=r.y+r.height/2;return {width:r.width,height:r.height,rows:[...range.getClientRects()].map(rect=>Math.round(rect.y)),hit44:[[x-21,y],[x+21,y],[x,y-21],[x,y+21]].every(([px,py])=>el.contains(document.elementFromPoint(px,py))),overlap:ir.right-parseFloat(getComputedStyle(input).paddingRight)>r.left}; });
          assert.equal(new Set(data.rows).size,1);assert.ok(data.width >= (coarse?44:36));assert.ok(data.height >= (coarse?44:36));if(coarse)assert.equal(data.hit44,true);assert.equal(data.overlap,false);
          assert.equal(await input.getAttribute('type'),'password');assert.equal(await button.getAttribute('aria-pressed'),'false');await button.focus();await page.keyboard.press('Enter');assert.equal(await input.getAttribute('type'),'text');await page.keyboard.press('Space');assert.equal(await input.getAttribute('type'),'password');
          await page.screenshot({ path: path.join(out, `login-${locale}-${width}-${coarse ? 'coarse' : 'fine'}.png`) });
        });
        await check(`${locale}/${coarse ? 'coarse' : 'fine'}/long action text remains readable without input overlap`, async () => {
          await page.evaluate(async locale => {
            const { translations } = await import('/src/frontend/utils/i18n.js');
            translations[locale].adminShowSecret = 'Show protected value';
            translations[locale].adminHideSecret = 'Hide protected value';
          }, locale);
          for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            const button = page.locator('.login-form-group.last button');
            assert.equal((await button.innerText()).trim(), 'Show protected value');
            const data = await button.evaluate(el => {
              const r = el.getBoundingClientRect(), input = el.parentElement.querySelector('input'), ir = input.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el);
              return { rows: [...range.getClientRects()].map(row => Math.round(row.y)), overlap: ir.right - parseFloat(getComputedStyle(input).paddingRight) > r.left, inputWidth: ir.width, clipped: document.documentElement.scrollWidth > innerWidth || el.scrollWidth > el.clientWidth };
            });
            assert.equal(new Set(data.rows).size, 1); assert.equal(data.overlap, false); assert.equal(data.clipped, false); assert.ok(data.inputWidth > 24);
            await button.click(); assert.equal((await button.innerText()).trim(), 'Hide protected value'); await button.click();
          }
        });
      }
      await ctx.close();
    }
  } else throw new Error('themes or secrets');
} catch (error) { report.errors.push(error.stack); }
finally {
  await browser?.close(); await server.close(); report.stopped = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(check => !check.pass).length;
  console.log(JSON.stringify({ mode, total: report.checks.length, failed, errors: report.errors, stopped: true }));
  if (failed || report.errors.length) process.exitCode = 1;
}
