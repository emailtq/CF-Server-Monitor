import assert from 'node:assert/strict';
import path from 'node:path';
import en from '../../../src/frontend/locales/en.js';

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

export async function refinementChecks({ page, context, report, check, state, output, menu, closeMenu, out, exports, socket }) {
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
      assert.deepEqual(geometry.scrollbar, { width: '8px', border: '1px' });
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
  await check('actual scrollbar has 6px painted thumb with full pointer hit area', async () => {
    await page.locator('.xterm').hover();
    const slider = page.locator('.xterm .scrollbar.vertical .slider');
    report.sliderStyle = await slider.evaluate(el => { const b = el.getBoundingClientRect(), css = getComputedStyle(el); return { width: b.width, borderLeft: parseFloat(css.borderLeftWidth), borderRight: parseFloat(css.borderRightWidth), clip: css.backgroundClip }; });
    assert.ok(report.sliderStyle.width >= 10);
    assert.equal(report.sliderStyle.width - report.sliderStyle.borderLeft - report.sliderStyle.borderRight, 6);
    assert.equal(report.sliderStyle.clip, 'padding-box');
  });
  const drag = async continuous => {
    await page.evaluate(() => window.fixtureScreen.scrollToBottom());
    await page.waitForTimeout(40); await page.locator('.xterm').hover();
    const slider = await page.locator('.xterm .scrollbar.vertical .slider').boundingBox(), track = await page.locator('.xterm .scrollbar.vertical').boundingBox();
    const x = slider.x + slider.width / 2, start = slider.y + slider.height / 2;
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
    report[continuous ? 'continuousThumb' : 'staticThumb'] = samples;
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
