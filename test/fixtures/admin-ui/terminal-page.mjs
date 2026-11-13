import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness, until } from '../../terminal-harness.js';
import en from '../../../src/frontend/locales/en.js';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const evidence = path.resolve('docs/superpowers/admin-ui-refactor/evidence/task-7');
fs.mkdirSync(evidence, { recursive: true });
const out = process.env.TERMINAL_PAGE_REPORT_DIR || fs.mkdtempSync(path.join(evidence, 'browser-'));
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], errors: [], actions: [], input: [], resize: [], syntheticPeer: true, realPTY: false };
let server, browser, h, page, context;
let failMetadata = false;
const peers = [];
const pendingRoutes = new Set();
const drainRoutes = async () => { while (pendingRoutes.size) await Promise.all([...pendingRoutes]); };
const check = async (name, fn) => { await fn(); report.checks.push({ name, pass: true }); console.log(name); };
const assertNodeTargets = async (width, height) => {
  const targets = await page.evaluate(() => ['.terminal-language', '.help-tooltip-trigger'].map(selector => {
    const element = document.querySelector(selector), box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const layout = ['.terminal-node', '.terminal-node-identity', '.terminal-node-name', '.help-tooltip'].map(selector => { const el = document.querySelector(selector), rect = el.getBoundingClientRect(), css = getComputedStyle(el); return { selector, width: rect.width, minWidth: css.minWidth, display: css.display, flexShrink: css.flexShrink, overflow: css.overflow, whiteSpace: css.whiteSpace }; });
    return { selector, width: box.width, height: box.height, x: box.x, right: box.right, bottom: box.bottom, visible: box.width > 0 && box.height > 0, reachable: element === hit || element.contains(hit), layout };
  }));
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  for (const target of targets.filter(target => target.visible)) {
    assert.ok(target.x >= 0 && target.right <= width && target.bottom <= height && target.reachable, 'visible node control must remain reachable: ' + JSON.stringify(target));
    if (coarse) assert.ok(target.width >= 44 && target.height >= 44, 'coarse node control requires 44x44 target: ' + JSON.stringify(target));
    else assert.deepEqual([target.width, target.height], target.selector === '.terminal-language' ? [120, 32] : [17, 17], 'fine pointer geometry must remain unchanged');
  }
  return targets;
};
try {
  h = await harness();
  await h.db.prepare("UPDATE servers SET history_partition_id=1 WHERE id='node-a'").run();
  const at=Date.now();
  const body={id:'node-a',terminal_enabled:true,time:{local_ts:at},metrics:{cpu:'1',timestamp:at}};
  const old=await h.fetch('/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,secret:'test-report-secret'})});
  assert.equal(old.status,401);
  assert.equal((await (await h.action('terminal_status',{serverId:'node-a'})).json()).localEnabled,null);
  const observed=await h.fetch('/update',{method:'POST',headers:{'Content-Type':'application/json',...h.agentHeaders()},body:JSON.stringify(body)});
  assert.equal(observed.status,200);
  assert.equal((await (await h.action('terminal_status',{serverId:'node-a'})).json()).localEnabled,true);
  report.authenticatedOrdinaryReport=true;
  report.oldSecretDenied=true;
  const onControlMessage = async (data, binary) => {
    if (binary) return;
    const frame = JSON.parse(data.toString());
    if (frame.type !== 'open') return;
    const peer = await h.socket(`/api/agent/terminal/session/${frame.sessionId}`, { ...h.agentHeaders(), 'X-CFSM-Terminal-Ticket': frame.ticket });
    peers.push(peer);
    let consumed = 0;
    peer.ws.on('message', (data, binary) => {
      if (binary) {
        consumed += data.length;
        report.input.push(data.toString('utf8'));
        peer.ws.send(JSON.stringify({ type: 'ack', bytes: consumed }));
        peer.ws.send(data, { binary: true });
      } else {
        const value = JSON.parse(data.toString());
        if (value.type === 'resize') report.resize.push(value);
        if (value.type === 'ping') peer.ws.send('{"type":"pong"}');
      }
    });
    await until(() => peer.messages.some(data => typeof data === 'string' && JSON.parse(data).type === 'start'));
    peer.ws.send('{"type":"ready"}');
    peer.ws.send(Buffer.from('REAL BROKER / SYNTHETIC PEER\r\nFINAL OUTPUT\r\n'), { binary: true });
  };
  server = await createServer({ frontendExports: true, fixtureEntries: [path.resolve('test/fixtures/admin-ui/terminal-install-access.html')], cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  const httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`, origin = httpOrigin.replace('http:', 'https:');
  const bundle = fs.readdirSync(out).find(name => name.startsWith('compiled-fixture-'));
  const exports = JSON.parse(fs.readFileSync(path.join(out, bundle, 'build-receipt.json'))).exports;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: process.env.TERMINAL_PAGE_POINTER !== 'fine' });
  await context.addCookies([{ name: 'cfsm_auth', value: encodeURIComponent(h.token), url: origin, secure: true, httpOnly: true }]);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: () => new Promise((resolve, reject) => { window.clipboardResolve = resolve; window.clipboardReject = reject; }), writeText: async text => { window.copied = text; } } });
  });
  const handleRoute = async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/admin/api') {
      const data = req.postDataJSON(); report.actions.push(data.action);
      if (data.action.startsWith('terminal_')) {
        const response = await h.mf.dispatchFetch(req.url(), { method: 'POST', headers: await req.allHeaders(), body: req.postData() });
        return route.fulfill({ status: response.status, body: await response.text(), headers: { 'content-type': 'application/json' } });
      }
      if (failMetadata && data.action === 'list') return route.fulfill({ status: 503, json: { error: 'metadata_unavailable' } });
      return route.fulfill({ json: { servers: [{ id: 'node-a', name: 'Hong Kong production node with a long name', region: 'HK', os: 'Debian 12' }], settings: { site_title: 'CF Monitor' } } });
    }
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({ json: {} });
    const target = url.pathname === '/admin' ? '/test/fixtures/admin-ui/terminal-install-access.html' : url.pathname;
    return route.fulfill({ response: await route.fetch({ url: httpOrigin + target + url.search }) });
  };
  await context.route('**/*', route => {
    const pending = handleRoute(route);
    pendingRoutes.add(pending);
    pending.then(() => pendingRoutes.delete(pending), () => pendingRoutes.delete(pending));
    return pending;
  });
  await context.routeWebSocket('**/admin/api/terminal/**', async socket => {
    const peer = await h.socket(new URL(socket.url()).pathname, { Cookie: `cfsm_auth=${encodeURIComponent(h.token)}`, Origin: 'https://example.com' });
    assert.equal(peer.response.status, 101);
    for (const message of peer.messages) socket.send(typeof message === 'string' ? message : Buffer.from(message));
    peer.ws.on('message', (data, binary) => socket.send(binary ? data : data.toString()));
    peer.ws.on('close', () => socket.close());
    socket.onMessage(data => peer.ws.readyState === 1 && peer.ws.send(data, { binary: typeof data !== 'string' }));
    socket.onClose(() => peer.ws.close());
  });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.stack));
  await page.goto(`${origin}/admin?locale=en#/admin/terminal/node-a?apiIndex=0`);
  await check('enabled offline page auto-checks authority, reports offline without reservation, then explicit retry works', async () => {
    await page.locator('.terminal-error').waitFor();
    assert.ok((await page.locator('.terminal-error').innerText()).includes('terminal_agent_offline'));
    assert.equal(report.actions.filter(action => action === 'terminal_open').length,0);
    assert.equal(await page.getByRole('button',{name:en.terminalReopen,exact:true}).isDisabled(),false);
    const control = await h.control();
    control.ws.on('message',onControlMessage);
    await page.getByRole('button',{name:en.terminalReopen,exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.terminal-status')?.textContent.includes('Shell ready'));
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('id'); await page.keyboard.press('Enter');
    await until(() => report.input.join('').includes('id\r'));
    report.retryKeyboardBytes = report.input.join('');
    assert.equal(report.retryKeyboardBytes,'id\r');
    report.input.length = 0;
  });
  await page.waitForFunction(() => document.querySelector('.terminal-status')?.textContent.includes('Shell ready'));
  await check('standalone approved header and one reservation; session details collapsed', async () => {
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.admin-header').count(), 1);
    assert.equal(await page.locator('.terminal-dots, .admin-nav, #terminal-secret').count(), 0);
    assert.equal(report.actions.filter(action => action === 'terminal_open').length, 1);
    assert.equal(await page.locator('.terminal-session').getAttribute('open'), null);
    assert.ok((await page.locator('.terminal-node-name').innerText()).includes('Hong Kong'));
  });
  await check('visible coarse language/help controls have 44px targets; fine pointer geometry and long-name help stay unchanged', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('.terminal-page').getBoundingClientRect().height === 844);
    report.nodeTargets = await assertNodeTargets(390, 844);
    if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await page.locator('.help-tooltip-trigger').click();
    else await page.locator('.help-tooltip-trigger').focus();
    await page.getByRole('tooltip').waitFor();
    await page.locator('.help-tooltip-trigger').press('Escape');
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(out, 'node-touch-targets.png') });
  });
  await check('actual xterm foreground/background change without new socket or reservation', async () => {
    const colors = [];
    for (const theme of ['light', 'dark', 'auto']) {
      await page.evaluate(async ({ file, theme }) => (await import(file)).useTheme().setTheme(theme), { file: exports['/src/frontend/composables/useTheme.js'], theme });
      await page.waitForTimeout(120);
      const color = await page.locator('.xterm').evaluate(el => {
        const style = getComputedStyle(el.closest('.terminal-screen'));
        const rgba = color => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
        return { background: rgba(getComputedStyle(el.querySelector('.xterm-scrollable-element')).backgroundColor), foreground: rgba(getComputedStyle(el.querySelector('.xterm-rows')).color), expectedBackground: rgba(style.backgroundColor), expectedForeground: rgba(style.color) };
      });
      assert.deepEqual(color.background, color.expectedBackground, 'renderer must resolve the current background, not inherit old/fallback CSS');
      assert.deepEqual(color.foreground, color.expectedForeground, 'xterm injected foreground must equal computed theme color');
      colors.push(color);
    }
    assert.notDeepEqual(colors[0], colors[1]);
    assert.equal(colors[0].background[3], 255);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => !document.body.classList.contains('light'));
    await page.waitForTimeout(80);
    const autoDark = await page.locator('.xterm-rows').evaluate(el => getComputedStyle(el).color);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.body.classList.contains('light'));
    await page.waitForTimeout(80);
    assert.notEqual(await page.locator('.xterm-rows').evaluate(el => getComputedStyle(el).color), autoDark);
    assert.equal(report.actions.filter(action => action === 'terminal_open').length, 1);
    report.themeColors = colors;
  });
  await check('mobile IME commits whole UTF8; Enter composition does not consume confirmation', async () => {
    const input = page.locator('.terminal-mobile-input');
    await input.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.value = '中文';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '中文' }));
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
      el.dispatchEvent(enter); window.compositionEnterCancelled = enter.defaultPrevented;
    });
    assert.equal(await page.evaluate(() => window.compositionEnterCancelled), false);
    assert.equal(report.input.length, 0);
    await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
    await until(() => report.input.join('').includes('中文'));
    assert.equal(report.input.join(''), '中文');
  });
  await check('modifiers and asynchronous clipboard stay current-session owned', async () => {
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await page.locator('.terminal-mobile-input').fill('c');
    await until(() => report.input.join('').includes('\x03'));
    await page.getByRole('button', { name: 'Alt', exact: true }).click();
    await page.locator('.terminal-mobile-input').fill('x');
    await until(() => report.input.join('').includes('\x1bx'));
    await page.getByRole('button', { name: en.terminalPaste, exact: true }).click();
    await page.locator('.terminal-mobile-input').evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.value = '旧会话';
    });
    await page.getByRole('button', { name: en.terminalDisconnect, exact: true }).click();
    await page.getByRole('button', { name: en.terminalReopen, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.terminal-status')?.textContent.includes('Shell ready'));
    const count = report.input.length;
    await page.locator('.terminal-mobile-input').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '旧会话' })));
    await page.evaluate(() => window.clipboardResolve('STALE'));
    await page.waitForTimeout(80);
    assert.equal(report.input.length, count);
    assert.equal(await page.locator('.terminal-mobile-input').inputValue(), '');
  });
  await check('seven locales desktop/mobile themes and low keyboard viewport retain output/input/disconnect/risk', async () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'es', 'fr', 'id', 'ja']) {
      await page.evaluate(async ({ file, locale }) => (await import(file)).setLanguage(locale), { file: exports['/src/frontend/utils/i18n.js'], locale });
      for (const [width, height] of [[1440, 900], [1024, 768], [768, 620], [390, 844], [320, 540], [640, 320], [320, 280]]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(() => Math.abs(document.querySelector('.terminal-page').getBoundingClientRect().height - innerHeight) < 1);
        for (const theme of ['light', 'dark', 'auto']) {
          await page.evaluate(async ({ file, theme }) => (await import(file)).useTheme().setTheme(theme), { file: exports['/src/frontend/composables/useTheme.js'], theme });
          const geometry = await page.evaluate(() => {
            const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, height: r.height }; };
            return { screen: rect('.terminal-screen'), input: rect('.terminal-mobile-input'), disconnect: rect('[data-terminal-disconnect]'), risk: rect('.terminal-risk'), page: document.documentElement.scrollHeight, viewport: innerHeight };
          });
          assert.ok(geometry.screen.height >= 48, JSON.stringify({ locale, width, height, geometry }));
          for (const key of ['input', 'disconnect', 'risk']) assert.ok(geometry[key].height > 0 && geometry[key].bottom <= height + 1, JSON.stringify({ locale, width, height, key, geometry }));
          assert.ok(geometry.disconnect.x >= 0 && geometry.disconnect.right <= width, 'disconnect must be immediately visible horizontally: ' + JSON.stringify({ locale, width, height, geometry }));
          assert.ok(geometry.page <= height + 1, JSON.stringify({ locale, width, height, geometry }));
          const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
          if (coarse) assert.ok(geometry.disconnect.height >= 44 && geometry.input.height >= 44);
          const nodeTargets = await assertNodeTargets(width, height);
          report.checks.push({ name: `${locale}/${width}x${height}/${theme}/${coarse ? 'coarse' : 'fine'}`, pass: true, geometry, nodeTargets });
          if (locale === 'en' || width === 320) await page.screenshot({ path: path.join(out, `${locale}-${width}-${height}-${theme}.png`) });
        }
      }
    }
    assert.ok(report.resize.length > 0);
    assert.equal(report.actions.filter(action => action === 'terminal_open').length, 2);
  });
  await check('visualViewport-only keyboard resize fits existing renderer without reconnect', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      window.originalViewport = window.visualViewport;
      const viewport = new EventTarget();
      viewport.height = 300;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      // The existing listener belongs to the original viewport, while its callback reads current height.
      window.originalViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => document.querySelector('.terminal-page').getBoundingClientRect().height === 300);
    assert.ok((await page.locator('.terminal-screen').boundingBox()).height >= 48);
    assert.ok((await page.locator('.terminal-mobile-input').boundingBox()).y < 300);
    assert.ok((await page.locator('[data-terminal-disconnect]').boundingBox()).y < 300);
    assert.equal(report.actions.filter(action => action === 'terminal_open').length, 2);
    await page.screenshot({ path: path.join(out, 'visualViewport-keyboard.png') });
    await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.originalViewport }); window.visualViewport.dispatchEvent(new Event('resize')); });
  });
  await check('metadata failure falls back to ID; actual transport error keeps final output and safe disconnect', async () => {
    failMetadata = true;
    await page.goto(`${origin}/admin?locale=en#/admin/terminal/node-a?apiIndex=0`);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.terminal-status')?.textContent.includes('Shell ready'));
    assert.equal(await page.locator('.terminal-node-name').innerText(), 'node-a');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('FINAL OUTPUT'));
    peers.at(-1).ws.close();
    await page.locator('.terminal-error').waitFor();
    assert.ok((await page.locator('.xterm-rows').innerText()).includes('FINAL OUTPUT'));
    assert.equal(await page.locator('[data-terminal-disconnect]').isDisabled(), true);
    failMetadata = false;
  });
  await check('unauthenticated direct page cannot reserve despite frontend authorization flag', async () => {
    const before = report.actions.filter(action => action === 'terminal_open').length;
    await context.clearCookies();
    const denied = await context.newPage();
    await denied.goto(`${origin}/admin?locale=en#/admin/terminal/node-a`);
    await denied.locator('.terminal-error').waitFor();
    assert.equal(report.actions.filter(action => action === 'terminal_open').length, before);
    assert.equal(await denied.locator('.xterm').count(), 0);
    await denied.waitForLoadState('networkidle');
    await drainRoutes();
    await denied.close();
    await context.addCookies([{ name: 'cfsm_auth', value: encodeURIComponent(h.token), url: origin, secure: true, httpOnly: true }]);
  });
  await check('long fallback ID stays truncated and unavailable capability cannot reserve', async () => {
    const before = report.actions.filter(action => action === 'terminal_open').length;
    const denied = await context.newPage(), id = 'node-' + 'x'.repeat(100);
    await denied.setViewportSize({ width: 320, height: 844 });
    await denied.goto(`${origin}/admin?locale=en#/admin/terminal/${id}`);
    await denied.locator('.terminal-error').waitFor();
    assert.equal(await denied.locator('.terminal-node-name').innerText(), id);
    assert.equal(await denied.locator('.terminal-node-name').getAttribute('title'), id);
    assert.equal(await denied.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(report.actions.filter(action => action === 'terminal_open').length, before);
    await denied.screenshot({ path: path.join(out, 'long-id-unavailable.png') });
    await denied.waitForLoadState('networkidle');
    await drainRoutes();
    await denied.close();
  });
  await check('disconnect retains final output; back preserves apiIndex and disposes', async () => {
    assert.ok((await page.locator('.xterm-rows').innerText()).includes('FINAL OUTPUT'));
    await page.locator('[data-terminal-back]').click();
    assert.ok(page.url().endsWith('#/admin?apiIndex=0'));
    assert.equal(await page.locator('.terminal-screen').count(), 0);
    await page.waitForLoadState('networkidle');
    await drainRoutes();
  });
} catch (error) {
  report.errors.push(error.stack);
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  await context?.unrouteAll({behavior:'wait'});
  await drainRoutes();
  await browser?.close(); await server?.close(); await h?.dispose();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
