import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { PING_NODE_FIELDS } from '../../../src/frontend/utils/pingNode.js';
import { validatePingNode } from '../../../src/shared/pingNode.js';

const { chromium } = createRequire(import.meta.url)(process.env.ADMIN_UI_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = path.resolve('.planning/2026-11-13-admin-ui-refinement/successor/stage1');
fs.mkdirSync(base, { recursive: true });
const out = process.env.ADMIN_SUCCESSOR_REPORT_DIR ? path.resolve(process.env.ADMIN_SUCCESSOR_REPORT_DIR) : fs.mkdtempSync(path.join(base, 'registered-'));
fs.mkdirSync(out, { recursive: true });
const referenceRoot = path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/reference-audit/dialogs');
const compareReference = process.argv.includes('--reference');
const report = { checks: [], screenshots: [], geometry: [], actions: [], errors: [] };
let server, referenceServer, browser, ctx, page, cdp;
const check = async (name, run) => {
  try { await run(); report.checks.push({ name, pass: true }); console.log('PASS', name); }
  catch (error) { report.checks.push({ name, pass: false, error: error.stack }); console.error('FAIL', name, error.stack); await snap(`failure-${report.checks.length}`).catch(() => {}); }
};
const snap = async name => { const file = path.join(out, `${name}.png`); const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(data, 'base64')); report.screenshots.push(file); };
const frames = async () => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
const nodes = () => Array.from({ length: 9 }, (_, i) => ({ id: `node-${i}`, name: `Node ${i + 1}`, server_group: i < 3 ? 'Asia' : i < 6 ? 'Europe' : '', region: i < 3 ? 'HK' : 'US', os: 'Ubuntu 24.04.3 LTS', is_online: i % 2 === 0 }));
const seed = () => ({ username: 'fixture', site_title: 'Fixture', password_configured: true, custom_ct: 'example.test:443', custom_ct_name: 'Configured', custom_cu: '', custom_cu_name: 'Name without target', custom_cm: '', custom_cm_name: '', custom_bd: '', custom_bd_name: '', ...Object.fromEntries(['node_1', 'node_2', 'node_3', 'node_4'].flatMap((field, i) => [[field, ''], [`${field}_name`, '']])) });
const ids = () => page.locator('#tab-servers tbody .server-row').evaluateAll(rows => rows.map(row => row.dataset.serverId));
const load = async (width = 390, dark = false, locale = 'zh', full = false) => {
  await ctx?.close();
  ctx = await browser.newContext({ viewport: { width, height: width < 640 ? 844 : 900 }, hasTouch: width < 640, isMobile: width < 640, deviceScaleFactor: 1 });
  let saved = full === 'empty' ? { username: 'fixture', password_configured: true } : full === 'defaults' ? { username: 'fixture', password_configured: true, custom_ct: 'ct.test', custom_cu: 'cu.test', custom_cm: 'cm.test', custom_ct_name: '电信', custom_cu_name: '联通', custom_cm_name: '移动', custom_bd_name: 'BGP', node_1_name: 'Node 1', node_2_name: 'Node 2', node_3_name: 'Node 3', node_4_name: 'Node 4' } : seed(), servers = nodes();
  if (full === true) for (const [i, field] of PING_NODE_FIELDS.entries()) { saved[field] = `node${i}.test`; saved[`${field}_name`] = `Saved ${i}`; }
  let configuredPingNodes = full === 'defaults' ? ['custom_ct', 'custom_cu', 'custom_cm'] : PING_NODE_FIELDS.filter(field => saved[field] || saved[`${field}_name`]);
  let revision = 1, nextTask = 1;
  let tasks = configuredPingNodes.filter(field => saved[field]).map(field => ({ id: `task-${nextTask++}`, name: saved[`${field}_name`] || field, target: saved[field], interval: 60, nodes: servers.map(node => node.id), auto_join: true }));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith('/admin/api')) {
      const data = route.request().postDataJSON(); report.actions.push(data);
      if (data.action.startsWith('latency_')) {
        if (data.action === 'latency_save') {
          if (!validatePingNode(data.task.target).valid || !data.task.name) return route.fulfill({ status: 400, json: { error: 'latency_invalid' } });
          tasks.push({ ...data.task, id: `task-${nextTask++}` }); revision++;
        } else if (data.action === 'latency_delete') { tasks = tasks.filter(task => task.id !== data.id); revision++; }
        return route.fulfill({ json: { tasks, revision } });
      }
      if (data.action === 'add') servers.push({ id: 'added', name: data.name });
      if (data.action === 'save_settings') { saved = { ...saved, ...data.settings }; configuredPingNodes = PING_NODE_FIELDS.filter(field => saved[field] || saved[`${field}_name`]); }
      if (data.action === 'save_order') servers = data.orders.map(id => servers.find(server => server.id === id));
      return route.fulfill({ json: { success: true, settings: saved, configuredPingNodes, servers, stats: { total: servers.length } } });
    }
    if (url.pathname.endsWith('/api/config') || url.pathname.endsWith('/theme')) return route.fulfill({ json: {} });
    return route.continue();
  });
  page = await ctx.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => report.errors.push(error.stack));
  await page.addInitScript(() => { window.touchEvidence = []; for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.addEventListener(type, e => window.touchEvidence.push({ type, pointerType: e.pointerType, y: e.clientY }), true); });
  cdp = await ctx.newCDPSession(page);
  await page.goto(`${origin}/test/fixtures/admin-ui/index.html?mode=admin&locale=${locale}#/admin`);
  await page.locator('.server-row').first().waitFor();
  await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
  await frames();
};
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
try {
  server = await createServer({ cacheDir: path.join(out, '.cache'), plugins: [vue()], publicDir: path.resolve('public') });
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: process.env.ADMIN_UI_CHROMIUM || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  report.chromium = browser.version();
  for (const width of [360, 390]) for (const dark of [false, true]) await check(`Android ${width}/${dark ? 'dark' : 'light'} real touch up/down half-overlap reversal and divider lift frame`, async () => {
    await load(width, dark);
    await page.addStyleTag({ content: '.server-row .admin-node-name { min-height: 44px; }' });
    const rows = page.locator('.server-row'), a = await rows.nth(1).boundingBox(), b = await rows.nth(2).boundingBox();
    assert.ok(Math.abs(a.height - b.height) < 1, 'equal-row regression isolates the reverse gate');
    const handle = await rows.nth(2).locator('.drag-handle').boundingBox(), x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await touch('touchStart', x, y);
    await touch('touchMove', x, y - a.height * .49); await frames(); assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-1', 'node-2']);
    await touch('touchMove', x, y - a.height * .52); await frames(); assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-2', 'node-1']);
    await page.waitForTimeout(170);
    const lifted = page.locator('[data-server-id=node-2]');
    const paint = await lifted.evaluate(row => ({ frame: getComputedStyle(row, '::after').borderTopColor, frameWidth: getComputedStyle(row, '::after').borderTopWidth, divider: getComputedStyle(row.cells[0]).borderBottomColor, opacity: getComputedStyle(row).opacity, shadow: getComputedStyle(row).boxShadow }));
    report.geometry.push({ width, dark, paint }); await snap(`touch-lift-${width}-${dark ? 'dark' : 'light'}`);
    for (const d of [-1, 1, -1, 1]) { await touch('touchMove', x, y - a.height * .52 + d); await frames(); }
    assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-2', 'node-1'], 'one-pixel jitter must not reverse');
    await touch('touchMove', x, y - a.height * .48); await frames();
    assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-1', 'node-2'], 'reverse swaps at half overlap, without another half-row travel');
    await touch('touchEnd'); assert.equal((await page.evaluate(() => window.touchEvidence)).filter(e => e.pointerType === 'touch').length > 2, true);
    assert.equal(paint.frameWidth, '1px'); assert.equal(paint.frame, paint.divider); assert.equal(paint.opacity, '1'); assert.notEqual(paint.shadow, 'none');
  });
  await check('name-only add uses unchanged create authority without group property', async () => {
    await load(); await page.locator('.toolbar .btn-primary').click();
    assert.equal(await page.locator('#add-server-group').count(), 0);
    await page.locator('#add-server-name').fill('Added node'); await page.getByRole('dialog').locator('footer .btn-primary').click(); await page.locator('[data-server-id=added]').waitFor();
    assert.deepEqual(report.actions.filter(a => a.action === 'add').at(-1), { action: 'add', name: 'Added node' });
  });
  const taskRows = () => page.locator('.latency-table tbody tr[data-server-id]');
  const addTask = async (name, target, trans) => {
    await page.locator('.latency-toolbar').getByRole('button', { name: trans.latencyAdd, exact: true }).click();
    await page.getByRole('textbox', { name: trans.latencyName, exact: true }).fill(name);
    await page.getByRole('textbox', { name: trans.latencyTarget, exact: true }).fill(target);
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${trans.save}$`, 'i') }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  await check('empty task catalog adds and removes one persisted monitor without phantom legacy labels', async () => {
    const trans = (await import('../../../src/frontend/locales/zh.js')).default;
    await load(390, false, 'zh', 'empty'); await page.locator('[data-page=collection]').click();
    await page.getByText(trans.latencyEmpty, { exact: true }).waitFor(); assert.equal(await taskRows().count(), 0);
    await addTask('Node 1', 'first.test:443', trans);
    await page.reload(); await page.locator('[data-page=collection]').click(); await taskRows().first().waitFor();
    assert.equal(await taskRows().count(), 1);
    await page.getByRole('button', { name: trans.latencyDelete + ': Node 1', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: trans.delete, exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.reload(); await page.locator('[data-page=collection]').click(); await page.getByText(trans.latencyEmpty, { exact: true }).waitFor();
    assert.equal(await taskRows().count(), 0);
  });
  await check('three migrated target tasks add a fourth without assigning spare legacy names', async () => {
    const trans = (await import('../../../src/frontend/locales/zh.js')).default;
    await load(390, false, 'zh', 'defaults'); await page.locator('[data-page=collection]').click(); await taskRows().first().waitFor();
    assert.equal(await taskRows().count(), 3);
    await addTask('Node 4', 'fourth.test:443', trans);
    await page.reload(); await page.locator('[data-page=collection]').click(); await taskRows().first().waitFor();
    assert.equal(await taskRows().count(), 4);
  });
  for (const tall of [1, 2]) for (const direction of [-1, 1]) await check(`Android unequal row ${tall} direction ${direction} uses stable half-overlap and actual turning point`, async () => {
    await load(390, true);
    await page.addStyleTag({ content: `.server-row[data-server-id="node-${tall}"] .admin-node-name { min-height: 140px; }` });
    const from = direction > 0 ? 1 : 2, draggedId = `node-${from}`, targetId = `node-${direction > 0 ? 2 : 1}`;
    const row = page.locator(`[data-server-id="${draggedId}"]`), target = page.locator(`[data-server-id="${targetId}"]`);
    const a = await row.boundingBox(), b = await target.boundingBox(), h = Math.min(a.height, b.height), p = await row.locator('.drag-handle').boundingBox(), x = p.x + p.width / 2, y = p.y + p.height / 2;
    const boundary = direction > 0 ? b.y - a.y - a.height + h / 2 : b.y + b.height - a.y - h / 2;
    await touch('touchStart', x, y); await touch('touchMove', x, y + boundary - direction * 3); await frames();
    assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-1', 'node-2']);
    await touch('touchMove', x, y + boundary + direction * 3); await frames(); await page.waitForTimeout(170);
    assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-2', 'node-1']);
    for (const wobble of [-1, 1, -1, 1]) { await touch('touchMove', x, y + boundary + direction * 3 + wobble); await frames(); }
    assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-2', 'node-1']);
    // Continue into the unequal row, then reverse by only a few pixels, not another half-row.
    await touch('touchMove', x, y + boundary + direction * 12); await frames();
    await touch('touchMove', x, y + boundary - direction * 3); await frames();
    assert.deepEqual((await ids()).slice(0, 3), ['node-0', 'node-1', 'node-2']); await touch('touchEnd');
  });
  for (const [width, dark, locale] of [[390, false, 'zh'], [360, true, 'en'], [1440, false, 'zh'], [1440, true, 'fr']]) await check(`task add/remove/unlimited capacity/save ${width}/${locale}/${dark}`, async () => {
    const trans = (await import(`../../../src/frontend/locales/${locale}.js`)).default;
    await load(width, dark, locale); await page.locator('[data-page=collection]').click(); await taskRows().first().waitFor();
    assert.equal(await taskRows().count(), 1, 'a legacy name without target must not become a runnable task');
    const originalId = await taskRows().first().getAttribute('data-server-id');
    await page.locator('.latency-toolbar').getByRole('button', { name: trans.latencyAdd, exact: true }).click();
    await page.getByRole('textbox', { name: trans.latencyName, exact: true }).fill('Node 2');
    await page.getByRole('textbox', { name: trans.latencyTarget, exact: true }).fill('https://invalid.test');
    const before = report.actions.filter(action => action.action === 'latency_save').length;
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${trans.save}$`, 'i') }).click();
    await page.getByRole('dialog').getByText(trans.latencyInvalid, { exact: true }).waitFor();
    assert.equal(report.actions.filter(action => action.action === 'latency_save').length, before, 'invalid target must not reach the API');
    await page.getByRole('textbox', { name: trans.latencyTarget, exact: true }).fill('new.test:443');
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${trans.save}$`, 'i') }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await taskRows().count(), 2); assert.equal(await taskRows().first().getAttribute('data-server-id'), originalId);
    for (let i = 3; i <= 9; i++) await addTask(`Node ${i}`, `node${i}.test:443`, trans);
    assert.equal(await taskRows().count(), 9); assert.equal(await page.locator('.latency-toolbar').getByRole('button', { name: trans.latencyAdd, exact: true }).isEnabled(), true);
    assert.ok(await page.locator('[data-ping-resource-warning]').innerText());
    assert.equal(await page.locator('.latency-page').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await snap(`tasks-${width}-${locale}-${dark}`);
    await page.reload(); await page.locator('[data-page=collection]').click(); await taskRows().first().waitFor(); assert.equal(await taskRows().count(), 9);
    await load(width, dark, locale, true); await page.locator('[data-page=collection]').click(); await taskRows().first().waitFor();
    assert.equal(await taskRows().count(), 8, 'all eight configured legacy targets remain runnable in the task catalog');
  });
  referenceServer = http.createServer((request, response) => {
    const relative = new URL(request.url, 'http://fixture.invalid').pathname.slice(1), file = path.resolve(referenceRoot, relative);
    if (!file.startsWith(referenceRoot + path.sep) || !['reference.html', 'reference.js', 'reference.css'].includes(relative)) { response.statusCode = 404; return response.end(); }
    response.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => referenceServer.listen(0, '127.0.0.1', resolve));
  for (const [width, dark, locale] of [[360, false, 'zh'], [390, true, 'zh'], [1440, false, 'zh'], [1440, true, 'en']]) await check(`actual minimal group reference layout/keyboard and CF filtered selection ${width}/${dark}/${locale}`, async () => {
    await load(width, dark, locale); await page.locator('.toolbar button').filter({ has: page.locator('[data-reference-icon=layers]') }).click();
    await page.locator('.admin-group-dialog-enter-active').waitFor({ state: 'detached' });
    const targetCdp = cdp, target = page, ref = await ctx.newPage();
    const refOrigin = `http://127.0.0.1:${referenceServer.address().port}`;
    await ref.route('**/*', route => new URL(route.request().url()).origin === refOrigin ? route.continue() : route.abort());
    if (compareReference) {
      await ref.goto(`${refOrigin}/reference.html?dark=${Number(dark)}`); await ref.waitForFunction(() => window.referenceOpen); await ref.evaluate(() => window.referenceOpen('group')); await ref.locator('[data-slot=dialog-content]').waitFor(); await ref.waitForTimeout(220);
      page = ref; cdp = await ctx.newCDPSession(ref); await snap(`group-reference-${width}-${dark}`); page = target; cdp = targetCdp;
    }
    await snap(`group-target-${width}-${dark}-${locale}`);
    const dimensions = async (p, shell, input, list) => p.evaluate(({ shell, input, list }) => { const s = document.querySelector(shell), i = s.querySelector(input), l = s.querySelector(list), css = getComputedStyle(s); return { width: s.getBoundingClientRect().width, padding: css.padding, radius: css.borderRadius, inputHeight: i?.getBoundingClientRect().height, columns: l ? getComputedStyle(l).gridTemplateColumns.split(' ').length : 0 }; }, { shell, input, list });
    assert.equal(await target.locator('.admin-dialog-group').count(), 1, 'group uses the source-equivalent bounded dialog');
    const actual = await dimensions(target, '.admin-dialog-group', '#group-name', '.admin-group-picker-list');
    assert.equal(actual.width, width < 640 ? width - 32 : 672); assert.equal(actual.columns, width < 480 ? 1 : width < 640 ? 2 : 3);
    if (compareReference) {
    const expected = await dimensions(ref, '[data-slot=dialog-content]', 'input[role=combobox]', '.grid.max-h-\\[min\\(16rem\\,40dvh\\)\\]');
    report.geometry.push({ width, dark, locale, actual, expected });
    assert.ok(Math.abs(actual.width - expected.width) <= (width < 640 ? 8 : 1)); assert.equal(actual.padding, expected.padding); assert.equal(actual.radius, expected.radius); assert.equal(actual.inputHeight, expected.inputHeight); assert.equal(actual.columns, expected.columns);
    const controlStyles = async (p, selectors) => p.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => { const e = document.querySelector(selector), s = getComputedStyle(e); return [key, { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, background: s.backgroundColor, color: s.color, border: s.borderColor, radius: s.borderRadius, padding: s.padding, height: e.getBoundingClientRect().height }]; })), selectors);
    const candidate = await controlStyles(target, { title: '.admin-dialog-group h2', name: '#group-name', search: '.admin-group-picker-search input', select: '.admin-group-picker-toolbar .toolbar-select', row: '.admin-group-picker-list label', footer: '.admin-dialog-group footer .btn-primary' });
    const baseline = await controlStyles(ref, { title: '[data-slot=dialog-title]', name: 'input[role=combobox]', search: 'input[aria-label="搜索节点"]', select: '[data-slot=select-trigger]', row: '[data-slot=dialog-content] .grid label', footer: '[data-slot=dialog-footer] button[type=submit]' });
    report.geometry.push({ width, dark, candidate, baseline });
    for (const key of ['title', 'name', 'search', 'select', 'row', 'footer']) for (const property of ['fontSize', 'fontWeight', 'lineHeight', 'radius', 'height']) assert.equal(candidate[key][property], baseline[key][property], `${key}.${property}`);
    // White has identical coordinates in OKLCH/OKLab; Tailwind color-mix serializes the latter.
    for (const key of ['name', 'search', 'select', 'row', 'footer']) for (const property of ['background', 'color', 'padding']) assert.equal(candidate[key][property].replace('oklch(1 0 0', 'oklab(1 0 0'), baseline[key][property].replace('oklch(1 0 0', 'oklab(1 0 0'), `${key}.${property}`);
    }
    const groupFilter = target.locator('.admin-group-picker-toolbar .toolbar-select');
    await groupFilter.click(); await target.keyboard.press('Escape'); await target.locator('.admin-toolbar-group-menu').waitFor({ state: 'detached' });
    assert.equal(await target.locator('.admin-dialog-group').count(), 1, 'Escape dismisses the owned filter dropdown, not its group dialog');
    assert.equal(await groupFilter.evaluate(e => e === document.activeElement), true, 'filter Escape restores the dropdown trigger focus');
    await groupFilter.click(); await target.getByRole('option', { name: target === page && locale === 'zh' ? '未分组' : 'Ungrouped', exact: true }).click(); await target.locator('.admin-toolbar-group-menu').waitFor({ state: 'detached' });
    assert.equal(await target.locator('.admin-group-picker-list input').count(), 3);
    await groupFilter.click(); await target.getByRole('option', { name: locale === 'zh' ? '全部分组' : 'All groups', exact: true }).click(); await target.locator('.admin-toolbar-group-menu').waitFor({ state: 'detached' });
    const input = target.locator('#group-name'); await input.click(); assert.equal(await target.locator('.admin-group-options [role=option]').count(), 3); assert.equal(await input.evaluate(e => e === document.activeElement), true);
    await target.locator('.admin-group-popover-enter-active').waitFor({ state: 'detached' }); await snap(`group-options-target-${width}-${dark}`);
    assert.match(await input.evaluate(e => getComputedStyle(e).boxShadow), /3px/, 'group text field paints its reference focus ring');
    assert.equal(await target.locator('.admin-group-options').evaluate(e => e.scrollHeight <= e.clientHeight + 1), true, 'short group options do not gain a phantom scrollbar from their border');
    if (compareReference) { await ref.locator('input[role=combobox]').click(); await ref.waitForTimeout(160); page = ref; cdp = await ctx.newCDPSession(ref); await snap(`group-options-reference-${width}-${dark}`); page = target; cdp = targetCdp; }
    await input.fill('As'); await target.keyboard.press('Enter'); assert.equal(await input.inputValue(), 'As'); await input.click(); await target.keyboard.press('ArrowDown'); await target.keyboard.press('Enter'); assert.equal(await input.inputValue(), 'Europe');
    await target.locator('.admin-group-picker-search input').fill('Node 1'); await target.locator('[data-action=pick-visible]').click(); assert.equal(await target.locator('.admin-group-picker-list input:checked').count(), 1);
    await target.locator('.admin-group-picker-search input').fill('Node 4'); await target.locator('[data-action=pick-visible]').click(); assert.equal(await target.locator('.admin-group-picker-list input:checked').count(), 1); await target.locator('.admin-group-picker-search input').fill(''); assert.equal(await target.locator('.admin-group-picker-list input:checked').count(), 2);
    await target.locator('.admin-group-picker-search input').fill('missing'); assert.equal(await target.locator('[data-action=pick-visible]').isDisabled(), true); await target.locator('.admin-group-picker-search input').fill('');
    await target.locator('.admin-group-layout details summary').click(); assert.equal(await target.locator('.admin-group-layout details button').count(), 3, 'CF-only batch and cache actions remain reachable');
    if (width < 640) {
      await target.setViewportSize({ width, height: 300 }); await target.waitForFunction(() => document.querySelector('.admin-dialog').getAnimations().every(animation => animation.playState === 'finished')); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await target.locator('.admin-group-layout details summary').click(); await input.focus(); await input.evaluate(e => e.scrollIntoView({ block: 'center' }));
      assert.equal(await input.evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true, 'name remains visible in the keyboard viewport');
      await snap(`group-keyboard-${width}-${locale}`);
    }
    await input.click(); await target.keyboard.press('Escape'); assert.equal(await target.getByRole('dialog').count(), 1, 'first Escape closes only the group list'); await target.keyboard.press('Escape'); await target.getByRole('dialog').waitFor({ state: 'detached' }); await ref.close();
  });
} catch (error) { report.failure = error.stack; process.exitCode = 1; console.error(error.stack); }
finally {
  await ctx?.close(); await browser?.close(); await server?.close(); if (referenceServer) await new Promise(resolve => referenceServer.close(resolve));
  report.resourcesClosed = true; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('Evidence:', out);
}
if (report.errors.length || report.checks.some(check => !check.pass)) process.exitCode = 1;
