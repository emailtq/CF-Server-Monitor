import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import en from '../../../src/frontend/locales/en.js';

const { chromium } = createRequire(import.meta.url)(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.ADMIN_DOWNLOAD_REPORT_DIR || `.planning/2026-11-13-admin-ui-polish/task2/run-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, checks: [], errors: [], geometry: [], screenshots: [], actions: [], mockBoundary: 'actual mounted Vue + real frontend HTTP/ownership; synthetic issuer/GitHub/clipboard; controlled parent command only in ownership tests' };
let server, browser, context, page, origin, httpOrigin;
let tokens, permissions, actions, metadata, held = [], holdAction = '', resetError = '', readError = '', loseReset = false, deferredMutation = false;
const releaseHeld = () => held.splice(0).forEach(resolve => resolve());
const count = action => actions.filter(item => item.action === action).length;
const dialog = () => page.locator('.admin-dialog-download');
const command = () => dialog().locator('pre').innerText();
const ready = () => page.waitForFunction(() => document.querySelector('[data-copy-command]')?.disabled === false);
const idle = () => page.waitForFunction(() => !document.querySelector('[data-confirm-reissue]')?.disabled);
const nextFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const load = async ({ controlled = true, locale = 'en', width = 1440, dark = false } = {}) => {
  releaseHeld(); holdAction = resetError = readError = ''; loseReset = deferredMutation = false;
  await page.goto('about:blank');
  tokens = { 'node-a': 'a'.repeat(64), 'node-b': 'b'.repeat(64) };
  permissions = { 'node-a': false, 'node-b': false }; actions = []; metadata = 0;
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.goto(`${origin}/admin?locale=${locale}${controlled ? '&controlled=1' : ''}#/admin`);
  await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
  if (!controlled) {
    await page.locator('.server-row').first().waitFor();
    await page.locator('[data-server-id=node-a]').getByRole('button', { name: (await import(`../../../src/frontend/locales/${locale}.js`)).default.copy, exact: true }).click();
  }
  await ready();
  await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
  assert.equal(await dialog().evaluate(el => getComputedStyle(el).colorScheme), dark ? 'dark' : 'light');
};
const rotate = async () => {
  await dialog().locator('[data-terminal-reissue]').click();
  await page.locator('.admin-dialog-download-confirm').waitFor();
  await page.locator('[data-confirm-reissue]').click();
};
const heldRequest = async () => {
  await page.waitForFunction(() => window.pendingFixtureRequest === true);
  assert.ok(held.length > 0);
};
const check = async (name, fn) => {
  try { await fn(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) {
    report.checks.push({ name, pass: false, error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`);
    await page?.screenshot({ path: path.join(out, `failure-${report.checks.length}.png`) }).catch(() => {});
    releaseHeld();
  }
};
try {
  server = await createServer({ frontendExports: true, fixtureEntries: [path.resolve('test/fixtures/admin-ui/download.html')], cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`; origin = httpOrigin.replace('http:', 'https:');
  browser = await chromium.launch({ headless: true, executablePath: process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  report.chromium = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text } } }));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://api.github.com') {
      metadata++;
      if (url.pathname.includes('/contents/')) {
        const cli = 'fs.StringVar(&nodeTokenFile,"token-file","","")\nfs.StringVar(&registerKey,"register-key","","")\nfs.StringVar(&terminal,"terminal","","")';
        return route.fulfill({ json: { encoding: 'base64', content: Buffer.from(url.pathname.includes('terminal_control.go') ? 'func (a *Agent) startTerminal(ctx context.Context) {}' : cli).toString('base64') } });
      }
      const tag = url.pathname.includes('/tags/') ? decodeURIComponent(url.pathname.split('/tags/')[1]) : 'task2.synthetic';
      return route.fulfill({ json: { tag_name: tag, draft: false, assets: ['linux-amd64', 'darwin-arm64', 'windows-amd64.exe', 'freebsd-amd64'].map(platform => ({ name: 'cf-probe-' + platform, state: 'uploaded', browser_download_url: `https://github.com/emailtq/cfsm-agent/releases/download/${tag}/cf-probe-${platform}` })) } });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/admin/api') {
      const data = request.postDataJSON(); actions.push(data); report.actions.push({ action: data.action, serverId: data.serverId });
      if (['node_read_install', 'terminal_enable_install', 'node_reset_token'].includes(data.action)) {
        const error = data.action === 'node_reset_token' ? resetError : data.action === 'node_read_install' ? readError : '';
        const mutate = () => {
          if (data.action === 'node_reset_token' && !error) tokens[data.serverId] = (tokens[data.serverId][0] === 'c' ? 'd' : 'c').repeat(64);
          if (data.action === 'terminal_enable_install' && !error) permissions[data.serverId] = true;
        };
        if (!deferredMutation) mutate();
        const snapshot = { token: tokens[data.serverId], enabled: permissions[data.serverId], needsRotation: false };
        if (holdAction === data.action) {
          holdAction = '';
          await page.evaluate(() => { window.pendingFixtureRequest = true });
          await new Promise(resolve => held.push(resolve));
          await page.evaluate(() => { window.pendingFixtureRequest = false }).catch(() => {});
        }
        if (deferredMutation) mutate();
        if (data.action === 'node_reset_token' && loseReset) { loseReset = false; return route.abort(); }
        const json = error ? { error } : deferredMutation ? { token: tokens[data.serverId], enabled: permissions[data.serverId], needsRotation: false } : snapshot;
        return route.fulfill({ status: error ? 409 : 200, json }).catch(() => {});
      }
      if (data.action === 'terminal_status') return route.fulfill({ json: { nodes: {} } });
      return route.fulfill({ json: { settings: { site_title: 'Fixture', username: 'fixture', terminal_enabled: true }, servers: [{ id: 'node-a', name: 'Node A', os: 'Linux' }, { id: 'node-b', name: 'Node B', os: 'Windows' }], stats: { total: 2 } } });
    }
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({ json: {} });
    const response = await route.fetch({ url: httpOrigin + (url.pathname === '/admin' ? '/test/fixtures/admin-ui/download.html' : url.pathname) + url.search });
    return route.fulfill({ response });
  });
  page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => report.errors.push(error.stack));

  await check('switch checked/unchecked/disabled track and thumb remain distinct in both themes', async () => {
    for (const dark of [false, true]) {
      await load({ dark });
      const sw = dialog().locator('[data-auto-update]');
      const css = () => sw.evaluate(el => { const c = getComputedStyle(el), p = getComputedStyle(el, '::before'); return { color: c.backgroundColor, opacity: c.opacity, width: c.width, height: c.height, thumb: p.backgroundColor, transform: p.transform } });
      const off = await css(); await sw.check(); const on = await css();
      assert.notEqual(off.color, on.color, `checked track must not be overridden (${dark})`);
      assert.notEqual(off.transform, on.transform); assert.equal(on.width, '32px'); assert.equal(on.height, '18px');
      assert.notEqual(on.thumb, on.color);
      await sw.evaluate(el => { el.disabled = true }); const disabledOn = await css();
      await sw.evaluate(el => { el.checked = false }); const disabledOff = await css();
      assert.ok(Number(disabledOn.opacity) < Number(on.opacity)); assert.notEqual(disabledOn.color, disabledOff.color);
      report.geometry.push({ dark, off, on, disabledOn, disabledOff });
    }
  });
  await check('language changes do not reread or interrupt a pending reset', async () => {
    await load(); const reads = count('node_read_install'), lookups = metadata;
    await page.evaluate(() => window.downloadFixture.setLanguage('zh')); await nextFrame();
    assert.equal(count('node_read_install'), reads, 'translation is not credential identity'); assert.equal(metadata, lookups);
    holdAction = 'node_reset_token'; await rotate(); await heldRequest();
    await page.evaluate(() => window.downloadFixture.setLanguage('ja')); await nextFrame();
    assert.equal(count('node_read_install'), reads); assert.equal(await dialog().locator('[data-copy-command]').isDisabled(), true);
    releaseHeld(); await ready(); assert.ok((await command()).includes(tokens['node-a']));
  });
  await check('failed reset stays explicit even when recovery can read the old credential', async () => {
    await load(); const old = tokens['node-a']; resetError = 'rotation_fixture_failed'; await rotate();
    await page.locator('.admin-dialog-download-confirm').waitFor({ state: 'hidden' }); await ready();
    assert.ok((await command()).includes(old));
    const error = dialog().locator('[data-credential-error]'); await error.waitFor();
    assert.ok((await error.innerText()).includes('rotation_fixture_failed'));
    assert.equal(await dialog().locator('[data-credential-status]').count(), 0, 'failed request must not become success');
  });
  await check('confirmation cancel, focus trap and immediate single-request pending feedback', async () => {
    await load();
    await dialog().locator('[data-terminal-reissue]').click();
    const confirm = page.locator('.admin-dialog-download-confirm');
    assert.ok((await confirm.locator('h2').innerText()).includes('node-a'), 'destructive confirmation names the affected node');
    const description = await confirm.getAttribute('aria-describedby');
    assert.ok(description, 'screen readers must receive the destructive warning');
    assert.equal(await confirm.locator(`[id="${description}"]`).innerText(), en.downloadReissueConfirm);
    await confirm.locator('footer button').last().focus(); await page.keyboard.press('Tab');
    assert.equal(await confirm.evaluate(el => el.contains(document.activeElement)), true);
    await page.locator('#outside').evaluate(el => el.focus()); assert.equal(await confirm.evaluate(el => el.contains(document.activeElement)), true);
    await confirm.locator('footer button').first().click(); assert.equal(count('node_reset_token'), 0);
    await dialog().locator('[data-terminal-reissue]').click(); holdAction = 'node_reset_token';
    const immediate = await page.locator('[data-confirm-reissue]').evaluate(async el => {
      el.click(); el.click(); await Promise.resolve();
      return { disabled: el.disabled, busy: el.closest('[role=dialog]').getAttribute('aria-busy'), text: el.textContent, copyDisabled: document.querySelector('[data-copy-command]').disabled };
    });
      report.pendingFeedback = immediate;
      assert.equal(immediate.disabled, true); assert.equal(immediate.busy, 'true'); assert.equal(immediate.copyDisabled, true);
    assert.equal(immediate.text.trim(), en.downloadReissuing); await heldRequest(); assert.equal(count('node_reset_token'), 1);
    await page.keyboard.press('Escape'); assert.equal(await confirm.count(), 1);
    await page.locator('[data-confirm-reissue]').evaluate(el => el.click()); assert.equal(count('node_reset_token'), 1);
    releaseHeld(); await ready(); await confirm.waitFor({ state: 'hidden' });
    assert.ok((await command()).includes(tokens['node-a'])); assert.ok(!(await command()).includes('a'.repeat(64)));
    assert.equal(await dialog().locator('[data-credential-status]').innerText(), en.downloadReissued);
    assert.equal(await dialog().evaluate(el => el.contains(document.activeElement)), true);
  });
  await check('lost reset reply recovers current token without swallowing the uncertain result', async () => {
    await load(); loseReset = true; holdAction = 'node_read_install'; await rotate(); await heldRequest();
    assert.equal(await dialog().locator('[data-copy-command]').isDisabled(), true); assert.ok(!(await command()).includes('a'.repeat(64)));
    releaseHeld(); await ready(); assert.ok((await command()).includes(tokens['node-a']));
    await dialog().locator('[data-credential-error]').waitFor(); assert.equal(await dialog().locator('[data-credential-status]').count(), 0);
    assert.equal(count('node_reset_token'), 1); assert.equal(count('node_read_install'), 2);
  });
  await check('lost reset and failed recovery block old command and show a real error', async () => {
    await load(); loseReset = true; readError = 'credential_fixture_unavailable'; await rotate();
    await page.locator('.admin-dialog-download-confirm').waitFor({ state: 'hidden' });
    assert.equal(await dialog().locator('[data-copy-command]').isDisabled(), true); assert.ok(!(await command()).includes('a'.repeat(64)));
    await dialog().locator('[data-credential-error]').waitFor();
  });
  await check('close/reopen during pending reset waits for authority and cannot send a second reset', async () => {
    await load(); holdAction = 'node_reset_token'; deferredMutation = true; await rotate(); await heldRequest();
    await page.evaluate(() => { window.downloadFixture.state.show = false }); await nextFrame();
    await page.evaluate(() => { const s = window.downloadFixture.state; s.apiIndex = 1; s.generation++; s.show = true }); await dialog().waitFor(); await nextFrame();
    assert.equal(count('node_read_install'), 1, 'reopen must wait for the outstanding mutation before rereading');
    assert.equal(await dialog().locator('[data-copy-command]').isDisabled(), true);
    assert.equal(await dialog().locator('[data-terminal-reissue]').isDisabled(), true);
    releaseHeld(); await ready(); assert.ok((await command()).includes(tokens['node-a'])); assert.equal(count('node_read_install'), 2);
    assert.equal(count('node_reset_token'), 1); assert.equal(await dialog().locator('[data-credential-status]').count(), 0, 'old dialog success must not leak into reopened dialog');
  });
  await check('site ABA and node changes reject old pending credential/error/success replies', async () => {
    for (const change of ['node', 'siteABA']) for (const failure of [false, true]) {
      await load(); holdAction = 'node_reset_token'; resetError = failure ? 'stale_fixture_error' : ''; await rotate(); await heldRequest();
      if (change === 'node') await page.evaluate(() => { window.downloadFixture.state.serverId = 'node-b' });
      else {
        await page.evaluate(() => { const s = window.downloadFixture.state; s.apiIndex = 99; s.generation++ }); await nextFrame();
        await page.evaluate(() => { const s = window.downloadFixture.state; s.apiIndex = 0; s.generation++ });
      }
      await nextFrame(); releaseHeld(); await ready();
      assert.ok((await command()).includes(tokens[change === 'node' ? 'node-b' : 'node-a']));
      assert.equal(await dialog().locator('[data-credential-error]').count(), 0); assert.equal(await dialog().locator('[data-credential-status]').count(), 0);
      assert.equal(count('node_reset_token'), 1);
    }
  });
  await check('late reads and multiple identity props produce one current read and no stale token', async () => {
    await load(); holdAction = 'node_read_install';
    await page.evaluate(() => { window.downloadFixture.state.show = false }); await nextFrame();
    await page.evaluate(() => { window.downloadFixture.state.show = true }); await heldRequest();
    const before = count('node_read_install');
    await page.evaluate(() => { const s = window.downloadFixture.state; s.serverId = 'node-b'; s.generation++ }); await ready();
    assert.equal(count('node_read_install'), before + 1);
    releaseHeld(); await nextFrame(); assert.ok((await command()).includes(tokens['node-b'])); assert.ok(!(await command()).includes(tokens['node-a']));
  });
  await check('full Admin retains all OS, version, proxy, user, auto-update and canonical terminal command paths', async () => {
    await load({ controlled: false }); assert.equal(count('node_read_install'), 1);
    for (const os of ['linux', 'unix', 'mac', 'windows', 'docker']) {
      await dialog().locator('[data-target-os]').selectOption(os);
      if (os === 'docker') { await dialog().locator('[data-install-blocked]').waitFor(); assert.equal(await dialog().locator('[data-copy-command]').isDisabled(), true); }
      else { await ready(); const text = await command(); assert.equal(text.split(tokens['node-a']).length - 1, 1); assert.match(text, /-terminal=0/); assert.doesNotMatch(text, /-secret=|terminal-token/); }
      assert.equal(await dialog().locator('[data-terminal-reissue]').isEnabled(), true);
    }
    await dialog().locator('[data-target-os]').selectOption('linux'); await ready();
    await dialog().locator('[data-install-mode]').selectOption('cfsm-user'); assert.match(await command(), /runuser -u cfsm/);
    await dialog().locator('#download-proxy').selectOption('https://ghfast.top/'); assert.match(await command(), /https:\/\/ghfast.top\/https:\/\/raw.githubusercontent.com/);
    await dialog().locator('[data-install-version]').fill('task2.synthetic'); await ready(); assert.match(await command(), /task2.synthetic/);
    await dialog().locator('[data-auto-update]').check(); assert.match(await command(), /-auto_update=1/);
    await dialog().locator('[data-terminal-install]').check(); await ready(); assert.match(await command(), /-terminal=1/); assert.equal(count('terminal_enable_install'), 1);
    await dialog().locator('[data-copy-command]').click(); assert.equal(await page.evaluate(() => window.copied), await command());
    assert.equal(await page.evaluate(token => Object.values({ ...localStorage, ...sessionStorage }).some(value => String(value).includes(token)), tokens['node-a']), false);
    await rotate(); await page.locator('.admin-dialog-download-confirm').waitFor({ state: 'hidden' }); await ready();
    const feedback = await dialog().locator('[data-credential-status]').boundingBox();
    const body = await dialog().locator('.admin-dialog-body').boundingBox();
    assert.ok(feedback.y >= body.y && feedback.y + feedback.height <= body.y + body.height, 'success feedback must be visible after a long-command reset, without another scroll');
  });
  await check('destructive confirmation is readable in light and dark themes', async () => {
    for (const dark of [false, true]) {
      await load({ dark }); await dialog().locator('[data-terminal-reissue]').click();
      const contrast = await page.locator('[data-confirm-reissue]').evaluate(el => {
        const css = getComputedStyle(el), ctx = document.createElement('canvas').getContext('2d');
        const luminance = color => {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
          const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 });
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const text = luminance(css.color), background = luminance(css.backgroundColor);
        return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
      });
      assert.ok(contrast >= 4.5, `confirmation text needs 4.5 contrast (${dark}: ${contrast})`);
      report.geometry.push({ dark, confirmContrast: contrast });
    }
  });
  await check('short mobile viewport still has one body scroll and reachable footer', async () => {
    await load({ controlled: false, width: 320 });
    await page.setViewportSize({ width: 320, height: 480 });
    const geometry = await dialog().evaluate(el => {
      const body = el.querySelector('.admin-dialog-body'), footer = el.querySelector('footer'); body.scrollTop = body.scrollHeight;
      return { bodyScroll: body.scrollHeight > body.clientHeight, bottom: footer.getBoundingClientRect().bottom, height: innerHeight, commandScroll: el.querySelector('pre').scrollHeight > el.querySelector('pre').clientHeight };
    });
    assert.equal(geometry.bodyScroll, true); assert.equal(geometry.commandScroll, false); assert.ok(geometry.bottom <= geometry.height - 15);
    assert.equal(await dialog().locator('[data-copy-command]').isEnabled(), true);
    await dialog().locator('[data-copy-command]').click(); assert.equal(await page.evaluate(() => window.copied), await command());
  });
  for (const locale of ['zh', 'en', 'ja']) for (const width of [320, 360, 390, 1440]) for (const dark of [false, true]) await check(`readable full Admin geometry ${locale}/${width}/${dark ? 'dark' : 'light'}`, async () => {
    await load({ controlled: false, locale, width, dark });
    for (const os of ['linux', 'unix', 'mac', 'windows', 'docker']) {
      await dialog().locator('[data-target-os]').selectOption(os);
      if (os === 'docker') await dialog().locator('[data-install-blocked]').waitFor(); else await ready();
      const geometry = await dialog().evaluate(d => {
        const rows = [...d.querySelectorAll('.download-option-row')].filter(row => row.querySelector(':scope > .form-input,:scope > .form-select,:scope > .download-option-control'));
        return { scheme: getComputedStyle(d).colorScheme, overflow: d.scrollWidth > d.clientWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth,
          rows: rows.map(row => { const label = row.querySelector('label'), control = row.querySelector(':scope > .form-input,:scope > .form-select,:scope > .download-option-control'); const l = label.getBoundingClientRect(), c = control.getBoundingClientRect(); return { labelBottom: l.bottom, controlTop: c.top, width: c.width, rowWidth: row.clientWidth, font: getComputedStyle(control).fontSize } }),
          commandOverflow: getComputedStyle(d.querySelector('pre')).overflowY, commandScrolls: d.querySelector('pre').scrollHeight > d.querySelector('pre').clientHeight,
          bodyScrolls: d.querySelector('.admin-dialog-body').scrollHeight > d.querySelector('.admin-dialog-body').clientHeight,
          footer: d.querySelector('footer').getBoundingClientRect().bottom, viewport: innerHeight };
      });
      assert.equal(geometry.overflow, false); assert.equal(geometry.pageOverflow, false);
      assert.equal(geometry.scheme, dark ? 'dark' : 'light');
      if (width < 640) for (const row of geometry.rows) { assert.ok(row.controlTop >= row.labelBottom - 1, 'mobile controls must sit below labels'); assert.ok(Math.abs(row.width - row.rowWidth) < 2); }
      assert.equal(geometry.commandScrolls, false, 'command must wrap within the only body scroller'); assert.ok(geometry.footer <= geometry.viewport - 15);
      report.geometry.push({ locale, width, dark, os, ...geometry });
      if (os === 'unix') { const hint = dialog().locator('[data-os-hint]'); await hint.waitFor(); assert.match(await hint.innerText(), /OpenWrt.*Alpine.*Synology DSM.*FreeBSD/); }
    }
    await dialog().locator('[data-target-os]').selectOption('linux'); await ready();
    await dialog().locator('[data-install-mode]').selectOption('cfsm-user');
    const selectedOption = await dialog().locator('[data-install-mode]').evaluate(el => {
      const css = getComputedStyle(el), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); ctx.font = css.font;
      return { measured: ctx.measureText(el.selectedOptions[0].textContent).width, available: el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) - 20 };
    });
    assert.ok(selectedOption.measured <= selectedOption.available, 'installation mode must be readable without shrinking or clipping');
    await dialog().locator('#download-proxy').selectOption('__custom__');
    const longProxy = 'https://proxy.example.test/a/deliberately/long/prefix/that/must/remain/readable/';
    await dialog().locator('input[aria-label]').last().fill(longProxy);
    const hint = dialog().locator('[data-proxy-hint]'); await hint.waitFor(); assert.equal(await hint.innerText(), longProxy);
    assert.equal(await hint.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await dialog().locator('[data-auto-update]').check();
    const shot = path.join(out, `download-${locale}-${width}-${dark ? 'dark' : 'light'}.png`);
    await page.screenshot({ path: shot }); report.screenshots.push(shot);
    if (width === 320 || width === 390) {
      await dialog().locator('.admin-dialog-body').evaluate(el => { el.scrollTop = el.scrollHeight });
      const bottomShot = path.join(out, `download-bottom-${locale}-${width}-${dark ? 'dark' : 'light'}.png`);
      await page.screenshot({ path: bottomShot }); report.screenshots.push(bottomShot);
    }
    await dialog().locator('[data-terminal-reissue]').click();
    assert.ok((await page.locator('.download-confirm-text').innerText()).length > 0);
    assert.equal(await page.locator('.admin-dialog-download-confirm').evaluate(el => el.scrollWidth > el.clientWidth), false);
    if (width === 320 || width === 1440) {
      const confirmShot = path.join(out, `confirm-${locale}-${width}-${dark ? 'dark' : 'light'}.png`);
      await page.screenshot({ path: confirmShot }); report.screenshots.push(confirmShot);
    }
  });
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(error.stack); console.error(error.stack); }
finally {
  releaseHeld(); await browser?.close(); await server?.close();
  report.closed = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
if (report.errors.length || report.checks.some(check => !check.pass)) process.exitCode = 1;
