import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import en from '../../../src/frontend/locales/en.js';
import { connectionChecks, refinementChecks } from './terminal-refinement-checks.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = path.resolve('.planning/2026-11-13-admin-ui-polish/task3');
fs.mkdirSync(base, { recursive: true });
const out = process.env.TERMINAL_WORKSPACE_REPORT_DIR || fs.mkdtempSync(path.join(base, 'workspace-'));
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], errors: [], actions: [], inputs: [], resizes: [], sockets: 0, ack: 0, outputBytes: 0, realXterm: true, syntheticPeer: true, physicalDevice: false };
report.sourceSHA256 = Object.fromEntries(['src/frontend/views/admin/Terminal.vue', 'src/frontend/views/admin/components/AdminDialog.vue', 'src/frontend/composables/useTerminal.js', 'test/fixtures/admin-ui/terminal-workspace.mjs', 'test/fixtures/admin-ui/terminal-refinement-checks.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
let server, browser, page, context, socket, session = 0;
const refinement = process.env.TERMINAL_REFINEMENT === '1';
let releaseCreating, releaseStarting;
const creatingGate = refinement ? new Promise(resolve => { releaseCreating = resolve; }) : Promise.resolve();
const startingGate = refinement ? new Promise(resolve => { releaseStarting = resolve; }) : Promise.resolve();
const check = async (name, fn) => {
  try { await fn(); report.checks.push({ name, pass: true }); console.log('PASS ' + name); }
  catch (error) { report.errors.push({ name, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
};
const state = () => page.evaluate(() => {
  const s = window.fixtureScreen, b = s.buffer.active;
  return { viewportY: b.viewportY, baseY: b.baseY, type: b.type, first: b.getLine(b.viewportY)?.translateToString(), rows: s.rows, cols: s.cols, mouse: s.modes.mouseTrackingMode, selection: s.hasSelection() };
});
const output = async text => {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += 16384) { const frame = bytes.subarray(offset, offset + 16384); report.outputBytes += frame.length; socket.send(frame); }
  await page.waitForFunction(bytes => window.fixtureAck >= bytes, report.outputBytes);
};
const menu = async () => { if (await page.locator('[data-terminal-menu]').getAttribute('aria-expanded') !== 'true') await page.locator('[data-terminal-menu]').click(); await page.locator('.admin-dialog-terminal').waitFor(); await page.waitForFunction(() => !document.querySelector('.terminal-menu-enter-active')); };
const closeMenu = async () => { if (await page.locator('[data-terminal-menu]').getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape'); await page.locator('.admin-dialog-terminal').waitFor({ state: 'hidden' }); };
try {
  server = await createServer({ frontendExports: true, fixtureEntries: [path.resolve('test/fixtures/admin-ui/terminal-workspace.html')], cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  const httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`, origin = httpOrigin.replace('http:', 'https:');
  const bundle = fs.readdirSync(out).find(name => name.startsWith('compiled-fixture-'));
  const exports = JSON.parse(fs.readFileSync(path.join(out, bundle, 'build-receipt.json'))).exports;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  report.browserVersion = browser.version();
  const touch = process.env.TERMINAL_WORKSPACE_POINTER !== 'fine';
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: touch, isMobile: touch });
  report.pointer = touch ? 'coarse' : 'fine';
  await context.addInitScript(() => {
    window.fixtureAck = 0;
    window.fixtureNativeClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => new Promise((resolve, reject) => { window.clipboardResolve = resolve; window.clipboardReject = reject; }), writeText: async text => { window.copied = text; } } });
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/admin/api') {
      const data = req.postDataJSON(); report.actions.push(data.action);
      if (data.action === 'terminal_status') { await creatingGate; return route.fulfill({ json: { enabled: true, connected: true, supported: true, protocol: 1, platform: 'linux' } }); }
      if (data.action === 'terminal_open') { session++; report.outputBytes = report.ack = 0; return route.fulfill({ json: { sessionId: `session-${session}`, browserPath: `/admin/api/terminal/node-a/session-${session}/ws` } }); }
      return route.fulfill({ json: { servers: [{ id: 'node-a', name: 'Hong Kong production node with a long name', region: 'HK', os: 'Debian 12' }], success: true } });
    }
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({ json: {} });
    const target = url.pathname === '/admin' ? '/test/fixtures/admin-ui/terminal-workspace.html' : url.pathname;
    return route.fulfill({ response: await route.fetch({ url: httpOrigin + target + url.search }) });
  });
  await context.routeWebSocket('**/admin/api/terminal/**', async ws => {
    report.sockets++;
    socket = ws;
    let consumed = 0;
    ws.onMessage(async data => {
      if (typeof data !== 'string') { consumed += data.length; report.inputs.push(Buffer.from(data).toString()); ws.send(JSON.stringify({ type: 'ack', bytes: consumed })); return; }
      const frame = JSON.parse(data);
      if (frame.type === 'ack') { report.ack = frame.bytes; await page.evaluate(bytes => { window.fixtureAck = bytes; }, frame.bytes).catch(() => {}); }
      if (frame.type === 'resize') report.resizes.push(frame);
      if (frame.type === 'ping') ws.send('{"type":"pong"}');
    });
    ws.send('{"type":"start","cols":80,"rows":24}');
    await startingGate;
    ws.send('{"type":"ready"}');
    if (refinement) { const first = Buffer.from('FIRST REMOTE LINE\r\n'); report.outputBytes += first.length; ws.send(first); }
  });
  page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') (report.console || (report.console = [])).push({ type: message.type(), text: message.text() }); });
  page.on('pageerror', error => report.errors.push({ name: 'pageerror', error: error.stack }));
  await page.goto(`${origin}/admin#/admin/terminal/node-a?apiIndex=0`);
  if (refinement) await connectionChecks({ page, check, releaseCreating, releaseStarting, out, report });
  await page.waitForFunction(() => window.fixtureScreen && !window.fixtureScreen.options.disableStdin);
  if (refinement) {
    await refinementChecks({ page, context, report, check, state, output, menu, closeMenu, out, exports, socket: () => socket });
  } else {
  const cdp = await context.newCDPSession(page);
  const swipe = async (delta = 180, options = {}) => {
    const box = await page.locator('.xterm-screen').boundingBox(), x = box.x + Math.min(box.width / 2, 100), y = box.y + Math.min(box.height / 3, 80);
    const points = n => [{ x, y: y + n, id: 1 }, ...(options.multi ? [{ x: x + 40, y: y + n, id: 2 }] : [])];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) });
    if (options.hold) await page.waitForTimeout(450);
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(delta * i / 8) }); await page.waitForTimeout(18); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(40);
  };
  await output(Array.from({ length: 240 }, (_, i) => `history-${i.toString().padStart(3, '0')}\r\n`).join(''));
  await page.evaluate(() => {
    window.fixtureFrames = []; let previous = performance.now();
    const tick = now => { window.fixtureFrames.push(now - previous); previous = now; window.fixtureFrameId = requestAnimationFrame(tick); }; window.fixtureFrameId = requestAnimationFrame(tick);
  });
  const before = await state();
  await swipe();
  const after = await state();
  report.touch = { before, after, hostOverflow: await page.locator('.terminal-screen').evaluate(el => getComputedStyle(el).overflow) };
  if (process.env.TERMINAL_WORKSPACE_RED === '1') {
    await page.locator('.terminal-screen').evaluate(el => { el.style.overflow = 'auto'; });
    await swipe(); report.touch.hostOverflowAuto = await state();
    await page.locator('.terminal-screen').evaluate(el => { el.style.overflow = ''; });
  }
  await check('native CDP one-finger history swipe moves actual normal viewportY without input', async () => {
    assert.ok(after.viewportY < before.viewportY, JSON.stringify(report.touch)); assert.equal(report.inputs.length, 0);
  });
  await page.evaluate(() => window.fixtureScreen.scrollLines(-10));
  const anchor = await state();
  const resizeCount = report.resizes.length;
  for (let i = 0; i < 40; i++) await output((`\r\x1b[2Kcontinuous-${i} ` + 'x'.repeat(15)).repeat(128) + '\r\n');
  report.continuous = { before: anchor, after: await state(), outputBytes: report.outputBytes, ack: report.ack, resizeDelta: report.resizes.length - resizeCount, frames: await page.evaluate(() => { cancelAnimationFrame(window.fixtureFrameId); return window.fixtureFrames; }) };
  await check('continuous output is ACKed completely and keeps the old visible history', async () => {
    assert.equal(report.continuous.after.first, anchor.first); assert.equal(report.ack, report.outputBytes); assert.ok(report.outputBytes > 100000); assert.equal(report.continuous.resizeDelta, 0);
  });
  await check('full-height workspace removes public header and bulky always-visible blocks', async () => {
    assert.equal(await page.locator('.admin-header').count(), 0);
    assert.ok((await page.locator('.terminal-screen').boundingBox()).height >= 700);
    assert.equal(await page.locator('.terminal-risk').isVisible(), false);
  });
  if (report.errors.length && process.env.TERMINAL_WORKSPACE_RED === '1') { await page.screenshot({ path: path.join(out, 'red-mobile.png') }); }
  else {
    await check('return-to-bottom is local; selection, long press and multi-touch are not claimed', async () => {
      await page.locator('[data-terminal-bottom]').click(); assert.equal((await state()).viewportY, (await state()).baseY);
      const start = await state(); await swipe(120, { hold: true }); assert.equal((await state()).viewportY, start.viewportY);
      await swipe(120, { multi: true }); assert.equal((await state()).viewportY, start.viewportY);
      await page.evaluate(() => window.fixtureScreen.select(0, window.fixtureScreen.buffer.active.viewportY, 8));
      await swipe(); assert.equal((await state()).selection, true); assert.equal((await state()).viewportY, start.viewportY);
      await page.evaluate(() => window.fixtureScreen.clearSelection()); assert.equal(report.inputs.length, 0);
    });
    await check('alternate/fullscreen and mouse reporting swipes never become remote arrows', async () => {
      await output('\x1b[?1049h\x1b[?1000h\x1b[?1006hALT SCREEN');
      assert.equal((await state()).type, 'alternate'); const inputs = report.inputs.length;
      await swipe(); assert.equal((await state()).viewportY, 0); assert.equal(report.inputs.length, inputs);
      await output('\x1b[?1049l');
      const normal = await state(); await swipe(); assert.equal((await state()).viewportY, normal.viewportY); assert.equal(report.inputs.length, inputs);
      await output('\x1b[?1000l\x1b[?1006l');
    });
    await check('sidebar is overlay, traps focus/Escape/restores trigger; theme does not reopen or resize', async () => {
      const box = await page.locator('.terminal-screen').boundingBox(), reservations = session, sockets = report.sockets, resizes = report.resizes.length;
      await menu(); assert.deepEqual(await page.locator('.terminal-screen').boundingBox(), box);
      assert.equal(await page.getByRole('dialog').count(), 1);
      const sidebar = await page.getByRole('dialog').boundingBox(); assert.deepEqual([sidebar.x, sidebar.y, sidebar.width, sidebar.height], [50, 0, 340, 844]);
      await page.locator('.terminal-theme').selectOption('light'); await page.waitForTimeout(60);
      assert.equal(session, reservations); assert.equal(report.sockets, sockets); assert.equal(report.resizes.length, resizes);
      await page.locator('.terminal-session summary').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.locator('.admin-dialog-close').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Shift+Tab'); assert.equal(await page.locator('.terminal-session summary').evaluate(el => el === document.activeElement), true);
      await closeMenu(); assert.equal(await page.locator('[data-terminal-menu]').evaluate(el => el === document.activeElement), true);
    });
    await check('remote disable cancellation restores persistent menu focus without revoking or reopening', async () => {
      const sockets = report.sockets, reservations = session, revokes = report.actions.filter(action => action === 'terminal_revoke_node').length;
      report.submenuFocus = [];
      for (const method of ['escape', 'close']) {
        await menu(); await page.locator('[data-terminal-revoke]').click();
        const dialog = page.locator('.admin-dialog-edit'); await dialog.waitFor();
        assert.equal(await page.locator('.admin-dialog-terminal').count(), 0);
        assert.equal(await dialog.locator('.btn-red').isDisabled(), true);
        assert.equal(await dialog.locator('.terminal-consent input').isChecked(), false);
        assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
        if (method === 'escape') await page.keyboard.press('Escape');
        else await dialog.locator('footer').getByRole('button', { name: en.close, exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        const focused = await page.locator('[data-terminal-menu]').evaluate(el => el === document.activeElement);
        report.submenuFocus.push({ method, focused, activeTag: await page.evaluate(() => document.activeElement.tagName) });
        assert.equal(focused, true, 'remote disable cancellation must return focus to the persistent menu trigger');
        assert.equal(report.sockets, sockets); assert.equal(session, reservations);
        assert.equal(report.actions.filter(action => action === 'terminal_revoke_node').length, revokes);
      }
    });
    await check('keyboard controls expand on demand; Chinese IME and modifiers keep one input owner', async () => {
      assert.equal(await page.locator('.terminal-key-controls').count(), 0);
      await page.locator('[data-terminal-keys]').click();
      const input = page.locator('.terminal-mobile-input');
      await input.evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = '中文'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }); el.dispatchEvent(enter); window.imePrevented = enter.defaultPrevented; });
      assert.equal(await page.evaluate(() => window.imePrevented), false);
      await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
      await page.waitForFunction(() => !document.querySelector('.terminal-mobile-input').value); await page.waitForTimeout(40);
      assert.equal(report.inputs.join(''), '中文');
      await page.getByRole('button', { name: 'Ctrl', exact: true }).click(); await input.fill('c'); await page.waitForTimeout(40);
      await page.getByRole('button', { name: 'Alt', exact: true }).click(); await input.fill('x'); await page.waitForTimeout(40);
      assert.equal(report.inputs.join(''), '中文\x03\x1bx');
      await page.locator('[data-terminal-keys]').click();
    });
    await check('1440/320/360/390 light/dark zh/en/ja have bounded visible geometry and real renderer colors', async () => {
      for (const locale of ['zh', 'en', 'ja']) {
        await page.evaluate(async ({ file, locale }) => (await import(file)).setLanguage(locale), { file: exports['/src/frontend/utils/i18n.js'], locale });
        for (const width of [1440, 320, 360, 390]) {
          const height = width === 1440 ? 900 : 844; await page.setViewportSize({ width, height });
          for (const theme of ['light', 'dark']) {
            await page.evaluate(async ({ file, theme }) => (await import(file)).useTheme().setTheme(theme), { file: exports['/src/frontend/composables/useTheme.js'], theme });
            await page.waitForTimeout(40);
            const geometry = await page.evaluate(() => {
              const host = document.querySelector('.terminal-screen'), box = host.getBoundingClientRect(), css = getComputedStyle(host);
              return { height: box.height, bottom: box.bottom, width: document.documentElement.scrollWidth, viewport: innerWidth, theme: window.fixtureScreen.options.theme, expected: { background: css.backgroundColor, foreground: css.color }, rows: window.fixtureScreen.rows, controls: [...document.querySelectorAll('.terminal-toolbar button,.terminal-toolbar input,[data-terminal-menu]')].map(el => ({ height: el.getBoundingClientRect().height, bottom: el.getBoundingClientRect().bottom })) };
            });
            assert.ok(geometry.height >= height - 120, JSON.stringify(geometry)); assert.ok(geometry.width <= width);
            assert.equal(geometry.theme.background, geometry.expected.background); assert.equal(geometry.theme.foreground, geometry.expected.foreground);
            for (const control of geometry.controls) assert.ok(control.height >= 44 && control.bottom <= height);
            report.checks.push({ name: `${locale}/${width}/${theme}`, pass: true, geometry });
            await page.screenshot({ path: path.join(out, `${locale}-${width}-${theme}.png`) });
            await menu(); await page.screenshot({ path: path.join(out, `${locale}-${width}-${theme}-menu.png`) }); await closeMenu();
          }
        }
      }
    });
    await check('visualViewport keyboard shrink and expanded keys fit the same socket', async () => {
      await page.evaluate(async file => (await import(file)).setLanguage('en'), exports['/src/frontend/utils/i18n.js']);
      await page.setViewportSize({ width: 390, height: 844 }); const reservations = session;
      await page.locator('[data-terminal-keys]').click();
      await page.evaluate(() => { window.originalViewport = visualViewport; const viewport = new EventTarget(); viewport.height = 300; Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport }); window.originalViewport.dispatchEvent(new Event('resize')); });
      await page.waitForFunction(() => document.querySelector('.terminal-page').getBoundingClientRect().height === 300);
      assert.ok((await page.locator('.terminal-screen').boundingBox()).height >= 100); assert.equal(session, reservations);
      await page.screenshot({ path: path.join(out, 'keyboard-300-expanded.png') });
      await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalViewport }); visualViewport.dispatchEvent(new Event('resize')); });
    });
    await check('clipboard and IME cannot cross reopen; final output drains before teardown', async () => {
      await page.locator('.terminal-mobile-input').evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = '旧会话'; });
      await page.getByRole('button', { name: en.terminalPaste, exact: true }).click();
      await menu(); await page.locator('[data-terminal-disconnect]').click(); await menu(); await page.getByRole('button', { name: en.terminalReopen, exact: true }).click();
      await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin); const count = report.inputs.length;
      await page.locator('.terminal-mobile-input').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      await page.evaluate(() => window.clipboardResolve('STALE')); await page.waitForTimeout(40); assert.equal(report.inputs.length, count);
      socket.send(Buffer.from('FINAL DRAIN MARKER\r\n')); socket.send('{"type":"exit","code":0}');
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('FINAL DRAIN MARKER'));
      assert.equal(await page.locator('.terminal-mobile-input').isDisabled(), true);
      await menu(); await page.locator('[data-terminal-back]').click(); await page.waitForFunction(() => !document.querySelector('.xterm'));
      assert.ok(page.url().endsWith('#/admin?apiIndex=0'));
    });
  }
  }
} catch (error) { report.errors.push({ name: 'fixture', error: error.stack }); await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally {
  await context?.unrouteAll({ behavior: 'wait' }); await browser?.close(); await server?.close();
  report.closed = true; report.nodeResourceUsage = process.resourceUsage(); report.nodeMemoryUsage = process.memoryUsage();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
