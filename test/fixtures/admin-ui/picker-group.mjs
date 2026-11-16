import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { pickerGroupD1 } from './picker-group-d1.mjs';
import { pickerGroupVisual } from './picker-group-visual.mjs';
import { keyboardPaint } from './keyboard-paint.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const out = path.resolve(process.env.PICKER_GROUP_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `round5-picker-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
const report = { node: process.version, physicalAndroid: false, checks: [], traces: [], bounds: [], screenshots: [], errors: [] };
let server, browser, context, page;
let transport;
const frames = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = async (name, run) => { await run(); report.checks.push(name); console.log('PASS ' + name); };
const shot = async (p, name) => {
  const coarse = await p.evaluate(() => matchMedia('(pointer:coarse)').matches), file = path.join(out, `${name}.png`);
  const cdp = await p.context().newCDPSession(p);
  try {
    const before = await p.evaluate(() => [innerWidth, innerHeight]);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    assert.deepEqual(await p.evaluate(() => [innerWidth, innerHeight]), before, 'capture must not restore a stale Playwright viewport');
  }
  finally { await cdp.detach(); }
  report.screenshots.push(file);
  assert.equal(await p.evaluate(() => matchMedia('(pointer:coarse)').matches), coarse, 'viewport screenshot preserves actual pointer mode');
};
const open = async kind => {
  await page.evaluate(kind => dialogFixture.open(kind), kind); await page.getByRole('dialog').last().waitFor(); await frames(page);
};
try {
  server = await createServer({ plugins: [vue()], publicDir: path.resolve('public'), vueFixtureDevtools: true, fixtureEntries: ['dialogs.html', 'named-pages.html'].map(file => path.resolve('test/fixtures/admin-ui', file)), cacheDir: path.join(out, '.cache'), apiMiddlewarePlugin: { name: 'picker-group-authenticated-worker-d1', configureServer(vite) { vite.middlewares.use((req, res, next) => transport ? transport(req, res, next) : next()); } } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: process.env.ADMIN_UI_CHROMIUM || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe') });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/admin/api')) return route.fulfill({ json: { settings: {}, servers: [], stats: {} } });
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => report.errors.push(error.stack));
  await page.goto(`${origin}/test/fixtures/admin-ui/dialogs.html?locale=zh#/admin`); await page.waitForFunction(() => window.dialogFixture);
  if (process.argv.includes('--keyboard-paint-only')) await keyboardPaint({ page, context, open, frames, report, shot });
  if (!process.argv.includes('--visual-only') && !process.argv.includes('--motion-only') && !process.argv.includes('--keyboard-paint-only')) {
    await open('alert');
    await page.evaluate(() => {
      window.pickerEvents = [];
      for (const type of ['pointerdown', 'mousedown', 'click', 'focusin', 'focusout', 'input', 'compositionstart', 'compositionend', 'scroll']) document.addEventListener(type, event => pickerEvents.push({ type, trusted: event.isTrusted, target: event.target.tagName, className: event.target.className, active: document.activeElement.tagName, related: event.relatedTarget?.tagName }), true);
      for(const type of ['resize','scroll']) visualViewport.addEventListener(type,event=>pickerEvents.push({type:'visualViewport.'+type,trusted:event.isTrusted,height:visualViewport.height,top:visualViewport.offsetTop,active:document.activeElement.tagName}));
    });
    const input = page.locator('.admin-picker-summary').first();
    await input.tap(); await page.locator('.admin-picker-menu').waitFor();
    if (await input.evaluate(el => el.tagName !== 'INPUT')) {
      await page.locator('.admin-picker-search input').tap(); await frames(page);
      report.traces.push({ kind: 'baseline-two-focus-owners', events: await page.evaluate(() => pickerEvents), persistentInputs: await page.locator('.admin-picker > input').count(), secondSearch: await page.locator('.admin-picker-search input').count() });
      await shot(page, 'baseline-second-search');
    }
    await check('touch opens the persistent input itself, with no second search or focus handoff', async () => {
      assert.equal(await input.evaluate(el => el.tagName), 'INPUT', 'the picker must be the input, not a button plus remounted search');
      assert.equal(await input.evaluate(el => document.activeElement === el), true);
      assert.equal(await page.locator('.admin-picker-search input').count(), 0);
      assert.equal(await input.evaluate(el=>getComputedStyle(el).paddingRight),'44px','the native search clear button needs its own space before the arrow');
    });
    await check('filter/select/arrows/reopen keep the same input and never filter the stored selection', async () => {
      await input.evaluate(el => { window.pickerInput = el; window.pickerEvents.length = 0; });
      await input.fill('29 '); await page.locator('.admin-picker-option input[value="node-29"]').uncheck();
      await frames(page);
      assert.equal(await input.evaluate(el => el === pickerInput && el === document.activeElement), true, 'native option click keeps input focus');
      assert.equal(await page.evaluate(() => dialogFixture.state.props.draft.scope.serverIds.length), 29);
      await input.fill('no-result'); assert.equal(await page.locator('.admin-picker-empty').count(), 1);
      assert.equal(await page.evaluate(() => dialogFixture.state.props.draft.scope.serverIds.length), 29);
      await page.locator('.admin-picker-arrow').first().tap(); assert.equal(await page.locator('.admin-picker-menu').count(),0); assert.equal(await input.evaluate(el=>el===document.activeElement),true);
      await page.locator('.admin-picker-arrow').first().tap(); assert.equal(await page.locator('.admin-picker-menu').count(),1); assert.equal(await input.evaluate(el=>el===document.activeElement),true);
      await input.fill(''); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home');
      assert.equal(await input.evaluate(el => document.getElementById(el.getAttribute('aria-activedescendant')).querySelector('input').hasAttribute('data-scope-all')), true);
      await page.keyboard.press('Space'); await frames(page);
      assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(dialogFixture.state.props.draft.scope))), { mode: 'all', serverIds: [] });
      await page.keyboard.press('End'); assert.equal(await input.evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.admin-picker-menu').count(), 0); assert.equal(await input.inputValue(), '');
      await input.tap(); assert.equal(await input.evaluate(el => el === pickerInput && el === document.activeElement), true);
      report.traces.push({ kind: 'filter-select-keyboard', events: await page.evaluate(() => pickerEvents) });
      assert.deepEqual((await page.evaluate(() => pickerEvents)).filter(e => e.type === 'focusout'), [], 'selection/filter/open-close cannot hand off focus');
    });
    await check('trusted Chromium composition and continuous visual viewport events keep focus, selection and input DOM', async () => {
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.imeSetComposition', { text: '分组搜索', selectionStart: 1, selectionEnd: 3 }); await frames(page);
        assert.ok((await page.evaluate(() => pickerEvents)).some(e => e.type === 'compositionstart' && e.trusted));
        await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })));
        assert.equal(await page.locator('.admin-picker-menu').count(), 1, 'IME Escape is not a dropdown or dialog dismissal');
        await page.evaluate(() => {
          const actual = visualViewport, viewport = new EventTarget();
          Object.assign(viewport, { height: actual.height, width: actual.width, offsetTop: 0, offsetLeft: 0 });
          Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
          window.viewportProbe = { actual, viewport }; pickerEvents.length = 0;
        });
        const sample = () => input.evaluate(el => {
          const dialog = el.closest('[role=dialog]'), r = dialog.getBoundingClientRect(), menu = dialog.querySelector('.admin-picker-menu').getBoundingClientRect();
          return { same: el === pickerInput, focused: el === document.activeElement, start: el.selectionStart, end: el.selectionEnd, dialog: [r.x, r.y, r.width, r.height], scrollTop: dialog.querySelector('.admin-dialog-scroll').scrollTop, menu: { top: menu.top, bottom: menu.bottom } };
        });
        const before = await sample(), samples = [];
        for (const [height, top] of [[700, 0], [540, 12], [320, 60], [320, 110], [540, 12], [844, 0]]) {
          await page.evaluate(([height, top]) => {
            Object.assign(viewportProbe.viewport, { height, offsetTop: top });
            for (const type of ['resize', 'scroll']) { viewportProbe.viewport.dispatchEvent(new Event(type)); viewportProbe.actual.dispatchEvent(new Event(type)); }
            window.dispatchEvent(new Event('resize'));
          }, [height, top]); await frames(page); samples.push(await sample());
        }
        assert.ok(samples.every(s => s.same && s.focused && s.start === before.start && s.end === before.end));
        assert.ok(samples.every(s => JSON.stringify(s.dialog) === JSON.stringify(before.dialog) && s.scrollTop === before.scrollTop));
        assert.equal(await page.locator('.admin-picker-menu').count(), 1);
        const events = await page.evaluate(() => pickerEvents);
        assert.deepEqual(events.filter(e => /focus|blur/.test(e.type)), []);
        report.traces.push({ kind: 'trusted-composition-visual-only-viewport', before, samples, events });
        await page.evaluate(() => Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewportProbe.actual }));
        await cdp.send('Input.insertText', { text: '分组搜索' });
        await input.fill(''); await page.keyboard.press('Escape');
      } finally { await cdp.detach(); }
    });
    await check('edit group uses the existing picker and keeps prefix/new/clear/long names without an added length limit', async () => {
      await open('edit');
      await page.evaluate(() => { dialogFixture.state.props.servers = [{ server_group: 'Asia' }, { server_group: 'Asia' }, { server_group: 'Europe' }, { server_group: '' }]; dialogFixture.state.props.editForm.server_group = 'Asia'; }); await frames(page);
      const group = page.locator('[name=edit_server_group]');
      assert.equal(await group.getAttribute('role'), 'combobox'); assert.equal(await group.getAttribute('maxlength'), null);
      await group.tap(); assert.equal(await page.locator('.admin-group-options').getByRole('option').count(), 3); assert.match(await page.locator('.admin-group-options').getByRole('option', { name: /Asia/ }).innerText(), /2/);
      await page.locator('.admin-group-options').getByRole('option', { name: /Europe/ }).tap(); assert.equal(await group.inputValue(), 'Europe'); assert.equal(await group.evaluate(el => el === document.activeElement), true);
      await group.fill('As'); await page.keyboard.press('Enter'); assert.equal(await group.inputValue(), 'As', 'Enter preserves a typed prefix rather than choosing Asia');
      await group.tap(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      await group.fill('Long CF group name beyond thirteen characters'); await page.keyboard.press('Enter');
      assert.equal(await group.inputValue(), 'Long CF group name beyond thirteen characters');
      await group.fill(''); await group.tap(); await page.locator('.admin-group-options').getByRole('option', { name: '未分组', exact: true }).tap(); assert.equal(await group.inputValue(), '');
      await group.tap(); await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 1);
      await page.evaluate(() => dialogFixture.state.props.servers = []); await frames(page); assert.equal(await group.getAttribute('role'), null); assert.equal(await page.locator('.admin-group-combobox > button').count(), 0);
      await group.fill('No existing groups'); assert.equal(await group.inputValue(), 'No existing groups');
    });
    await check('busy/locked native fieldsets and the 16-channel save limit are unchanged', async () => {
      await open('alert'); await page.evaluate(() => { dialogFixture.state.props.draft.targetIds = Array.from({ length:17 }, (_,i) => `channel-${i}`); });
      await page.locator('[data-action=save-rule]').click(); assert.equal(await page.locator('.admin-notification-error[role=alert]').count(),1); assert.equal(await page.evaluate(() => dialogFixture.state.events.filter(e=>e.name==='save').length),0);
      await page.evaluate(() => dialogFixture.busy(true)); assert.equal(await page.locator('.admin-picker-summary').first().isDisabled(),true); assert.equal(await page.locator('.admin-picker-arrow').first().isDisabled(),true);
      await page.evaluate(() => { dialogFixture.busy(false); dialogFixture.state.props.locked=true; }); await frames(page); assert.equal(await page.locator('.admin-picker-summary').first().isDisabled(),true);
    });
    await check('edit group popover keeps the existing reduced-motion setting', async () => {
      await page.emulateMedia({ reducedMotion:'reduce' }); await open('edit'); await page.locator('[name=edit_server_group]').tap();
      assert.equal(await page.locator('.admin-group-options').evaluate(el=>el.getAnimations().filter(a=>a.playState!=='finished').length),0);
      await page.emulateMedia({ reducedMotion:'no-preference' });
    });
    await pickerGroupD1({ browser, origin, setTransport: value => { transport = value; }, report, check, shot });
  }
  if (process.argv.includes('--visual') || process.argv.includes('--visual-only') || process.argv.includes('--motion-only')) await pickerGroupVisual({ browser, origin, out, report, check, shot });
} catch (error) { report.errors.push(error.stack); console.error(error.stack); if (page) await shot(page, 'failure'); }
finally {
  await context?.close(); await browser?.close(); await server?.close();
  report.closed = true; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('REPORT ' + path.join(out, 'report.json'));
  process.exitCode = report.errors.length ? 1 : 0;
}
