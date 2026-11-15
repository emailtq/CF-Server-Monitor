import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.ADMIN_NODE_DENSITY_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `node-density-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
const fullV6 = '2001:db8:abcd:1234:5678:90ab:cdef:1234';
const initial = [
  { name: 'Plain', ip_v6: '' },
  { name: 'Dual stack', ip_v6: fullV6 },
  { name: 'Tokyo production database with a deliberately long node name', ip_v6: fullV6 },
  { name: 'Long group', server_group: 'Production-team-with-a-deliberately-long-unbroken-group-name-for-wrap-validation' },
  { name: 'Long OS', os: 'Microsoft Windows Server 2025 build 26100', server_group: 'Production' },
  { name: 'No address', ip_v4: '1', ip_v6: 'false', server_group: '' },
  { name: 'Offline private', is_online: false, is_hidden: '1' },
  { name: 'IPv6 only', ip_v4: '', ip_v6: fullV6 }
].map((extra, i) => ({
  id: `node-${i}`, name: `Node ${i}`, server_group: 'Default', os: 'Ubuntu 24.04.3 LTS', region: 'HK',
  ip_v4: `192.0.2.${i + 1}`, ip_v6: '', is_online: true, is_hidden: '0', timestamp: Date.now() - 7200000,
  traffic_limit: 100, traffic_calc_type: 'sum', net_rx_monthly: 12 * 1024 ** 3, net_tx_monthly: 8 * 1024 ** 3,
  price: '5.00', currency: '$', billing_cycle: 'month', expire_date: '2026-12-01', ...extra
}));
const report = { node: process.version, geometry: [], checks: [], errors: [], screenshots: [], saves: [] };
let server, browser;
let nodes = [...initial];

// Optional acceptance comparison uses unchanged actual React source and the existing lock-pinned dependencies/CSS.
async function prepareReference() {
  const original = path.resolve('../monitor/web-admin/src');
  const existing = path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/reference-audit/nodes-shell/reference');
  const entry = fs.readFileSync(path.join(existing, 'entry.tsx'), 'utf8');
  const admin = fs.readFileSync(path.join(original, 'components/Admin.tsx'), 'utf8');
  for (const [start, end] of [[33, 241], [243, 374], [1580, 1864], [3685, 3694]]) {
    assert.ok(entry.includes(admin.split(/\r?\n/).slice(start - 1, end).join('\n')), `actual Admin.tsx ${start}-${end} unchanged in reused extraction`);
  }
  assert.equal(fs.readFileSync(path.join(existing, 'src/index.css'), 'utf8'), fs.readFileSync(path.join(original, 'index.css'), 'utf8'));
  const synthetic = initial.map((node, i) => ({ id: i + 1, name: node.name, group: node.server_group, country: node.region,
    online: node.is_online, public: node.is_hidden !== '1', last_seen_ago: 7200,
    addresses: [node.ip_v4, node.ip_v6].filter(value => value && value !== '1' && value !== 'false').map(address => ({ address, source: 'manual' })),
    month_used: 20 * 1024 ** 3, traffic_limit: 100 * 1024 ** 3, price: 5, currency: 'USD', expires_at: node.expire_date }));
  const folder = path.join(out, 'reference'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'entry.tsx'), entry.replace(/const nodes=\[.*?\]; function Fixture/s, `const nodes=${JSON.stringify(synthetic)}; function Fixture`));
  const { build } = await import('esbuild');
  await build({ absWorkingDir: folder, entryPoints: ['entry.tsx'], outfile: 'reference.js', bundle: true, format: 'iife', jsx: 'automatic',
    nodePaths: [path.join(existing, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': original, 'radix-ui': path.join(existing, 'radix.ts') }, logLevel: 'warning' });
  fs.copyFileSync(path.join(existing, 'reference.css'), path.join(folder, 'reference.css'));
  report.reference = { original, existing, folder, method: 'unchanged current Admin source chunks; current real ui primitives, React/Radix and compiled original Tailwind; synthetic API/data only', metadataDifference: 'CF also shows flag, OS icon/version, Default group, terminal action; target rows may grow naturally' };
  return folder;
}

async function measure(page, kind) {
  return page.evaluate(kind => {
    const box = el => ({ top: el.getBoundingClientRect().top, left: el.getBoundingClientRect().left, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height });
    const style = el => { const s = getComputedStyle(el); return { ...box(el), padding: s.padding, size: s.fontSize, line: s.lineHeight, minHeight: s.minHeight, display: s.display, gap: s.rowGap, whiteSpace: s.whiteSpace }; };
    return { coarse: matchMedia('(pointer: coarse)').matches, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      rows: [...document.querySelectorAll('tbody tr')].map(row => ({ ...box(row), cells: [...row.cells].filter(cell => getComputedStyle(cell).display !== 'none').map(cell => ({ ...style(cell), children: [...cell.children].map(style) })),
        addresses: [...row.cells[1].querySelectorAll('button')].map(button => ({ ...style(button), text: button.textContent, label: button.getAttribute('aria-label'), icon: button.querySelector('svg') ? style(button.querySelector('svg')) : null })),
        addressList: row.cells[1].querySelector('div') ? style(row.cells[1].querySelector('div')) : null
      })) };
  }, kind);
}
async function check(name, fn) {
  try { await fn(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, pass: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  const reference = process.env.ADMIN_NODE_DENSITY_REFERENCE === '1' ? await prepareReference() : null;
  server = await createServer({ cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  const httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`, origin = httpOrigin.replace('http:', 'https:');
  browser = await chromium.launch({ headless: true, executablePath: process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  report.chromium = browser.version();
  for (const width of [360, 390, 1440, 1920]) for (const dark of [false, true]) {
    const coarse = width < 640, context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: coarse, isMobile: coarse, colorScheme: dark ? 'dark' : 'light' });
    await context.addInitScript(() => {
      window.copiedValues = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedValues.push(text); } } });
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/reference/')) {
        const file = path.join(reference, path.basename(url.pathname));
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css' });
      }
      if (url.pathname.endsWith('/admin/api')) {
        const data = route.request().postDataJSON();
        if (data.action === 'save_order') { report.saves.push({ width, dark, orders: data.orders }); nodes = data.orders.map(id => nodes.find(node => node.id === id)); }
        return route.fulfill({ json: data.action === 'list' ? { servers: nodes, stats: { total: nodes.length } } : data.action === 'get_settings' ? { settings: { site_title: 'CF Monitor', username: 'fixture', terminal_enabled: false } } : { success: true } });
      }
      if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
      const asset = url.pathname.replace(/^\/test\/fixtures\/admin-ui\/(?=flags\/|os-icons\/)/, '/');
      return route.fulfill({ response: await route.fetch({ url: httpOrigin + asset + url.search }) });
    });
    const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => report.errors.push(error.stack));
    let referenceGeometry;
    if (reference) {
      await page.goto(origin); await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/reference/reference.css">');
      if (dark) await page.evaluate(() => history.replaceState(null, '', '?dark=1'));
      await page.addScriptTag({ url: '/reference/reference.js' }); await page.locator('tbody tr').first().waitFor();
      referenceGeometry = await measure(page, 'reference'); report.geometry.push({ kind: 'reference', width, dark, ...referenceGeometry });
      const shot = path.join(out, `reference-${width}-${dark ? 'dark' : 'light'}.png`); await page.screenshot({ path: shot }); report.screenshots.push(shot);
    }
    for (const locale of ['zh', 'en']) {
      nodes = [...initial];
      await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=${locale}#/admin`);
      await page.locator('.server-row').first().waitFor(); await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
      const geometry = await measure(page, 'cf'); report.geometry.push({ kind: 'cf', width, dark, locale, ...geometry });
      const shot = path.join(out, `cf-${width}-${dark ? 'dark' : 'light'}-${locale}.png`); await page.screenshot({ path: shot }); report.screenshots.push(shot);
      await check(`compact intrinsic cells ${width}/${dark ? 'dark' : 'light'}/${locale}`, async () => {
        assert.equal(geometry.coarse, coarse); assert.ok(geometry.pageWidth <= width);
        const dual = geometry.rows[1];
        assert.equal(dual.addressList.display, 'grid'); assert.equal(dual.addressList.gap, '2px');
        assert.equal(dual.addressList.height, coarse ? 50 : 42);
        for (const row of geometry.rows) {
          for (const address of row.addresses) { assert.equal(address.line, '20px'); assert.equal(address.size, '14px'); assert.equal(address.height, coarse ? 24 : 20); assert.equal(address.whiteSpace, 'nowrap'); assert.equal(address.icon.width, 12); }
          const content = Math.max(...row.cells.flatMap(cell => cell.children.map(child => child.height)));
          assert.ok(Math.abs(row.height - (content + 17)) < 1, `row follows its tallest actual cell + p-2/divider: ${JSON.stringify({ row: row.height, content })}`);
        }
        assert.equal(geometry.rows[5].addresses.length, 0);
        assert.ok(geometry.rows[2].height > geometry.rows[0].height, 'long name grows naturally');
        assert.ok(geometry.rows[3].height > geometry.rows[0].height, 'long group grows naturally');
        assert.equal(dual.addresses[1].text.trim(), '2001:db8…cdef:1234'); assert.ok(dual.addresses[1].label.includes(fullV6));
        if (referenceGeometry) {
          assert.equal(dual.addressList.gap, referenceGeometry.rows[1].addressList.gap);
          assert.equal(dual.addresses[1].text.trim(), referenceGeometry.rows[1].addresses[1].text.trim());
          assert.equal(dual.cells[1].padding, referenceGeometry.rows[1].cells[1].padding);
          assert.equal(dual.addresses[0].line, referenceGeometry.rows[1].addresses[0].line);
        }
        assert.ok((await page.locator('[data-server-id="node-5"] .admin-node-group').innerText()).trim());
        assert.equal(await page.locator('[data-server-id="node-4"] .admin-node-os').innerText(), 'Windows Server 2025');
        assert.equal(await page.locator('.flag-img').count(), initial.length); assert.equal(await page.locator('.os-icon-img').count(), initial.length);
        const toolbarRows = await page.locator('#tab-servers .toolbar > button').evaluateAll(buttons => new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size);
        assert.equal(toolbarRows, 1, 'accepted group/bulk-add/add stays one row');
      });
      await check(`full-value copy and focus ${width}/${dark ? 'dark' : 'light'}/${locale}`, async () => {
        const address = page.locator('[data-server-id="node-1"] .server-ip-list button').nth(1);
        await address.scrollIntoViewIfNeeded();
        if (coarse) await address.tap(); else await address.click();
        await page.waitForFunction(() => window.copiedValues.length === 1);
        assert.deepEqual(await page.evaluate(() => window.copiedValues), [fullV6]);
        assert.equal(await address.getAttribute('title'), fullV6);
        assert.ok((await address.getAttribute('class')).includes('spec-copied'));
        await page.keyboard.press('Tab'); await address.focus();
        assert.equal(await address.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid'), true);
        await page.keyboard.press('Enter'); await page.keyboard.press('Space');
        assert.deepEqual(await page.evaluate(() => window.copiedValues), [fullV6, fullV6, fullV6]);
        const icon = address.locator('svg');
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-server-id="node-1"] .server-ip-list button:nth-child(2) svg')).opacity === '1');
        assert.equal(await icon.evaluate(el => getComputedStyle(el).opacity), '1');
        assert.equal(await icon.locator('path').count(), 1, 'copy success renders its check feedback');
        const focusBox = await address.evaluate(el => {
          const a = el.getBoundingClientRect(), b = el.closest('td').getBoundingClientRect(), css = getComputedStyle(el), ring = parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset);
          return { left: a.left - ring, right: a.right + ring, top: a.top - ring, bottom: a.bottom + ring, cellLeft: b.left, cellRight: b.right, cellTop: b.top, cellBottom: b.bottom };
        });
        assert.ok(focusBox.left >= focusBox.cellLeft && focusBox.right <= focusBox.cellRight && focusBox.top >= focusBox.cellTop && focusBox.bottom <= focusBox.cellBottom, 'copy focus ring stays inside the padded cell');
        const shot = path.join(out, `copy-focus-${width}-${dark ? 'dark' : 'light'}-${locale}.png`);
        await page.screenshot({ path: shot }); report.screenshots.push(shot);
        if (coarse) {
          const buttons = page.locator('[data-server-id="node-1"] .server-ip-list button');
          const bounds = await buttons.evaluateAll(buttons => buttons.map(button => {
            const r = button.getBoundingClientRect();
            const points = [[r.left + .5, r.top + .5], [r.right - .5, r.top + .5], [r.left + .5, r.bottom - .5], [r.right - .5, r.bottom - .5]];
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, hit: points.every(([x, y]) => button.contains(document.elementFromPoint(x, y))) };
          }));
          assert.ok(bounds.every(bound => bound.hit), 'all four address target corners hit only their own button');
          assert.equal(bounds[1].top - bounds[0].bottom, 2, 'the two 24px touch targets never overlap');
          const cdp = await context.newCDPSession(page);
          for (const bound of bounds) for (const y of [bound.top + .5, bound.bottom - .5]) {
            const touchPoints = [{ x: (bound.left + bound.right) / 2, y }];
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          }
          await cdp.detach();
          assert.deepEqual(await page.evaluate(() => window.copiedValues.slice(3)), ['192.0.2.2', '192.0.2.2', fullV6, fullV6], 'top and bottom touch edges copy the intended complete family');
          report.geometry.push({ kind: 'address-touch-edges', width, dark, locale, bounds });
        }
      });
    }
    await check(`half-overlap reversal, lift and keyboard save ${width}/${dark ? 'dark' : 'light'}`, async () => {
      const row = page.locator('[data-server-id="node-0"]'), handle = row.locator('.drag-handle');
      await handle.scrollIntoViewIfNeeded(); await page.evaluate(() => { document.querySelector('.table-wrapper').scrollLeft = 0; });
      await page.waitForTimeout(170);
      const h = await handle.boundingBox(), r = await row.boundingBox(), x = h.x + h.width / 2, y = h.y + h.height / 2;
      const cdp = coarse ? await context.newCDPSession(page) : null;
      const send = async (type, py) => cdp ? cdp.send('Input.dispatchTouchEvent', { type: type === 'down' ? 'touchStart' : type === 'move' ? 'touchMove' : 'touchEnd', touchPoints: type === 'up' ? [] : [{ x, y: py }] }) : type === 'down' ? (await page.mouse.move(x, py), page.mouse.down()) : type === 'move' ? page.mouse.move(x, py) : page.mouse.up();
      await send('down', y);
      await page.waitForFunction(() => document.querySelector('[data-server-id="node-0"]').hasAttribute('data-lifted'));
      const paint = await row.evaluate(el => ({ opacity: getComputedStyle(el).opacity, border: getComputedStyle(el, '::after').borderTopColor, divider: getComputedStyle(el.querySelector('td')).borderBottomColor }));
      assert.equal(paint.opacity, '1'); assert.equal(paint.border, paint.divider);
      await send('move', y + r.height * .3); assert.equal(await page.locator('.server-row').first().getAttribute('data-server-id'), 'node-0');
      await send('move', y + r.height * .55);
      await page.waitForFunction(() => document.querySelector('.server-row').dataset.serverId === 'node-1');
      const shot = path.join(out, `lift-${width}-${dark ? 'dark' : 'light'}.png`); await page.screenshot({ path: shot }); report.screenshots.push(shot);
      await send('move', y + r.height * .3);
      await page.waitForFunction(() => document.querySelector('.server-row').dataset.serverId === 'node-0');
      const saves = report.saves.length; await send('up', y + r.height * .3); await cdp?.detach();
      assert.equal(report.saves.length, saves, 'returning to original order saves nothing');
      await handle.focus(); await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => document.querySelector('.server-row').dataset.serverId === 'node-1');
      await page.waitForTimeout(170); assert.equal(report.saves.length, saves + 1);
      assert.equal(await handle.evaluate(el => el === document.activeElement), true);
    });
    await context.close();
  }
  // The existing public fixture remains separate from the owned node-table selectors.
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/fixtures/admin-ui/index.html?mode=public#/`);
  await page.locator('#public-control').waitFor();
  assert.equal(await page.locator('.admin-node-table').count(), 0); await context.close();
} catch (error) { report.errors.push(error.stack); console.error(error.stack); }
finally {
  await browser?.close(); await server?.close(); report.closed = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${out}`);
}
if (report.errors.length || report.checks.some(check => !check.pass)) process.exitCode = 1;
