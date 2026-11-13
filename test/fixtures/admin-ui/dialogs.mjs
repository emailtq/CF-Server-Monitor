import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';

const playwrightPath = createRequire(import.meta.url).resolve(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const runtimeRequire = createRequire(playwrightPath);
const { chromium } = runtimeRequire(playwrightPath);
const { PNG } = runtimeRequire('pngjs');
const out = path.resolve(process.env.ADMIN_DIALOG_REPORT_DIR || `.planning/2026-11-13-admin-ui-refinement/task2/run-${Date.now()}`);
const viewportScrollbarOnly = process.argv.includes('--viewport-scrollbar');
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, args: process.argv.slice(2), checks: [], geometry: [], screenshots: [], errors: [], actions: [], boundary: 'Mounted production Vue components and styles; synthetic HTTP responses only. Private Vue refs select existing inline dialogs; no substituted dialog markup.' };
const hashFiles = ['src/frontend/styles/admin.css', 'src/frontend/styles/admin-download.css', 'src/frontend/views/admin/components/AdminDialog.vue', 'src/frontend/views/admin/components/AdminMultiSelect.vue', 'src/frontend/views/admin/Terminal.vue', 'test/fixtures/admin-ui/dialogs.js', 'test/fixtures/admin-ui/dialogs.mjs'];
report.hashes = Object.fromEntries(hashFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
let server, browser, context, page, httpOrigin, origin;
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = async (name, fn) => {
  try { await fn(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, pass: false, error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
};
const screenshot = async name => { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file); };
const open = async (kind, stress = false) => {
  await page.evaluate(({ kind, stress }) => window.dialogFixture.open(kind, stress), { kind, stress });
  await page.locator('.admin-dialog').last().waitFor();
  await frames();
  // Expand real optional sections so containment includes their real forms/previews.
  await page.locator('.admin-dialog-body details').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
  await frames();
};
const inspect = async (kind, dimensions) => {
  const dialog = page.locator('.admin-dialog').last();
  const problems = [];
  const base = await dialog.evaluate(section => {
    const body = section.querySelector('.admin-dialog-body'), r = section.getBoundingClientRect();
    // Native editable controls own their text scrolling, not modal layout scrolling.
    const structural = [...section.querySelectorAll('*'), section].filter(e => !e.matches('input,textarea,select,option') && e.getClientRects().length);
    const scrolls = structural.filter(e => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1);
    const scroll = getComputedStyle(body).overflowY === 'visible' ? section : body;
    return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, gutter: scroll.offsetWidth - scroll.clientWidth - scroll.clientLeft * 2, body: { clientWidth: body.clientWidth, offsetWidth: body.offsetWidth, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, padding: getComputedStyle(body).padding }, scrolls: scrolls.map(e => e.className), horizontal: structural.filter(e => e.clientWidth && (e === section || e === body || ['auto', 'scroll'].includes(getComputedStyle(e).overflowX)) && e.scrollWidth > e.clientWidth + 1).map(e => ({ name: e.className, width: e.clientWidth, scrollWidth: e.scrollWidth })) };
  });
  if (base.box.x < -.5 || base.box.x + base.box.width > dimensions.width + .5 || base.box.y < -.5 || base.box.y + base.box.height > dimensions.height + .5) problems.push('dialog outside viewport');
  if (base.horizontal.length) problems.push(`horizontal overflow ${JSON.stringify(base.horizontal)}`);
  if (base.body.clientHeight < 44) problems.push('dialog body collapsed below a usable control height');
  if (base.gutter < 8) problems.push('scrollbar gutter not reserved');
  if (base.scrolls.length > 1) problems.push(`nested vertical scroll owners ${base.scrolls}`);
  const controls = dialog.locator('.admin-dialog-body :is(input:not([type=hidden]), select, textarea, button, pre, summary)');
  const edges = [];
  await page.keyboard.press('Tab');
  for (let i = 0; i < await controls.count(); i++) {
    const control = controls.nth(i);
    if (!await control.isVisible()) continue;
    const edge = await control.evaluate(element => {
      if (!element.disabled && element.tagName !== 'PRE') element.focus();
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const body = element.closest('.admin-dialog-body'), section = element.closest('.admin-dialog');
      const scroll = getComputedStyle(body).overflowY === 'visible' ? section : body;
      const e = element.getBoundingClientRect(), b = scroll.getBoundingClientRect(), style = getComputedStyle(element);
      const ring = style.outlineStyle !== 'none' ? Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) : 0;
      const shadow = style.boxShadow !== 'none' ? 2 : 0;
      const extent = Math.max(ring, shadow);
      return { tag: element.tagName, name: element.name || element.className, focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'), extent, left: e.left - extent, right: e.right + extent, top: e.top - extent, bottom: e.bottom + extent, contentLeft: b.left + scroll.clientLeft, contentRight: b.left + scroll.clientLeft + scroll.clientWidth, contentTop: b.top + scroll.clientTop, contentBottom: b.top + scroll.clientTop + scroll.clientHeight, height: e.height };
    });
    if (edge.left < edge.contentLeft - .75 || edge.right > edge.contentRight + .75) problems.push(`clipped x ${JSON.stringify(edge)}`);
    // Oversized pre blocks may scroll; normal hit targets must be wholly visible after focus.
    if (edge.tag !== 'PRE' && edge.height + 2 * edge.extent <= edge.contentBottom - edge.contentTop && (edge.top < edge.contentTop - .75 || edge.bottom > edge.contentBottom + .75)) problems.push(`clipped focus y ${JSON.stringify(edge)}`);
    edges.push(edge);
  }
  const scrollEdges = await dialog.evaluate(section => {
    const body = section.querySelector('.admin-dialog-body'), scroll = getComputedStyle(body).overflowY === 'visible' ? section : body;
    scroll.scrollTop = 0;
    const top = scroll.scrollTop;
    scroll.scrollTop = scroll.scrollHeight;
    return { owner: scroll.className, top, bottom: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight, documentX: document.documentElement.scrollWidth > innerWidth };
  });
  if (scrollEdges.documentX) problems.push('document horizontal overflow');
  const footer = dialog.locator('.admin-dialog-footer button');
  await page.mouse.move(0, 0); // A stationary pointer over a scrolled quota help icon is not a footer hit test.
  const hits = [];
  for (let i = 0; i < await footer.count(); i++) {
    await footer.nth(i).focus();
    await page.waitForFunction(() => !document.querySelector('.help-tooltip-panel')); // Real help panels close after their existing 120ms blur grace period.
    const hit = await footer.nth(i).evaluate(button => {
      button.focus(); button.scrollIntoView({ block: 'nearest' });
      const r = button.getBoundingClientRect(), style = getComputedStyle(button), ring = style.outlineStyle !== 'none' ? parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) : 0, viewportTop = visualViewport?.offsetTop || 0, viewportBottom = viewportTop + (visualViewport?.height || innerHeight);
      return { label: button.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height, ring, inside: r.left - ring >= 0 && r.right + ring <= innerWidth && r.top - ring >= viewportTop && r.bottom + ring <= viewportBottom, hit: button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
    });
    if (!hit.inside || !hit.hit) problems.push(`footer clipped ${JSON.stringify(hit)}`);
    hits.push(hit);
  }
  await screenshot(`${kind}-${dimensions.width}-${dimensions.height}-bottom`);
  const close = await dialog.locator('.admin-dialog-close').evaluate(button => {
    button.scrollIntoView({ block: 'nearest' }); const r = button.getBoundingClientRect();
    const top = visualViewport?.offsetTop || 0; return { inside: r.top >= top && r.bottom <= top + (visualViewport?.height || innerHeight), hit: button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
  });
  if (!close.inside || !close.hit) problems.push('close button unreachable');
  if (['edit', 'group', 'download', 'terminal', 'notificationTemplate'].includes(kind)) {
    await dialog.evaluate(section => { const body = section.querySelector('.admin-dialog-body'); (getComputedStyle(body).overflowY === 'visible' ? section : body).scrollTop = 0; });
    await screenshot(`${kind}-${dimensions.width}-${dimensions.height}-top`);
  }
  report.geometry.push({ kind, dimensions, base, edges, scrollEdges, hits, close, problems });
  assert.deepEqual(problems, [], `${kind} ${dimensions.width}x${dimensions.height}`);
};
try {
  server = await createServer({ fixtureEntries: [path.resolve('test/fixtures/admin-ui/dialogs.html')], vueFixtureDevtools: true, cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`; origin = httpOrigin.replace('http:', 'https:');
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  report.chromium = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://api.github.com') {
      if (url.pathname.includes('/contents/')) return route.fulfill({ json: { encoding: 'base64', content: Buffer.from('fs.StringVar(&nodeTokenFile,"token-file","","")\nfs.StringVar(&registerKey,"register-key","","")\nfs.StringVar(&terminal,"terminal","","")\nfunc (a *Agent) startTerminal(ctx context.Context) {}').toString('base64') } });
      return route.fulfill({ json: { tag_name: 'task2.synthetic', draft: false, assets: ['linux-amd64', 'darwin-arm64', 'windows-amd64.exe', 'freebsd-amd64'].map(platform => ({ name: 'cf-probe-' + platform, state: 'uploaded', browser_download_url: 'https://github.com/emailtq/cfsm-agent/releases/download/task2.synthetic/cf-probe-' + platform })) } });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith('/admin/api')) {
      const data = request.postDataJSON(); report.actions.push({ action: data.action });
      if (data.action === 'node_read_install') return route.fulfill({ json: { token: 'a'.repeat(64), enabled: false, needsRotation: false } });
      if (data.action === 'get_notification_config') return route.fulfill({ json: { schema: 1, revision: 1, channels: [], rules: [] } });
      if (data.action === 'terminal_create') return route.fulfill({ status: 503, json: { error: 'terminal_agent_offline' } });
      if (data.action === 'terminal_status') return route.fulfill({ json: { nodes: {}, connected: false, supported: true } });
      return route.fulfill({ json: { settings: { site_title: 'Fixture', username: 'fixture', terminal_enabled: true, notification_config: { schema: 1, revision: 1, channels: [], rules: [] } }, servers: [{ id: 'node-a', name: 'Fixture node', os: 'Linux' }], stats: { total: 1 } } });
    }
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({ json: {} });
    const response = await route.fetch({ url: httpOrigin + (url.pathname === '/admin' ? '/test/fixtures/admin-ui/dialogs.html' : url.pathname) + url.search });
    return route.fulfill({ response });
  });
  page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', error => report.errors.push(error.stack));
  const kinds = ['add', 'group', 'delete', 'edit', 'batch', 'renew', 'download', 'downloadConfirm', 'autoDiscovery', 'notificationCreate', 'notificationSmtp', 'notificationWebhook', 'notificationTemplate', 'alert', 'revoke', 'terminal', 'database', 'notificationRemoval', 'autoUpdateWarning', 'databaseClear', 'databaseUpgrade', 'd1Usage', 'validation', 'saveResult', 'message'];
  const matrix = viewportScrollbarOnly ? [] : [{ width: 1440, height: 900, locale: 'en', dark: false }, { width: 320, height: 480, locale: 'zh', dark: true }, { width: 360, height: 360, locale: 'ja', dark: false }, { width: 390, height: 300, locale: 'en', dark: true, stress: true }];
  if (viewportScrollbarOnly) { await page.goto(`${origin}/admin?locale=en#/admin/terminal/node-a`); await page.waitForFunction(() => window.dialogFixture); }
  const viewportCdp = await context.newCDPSession(page);
  for (const dimensions of matrix) {
    await viewportCdp.send('Emulation.setTouchEmulationEnabled', { enabled: dimensions.width < 640 });
    await page.setViewportSize({ width: dimensions.width, height: dimensions.height });
    await page.goto(`${origin}/admin?locale=${dimensions.locale}#/admin/terminal/node-a`);
    await page.waitForFunction(() => window.dialogFixture);
    dimensions.coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    assert.equal(dimensions.coarse, dimensions.width < 640, 'mobile geometry must exercise the real coarse-pointer stylesheet');
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dimensions.dark);
    for (const kind of kinds) await check(`${kind} ${dimensions.width}x${dimensions.height} ${dimensions.locale} containment`, async () => { await open(kind, dimensions.stress); await inspect(kind, dimensions); });
  }
  await viewportCdp.detach();
  for (const height of [360, 700]) await check(`actual alert picker follows the ${height === 360 ? 'short section' : 'normal body'} scrollport, own scrolling and keyboard`, async () => {
    await page.setViewportSize({ width: 390, height }); await open('alert');
    const dialog = page.locator('.admin-dialog').last(), trigger = dialog.locator('.admin-picker-summary').first(), menu = dialog.locator('.admin-picker-menu');
    const sample = () => dialog.evaluate(section => {
      const body = section.querySelector('.admin-dialog-body'), owner = getComputedStyle(body).overflowY === 'visible' ? section : body;
      const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      return { owner: owner.className, scrollTop: owner.scrollTop, section: box(section), body: box(body), port: box(owner), trigger: box(section.querySelector('.admin-picker-summary')), menu: box(section.querySelector('.admin-picker-menu')) };
    });
    await trigger.click(); await menu.waitFor();
    const beforeMenuScroll = await sample(), options = menu.locator('.admin-picker-options'), optionsBox = await options.boundingBox();
    await page.mouse.move(optionsBox.x + optionsBox.width / 2, optionsBox.y + optionsBox.height / 2); await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('.admin-picker-options')?.scrollTop > 0);
    assert.equal((await sample()).scrollTop, beforeMenuScroll.scrollTop, 'menu wheel must not scroll the surrounding dialog');
    await page.keyboard.press('End'); await frames();
    assert.equal(await menu.count(), 1); assert.equal((await sample()).scrollTop, beforeMenuScroll.scrollTop, 'menu keyboard scroll retains the background owner');
    await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0); assert.equal(await trigger.evaluate(e => e === document.activeElement), true); assert.equal(await dialog.count(), 1);
    await trigger.click(); await menu.waitFor(); const before = await sample();
    await page.mouse.move(before.port.right - 4, (before.port.top + before.port.bottom) / 2); await page.mouse.wheel(0, -2000);
    await page.waitForFunction(() => { const section = document.querySelector('.admin-dialog'), body = section.querySelector('.admin-dialog-body'); return (getComputedStyle(body).overflowY === 'visible' ? section : body).scrollTop === 0; });
    await frames(); const after = await sample(), outside = after.trigger.bottom <= after.port.top || after.trigger.top >= after.port.bottom;
    report.geometry.push({ kind: 'picker-scrollport', height, beforeMenuScroll, before, after, outside });
    await screenshot(`picker-scrollport-${height}`);
    assert.equal(outside, height === 360, 'the short viewport must really scroll the trigger out; normal body keeps it visible');
    assert.equal(await menu.count(), outside ? 0 : 1, 'a fully clipped trigger must close its popup instead of leaving it over the header');
    if (!outside) { await page.keyboard.press('Escape'); assert.equal(await trigger.evaluate(e => e === document.activeElement), true); }
  });
  await check('visualViewport-only keyboard shrink keeps actual forms, footer and close inside 300px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open('edit');
    await page.evaluate(() => {
      window.actualViewport = visualViewport;
      const viewport = new EventTarget(); Object.assign(viewport, { height: 300, width: 390, offsetTop: 0, offsetLeft: 0 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      window.actualViewport.dispatchEvent(new Event('resize'));
    });
    try {
      for (const kind of ['edit', 'add', 'group', 'delete', 'notificationTemplate', 'download']) {
        if (kind !== 'edit') await open(kind);
        await frames(); await inspect(`keyboard-${kind}`, { width: 390, height: 300, locale: 'en', keyboardBoundary: 'visualViewport API resize only; layout viewport remains 844px' });
      }
    } finally {
      await page.evaluate(() => { window.dialogFixture.state.open = false; }); await frames();
      await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.actualViewport }); visualViewport.dispatchEvent(new Event('resize')); });
    }
  });
  const dragCdp = await context.newCDPSession(page); await dragCdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await dragCdp.detach();
  for (const kind of ['edit', 'terminal']) await check(`${kind} scrollbar paints a narrower thumb but retains native edge and center drag`, async () => {
    await page.setViewportSize({ width: kind === 'edit' ? 1440 : 390, height: kind === 'edit' ? 700 : 360 }); await open(kind);
    const scroller = page.locator('.admin-dialog').last();
    const geometry = await scroller.evaluate(section => {
      const body = section.querySelector('.admin-dialog-body'), owner = getComputedStyle(body).overflowY === 'visible' ? section : body;
      owner.scrollTop = 0;
      const r = owner.getBoundingClientRect(), gutter = owner.offsetWidth - owner.clientWidth - owner.clientLeft * 2, thumbHeight = Math.max(24, owner.clientHeight ** 2 / owner.scrollHeight);
      return { owner: owner.className, gutter, barLeft: r.left + owner.clientLeft + owner.clientWidth, thumbY: r.top + owner.clientTop + thumbHeight / 2, clientHeight: owner.clientHeight, scrollHeight: owner.scrollHeight };
    });
    await page.mouse.move(0, 0); await frames();
    const shot = path.join(out, `scrollbar-${kind}.png`), buffer = await page.screenshot({ path: shot, clip: { x: Math.round(geometry.barLeft) - 2, y: Math.round(geometry.thumbY), width: geometry.gutter + 2, height: 1 } });
    report.screenshots.push(shot);
    const pixels = PNG.sync.read(buffer), background = [...pixels.data.subarray(0, 3)];
    const visibleColumns = Array.from({ length: geometry.gutter }, (_, x) => x + 2).filter(x => background.some((value, channel) => Math.abs(value - pixels.data[x * 4 + channel]) > 3));
    const drags = [];
    for (const offset of [.5, 4]) {
      await scroller.evaluate(section => { const body = section.querySelector('.admin-dialog-body'); (getComputedStyle(body).overflowY === 'visible' ? section : body).scrollTop = 0; });
      await page.mouse.move(geometry.barLeft + offset, geometry.thumbY); await page.mouse.down();
      await page.mouse.move(geometry.barLeft + offset, geometry.thumbY + Math.min(220, geometry.clientHeight * .55), { steps: 6 }); await page.mouse.up();
      drags.push({ offset, scrollTop: await scroller.evaluate(section => { const body = section.querySelector('.admin-dialog-body'); return (getComputedStyle(body).overflowY === 'visible' ? section : body).scrollTop; }) });
    }
    report.geometry.push({ kind: 'scrollbar-drag', consumer: kind, ...geometry, paintedWidth: visibleColumns.length, background, drags });
    assert.equal(geometry.gutter, 8, 'keep the established drag region and separately reserved layout gutter');
    assert.equal(visibleColumns.length, 6, 'the screenshot must actually paint a six-pixel thumb, not merely declare a thin width');
    assert.ok(drags.every(drag => drag.scrollTop > 0), 'native mouse drag must work at both the unpainted edge and thumb center');
    await screenshot(`scrollbar-${kind}-after-drag`);
  });
  await check('stack, busy, keyboard trap and focus restore stay on the real dialogs', async () => {
    await page.setViewportSize({ width: 390, height: 480 });
    await page.evaluate(() => { window.dialogFixture.state.open = false; }); await frames();
    await page.locator('#outside').focus(); await open('download');
    await page.waitForFunction(() => !document.querySelector('[data-terminal-reissue]')?.disabled);
    const reissue = page.locator('[data-terminal-reissue]'); await reissue.focus(); await reissue.click();
    const confirm = page.locator('.admin-dialog-download-confirm'); await confirm.waitFor();
    const first = confirm.locator('.admin-dialog-close'), last = confirm.locator('[data-confirm-reissue]');
    await last.focus(); await page.keyboard.press('Tab'); assert.equal(await first.evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await last.evaluate(e => e === document.activeElement), true);
    await page.evaluate(() => document.querySelector('#outside').focus()); assert.equal(await confirm.evaluate(e => e.contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); assert.equal(await confirm.count(), 0); assert.equal(await reissue.evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.admin-dialog').count(), 0); assert.equal(await page.locator('#outside').evaluate(e => e === document.activeElement), true);
    await open('add'); await page.evaluate(() => window.dialogFixture.busy(true));
    await page.keyboard.press('Escape'); await page.mouse.click(2, 2); assert.equal(await page.locator('.admin-dialog').count(), 1); assert.equal(await page.locator('.admin-dialog-close').isDisabled(), true);
    await page.evaluate(() => window.dialogFixture.busy(false)); await page.keyboard.press('Escape'); assert.equal(await page.locator('.admin-dialog').count(), 0);
  });
  for (const dark of [false, true]) await check(`download switch has real mid-transition movement and color, ${dark ? 'dark' : 'light'}`, async () => {
    await page.setViewportSize({ width: 390, height: 600 }); await open('download');
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
    const toggle = page.locator('#download-auto-update');
    await frames(); await page.waitForFunction(() => !document.querySelector('#download-auto-update').getAnimations({ subtree: true }).some(animation => animation.playState === 'running'));
    const sample = () => toggle.evaluate(e => ({ checked: e.checked, transform: getComputedStyle(e, '::before').transform, track: getComputedStyle(e).backgroundColor, thumb: getComputedStyle(e, '::before').backgroundColor, tap: getComputedStyle(e).webkitTapHighlightColor }));
    const before = await sample(); await toggle.click();
    const mid = await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => { const e = document.querySelector('#download-auto-update'); resolve({ checked: e.checked, transform: getComputedStyle(e, '::before').transform, track: getComputedStyle(e).backgroundColor, thumb: getComputedStyle(e, '::before').backgroundColor }); }));
    }));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#download-auto-update'), '::before').transform === 'matrix(1, 0, 0, 1, 14, 0)');
    const after = await sample(); report.geometry.push({ kind: 'switch-motion', dark, before, mid, after });
    assert.equal(mid.checked, true, 'state update is synchronous, not delayed until animation ends');
    assert.notEqual(mid.transform, before.transform); assert.notEqual(mid.transform, after.transform);
    assert.notEqual(mid.track, before.track); assert.notEqual(mid.track, after.track); assert.equal(after.tap, 'rgba(0, 0, 0, 0)');
    await screenshot(`switch-${dark ? 'dark' : 'light'}`);
    const disabled = page.locator('#download-terminal');
    await page.locator('.admin-dialog-download select').first().selectOption('windows');
    assert.equal(await disabled.isDisabled(), true); const unchanged = await disabled.isChecked();
    await disabled.scrollIntoViewIfNeeded(); const box = await disabled.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); assert.equal(await disabled.isChecked(), unchanged, 'a native click must not toggle the disabled switch');
  });
  await check('reduced motion and native touch do not lose switch focus/disabled semantics', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await open('download');
    const toggle = page.locator('#download-auto-update'); await page.keyboard.press('Tab'); await toggle.focus(); await page.keyboard.press('Space');
    const state = await toggle.evaluate(e => ({ checked: e.checked, transform: getComputedStyle(e, '::before').transform, focus: e.matches(':focus-visible'), outline: getComputedStyle(e).outlineWidth, transition: getComputedStyle(e, '::before').transitionDuration }));
    assert.equal(state.checked, true); assert.equal(state.transform, 'matrix(1, 0, 0, 1, 14, 0)'); assert.equal(state.focus, true); assert.equal(state.outline, '2px'); assert.equal(state.transition, '0s');
    const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const b = await toggle.boundingBox(); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await toggle.isChecked(), false); assert.equal(await toggle.evaluate(e => getComputedStyle(e).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)'); await cdp.detach();
    report.geometry.push({ kind: 'reduced-motion', state });
  });
  assert.deepEqual(report.errors, [], 'no Vue runtime errors');
} catch (error) { report.errors.push(error.stack); console.error(error.stack); }
finally {
  await context?.close(); await browser?.close(); await server?.close();
  report.cleanup = { contextClosed: true, browserClosed: true, serverClosed: true, historicalEvidenceUntouched: true };
  report.pass = report.checks.length > 0 && report.checks.every(check => check.pass) && report.errors.length === 0;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`REPORT ${path.join(out, 'report.json')}`);
process.exitCode = report.pass ? 0 : 1;
