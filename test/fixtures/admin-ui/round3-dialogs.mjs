import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Rebuild the audited actual React/Radix fixture after direct source comparison.
export async function referenceAssets(out) {
  const source = path.resolve('../monitor/web-admin');
  const audit = path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/reference-audit');
  const fixture = path.join(audit, 'dialogs/reference');
  const entry = fs.readFileSync(path.join(fixture, 'entry.tsx'), 'utf8');
  const admin = fs.readFileSync(path.join(source, 'src/components/Admin.tsx'), 'utf8');
  const functions = [...entry.matchAll(/^function (\w+)/mg)].map(match => match[1]).filter(name => name !== 'App');
  for (const name of functions) {
    const start = admin.indexOf(`function ${name}`), next = /^(?:function |const |export |type |interface )/mg;
    assert.ok(start >= 0, name); next.lastIndex = start + 1;
    const boundary = next.exec(admin)?.index ?? admin.length, end = admin.lastIndexOf('\n}', boundary) + 2;
    assert.ok(entry.includes(admin.slice(start, end)), `reference ${name} drifted; refresh from original source`);
  }
  for (const file of ['button', 'dialog', 'input', 'label', 'popover', 'select', 'switch', 'tooltip']) {
    const relative = `src/components/ui/${file}.tsx`;
    assert.equal(fs.readFileSync(path.join(fixture, relative), 'utf8'), fs.readFileSync(path.join(source, relative), 'utf8'), relative);
  }
  for (const relative of ['src/lib/utils.ts', 'src/lib/api.ts']) assert.equal(fs.readFileSync(path.join(fixture, relative), 'utf8'), fs.readFileSync(path.join(source, relative), 'utf8'), relative);
  assert.equal(fs.readFileSync(path.join(audit, 'nodes-shell/reference/src/index.css'), 'utf8'), fs.readFileSync(path.join(source, 'src/index.css'), 'utf8'));
  const dir = path.join(out, 'actual-reference'); fs.mkdirSync(dir, { recursive: true });
  await build({ entryPoints: [path.join(fixture, 'entry.tsx')], bundle: true, format: 'iife', outfile: path.join(dir, 'reference.js'), nodePaths: [path.join(audit, 'nodes-shell/reference/node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': path.join(fixture, 'src'), 'radix-ui': path.join(fixture, 'radix.ts') }, jsx: 'automatic' });
  fs.copyFileSync(path.join(audit, 'dialogs/reference.css'), path.join(dir, 'reference.css'));
  fs.copyFileSync(path.join(audit, 'dialogs/reference.html'), path.join(dir, 'reference.html'));
  return { dir, source, functions, primitives: 8, css: 'existing locked Tailwind compilation of actual minimal index.css' };
}

export async function round3Dialogs({ page, context, open, frames, out, report, PNG, screenshot, origin }) {
  if (process.argv.includes('--track-layout')) return dialogTrackLayout({ page, context, open, frames, out, report, PNG, screenshot, origin });
  const reference = process.env.ADMIN_DIALOG_REFERENCE === '1' ? await referenceAssets(out) : null; report.reference = reference;
  if (reference) await context.route('**/reference*', route => {
    const file = path.join(reference.dir, path.basename(new URL(route.request().url()).pathname));
    return route.fulfill({ path: file, contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  const ref = reference ? await context.newPage() : null;
  ref?.on('pageerror', error => report.errors.push(`actual reference: ${error.stack}`));
  const sample = (p, isRef = false) => p.evaluate(isRef => {
    const section = document.querySelector(isRef ? '[data-slot=dialog-content]' : '.admin-dialog');
    const body = isRef ? section.querySelector('form') || section.children[1] : section.querySelector('.admin-dialog-body');
    const footer = section.querySelector(isRef ? '[data-slot=dialog-footer]' : 'footer');
    const r = e => { const b = e?.getBoundingClientRect(); return b && { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
    const owner = isRef ? section : section.querySelector('.admin-dialog-scroll'), css = getComputedStyle(owner), active = document.activeElement;
    return { viewport: { height: visualViewport.height, top: visualViewport.offsetTop, width: visualViewport.width }, scheme: css.colorScheme, trackTop: parseFloat(getComputedStyle(owner, '::-webkit-scrollbar-track').marginTop) || 0, trackBottom: parseFloat(getComputedStyle(owner, '::-webkit-scrollbar-track').marginBottom) || 0, section: r(section), body: r(body), footer: r(footer), active: { tag: active.tagName, id: active.id, rect: r(active), value: active.value, start: active.selectionStart, end: active.selectionEnd }, bodyOverflow: getComputedStyle(body).overflowY, shellOverflow: css.overflowY, gutter: owner.offsetWidth - owner.clientWidth - owner.clientLeft * 2, paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight), scrollTop: owner.scrollTop, scrollHeight: owner.scrollHeight, clientHeight: owner.clientHeight, short: section.parentElement.classList.contains('admin-dialog-short') };
  }, isRef);
  const cdp = await context.newCDPSession(page), refCdp = ref ? await context.newCDPSession(ref) : null;
  const referenceShot = async file => { const image = await refCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file); };
  const metrics = async (session, width, height) => session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 640 });
  const check = async (name, fn) => {
    if (process.argv.includes('--provider-viewport') && !name.startsWith('provider select')) return;
    if (process.argv.includes('--busy-focus') && !name.startsWith('busy fieldset')) return;
    try { await fn(); report.checks.push({ name, pass: true }); console.log('PASS ' + name); }
    catch (error) { report.checks.push({ name, pass: false, error: error.stack }); console.error('FAIL ' + name + '\n' + error.stack); }
  };
  try {
    for (const width of [360, 390, 1440, 1920]) for (const dark of [false, true]) {
      const openKind = async kind => { await open(kind); await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark); };
      const height = width < 640 ? 844 : 900;
      await page.bringToFront(); await page.setViewportSize({ width, height }); if (ref) await ref.setViewportSize({ width, height });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 640 }); if (refCdp) await refCdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 640 });
      await metrics(cdp, width, height); if (refCdp) await metrics(refCdp, width, height);
      await page.goto(`${origin}/admin?locale=${width === 390 ? 'ja' : width === 360 ? 'zh' : 'en'}#/admin/terminal/node-a`); await page.waitForFunction(() => window.dialogFixture);
      await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
      if (reference) {
        await ref.goto(`${origin}/reference.html?dark=${dark ? 1 : 0}`); await ref.waitForFunction(() => window.referenceOpen);
        for (const kind of ['add', 'group', 'download']) {
          await metrics(cdp, width, height); await metrics(refCdp, width, height);
          await ref.bringToFront();
          await ref.evaluate(kind => window.referenceOpen(kind), kind); await ref.getByRole('dialog').waitFor();
          await ref.waitForFunction(() => document.querySelector('[data-slot=dialog-content]')?.getAnimations().every(a => a.playState === 'finished'));
          await page.bringToFront(); await openKind(kind); report.geometry.push({ kind: 'same-viewport-reference', consumer: kind, width, dark, reference: await sample(ref, true), target: await sample(page) });
          const refShot = path.join(out, `reference-${kind}-${width}-${dark}.png`); await referenceShot(refShot); await screenshot(`target-${kind}-${width}-${dark}`);
          if (width < 640) {
            await metrics(cdp, width, 300); await metrics(refCdp, width, 300);
            for (const p of [page, ref]) { await p.bringToFront(); const input = p.locator('[role=dialog] input:not([type=checkbox])').first(); if (await input.count()) await input.focus(); }
            await frames(); report.geometry.push({ kind: 'same-viewport-keyboard-reference', consumer: kind, width, dark, reference: await sample(ref, true), target: await sample(page) });
            const keyboardShot = path.join(out, `reference-${kind}-${width}-${dark}-keyboard.png`); await referenceShot(keyboardShot); await page.bringToFront(); await screenshot(`target-${kind}-${width}-${dark}-keyboard`);
            assert.equal(PNG.sync.read(fs.readFileSync(keyboardShot)).height, 300, 'reference capture must use the real CDP short viewport');
            assert.equal(PNG.sync.read(fs.readFileSync(path.join(out, `target-${kind}-${width}-${dark}-keyboard.png`))).height, 300, 'target capture must not restore Playwright\'s original 844px viewport');
          }
        }
        await metrics(cdp, width, height);
      }
      await check(`${width}/${dark}: shared content edges and stable shell owner`, async () => {
        for (const kind of ['add', 'edit', 'group', 'notificationSmtp', 'alert', 'batch', 'download', 'databaseClear', 'terminal']) {
          await openKind(kind); const g = await sample(page); report.geometry.push({ kind, width, dark, g });
          assert.equal(g.scheme, dark ? 'dark' : 'light', 'verify the effective theme after every consumer mounts');
          assert.equal(g.bodyOverflow, 'visible', 'no body/shell ownership flip at 480px'); assert.equal(g.shellOverflow, 'auto');
          if (g.footer) assert.ok(Math.abs(g.body.left - g.footer.left) <= .5 && Math.abs(g.body.right - g.footer.right) <= .5, 'body and footer must share content edges');
          assert.equal(g.paddingLeft, g.paddingRight + g.gutter, 'native hit gutter lives inside existing padding, not an extra content column');
        }
      });
      await check(`${width}/${dark}: close control has a full independent hit area beside native scrollbar`, async () => {
        for (const kind of ['edit', 'group', 'terminal']) {
          await openKind(kind); const button = page.locator('.admin-dialog-close'); await button.scrollIntoViewIfNeeded();
          const hit = await button.evaluate(el => {
            const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, radius = matchMedia('(pointer:coarse)').matches ? 21 : 14;
            return { kind: el.closest('.admin-dialog').className, hit: [[x-radius,y], [x+radius,y], [x,y-radius], [x,y+radius]].map(([px,py]) => el.contains(document.elementFromPoint(px,py))) };
          });
          report.geometry.push({ kind: 'close-hit', width, dark, hit }); assert.ok(hit.hit.every(Boolean), JSON.stringify(hit));
          const r = await button.boundingBox(), x = r.x + r.width / 2 + (width < 640 ? 21 : 14), y = r.y + r.height / 2;
          if (width < 640) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
          else await page.mouse.click(x, y);
          await page.locator('.admin-dialog').waitFor({ state: 'hidden', timeout: 1200 });
        }
      });
      if (width >= 640) continue;
      await check(`${width}: continuous keyboard shrink/restore preserves focus, selection and width`, async () => {
        for (const kind of ['add', 'edit', 'group', 'notificationSmtp', 'alert', 'download']) {
          await metrics(cdp, width, height); await openKind(kind);
          const input = page.locator('.admin-dialog input:not([type=checkbox]):not([type=hidden])').first();
          await input.fill('Keyboard selection'); await input.evaluate(el => el.setSelectionRange(2, 8));
          const before = await sample(page), trace = []; report.geometry.push({ kind: 'continuous-actual-CDP-keyboard', consumer: kind, width, dark, before, trace });
          for (const h of [700, 560, 500, 481, 479, 440, 360, 300, 360, 440, 479, 481, 560, 700, 844]) {
            await metrics(cdp, width, h); await frames(); const g = await sample(page); trace.push(g);
            assert.equal(g.scheme, dark ? 'dark' : 'light');
            assert.equal(g.bodyOverflow, 'visible', kind + ': changing height must not replace the scroll owner');
            assert.equal(g.section.width, before.section.width, kind + ': keyboard must not squeeze form width');
            assert.equal(g.active.id, before.active.id); assert.equal(g.active.tag, 'INPUT');
            assert.equal(g.active.start, before.active.start); assert.equal(g.active.end, before.active.end);
            assert.ok(g.section.top >= -.5 && g.section.bottom <= g.viewport.height + .5);
            assert.ok(g.active.rect.top >= g.section.top - .5 && g.active.rect.bottom <= g.section.bottom + .5, `${kind}: focused input must remain visible at ${h}px`);
            if (h === 300) await screenshot(`keyboard-${kind}-${width}-${dark}`);
          }
        }
        await screenshot(`keyboard-restored-${width}-${dark}`);
      });
      await check(`${width}: edge paint and continuous CDP diagonal thumb drag`, async () => {
        await metrics(cdp, width, 500); await openKind('edit'); const section = page.locator('.admin-dialog'); await section.locator('.admin-dialog-scroll').evaluate(el => { el.scrollTop = 0; });
        const g = await sample(page), r = await section.boundingBox();
        const x = r.x + r.width - 14, y = r.y + 1 + g.trackTop + Math.max(24, (g.clientHeight - g.trackTop - g.trackBottom) * g.clientHeight / g.scrollHeight) / 2;
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: Math.round(r.x + r.width - g.gutter - 1), y: Math.round(y), width: Math.max(1, g.gutter), height: 1, scale: 1 } });
        const paintBuffer = Buffer.from(capture.data, 'base64'), paintPath = path.join(out, `edge-paint-${width}-${dark}.png`); fs.writeFileSync(paintPath, paintBuffer); report.screenshots.push(paintPath); const paint = PNG.sync.read(paintBuffer);
        const background = [...paint.data.subarray(0, 3)], columns = Array.from({ length: paint.width }, (_, n) => n).filter(n => background.some((v, c) => Math.abs(v - paint.data[n * 4 + c]) > 3));
        report.geometry.push({ kind: 'edge-paint', width, dark, g, columns });
        assert.equal(columns.length, 3, 'real thumb paint remains 3px'); assert.ok(columns[0] <= 4, 'paint hugs border, not inner edge of 20px gutter');
        const trace = []; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let n = 1; n <= 12; n++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - n, y: y + n * 8 }] }); await frames(); trace.push(await section.locator('.admin-dialog-scroll').evaluate(el => el.scrollTop)); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        report.geometry.push({ kind: 'edge-touch-drag', width, dark, g, columns, trace }); assert.ok(trace.at(-1) > 20); assert.ok(trace.every((v, n) => !n || v >= trace[n - 1])); await screenshot(`edge-touch-drag-${width}-${dark}`);
      });
      if (width === 390 && !dark) await check('CDP pinch diagnostic records available native visualViewport offset', async () => {
        await metrics(cdp, width, 844); await openKind('notificationSmtp');
        await page.locator('.admin-dialog input:not([type=checkbox])').last().focus();
        await cdp.send('Input.synthesizePinchGesture', { x: 180, y: 350, scaleFactor: 1.5, gestureSourceType: 'touch' }); await frames();
        const g = await sample(page); report.geometry.push({ kind: 'CDP-offset-probe', nativeOffsetAvailable: g.viewport.top > 0, g });
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }); await metrics(cdp, width, 844);
      });
      if (width === 390 && dark) await check('visual-only height/offset API seam keeps group name popup anchored and input selection', async () => {
        await metrics(cdp, width, 844); await openKind('group');
        const input = page.locator('#group-name'); await input.click(); await input.fill('Keyboard'); await input.evaluate(el => el.setSelectionRange(1, 4));
        await page.locator('.admin-group-options').waitFor();
        await page.locator('.admin-group-options').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        const beforePan = await sample(page);
        await page.evaluate(() => {
          window.nativeDialogViewport = visualViewport;
          window.dialogViewportSeam = new EventTarget(); Object.assign(window.dialogViewportSeam, { height: 300, width: 390, offsetTop: 90, offsetLeft: 0 });
          Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.dialogViewportSeam });
          window.nativeDialogViewport.dispatchEvent(new Event('resize'));
        });
        try {
          await frames(); await frames(); const g = await sample(page), menu = await page.locator('.admin-group-options').boundingBox();
          report.geometry.push({ kind: 'visual-only-API-seam', boundary: 'synthetic height/offset on real mounted components; unchanged 844px layout viewport, not physical IME', g, menu });
          assert.equal(g.viewport.top, 90); assert.deepEqual(g.section, beforePan.section, 'minimal keeps the CSS layout viewport dialog stable during native visual-only keyboard panning');
          assert.equal(g.active.start, 1); assert.equal(g.active.end, 4);
          assert.ok(menu.y >= 98 && menu.y + menu.height <= 382, 'group popup must follow the usable visual viewport');
          assert.ok(Math.min(Math.abs(menu.y + menu.height + 4 - g.active.rect.top), Math.abs(menu.y - 4 - g.active.rect.bottom)) < 1, 'group menu must stay attached to its input after shell layout changes');
          await screenshot('visual-only-offset-group');
        } finally { await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.nativeDialogViewport }); visualViewport.dispatchEvent(new Event('resize')); }); }
      });
      if (width === 360 && !dark) await check('provider select survives visual-only viewport pan and remains attached without refocusing input', async () => {
        await metrics(cdp, width, 500); await openKind('notificationCreate');
        const trigger = page.locator('.admin-toolbar-group-trigger'); await trigger.click(); await page.locator('.admin-toolbar-group-menu').waitFor();
        await page.waitForFunction(() => { const menu = document.querySelector('.admin-toolbar-group-menu'); return menu && menu.getAnimations().every(a => a.playState === 'finished'); });
        await page.evaluate(() => {
          window.nativeDialogViewport = visualViewport;
          window.dialogViewportSeam = new EventTarget(); Object.assign(window.dialogViewportSeam, { height: 500, width: 360, offsetTop: 90, offsetLeft: 0 });
          Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.dialogViewportSeam }); window.nativeDialogViewport.dispatchEvent(new Event('resize'));
        });
        try {
          await frames(); await frames(); const anchor = await trigger.boundingBox(), menu = await page.locator('.admin-toolbar-group-menu').boundingBox();
          report.geometry.push({ kind: 'provider-visual-only-seam', anchor, menu });
          assert.ok(Math.min(Math.abs(menu.y + menu.height + 4 - anchor.y), Math.abs(menu.y - 4 - anchor.y - anchor.height)) < 1, 'provider popup follows its trigger after visual-only shell reflow');
          assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'INPUT');
        } finally { await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.nativeDialogViewport }); visualViewport.dispatchEvent(new Event('resize')); }); }
      });
      if (width === 390 && dark) await check('busy fieldset disabled descendants cannot defeat dialog focus containment', async () => {
        for (const kind of ['notificationSmtp', 'group']) {
          await openKind(kind); await page.evaluate(() => window.dialogFixture.busy(true));
          await page.locator('#outside').focus();
          assert.equal(await page.locator('.admin-dialog').evaluate(el => el.contains(document.activeElement)), true, `${kind}: inherited fieldset disabling must leave focus inside the busy dialog`);
          await page.keyboard.press('Tab'); assert.equal(await page.locator('.admin-dialog').evaluate(el => el.contains(document.activeElement)), true);
          await page.keyboard.press('Escape'); assert.equal(await page.locator('.admin-dialog').count(), 1);
          await page.evaluate(() => window.dialogFixture.busy(false)); await page.keyboard.press('Escape'); await page.locator('.admin-dialog').waitFor({ state: 'hidden' });
        }
      });
    }
  } finally { await cdp.detach(); await refCdp?.detach(); await ref?.close(); }
}

