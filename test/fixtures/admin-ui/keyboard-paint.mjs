import assert from 'node:assert/strict';

// Uses the existing production Vue host; the viewport seam diagnoses app feedback, not an Android IME.
export async function keyboardPaint({ page, context, open, frames, report, shot }) {
  const check = async (name, run) => {
    try { await run(); report.checks.push(name); console.log('PASS ' + name); }
    catch (error) { report.errors.push(error.stack); console.error('FAIL ' + name + '\n' + error.stack); }
  };
  for (const width of [360, 390, 1440, 1920]) for (const dark of [false, true]) {
    const mobile = width < 640, height = mobile ? 844 : 900, stem = `${width}-${dark ? 'dark' : 'light'}`;
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
      await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.evaluate(() => matchMedia('(pointer:coarse)').matches), mobile);
      for (const [kind, field, popup] of [
        ['alert', '.admin-picker-summary', '.admin-picker-menu'],
        ['edit', '[name=edit_server_group]', '.admin-group-options'],
        ['notificationCreate', '.admin-toolbar-group-trigger', '.admin-toolbar-group-menu']
      ]) await check(`${kind} ${stem}: down-only available-space menu with stable focus and selection`, async () => {
        await open(kind);
        const input = page.locator(field).first(), menu = page.locator(popup).first();
        await (mobile ? input.tap() : input.click()); await menu.waitFor();
        await page.waitForFunction(popup => document.querySelector(popup)?.getAnimations().every(animation => animation.playState !== 'running'), popup);
        await frames(page);
        const baseline = await input.evaluate(el => {
          window.paintOwner = document.activeElement; window.paintInput = el; window.paintFocus = [];
          window.paintRecord = event => paintFocus.push({ type: event.type, target: event.target.className });
          for (const type of ['focusin', 'focusout']) document.addEventListener(type, paintRecord, true);
          const actual = visualViewport, viewport = new EventTarget();
          Object.assign(viewport, { height: actual.height, width: actual.width, offsetTop: 0, offsetLeft: 0 });
          Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
          window.paintViewport = { actual, viewport };
          const dialog = el.closest('[role=dialog]').getBoundingClientRect();
          return { dialog: [dialog.x, dialog.y, dialog.width, dialog.height], start: el.selectionStart, end: el.selectionEnd };
        });
        const samples = [];
        try {
          for (const space of [8, 100, 42, 160, 240]) {
            await input.evaluate((el, space) => {
              const bottom = el.getBoundingClientRect().bottom;
              Object.assign(paintViewport.viewport, { height: Math.min(paintViewport.actual.height, bottom + space + 16), offsetTop: 0 });
              for (const type of ['resize', 'scroll']) { paintViewport.viewport.dispatchEvent(new Event(type)); paintViewport.actual.dispatchEvent(new Event(type)); }
              window.dispatchEvent(new Event('resize'));
            }, space); await frames(page);
            const state = await input.evaluate((el, popup) => {
              const trigger = el.getBoundingClientRect(), element = document.querySelector(popup), menu = element?.getBoundingClientRect(), dialog = el.closest('[role=dialog]').getBoundingClientRect();
              const list = element?.querySelector('.admin-picker-options, .admin-toolbar-group-viewport')?.getBoundingClientRect();
              return { triggerBottom: trigger.bottom, menu: menu && { top: menu.top, bottom: menu.bottom, height: menu.height }, list: list && { top: list.top, bottom: list.bottom, height: list.height }, viewportBottom: visualViewport.height, same: el === paintInput, focus: document.activeElement === paintOwner, start: el.selectionStart, end: el.selectionEnd, dialog: [dialog.x, dialog.y, dialog.width, dialog.height] };
            }, popup);
            samples.push(state);
            assert.ok(state.menu, 'visual-only resize keeps the opened menu mounted');
            assert.ok(Math.abs(state.menu.top - state.triggerBottom - 4) < 1, 'menu always starts four pixels below the trigger; no upward flip or top clamp');
            assert.ok(state.menu.bottom <= state.viewportBottom - 8 + 1, 'menu fits available space, including its chrome');
            if (state.list?.height > 0) assert.ok(state.list.bottom <= state.menu.bottom - 1 + .5, 'shrink the inner scrollport, not clip a larger scrollport behind the outer menu');
            assert.equal(state.same && state.focus, true); assert.equal(state.start, baseline.start); assert.equal(state.end, baseline.end);
            assert.deepEqual(state.dialog, baseline.dialog, 'menu resize does not recenter the form');
          }
          assert.deepEqual(await page.evaluate(() => paintFocus), []);
          await shot(page, `${kind}-down-${stem}`);
        } finally {
          report.traces.push({ kind: 'down-only-viewport', dialog: kind, stem, baseline, samples, events: await page.evaluate(() => paintFocus) });
          await page.evaluate(() => { for (const type of ['focusin', 'focusout']) document.removeEventListener(type, paintRecord, true); Object.defineProperty(window, 'visualViewport', { configurable: true, value: paintViewport.actual }); paintViewport.actual.dispatchEvent(new Event('resize')); });
        }
        await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 1);
      });
      await check(`primary ${stem}: rest/hover/active/focus/disabled retain readable colors`, async () => {
        await open('edit');
        const button = page.locator('.admin-dialog-edit footer .btn-primary'); await button.scrollIntoViewIfNeeded();
        const sample = (state, target = button) => target.evaluate((el, state) => {
          const css = getComputedStyle(el), panel = getComputedStyle(el.closest('.admin-dialog')).backgroundColor;
          const canvas = new OffscreenCanvas(1, 1), ctx = canvas.getContext('2d');
          const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
          const composite = (a, b, opacity = 1) => a.slice(0, 3).map((c, i) => c * a[3] / 255 * opacity + b[i] * (1 - a[3] / 255 * opacity));
          const bg = composite(rgba(css.backgroundColor), rgba(panel), Number(css.opacity));
          const fg = composite(rgba(css.color), rgba(panel), Number(css.opacity));
          const luminance = rgb => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((v, c, i) => v + c * [.2126, .7152, .0722][i], 0);
          const a = luminance(bg), b = luminance(fg);
          return { state, background: css.backgroundColor, color: css.color, opacity: css.opacity, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), focusVisible: el.matches(':focus-visible'), outline: css.outlineStyle, shadow: css.boxShadow };
        }, state);
        await page.mouse.move(0, 0); const states = [await sample('rest')];
        await button.hover(); states.push(await sample('hover'));
        await page.mouse.down(); states.push(await sample('active')); await page.mouse.up();
        await page.keyboard.press('Tab'); await button.focus(); states.push(await sample('focus'));
        await shot(page, `primary-focus-${stem}`);
        await page.evaluate(() => dialogFixture.busy(true)); states.push(await sample('disabled'));
        report.traces.push({ kind: 'button-paint', stem, states });
        assert.ok(states.filter(s => s.state !== 'disabled').every(s => s.contrast >= 4.5), JSON.stringify(states));
        assert.ok(states.at(-1).contrast >= 2, 'disabled text stays distinguishable under the accepted .5 opacity');
        assert.equal(states[3].focusVisible, true);
        assert.ok(states[3].outline !== 'none' || states[3].shadow !== 'none', 'keyboard focus has a visible indicator');
        if (width === 1440) for (const kind of ['add', 'group', 'renew', 'notificationSmtp', 'alert', 'delete']) {
          await open(kind);
          const buttons = page.locator('[role=dialog] footer .btn');
          for (let i = 0; i < await buttons.count(); i++) {
            const target = buttons.nth(i); await target.scrollIntoViewIfNeeded();
            if (await target.isDisabled()) continue;
            await page.mouse.move(0, 0); const variant = [await sample('rest', target)];
            await target.hover(); variant.push(await sample('hover', target));
            await target.evaluate(el => el.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); }, { once: true, capture: true }));
            await page.mouse.down(); variant.push(await sample('active', target));
            await page.mouse.up(); // The one-shot listener prevents submitting while preserving actual pointer paint.
            await page.keyboard.press('Tab'); await target.focus(); variant.push(await sample('focus', target));
            await page.evaluate(() => dialogFixture.busy(true)); variant.push(await sample('disabled', target));
            await page.evaluate(() => dialogFixture.busy(false));
            report.traces.push({ kind: 'real-button-variant', dialog: kind, stem, className: await target.getAttribute('class'), states: variant });
            assert.ok(variant.slice(1, 4).every(state => state.color === variant[0].color && state.contrast >= 4.5), 'hover/active/focus preserve the variant foreground and readable contrast');
            assert.equal(variant[3].focusVisible, true);
          }
        }
      });
      await check(`secret eye ${stem}: tap does not blur or replace the editable input`, async () => {
        await open('notificationSmtp');
        const input = page.locator('.admin-secret-field input:not([readonly])').last(), eye = input.locator('..').locator('.admin-secret-eye');
        await input.fill('fixture-visible-only'); await input.evaluate(el => { window.eyeInput = el; window.eyeBlur = 0; el.addEventListener('blur', () => eyeBlur++); });
        await (mobile ? eye.tap() : eye.click()); await frames(page);
        assert.equal(await input.evaluate(el => el === eyeInput && el === document.activeElement), true);
        assert.equal(await page.evaluate(() => eyeBlur), 0); assert.equal(await input.inputValue(), 'fixture-visible-only');
        const paint = await eye.evaluate(el => { const css = getComputedStyle(el); return { background: css.backgroundColor, border: css.borderWidth, animations: el.getAnimations().length }; });
        assert.equal(paint.background, 'rgba(0, 0, 0, 0)'); assert.equal(paint.border, '0px'); assert.equal(paint.animations, 0);
      });
      await check(`dialog ${stem}: asynchronous initial focus respects a consumer-owned editable field`, async () => {
        await page.evaluate(() => {
          window.initialFocus = [];
          const observer = new MutationObserver(() => {
            const input = document.querySelector('.admin-dialog-add input');
            if (!input) return;
            observer.disconnect(); window.initialInput = input;
            input.addEventListener('blur', () => initialFocus.push('blur')); input.focus();
          });
          observer.observe(document.body, { childList: true, subtree: true });
          dialogFixture.open('add');
        });
        await page.locator('.admin-dialog-add').waitFor(); await frames(page);
        assert.equal(await page.evaluate(() => initialInput === document.activeElement), true, 'AdminDialog must not replace an already-established input focus with X');
        assert.deepEqual(await page.evaluate(() => initialFocus), []);
      });
      await check(`dialog ${stem}: minimal height transition and null blur preserve the open group search`, async () => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await open('edit');
        const group = page.locator('[name=edit_server_group]');
        await (mobile ? group.tap() : group.click());
        await page.locator('.admin-group-options').waitFor();
        const transition = await page.locator('.admin-dialog').evaluate(el => {
          const css = getComputedStyle(el);
          return { property: css.transitionProperty, duration: css.transitionDuration, easing: css.transitionTimingFunction };
        });
        assert.equal(transition.property, 'max-height');
        assert.equal(transition.duration, '0.2s');
        assert.equal(transition.easing, 'ease');
        if (mobile) {
          await page.evaluate(() => {
            window.heightFrames = []; window.heightDone = false;
            const section = document.querySelector('.admin-dialog');
            const frame = () => { heightFrames.push(section.getBoundingClientRect().height); if (!heightDone) requestAnimationFrame(frame); };
            requestAnimationFrame(frame);
          });
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 400, deviceScaleFactor: 1, mobile });
          await page.waitForFunction(() => document.querySelector('.admin-dialog').getAnimations().every(a => a.playState === 'finished') && heightFrames.length > 2);
          await page.evaluate(() => heightDone = true);
          const heights = await page.evaluate(() => heightFrames);
          assert.ok(heights.some(value => value > 369 && value < 811), 'a native layout resize paints intermediate heights, not just the final 368px');
          report.traces.push({ kind: 'native-layout-height-transition', stem, heights });
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
          await page.waitForFunction(() => document.querySelector('.admin-dialog').getAnimations().every(a => a.playState === 'finished'));
        }
        await group.evaluate(el => el.blur());
        await frames(page);
        assert.equal(await group.getAttribute('aria-expanded'), 'true', 'null relatedTarget is not an outside focus interaction');
        await group.focus();
        await page.keyboard.press('Escape');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.locator('.admin-dialog').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      });
      if (mobile) await check(`alert ${stem}: a lower input and the first down-only option remain usable after layout shrink`, async () => {
        await open('alert');
        const input = page.locator('.admin-picker-summary').first();
        await input.tap();
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 300, deviceScaleFactor: 1, mobile });
        await frames(page);
        const state = await input.evaluate(el => {
          const menu = el.parentElement.querySelector('.admin-picker-menu'), row = menu.querySelector('[role=option]');
          const trigger = el.getBoundingClientRect(), option = row.getBoundingClientRect(), port = el.closest('.admin-dialog-scroll').getBoundingClientRect();
          return { focused: document.activeElement === el, trigger: [trigger.top, trigger.bottom], option: [option.top, option.bottom], port: [port.top, port.bottom], menu: getComputedStyle(menu).visibility };
        });
        assert.equal(state.focused, true); assert.equal(state.menu, 'visible');
        assert.ok(state.trigger[0] >= state.port[0] && state.option[1] <= state.port[1] - 4, 'the shared reveal must retain a selectable row below the input, not just the count or menu border');
        report.traces.push({ kind: 'lower-picker-layout-reveal', stem, state });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
        await frames(page);
        await input.press('ArrowDown'); await input.press('End');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 300, deviceScaleFactor: 1, mobile });
        await frames(page);
        const scrolled = await input.evaluate(el => {
          const menu = el.parentElement.querySelector('.admin-picker-menu'), list = menu.querySelector('.admin-picker-options');
          return { height: list.clientHeight, rowHeight: list.querySelector('[role=option]').offsetHeight, focused: document.activeElement === el };
        });
        assert.equal(scrolled.focused, true);
        assert.ok(scrolled.height >= scrolled.rowHeight, 'native list scrolling cannot remove the reserved selectable row on the next resize');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      });
      if (mobile) await check(`pickers ${stem}: opening after the viewport has settled reveals one down-only row without changing focus`, async () => {
        let previousKind
        for (const [kind, selector, index] of [['alert', '.admin-picker-summary', 0], ['alert', '.admin-picker-summary', 1], ['edit', '[name=edit_server_group]', 0], ['group', '#group-name', 0]]) {
          if (previousKind !== kind) {
            await open(kind);
            await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 300, deviceScaleFactor: 1, mobile });
            await page.waitForFunction(() => document.querySelector('.admin-dialog').getAnimations().every(a => a.playState === 'finished'));
          } else await page.keyboard.press('Escape'); // Close the overlapping menu, keeping the keyboard/input focus before switching fields.
          previousKind = kind;
          const input = page.locator(selector).nth(index);
          // Native scrolling first reveals the trigger at the port's bottom; opening cannot rely on a later resize.
          await input.evaluate(el => {
            const owner = el.closest('.admin-dialog-scroll'), port = owner.getBoundingClientRect(), field = el.getBoundingClientRect();
            owner.scrollTop += field.bottom - port.bottom + 12;
            window.settledPickerInput = el; window.settledPickerFocus = [];
            el.addEventListener('focusout', event => { if (event.target === settledPickerInput) settledPickerFocus.push({ trusted: event.isTrusted, related: event.relatedTarget?.tagName }); });
          });
          await frames(page);
          const before = await input.evaluate(el => { const r = el.getBoundingClientRect(); return { viewport: innerHeight, top: r.top, bottom: r.bottom }; });
          await input.tap(); await frames(page);
          const state = await input.evaluate(el => {
            const menu = el.parentElement.querySelector('.admin-picker-menu, .admin-group-options'), row = menu?.querySelector('[role=option]');
            const rect = el => { const r = el.getBoundingClientRect(); return [r.top, r.bottom, r.height]; };
            return { viewport: innerHeight, same: el === settledPickerInput, focused: document.activeElement === el, input: rect(el), menu: menu && rect(menu), row: row && rect(row), port: rect(el.closest('.admin-dialog-scroll')), visible: menu && getComputedStyle(menu).visibility, focusout: settledPickerFocus };
          });
          report.traces.push({ kind: 'already-shrunk-picker-open', stem, consumer: kind, index, before, state });
          assert.equal(state.viewport, before.viewport); assert.equal(state.same && state.focused, true); assert.deepEqual(state.focusout, []);
          assert.equal(state.visible, 'visible'); assert.ok(state.row, 'a real selectable option must be rendered');
          assert.ok(state.input[0] >= state.port[0] && state.row[1] <= state.port[1] - 3, 'opening on a stable short viewport reveals the complete first option, not a clipped menu border');
          assert.ok(Math.abs(state.menu[0] - state.input[1] - 4) < 1, 'opening retains the four-pixel downward anchor');
          const point = await input.evaluate(el => {
            const owner = el.closest('.admin-dialog-scroll'), field = el.getBoundingClientRect(), port = owner.getBoundingClientRect();
            owner.scrollTop += field.bottom - port.bottom + 12;
            const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await frames(page);
          const reopened = await input.evaluate(el => {
            const row = el.parentElement.querySelector('[role=option]'), option = row.getBoundingClientRect(), port = el.closest('.admin-dialog-scroll').getBoundingClientRect();
            return { focused: document.activeElement === el, bottom: option.bottom, portBottom: port.bottom };
          });
          assert.equal(reopened.focused, true); assert.ok(reopened.bottom <= reopened.portBottom - 3, 're-clicking an already-open picker after native body scrolling also reveals the row');
          report.traces.push({ kind: 'already-open-scrolled-picker', stem, consumer: kind, index, reopened });
          await shot(page, `settled-${kind}-${index}-${stem}`);
        }
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      });
    } finally { await cdp.detach(); }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
