import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { nativeScrollbar as assertNativeScrollbar } from './scrollbar-assertions.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { PNG } = createRequire(import.meta.url)(process.env.ADMIN_UI_PNGJS || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pngjs');
const out = path.resolve(process.env.ADMIN_REORDER_REPORT_DIR || `.planning/2026-11-13-admin-ui-refinement/task1/run-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, checks: [], errors: [], screenshots: [], saves: [], geometry: [], timeline: [] };
const makeNodes = (count = 8, prefix = 'node') => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, name: i === 1 ? 'Tokyo production database with a deliberately long node name' : `Node ${i + 1}`,
  server_group: i === 2 ? '' : i === 5 ? 'Production-team-with-a-deliberately-long-unbroken-group-name-for-wrap-validation' : i % 2 ? 'Production' : 'Default', os: i === 0 ? 'Ubuntu 24.04.3 LTS' : i === 2 ? '' : i === 3 ? 'MysteryOS 7.3 build 12' : i === 5 ? 'Alibaba Cloud Linux 3.2104 LTS kernel 5.10.134' : i === 6 ? 'Linux 6.8.0-101 generic build 42' : i === 7 ? 'macOS 15.2.1' : i % 2 ? 'Windows Server 2025' : 'Debian GNU/Linux 13 (trixie)', region: i >= 8 && i <= 12 ? ['SH-AC', 'SH-TA', 'GB-ENG', 'GB-SCT', 'GB-WLS'][i - 8] : i === 0 ? 'hk' : i === 2 ? '' : i === 3 ? 'xx' : i === 4 ? 'uk' : i === 6 ? 'not-a-region' : i === 7 ? 'TW' : i % 2 ? 'jp' : 'us',
  ip_v4: `192.0.2.${i % 250 + 1}`, ip_v6: i % 2 ? '2001:db8:abcd:1234::1234' : '', is_online: i % 3 !== 0,
  timestamp: Date.now() - 7200000, is_hidden: i === 2 ? '1' : '0', traffic_limit: 100, traffic_calc_type: 'sum',
  net_rx_monthly: 12 * 1024 ** 3, net_tx_monthly: 8 * 1024 ** 3, price: '5.00', currency: '$', billing_cycle: 'month', expire_date: '2026-12-01'
}));
let nodes = makeNodes(), otherNodes = makeNodes(3, 'other'), saves = [], actions = [], held = [], hold = false, holdList = false, failure = '', reconcileError = '', inFlight = 0, maxInFlight = 0;
let server, browser, context, page, origin, httpOrigin, intercept, dragStart;
const ids = () => page.locator('#tab-servers tbody > .server-row[data-server-id]').evaluateAll(rows => rows.map(row => row.dataset.serverId));
const waitIds = expected => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('tbody .server-row')].map(row => row.dataset.serverId)) === JSON.stringify(expected), expected);
const selectGroup = async label => {
  await page.locator('.admin-toolbar-group-trigger').click();
  await page.getByRole('option', { name: label, exact: true }).click();
};
const trace = (phase, details = {}) => report.timeline.push({ time: Date.now(), phase, ...details });
const nativeScrollbar = (...args) => assertNativeScrollbar({ page, out, report, PNG }, ...args);
const waitForTransport = async predicate => {
  const deadline = Date.now() + 7000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'fixture transport must reach the expected request/hold state');
};
const release = () => { trace('release-held', { count: held.length }); for (const resolve of held.splice(0)) resolve(); };
const load = async ({ count = 8, locale = 'en', width = 1440, dark = false, reducedMotion = 'no-preference', terminalSite = false, uniqueGroups = false } = {}) => {
  await page.mouse.up(); hold = holdList = false; release(); await page.waitForTimeout(30); await page.goto('about:blank');
  failure = reconcileError = ''; saves = []; actions = []; inFlight = maxInFlight = 0; nodes = makeNodes(count); otherNodes = makeNodes(3, 'other');
  if (uniqueGroups) nodes.forEach((node, i) => { node.server_group = `Group ${i.toString().padStart(2, '0')}`; });
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion, colorScheme: dark ? 'dark' : 'light' });
  await page.goto(`${origin}/${terminalSite ? 'admin' : 'test/fixtures/admin-ui/index.html'}?mode=admin&${terminalSite ? '' : 'sites=1&'}locale=${locale}#/admin?apiIndex=0`);
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
  const row = await page.locator('.server-row').nth(index).boundingBox();
  dragStart = { ...p, grab: p.y - row.y, id: await page.locator('.server-row').nth(index).getAttribute('data-server-id') };
  return p;
};
const moveTo = async index => {
  const row = await page.locator('.server-row').nth(index).evaluate(row => ({ y: row.offsetParent.getBoundingClientRect().top + row.offsetTop, height: row.offsetHeight }));
  const height = await page.locator(`[data-server-id="${dragStart.id}"]`).evaluate(row => row.offsetHeight);
  // New overlap threshold is measured at the row edge, not at the pointer's old destination slot.
  await page.mouse.move(dragStart.x, row.y + Math.min(height, row.height) * .55 - height + dragStart.grab);
};
const check = async (name, fn) => {
  trace('check-start', { name });
  try { await fn(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, pass: false, error: error.stack }); trace('check-failure', { name, ...(await page.evaluate(() => ({ events: window.pointerEvidence, focus: document.activeElement?.outerHTML.slice(0, 200), rows: [...document.querySelectorAll('.server-row')].slice(0, 8).map(row => ({ id: row.dataset.serverId, top: row.offsetTop, height: row.offsetHeight, visual: row.getBoundingClientRect().top, transform: row.style.transform })) })).catch(() => ({}))) }); console.error(`FAIL ${name}\n${error.stack}`); await page?.mouse.up().catch(() => {}); }
};
const terminalReturnChecks = async (coarse, width = coarse ? 390 : 1440) => {
  await check(`${coarse ? 'coarse' : 'fine'} ${width} terminal tab return keeps ready entry hint hidden and node row background neutral`, async () => {
    await load({ width, terminalSite: true });
    const row = page.locator('[data-server-id="node-0"]'), button = row.locator('.terminal-entry button');
    await page.waitForFunction(() => !document.querySelector('[data-server-id="node-0"] .terminal-entry button').disabled);
    if (coarse) await page.locator('.table-wrapper').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await page.mouse.move(1, 1); const before = await row.evaluate(row => getComputedStyle(row).backgroundColor);
    if (coarse) {
      const cdp = await context.newCDPSession(page), box = await button.boundingBox(), touchPoints = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
    } else await button.click();
    assert.equal(await page.evaluate(() => window.opened.length), 1, 'real component opens synchronously into the simulated new tab');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    const after = await row.evaluate(row => ({ background: getComputedStyle(row).backgroundColor, reasonDisplay: getComputedStyle(row.querySelector('.terminal-reason')).display, hover: row.matches(':hover'), focused: document.activeElement?.className, aria: row.querySelector('.terminal-entry button').getAttribute('aria-label'), coarse: matchMedia('(pointer: coarse)').matches }));
    report.geometry.push({ kind: 'terminal-return', coarse, before, after });
    const screenshot = path.join(out, `terminal-return-${coarse ? 'coarse' : 'fine'}-${width}.png`); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    assert.equal(after.coarse, coarse); assert.ok(after.aria); assert.equal(after.reasonDisplay, 'none', 'ready terminal does not leave an obvious entry tooltip after return'); assert.equal(after.background, before, 'node hover must not leave a decorative whole-row fill');
    await page.keyboard.press('Tab'); await button.focus();
    assert.equal(await button.evaluate(button => button.matches(':focus-visible') && getComputedStyle(button).outlineStyle === 'solid'), true);
    assert.equal(await row.locator('.terminal-reason').isVisible(), false);
  });
  await check(`${coarse ? 'coarse' : 'fine'} ${width} unavailable terminal reason remains keyboard and pointer accessible without opening a tab`, async () => {
    await load({ width, terminalSite: true }); const entry = page.locator('[data-server-id="node-2"] .terminal-entry'), button = entry.locator('button'), reason = entry.locator('.terminal-reason');
    await page.waitForFunction(() => document.querySelector('[data-server-id="node-2"] .terminal-reason')?.textContent.includes('Local terminal'));
    assert.equal(await button.isDisabled(), true);
    await page.keyboard.press('Tab'); await entry.focus();
    assert.equal(await reason.isVisible(), true); assert.ok(await reason.innerText());
    assert.equal(await reason.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }), true, 'unavailable reason must paint above neighboring row backgrounds, not merely have display:block');
    assert.equal(await reason.evaluate(element => { const rect = element.getBoundingClientRect(), wrapper = element.closest('.table-wrapper').getBoundingClientRect(); return rect.left >= wrapper.left + 1 && rect.right <= wrapper.right - 1; }), true, 'keyboard focuses the action block without clipping its reason');
    assert.equal(await entry.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid'), true, 'reason trigger retains a keyboard focus indicator');
    const keyboardScreenshot = path.join(out, `terminal-unavailable-keyboard-${coarse ? 'coarse' : 'fine'}-${width}.png`); await page.screenshot({ path: keyboardScreenshot }); report.screenshots.push(keyboardScreenshot);
    await page.mouse.click(1, 1);
    if (coarse) {
      await page.locator('.table-wrapper').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await entry.tap();
    } else await entry.hover();
    assert.equal(await reason.isVisible(), true, 'unavailable reason is reachable by native touch/fine hover'); assert.equal(await page.evaluate(() => window.opened.length), 0);
    assert.equal(await reason.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }), true);
    assert.equal(await reason.evaluate(element => { const rect = element.getBoundingClientRect(), wrapper = element.closest('.table-wrapper').getBoundingClientRect(); return rect.left >= wrapper.left + 1 && rect.right <= wrapper.right - 1; }), true, 'the complete pointer reason, not just its center, stays within table viewport edges');
    assert.equal(await entry.evaluate(element => getComputedStyle(element).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)');
    const pointerScreenshot = path.join(out, `terminal-unavailable-pointer-${coarse ? 'coarse' : 'fine'}-${width}.png`); await page.screenshot({ path: pointerScreenshot }); report.screenshots.push(pointerScreenshot);
  });
};
try {
  server = await createServer({ cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
  origin = httpOrigin.replace('http:', 'https:');
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  report.chromium = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.opened = []; window.open = (...args) => { window.opened.push(args); return null; };
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
      if (data.action === 'edit') {
        const rows = site === 'a' ? nodes : otherNodes, index = rows.findIndex(row => row.id === data.id);
        assert.ok(index >= 0, 'fixture edit must refer to an existing real node');
        rows[index] = { ...rows[index], ...data };
        return route.fulfill({ json: { success: true } });
      }
      if (data.action === 'delete') {
        if (site === 'a') nodes = nodes.filter(row => row.id !== data.id);
        else otherNodes = otherNodes.filter(row => row.id !== data.id);
        return route.fulfill({ json: { success: true } });
      }
      if (data.action === 'terminal_status') return route.fulfill({ json: { nodes: Object.fromEntries((data.serverIds || []).map(id => [id, id === 'node-2' ? { enabled: false, localEnabled: false, state: 'local_disabled' } : { enabled: true, localEnabled: true, state: 'ready' }])) } });
      return route.fulfill({ json: {} });
    }
    if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
    // Preserve real terminal HTTPS capability checks; serve compiled local assets through the existing fixture transport.
    const assetPath = url.pathname === '/admin' ? '/test/fixtures/admin-ui/index.html' : url.pathname.replace(/^\/test\/fixtures\/admin-ui\/(?=flags\/|os-icons\/)/, '/');
    return route.fulfill({ response: await route.fetch({ url: httpOrigin + assetPath + url.search }) });
  };
  await context.route('**/*', intercept);
  page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => report.errors.push(error.stack));

  await check('two-line metadata retains reported product major version, independent Default/unassigned group and full OS search/edit', async () => {
    await load();
    for (const [id, os, group, full] of [['node-0', 'Ubuntu 24', 'Default', 'Ubuntu 24.04.3 LTS'], ['node-1', 'Windows Server 2025', 'Production', 'Windows Server 2025'], ['node-2', 'Unknown', 'Default', ''], ['node-3', 'MysteryOS', 'Production', 'MysteryOS 7.3 build 12'], ['node-4', 'Debian 13', 'Default', 'Debian GNU/Linux 13 (trixie)'], ['node-6', 'Linux', 'Default', 'Linux 6.8.0-101 generic build 42'], ['node-7', 'macOS 15', 'Production', 'macOS 15.2.1']]) {
      const row = page.locator(`[data-server-id="${id}"]`), first = row.locator('.server-info'), second = row.locator('.admin-node-metadata');
      assert.equal(await first.locator('.flag-img').count(), 1);
      assert.equal(await first.locator('.os-icon-img').count(), 0, 'OS image belongs only on second line');
      assert.equal(await second.locator('.os-icon-img').count(), 1);
      assert.equal((await second.innerText()).trim().split(/\s+/).join(' '), `${os} ${group}`);
      assert.equal(await second.locator('.admin-node-os').innerText(), os);
      assert.equal(await second.locator('.admin-node-group').innerText(), group, 'group is its own visible element even for Default/unassigned');
      assert.equal(await second.getAttribute('title'), full || 'Unknown');
      const a = await first.boundingBox(), b = await second.boundingBox(); assert.ok(b.y >= a.y + a.height - 1);
    }
    await page.locator('#tab-servers .admin-search input').fill('24.04.3'); assert.deepEqual(await ids(), ['node-0']);
    await page.locator('#tab-servers .admin-search input').fill('');
    await page.locator('[data-server-id="node-0"] .server-name-link').click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('dialog').locator('[name="edit_name"]').inputValue(), 'Node 1', 'existing name edit action still opens the right node');
    await page.keyboard.press('Escape');
  });
  await check('actual country badge follows name text flow after the existing flag, neutral outline only; missing/invalid stays absent', async () => {
    await load();
    for (const [id, country, flag] of [['node-0', 'HK', 'hk'], ['node-1', 'JP', 'jp'], ['node-2', '', 'xx'], ['node-3', '', 'xx'], ['node-4', 'GB', 'gb'], ['node-6', '', 'not-a-region'], ['node-7', 'TW', 'cn']]) {
      const row = page.locator(`[data-server-id="${id}"]`), badge = row.locator('.admin-country-code');
      assert.equal(await badge.count(), country ? 1 : 0);
      assert.ok((await row.locator('.flag-img').getAttribute('src')).endsWith(`flags/${flag}.svg`));
      if (country) {
        assert.equal(await badge.innerText(), country);
        const visual = await badge.evaluate(element => { const style = getComputedStyle(element); return { insideName: !!element.closest('.server-name-link'), background: style.backgroundColor, border: style.borderTopWidth, size: style.fontSize, height: element.getBoundingClientRect().height, position: style.position, preceding: [...element.parentNode.childNodes].slice(0, [...element.parentNode.childNodes].indexOf(element)).map(node => node.textContent).join('') }; });
        report.geometry.push({ kind: 'country-badge', id, ...visual });
        assert.equal(visual.insideName, true, 'badge is inline in name text flow, not a separately flexed side chip'); assert.equal(visual.background, 'rgba(0, 0, 0, 0)'); assert.equal(visual.border, '1px'); assert.equal(visual.size, '12px'); assert.ok(visual.height <= 24); assert.equal(visual.position, 'static'); assert.ok(visual.preceding.includes(nodes.find(node => node.id === id).name));
      }
    }
  });
  await check('existing extended-region flag assets remain independent of the two-letter country badge', async () => {
    await load({ count: 13 });
    for (const [index, flag] of [[8, 'sh-ac'], [9, 'sh-ta'], [10, 'gb-eng'], [11, 'gb-sct'], [12, 'gb-wls']]) {
      const row = page.locator(`[data-server-id="node-${index}"]`), image = row.locator('.flag-img');
      assert.ok((await image.getAttribute('src')).endsWith(`flags/${flag}.svg`), 'badge validator must not replace a supported flag with xx');
      await page.waitForFunction(id => { const img = document.querySelector(`[data-server-id="${id}"] .flag-img`); return img.complete && img.naturalWidth > 0; }, `node-${index}`);
      assert.equal(await row.locator('.admin-country-code').count(), 0, 'extended region does not fabricate a two-letter country');
    }
    const screenshot = path.join(out, 'extended-region-flags.png'); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
  });
  await check('node name slot follows latest compact 185-198px range without squeezing IP/status/actions or page overflow', async () => {
    await load(); const geometry = await page.evaluate(() => { const table = document.querySelector('.admin-node-table'), name = document.querySelector('[data-server-id="node-1"] .server-name-link'), slot = name.closest('.admin-node-name').lastElementChild; return { name: name.getBoundingClientRect().width, slot: slot.getBoundingClientRect().width, page: document.documentElement.scrollWidth, viewport: innerWidth, cell: table.querySelector('td').getBoundingClientRect().width, other: [...table.querySelectorAll('tbody tr:first-child td')].slice(1).map(cell => cell.getBoundingClientRect().width) }; });
    report.geometry.push({ kind: 'name-width', ...geometry }); assert.ok(geometry.slot >= 185 && geometry.slot <= 198, JSON.stringify(geometry)); assert.ok(geometry.name > 155); assert.ok(geometry.page <= geometry.viewport); assert.ok(geometry.other[0] >= 170); assert.ok(geometry.other.at(-1) >= 180);
  });
  await check('held grip lifts the opaque original row without activating, editing or saving; tap and cancel leave no ghost', async () => {
    for (const reducedMotion of ['no-preference', 'reduce']) for (const outcome of ['tap', 'cancel']) {
      await load({ reducedMotion }); const before = await ids(); await start();
      await page.waitForTimeout(180);
      const held = await page.locator('[data-server-id="node-0"]').evaluate(row => ({ lifted: row.hasAttribute('data-lifted'), active: row.hasAttribute('data-reordering'), opacity: getComputedStyle(row).opacity, shadow: getComputedStyle(row).boxShadow }));
      const screenshot = path.join(out, `held-${reducedMotion}-${outcome}.png`); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      assert.equal(held.lifted, true); assert.equal(held.active, false); assert.equal(held.opacity, '1'); assert.notEqual(held.shadow, 'none');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-server-reordering')), false);
      assert.deepEqual(await ids(), before); assert.equal(saves.length, 0); assert.equal(await page.getByRole('dialog').count(), 0);
      if (outcome === 'cancel') await page.keyboard.press('Escape');
      await page.mouse.up(); await page.waitForTimeout(180);
      assert.equal(await page.locator('[data-lifted], [data-reordering]').count(), 0);
      assert.equal(await page.locator('[data-server-id="node-0"]').evaluate(row => getComputedStyle(row).boxShadow), 'none');
      assert.equal(saves.length, 0); assert.equal(await page.getByRole('dialog').count(), 0);
    }
  });
  await check('fine pointer grip hover, hold and click have no local frame even after keyboard focus, while keyboard sorting keeps its visible focus', async () => {
    await load(); const before = await ids(), handle = page.locator('[data-server-id="node-0"] .drag-handle');
    await page.keyboard.press('Tab'); await handle.focus();
    assert.equal(await handle.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid'), true);
    await start(); await page.waitForTimeout(180);
    const appearance = async () => handle.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, border: style.borderTopStyle, outline: style.outlineStyle, shadow: style.boxShadow, focused: element === document.activeElement }; });
    const held = await appearance(); report.geometry.push({ kind: 'fine-grip-held', ...held });
    const screenshot = path.join(out, 'grip-fine-held.png'); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    assert.equal(held.background, 'rgba(0, 0, 0, 0)'); assert.equal(held.border, 'none'); assert.equal(held.outline, 'none'); assert.equal(held.shadow, 'none'); assert.equal(held.focused, true, 'pointer focus is retained, not forcibly blurred');
    await page.mouse.up(); const clicked = await appearance(); report.geometry.push({ kind: 'fine-grip-clicked', ...clicked });
    assert.equal(clicked.outline, 'none'); assert.equal(clicked.background, 'rgba(0, 0, 0, 0)'); assert.equal(clicked.border, 'none');
    assert.deepEqual(await ids(), before); assert.equal(saves.length, 0); assert.equal(await page.getByRole('dialog').count(), 0);
    await page.keyboard.press('ArrowDown'); await waitForTransport(() => saves.length === 1 && inFlight === 0);
    assert.equal(await handle.evaluate(element => element === document.activeElement && element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid'), true);
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert.equal(await handle.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid'), true);
  });
  await check('toolbar group single select supports keyboard, typeahead, selected check, Escape, outside and focus return', async () => {
    await load(); const trigger = page.locator('.admin-toolbar-group-trigger');
    await trigger.focus(); await page.keyboard.press('ArrowDown');
    await page.getByRole('listbox').waitFor();
    assert.equal(await page.getByRole('option', { name: 'All groups', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('p');
    assert.equal(await page.getByRole('option', { name: 'Production', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('r'); await page.keyboard.press('o');
    assert.equal(await page.getByRole('option', { name: 'Production', exact: true }).evaluate(element => element === document.activeElement), true, 'typeahead keeps matching the composed prefix');
    await page.keyboard.press('Enter');
    await page.getByRole('listbox').waitFor({ state: 'detached' }); assert.equal(await page.getByRole('listbox').count(), 0); assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.drag-handle:enabled').count(), 0); assert.ok((await ids()).length > 0);
    await trigger.click(); const selected = page.getByRole('option', { name: 'Production', exact: true });
    assert.equal(await selected.getAttribute('aria-selected'), 'true'); assert.equal(await selected.locator('svg').count(), 1);
    await page.keyboard.press('p');
    assert.equal(await page.getByRole('option', { name: makeNodes()[5].server_group, exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('p'); assert.equal(await selected.evaluate(element => element === document.activeElement), true, 'repeated letters cycle matching options');
    await page.keyboard.press('End'); await page.keyboard.press('Home');
    assert.equal(await page.getByRole('option', { name: 'All groups', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape'); await page.getByRole('listbox').waitFor({ state: 'detached' }); assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    assert.ok((await trigger.innerText()).includes('Production'), 'Escape does not commit keyboard preview');
    await trigger.click(); await page.waitForTimeout(220); const outside = await page.locator('#tab-servers .admin-search input').boundingBox(); await page.mouse.click(outside.x + 8, outside.y + outside.height / 2); await page.getByRole('listbox').waitFor({ state: 'detached' }); assert.equal(await page.getByRole('listbox').count(), 0);
    await trigger.click(); await page.keyboard.press('Tab'); await page.waitForTimeout(180); assert.equal(await page.getByRole('listbox').count(), 1);
    assert.equal(await selected.evaluate(element => element === document.activeElement), true, 'actual Tab traps focus on the current option');
    await page.keyboard.press('Escape'); await page.getByRole('listbox').waitFor({ state: 'detached' });
    await selectGroup('All groups'); assert.equal(await page.locator('.drag-handle:enabled').count(), 8);
    const search = page.locator('#tab-servers .admin-search input'); await search.fill('missing-node'); await search.press('Enter');
    assert.equal(await search.evaluate(el => el.type), 'text'); assert.equal(await search.getAttribute('type'), null); assert.equal(await search.getAttribute('inputmode'), null);
    assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await search.inputValue(), 'missing-node');
    assert.equal(await search.evaluate(element => { const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented; }), true, 'actual NodeSearch prevents Enter, including a composing key, without changing its value');
    assert.equal(await search.inputValue(), 'missing-node');
    await page.locator('.empty-state .btn').click(); assert.equal(await page.locator('.drag-handle:enabled').count(), 8);
    await selectGroup('Production'); await page.evaluate(() => { location.hash = '/admin?apiIndex=1'; }); await waitIds(['other-0', 'other-1', 'other-2']);
    assert.ok((await trigger.innerText()).includes('All groups')); assert.equal(await page.locator('.drag-handle:enabled').count(), 3);
  });
  await check('node toolbar has a left search glyph, matching input/trigger/button geometry and visible focus ring', async () => {
    await load();
    const geometry = await page.locator('.admin-search').evaluate(root => {
      const input = root.querySelector('input'), glyph = root.querySelector('svg'), a = root.getBoundingClientRect(), b = glyph.getBoundingClientRect(), style = getComputedStyle(input);
      return { glyphLeft: b.left - a.left, glyphWidth: b.width, padding: style.paddingLeft, height: input.offsetHeight, radius: style.borderRadius, size: style.fontSize };
    });
    report.geometry.push({ kind: 'search-reference', ...geometry });
    assert.ok(Math.abs(geometry.glyphLeft - 10) < 1); assert.equal(geometry.glyphWidth, 16); assert.equal(geometry.padding, '32px');
    assert.equal(geometry.height, 36); assert.equal(geometry.radius, '8px'); assert.equal(geometry.size, '14px');
    await page.keyboard.press('Tab'); await page.locator('#tab-servers .admin-search input').focus();
    assert.equal(await page.locator('#tab-servers .admin-search input').evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).boxShadow !== 'none'), true);
  });
  await check('actual scalar trigger typeahead stays closed, Space respects the one-second prefix and mouse release selects once', async () => {
    await load(); const trigger = page.locator('.admin-toolbar-group-trigger'), menu = page.getByRole('listbox');
    await trigger.focus(); await page.keyboard.press('p');
    assert.equal(await menu.count(), 0); assert.ok((await trigger.innerText()).includes('Production'));
    assert.equal(await page.locator('.drag-handle:enabled').count(), 0);
    await page.keyboard.press('ArrowDown'); await menu.waitFor(); await page.waitForTimeout(220);
    await page.keyboard.press('Home'); await page.keyboard.press('p'); await page.keyboard.press(' ');
    assert.equal(await menu.count(), 1, 'Space extends an active typeahead prefix instead of selecting');
    await page.keyboard.press('Tab'); await page.waitForTimeout(180); assert.equal(await menu.count(), 1);
    await page.waitForTimeout(1100); await page.keyboard.press(' '); await menu.waitFor({ state: 'detached' });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await selectGroup('All groups'); await menu.waitFor({ state: 'detached' });
    const rect = await trigger.boundingBox(); await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
    await menu.waitFor(); await page.waitForTimeout(220);
    const option = page.getByRole('option', { name: 'Production', exact: true }), box = await option.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.up(); await menu.waitFor({ state: 'detached' });
    assert.ok((await trigger.innerText()).includes('Production')); assert.equal(saves.length, 0, 'group selection never writes order');
  });
  await check('actual scroll-button menu retains viewport identity, last-option focus and lifecycle cleanup across site changes', async () => {
    await load({ count: 50, uniqueGroups: true }); const trigger = page.locator('.admin-toolbar-group-trigger'); await trigger.click(); await page.waitForTimeout(220);
    const menu = page.getByRole('listbox'), port = menu.locator('.admin-toolbar-group-viewport');
    await port.evaluate(el => { window.toolbarViewport = el; });
    await page.keyboard.press('End'); await page.waitForTimeout(60);
    assert.equal(await menu.getByRole('option', { name: 'Group 49', exact: true }).evaluate(el => el === document.activeElement), true);
    assert.equal(await port.evaluate(el => el === window.toolbarViewport && el.isConnected), true, 'scroll arrows do not move or replace the focused viewport');
    await page.keyboard.press('Home'); await page.waitForTimeout(60);
    const before = await port.evaluate(el => el.scrollTop); await menu.locator('.admin-toolbar-group-scroll').last().hover(); await page.waitForTimeout(120); await page.mouse.move(1, 1);
    assert.ok(await port.evaluate(el => el.scrollTop) > before, 'the visible down arrow really scrolls options');
    const geometry = await menu.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight })); report.geometry.push({ kind: 'toolbar-actual-scroll-menu', ...geometry });
    assert.equal(geometry.width, 130); assert.ok(geometry.height > 240, 'available viewport, not an invented 240px cap, bounds a long ordinary menu');
    await page.evaluate(() => { location.hash = '/admin?apiIndex=1'; }); await waitIds(['other-0', 'other-1', 'other-2']); await menu.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.drag-handle:enabled').count(), 3); assert.equal(saves.length, 0);
    assert.equal(await page.evaluate(() => document.body.style.pointerEvents), '', 'site replacement releases the select modal ownership');
  });
  await check('listbox root arrow boundaries and conditional mouse-item leave match actual select without clearing keyboard or touch focus', async () => {
    await load({ count: 50, uniqueGroups: true }); await page.locator('.admin-toolbar-group-trigger').click(); await page.waitForTimeout(220);
    const menu = page.getByRole('listbox'), first = menu.getByRole('option', { name: 'All groups', exact: true }), last = menu.getByRole('option', { name: 'Group 49', exact: true });
    await menu.locator('.admin-toolbar-group-scroll').last().hover(); await page.waitForTimeout(65); await page.mouse.move(1, 1);
    assert.equal(await menu.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowUp'); assert.equal(await last.evaluate(el => el === document.activeElement), true, 'root ArrowUp chooses CF last, not a fabricated reference option');
    await page.keyboard.press('ArrowDown'); assert.equal(await last.evaluate(el => el === document.activeElement), true, 'last ArrowDown stays last');
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowUp'); assert.equal(await first.evaluate(el => el === document.activeElement), true, 'first ArrowUp stays first');
    await menu.evaluate(el => el.focus({ preventScroll: true })); await page.keyboard.press('ArrowDown'); assert.equal(await first.evaluate(el => el === document.activeElement), true, 'root ArrowDown chooses first');
    const option = menu.getByRole('option', { name: 'Group 03', exact: true }); await option.hover(); const box = await menu.boundingBox();
    await page.mouse.move(box.x + 2, box.y + 2); assert.equal(await menu.evaluate(el => el === document.activeElement), true, 'mouse leaves hovered item to padding with no stuck highlight');
    await option.hover(); await page.keyboard.press('Home'); await page.mouse.move(box.x + 2, box.y + 2);
    assert.equal(await first.evaluate(el => el === document.activeElement), true, 'leaving a non-focused hovered item preserves keyboard first');
    assert.equal(await first.evaluate(el => { el.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch' })); return el === document.activeElement; }), true, 'touch leave behavior is unchanged');
    await page.keyboard.press('End'); assert.equal(await last.evaluate(el => el === document.activeElement), true); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    assert.equal(saves.length, 0); assert.equal(await page.evaluate(() => document.body.style.pointerEvents), '');
  });
  await check('actual select modal blocks outside wheel/actions through leave, restores ownership and does not fight CF dialog focus', async () => {
    await load({ count: 50, uniqueGroups: true }); const trigger = page.locator('.admin-toolbar-group-trigger'), menu = page.getByRole('listbox'), group = page.locator('#tab-servers .toolbar > button').first();
    await trigger.click(); await page.waitForTimeout(220);
    assert.equal(await page.evaluate(() => document.body.style.pointerEvents), 'none');
    assert.equal(await page.locator('.table-wrapper').getAttribute('aria-hidden'), 'true', 'background metadata is hidden only from modal accessibility browsing, not removed');
    const before = await page.evaluate(() => scrollY); await page.mouse.move(2, 850); await page.mouse.wheel(0, 200); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => scrollY), before); assert.equal(await menu.count(), 1);
    const box = await group.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.getByRole('dialog').count(), 0, 'first outside pointer only dismisses the modal select');
    assert.equal(await page.evaluate(() => document.body.style.pointerEvents), 'none', 'pointer shielding stays owned through the actual leave');
    await page.waitForTimeout(50); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.getByRole('dialog').count(), 0, 'another pointer during leave cannot open a competing dialog');
    await menu.waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => document.body.style.pointerEvents), '');
    assert.equal(await page.locator('.table-wrapper').getAttribute('aria-hidden'), null, 'accepted metadata accessibility is restored when the select closes');
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await group.click(); const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true); await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    await trigger.click(); await page.waitForTimeout(220); await group.evaluate(el => el.click()); await dialog.waitFor(); await menu.waitFor({ state: 'detached' });
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'programmatic CF dialog opening takes focus ownership rather than competing traps');
    assert.equal(await page.evaluate(() => document.body.style.pointerEvents), ''); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    await trigger.click(); await page.waitForTimeout(220); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await menu.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.body.style.pointerEvents), ''); assert.equal(saves.length, 0);
  });
  await check('renaming or deleting the last node of the selected group resets stale filtering without erasing search', async () => {
    for (const outcome of ['rename', 'delete']) {
      await load(); const group = makeNodes()[5].server_group, search = page.locator('#tab-servers .admin-search input');
      await search.fill('Node 6'); await selectGroup(group); assert.deepEqual(await ids(), ['node-5']);
      const row = page.locator('[data-server-id="node-5"]');
      await row.locator(outcome === 'rename' ? '.action-btns [data-reference-icon="pencil"]' : '.btn-red').click();
      const dialog = page.getByRole('dialog');
      const titleId = await dialog.getAttribute('aria-labelledby');
      if (outcome === 'rename') await dialog.locator('[name="edit_server_group"]').fill('Renamed group');
      await dialog.locator(outcome === 'rename' ? 'footer .btn-primary' : 'footer .btn-red').click(); await page.locator(`[aria-labelledby="${titleId}"]`).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('.admin-toolbar-group-trigger')?.textContent.includes('All groups'));
      await page.keyboard.press('Escape');
      assert.equal(await search.inputValue(), 'Node 6', 'group refresh does not clear a separate search');
      await search.fill(''); assert.equal(await page.locator('.drag-handle:enabled').count(), outcome === 'rename' ? 8 : 7);
      await page.locator('.admin-toolbar-group-trigger').click();
      assert.equal(await page.getByRole('option', { name: group, exact: true }).count(), 0);
      if (outcome === 'rename') assert.equal(await page.getByRole('option', { name: 'Renamed group', exact: true }).count(), 1);
      await page.keyboard.press('Escape'); await page.getByRole('listbox').waitFor({ state: 'detached' });
    }
  });
  await check('real keyed row overlaps before half-short-row threshold, then displaces without boundary jitter in all height/direction pairs', async () => {
    for (const tallId of ['node-0', 'node-1']) for (const direction of ['down', 'up']) {
      await load(); await page.addStyleTag({ content: `.server-row[data-server-id="${tallId}"] .admin-node-name { min-height: 180px; }` });
      const before = await ids(), from = direction === 'down' ? 0 : 1, targetId = direction === 'down' ? 'node-1' : 'node-0', draggedId = `node-${from}`;
      const dragged = page.locator(`[data-server-id="${draggedId}"]`), target = page.locator(`[data-server-id="${targetId}"]`);
      await dragged.evaluate(row => { window.originalDraggedRow = row; });
      const a = await dragged.boundingBox(), b = await target.boundingBox(), shorter = Math.min(a.height, b.height), sign = direction === 'down' ? 1 : -1, p = await start(from);
      const initialLayoutTop = await dragged.evaluate(row => row.offsetTop);
      const delta = direction === 'down' ? b.y - a.y - a.height : b.y + b.height - a.y;
      const beforeY = p.y + delta + sign * shorter * .3, afterY = p.y + delta + sign * (shorter * .5 + .25);
      await page.mouse.move(p.x, beforeY);
      const visual = await dragged.boundingBox(), overlap = Math.min(visual.y + visual.height, b.y + b.height) - Math.max(visual.y, b.y);
      report.geometry.push({ kind: 'overlap-before', direction, tallId, a, b, visual, overlap, shorter, pointer: beforeY });
      assert.ok(overlap > shorter * .2 && overlap < shorter * .5, JSON.stringify({ overlap, shorter, visual, a, b }));
      assert.ok(Math.abs(visual.y - (a.y + beforeY - p.y)) < 2, 'real row tracks pointer before displacement');
      assert.deepEqual(await ids(), before); assert.equal(saves.length, 0);
      const screenshot = path.join(out, `overlap-${tallId}-${direction}.png`); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      // A loud adjacent-cell background reveals alpha blending/paint-order failures in every column, including actions.
      await target.locator('td').evaluateAll(cells => cells.forEach(cell => { cell.style.backgroundColor = 'rgb(230, 0, 126)'; }));
      const occlusion = await dragged.evaluate((row, targetId) => {
        const a = row.getBoundingClientRect(), b = document.querySelector(`[data-server-id="${targetId}"]`).getBoundingClientRect();
        const y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
        const cleanY = a.top < b.top ? a.top + 16 : a.bottom - 16;
        return [...row.cells].filter(cell => cell.getBoundingClientRect().width > 0).map(cell => {
          const x = cell.getBoundingClientRect().right - 4;
          return { x, y, cleanY, hit: document.elementFromPoint(x, y)?.closest('.server-row')?.dataset.serverId, expected: row.dataset.serverId };
        });
      }, targetId);
      const paintPath = path.join(out, `occlusion-${tallId}-${direction}.png`), image = PNG.sync.read(await page.screenshot({ path: paintPath })); report.screenshots.push(paintPath);
      const pixel = (x, y) => [...image.data.subarray((Math.floor(y) * image.width + Math.floor(x)) * 4, (Math.floor(y) * image.width + Math.floor(x)) * 4 + 3)];
      const samples = occlusion.map(sample => ({ ...sample, paint: pixel(sample.x, sample.y), cleanPaint: pixel(sample.x, sample.cleanY) }));
      report.geometry.push({ kind: 'actual-occlusion', direction, tallId, samples });
      for (const sample of samples) { assert.equal(sample.hit, draggedId, 'active real row must own the actual intersection in every cell'); assert.deepEqual(sample.paint, sample.cleanPaint, 'opaque active cell must hide the neighboring marker, not blend through it'); }
      await page.mouse.move(p.x, afterY); const next = ['node-1', 'node-0', ...before.slice(2)]; await waitIds(next);
      for (let i = 0; i < 8; i++) await page.mouse.move(p.x, afterY + (i % 2 ? 1 : -1));
      assert.deepEqual(await ids(), next); assert.equal(saves.length, 0);
      const shifted = await dragged.boundingBox();
      report.geometry.push({ kind: 'overlap-after-threshold-jitter', direction, tallId, shorter, thresholdCoverage: shorter * .5 + .25, visual: shifted, pointer: afterY + 1, order: await ids() });
      assert.ok(Math.abs(shifted.y - (a.y + afterY - p.y + 1)) < 3, 'Vue layout changes do not jump the tracking row');
      assert.equal(await dragged.evaluate(row => row === window.originalDraggedRow), true, 'drag uses the original keyed row, not a clone');
      assert.equal(await dragged.evaluate(row => row.getAnimations().some(animation => animation.id === 'server-slide')), false, 'active tracking does not compete with 150ms FLIP');
      await page.keyboard.press('Escape'); await page.mouse.up(); await waitIds(before);
      await dragged.locator('.drag-handle').hover();
      assert.equal(await dragged.evaluate(row => row.style.transform), '', 'cancel restores inline tracking transform');
      assert.equal(await dragged.evaluate(row => row.offsetTop), initialLayoutTop, 'cancel restores layout even when browser scroll anchoring changes scrollY');
      assert.ok(await dragged.evaluate(row => Math.abs(row.getBoundingClientRect().top - row.offsetParent.getBoundingClientRect().top - row.offsetTop) < 2));
    }
  });

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
  for (const outcome of ['release', 'cancel']) for (const direction of ['down', 'up']) {
    await check(`${outcome}/${direction} below threshold keeps all seven cells opaque above neighbors throughout the real landing animation`, async () => {
      await load(); const from = direction === 'down' ? 0 : 1, id = `node-${from}`, targetId = `node-${1 - from}`, before = await ids();
      const row = page.locator(`[data-server-id="${id}"]`), target = page.locator(`[data-server-id="${targetId}"]`), a = await row.boundingBox(), b = await target.boundingBox();
      const p = await start(from), distance = Math.min(a.height, b.height) * .3;
      await page.mouse.move(p.x, p.y + (direction === 'down' ? distance : -distance)); await page.waitForTimeout(170);
      assert.deepEqual(await ids(), before); assert.equal(saves.length, 0);
      await target.locator('td').evaluateAll(cells => cells.forEach(cell => { cell.style.backgroundColor = 'rgb(230, 0, 126)'; }));
      await page.evaluate(({ id, targetId, outcome }) => {
        const row = document.querySelector(`[data-server-id="${id}"]`), target = document.querySelector(`[data-server-id="${targetId}"]`);
        window.landingSamples = []; window.landingDone = false; window.landingPixelReady = false;
        const sample = () => {
          const a = row.getBoundingClientRect(), b = target.getBoundingClientRect(), overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top), y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
          window.landingSamples.push({ at: performance.now(), overlap, lifted: row.hasAttribute('data-lifted'), settling: row.hasAttribute('data-settling'), z: getComputedStyle(row).zIndex, capture: row.parentElement.hasPointerCapture(window.dragPointerId), animation: row.getAnimations().map(animation => ({ id: animation.id, time: animation.currentTime, state: animation.playState })), cells: [...row.cells].filter(cell => cell.offsetWidth).map(cell => ({ x: cell.getBoundingClientRect().right - 16, y, hit: overlap > 0 ? document.elementFromPoint(cell.getBoundingClientRect().right - 16, y)?.closest('.server-row')?.dataset.serverId : null })) });
          const slide = row.getAnimations().find(animation => animation.id === 'server-slide');
          if (!window.landingPixelReady && slide?.currentTime >= 50 && overlap > 2) {
            window.landingPixelReady = true;
            const animations = row.getAnimations(); animations.forEach(animation => animation.pause());
            window.resumeLanding = () => { animations.forEach(animation => animation.play()); requestAnimationFrame(sample); };
          } else if (window.landingSamples.length < 16) requestAnimationFrame(sample); else window.landingDone = true;
        };
        document.addEventListener(outcome === 'release' ? 'pointerup' : 'keydown', () => requestAnimationFrame(sample), { once: true });
      }, { id, targetId, outcome });
      if (outcome === 'release') await page.mouse.up(); else { await page.keyboard.press('Escape'); await page.mouse.up(); }
      await page.waitForFunction(() => window.landingPixelReady);
      const pixelSample = await page.evaluate(() => window.landingSamples.at(-1)), screenshot = path.join(out, `landing-${outcome}-${direction}.png`);
      // Freeze only the sampled timeline for PNG evidence; never replace the real row or its paint styles.
      const image = PNG.sync.read(await page.screenshot({ path: screenshot, animations: 'allow' })); report.screenshots.push(screenshot);
      const paint = pixelSample.cells.map(cell => { const at = (Math.floor(cell.y) * image.width + Math.floor(cell.x)) * 4; return { ...cell, rgb: [...image.data.subarray(at, at + 3)] }; });
      await page.evaluate(() => window.resumeLanding());
      await page.waitForFunction(() => window.landingDone);
      const samples = await page.evaluate(() => window.landingSamples);
      report.geometry.push({ kind: 'landing-occlusion', outcome, direction, id, samples, paint, imageSize: { width: image.width, height: image.height } });
      const intersecting = samples.filter(sample => sample.overlap > .5);
      assert.ok(intersecting.length >= 3, 'several real frames must intersect before the row lands');
      assert.ok(intersecting.some(sample => sample.animation.some(animation => animation.id === 'server-slide' && animation.time >= 30)), 'test must observe mid-animation, not only release');
      for (const sample of intersecting) {
        assert.equal(sample.cells.length, 7); assert.equal(sample.capture, false, 'paint settling cannot retain pointer capture'); assert.equal(sample.lifted, false);
        for (const cell of sample.cells) assert.equal(cell.hit, id, `${outcome}/${direction}: every intersecting cell must paint above its neighbor until landing finishes`);
      }
      for (const cell of paint) assert.deepEqual(cell.rgb, [255, 255, 255], 'mid-landing opaque cells hide the neighbor marker instead of blending through it');
      await page.waitForFunction(id => { const row = document.querySelector(`[data-server-id="${id}"]`); return !row.hasAttribute('data-settling') && !row.getAnimations().length; }, id);
      assert.equal(await row.evaluate(row => row.hasAttribute('data-settling') || row.hasAttribute('data-lifted')), false);
      assert.equal(await row.evaluate(row => getComputedStyle(row).zIndex), '1'); assert.equal(await row.evaluate(row => getComputedStyle(row).boxShadow), 'none');
      assert.deepEqual(await ids(), before); assert.equal(saves.length, 0);
    });
  }
  await check('settling paint belongs to its animation and cannot outlive cancellation, a new drag, changed site, removed rows or reduced motion', async () => {
    for (const outcome of ['animation-cancel', 'second-drag', 'site', 'removed-row', 'unmount', 'reduced']) {
      await load({ reducedMotion: outcome === 'reduced' ? 'reduce' : 'no-preference' });
      const p = await start(), row = page.locator('[data-server-id="node-0"]'), a = await row.boundingBox();
      await page.mouse.move(p.x, p.y + a.height * .3); await page.waitForTimeout(170); await page.mouse.up();
      if (outcome === 'reduced') {
        assert.equal(await page.locator('[data-settling], [data-lifted]').count(), 0);
        assert.equal(await row.evaluate(row => row.getAnimations().length), 0);
      } else {
        await page.waitForFunction(() => document.querySelector('[data-server-id="node-0"]').getAnimations().some(animation => animation.id === 'server-slide'));
        if (outcome === 'animation-cancel') {
          await row.evaluate(row => row.getAnimations().forEach(animation => animation.cancel()));
        } else if (outcome === 'second-drag') {
          const box = await row.locator('.drag-handle').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
          await page.mouse.move(x, y); await page.mouse.down();
          assert.equal(await row.evaluate(row => row.hasAttribute('data-lifted') && row.parentElement.hasPointerCapture(window.dragPointerId)), true, 'new drag is accepted while the previous row settles');
          await page.mouse.move(x + 8, y); await page.waitForTimeout(180);
          assert.equal(await row.evaluate(row => row.hasAttribute('data-lifted') && !row.hasAttribute('data-settling')), true, 'old animation completion cannot clear new lift');
          await page.keyboard.press('Escape'); await page.mouse.up();
        } else if (outcome === 'site') {
          await page.evaluate(() => { location.hash = '/admin?apiIndex=1'; }); await waitIds(['other-0', 'other-1', 'other-2']);
        } else if (outcome === 'removed-row') {
          await row.evaluate(row => { window.oldLandingRow = row; row.getAnimations().forEach(animation => animation.pause()); });
          nodes = nodes.slice(1);
          await page.locator('#tab-servers .toolbar > .btn').first().click(); await page.getByRole('dialog').locator('summary').click();
          await page.getByRole('dialog').getByRole('button', { name: 'Refresh cache', exact: true }).click(); await row.waitFor({ state: 'detached' });
          assert.equal(await page.evaluate(() => window.oldLandingRow.hasAttribute('data-settling')), false);
        } else {
          await page.evaluate(() => { window.oldLandingRow = document.querySelector('[data-server-id="node-0"]'); location.hash = '/fixture'; });
          await page.waitForFunction(() => !document.querySelector('.server-row'));
          assert.equal(await page.evaluate(() => window.oldLandingRow.hasAttribute('data-settling')), false);
        }
        await page.waitForFunction(() => !document.querySelector('[data-settling], [data-lifted]'));
      }
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-server-reordering')), false);
      assert.equal(saves.length, 0);
    }
  });
  await check('Escape, pointercancel, outside release and missed release restore the original order without saving', async () => {
    for (const cancel of ['Escape', 'pointercancel', 'outside', 'buttons-zero', 'blur', 'lostcapture']) {
      await load(); const before = await ids(); await start(); await moveTo(2);
      await page.waitForFunction(() => document.querySelector('tbody .server-row')?.dataset.serverId !== 'node-0');
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else if (cancel === 'outside') { await page.mouse.move(5, 5); await page.mouse.up(); }
      else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (cancel === 'lostcapture') {
        await page.locator('tbody').evaluate(body => body.releasePointerCapture(window.dragPointerId));
        await page.mouse.move(dragStart.x + 1, dragStart.y);
      }
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
      const p = await start(from), near = direction === 'down' ? p.y + short.height * .3 : p.y - short.height * .3;
      const across = direction === 'down' ? p.y + short.height * .55 : p.y - short.height * .55;
      await page.mouse.move(p.x, near); await page.waitForTimeout(80); assert.deepEqual(await ids(), before);
      await page.mouse.move(p.x, across);
      const next = direction === 'down' ? ['node-1', 'node-0', ...before.slice(2)] : ['node-0', 'node-2', 'node-1', ...before.slice(3)];
      await waitIds(next);
      for (let i = 0; i < 8; i++) { await page.mouse.move(p.x, across + (i % 2)); await page.waitForTimeout(20); }
      assert.deepEqual(await ids(), next); assert.equal(saves.length, 0);
      assert.equal((await page.locator('.server-row[data-server-id="node-1"]').boundingBox()).height, tall.height, 'tall node keeps its intrinsic height after displacement');
      assert.equal(await page.locator(`.server-row[data-server-id="node-${from}"]`).evaluate(row => row.offsetHeight), Math.round(short.height), 'tracking transforms cannot change the intrinsic short-row height');
      await page.keyboard.press('Escape'); await page.mouse.up(); await waitIds(before);
    }
  });
  await check('continuous real-row drag reverses deliberately, snaps on release and reduced motion keeps tracking without FLIP', async () => {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await load({ reducedMotion }); const before = await ids(), p = await start();
      await moveTo(3); await waitIds(['node-1', 'node-2', 'node-3', 'node-0', ...before.slice(4)]);
      await page.mouse.move(p.x, p.y); await waitIds(before); assert.equal(saves.length, 0, 'continuous reversal is preview-only');
      const visual = await page.locator('[data-server-id="node-0"]').boundingBox();
      assert.ok(Math.abs(visual.y + dragStart.grab - p.y) < 2);
      await moveTo(2); const next = ['node-1', 'node-2', 'node-0', ...before.slice(3)]; await waitIds(next);
      assert.equal(saves.length, 0);
      if (reducedMotion === 'reduce') assert.equal(await page.locator('tbody').evaluate(body => [...body.rows].flatMap(row => row.getAnimations()).length), 0);
      await page.mouse.up(); await waitForTransport(() => saves.length === 1 && inFlight === 0); await waitIds(next);
      const row = page.locator('[data-server-id="node-0"]'); await row.locator('.drag-handle').hover();
      assert.equal(await row.evaluate(row => row.style.transform), '');
      assert.ok(await row.evaluate(row => Math.abs(row.getBoundingClientRect().top - row.offsetParent.getBoundingClientRect().top - row.offsetTop) < 2));
    }
  });
  await check('200 nodes edge-scroll with a stationary pointer and bounded transform-only displacement', async () => {
    await load({ count: 200 }); const before = await ids(), p = await start();
    await page.evaluate(() => { window.frameGaps = []; let previous = performance.now(); const measure = now => { window.frameGaps.push(now - previous); previous = now; if (window.frameGaps.length < 120) requestAnimationFrame(measure); }; requestAnimationFrame(measure); });
    await page.mouse.move(p.x, 895); await page.waitForFunction(() => window.scrollY > 40);
    await page.waitForTimeout(700);
    assert.equal((await ids()).length, 200); assert.notDeepEqual(await ids(), before); assert.equal(saves.length, 0);
    const metrics = await page.evaluate(() => ({ scrollY, draggedTop: document.querySelector('[data-reordering]').getBoundingClientRect().top, maxFrameMs: Math.max(...window.frameGaps), frames: window.frameGaps.length, animated: [...document.querySelectorAll('tbody tr')].flatMap(row => row.getAnimations()).map(animation => animation.effect.getKeyframes().map(frame => Object.keys(frame))) }));
    report.performance = metrics; assert.ok(metrics.frames >= 10); assert.ok(metrics.scrollY > 100);
    assert.ok(Math.abs(metrics.draggedTop + dragStart.grab - 895) < 2, 'stationary pointer tracking compensates page edge scroll');
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
    await page.locator('#tab-servers .admin-search input').fill('Node 1'); assert.equal(await page.locator('.drag-handle:enabled').count(), 0);
    await page.locator('#tab-servers .admin-search input').fill(''); await selectGroup('Production'); assert.equal(await page.locator('.drag-handle:enabled').count(), 0);
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
  await terminalReturnChecks(false);
  await check('preserved table/font/row/buttons with exact toolbar in 1440/320/360/390 light/dark zh/en/ja overflow matrix', async () => {
    for (const width of [1440, 320, 360, 390]) for (const locale of ['zh', 'en', 'ja']) for (const dark of [false, true]) {
      if (width === 320 && locale === 'zh' && !dark) {
        await page.close();
        context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
        await context.route('**/*', intercept);
        await context.addInitScript(() => { window.opened = []; window.open = (...args) => { window.opened.push(args); return null; }; document.addEventListener('pointerdown', event => { window.dragPointerId = event.pointerId; }); });
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
      assert.equal(geometry.font, 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"', 'previously accepted table font remains unchanged');
      assert.equal(geometry.toolbarFont, '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'); assert.equal(geometry.toolbarLine, '20px');
      assert.ok(geometry.nameWidth >= 96, 'flag/OS assets must not squeeze the name below the reference 6rem slot');
      const metadata = await page.locator('[data-server-id="node-5"] .admin-node-metadata').evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, text: element.innerText, nameSize: getComputedStyle(element.parentElement.querySelector('.server-name-link')).fontSize }));
      assert.ok(metadata.scroll <= metadata.width + 1, 'long group wraps inside node metadata, not by shrinking the name'); assert.equal(metadata.nameSize, '14px'); assert.ok(metadata.text.includes('long-unbroken-group-name'));
      const group = await page.locator('[data-server-id="node-5"] .admin-node-group').boundingBox(); assert.ok(group.width > 0 && group.height > 0);
      assert.equal(await page.locator('[data-server-id="node-5"] .admin-node-os').innerText(), 'Alibaba Cloud Linux 3');
      assert.equal(await page.locator('[data-server-id="node-2"] .admin-node-group').innerText(), { zh: '\u9ed8\u8ba4', en: 'Default', ja: '\u30c7\u30d5\u30a9\u30eb\u30c8' }[locale]);
      assert.equal(await page.locator('[data-server-id="node-1"] .server-name-link').evaluate(element => { const text = element.firstChild, range = document.createRange(); range.setStart(text, text.textContent.trimEnd().lastIndexOf('name')); range.setEnd(text, text.textContent.trimEnd().length); const word = range.getBoundingClientRect(), badge = element.querySelector('.admin-country-code').getBoundingClientRect(); return Math.abs(word.top - badge.top) <= 4; }), true, 'country badge follows the final name word rather than a separate width-consuming side slot');
      const buttonSize = geometry.coarse ? 44 : 36;
      assert.deepEqual(geometry.button, { width: buttonSize, height: buttonSize }); assert.equal(geometry.padding, '8px');
      assert.equal(geometry.coarse, width < 640);
      const toolbar = await page.locator('#tab-servers .toolbar').evaluate(element => {
        const input = element.querySelector('input'), trigger = element.querySelector('.admin-toolbar-group-trigger'), filter = element.querySelector('.admin-filter-group').getBoundingClientRect(), buttons = [...element.querySelectorAll(':scope > .btn')];
        return { inputSize: getComputedStyle(input).fontSize, inputWidth: input.getBoundingClientRect().width, triggerWidth: trigger.getBoundingClientRect().width, heights: [input, trigger, ...buttons].map(control => control.getBoundingClientRect().height), actionRows: new Set(buttons.map(control => Math.round(control.getBoundingClientRect().top))).size, filterBottom: filter.bottom, actionsTop: buttons[0].getBoundingClientRect().top, right: buttons.at(-1).getBoundingClientRect().right, edge: element.getBoundingClientRect().right };
      });
      report.geometry.push({ kind: 'toolbar-matrix', width, locale, dark, ...toolbar });
      assert.equal(toolbar.inputSize, width < 768 ? '16px' : '14px'); assert.ok(toolbar.inputWidth >= 100); assert.equal(toolbar.triggerWidth, 128);
      assert.ok(toolbar.heights.every(height => height === 36)); assert.ok(Math.abs(toolbar.right - toolbar.edge) < 1);
      if (locale === 'zh' && [360, 390].includes(width)) assert.equal(toolbar.actionRows, 1, 'accepted Chinese phone actions remain a single natural row');
      if (width < 640) assert.ok(toolbar.actionsTop >= toolbar.filterBottom + 8, 'small-screen actions follow the full-width filter row');
      await page.locator('.admin-toolbar-group-trigger').click();
      const menu = page.getByRole('listbox'), popup = await menu.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, scroll: element.scrollHeight, height: element.clientHeight, hit: element.contains(document.elementFromPoint(rect.left + 12, rect.top + 12)) };
      });
      report.geometry.push({ kind: 'popup-matrix', width, locale, dark, ...popup });
      assert.ok(popup.left >= 8 && popup.right <= width - 8); assert.ok(popup.top >= 8 && popup.bottom <= 892); assert.equal(popup.hit, true);
      const popupScreenshot = path.join(out, `group-${width}-${locale}-${dark ? 'dark' : 'light'}.png`); await page.screenshot({ path: popupScreenshot }); report.screenshots.push(popupScreenshot);
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
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
  await terminalReturnChecks(true);
  await terminalReturnChecks(true, 320);
  await check('native coarse grip touch hold and tap have no local frame or edit/save, and keyboard focus remains available afterwards', async () => {
    await load({ width: 390 }); const handle = page.locator('[data-server-id="node-0"] .drag-handle'), before = await ids(), cdp = await context.newCDPSession(page), p = await point(0);
    await page.keyboard.press('Tab'); await handle.focus();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] }); await page.waitForTimeout(180);
    const held = await handle.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, border: style.borderTopStyle, outline: style.outlineStyle, shadow: style.boxShadow }; });
    report.geometry.push({ kind: 'coarse-grip-held', ...held });
    const screenshot = path.join(out, 'grip-coarse-held.png'); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    assert.equal(held.background, 'rgba(0, 0, 0, 0)'); assert.equal(held.border, 'none'); assert.equal(held.outline, 'none'); assert.equal(held.shadow, 'none');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await handle.evaluate(element => getComputedStyle(element).outlineStyle), 'none'); assert.equal(saves.length, 0); assert.deepEqual(await ids(), before); assert.equal(await page.getByRole('dialog').count(), 0);
    await page.keyboard.press('ArrowDown'); await waitForTransport(() => saves.length === 1 && inFlight === 0);
    assert.equal(await handle.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid'), true); await cdp.detach();
  });
  await check('native coarse held row occludes its neighbor before displacement and touch cancel restores lift without a save', async () => {
    await load({ width: 390 }); const before = await ids(), cdp = await context.newCDPSession(page), p = await point(0);
    const dragged = page.locator('[data-server-id="node-0"]'), target = page.locator('[data-server-id="node-1"]'), a = await dragged.boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + a.height * .3 }] });
    await target.locator('td').evaluateAll(cells => cells.forEach(cell => { cell.style.backgroundColor = 'rgb(230, 0, 126)'; }));
    const sample = await dragged.evaluate(row => {
      const a = row.getBoundingClientRect(), b = document.querySelector('[data-server-id="node-1"]').getBoundingClientRect(), x = a.left + 4, y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
      return { x, y, overlap: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top), hit: document.elementFromPoint(x, y)?.closest('.server-row')?.dataset.serverId };
    });
    const screenshot = path.join(out, 'occlusion-native-coarse.png'), image = PNG.sync.read(await page.screenshot({ path: screenshot })); report.screenshots.push(screenshot);
    const at = (Math.floor(sample.y) * image.width + Math.floor(sample.x)) * 4, paint = [...image.data.subarray(at, at + 3)];
    report.geometry.push({ kind: 'native-coarse-occlusion', ...sample, paint });
    assert.ok(sample.overlap > 0); assert.equal(sample.hit, 'node-0'); assert.deepEqual(paint, [255, 255, 255]); assert.deepEqual(await ids(), before); assert.equal(saves.length, 0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await page.waitForTimeout(180);
    assert.equal(await page.locator('[data-lifted], [data-reordering]').count(), 0); assert.equal(saves.length, 0); assert.deepEqual(await ids(), before); await cdp.detach();
  });
  await check('coarse group menu scrolls long options within a 300px keyboard viewport, selects by touch and closes when its trigger scrolls away', async () => {
    await load({ count: 50, width: 320 }); await page.setViewportSize({ width: 320, height: 300 });
    const trigger = page.locator('.admin-toolbar-group-trigger'); await trigger.tap();
    const menu = page.getByRole('listbox'); await page.waitForTimeout(220); await page.keyboard.press('End');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await menu.evaluate(element => { const rect = element.getBoundingClientRect(), port = element.querySelector('.admin-toolbar-group-viewport'); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, scroll: port.scrollHeight, height: port.clientHeight, offset: port.scrollTop }; });
    report.geometry.push({ kind: 'keyboard-300-group', ...bounds });
    assert.ok(bounds.top >= 6 && bounds.bottom <= 294); assert.ok(bounds.left >= 10 && bounds.right <= 310); assert.ok(bounds.scroll > bounds.height && bounds.offset > 0);
    const long = page.getByRole('option', { name: makeNodes()[5].server_group, exact: true });
    assert.equal(await long.evaluate(element => element === document.activeElement), true);
    assert.equal(await long.evaluate(element => { const a = element.getBoundingClientRect(), b = element.parentElement.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom; }), true, 'the entire highlighted wrapped label scrolls into the popup');
    const screenshot = path.join(out, 'group-keyboard-300.png'); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    await long.tap(); await page.getByRole('listbox').waitFor({ state: 'detached' }); assert.equal(await page.getByRole('listbox').count(), 0); assert.ok((await trigger.innerText()).includes('Production-team'));
    assert.equal(await page.locator('.drag-handle:enabled').count(), 0);
    await trigger.tap(); await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForFunction(() => !document.querySelector('[role=listbox]'));
    await page.evaluate(() => window.scrollTo(0, 0)); await selectGroup('All groups'); assert.equal(await page.locator('.drag-handle:enabled').count(), 50);
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
  await check('native touch uses transparent browser tap highlight while keyboard focus and danger semantics remain', async () => {
    await load({ width: 390 });
    const cdp = await context.newCDPSession(page), name = page.locator('[data-server-id="node-0"] .server-name-link');
    const box = await name.boundingBox(), touchPoints = [{ x: box.x + 5, y: box.y + 5 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
    const computed = await page.evaluate(() => [...document.querySelectorAll('.admin-ui button, .admin-ui input, .admin-ui select, .admin-ui a')].slice(0, 60).map(element => ({ class: element.className, tap: getComputedStyle(element).webkitTapHighlightColor, outline: getComputedStyle(element).outline, active: element.matches(':active'), focusVisible: element.matches(':focus-visible'), color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor })));
    report.tapComputed = computed;
    const screenshot = path.join(out, 'native-touch-held.png'); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.ok(computed.every(item => item.tap === 'rgba(0, 0, 0, 0)'), JSON.stringify(computed));
    await page.keyboard.press('Tab'); await page.locator('[data-server-id="node-0"] .drag-handle').focus();
    const focus = await page.locator('[data-server-id="node-0"] .drag-handle').evaluate(element => ({ visible: element.matches(':focus-visible'), style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));
    report.keyboardFocus = focus; assert.equal(focus.visible, true); assert.equal(focus.style, 'solid'); assert.equal(focus.width, '2px');
    const danger = await page.locator('[data-server-id="node-0"] .btn-red').evaluate(element => getComputedStyle(element).color);
    assert.notEqual(danger, await name.evaluate(element => getComputedStyle(element).color));
    const focusScreenshot = path.join(out, 'keyboard-focus.png'); await page.screenshot({ path: focusScreenshot }); report.screenshots.push(focusScreenshot);
    await cdp.detach();
  });
  // The preceding real-touch matrix owns a mobile context with overlay viewport scrollbars.
  await context.close(); context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', intercept); page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => report.errors.push(error.stack));
  for (const dark of [false, true]) for (const width of [320, 360, 390, 1440]) await check(`page, navigation, table and group scrollbar paint/hit edges ${width} ${dark ? 'dark' : 'light'}`, async () => {
    await load({ count: 50, width, dark, uniqueGroups: true });
    const name = `${width}-${dark ? 'dark' : 'light'}`;
    await nativeScrollbar(page.locator('html'), 'y', `body-${name}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (width < 768) {
      const nav = page.locator('.admin-nav'); await nativeScrollbar(nav, 'x', `nav-${name}`);
      for (const end of [false, true]) {
        await page.keyboard.press('Tab'); await nav.locator('button').nth(end ? 8 : 0).focus();
        const edge = await nav.locator('button').nth(end ? 8 : 0).evaluate(el => {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const a = el.getBoundingClientRect(), port = el.parentElement, b = port.getBoundingClientRect(), css = getComputedStyle(el), ring = parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset);
          return { left: a.left - ring, right: a.right + ring, top: a.top - ring, bottom: a.bottom + ring, portLeft: b.left + port.clientLeft, portRight: b.left + port.clientLeft + port.clientWidth, portTop: b.top + port.clientTop, portBottom: b.top + port.clientTop + port.clientHeight };
        });
        report.geometry.push({ kind: 'navigation-focus-edge', name, end, ...edge });
        assert.ok(edge.left >= edge.portLeft - .75 && edge.right <= edge.portRight + .75 && edge.top >= edge.portTop - .75 && edge.bottom <= edge.portBottom + .75, JSON.stringify(edge));
      }
    }
    const table = page.locator('.table-wrapper').first(); await table.evaluate(el => el.scrollIntoView({ block: 'end' }));
    if (await table.evaluate(el => el.scrollWidth > el.clientWidth)) await nativeScrollbar(table, 'x', `table-${name}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    const trigger = page.locator('.admin-toolbar-group-trigger'); await trigger.click();
    const popup = page.getByRole('listbox'), port = popup.locator('.admin-toolbar-group-viewport'); await page.waitForTimeout(220);
    assert.equal(await port.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').display), 'none', 'actual SelectViewport hides native paint and uses its visible scroll buttons');
    assert.ok(await popup.locator('.admin-toolbar-group-scroll').evaluateAll(elements => elements.some(el => el.offsetHeight > 0)), 'overflowing options retain an actual scroll affordance');
    await page.keyboard.press('End');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await popup.locator('button').last().evaluate(el => el === document.activeElement), true);
    assert.equal(await popup.evaluate(el => el.offsetWidth), 130, 'actual ordinary popup is trigger128 plus viewport borders');
    const endpoint = await port.evaluate(el => {
      const last = el.lastElementChild.getBoundingClientRect(), r = el.getBoundingClientRect();
      return { scrollTop: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, paddingBottom: parseFloat(getComputedStyle(el).paddingBottom), lastTop: last.top, lastBottom: last.bottom, clientTop: r.top + el.clientTop, clientBottom: r.top + el.clientTop + el.clientHeight };
    });
    report.geometry.push({ kind: 'group-End-content-endpoint', name, ...endpoint });
    // scrollIntoView reaches the last option, not the trailing menu padding.
    assert.ok(endpoint.lastTop >= endpoint.clientTop - 1 && endpoint.lastBottom <= endpoint.clientBottom + 1, `complete last option is visible: ${JSON.stringify(endpoint)}`);
    assert.ok(endpoint.gap - endpoint.paddingBottom <= 1 && endpoint.lastBottom >= endpoint.clientBottom - endpoint.paddingBottom - 1, `End reaches the content endpoint: ${JSON.stringify(endpoint)}`);
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(saves.length, 0, 'scrolling never writes node order');
    const shot = path.join(out, `scrollbars-page-${name}.png`); await page.screenshot({ path: shot }); report.screenshots.push(shot);
  });
  await check('shared scrollbar paint never reaches the mounted public control or body', async () => {
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=public#/`);
    await page.locator('#public-control').waitFor();
    const css = await page.locator('#public-control input').evaluate(el => ({ admin: document.body.classList.contains('admin-ui-surface'), thumb: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundImage, border: getComputedStyle(el, '::-webkit-scrollbar-thumb').borderLeftWidth, token: getComputedStyle(el).getPropertyValue('--admin-scrollbar-paint') }));
    assert.deepEqual(css, { admin: false, thumb: 'none', border: '0px', token: '' });
    const shot = path.join(out, 'public-scope-unchanged.png'); await page.screenshot({ path: shot }); report.screenshots.push(shot);
  });
  assert.deepEqual(report.errors, [], 'no Vue/browser exceptions');
} catch (error) { report.errors.push(error.stack); }
finally {
  release(); await browser?.close(); await server?.close(); report.closed = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${out}`);
}
if (report.errors.length || report.checks.some(check => !check.pass)) process.exitCode = 1;