export async function dialogTrackLayout({ page, context, open, frames, out, report, PNG, screenshot, origin }) {
  const cdp = await context.newCDPSession(page);
  const measure = section => {
    const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
    const title = section.querySelector('h2'), close = section.querySelector('.admin-dialog-close'), body = section.querySelector('.admin-dialog-body'), footer = section.querySelector('footer');
    const owner = section.querySelector('.admin-dialog-scroll') || section, css = getComputedStyle(owner), track = getComputedStyle(owner, '::-webkit-scrollbar-track'), coarse = matchMedia('(pointer:coarse)').matches;
    const r = box(section), head = box(title), x = box(close), glyph=box(close.querySelector('svg')), gutter = owner.offsetWidth - owner.clientWidth - owner.clientLeft * 2;
    return { r, head, close: x, glyphCenter:glyph.x+glyph.width/2, coarse, gutter, chromeEnd: Math.max(head.bottom, x.bottom) - r.y, trackTop: parseFloat(track.marginTop) || 0, trackBottom: parseFloat(track.marginBottom) || 0, scrollHeight: owner.scrollHeight, clientHeight: owner.clientHeight, body: box(body), footer: footer && box(footer), paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight), overflow: getComputedStyle(body).overflowY };
  };
  try {
    for (const width of [360, 390, 1440, 1920]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 640 });
      await page.goto(`${origin}/admin?locale=${width < 640 ? 'zh' : 'en'}#/admin/terminal/node-a`); await page.waitForFunction(() => window.dialogFixture);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 640 }); await frames();
      for (const kind of ['group', 'notificationSmtp', 'edit', 'terminal']) {
        const name = `track-${kind}-${width}-${dark}`;
        try {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 640 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 640 });
          await open(kind); await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
          if (kind === 'edit') await page.evaluate(() => { window.dialogFixture.state.props.currentServerName = 'Long dialog title with natural wrapping / 标题完整保留 '.repeat(3); });
          await frames(); await page.waitForFunction(() => { const overlays = [...document.querySelectorAll('.admin-dialog-overlay')]; return overlays.length === 1 && overlays.every(el => el.getAnimations({ subtree: true }).every(a => a.playState === 'finished')); });
          await page.locator('.admin-dialog-scroll').last().evaluate(el => { el.scrollTop = 0; }); await screenshot(`${name}-normal`);
          const normal = await page.locator('.admin-dialog').last().evaluate(measure);
          if (normal.scrollHeight <= normal.clientHeight) {
            const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: Math.round(normal.r.right) - 21, y: Math.ceil(normal.r.y + normal.chromeEnd + 8), width: 6, height: Math.max(1, Math.floor(normal.r.height - normal.chromeEnd - 32)), scale: 1 } });
            const pixels = PNG.sync.read(Buffer.from(capture.data, 'base64'));
            const painted = Array.from({ length: pixels.height }, (_, y) => y).filter(y => [2,3,4].some(x => [0,1,2].some(c => Math.abs(pixels.data[(y * pixels.width + x) * 4 + c] - pixels.data[y * pixels.width * 4 + c]) > 3)));
            report.geometry.push({ kind: 'no-overflow-no-thumb', name, normal, painted });
            assert.deepEqual(painted, [], 'normal non-overflowing shell must not paint an unnecessary scrollbar');
          }
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 640 ? 300 : 500, deviceScaleFactor: 1, mobile: width < 640 }); await frames();
          await page.waitForFunction(() => [...document.querySelectorAll('.admin-dialog-overlay')].every(el => el.getAnimations({ subtree: true }).every(a => a.playState === 'finished')));
          const section = page.locator('.admin-dialog').last(); await section.locator('.admin-dialog-scroll').evaluate(el => { el.scrollTop = 0; }); await frames();
          const g = await section.evaluate(measure); await screenshot(name);
          assert.equal(g.coarse, width < 640, 'desktop track checks must exercise actual fine-pointer mouse mode');
          const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: Math.round(g.r.right) - 21, y: Math.round(g.r.y) + 9, width: 6, height: Math.floor(g.r.height) - 18, scale: 1 } });
          const png = PNG.sync.read(Buffer.from(captured.data, 'base64'));
          const paintedRows = Array.from({ length: png.height }, (_, y) => y).filter(y => y + 9 >= g.chromeEnd + 8 && [2,3,4].some(x => [0,1,2].some(c => Math.abs(png.data[(y * png.width + x) * 4 + c] - png.data[y * png.width * 4 + c]) > 3)));
          const firstPaint = paintedRows.length ? paintedRows[0] + 9 : null;
          report.geometry.push({ kind: 'track-layout', name, g, firstPaint, paintedRows });
          assert.ok(firstPaint !== null, 'scrollbar must remain visibly painted, not hidden');
          assert.ok(firstPaint >= g.chromeEnd + 8, `${name}: actual thumb starts ${firstPaint}px, title/close ends ${g.chromeEnd}px`);
          const paintedY = paintedRows[Math.min(5, paintedRows.length - 1)], paintedColumns = [1,2,3,4,5].filter(x => [0,1,2].some(c => Math.abs(png.data[(paintedY * png.width + x) * 4 + c] - png.data[paintedY * png.width * 4 + c]) > 3));
          assert.equal(paintedColumns.length, 3, 'track margin must retain actual 3px thumb paint');
          const pixelAt = x => [...png.data.subarray((paintedY * png.width + x) * 4, (paintedY * png.width + x) * 4 + 3)];
          const background = pixelAt(0), thumb = pixelAt(paintedColumns[1]), contrast = Math.max(...thumb.map((v,c) => Math.abs(v-background[c])));
          report.geometry.push({ kind: 'faint-thumb-color', name, background, thumb, contrast });
          // CDP mobile captures shift both panel and thumb by up to four channel levels.
          assert.ok(thumb.every(value => Math.abs(value - (dark ? 51 : 228)) <= 4) && Math.max(...thumb) === Math.min(...thumb), 'actual paint stays neutral and near the chosen Codex gray/dark adaptation');
          assert.ok(contrast >= 15 && contrast <= 50, 'thumb stays visible but faint against the effective panel, not the previous high-contrast gray');
          const paintCenter = Math.round(g.r.right) - 21 + paintedColumns.reduce((sum,x) => sum+x+.5,0)/paintedColumns.length;
          report.geometry.push({kind:'horizontal-axis',name,paintCenter,glyphCenter:g.glyphCenter,delta:Math.abs(paintCenter-g.glyphCenter)});
          assert.ok(Math.abs(paintCenter-g.glyphCenter) <= .75, 'actual painted thumb and X glyph must share the horizontal axis');
          if (kind === 'edit') assert.ok(g.head.right <= g.close.x - 6, 'long title must not run underneath the close control');
          assert.equal(g.overflow, 'visible'); assert.equal(g.paddingLeft, g.paddingRight + g.gutter);
          if (g.footer) assert.ok(Math.abs(g.body.x - g.footer.x) < 1 && Math.abs(g.body.right - g.footer.right) < 1);
          const length = g.clientHeight - g.trackTop - g.trackBottom, y = g.r.y + 1 + g.trackTop + Math.max(24, length * g.clientHeight / g.scrollHeight) / 2;
          const x = g.r.right - (g.coarse ? 14 : 18), samples = [];
          if (g.coarse) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); else { await page.mouse.move(x,y); await page.mouse.down(); }
          for (let n = 1; n <= 8; n++) {
            if (g.coarse) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - n, y: y + n * 7 }] }); else await page.mouse.move(x,y+n*7);
            await frames(); samples.push(await section.locator('.admin-dialog-scroll').evaluate(el => el.scrollTop));
          }
          if (g.coarse) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); else await page.mouse.up();
          if (g.coarse) await page.waitForTimeout(300); // Finish Chromium's native scrollbar gesture before the next tap.
          report.geometry.push({ kind: 'track-drag', name, samples }); assert.ok(samples.at(-1) > 10 && samples.every((v,n) => !n || v >= samples[n-1]), JSON.stringify(samples));
          await section.locator('.admin-dialog-scroll').evaluate(el => { el.scrollTop = 0; }); await section.locator('.admin-dialog-close').scrollIntoViewIfNeeded();
          const hit = await section.locator('.admin-dialog-close').evaluate(el => { const r = el.getBoundingClientRect(), radius = matchMedia('(pointer:coarse)').matches ? 21 : 14, x = r.x+r.width/2, y=r.y+r.height/2; return [[x-radius,y],[x+radius,y],[x,y-radius],[x,y+radius]].every(([px,py]) => el.contains(document.elementFromPoint(px,py))); });
          assert.equal(hit,true,'X full independent hit region remains usable');
          const closeBox = await section.locator('.admin-dialog-close').boundingBox(), closeX=closeBox.x+closeBox.width-1, closeY=closeBox.y+closeBox.height/2;
          if (g.coarse) { await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:closeX,y:closeY}]}); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); } else await page.mouse.click(closeX,closeY);
          await section.waitFor({state:'hidden',timeout:1200});
          report.checks.push({ name, pass: true }); console.log('PASS '+name);
        } catch(error) { report.checks.push({ name, pass: false, error: error.stack }); console.error('FAIL '+name+'\n'+error.stack); }
      }
    }
  } finally { await cdp.detach(); }
}
