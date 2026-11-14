import assert from 'node:assert/strict';
import path from 'node:path';
import en from '../../../src/frontend/locales/en.js';
import { nativeScrollbar } from './scrollbar-assertions.mjs';

export async function connectionChecks({ page, check, releaseCreating, releaseStarting, out, report }) {
  await check('actual creating transcript occupies the terminal content, not an overlay card', async () => {
    await page.waitForTimeout(80);
    const transcript = page.locator('.terminal-screen .terminal-connection');
    assert.equal(await transcript.count(), 1);
    const css = await transcript.evaluate(el => { const s = getComputedStyle(el); return { position: s.position, align: s.textAlign, font: s.fontFamily, border: s.borderTopWidth }; });
    assert.equal(css.position, 'static'); assert.equal(css.align, 'left'); assert.match(css.font, /mono/i); assert.equal(css.border, '0px');
    assert.match(await transcript.innerText(), /Checking access/);
    await page.screenshot({ path: path.join(out, 'creating.png') });
  });
  releaseCreating();
  await page.waitForFunction(() => !!window.fixtureScreen);
  await check('actual starting transcript is removed before FIRST remote bytes are written', async () => {
    await page.waitForTimeout(80);
    assert.match(await page.locator('.terminal-screen').innerText(), /Waiting for PTY/);
  });
  await page.evaluate(() => {
    window.firstWrite = [];
    const screen = window.fixtureScreen, original = screen.write;
    screen.write = function (...args) { window.firstWrite.push({ local: document.querySelector('.terminal-connection')?.textContent || '', data: new TextDecoder().decode(args[0]) }); return original.apply(this, args); };
  });
  releaseStarting();
  await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin);
  await page.waitForFunction(() => window.firstWrite.length > 0);
  await check('first welcome retained, no permanent shell-ready label or remote ACK pollution', async () => {
    report.firstWrite = await page.evaluate(() => window.firstWrite);
    assert.equal(report.firstWrite[0].local, '');
    assert.equal(report.firstWrite[0].data, 'FIRST REMOTE LINE\r\n');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('FIRST REMOTE LINE'));
    assert.equal(await page.locator('.terminal-connection,.terminal-status').count(), 0);
  });
}

