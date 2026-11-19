import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { referenceAssets } from './round3-dialogs.mjs';

// A visualViewport seam diagnoses application feedback, not a physical Android IME.
export async function round4Dialogs({ page, context, open, frames, out, report, screenshot, origin }) {
  const reference = await referenceAssets(out); report.reference = reference;
  await context.route('**/reference*', route => {
    const file = path.join(reference.dir, path.basename(new URL(route.request().url()).pathname));
    return route.fulfill({ path: file, contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  const ref = await context.newPage(), cdp = await context.newCDPSession(page), refCdp = await context.newCDPSession(ref);
  const check = async (name, run) => {
    try { await run(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({ name, pass: false, error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
  };
  const metrics = (session, width, height) => session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 640 });
  const trace = p => p.evaluate(() => {
    const input = document.querySelector('[role=dialog] input:not([type=checkbox]):not([type=hidden])') || document.querySelector('[role=dialog] textarea');
    const dialog = input.closest('[role=dialog]'), owner = dialog.querySelector('.admin-dialog-scroll') || dialog;
    const viewport = new EventTarget(); Object.assign(viewport, { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0 });
    const actualViewport = window.visualViewport;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    // Let any pre-existing listener observe the seam before recording the baseline.
    actualViewport.dispatchEvent(new Event('resize'));
    const events = [], writes = [], scrollCalls = [];
    const record = event => events.push({ type: event.type, trusted: event.isTrusted, target: event.target.tagName || event.target.className, active: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd });
    for (const type of ['focus', 'blur', 'focusin', 'focusout', 'input', 'compositionstart', 'compositionend', 'scroll']) document.addEventListener(type, record, true);
    const observer = new MutationObserver(records => writes.push(...records.map(r => ({ target: r.target.className, style: r.target.getAttribute('style') }))));
    observer.observe(dialog.parentElement, { attributes: true, attributeFilter: ['style'], subtree: true });
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) { scrollCalls.push({ tag: this.tagName, className: this.className, active: this === input }); return scrollIntoView.apply(this, args); };
    const box = () => { const r = dialog.getBoundingClientRect(); return { top: r.top, height: r.height, width: r.width, scrollTop: owner.scrollTop, identity: input === document.querySelector('[role=dialog] input:not([type=checkbox]):not([type=hidden])'), active: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd }; };
    window.imeTrace = { viewport, actualViewport, input, events, writes, scrollCalls, box, cleanup: () => { observer.disconnect(); for (const type of ['focus', 'blur', 'focusin', 'focusout', 'input', 'compositionstart', 'compositionend', 'scroll']) document.removeEventListener(type, record, true); Element.prototype.scrollIntoView = scrollIntoView; Object.defineProperty(window, 'visualViewport', { configurable: true, value: actualViewport }); } };
  });
  try {
    for (const [width, dark] of [[360, false], [390, true], [1440, false], [1920, true]]) {
      const height = width < 640 ? 844 : 900;
      await metrics(cdp, width, height); await metrics(refCdp, width, height);
      await page.goto(`${origin}/admin?locale=zh#/admin/terminal/node-a`); await page.waitForFunction(() => window.dialogFixture);
      await ref.goto(`${origin}/reference.html?dark=${Number(dark)}`); await ref.waitForFunction(() => window.referenceOpen);
      await ref.evaluate(() => window.referenceOpen('group')); await ref.getByRole('dialog').waitFor();
      await ref.waitForFunction(() => document.querySelector('[data-slot=dialog-content]').getAnimations().every(a => a.playState === 'finished'));
      for (const [p, isRef] of [[ref, true], [page, false]]) {
        for (const kind of isRef ? ['group'] : ['add', 'edit', 'group', 'notificationSmtp', 'alert', 'batch', 'renew', 'delete', 'download', 'revoke']) await check(`${isRef ? 'minimal' : 'CF'} ${kind} ${width}: visual-only keyboard events never relayout/refocus/scroll the form`, async () => {
          await p.bringToFront();
          if (!isRef) { await open(kind); await p.evaluate(dark => document.body.classList.toggle('light', !dark), dark); }
          let input = p.locator('[role=dialog] input:not([type=checkbox]):not([type=hidden])').first();
          if (!await input.count()) input = p.locator('[role=dialog] textarea').first();
          if (!await input.count()) return; // Confirm dialogs without text entry have no IME owner.
          await input.click();
          if (await input.evaluate(el => ['text', 'password', 'search'].includes(el.type) || el.tagName === 'TEXTAREA')) {
            await input.fill('Keyboard'); await input.evaluate(el => el.setSelectionRange(2, 6));
          }
          await trace(p); await frames();
          let composition = [];
          try {
            if (kind === 'group' && width < 640) {
              await (isRef ? refCdp : cdp).send('Input.imeSetComposition', { text: '分组编辑', selectionStart: 1, selectionEnd: 3 });
              await frames(); composition = await p.evaluate(() => imeTrace.events.filter(e => e.type === 'compositionstart'));
              report.geometry.push({ kind: 'composition-owner', isRef, consumer: kind, width, events: await p.evaluate(() => imeTrace.events), state: await p.evaluate(() => ({ active: document.activeElement.outerHTML, owner: imeTrace.input.outerHTML })) });
              assert.ok(composition.some(e => e.trusted && e.active), 'exercise Chromium composition ownership, separately from physical Android/system IME');
            }
            await p.evaluate(() => { imeTrace.events.length = imeTrace.writes.length = imeTrace.scrollCalls.length = 0; });
            const before = await p.evaluate(() => imeTrace.box()), samples = [];
            for (const [h, top] of [[700, 0], [560, 12], [440, 48], [300, 84], [300, 110], [440, 48], [700, 0], [height, 0]]) {
              await p.evaluate(([h, top]) => { Object.assign(imeTrace.viewport, { height: h, offsetTop: top }); for (const type of ['resize', 'scroll']) { imeTrace.viewport.dispatchEvent(new Event(type)); imeTrace.actualViewport.dispatchEvent(new Event(type)); } window.dispatchEvent(new Event('resize')); }, [h, top]);
              await frames(); samples.push(await p.evaluate(() => imeTrace.box()));
            }
            const evidence = await p.evaluate(() => ({ events: imeTrace.events, writes: imeTrace.writes, scrollCalls: imeTrace.scrollCalls }));
            report.geometry.push({ kind: 'visual-only-layout-feedback', isRef, consumer: kind, width, dark, before, samples, composition, ...evidence });
            assert.ok(samples.every(s => s.identity && s.active && s.start === before.start && s.end === before.end), 'input DOM/focus/selection must survive browser viewport animation');
            assert.ok(samples.every(s => s.top === before.top && s.height === before.height && s.width === before.width && s.scrollTop === before.scrollTop), 'match minimal: visual viewport panning does not recenter or scroll the layout viewport dialog');
            assert.deepEqual(evidence.scrollCalls.filter(c => c.active), [], 'no app scrollIntoView fights native keyboard reveal');
            assert.deepEqual(evidence.events.filter(e => /focus|blur/.test(e.type)), [], 'no app focus handoff during keyboard events');
          } finally {
            await p.evaluate(() => imeTrace.cleanup());
            if (composition.length) await (isRef ? refCdp : cdp).send('Input.insertText', { text: '分组编辑' });
          }
        });
      }
      await page.bringToFront(); await open('group'); await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
      const servers = Array.from({ length: 9 }, (_, i) => ({ id: `node-${i}`, name: `Node ${i + 1}`, server_group: i < 3 ? 'Asia' : i < 6 ? 'Europe' : '', region: i < 3 ? 'HK' : 'US', is_online: i % 2 === 0 }));
      await page.evaluate(servers => { dialogFixture.state.props.servers = servers; dialogFixture.state.props.selected = []; document.querySelector('.admin-group-layout details').open = false; }, servers); await frames();
      for (const [p, isRef] of [[ref, true], [page, false]]) {
        await p.bringToFront(); const input = p.locator(isRef ? 'input[role=combobox]' : '#group-name');
        await input.fill(''); await input.click(); await p.waitForFunction(() => !document.querySelector('.admin-group-popover-enter-active') && !document.querySelector('[data-slot=popover-content]')?.getAnimations().some(a => a.playState !== 'finished'));
        const file = path.join(out, `${isRef ? 'reference' : 'target'}-group-options-${width}-${dark}.png`), session = isRef ? refCdp : cdp;
        const image = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
        await check(`${isRef ? 'minimal' : 'CF'} group ${width}: list click/typing/Escape keeps the input focus and selection owner`, async () => {
          const options = p.getByRole('option', { name: /Asia/ }); await options.click();
          assert.equal(await input.inputValue(), 'Asia'); assert.equal(await input.evaluate(el => el === document.activeElement), true);
          await input.click(); await p.keyboard.press('Control+a'); await p.keyboard.type('Asia new'); await p.keyboard.press('Enter');
          assert.equal(await input.inputValue(), 'Asia new', 'Enter keeps the typed new name, not a prefix match');
          assert.equal(await input.evaluate(el => el === document.activeElement), true);
          await input.click(); await p.keyboard.press('Escape');
          if (isRef) await p.locator('[data-slot=popover-content]').waitFor({ state: 'detached' });
          assert.equal(await p.getByRole('dialog').count(), 1, 'first Escape dismisses only the group popover');
        });
      }
      await page.bringToFront();
    }
    await check('real admin rename/dissolve uses one authenticated atomic D1 group-only save and retains failed selection', async () => {
      const { Miniflare } = await import('miniflare');
      const { handleAdminAPI } = await import('../../../src/handlers/admin.js');
      const { generateToken } = await import('../../../src/middleware/auth.js');
      const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("OK"); } }', d1Databases: { DB: 'group-ui' } });
      const requests = [], sys = { password: 'fixture-hash', jwt_secret: 'x'.repeat(32) };
      try {
        const db = await mf.getD1Database('DB'), env = { DB: db }, token = await generateToken(env, sys);
        await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, server_group TEXT)').run();
        const servers = Array.from({ length: 9 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, name: `Node ${i + 1}`, server_group: i < 3 ? 'Asia' : i < 6 ? 'Europe' : '', region: i < 3 ? 'HK' : 'US', is_online: true }));
        for (const server of servers) await db.prepare('INSERT INTO servers VALUES (?, ?)').bind(server.id, server.server_group).run();
        await page.addInitScript(token => localStorage.setItem('jwt_token', token), token);
        await context.route('**/admin/api', async route => {
          const data = route.request().postDataJSON();
          if (data.action === 'batch_group') {
            requests.push(data);
            const response = await handleAdminAPI(new Request(origin + '/admin/api', { method: 'POST', headers: route.request().headers(), body: route.request().postData() }), env, sys);
            return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
          }
          if (data.action === 'edit') throw new Error('group assignment must not send full per-node edit requests');
          const rows = (await db.prepare('SELECT * FROM servers').all()).results;
          return route.fulfill({ json: { success: true, settings: { username: 'fixture', password_configured: true }, servers: servers.map(server => ({ ...server, server_group: rows.find(row => row.id === server.id).server_group })), stats: { total: servers.length } } });
        });
        await metrics(cdp, 390, 844);
        await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=zh#/admin`);
        await page.locator('.server-row').first().waitFor(); await page.evaluate(() => document.body.classList.remove('light'));
        const openGroup = async group => {
          await page.getByRole('button', { name: '分组', exact: true }).click();
          await page.locator('.admin-dialog-group').waitFor();
          await page.locator('.admin-group-picker-toolbar .toolbar-select').click();
          await page.getByRole('option', { name: group, exact: true }).click();
          await page.locator('.admin-toolbar-group-menu').waitFor({ state: 'detached' });
          await page.locator('[data-action=pick-visible]').click();
          assert.equal(await page.locator('.admin-group-picker-list input:checked').count(), 3);
        };
        await openGroup('Asia'); await page.locator('#group-name').fill('  New Asia  ');
        report.geometry.push({ kind: 'group-save-before-click', state: await page.locator('#group-name').evaluate(el => ({ value: el.value, active: document.activeElement.outerHTML, expanded: el.getAttribute('aria-expanded') })) });
        await page.locator('.admin-dialog-group footer button[type=submit]').click();
        await page.locator('.admin-dialog-group').waitFor({ state: 'detached' });
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0], { action: 'batch_group', ids: servers.slice(0, 3).map(s => s.id), server_group: 'New Asia' });
        await page.locator('.admin-dialog-close').click();
        await page.waitForFunction(() => [...document.querySelectorAll('.server-row')].some(row => row.textContent.includes('New Asia')));
        await openGroup('New Asia'); await page.locator('#group-name').fill('');
        await page.locator('.admin-dialog-group footer button[type=submit]').click();
        await page.locator('.admin-dialog-group').waitFor({ state: 'detached' });
        assert.equal(requests.length, 2); assert.equal(requests[1].server_group, '');
        assert.deepEqual((await db.prepare('SELECT server_group FROM servers ORDER BY id').all()).results.map(r => r.server_group), ['', '', '', 'Europe', 'Europe', 'Europe', '', '', '']);
        await page.locator('.admin-dialog-close').click();
        await openGroup('Europe'); await page.locator('#group-name').fill('Rejected name');
        await db.prepare('DELETE FROM servers WHERE id = ?').bind(servers[4].id).run();
        await page.locator('.admin-dialog-group footer button[type=submit]').click();
        await page.locator('.admin-dialog-default').waitFor();
        await page.locator('.admin-dialog-default .admin-dialog-close').click();
        assert.equal(await page.locator('#group-name').inputValue(), 'Rejected name');
        assert.equal(await page.locator('.admin-group-picker-list input:checked').count(), 3, 'failure keeps the pending user selection for correction');
        assert.deepEqual((await db.prepare("SELECT server_group FROM servers WHERE server_group != ''").all()).results.map(r => r.server_group), ['Europe', 'Europe'], 'stale selection cannot partially rename the remaining members');
        await screenshot('real-admin-failed-group-retained');
        report.geometry.push({ kind: 'group-save-real-D1', requests, transport: 'Browser API request headers/body passed to production authenticated handleAdminAPI and Miniflare D1; fixture list/settings reads only.' });
      } finally { await mf.dispose(); }
    });
  } finally { await cdp.detach(); await refCdp.detach(); await ref.close(); }
}
