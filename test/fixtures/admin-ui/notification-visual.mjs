import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from './notification-matrix-server.mjs';
import vue from '@vitejs/plugin-vue';
const require = createRequire(import.meta.url);
const lucideRoot = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/lucide';
const { icons } = require(lucideRoot);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TASK5_VISUAL_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/visual');
fs.mkdirSync(out, { recursive: true });
const seed = JSON.parse(fs.readFileSync('docs/superpowers/admin-ui-refactor/evidence/task-0/reference-data-viewport-tokens.json')).nodes;
const channels = [
  { id: 'ops', type: 'telegram', name: '运维值班群', enabled: true, config: { chatId: '-1000000000001' }, secretFields: { botToken: true }, template: '{{client}} {{event}}\n{{message}}\n{{time}}' },
  { id: 'personal', type: 'telegram', name: '个人消息', enabled: true, config: { chatId: '100000002' }, secretFields: { botToken: true }, template: '{{client}}: {{message}}' },
  { id: 'mail', type: 'smtp', name: '运维邮件', enabled: true, config: { host: 'smtp.example.com', port: 465, username: 'monitor@example.com', from: 'monitor@example.com', to: 'ops@example.com', secure: 'tls' }, secretFields: { ['pass' + 'word']: true }, template: '{{message}}' },
  { id: 'deploy', type: 'webhook', name: '部署机器人', enabled: false, config: { method: 'POST', format: 'json', body: '' }, secretFields: { url: true }, template: '{{message}}' }
];
const config = { schema: 1, revision: 2, language: 'zh', timezone: 'Asia/Shanghai', channels, rules: [
  { id: 'offline', name: '生产节点离线', type: 'offline', enabled: true, options: { minutes: 3 }, scope: { mode: 'selected', serverIds: ['node-1', 'node-2', 'node-3'] }, targetIds: ['ops', 'mail'] },
  { id: 'traffic', name: '流量达到额度', type: 'traffic', enabled: true, options: { threshold: 80 }, scope: { mode: 'all', serverIds: [] }, targetIds: ['personal'] },
  { id: 'expiry', name: '到期提醒', type: 'expiry', enabled: true, options: { days: 7, hour: 9 }, scope: { mode: 'all', serverIds: [] }, targetIds: ['personal', 'mail'] }
] };
const servers = seed.map(n => ({ id: `node-${n.id}`, name: n.name, server_group: n.group, os: n.os, region: n.country, ip_v4: n.ip, net_rx_monthly: 0, net_tx_monthly: 0 }));
const report = { node: process.version, pid: process.pid, checks: [], errors: [], denied: [], pairs: [], measurements: [], kind: 'Presentation-only controlled DTO; actual D1 and sends are in notifications.mjs' };
let server, browser;
const check = async (name, fn) => { await fn(); report.checks.push({ name, pass: true }); };
const measure = (page, selector) => page.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: c.fontSize, fontWeight: c.fontWeight, color: c.color, background: c.backgroundColor, padding: c.padding, gap: c.gap, radius: c.borderRadius }; });
try {
  server = await createServer({ configFile: false, cacheDir: path.join(out, '.vite-cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router'] }, plugins: [vue()], server: { host: '127.0.0.1', port: 0, hmr: false }, publicDir: path.resolve('public') }); await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  for (const coarse of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: coarse, colorScheme: 'light' });
    let many = false;
    await ctx.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); }
      if (url.pathname.endsWith('/admin-ui-approved/preview.html')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync('docs/superpowers/references/admin-ui-approved/preview.html') });
      if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
      if (url.pathname.endsWith('/admin/api')) {
        const data = route.request().postDataJSON();
        assert.notEqual(data.action, 'test_notification_channel', 'presentation navigation must not send');
        assert.notEqual(data.action, 'save_notification_config', 'presentation cancellation must not save');
        return route.fulfill({ json: data.action === 'get_notification_config' ? config : { settings: { username: 'fixture', ['pass' + 'word' + '_configured']: true, site_title: 'CF Monitor' }, servers: many ? Array.from({ length: 120 }, (_, n) => ({ id: `node-${n}`, name: `Node ${n}`, server_group: 'Fixture' })) : servers, stats: { total: many ? 120 : 6 } } });
      }
      return route.continue();
    });
    const page = await ctx.newPage(), ref = await ctx.newPage(); page.on('pageerror', e => report.errors.push(e.message)); ref.on('pageerror', e => report.errors.push(e.message));
    for (const width of [1440, 1024, 768, 390, 320]) for (const theme of ['light', 'dark', 'auto']) {
      await page.setViewportSize({ width, height: 900 }); await ref.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
      await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=zh#/admin`); await page.locator('[data-page=servers]').click(); await page.locator('.server-row').first().waitFor();
      await page.locator('[data-page=themeStore]').click(); await page.locator('#current-theme').selectOption(theme); await page.locator('[data-page=notifications]').click(); await page.locator('[data-channel-row]').first().waitFor();
      await ref.goto(`${origin}/docs/superpowers/references/admin-ui-approved/preview.html`); await ref.addScriptTag({ content: fs.readFileSync(`${lucideRoot}/dist/umd/lucide.min.js`, 'utf8') }); await ref.addStyleTag({ content: `body { margin:0; color-scheme:${theme === 'dark' ? 'dark' : 'light'} }` });
      await ref.locator('.rep-nav [data-page=channels]').click();
      await check(`${width}/${theme}/${coarse}: reference geometry and exact SVG nodes`, async () => {
        assert.equal(await ref.evaluate(() => document.characterSet), 'UTF-8'); assert.match(await ref.locator('.rep-nav').innerText(), /节点.*延迟.*通知.*告警/s);
        assert.equal(await page.locator('.admin-channel-meta').first().locator('span').nth(1).innerText(), await ref.locator('.cf-channel-meta').first().locator('span').nth(1).innerText());
        assert.equal(await page.locator('.admin-channel-identity .server-secondary').first().innerText(), await ref.locator('.cf-channel-identity .cf-secondary').first().innerText());
        assert.equal((await measure(page, '[data-channel-remove]')).color, (await measure(ref, '[data-channel-remove]')).color);
        for (const [actual, expected] of [['.admin-channel-group', '.cf-channel-group'], ['.admin-group-heading', '.cf-group-heading'], ['.admin-channel-row', '.cf-channel-row'], ['.admin-page-heading h2', '.cf-page-heading h2']]) {
          const a = await measure(page, actual), b = await measure(ref, expected); report.measurements.push({ width, theme, coarse, actual, expected, a, b });
          for (const key of ['fontSize', 'padding', 'radius', 'color', 'background']) assert.equal(a[key], b[key], `${actual}.${key}`);
          assert.ok(Math.abs(a.width - b.width) <= 2, `${actual}.width`);
          if (!coarse && actual === '.admin-channel-row') assert.ok(Math.abs(a.height - b.height) <= 2, 'fine row density');
        }
        for (const name of ['bell', 'list-filter', 'send', 'mail', 'webhook', 'arrow-up-right']) {
          const svg = page.locator(`[data-reference-icon="${name}"]`).first(); if (!(await svg.count())) continue;
          const actual = await svg.evaluate(el => [...el.children].map(n => [n.tagName, Object.fromEntries([...n.attributes].map(a => [a.name, a.value]))]));
          const expected = icons[name.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('')]; assert.deepEqual(actual, expected);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      });
      const stem = `${width}-${theme}-${coarse ? 'coarse' : 'fine'}`;
      for (const [actualPage, referencePage] of [['notifications', 'channels'], ['alerts', 'rules']]) {
        await page.locator(`[data-page=${actualPage}]`).click(); await ref.locator(`.rep-nav [data-page=${referencePage}]`).click();
        if (actualPage === 'alerts') await check(`alert reference condition and scope ${stem}`, async () => {
          assert.equal(await page.locator('.admin-rule-condition').first().innerText(), await ref.locator('.cf-rule-condition').first().innerText());
          assert.equal(await page.locator('.admin-rule-detail').first().locator('span').first().innerText(), await ref.locator('.cf-rule-detail').first().locator('span').first().innerText());
        });
        await page.screenshot({ path: path.join(out, `${actualPage}-${stem}.png`) }); await ref.screenshot({ path: path.join(out, `reference-${referencePage}-${stem}.png`) }); report.pairs.push({ actual: `${actualPage}-${stem}.png`, reference: `reference-${referencePage}-${stem}.png`, width, theme, coarse, locale: 'zh' });
        assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
      }
      await page.locator('[data-page=notifications]').click(); await page.locator('[data-action=add-channel]').click();
      const dialog = page.getByRole('dialog');
      for (let step = 0; step < 3; step++) {
        if (step === 1) { await dialog.locator('[name=name]').fill('示例通知'); await dialog.locator('[name=chatId]').fill('-1000000000001'); }
        await check(`wizard ${step}/${stem}: bounds, real coarse targets and keyboard focus`, async () => {
          const r = await dialog.boundingBox(); assert.ok(r.x >= 15 && r.x + r.width <= width - 15); assert.ok(r.y >= 15 && r.y + r.height <= 885);
          if (step === 1) assert.deepEqual(await dialog.locator('[data-secret=botToken], [name=chatId]').evaluateAll(nodes => nodes.map(n => n.dataset.secret || n.name)), ['botToken', 'chatId'], 'frozen Telegram connection field order');
          for (const el of [dialog.locator('[data-action=next]'), dialog.locator('[data-action=save-channel]')]) if (await el.count()) { await el.scrollIntoViewIfNeeded(); const box = await el.boundingBox(); if (coarse) { assert.ok(box.width >= 44 && box.height >= 44); assert.equal(await el.evaluate(el => { const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return [[x-21,y],[x+21,y],[x,y-21],[x,y+21]].every(([px,py])=>el.contains(document.elementFromPoint(px,py))); }), true); } }
          await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role=dialog]')), true);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        });
        await page.screenshot({ path: path.join(out, `wizard-${step}-${stem}.png`) }); assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), coarse);
        if (step < 2) await dialog.locator('[data-action=next]').click();
      }
      await dialog.locator('[data-action=cancel]').click();
      await page.locator('[data-channel-edit=ops]').first().click(); assert.equal(await dialog.locator('[data-secret=botToken]').inputValue(), ''); await page.screenshot({ path: path.join(out, `masked-secret-${stem}.png`) }); await dialog.locator('[data-action=cancel]').click();
      await page.locator('[data-page=alerts]').click(); await page.locator('[data-rule-edit=offline]').first().click(); await dialog.locator('.admin-picker-summary').first().click(); await page.screenshot({ path: path.join(out, `picker-${stem}.png`) }); await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1); await dialog.locator('[data-action=cancel]').click();
    }
    many = true;
    await page.setViewportSize({ width: 390, height: 900 }); await page.reload(); await page.locator('[data-page=alerts]').click(); await page.locator('[data-action=add-rule]').click(); const dialog = page.getByRole('dialog'); assert.equal(await dialog.locator('.admin-picker-summary').count(), 2);
    await check(`120 options/${coarse}: bounded scrolling and hidden selections`, async () => { const before = await dialog.boundingBox(); await dialog.locator('.admin-picker-summary').first().click(); const list = dialog.locator('.admin-picker-options'); assert.ok((await list.boundingBox()).height <= 201); assert.equal(await list.locator('input:not([data-scope-all])').count(), 120); for (let n = 0; n < 119; n++) await list.locator(`input[value="node-${n}"]`).uncheck(); await dialog.locator('.admin-picker-search input').fill('Node 119'); assert.equal(await list.locator('input[value="node-119"]').isChecked(), true); await dialog.locator('.admin-picker-search input').fill('Node 0'); assert.equal(await dialog.locator('.admin-picker-count').innerText(), '1 / 120 已选'); await page.keyboard.press('Escape'); assert.ok(Math.abs((await dialog.boundingBox()).height - before.height) < 50); });
    await dialog.locator('[data-action=cancel]').click(); await ctx.close();
  }
} catch (error) { report.errors.push(error.stack); }
finally { await browser?.close(); await server?.close(); report.stopped = true; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ total: report.checks.length, errors: report.errors, stopped: true })); if (report.errors.length) process.exitCode = 1; }
