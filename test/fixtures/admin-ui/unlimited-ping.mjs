import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness } from '../../terminal-harness.js';
import { saveSiteOptions } from '../../../src/utils/settings.js';
import { PING_NODE_FIELDS } from '../../../src/frontend/utils/pingNode.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const out = process.env.PING_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `stage3-${process.env.CODEX_THREAD_ID || 'unlimited-ping'}`, `ui-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const evidence = { checks: [], screenshots: [], errors: [], device: 'Chromium emulated 360/390 touch and 1440/1920 mouse/keyboard; no physical Android or system IME', calls: [] };
let h, server, browser, context, wss, page;
const peers = [];
const contrastOnly = process.argv.includes('--contrast');
const legacy = Object.fromEntries(PING_NODE_FIELDS.flatMap((field, i) => [[field, '127.0.0.1:1'], [`${field}_name`, `Node ${i + 1}`]]));
const seed = { ...legacy, extra_ping_nodes: [], ['pass' + 'word']: 'fixture-only-hash', username: 'fixture', is_public: 'true', show_three_net_details: 'true', wss_report_enabled: 'true', theme_url: '' };
let sequence = 0;
// Use the real minimum report cadence, rather than putting unrelated configurations in one 10-second history bucket.
const historyStart = Date.now() - 270000;
const report = async (extra, change = {}, timestamp = historyStart + ++sequence * 30000) => {
  const metrics = { cpu: '12', ram_total: '1024', ram_used: '512', os: 'Ubuntu 24.04', kernel_version: '6.8', cpu_cores: '2', timestamp,
    ...Object.fromEntries(['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4'].flatMap(id => [[`ping_${id}`, false], [`loss_${id}`, false]])),
    extra_probes: Object.fromEntries(extra.map((node, i) => [node.id, change[node.id] || { ping: 31 + i, loss: 0 }])) };
  const response = await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'node-a', metrics }) });
  assert.equal(response.status, 200);
};
const snapshot = async (page, name) => {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file }); evidence.screenshots.push(file);
};
const action = async (page, cdp, locator, mobile) => {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(el => el.scrollIntoView({ block: 'center' }));
  if (!mobile) { await locator.click(); return; }
  const r = await locator.boundingBox(), touchPoints = [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }];
  const hit = await locator.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
  assert.ok(hit, `touch target is covered: ${await locator.getAttribute('data-action') || await locator.textContent()}`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
try {
  h = await harness();
  await saveSiteOptions(h.db, seed);
  await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=?,custom_ct='0',custom_cu='0',custom_cm='0',custom_bd='0',node_1='0',node_2='0',node_3='0',node_4='0' WHERE id='node-a'").bind(Date.now() - 3600000).run();
  server = await createServer({ cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public'), fixtureEntries: [path.resolve('test/fixtures/admin-ui/unlimited-ping.html')], apiMiddlewarePlugin: { name: 'ping-actual-worker-d1', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, 'http://fixture.invalid');
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/admin/api') return next();
      if (url.pathname === '/api/ws') return next();
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const headers = { ...request.headers, Origin: 'https://example.com' }; delete headers.host;
        // Public config has no remote-version lookup; test login consent is supplied by the existing fixture pattern.
        if (url.pathname === '/api/config') delete headers.cookie;
        if (body && url.pathname === '/admin/api') evidence.calls.push({ action: JSON.parse(body).action });
        const result = await h.fetch(url.pathname + url.search, { method: request.method, headers, ...(body ? { body } : {}) });
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) { evidence.errors.push(error.stack); response.statusCode = 500; response.end('fixture request failed'); }
    });
  } } });
  wss = new WebSocketServer({ noServer: true });
  server.httpServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, async ws => {
      const peer = await h.socket(request.url); peers.push(peer);
      for (const message of peer.messages) if (ws.readyState === 1) ws.send(message);
      peer.ws.on('message', (data, binary) => { if (ws.readyState === 1) ws.send(data, { binary }); });
      ws.on('close', () => peer.ws.terminate());
    });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ADMIN_UI_CHROMIUM || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe'), ignoreDefaultArgs: ['--hide-scrollbars'] });
  evidence.chromium = browser.version();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const width of contrastOnly ? [390, 1440] : [360, 390, 1440, 1920]) for (const dark of [false, true]) {
    const mobile = width < 640, locale = width === 360 ? 'zh' : width === 390 ? 'zh-TW' : 'en';
    const reset = await h.action('save_settings', { settings: seed }); assert.equal(reset.status, 200, await reset.text());
    await context?.close();
    context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 1080 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    await context.addCookies([{ name: 'cfsm_auth', value: h.token, url: origin }]);
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => evidence.errors.push(error.stack));
    const cdp = await context.newCDPSession(page);
    await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=${locale}#/admin`);
    await page.locator('[data-page=collection]').waitFor();
    await action(page, cdp, page.locator('[data-page=collection]'), mobile);
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
    assert.equal(await page.locator('.ping-node-item').count(), 8);
    const add = page.locator('[data-action=add-ping-node]');
    await action(page, cdp, add, mobile);
    assert.equal(await page.locator('.ping-node-item').count(), 9);
    assert.equal(await add.isEnabled(), true);
    await page.locator('[data-ping-resource-warning]').waitFor();
    const firstExtra = page.locator('[data-ping-node]').nth(8), id = await firstExtra.getAttribute('data-ping-node');
    await firstExtra.locator('input').last().fill('invalid://target');
    await action(page, cdp, page.locator('.settings-save-bar button'), mobile);
    assert.equal(await firstExtra.locator('.input-invalid').count(), 1);
    await firstExtra.locator('input').last().fill('127.0.0.1:1');
    await firstExtra.locator('input').first().fill('Extra Nine');
    const targetCount = width === 390 && dark ? 32 : 11;
    for (let n = 9; n < targetCount; n++) {
      if (!mobile) { await add.focus(); await page.keyboard.press('Enter'); }
      else await action(page, cdp, add, mobile);
      await page.locator('[data-ping-node]').last().locator('input').last().fill('127.0.0.1:1');
    }
    assert.equal(await page.locator('.ping-node-item').count(), targetCount);
    await add.scrollIntoViewIfNeeded();
    const overflow = await page.locator('.collection-settings').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, body: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(overflow.scroll <= overflow.width + 1 && overflow.body <= width + 1, JSON.stringify(overflow));
    await snapshot(page, `${width}-${dark ? 'dark' : 'light'}-warning-add`);
    await action(page, cdp, page.locator('.settings-save-bar button'), mobile);
    await page.waitForFunction(() => !document.querySelector('.settings-save-bar button').disabled);
    let saved = (await (await h.action('get_settings')).json()).settings.extra_ping_nodes;
    assert.equal(saved.length, targetCount - 8); assert.equal(saved[0].id, id); assert.equal(saved[0].name, 'Extra Nine');
    await page.reload(); await action(page, cdp, page.locator('[data-page=collection]'), mobile);
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
    assert.equal(await page.locator('.ping-node-item').count(), targetCount);
    assert.equal(await page.locator(`[data-ping-node="${id}"] input`).first().inputValue(), 'Extra Nine');
    await action(page, cdp, page.locator(`[data-ping-node="${id}"] [data-action=remove-ping-node]`), mobile);
    await action(page, cdp, add, mobile);
    const replacement = await page.locator('[data-ping-node]').last().getAttribute('data-ping-node'); assert.notEqual(replacement, id);
    await page.locator('[data-ping-node]').last().locator('input').last().fill('127.0.0.1:1');
    await action(page, cdp, page.locator('.settings-save-bar button'), mobile);
    await page.waitForFunction(() => !document.querySelector('.settings-save-bar button').disabled);
    const current = (await (await h.action('get_settings')).json()).settings.extra_ping_nodes;
    assert.deepEqual(current.slice(0, -1).map(node => node.id), saved.slice(1).map(node => node.id));
    saved = current;
    await report(saved);
    await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=${locale}#/`);
    await page.waitForFunction(name => [...document.querySelectorAll('.three-net-name')].some(el => el.textContent === name), saved[0].name);
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
    await snapshot(page, `${width}-${dark ? 'dark' : 'light'}-public-card`);
    await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=${locale}#/server/node-a`);
    await page.waitForFunction(() => window.pingCharts?.().some(chart => chart.datasets.some(ds => ds.field?.startsWith('ping_extra_') && ds.data.length)));
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
    const datasets = await page.evaluate(() => window.pingCharts().find(chart => chart.datasets.some(ds => ds.field?.startsWith('ping_extra_'))).datasets.filter(ds => ds.field?.startsWith('ping_extra_')));
    assert.deepEqual(datasets.map(ds => ds.field), saved.map(node => `ping_extra_${node.id}`));
    assert.ok(datasets.every(ds => ds.data.some(point => typeof point.y === 'number' && point.y > 0)), 'each current target needs a measured history point, not only padded null buckets');
    const pingCard = page.locator('.chart-card:visible').filter({ has: page.locator('.ping-indicator') }).first();
    await pingCard.scrollIntoViewIfNeeded();
    assert.ok((await pingCard.locator('.ping-indicator').textContent()).includes(saved[0].name));
    assert.ok(await pingCard.locator('.ping-indicator span').first().evaluate(el => getComputedStyle(el).color === getComputedStyle(document.body).color), 'new target readouts use readable theme text, not pale chart stroke colors');
    await snapshot(page, `${width}-${dark ? 'dark' : 'light'}-public-history`);
    if (width === 390 && dark) {
      const last = saved.at(-1);
      await report(saved, { [last.id]: { ping: null, loss: 100 } }, Date.now() - 1000);
      await page.waitForFunction(id => window.pingCharts().some(chart => chart.datasets.some(ds => ds.field === `ping_extra_${id}` && ds.data.some(point => point.y === 100))), last.id);
      await report(saved, { [last.id]: { ping: false, loss: false } }, Date.now() - 500);
      await page.waitForFunction(id => window.pingCharts().filter(chart => chart.datasets.some(ds => ds.field === `ping_extra_${id}`)).every(chart => chart.datasets.find(ds => ds.field === `ping_extra_${id}`).hidden), last.id);
      await report(saved, {}, Date.now());
      await page.waitForFunction(id => window.pingCharts().filter(chart => chart.datasets.some(ds => ds.field === `ping_extra_${id}`)).every(chart => !chart.datasets.find(ds => ds.field === `ping_extra_${id}`).hidden), last.id);
      evidence.checks.push('actual DO websocket → browser extra target failure updates chart');
    }
    evidence.checks.push(`${width}/${dark ? 'dark' : 'light'}/${locale}: ${targetCount} rows, nonblocking warning, ${mobile ? 'CDP touch' : 'mouse/keyboard'}, validation, save/reload, rename/remove stable IDs, D1 public history charts`);
    await page.close();
  }
  for (const locale of contrastOnly ? [] : ['ja', 'fr', 'es', 'id']) {
    const extra = [{ id: 'p_locale', name: 'Node 9', target: '' }];
    assert.equal((await h.action('save_settings', { settings: { ...seed, extra_ping_nodes: extra } })).status, 200);
    await context?.close();
    context = await browser.newContext({ viewport: { width: 360, height: 844 }, isMobile: true, hasTouch: true });
    await context.addCookies([{ name: 'cfsm_auth', value: h.token, url: origin }]);
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page = await context.newPage();
    await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=${locale}#/admin`);
    const cdp = await context.newCDPSession(page);
    await action(page, cdp, page.locator('[data-page=collection]'), true);
    const warning = page.locator('[data-ping-resource-warning]');
    const trans = (await import(`../../../src/frontend/locales/${locale}.js`)).default;
    assert.equal(await warning.textContent(), trans.adminPingResourceWarning);
    assert.equal(await page.locator('[data-action=add-ping-node]').isEnabled(), true);
    await warning.scrollIntoViewIfNeeded(); await snapshot(page, `360-${locale}-warning`);
    assert.ok(await page.locator('.collection-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    evidence.checks.push(`${locale}: localized warning and capability requirement render without overflow at 360 touch`);
  }
  assert.deepEqual(evidence.errors, []);
} catch (error) {
  evidence.failure = error.stack;
  await snapshot(page, 'failure').catch(() => {});
  throw error;
} finally {
  await context?.close(); await browser?.close();
  for (const peer of peers) peer.ws?.terminate();
  if (wss) { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); }
  await server?.close(); await h?.dispose();
  evidence.closed = true;
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log('Evidence:', out);
}