export async function refinementChecks({ page, context, report, check, state, output, menu, closeMenu, out, exports, socket, PNG }) {
  await check('leaving and reversed real menu reclaim outside focus and block remote keyboard input', async () => {
    const inputs = report.inputs.length;
    await menu();
    const sample = when => page.evaluate(when => ({ when, inside: !!document.querySelector('.admin-dialog-terminal')?.contains(document.activeElement), leaving: !!document.querySelector('.terminal-menu-leave-active'), active: document.activeElement?.tagName }), when);
    await page.evaluate(async () => { document.querySelector('.admin-dialog-close').click(); await Promise.resolve(); document.querySelector('.terminal-mobile-input').focus(); });
    const samples = [await sample('outside-focus-during-leave')];
    await page.keyboard.press('Tab'); samples.push(await sample('tab-during-leave'));
    await page.keyboard.press('Shift+Tab'); samples.push(await sample('shift-tab-during-leave'));
    await page.evaluate(() => document.querySelector('[data-terminal-menu]').click());
    await page.waitForFunction(() => !document.querySelector('.terminal-menu-enter-active'));
    samples.push(await sample('reversed-without-extra-focus'));
    await page.keyboard.type('m'); await page.waitForTimeout(40);
    report.leaveFocus = { samples, inputDelta: report.inputs.length - inputs };
    await page.screenshot({ path: path.join(out, 'reverse-focus.png') });
    await closeMenu();
    assert.ok(samples.slice(0, 3).every(sample => sample.leaving), 'checks must occur inside actual CSS leave');
    assert.ok(samples.every(sample => sample.inside), JSON.stringify(report.leaveFocus));
    assert.equal(report.inputs.length, inputs, 'open/reversed menu keyboard must not send remote bytes');
  });
  await check('settings 44px target has centered glyph, no hover/active fill, visible keyboard focus', async () => {
    const button = page.locator('[data-terminal-menu]');
    await button.hover();
    const geometry = await button.evaluate(el => { const b = el.getBoundingClientRect(), svg = el.querySelector('svg').getBoundingClientRect(), css = getComputedStyle(el); return { width: b.width, height: b.height, dx: svg.x + svg.width / 2 - b.x - b.width / 2, dy: svg.y + svg.height / 2 - b.y - b.height / 2, background: css.backgroundColor }; });
    report.glyph = geometry;
    assert.deepEqual([geometry.width, geometry.height, geometry.dx, geometry.dy], [44, 44, 0, 0]); assert.equal(geometry.background, 'rgba(0, 0, 0, 0)');
    await page.keyboard.press('Tab'); await button.focus();
    assert.notEqual(await button.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  });
  await check('terminal X keeps its centered 44px hit target, neutral pointer fill and keyboard ring', async () => {
    const inputs = report.inputs.length, sockets = report.sockets, resizes = report.resizes.length;
    const button = page.locator('.admin-dialog-terminal .admin-dialog-close');
    const samples = [];
    const sample = async phase => samples.push(await button.evaluate((el, phase) => {
      const b = el.getBoundingClientRect(), svg = el.querySelector('svg').getBoundingClientRect(), css = getComputedStyle(el);
      return { phase, light: document.body.classList.contains('light'), width: b.width, height: b.height, dx: svg.x + svg.width / 2 - b.x - b.width / 2, dy: svg.y + svg.height / 2 - b.y - b.height / 2, background: css.backgroundColor, active: el.matches(':active'), hit: el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)), ring: css.outlineStyle, focusVisible: el.matches(':focus-visible') };
    }, phase));
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark); await menu();
      await button.hover(); await sample('hover');
      await page.mouse.down(); await sample('mouse-held');
      await page.screenshot({ path: path.join(out, `terminal-x-mouse-held-${dark}.png`) });
      await page.mouse.up(); await page.locator('.admin-dialog-terminal').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[data-terminal-menu]').evaluate(el => el === document.activeElement), true);
      await menu();
      const cdp = await context.newCDPSession(page), b = await button.boundingBox();
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] });
      await page.waitForTimeout(40);
      await sample('touch-held');
      await page.screenshot({ path: path.join(out, `terminal-x-touch-held-${dark}.png`) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      if (await button.count()) { await sample('touch-release-leaving'); await page.screenshot({ path: path.join(out, `terminal-x-touch-release-${dark}.png`) }); }
      await page.locator('.admin-dialog-terminal').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[data-terminal-menu]').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.evaluate(() => document.body.classList.contains('admin-dialog-open')), false);
      await menu(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await sample('keyboard');
      await page.screenshot({ path: path.join(out, `terminal-x-keyboard-${dark}.png`) });
      await closeMenu(); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: report.pointer !== 'fine' }); await cdp.detach();
    }
    await page.evaluate(() => document.body.classList.add('light')); report.closeGlyph = samples;
    assert.ok(samples.every(s => s.width === 44 && s.height === 44 && s.dx === 0 && s.dy === 0 && (s.phase === 'touch-release-leaving' || s.hit)), JSON.stringify(samples));
    assert.ok(samples.every(s => s.background === 'rgba(0, 0, 0, 0)'), JSON.stringify(samples));
    assert.ok(samples.at(-1).focusVisible && samples.at(-1).ring === 'solid');
    assert.equal(report.inputs.length, inputs); assert.equal(report.sockets, sockets); assert.equal(report.resizes.length, resizes);
  });
  await check('right-to-left menu enters, leaves mounted to right, reverses and hands off revoke focus', async () => {
    const host = await page.locator('.terminal-screen').boundingBox(), sockets = report.sockets, resizes = report.resizes.length;
    await page.locator('[data-terminal-menu]').click();
    await page.waitForTimeout(60);
    const mid = await page.locator('.admin-dialog-terminal').boundingBox();
    report.menuMid = mid;
    assert.ok(mid.x > 50 && mid.x < 390, JSON.stringify(mid));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.admin-dialog-terminal').count(), 1, 'leave DOM must remain mounted');
    await page.waitForTimeout(60);
    assert.equal(await page.locator('.admin-dialog-terminal').evaluate(el => el.contains(document.activeElement)), true);
    await page.evaluate(() => document.querySelector('[data-terminal-menu]').click());
    await menu();
    assert.equal(await page.locator('.admin-dialog-terminal').count(), 1);
    assert.deepEqual(await page.locator('.terminal-screen').boundingBox(), host);
    await page.locator('[data-terminal-revoke]').click();
    assert.equal(await page.locator('.admin-dialog-edit').count(), 0, 'handoff waits for leave/release');
    await page.locator('.admin-dialog-edit').waitFor();
    assert.equal(await page.locator('.admin-dialog-terminal').count(), 0);
    assert.equal(await page.locator('.admin-dialog-edit').evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await page.locator('.admin-dialog-edit').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-terminal-menu]').evaluate(el => el === document.activeElement), true);
    assert.equal(report.sockets, sockets); assert.equal(report.resizes.length, resizes);
  });
  await closeMenu();
  await page.locator('[data-terminal-keys]').click();
  const pasteButton = page.getByRole('button', { name: en.terminalPaste, exact: true });
  const draft = page.locator('[data-terminal-paste-draft]');
  await check('denied explicit clipboard read opens native multiline draft; Send alone uses bracketed paste', async () => {
    const count = report.inputs.length;
    await pasteButton.click(); await page.evaluate(() => window.clipboardReject(new Error('denied')));
    await page.waitForTimeout(60); assert.equal(await draft.count(), 1);
    assert.equal(await draft.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('.terminal-notice').innerText().then(text => text.includes('terminal_clipboard_denied')), false);
    await draft.fill('line one\nline two'); await page.waitForTimeout(40); assert.equal(report.inputs.length, count);
    await output('\x1b[?2004h');
    await page.locator('[data-terminal-paste-send]').click();
    await page.waitForTimeout(60);
    assert.equal(report.inputs.slice(count).join(''), '\x1b[200~line one\rline two\x1b[201~');
    assert.equal(await draft.count(), 0); assert.equal(await page.locator('.terminal-notice').count(), 0);
  });
  await check('missing Clipboard API fallback supports genuine native paste, cancel and overflow without execution', async () => {
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
    await pasteButton.click(); await page.waitForTimeout(40); assert.equal(await draft.count(), 1);
    const count = report.inputs.length;
    // Only test setup writes the OS clipboard; production reads remain explicit and permission-bound.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => window.fixtureNativeClipboard.writeText('native line A\nnative line B'));
    await draft.focus(); await page.keyboard.press('Control+V');
    assert.equal(await draft.inputValue(), 'native line A\nnative line B'); assert.equal(report.inputs.length, count);
    await page.locator('[data-terminal-paste-cancel]').click(); assert.equal(await draft.count(), 0); assert.equal(report.inputs.length, count);
    await pasteButton.click(); await draft.fill('x'.repeat(16384)); await page.locator('[data-terminal-paste-send]').click();
    await page.waitForTimeout(40); assert.equal(report.inputs.length, count); assert.equal(await draft.count(), 1);
    assert.equal(await page.locator('.terminal-notice').innerText().then(text => text.includes('terminal_input_overflow')), false);
    await page.locator('[data-terminal-notice-close]').click(); assert.equal(await page.locator('.terminal-notice').count(), 0);
    await page.locator('[data-terminal-paste-cancel]').click();
  });
  await check('browser-native xterm paste still passes through the bounded bracketed-paste transport', async () => {
    const count = report.inputs.length;
    await page.evaluate(() => window.fixtureNativeClipboard.writeText('native xterm\nsecond'));
    // Ctrl+V remains the terminal's literal ^V; Shift+Insert is Chromium's native paste action.
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Shift+Insert'); await page.waitForTimeout(60);
    assert.equal(report.inputs.slice(count).join(''), '\x1b[200~native xterm\rsecond\x1b[201~');
  });
  await check('draft and bottom notices stay reachable in every locale at 320px / keyboard 300px', async () => {
    const inputs = report.inputs.length, sockets = report.sockets;
    for (const locale of ['zh', 'en', 'ja', 'zh-TW', 'es', 'fr', 'id']) {
      await page.evaluate(async ({ file, locale }) => (await import(file)).setLanguage(locale), { file: exports['/src/frontend/utils/i18n.js'], locale });
      await page.setViewportSize({ width: 320, height: 300 });
      await page.getByRole('button', { name: await page.locator('.terminal-key-controls button').nth(1).innerText(), exact: true }).click();
      await draft.fill('preview\nonly');
      await page.locator('[data-terminal-paste-send]').scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const rect = el => { const b = el.getBoundingClientRect(); return { x: b.x, right: b.right, y: b.y, bottom: b.bottom, height: b.height }; };
        const footer = document.querySelector('.terminal-toolbar'), css = getComputedStyle(footer);
        return { footer: rect(footer), screen: rect(document.querySelector('.terminal-screen')), send: rect(document.querySelector('[data-terminal-paste-send]')), width: document.documentElement.scrollWidth, scrollWidth: footer.scrollWidth, clientWidth: footer.clientWidth, scrollbar: { width: getComputedStyle(footer, '::-webkit-scrollbar').width, border: getComputedStyle(footer, '::-webkit-scrollbar-thumb').borderLeftWidth }, overflow: css.overflowY };
      });
      assert.ok(geometry.screen.height >= 40 && geometry.send.bottom <= 300 && geometry.send.height >= 44, JSON.stringify({ locale, geometry }));
      assert.ok(geometry.width <= 320 && geometry.scrollWidth <= geometry.clientWidth);
      assert.equal(geometry.scrollbar.width, '8px');
      assert.ok(parseFloat(geometry.scrollbar.border) >= 1.5 && parseFloat(geometry.scrollbar.border) <= 2);
      report.checks.push({ name: `draft-${locale}-320x300`, pass: true, geometry });
      await page.screenshot({ path: path.join(out, `draft-${locale}-320x300.png`) });
      await page.locator('[data-terminal-paste-cancel]').click();
    }
    await page.evaluate(async file => (await import(file)).setLanguage('en'), exports['/src/frontend/utils/i18n.js']);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(report.inputs.length, inputs); assert.equal(report.sockets, sockets);
  });
  await check('draft clears on session loss; late clipboard success/rejection cannot reach a fresh shell', async () => {
    const count = report.inputs.length;
    await pasteButton.click(); await draft.fill('NEVER SEND OLD DRAFT');
    await menu(); await page.locator('[data-terminal-disconnect]').click();
    assert.equal(await draft.count(), 0);
    await menu(); await page.getByRole('button', { name: en.terminalReopen, exact: true }).click(); await closeMenu();
    await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin);
    for (const mode of ['resolve', 'reject']) {
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => new Promise((resolve, reject) => { window.clipboardResolve = resolve; window.clipboardReject = reject; }) } }));
      await pasteButton.click();
      await menu(); assert.equal(await page.getByRole('button', { name: en.terminalReopen, exact: true }).isDisabled(), true);
      await page.locator('[data-terminal-disconnect]').click();
      await menu(); await page.getByRole('button', { name: en.terminalReopen, exact: true }).click(); await closeMenu();
      await page.waitForFunction(() => !window.fixtureScreen.options.disableStdin);
      await page.evaluate(mode => mode === 'resolve' ? window.clipboardResolve('STALE') : window.clipboardReject(new Error('denied')), mode);
      await page.waitForTimeout(40);
      assert.equal(await draft.count(), 0); assert.equal(await page.locator('.terminal-notice').count(), 0);
    }
    assert.equal(report.inputs.length, count);
  });
  await check('reduced-motion menu and cancelled revoke handoff preserve trap/trigger ownership', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await menu();
    assert.equal(await page.locator('.admin-dialog-terminal').evaluate(el => getComputedStyle(el).transitionDuration), '0s'); await closeMenu();
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await menu(); await page.locator('[data-terminal-revoke]').click();
    await page.evaluate(() => document.querySelector('[data-terminal-menu]').click());
    await menu(); await closeMenu();
    assert.equal(await page.locator('.admin-dialog-edit').count(), 0, 'reversing leave cancels pending revoke handoff');
    assert.equal(await page.locator('[data-terminal-menu]').evaluate(el => el === document.activeElement), true);
  });
  await output(Array.from({ length: 300 }, (_, i) => `thumb-history-${i}\r\n`).join(''));
  await check('actual scrollbar has 3px painted thumb with full pointer hit area', async () => {
    await page.locator('.xterm').hover();
    const slider = page.locator('.xterm .scrollbar.vertical .slider');
    report.sliderStyle = await slider.evaluate(el => { const b = el.getBoundingClientRect(), css = getComputedStyle(el); return { width: b.width, borderLeft: parseFloat(css.borderLeftWidth), borderRight: parseFloat(css.borderRightWidth), clip: css.backgroundClip }; });
    assert.equal(report.sliderStyle.width, 14);
    const paintBox = report.sliderStyle.width - report.sliderStyle.borderLeft - report.sliderStyle.borderRight;
    assert.ok(paintBox >= 3 && paintBox < 4, 'fractional-DPR border rounding must not clip the separate 3px paint');
    assert.equal(report.sliderStyle.clip, 'padding-box');
  });
  const drag = async (continuous, offset) => {
    await page.evaluate(() => window.fixtureScreen.scrollToBottom());
    await page.waitForTimeout(40); await page.locator('.xterm').hover();
    const slider = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox(), track = await page.locator('.xterm .scrollbar.vertical').boundingBox();
    const x = slider.x + (offset ?? slider.width / 2), start = slider.y + slider.height / 2;
    await page.evaluate(() => {
      window.thumbFrames = []; window.thumbCounters = { render: 0, scroll: 0, parsed: 0 }; let previous = performance.now();
      const tick = now => { window.thumbFrames.push(now - previous); previous = now; window.thumbFrameId = requestAnimationFrame(tick); }; window.thumbFrameId = requestAnimationFrame(tick);
      window.thumbSubscriptions = [window.fixtureScreen.onRender(() => window.thumbCounters.render++), window.fixtureScreen.onScroll(() => window.thumbCounters.scroll++), window.fixtureScreen.onWriteParsed(() => window.thumbCounters.parsed++)];
    });
    await page.mouse.move(x, start); await page.mouse.down();
    const samples = [];
    for (let i = 1; i <= 24; i++) {
      const y = start + (track.y + slider.height / 2 - start) * i / 24;
      await page.mouse.move(x, y);
      if (continuous) await output(`continuing-${i}\r\n`);
      await page.waitForTimeout(16);
      samples.push({ y, at: await page.evaluate(() => performance.now()), ...await state(), domScrollTop: await page.locator('.xterm-scrollable-element').evaluate(el => el.scrollTop), thumbTop: await page.locator('.scrollbar.vertical .slider').evaluate(el => parseFloat(el.style.top)) });
    }
    await page.mouse.up();
    if (offset) (report.edgeThumbs ||= []).push({ offset, samples });
    else report[continuous ? 'continuousThumb' : 'staticThumb'] = samples;
    (report.thumbTiming || (report.thumbTiming = [])).push({ continuous, ...await page.evaluate(() => { cancelAnimationFrame(window.thumbFrameId); for (const sub of window.thumbSubscriptions) sub.dispose(); return { frames: window.thumbFrames, counters: window.thumbCounters, smoothScrollDuration: window.fixtureScreen.options.smoothScrollDuration, screenReaderMode: window.fixtureScreen.options.screenReaderMode }; }) });
    assert.equal(samples.at(-1).viewportY, 0);
    assert.ok(samples.every((sample, i) => !i || sample.viewportY <= samples[i - 1].viewportY), JSON.stringify(samples));
    const anchor = await state(); await output('after-drag\r\n');
    if (anchor.baseY === 1000 && anchor.viewportY === 0) { assert.equal((await state()).viewportY, 0); report.oldestEviction = true; }
    else assert.equal((await state()).first, anchor.first);
    // Drag the real thumb down again, including both history endpoints.
    const top = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox();
    await page.mouse.move(x, top.y + top.height / 2); await page.mouse.down();
    await page.mouse.move(x, track.y + track.height - top.height / 2, { steps: 24 }); await page.mouse.up();
    assert.equal((await state()).viewportY, (await state()).baseY);
  };
  await check('static real pointer thumb tracks monotonically and reaches history endpoints', () => drag(false));
  await check('continuous-output real pointer thumb tracks monotonically and preserves history/ACK', async () => { await drag(true); assert.equal(report.ack, report.outputBytes); });
  await check('both unpainted edges of the full 14px real thumb retain drag and history endpoints', async () => {
    const inputs = report.inputs.length;
    for (const offset of [1, 13]) await drag(false, offset);
    assert.equal(report.inputs.length, inputs); assert.equal(report.ack, report.outputBytes);
  });
  await check('captured real thumb drag does not reset history when pointer drifts laterally', async () => {
    await page.evaluate(() => window.fixtureScreen.scrollToBottom()); await page.waitForTimeout(40); await page.locator('.xterm').hover();
    const slider = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox();
    const x = slider.x + slider.width / 2, y = slider.y + slider.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y - 120, { steps: 8 }); await page.waitForTimeout(32);
    const before = await state();
    await page.mouse.move(x - 160, y - 180, { steps: 8 }); await page.waitForTimeout(32);
    const after = await state(); await page.mouse.up();
    report.lateralDrag = { before, after, platform: await page.evaluate(() => navigator.platform) };
    assert.ok(after.viewportY < before.viewportY, JSON.stringify(report.lateralDrag));
  });
  await check('genuine CDP touch grabs thumb, follows diagonal drag and cancels without browser pan or input', async () => {
    const cdp = await context.newCDPSession(page);
    await page.evaluate(() => {
      window.thumbEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) document.addEventListener(type, event => window.thumbEvents.push({ type, id: event.pointerId, pointerType: event.pointerType, y: event.clientY }), true);
      window.fixtureScreen.scrollToBottom();
    });
    await page.waitForTimeout(40); await page.locator('.xterm').hover();
    let slider = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox();
    const x = slider.x + slider.width / 2, y = slider.y + slider.height / 2, before = await state(), inputs = report.inputs.length;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * 6, y: y - i * 12, id: 1 }] }); await page.waitForTimeout(18); }
    assert.ok((await state()).viewportY < before.viewportY);
    const moved = await state();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(40);
    report.touchThumb = { before, moved, after: await state(), events: await page.evaluate(() => window.thumbEvents) };
    assert.equal(report.touchThumb.events.filter(event => event.type === 'pointercancel').length, 1, 'only explicit touchCancel, no spontaneous browser-pan cancellation');
    assert.ok(report.touchThumb.events.some(event => event.type === 'pointermove' && event.pointerType === 'touch'));
    assert.equal(await page.locator('.slider.active').count(), 0);
    assert.equal(report.inputs.length, inputs); assert.equal((await state()).viewportY, moved.viewportY);
    slider = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox();
    const track = await page.locator('.xterm .scrollbar.vertical').boundingBox(), sy = slider.y + slider.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: sy, id: 1 }] });
    for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * 2, y: sy + (track.y + slider.height / 2 - sy) * i / 12, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(40);
    assert.equal((await state()).viewportY, 0); assert.equal(await page.locator('.slider.active').count(), 0); assert.equal(report.inputs.length, inputs);
  });
  await check('thumb capture loss/blur release owned frames; track click remains xterm-owned', async () => {
    await page.evaluate(() => window.fixtureScreen.scrollToBottom()); await page.waitForTimeout(40); await page.locator('.xterm').hover();
    let slider = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox();
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2); await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.locator('.slider.active').count(), 0); await page.mouse.up();
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2 - 1);
    assert.equal(await page.evaluate(() => window.thumbEvents.at(-2)?.type === 'gotpointercapture' || window.thumbEvents.at(-1)?.type === 'gotpointercapture'), true);
    await page.locator('.scrollbar.vertical .slider').evaluate(el => { const id = window.thumbEvents.findLast(event => event.type === 'pointerdown').id; const captured = el.hasPointerCapture(id); if (captured) el.releasePointerCapture(id); window.fixtureLostCapture = captured; });
    assert.equal(await page.evaluate(() => window.fixtureLostCapture), true);
    // Chromium processes pending capture release before the next native pointer event.
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2 - 1);
    await page.waitForTimeout(40); assert.equal(await page.locator('.slider.active').count(), 0); await page.mouse.up();
    const track = await page.locator('.xterm .scrollbar.vertical').boundingBox(), before = await state(), inputs = report.inputs.length;
    await page.mouse.click(track.x + track.width / 2, track.y + 10); await page.waitForTimeout(40);
    assert.ok((await state()).viewportY < before.viewportY); assert.equal(report.inputs.length, inputs);
  });
  await check('scrollback cap/trim and growing output keep thumb endpoints reachable without jumping to latest', async () => {
    await output(Array.from({ length: 1250 }, (_, i) => `trim-history-${i}\r\n`).join(''));
    assert.equal((await state()).baseY, 1000);
    await drag(true);
    await page.evaluate(() => window.fixtureScreen.scrollToLine(500));
    const anchor = await state(); await output(Array.from({ length: 40 }, (_, i) => `trim-tail-${i}\r\n`).join(''));
    const after = await state(); report.trim = { anchor, after };
    assert.equal(after.first, anchor.first); assert.ok(after.viewportY < after.baseY); assert.equal(report.ack, report.outputBytes);
  });
  if (report.pointer === 'fine') await check('Terminal native draft, toolbar and key-row actual paint/drag retain complete control edges', async () => {
    const count = report.inputs.length, sockets = report.sockets;
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
      await page.setViewportSize({ width: 320, height: 300 });
      await pasteButton.click(); await draft.fill(Array.from({ length: 100 }, (_, i) => `preview ${i}`).join('\n'));
      await nativeScrollbar({ page, report, out, PNG }, draft, 'y', `terminal-draft-${dark}`);
      const toolbar = page.locator('.terminal-toolbar');
      await nativeScrollbar({ page, report, out, PNG }, toolbar, 'y', `terminal-toolbar-${dark}`);
      const keys = page.locator('.terminal-key-controls'); await keys.scrollIntoViewIfNeeded();
      await nativeScrollbar({ page, report, out, PNG }, keys, 'x', `terminal-keys-${dark}`);
      await page.locator('[data-terminal-paste-cancel]').click();
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.body.classList.add('light'));
    assert.equal(report.inputs.length, count); assert.equal(report.sockets, sockets); assert.equal(report.ack, report.outputBytes);
  });
  await check(`real custom thumb paint stays approximately 3px in both themes at context DPR ${report.dpr}`, async () => {
    const samples = [], dpr = report.dpr;
    for (const dark of [false, true]) {
      // Sample mid-track, away from the existing return-to-bottom button's border.
      await page.evaluate(dark => { document.body.classList.toggle('light', !dark); window.fixtureScreen.scrollToLine(400); }, dark);
      await page.locator('.xterm').hover(); await page.waitForTimeout(120);
      const slider = page.locator('.scrollbar.vertical .slider'), b = await slider.boundingBox();
      const png = PNG.sync.read(await page.screenshot({ path: path.join(out, `custom-paint-${dark}-${dpr}.png`), clip: { x: b.x, y: b.y + b.height / 2, width: b.width, height: 1 } }));
      const background = [...png.data.subarray(0, 3)];
      const contrast = Array.from({ length: png.width }, (_, i) => Math.max(...background.map((value, c) => Math.abs(value - png.data[i * 4 + c]))));
      const painted = Array.from({ length: png.width }, (_, i) => i).filter(i => background.some((value, c) => Math.abs(value - png.data[i * 4 + c]) > 3));
      const middle = Math.floor(png.width / 2) * 4, rgb = [...png.data.subarray(middle, middle + 3)];
      samples.push({ dark, dpr, width: b.width, paintedPhysical: painted.length, supportCss: painted.length / dpr, paintedCss: contrast.reduce((sum, value) => sum + value / Math.max(...contrast), 0) / dpr, rgb });
      await page.screenshot({ path: path.join(out, `terminal-scrollbar-${dark}-${dpr}.png`) });
    }
    await page.evaluate(() => document.body.classList.add('light'));
    report.customPaint = samples;
    assert.ok(samples.every(s => s.width === 14 && Math.abs(s.paintedCss - 3) <= .55 && (s.dpr !== 1 || s.paintedPhysical === 3) && Math.max(...s.rgb) - Math.min(...s.rgb) <= 2), JSON.stringify(samples));
  });
  await check('exit retains remote screen; compact dismissible notice never covers output', async () => {
    const bufferText = () => page.evaluate(() => { const b = window.fixtureScreen.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) || '').join('\n').trimEnd(); });
    const before = await bufferText(); socket().send('{"type":"exit","code":0}');
    await page.waitForTimeout(80);
    assert.equal(await bufferText(), before, 'notice layout may change visible rows, never remote cells or history');
    assert.equal(await page.locator('.terminal-notice').count(), 1);
    const notice = await page.locator('.terminal-notice').boundingBox(), host = await page.locator('.terminal-screen').boundingBox();
    assert.ok(notice.y >= host.y + host.height);
    assert.equal(await page.locator('.terminal-connection').count(), 0);
    await page.screenshot({ path: path.join(out, 'exit-retained.png') });
    await page.locator('[data-terminal-notice-close]').click(); assert.equal(await page.locator('.terminal-notice').count(), 0);
  });
  await page.screenshot({ path: path.join(out, 'refinement.png') });
  await check('unmount during captured thumb drag removes renderer and pending local handlers safely', async () => {
    await page.locator('.xterm').hover();
    const slider = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox();
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2); await page.mouse.down();
    await page.evaluate(() => window.fixtureRouter.push('/admin?apiIndex=0'));
    await page.waitForFunction(() => !document.querySelector('.xterm'));
    await page.mouse.move(20, 100); await page.mouse.up();
    assert.equal(await page.locator('.admin-dialog-terminal,.slider.active').count(), 0);
  });
}
