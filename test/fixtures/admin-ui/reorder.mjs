import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.ADMIN_REORDER_REPORT_DIR || `.planning/2026-11-13-admin-ui-polish/task1/run-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, checks: [], errors: [], screenshots: [], saves: [], geometry: [], timeline: [] };
const makeNodes = (count = 8, prefix = 'node') => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, name: i === 1 ? 'Tokyo production database with a deliberately long node name' : `Node ${i + 1}`,
  server_group: i % 2 ? 'Production' : 'Default', os: i % 2 ? 'Windows' : 'Linux', region: i % 2 ? 'jp' : 'us',
  ip_v4: `192.0.2.${i % 250 + 1}`, ip_v6: i % 2 ? '2001:db8:abcd:1234::1234' : '', is_online: i % 3 !== 0,
  timestamp: Date.now() - 7200000, is_hidden: i === 2 ? '1' : '0', traffic_limit: 100, traffic_calc_type: 'sum',
  net_rx_monthly: 12 * 1024 ** 3, net_tx_monthly: 8 * 1024 ** 3, price: '5.00', currency: '$', billing_cycle: 'month', expire_date: '2026-12-01'
}));
let nodes = makeNodes(), otherNodes = makeNodes(3, 'other'), saves = [], actions = [], held = [], hold = false, holdList = false, failure = '', reconcileError = '', inFlight = 0, maxInFlight = 0;
let server, browser, context, page, origin, intercept;
const ids = () => page.locator('#tab-servers tbody > .server-row[data-server-id]').evaluateAll(rows => rows.map(row => row.dataset.serverId));
const waitIds = expected => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('tbody .server-row')].map(row => row.dataset.serverId)) === JSON.stringify(expected), expected);
const trace = (phase, details = {}) => report.timeline.push({ time: Date.now(), phase, ...details });
const waitForTransport = async predicate => {
  const deadline = Date.now() + 7000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'fixture transport must reach the expected request/hold state');
};
const release = () => { trace('release-held', { count: held.length }); for (const resolve of held.splice(0)) resolve(); };
const load = async ({ count = 8, locale = 'en', width = 1440, dark = false, reducedMotion = 'no-preference' } = {}) => {
  await page.mouse.up(); hold = holdList = false; release(); await page.waitForTimeout(30); await page.goto('about:blank');
  failure = reconcileError = ''; saves = []; actions = []; inFlight = maxInFlight = 0; nodes = makeNodes(count); otherNodes = makeNodes(3, 'other');
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion, colorScheme: dark ? 'dark' : 'light' });
  await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&sites=1&locale=${locale}#/admin?apiIndex=0`);
  await page.locator('.server-row').first().waitFor();
  await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
};
const point = async index => {
  const box = await page.locator('.server-row').nth(index).locator('.drag-handle').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const start = async (index = 0) => {
  // A sampled coordinate drifts off the grip during FLIP; hover waits for a stable real hit target.
  await page.locator('.server-row').nth(index).locator('.drag-handle').hover();
  const p = await point(index);
  trace('before-pointer-start', await page.evaluate(({ p, index }) => ({ index, p, intended: document.querySelectorAll('.server-row')[index]?.dataset.serverId, hit: document.elementFromPoint(p.x, p.y)?.closest('.server-row')?.dataset.serverId, gripHit: !!document.elementFromPoint(p.x, p.y)?.closest('.drag-handle'), animations: [...document.querySelectorAll('.server-row')].flatMap(row => row.getAnimations()).map(animation => ({ currentTime: animation.currentTime, state: animation.playState })), focus: document.activeElement?.outerHTML.slice(0, 200), events: window.pointerEvidence }), { p, index }));
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  trace('after-pointer-start', await page.evaluate(() => ({ capture: document.querySelector('tbody')?.hasPointerCapture(window.dragPointerId), events: window.pointerEvidence })));
  assert.equal(await page.locator('tbody').evaluate(body => body.hasPointerCapture(window.dragPointerId)), true, 'pointer press must hit the grip before the test advances');
  return p;
};
const moveTo = async index => {
  const row = await page.locator('.server-row').nth(index).boundingBox();
  const p = await point(0);
  await page.mouse.move(p.x, row.y + row.height - 2);
};
const check = async (name, fn) => {
  trace('check-start', { name });
  try { await fn(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, pass: false, error: error.stack }); trace('check-failure', { name, ...(await page.evaluate(() => ({ events: window.pointerEvidence, focus: document.activeElement?.outerHTML.slice(0, 200) })).catch(() => ({}))) }); console.error(`FAIL ${name}\n${error.stack}`); await page?.mouse.up().catch(() => {}); }
};
try {
  server = await createServer({ cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  report.chromium = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.pointerEvidence = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'focusin', 'blur']) {
      document.addEventListener(type, event => {
        if (type === 'pointerdown') window.dragPointerId = event.pointerId;
        window.pointerEvidence.push({ time: Date.now(), type, id: event.target?.closest?.('.server-row')?.dataset.serverId, tag: event.target?.tagName, buttons: event.buttons, x: event.clientX, y: event.clientY });
      }, true);
    }
  });
  intercept = async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith('/admin/api')) {
      const data = req.postDataJSON(), site = url.pathname.startsWith('/site-b') ? 'b' : 'a';
      actions.push({ site, ...data });
      if (data.action === 'save_order') {
        trace('save-request', { orders: data.orders, hold, failure });
        saves.push({ site, ...data }); report.saves.push({ site, ...data });
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        const error = failure; failure = '';
        if (hold) await new Promise(resolve => held.push(resolve));
        trace('save-respond', { orders: data.orders, error });
        if (!error) {
          const rows = site === 'a' ? nodes : otherNodes;
          const ordered = data.orders.map(id => rows.find(row => row.id === id));
          if (site === 'a') nodes = ordered; else otherNodes = ordered;
        }
        inFlight--;
        return route.fulfill({ status: error ? 409 : 200, json: error ? { error } : { success: true } }).catch(() => {});
      }
      if (data.action === 'list') {
        trace('list-request', { refresh: data.refresh });
        const json = { servers: site === 'a' ? nodes : otherNodes, stats: { total: (site === 'a' ? nodes : otherNodes).length } };
        if (holdList && data.refresh) await new Promise(resolve => held.push(resolve));
        return reconcileError && data.refresh ? route.fulfill({ status: 503, json: { error: reconcileError } }) : route.fulfill({ json }).catch(() => {});
      }
      if (data.action === 'get_settings') return route.fulfill({ json: { settings: { site_title: 'CF Monitor', username: 'fixture', terminal_enabled: true } } });
      if (data.action === 'terminal_status') return route.fulfill({ json: { nodes: Object.fromEntries((data.serverIds || []).map(id => [id, { enabled: true, localEnabled: true, state: 'ready' }])) } });
      return route.fulfill({ json: {} });
    }
    if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
    return route.continue();
  };
  await context.route('**/*', intercept);
  page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => report.errors.push(error.stack));

  await check('live DOM displacement uses stable tbody capture and emits one complete save only on release', async () => {
    await load(); const before = await ids(); await start(); await moveTo(2);
    await page.waitForTimeout(80); assert.notDeepEqual(await ids(), before, 'live DOM order must change before release');
    assert.deepEqual(await ids(), ['node-1', 'node-2', 'node-0', ...before.slice(3)]);
    assert.equal(saves.length, 0, 'pointer moves must not save');
    assert.equal(await page.locator('tbody').evaluate(body => body.hasPointerCapture(window.dragPointerId)), true);
    assert.equal(await page.locator('.server-row-drag-ghost, .drag-over').count(), 0);
    const next = await ids(); await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('tbody').hasPointerCapture(window.dragPointerId));
    await page.waitForTimeout(150);
    assert.equal(saves.length, 1); assert.deepEqual(saves[0].orders, next); assert.equal(saves[0].orders.length, 8);
    await waitIds(next);
  });
  await check('Escape, pointercancel, outside release and missed release restore the original order without saving', async () => {
    for (const cancel of ['Escape', 'pointercancel', 'outside', 'buttons-zero']) {
      await load(); const before = await ids(); await start(); await moveTo(2);
      await page.waitForFunction(() => document.querySelector('tbody .server-row')?.dataset.serverId !== 'node-0');
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else if (cancel === 'outside') { await page.mouse.move(5, 5); await page.mouse.up(); }
      else await page.locator('tbody').evaluate((body, type) => body.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: window.dragPointerId, buttons: 0, clientX: 400, clientY: 400 })), cancel === 'pointercancel' ? 'pointercancel' : 'pointermove');
      await waitIds(before); await page.mouse.up(); assert.equal(saves.length, 0, cancel);
      assert.equal(await page.locator('tbody').evaluate(body => body.hasPointerCapture(window.dragPointerId)), false, cancel);
    }
  });
  await check('unequal-height layout hit testing does not oscillate while rows animate', async () => {
    for (const direction of ['down', 'up']) {
      await load(); await page.addStyleTag({ content: '.server-row[data-server-id="node-1"] .admin-node-name { min-height: 180px; }' });
      const before = await ids(), from = direction === 'down' ? 0 : 2;
      const short = await page.locator(`.server-row[data-server-id="node-${from}"]`).boundingBox();
      const tall = await page.locator('.server-row[data-server-id="node-1"]').boundingBox();
      assert.ok(tall.height > short.height + 20, JSON.stringify({ direction, short, tall }));
      const p = await start(from), near = direction === 'down' ? tall.y + 10 : tall.y + tall.height - 10;
      const across = direction === 'down' ? tall.y + tall.height - 2 : tall.y + 2;
      await page.mouse.move(p.x, near); await page.waitForTimeout(80); assert.deepEqual(await ids(), before);
      await page.mouse.move(p.x, across);
      const next = direction === 'down' ? ['node-1', 'node-0', ...before.slice(2)] : ['node-0', 'node-2', 'node-1', ...before.slice(3)];
      await waitIds(next);
      for (let i = 0; i < 8; i++) { await page.mouse.move(p.x, across + (i % 2)); await page.waitForTimeout(20); }
      assert.deepEqual(await ids(), next); assert.equal(saves.length, 0);
      assert.equal((await page.locator('.server-row[data-server-id="node-1"]').boundingBox()).height, tall.height, 'tall node keeps its intrinsic height after displacement');
      assert.equal((await page.locator(`.server-row[data-server-id="node-${from}"]`).boundingBox()).height, short.height);
      await page.keyboard.press('Escape'); await page.mouse.up(); await waitIds(before);
    }
  });
  await check('200 nodes edge-scroll with a stationary pointer and bounded transform-only displacement', async () => {
    await load({ count: 200 }); const before = await ids(), p = await start();
    await page.evaluate(() => { window.frameGaps = []; let previous = performance.now(); const measure = now => { window.frameGaps.push(now - previous); previous = now; if (window.frameGaps.length < 120) requestAnimationFrame(measure); }; requestAnimationFrame(measure); });
    await page.mouse.move(p.x, 895); await page.waitForFunction(() => window.scrollY > 40);
    await page.waitForTimeout(700);
    assert.equal((await ids()).length, 200); assert.notDeepEqual(await ids(), before); assert.equal(saves.length, 0);
    const metrics = await page.evaluate(() => ({ scrollY, maxFrameMs: Math.max(...window.frameGaps), frames: window.frameGaps.length, animated: [...document.querySelectorAll('tbody tr')].flatMap(row => row.getAnimations()).map(animation => animation.effect.getKeyframes().map(frame => Object.keys(frame))) }));
    report.performance = metrics; assert.ok(metrics.frames >= 10); assert.ok(metrics.scrollY > 100);
    for (const animation of metrics.animated) for (const keys of animation) assert.equal(keys.some(key => ['top', 'height', 'margin'].includes(key)), false);
    await page.keyboard.press('Escape'); await page.mouse.up(); await waitIds(before);
    const y = await page.evaluate(() => scrollY); await page.waitForTimeout(100); assert.equal(await page.evaluate(() => scrollY), y, 'cancel stops edge scrolling');
  });
  await check('rapid keyboard saves serialize, failure is visible and final order reconciles from the server', async () => {
    await load(); hold = true;
    const handle = page.locator('[data-server-id="node-0"] .drag-handle');
    await handle.focus(); await page.keyboard.press('ArrowDown');
    await waitForTransport(() => saves.length === 1 && held.length === 1);
    failure = 'fixture_order_refused'; await page.keyboard.press('ArrowDown');
    await waitIds(['node-1', 'node-2', 'node-0', 'node-3', 'node-4', 'node-5', 'node-6', 'node-7']);
    assert.equal(saves.length, 1, 'second save waits'); assert.equal(maxInFlight, 1);
    assert.deepEqual((await ids()).slice(0, 3), ['node-1', 'node-2', 'node-0']);
    release(); await waitForTransport(() => saves.length === 2 && held.length === 1); assert.equal(maxInFlight, 1);
    // Change the authoritative list as another admin would; a failed optimistic order must not remain.
    nodes = [nodes[2], nodes[0], nodes[1], ...nodes.slice(3)]; hold = false; release();
    await page.getByText('fixture_order_refused', { exact: true }).waitFor();
    await waitIds(nodes.map(row => row.id));
    assert.ok(actions.filter(action => action.action === 'list').length >= 2);
    assert.equal(saves.every(save => save.orders.length === 8 && new Set(save.orders).size === 8), true);
    await load(); hold = true; failure = 'fixture_first_order_refused';
    await page.locator('[data-server-id="node-0"] .drag-handle').focus(); await page.keyboard.press('ArrowDown');
    await waitForTransport(() => saves.length === 1 && held.length === 1);
    await page.keyboard.press('ArrowDown'); hold = false; release();
    await page.getByText('fixture_first_order_refused', { exact: true }).waitFor();
    await waitForTransport(() => saves.length === 2 && inFlight === 0);
    await waitIds(['node-1', 'node-2', 'node-0', 'node-3', 'node-4', 'node-5', 'node-6', 'node-7']);
    assert.equal(saves.length, 2); assert.equal(maxInFlight, 1, 'failure must not poison the next queued save');
  });
  await check('stale site saves cannot start queued requests or reconcile/error into a different site, including A-B-A', async () => {
    await load(); hold = true; failure = 'stale_order_failure';
    await page.locator('[data-server-id="node-0"] .drag-handle').focus(); await page.keyboard.press('ArrowDown');
    await waitForTransport(() => saves.length === 1 && held.length === 1);
    assert.equal(saves.length, 1); await page.keyboard.press('ArrowDown');
    await page.evaluate(() => { location.hash = '/admin?apiIndex=1'; }); await waitIds(['other-0', 'other-1', 'other-2']);
    await page.evaluate(() => { location.hash = '/admin?apiIndex=0'; }); await waitIds(makeNodes().map(row => row.id));
    hold = false; release(); await page.waitForTimeout(180);
    assert.equal(saves.length, 1, 'old queued reorder never starts');
    assert.equal(await page.getByText('stale_order_failure', { exact: true }).count(), 0);
    assert.deepEqual(await ids(), makeNodes().map(row => row.id));
    await page.locator('[data-server-id="node-0"] .drag-handle').focus(); await page.keyboard.press('ArrowDown');
    await waitForTransport(() => saves.length === 2 && inFlight === 0);
    assert.equal(saves.length, 2); assert.equal(saves[1].site, 'a');
  });
  await check('failed final server reconciliation is visible rather than claiming the optimistic order is confirmed', async () => {
    await load(); reconcileError = 'fixture_reconcile_unavailable';
    await page.locator('[data-server-id="node-0"] .drag-handle').focus(); await page.keyboard.press('ArrowDown');
    await page.getByText('fixture_reconcile_unavailable', { exact: true }).waitFor();
    assert.equal(saves.length, 1);
    assert.equal(actions.some(action => action.action === 'list' && action.refresh === true), true);
  });
  await check('previous save reconciliation does not cancel a newer pointer drag or erase its live preview', async () => {
    await load(); holdList = true;
    nodes[0] = { ...nodes[0], name: 'Reconciled' };
    await page.locator('[data-server-id="node-0"] .drag-handle').focus(); await page.keyboard.press('ArrowDown');
    await waitForTransport(() => saves.length === 1 && held.length === 1);
    await start(1); await moveTo(3);
    const next = ['node-1', 'node-2', 'node-3', 'node-0', 'node-4', 'node-5', 'node-6', 'node-7']; await waitIds(next);
    const reply = page.waitForResponse(response => response.request().postDataJSON()?.action === 'list' && response.request().postDataJSON()?.refresh === true);
    holdList = false; release(); await (await reply).finished();
    await page.locator('[data-server-id="node-0"] .server-name-link').filter({ hasText: 'Reconciled' }).waitFor();
    assert.equal(await page.locator('tbody').evaluate(body => body.hasPointerCapture(window.dragPointerId)), true, 'old list cannot take the active drag');
    assert.deepEqual(await ids(), next); assert.equal(saves.length, 1);
    await page.mouse.up(); await waitForTransport(() => saves.length === 2 && inFlight === 0); assert.deepEqual(saves[1].orders, next);
  });
  for (const outcome of ['cancel', 'unchanged-release', 'new-save']) {
    await check(`failed prior save authority is adopted after ${outcome} without interrupting the active pointer`, async () => {
      await load(); const authoritative = await ids(); hold = true; failure = 'fixture_prior_order_refused';
      nodes[0] = { ...nodes[0], name: 'Reconciled' };
      await page.locator('[data-server-id="node-0"] .drag-handle').focus(); await page.keyboard.press('ArrowDown');
      await waitForTransport(() => saves.length === 1 && held.length === 1);
      const p = await start(1);
      const beforeDrag = await ids();
      const next = ['node-1', 'node-2', 'node-3', 'node-0', 'node-4', 'node-5', 'node-6', 'node-7'];
      if (outcome === 'unchanged-release') await page.mouse.move(p.x + 8, p.y);
      else { await moveTo(3); await waitIds(next); }
      const reply = page.waitForResponse(response => response.request().postDataJSON()?.action === 'list' && response.request().postDataJSON()?.refresh === true);
      hold = false; release(); await page.getByText('fixture_prior_order_refused', { exact: true }).waitFor();
      await (await reply).finished();
      await page.locator('[data-server-id="node-0"] .server-name-link').filter({ hasText: 'Reconciled' }).waitFor();
      trace('authority-during-pointer', await page.evaluate(() => ({ capture: document.querySelector('tbody')?.hasPointerCapture(window.dragPointerId), events: window.pointerEvidence, focus: document.activeElement?.outerHTML.slice(0, 200) })));
      assert.equal(actions.some(action => action.action === 'list' && action.refresh), true);
      assert.deepEqual(nodes.map(node => node.id), authoritative, 'first refused save cannot change the server order');
      assert.equal(await page.locator('tbody').evaluate(body => body.hasPointerCapture(window.dragPointerId)), true);
      assert.deepEqual(await ids(), outcome === 'unchanged-release' ? beforeDrag : next, 'authority must not overwrite an active preview');
      await page.getByRole('dialog').locator('footer button').evaluate(button => button.click());
      if (outcome === 'cancel') await page.keyboard.press('Escape');
      if (outcome === 'new-save') hold = true;
      await page.mouse.up();
      if (outcome === 'new-save') {
        await waitForTransport(() => saves.length === 2 && held.length === 1);
        assert.equal(saves.length, 2); assert.deepEqual(saves[1].orders, next); assert.deepEqual(await ids(), next, 'delayed old authority cannot erase the new committed preview');
        hold = false; release(); await waitForTransport(() => inFlight === 0); await waitIds(next); assert.deepEqual(nodes.map(node => node.id), next);
      } else {
        await waitIds(authoritative);
        assert.equal(saves.length, 1, 'cancel or unchanged release must not save');
        assert.deepEqual(await ids(), authoritative, 'canceled failed optimistic order must yield to the authority received during drag');
      }
    });
  }
  await check('keyboard up/down keeps focus, respects bounds/filter and reduced motion skips row animations', async () => {
    await load({ reducedMotion: 'reduce' });
    const handle = page.locator('[data-server-id="node-0"] .drag-handle'); await handle.focus(); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(40); assert.equal(saves.length, 0);
    await page.keyboard.press('ArrowDown'); await page.waitForTimeout(100); assert.deepEqual((await ids()).slice(0, 2), ['node-1', 'node-0']); assert.equal(saves.length, 1);
    assert.equal(await handle.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('tbody').evaluate(body => [...body.rows].flatMap(row => row.getAnimations()).length), 0);
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(100); assert.deepEqual((await ids()).slice(0, 2), ['node-0', 'node-1']); assert.equal(saves.length, 2);
    await page.locator('input[type="search"]').fill('Node 1'); assert.equal(await page.locator('.drag-handle:enabled').count(), 0);
    await page.locator('input[type="search"]').fill(''); await page.locator('.toolbar-select').selectOption('Production'); assert.equal(await page.locator('.drag-handle:enabled').count(), 0);
  });
  await check('nested scroll container edge scrolls without scrolling the whole page and unmount releases capture', async () => {
    await load({ count: 50 });
    await page.locator('.table-wrapper').evaluate(element => { element.style.maxHeight = '420px'; });
    const p = await start(), wrapper = await page.locator('.table-wrapper').boundingBox();
    await page.mouse.move(p.x, wrapper.y + wrapper.height - 4);
    await page.waitForFunction(() => document.querySelector('.table-wrapper').scrollTop > 40);
    assert.equal(await page.evaluate(() => scrollY), 0); assert.equal(saves.length, 0);
    await page.evaluate(() => { location.hash = '/fixture'; });
    await page.waitForFunction(() => !document.querySelector('.server-row'));
    await page.mouse.up(); assert.equal(saves.length, 0);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-server-reordering')), false);
  });
  await check('reference font/row/buttons and 1440/320/360/390 light/dark zh/en/ja table overflow matrix', async () => {
    for (const width of [1440, 320, 360, 390]) for (const locale of ['zh', 'en', 'ja']) for (const dark of [false, true]) {
      if (width === 320 && locale === 'zh' && !dark) {
        await page.close();
        context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
        await context.route('**/*', intercept);
        await context.addInitScript(() => document.addEventListener('pointerdown', event => { window.dragPointerId = event.pointerId; }));
        page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => report.errors.push(error.stack));
      }
      await load({ width, locale, dark });
      const geometry = await page.evaluate(() => {
        const table = document.querySelector('.admin-node-table'), wrapper = table.parentElement, cell = table.querySelector('td'), th = table.querySelector('th'), name = table.querySelector('.server-name-link'), button = table.querySelector('.action-btns .btn-icon'), price = table.querySelector('td:nth-child(5) .admin-copy-value'), toolbar = document.querySelector('#tab-servers .toolbar .btn'), style = element => getComputedStyle(element);
        return { coarse: matchMedia('(pointer: coarse)').matches, page: document.documentElement.scrollWidth, viewport: innerWidth, wrapper: wrapper.clientWidth, scroll: wrapper.scrollWidth, font: style(table).fontFamily, toolbarFont: style(toolbar).fontFamily, toolbarLine: style(toolbar).lineHeight, size: style(cell).fontSize, priceSize: style(price).fontSize, line: style(cell).lineHeight, headSize: style(th).fontSize, headWeight: style(th).fontWeight, nameWeight: style(name).fontWeight, nameWidth: name.getBoundingClientRect().width, button: { width: button.offsetWidth, height: button.offsetHeight }, padding: style(cell).padding, borderRadius: style(wrapper).borderRadius };
      });
      report.geometry.push({ width, locale, dark, ...geometry });
      assert.ok(geometry.page <= geometry.viewport, JSON.stringify(geometry));
      assert.equal(geometry.size, '14px'); assert.equal(geometry.priceSize, '14px'); assert.equal(geometry.headSize, '14px'); assert.equal(geometry.line, '20px'); assert.equal(geometry.headWeight, '500'); assert.equal(geometry.nameWeight, '500');
      assert.equal(geometry.toolbarFont, geometry.font); assert.equal(geometry.toolbarLine, '20px');
      assert.ok(geometry.nameWidth >= 96, 'flag/OS assets must not squeeze the name below the reference 6rem slot');
      const buttonSize = geometry.coarse ? 44 : 36;
      assert.deepEqual(geometry.button, { width: buttonSize, height: buttonSize }); assert.equal(geometry.padding, '8px');
      assert.equal(geometry.coarse, width < 640);
      if (width < 640) {
        assert.ok(geometry.scroll > geometry.wrapper);
        await page.locator('.table-wrapper').evaluate(element => { element.scrollLeft = element.scrollWidth; });
        assert.ok(await page.locator('.table-wrapper').evaluate(element => element.scrollLeft > 0));
        assert.equal(await page.locator('.table-wrapper').evaluate(element => {
          const visible = element.getBoundingClientRect(), actions = element.querySelector('.action-btns').getBoundingClientRect();
          return actions.left >= visible.left && actions.right <= visible.right;
        }), true, 'all five CF actions remain reachable inside the table scroll area');
        if (width === 320) {
          const screenshot = path.join(out, `nodes-${width}-${locale}-${dark ? 'dark' : 'light'}-actions.png`);
          await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
        }
      }
      await page.locator('.table-wrapper').evaluate(element => { element.scrollLeft = 0; });
      const screenshot = path.join(out, `nodes-${width}-${locale}-${dark ? 'dark' : 'light'}.png`); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    }
  });
  await check('native coarse touch pointer reorders the real mounted Vue rows and saves once on touch end', async () => {
    await load({ width: 390 });
    const cdp = await context.newCDPSession(page), p = await point(0), before = await ids();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    const target = await page.locator('.server-row').nth(2).boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: target.y + target.height - 2 }] });
    await waitIds(['node-1', 'node-2', 'node-0', ...before.slice(3)]); assert.equal(saves.length, 0);
    assert.equal(await page.locator('tbody').evaluate(body => body.hasPointerCapture(window.dragPointerId)), true);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(150);
    assert.equal(saves.length, 1); assert.deepEqual(saves[0].orders, ['node-1', 'node-2', 'node-0', ...before.slice(3)]);
    await cdp.detach();
  });
  assert.deepEqual(report.errors, [], 'no Vue/browser exceptions');
} catch (error) { report.errors.push(error.stack); }
finally {
  release(); await browser?.close(); await server?.close(); report.closed = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${out}`);
}
if (report.errors.length || report.checks.some(check => !check.pass)) process.exitCode = 1;
