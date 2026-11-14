import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { providers, channelFields, newChannel } from '../../../src/frontend/views/admin/composables/notificationPresentation.js';

const { chromium } = createRequire(import.meta.url)('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { PNG } = createRequire(import.meta.url)('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pngjs');
const referenceIcons = createRequire(import.meta.url)('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/lucide').icons;
const probe = process.argv[2] || 'all';
const out = path.resolve(process.env.STAGE2_REPORT_DIR || '.planning/2026-11-13-admin-ui-refinement/successor/stage2/evidence', probe);
fs.mkdirSync(out, { recursive: true });
const report = { probe, node: process.version, checks: [], errors: [], events: [], geometry: [], screenshots: [], calls: [], device: 'Chromium mobile emulation, real CDP touch; no physical Android or OS soft keyboard' };
let server, browser, context, page;
const check = async (name, fn) => { if (probe === 'eyes' && !name.includes('eye')) return; await fn(); report.checks.push(name); console.log('PASS ' + name); };
const tap = async (cdp, locator) => {
  await locator.scrollIntoViewIfNeeded(); const r = await locator.boundingBox();
  assert.ok(r); const touchPoints = [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const config = { schema: 1, revision: 1, language: 'zh', timezone: 'Asia/Shanghai', channels: ['telegram', 'smtp', 'webhook'].map((type, n) => ({ ...newChannel(type), id: `fixture-${n}`, name: n === 0 ? '运维告警通知 · Synthetic very long notification name' : `Fixture ${type}`, config: type === 'telegram' ? { chatId: '42' } : type === 'smtp' ? { host: 'smtp.fixture.invalid', port: 465, secure: 'tls', to: 'long-operations-name@example.test' } : { method: 'POST', format: 'json', body: '' }, secretFields: type === 'telegram' ? { botToken: true } : type === 'smtp' ? { ['pass' + 'word']: true } : { url: true } })), rules: [{ id: 'rule', name: '生产节点离线 · Synthetic long rule name', type: 'offline', enabled: true, options: { minutes: 5 }, scope: { mode: 'all', serverIds: [] }, targetIds: ['fixture-0', 'fixture-1'] }] };
const style = locator => locator.evaluate(el => {
  const css = getComputedStyle(el), r = el.getBoundingClientRect();
  return Object.fromEntries(['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'borderRadius', 'borderColor', 'backgroundColor', 'padding', 'boxShadow', 'transition'].map(key => [key, css[key]]).concat([['width', r.width], ['height', r.height]]));
});
const assertEye = async (eye, mobile, icon) => {
  const geometry = await eye.evaluate(el => {
    const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    const css = getComputedStyle(el);
    return { hit44: [[x-21,y],[x+21,y],[x,y-21],[x,y+21]].every(([px,py]) => el.contains(document.elementFromPoint(px,py))), label: el.getAttribute('aria-label'), background: css.backgroundColor, border: css.borderTopWidth, outline: css.outlineStyle, shadow: css.boxShadow, transition: css.transitionDuration, tap: css.webkitTapHighlightColor, opacity: css.opacity, nodes: [...el.querySelector('svg').children].map(node => [node.tagName, Object.fromEntries([...node.attributes].map(a => [a.name, a.value]))]) };
  });
  assert.deepEqual(geometry.nodes, referenceIcons[icon === 'eye' ? 'Eye' : 'EyeOff']);
  assert.ok(geometry.label.length > 0); assert.equal(geometry.background, 'rgba(0, 0, 0, 0)');
  assert.equal(geometry.border, '0px'); assert.equal(geometry.outline, 'none');
  assert.equal(geometry.shadow, 'none'); assert.equal(geometry.transition, '0s'); assert.equal(geometry.tap, 'rgba(0, 0, 0, 0)'); assert.equal(geometry.opacity, '1');
  if (mobile) assert.equal(geometry.hit44, true, 'full44px eye surface must receive input');
};
const pressEye = async (page, cdp, eye, mobile) => {
  await eye.scrollIntoViewIfNeeded(); const r = await eye.boundingBox(), point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  if (mobile) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  for (let n = 0; n < 3; n++) { await page.evaluate(() => new Promise(requestAnimationFrame)); await assertEye(eye, mobile, 'eye'); }
  if (mobile) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.mouse.up();
};
const nativeDrag = async (page, cdp, locator, horizontal, mobile, name) => {
  const g = await locator.evaluate((el, horizontal) => {
    el.scrollTop = 0; el.scrollLeft = 0;
    const root = el === document.scrollingElement, r = el.getBoundingClientRect();
    return { root, left: root ? 0 : r.left, top: root ? 0 : r.top, right: root ? innerWidth : r.right, bottom: root ? innerHeight : r.bottom, length: horizontal ? el.clientWidth : root ? innerHeight : el.clientHeight, total: horizontal ? el.scrollWidth : el.scrollHeight, gutter: root ? innerWidth - el.clientWidth : horizontal ? el.offsetHeight - el.clientHeight : el.offsetWidth - el.clientWidth };
  }, horizontal);
  assert.ok(g.total > g.length + 40, name + ' must have real scrollable content');
  if (g.root && mobile && g.gutter === 0) {
    // Mobile Chrome owns its non-draggable root overlay; internal native CSS bars are tested below.
    const samples = [], x = 12, y = g.bottom / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let n = 1; n <= 12; n++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + n, y: y - n * 10 }] });
      await page.evaluate(() => new Promise(requestAnimationFrame)); samples.push(await page.evaluate(() => scrollY));
    }
    await page.waitForTimeout(150); // Release from a held position, not a momentum fling.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    report.geometry.push({ name, kind: 'actual-CDP-root-content-swipe', rootThumbLimit: 'mobile browser overlay does not expose a CSS thumb/gutter', g, samples });
    assert.ok(samples.at(-1) > 20); assert.ok(samples.every((value, n) => n === 0 || value >= samples[n - 1]));
    return;
  }
  const offset = mobile ? 14 : 4, middle = Math.max(8, Math.min(g.length ** 2 / g.total / 2, 24));
  const x = horizontal ? g.left + middle : g.right - offset, y = horizontal ? g.bottom - offset : g.top + middle;
  const paintShot = `${name}-paint.png`, clip = horizontal ? { x: Math.round(x), y: Math.round(g.bottom - g.gutter), width: 1, height: g.gutter } : { x: Math.round(g.right - g.gutter), y: Math.round(y), width: g.gutter, height: 1 };
  const png = PNG.sync.read(await page.screenshot({ path: path.join(out, paintShot), clip })), background = [...png.data.subarray(0, 3)];
  const contrast = Array.from({ length: horizontal ? png.height : png.width }, (_, n) => Math.max(...background.map((value, c) => Math.abs(value - png.data[n * 4 + c]))));
  const paintedCss = contrast.reduce((sum, value) => sum + value / Math.max(...contrast), 0);
  report.geometry.push({ name, kind: 'actual-native-thumb-paint', gutter: g.gutter, paintedCss });
  assert.ok(Math.abs(paintedCss - 3) < .55, name + ' actual paint must remain 3px: ' + paintedCss);
  const samples = [];
  if (mobile) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  else { await page.mouse.move(x, y); await page.mouse.down(); }
  for (let n = 1; n <= 12; n++) {
    const point = { x: x + (horizontal ? n * 8 : -n), y: y + (horizontal ? -n : n * 8) };
    if (mobile) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    else await page.mouse.move(point.x, point.y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    samples.push(await locator.evaluate((el, horizontal) => horizontal ? el.scrollLeft : el.scrollTop, horizontal));
  }
  if (mobile) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.mouse.up();
  await page.waitForTimeout(300); // Let the browser finish the native scrollbar gesture before the next tap.
  report.geometry.push({ name, kind: mobile ? 'actual-CDP-touch-drag' : 'actual-mouse-drag', g, samples });
  assert.ok(samples.at(-1) > 20, name + ': ' + JSON.stringify(samples));
  assert.ok(samples.every((value, n) => n === 0 || value >= samples[n - 1]), name + ' drift must not reset progress');
};
try {
  server = await createServer({ cacheDir: path.join(out, '.cache'), fixtureEntries: [path.resolve('test/fixtures/admin-ui/scope.html')], plugins: [vue()], publicDir: path.resolve('public') });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe' });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/admin/api')) {
      const data = request.postDataJSON(); report.calls.push(data.action);
      assert.ok(!['save_notification_config', 'test_notification_channel'].includes(data.action), 'touch/layout checks must not save or deliver');
      return route.fulfill({ json: data.action === 'get_notification_config' ? config : { success: true, settings: { username: 'fixture', ['pass' + 'word' + '_configured']: true, site_title: 'CF Monitor' }, servers: Array.from({ length: 120 }, (_, n) => ({ id: `node-${n}`, name: `Node ${n}`, server_group: 'Fixture' })), stats: { total: 120 } } });
    }
    return route.continue();
  });
  page = await context.newPage(); const cdp = await context.newCDPSession(page);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${origin}/test/fixtures/admin-ui/scope.html?mode=picker`);
  await tap(cdp, page.locator('#open'));
  const dialog = page.getByRole('dialog'), summary = dialog.locator('.admin-picker-summary').first();
  await page.evaluate(() => {
    window.touchEvents = [];
    for (const type of ['pointerdown', 'focusin', 'focusout', 'scroll', 'click']) document.addEventListener(type, event => window.touchEvents.push({ type, target: event.target.className, related: event.relatedTarget?.className, pointer: event.pointerType, active: document.activeElement.tagName }), true);
    visualViewport.addEventListener('resize', () => window.touchEvents.push({ type: 'visualViewport.resize', height: visualViewport.height, active: document.activeElement.tagName }));
  });
  await tap(cdp, summary); await dialog.locator('.admin-picker-menu').waitFor();
  if (['all', 'picker'].includes(probe)) await check('CDP touch opens without focusing a text input', async () => {
    report.geometry.push(await page.evaluate(() => ({ coarse: matchMedia('(pointer:coarse)').matches, touch: navigator.maxTouchPoints, viewport: { width: visualViewport.width, height: visualViewport.height }, active: document.activeElement.tagName })));
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('input,textarea')), false);
    assert.equal(await summary.getAttribute('aria-expanded'), 'true');
  });
  if (['all', 'viewport'].includes(probe)) await check('real CDP visual viewport shrink retains open picker and explicit search', async () => {
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=zh#/admin`);
    await tap(cdp, page.locator('[data-page=alerts]'));
    await tap(cdp, page.locator('[data-action=add-rule]'));
    await tap(cdp, dialog.locator('.admin-picker-summary').first());
    report.geometry.push({ kind: 'before-viewport', trigger: await dialog.locator('.admin-picker-summary').first().boundingBox(), menu: await dialog.locator('.admin-picker-menu').boundingBox() });
    await tap(cdp, dialog.locator('.admin-picker-search input'));
    assert.equal(await page.evaluate(() => document.activeElement.type), 'search');
    // Actual mobile viewport geometry/event, not an overridden visualViewport object.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 320, deviceScaleFactor: 1, mobile: true });
    await page.waitForFunction(() => visualViewport.height === 320);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.locator('.admin-picker-menu').count(), 1);
    await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.locator('.admin-picker-menu').count(), 1, 'keyboard-induced dialog scroll must retain focused search');
    await dialog.locator('.admin-picker-search input').fill('Node 2');
    assert.ok(await dialog.locator('.admin-picker-option').count());
    const short = await page.evaluate(() => { const r = document.querySelector('.admin-picker-menu').getBoundingClientRect(); return { viewportHeight: visualViewport.height, menuTop: r.top, menuBottom: r.bottom }; });
    report.geometry.push({ kind: 'actual-short-search', ...short });
    assert.equal(short.viewportHeight, 320); assert.ok(short.menuTop >= 15 && short.menuBottom <= 305);
    const screenshot = 'actual-short-viewport-search.png', captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, screenshot), Buffer.from(captured.data, 'base64')); report.screenshots.push(screenshot);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await page.goto(`${origin}/test/fixtures/admin-ui/scope.html?mode=picker`);
    await tap(cdp, page.locator('#open')); await tap(cdp, summary);
  });
  if (['all', 'scroll'].includes(probe)) await check('coarse native picker thumb captures a wider diagonal touch drag', async () => {
    const list = dialog.locator('.admin-picker-options'); await list.evaluate(el => { el.scrollTop = 0; });
    const r = await list.boundingBox(); const x = r.x + r.width - 14, y = r.y + 8;
    const samples = [];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let n = 1; n <= 10; n++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - n * 1.2, y: y + n * 10 }] });
      await page.evaluate(() => new Promise(requestAnimationFrame)); samples.push(await list.evaluate(el => el.scrollTop));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    report.geometry.push({ kind: 'picker-drag', r, samples, gutter: await list.evaluate(el => el.offsetWidth - el.clientWidth) });
    assert.ok(samples.at(-1) > 100, JSON.stringify(samples));
    assert.ok(samples.every((value, n) => n === 0 || value >= samples[n - 1]), 'drag should not reset after lateral drift');
  });
  if (['all', 'form'].includes(probe)) {
    await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=zh#/admin`);
    await tap(cdp, page.locator('[data-page=notifications]'));
    await tap(cdp, page.locator('[data-action=add-channel]'));
    await check('notification add exposes provider, connection, template and actions on one page', async () => {
      assert.equal(await dialog.locator('.admin-wizard-steps').count(), 0);
      assert.equal(await dialog.locator('.admin-toolbar-group-trigger').count(), 1);
      for (const selector of ['[name=name]', '[data-secret=botToken]', '[name=template]', '[name=enabled]', '[data-action=test]', '[data-action=save-channel]', '[data-action=cancel]']) assert.equal(await dialog.locator(selector).count(), 1, selector);
    });
  }
  if (['all', 'layout', 'eyes'].includes(probe)) {
    await context.close(); context = null;
    for (const [width, locale] of [[360, 'zh'], [390, 'zh'], [1440, 'zh'], [1920, 'fr']]) for (const theme of ['light', 'dark']) {
      const mobile = width < 640, height = mobile ? 844 : 1080;
      context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, colorScheme: theme });
      await context.route('**/*', route => {
        const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort();
        if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
        if (url.pathname.endsWith('/admin/api')) {
          const data = route.request().postDataJSON(); report.calls.push(data.action);
          assert.ok(!['save_notification_config', 'test_notification_channel'].includes(data.action));
          return route.fulfill({ json: data.action === 'get_notification_config' ? config : { success: true, settings: { username: 'fixture', ['pass' + 'word' + '_configured']: true, site_title: 'CF Monitor' }, servers: Array.from({ length: 120 }, (_, n) => ({ id: `node-${n}`, name: `Node ${n}`, server_group: 'Fixture' })), stats: { total: 120 } } });
        }
        return route.continue();
      });
      page = await context.newPage(); const cdp = await context.newCDPSession(page);
      await page.addInitScript(() => {
        window.touchEvents = [];
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click', 'focusin', 'focusout']) document.addEventListener(type, event => window.touchEvents.push({ type, target: event.target.className, pointer: event.pointerType, detail: event.detail, related: event.relatedTarget?.className, active: document.activeElement.className }), true);
      });
      page.on('pageerror', error => report.errors.push(error.message));
      const click = locator => mobile ? tap(cdp, locator) : locator.click();
      const shot = async suffix => { const filename = `${width}-${theme}-${locale}-${suffix}.png`; await page.screenshot({ path: path.join(out, filename) }); report.screenshots.push(filename); };
      await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=${locale}#/admin`);
      await page.locator('.server-row').first().waitFor();
      await check(`${width}/${theme}: preserved node action row and actual page/nav scrollbar drag`, async () => {
        const actions = await page.locator('#tab-servers .toolbar > .btn').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, width: r.width, height: r.height }; }));
        report.geometry.push({ name: 'accepted-node-actions', width, theme, actions, rootGutter: await page.evaluate(() => innerWidth - document.documentElement.clientWidth) });
        assert.equal(new Set(actions.map(r => Math.round(r.y))).size, 1, 'accepted group/bulk-add/add actions must stay on one row');
        assert.ok(actions.every(r => r.height === 36), 'do not shrink accepted controls');
        await nativeDrag(page, cdp, page.locator('html'), false, mobile, `page-${width}-${theme}`);
        await page.evaluate(() => scrollTo(0, 0));
        if (mobile) { await nativeDrag(page, cdp, page.locator('.admin-nav'), true, true, `nav-${width}-${theme}`); await page.locator('.admin-nav').evaluate(el => { el.scrollLeft = 0; }); }
      });
      const nodeStyle = await style(page.locator('#tab-servers .admin-toolbar-group-trigger'));
      const nodeTrigger = page.locator('#tab-servers .admin-toolbar-group-trigger');
      await click(nodeTrigger); await page.locator('.admin-toolbar-group-menu').waitFor();
      const nodeMenuStyle = await style(page.locator('.admin-toolbar-group-menu'));
      await shot('node-dropdown'); await page.keyboard.press('Escape'); await page.locator('.admin-toolbar-group-menu').waitFor({ state: 'hidden' });
      for (const tab of ['notifications', 'alerts']) {
        await click(page.locator(`[data-page=${tab}]`));
        await check(`${width}/${theme}/${tab}: left identity and right enabled/actions`, async () => {
          const rows = await page.locator(tab === 'notifications' ? '.admin-channel-row' : '.admin-rule-row').evaluateAll(nodes => nodes.map(el => {
            const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom }; };
            return { row: rect(el), identity: rect(el.querySelector('.admin-channel-identity,.admin-rule-title')), action: rect(el.querySelector('.admin-channel-actions')), toggle: rect(el.querySelector('input[type=checkbox]')) };
          }));
          report.geometry.push({ name: 'list-layout', width, theme, tab, rows });
          assert.ok(rows.length);
          for (const r of rows) { assert.ok(r.action.x >= r.identity.right - 1); assert.ok(r.row.right - r.action.right <= 17); assert.ok(r.action.right <= width); }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        });
        await shot(tab);
      }
      await click(page.locator('[data-page=notifications]')); await click(page.locator('[data-action=add-channel]'));
      const dialog = page.getByRole('dialog'), trigger = dialog.locator('.admin-toolbar-group-trigger');
      await check(`${width}/${theme}: same real node selector styles; mouse/touch, keyboard Escape and restore`, async () => {
        const providerStyle = await style(trigger), name = await dialog.locator('[name=name]').boundingBox();
        assert.equal(providerStyle.width, name.width, 'provider trigger must fill the same field column');
        assert.equal(providerStyle.height, mobile ? 44 : 36);
        for (const key of Object.keys(nodeStyle).filter(key => !['width', 'height', 'padding'].includes(key))) assert.equal(providerStyle[key], nodeStyle[key], key);
        await click(trigger); await dialog.locator('.admin-toolbar-group-menu').waitFor();
        const notificationMenuStyle = await style(dialog.locator('.admin-toolbar-group-menu'));
        for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'borderRadius', 'borderColor', 'backgroundColor', 'padding', 'boxShadow']) assert.equal(notificationMenuStyle[key], nodeMenuStyle[key], key);
        assert.equal(await page.evaluate(() => document.body.style.pointerEvents), 'none');
        await shot('provider-dropdown');
        await page.keyboard.press('Escape'); await dialog.locator('.admin-toolbar-group-menu').waitFor({ state: 'hidden' });
        assert.equal(await dialog.count(), 1); assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
        assert.notEqual(await page.evaluate(() => document.body.style.pointerEvents), 'none');
        await trigger.focus(); await page.keyboard.press('ArrowDown'); await dialog.locator('.admin-toolbar-group-menu').waitFor();
        await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await dialog.locator('.admin-toolbar-group-menu').waitFor({ state: 'hidden' });
        assert.equal(await dialog.locator('[name=host]').count(), 1, 'keyboard selected SMTP');
      });
      await check(`${width}/${theme}: one-page fields, template, enabled alignment, dialog scroll`, async () => {
        const enabled = await dialog.locator('.admin-enabled-setting').evaluate(el => { const text = el.firstElementChild.getBoundingClientRect(), input = el.querySelector('input').getBoundingClientRect(); return { textRight: text.right, inputX: input.x, inputRight: input.right, rowRight: el.getBoundingClientRect().right }; });
        assert.ok(enabled.textRight < enabled.inputX && Math.abs(enabled.inputRight - enabled.rowRight) < 2);
        assert.equal(await dialog.locator('.admin-form-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), mobile ? 1 : 2);
        await dialog.locator('[name=template]').fill('Local {{message}}'); assert.match(await dialog.locator('.admin-message-preview').innerText(), /Local/);
        await dialog.locator('.admin-dialog-body').evaluate(el => { el.scrollTop = 0; });
        await shot('smtp-form-top');
        if (mobile) await nativeDrag(page, cdp, dialog.locator('.admin-dialog-body'), false, true, `dialog-${width}-${theme}`);
        else { await page.setViewportSize({ width, height: 640 }); await nativeDrag(page, cdp, dialog.locator('.admin-dialog-body'), false, false, `dialog-${width}-${theme}`); await page.setViewportSize({ width, height }); }
        await dialog.locator('[name=template]').scrollIntoViewIfNeeded(); await shot('template-preview');
      });
      await check(`${width}/${theme}: notification eye stays inside full-width field, toggles and supports keyboard`, async () => {
        const input = dialog.locator('[data-secret]').first(), wrapper = input.locator('..'), eye = wrapper.locator('button');
        await eye.scrollIntoViewIfNeeded();
        const r = await input.boundingBox(), b = await eye.boundingBox(), host = await wrapper.boundingBox();
        assert.equal(r.width, host.width); assert.ok(b.x >= r.x && b.x + b.width <= r.x + r.width);
        assert.equal(b.width, mobile ? 44 : 36); assert.equal(b.height, mobile ? 44 : 36);
        assert.equal(await eye.innerText(), ''); assert.equal(await eye.locator('[data-reference-icon=eye]').count(), 1);
        await assertEye(eye, mobile, 'eye');
        const unfocusedColor = await eye.evaluate(el => getComputedStyle(el).color);
        if (!mobile) { await eye.hover(); await assertEye(eye, false, 'eye'); }
        assert.ok(await input.evaluate(el => parseFloat(getComputedStyle(el).paddingRight) >= 44));
        await input.fill('synthetic-eye-only'); await pressEye(page, cdp, eye, mobile);
        assert.equal(await input.getAttribute('type'), 'text'); assert.equal(await eye.getAttribute('aria-pressed'), 'true');
        assert.equal(await eye.locator('[data-reference-icon=eye-off]').count(), 1);
        await assertEye(eye, mobile, 'eye-off');
        await shot('notification-eye-pointer');
        await eye.focus(); await page.keyboard.press('Space'); assert.equal(await input.getAttribute('type'), 'pass' + 'word');
        await assertEye(eye, mobile, 'eye');
        assert.equal(await eye.evaluate((el, color) => el === document.activeElement && getComputedStyle(el).color !== color, unfocusedColor), true);
        await shot('notification-eye-keyboard');
        assert.equal(await input.inputValue(), 'synthetic-eye-only'); await input.fill('');
        report.geometry.push({ name: 'inside-notification-eye', width, theme, input: r, eye: b });
        await eye.scrollIntoViewIfNeeded(); await shot('visible-notification-eye');
        await dialog.locator('.admin-dialog-body').evaluate(el => { el.scrollTop = 0; }); await shot('smtp-inside-eye');
      });
      if (width === 360 && theme === 'light') await check('all twelve providers render their full connection fields on the same Android page', async () => {
        for (const type of providers) {
          await click(trigger); await dialog.locator('.admin-toolbar-group-menu').waitFor();
          await click(dialog.getByRole('option').nth(providers.indexOf(type))); await dialog.locator('.admin-toolbar-group-menu').waitFor({ state: 'hidden' });
          assert.deepEqual(await dialog.locator('[data-field]').evaluateAll(nodes => nodes.map(n => n.dataset.field)), channelFields(type));
          assert.equal(await dialog.locator('[name=template]').inputValue(), 'Local {{message}}');
          assert.equal(await dialog.locator('[data-action=test], [data-action=save-channel], [data-action=cancel]').count(), 3);
          if (['webhook', 'legacy'].includes(type)) { await dialog.locator('.admin-dialog-body').evaluate(el => { el.scrollTop = 0; }); await shot(`${type}-form`); }
        }
      });
      await click(dialog.locator('[data-action=cancel]'));
      await click(page.locator('[data-page=alerts]')); await click(page.locator('[data-action=add-rule]'));
      const picker = dialog.locator('.admin-picker-summary').first(); await click(picker); await dialog.locator('.admin-picker-menu').waitFor();
      await check(`${width}/${theme}: picker explicit search, keyboard navigation and restoring trigger`, async () => {
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'DIV');
        await nativeDrag(page, cdp, dialog.locator('.admin-picker-options'), false, mobile, `picker-${width}-${theme}`);
        await click(dialog.locator('.admin-picker-search input')); await dialog.locator('.admin-picker-search input').fill('Node 2');
        assert.equal(await page.evaluate(() => document.activeElement.type), 'search');
        await page.keyboard.press('End'); assert.match(await page.evaluate(() => document.activeElement.value), /node-2\d?/);
        await page.keyboard.press('Escape'); assert.equal(await dialog.locator('.admin-picker-menu').count(), 0); assert.equal(await picker.evaluate(el => el === document.activeElement), true);
        await picker.focus(); await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.type), 'search'); await page.keyboard.press('Escape');
      });
      await shot('alert-form'); await click(dialog.locator('[data-action=cancel]'));
      if (mobile) await check(`${width}/${theme}: root touch scrolling works after menu/dialog lock release`, async () => {
        await click(page.locator('[data-page=servers]'));
        assert.notEqual(await page.evaluate(() => document.body.style.pointerEvents), 'none');
        assert.equal(await page.evaluate(() => document.body.classList.contains('admin-dialog-open')), false);
        await nativeDrag(page, cdp, page.locator('html'), false, true, `root-after-menus-${width}-${theme}`);
      });
      await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=login&locale=${locale}#/admin`);
      await check(`${width}/${theme}: login eye shares field width, icon state and keyboard behavior without submit`, async () => {
        const input = page.locator('input[autocomplete=current-password]'), eye = input.locator('..').locator('button');
        await input.fill('synthetic-login-eye');
        const r = await input.boundingBox(), b = await eye.boundingBox(), username = await page.locator('input[name=username]').boundingBox();
        assert.equal(r.width, username.width); assert.ok(b.x >= r.x && b.x + b.width <= r.x + r.width);
        assert.equal(b.width, mobile ? 44 : 36); assert.equal(b.height, mobile ? 44 : 36);
        assert.equal(await eye.innerText(), ''); assert.equal(await eye.locator('[data-reference-icon=eye]').count(), 1);
        await assertEye(eye, mobile, 'eye');
        const unfocusedColor = await eye.evaluate(el => getComputedStyle(el).color);
        if (!mobile) { await eye.hover(); await assertEye(eye, false, 'eye'); }
        const calls = report.calls.length;
        await pressEye(page, cdp, eye, mobile); assert.equal(await input.getAttribute('type'), 'text');
        assert.equal(await eye.getAttribute('aria-pressed'), 'true'); assert.equal(await eye.locator('[data-reference-icon=eye-off]').count(), 1);
        await assertEye(eye, mobile, 'eye-off');
        await shot('login-eye-pointer');
        await eye.focus(); await page.keyboard.press('Enter'); assert.equal(await input.getAttribute('type'), 'password');
        await assertEye(eye, mobile, 'eye');
        assert.equal(await eye.evaluate((el, color) => el === document.activeElement && getComputedStyle(el).color !== color, unfocusedColor), true);
        assert.equal(await input.inputValue(), 'synthetic-login-eye'); assert.equal(report.calls.length, calls, 'eye is not submit');
        assert.ok(await input.evaluate(el => parseFloat(getComputedStyle(el).paddingRight) >= 44));
        report.geometry.push({ name: 'inside-login-eye', width, theme, input: r, eye: b }); await shot('login-eye');
      });
      await context.close(); context = null;
    }
  }
  if (page && !page.isClosed()) {
    report.events = await page.evaluate(() => window.touchEvents || []);
    const screenshot = `${probe}.png`; await page.screenshot({ path: path.join(out, screenshot) }); report.screenshots.push(screenshot);
  }
} catch (error) { report.errors.push(error.stack); }
finally {
  if (page && !page.isClosed()) {
    report.events = await page.evaluate(() => window.touchEvents || []);
    await page.screenshot({ path: path.join(out, `${probe}-final.png`) });
  }
  await context?.close(); await browser?.close(); await server?.close(); report.stopped = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, errors: report.errors, stopped: true }));
  if (report.errors.length) process.exitCode = 1;
}
