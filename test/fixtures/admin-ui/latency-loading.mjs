import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness, until } from '../../terminal-harness.js';
import { saveSiteOptions } from '../../../src/utils/settings.js';
import { runLatencyMetadataChecks } from './latency-metadata-checks.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const out = path.resolve(process.env.CFSM_LATENCY_LOADING_EVIDENCE || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `round4-latency-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
const baseline = process.argv.includes('--baseline');
const addRecoveryOnly = process.argv.includes('--add-recovery-only');
const phase43Only = process.argv.includes('--phase43-only') || process.argv.includes('--metadata-only') || process.argv.includes('--add-node-only') || process.argv.includes('--staged-metadata-only') || process.argv.includes('--metadata-errors-only');
const receipt = { baseline, addRecoveryOnly, localMiniflareNotProduction: true, checks: [], screenshots: [], timings: [], browserErrors: [] };
let server, browser, context, page, a, b;
const pendingApi = new Set();
const holds = [];
const hold = (site, action, status) => {
  const item = { site, action, status, arrived: false, done: false };
  item.promise = new Promise(resolve => { item.release = resolve; });
  holds.push(item); return item;
};
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const shot = async name => { const file = path.join(out, `${name}-${receipt.dark ? 'dark' : 'light'}.png`); await page.screenshot({ path: file }); receipt.screenshots.push(file); };
const shell = async () => ({ heads: await page.locator('.latency-table thead th').allTextContents(), status: await page.locator('.latency-page [role=status]').allTextContents(), rows: await page.locator('.latency-table tbody tr').allTextContents() });
const waitHold = async item => {
  for (let attempt = 0; attempt < 500; attempt++) { if (item.arrived) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Expected held ${item.site}/${item.action} request did not arrive`);
};
async function enter() { await page.locator('[data-page=collection]').click(); await page.locator('.latency-page').waitFor(); await page.evaluate(() => window.observeLatencyAcceptance?.()); await frames(); }
async function trace() { receipt.timings.push(await page.evaluate(() => window.latencyTrace)); }
try {
  a = await harness({ traceD1: true }); b = await harness({ traceD1: true });
  for (const h of [a, b]) await saveSiteOptions(h.db, { is_public: 'true', theme_url: '', last_agent_version: '1.1.1' });
  await b.action('latency_save', { task: { name: 'Site B private catalog', target: 'site-b.test:443', interval: 60, nodes: ['node-a'], auto_join: false } });
  server = await createServer({ plugins: [vue()], publicDir: path.resolve('public'), vueFixtureDevtools: true, fixtureEntries: [path.resolve('test/fixtures/admin-ui/latency-loading.html')], cacheDir: path.join(out, 'cache'), apiMiddlewarePlugin: { name: 'latency-loading-actual-worker', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      const url = new URL(request.url, 'http://fixture.invalid');
      const match = url.pathname.match(/^\/site-(a|b)(\/.*)$/) || (/^\/(admin\/api|api\/config)$/.test(url.pathname) ? ['','a',url.pathname] : null); if (!match) return next();
      const job = (async () => {
      const h = match[1] === 'a' ? a : b;
      let body = ''; for await (const chunk of request) body += chunk;
      const action = body ? JSON.parse(body).action : null;
      const item = holds.find(item => item.site === match[1] && item.action === (action || match[2]) && !item.arrived);
      const headers = new Headers(request.headers);
      headers.set('Cookie', `cfsm_auth=${h.token}`); headers.set('Origin', 'https://example.com'); headers.delete('host');
      const started = performance.now();
      const result = await h.fetch(match[2] + url.search, { method: request.method, headers, ...(body ? { body } : {}) });
      const payload = Buffer.from(await result.arrayBuffer());
      receipt.timings.push({ side: 'bridge', site: match[1], action: action || match[2], workerHttpMs: performance.now() - started, injectedHold: !!item });
      if (item) { item.arrived = true; await item.promise; item.done = true; }
      if (item?.status) { response.writeHead(item.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'injected_network_failure' })); }
      else { response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(payload); }
      })().catch(error => { receipt.bridgeError = error.stack; response.writeHead(500); response.end(); });
      pendingApi.add(job); job.finally(() => pendingApi.delete(job));
    });
  } } });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ADMIN_UI_CHROMIUM || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe') });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  if (phase43Only) await runLatencyMetadataChecks({a,b,browser,origin,hold,waitHold,receipt,out,metadataOnly:process.argv.includes('--metadata-only'),addNodeOnly:process.argv.includes('--add-node-only'),stagedOnly:process.argv.includes('--staged-metadata-only'),errorsOnly:process.argv.includes('--metadata-errors-only')});
  for (const width of addRecoveryOnly || phase43Only ? [] : baseline ? [390] : [360, 390, 1440, 1920]) for (const dark of baseline ? [false] : [false, true]) {
    receipt.dark = dark;
    await a.action('list', { refresh: true });
    context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 640, isMobile: width < 640 });
    await context.addInitScript(() => {
      window.latencyTrace = [];
      const mark = (stage, data = {}) => window.latencyTrace.push({ stage, atMs: performance.now(), ...data });
      const fetch = window.fetch;
      window.fetch = async (url, options) => {
        const action = options?.body && JSON.parse(options.body).action;
        if (action === 'latency_list') mark('request-start', { url });
        const result = await fetch(url, options);
        if (action === 'latency_list') {
          mark('response-return', { status: result.status });
          const json = result.json.bind(result);
          result.json = async () => { const data = await json(); mark('json-return', { revision: data.revision }); return data; };
        }
        return result;
      };
      new MutationObserver(() => {
        const table = document.querySelector('.latency-table');
        if (!table) window.lastLatencyText = '';
        const text = table?.querySelector('tbody')?.textContent;
        if (text && text !== window.lastLatencyText) { window.lastLatencyText = text; mark('dom-adopted', { text }); requestAnimationFrame(() => mark('first-frame', { text })); }
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    page = await context.newPage(); page.on('pageerror', error => receipt.browserErrors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/test/fixtures/admin-ui/latency-loading.html?locale=zh#/admin`);
    await page.waitForFunction(() => window.adminState?.().servers.length === 2);
    await page.evaluate(dark => document.body.classList.toggle('light', !dark), dark);
    const initial = hold('a', 'latency_list'); await enter(); await waitHold(initial);
    receipt.initialShell = await shell(); await shot(`${width}-initial-loading`);
    if (!baseline) { assert.equal(receipt.initialShell.heads.length, 5); assert.ok(receipt.initialShell.status.join().includes('加载')); }
    initial.release(); await page.locator('.latency-task-name').first().waitFor(); await frames();
    // An actual node-list update arrives while a catalog response is held: first result must be usable, then reconcile again.
    await page.locator('[data-page=servers]').click();
    const first = hold('a', 'latency_list'); const second = hold('a', 'latency_list');
    await enter(); await waitHold(first);
    await a.db.prepare("INSERT OR IGNORE INTO servers(id,name) VALUES('late-node','Late node')").run();
    await page.evaluate(() => window.adminState().loadServers({ refresh: true }));
    if (baseline) await waitHold(second);
    first.release(); await frames();
    await until(async () => (await page.evaluate(() => window.latencyTrace.filter(item => item.stage === 'json-return').length)) >= 2);
    await frames(); receipt.firstResultDuringNodeRefresh = await shell(); await shot(`${width}-node-race-first-result`);
    if (!baseline) { assert.ok(await page.locator('.latency-task-name').count()); await waitHold(second); }
    second.release(); await page.locator('.latency-task-name').first().waitFor(); await frames();
    if (baseline) { await trace(); break; }
    receipt.checks.push(`${width}: persistent headers/loading, accepted first node-race result, queued reconciliation`);
    const refreshing = hold('a', 'latency_list'); await page.locator('.latency-toolbar').getByRole('button', { name: '刷新', exact: true }).click(); await waitHold(refreshing); await frames();
    assert.equal((await shell()).heads.length, 5); assert.ok(await page.locator('.latency-task-name').count()); await shot(`${width}-background-refresh`);
    refreshing.release(); await page.waitForFunction(() => !window.latencyState().loading);
    const failure = hold('a', 'latency_list', 503); await page.locator('.latency-toolbar').getByRole('button', { name: '刷新', exact: true }).click(); await waitHold(failure); failure.release();
    await page.locator('.latency-page [role=alert]').waitFor(); assert.ok(await page.locator('.latency-task-name').count()); await shot(`${width}-refresh-error`);
    await page.locator('.latency-toolbar').getByRole('button', { name: '刷新', exact: true }).click(); await page.waitForFunction(() => !window.latencyState().error && !window.latencyState().loading);
    receipt.checks.push(`${width}: background refresh retains rows, error retains rows, explicit retry clears error`);
    if (width === 390 && dark) {
      const old = hold('a', 'latency_list', 401); await page.locator('.latency-toolbar').getByRole('button', { name: '刷新', exact: true }).click(); await waitHold(old);
      await page.getByRole('button', { name: '添加监控', exact: true }).click();
      await page.getByRole('textbox', { name: '名称', exact: true }).fill('Mutation wins');
      await page.getByRole('textbox', { name: '目标地址', exact: true }).fill('mutation.test:443');
      await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      old.release(); await frames(); assert.ok(await page.getByText('Mutation wins', { exact: true }).count());
      assert.ok(await page.locator('.admin-ui').count()); receipt.checks.push('mutation invalidates old read/401 authority, accepted mutation remains visible');
      const oldSite = hold('a', 'latency_list', 403); await page.locator('.latency-toolbar').getByRole('button', { name: '刷新', exact: true }).click(); await waitHold(oldSite);
      const config = hold('b', '/api/config');
      await page.evaluate(() => { const state = window.adminState(); state.selectedApiIndex = 1; void state.switchAdminSite(); }); await waitHold(config);
      await page.getByText('Site B private catalog', { exact: true }).waitFor(); await frames();
      assert.equal(await page.getByText('Mutation wins', { exact: true }).count(), 0);
      assert.equal(await page.locator('.admin-loading-overlay').count(), 0, 'agent release/config discovery does not mask ready latency content'); await shot('390-site-b-config-still-pending');
      oldSite.release(); config.release(); await frames(); assert.ok(await page.getByText('Site B private catalog', { exact: true }).count()); receipt.checks.push('site switch discards old catalog/auth effects; slow config cannot mask ready latency');
      const late = hold('b', 'latency_list'); await page.locator('.latency-toolbar').getByRole('button', { name: '刷新', exact: true }).click(); await waitHold(late);
      const logout = hold('b', 'logout'); await page.evaluate(() => { void window.adminState().logout(); }); await waitHold(logout); await frames();
      assert.equal(await page.locator('.latency-page').count(), 0); late.release(); logout.release(); receipt.checks.push('logout removes catalog before network completion');
    }
    await trace(); await context.close(); context = null;
    await a.db.prepare("DELETE FROM servers WHERE id='late-node'").run();
  }
  if (addRecoveryOnly) {
    receipt.dark = true;
    for (const phase of ['first-error', 'initial-in-flight']) {
      const original = (await (await a.action('latency_list')).json()).tasks;
      context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); page = await context.newPage();
      page.on('pageerror', error => receipt.browserErrors.push(error.message));
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/test/fixtures/admin-ui/latency-loading.html?locale=zh#/admin`);
      await page.waitForFunction(() => window.adminState?.().servers.length === 2);
      await page.evaluate(() => document.body.classList.remove('light'));
      const initial = hold('a', 'latency_list', phase === 'first-error' ? 503 : undefined);
      await enter(); await waitHold(initial);
      if (phase === 'first-error') { initial.release(); await page.locator('.latency-page [role=alert]').waitFor(); }
      assert.equal(await page.evaluate(() => window.latencyState().tasks), null, 'unloaded/failed catalog stays unknown, not a successful empty list');
      assert.equal(await page.getByText('还没有延迟监控，添加目标开始采集。', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => !!window.latencyState().error), phase === 'first-error');
      const add = page.getByRole('button', { name: '添加监控', exact: true });
      assert.equal(await add.isEnabled(), true, `${phase}: creating a monitor requires nodes, not a loaded catalog`);
      await shot(`add-recovery-${phase}`);
      await add.click(); await page.getByRole('dialog').waitFor();
      const name = `Add recovery ${phase}`;
      await page.getByRole('textbox', { name: '名称', exact: true }).fill(name);
      await page.getByRole('textbox', { name: '目标地址', exact: true }).fill('add-recovery.test:443');
      const saved = hold('a', 'latency_save');
      await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click(); await waitHold(saved);
      assert.equal(await add.isEnabled(), false, 'busy still prevents duplicate entry during save');
      saved.release(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByText(name, { exact: true }).waitFor();
      initial.release(); await waitHold(initial); await frames();
      const current = await page.evaluate(() => ({ tasks: window.latencyState().tasks, error: window.latencyState().error, loading: window.latencyState().loading }));
      assert.equal(current.error, ''); assert.equal(current.loading, false);
      assert.equal(current.tasks.length, original.length + 1, 'save keeps the existing unknown catalog instead of replacing it');
      assert.ok(original.every(task => current.tasks.some(saved => saved.id === task.id)));
      assert.ok(current.tasks.some(task => task.name === name));
      const persisted = (await (await a.action('latency_list')).json()).tasks;
      assert.deepEqual(current.tasks, persisted, 'new save wins over old list response and matches actual persisted D1 catalog');
      await shot(`add-recovery-${phase}-saved`);
      receipt.checks.push(`${phase}/390 dark: Add opens with tasks=null, error remains distinct from empty, busy blocks reentry, save preserves existing tasks and wins old read`);
      await context.close(); context = null;
    }
  }
  if (!baseline && !addRecoveryOnly && !phase43Only) {
    await a.action('import_servers', { settings: { latency_tasks: { version: 1, tasks: [] } } });
    for (const locale of ['zh', 'zh-TW', 'en', 'ja', 'id', 'fr', 'es']) {
      const trans = (await import(`../../../src/frontend/locales/${locale}.js`)).default;
      receipt.dark = false;
      context = await browser.newContext({ viewport: { width: 360, height: 844 }, hasTouch: true, isMobile: true }); page = await context.newPage();
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/test/fixtures/admin-ui/latency-loading.html?locale=${locale}#/admin`);
      await page.waitForFunction(() => window.adminState?.().servers.length === 2);
      const failed = hold('a', 'latency_list', 503); await page.locator('[data-page=collection]').click(); await waitHold(failed);
      await page.getByRole('button', { name: trans.latencyByNode, exact: true }).click(); await frames();
      assert.equal((await shell()).heads.length, 3); assert.equal(await page.locator('.latency-owned').count(), 0);
      assert.ok((await shell()).status.includes(trans.latencyLoading)); failed.release();
      await page.locator('.latency-page [role=alert]').waitFor(); assert.equal(await page.locator('.latency-owned').count(), 0);
      await page.getByRole('button', { name: trans.latencyByTask, exact: true }).click(); await shot(`locale-${locale}-first-error`);
      await page.locator('.latency-toolbar').getByRole('button', { name: trans.refresh, exact: true }).click(); await page.getByText(trans.latencyEmpty, { exact: true }).waitFor();
      assert.equal(await page.locator('.latency-table thead th').count(), 5); await shot(`locale-${locale}-empty`);
      assert.ok(await page.locator('.latency-toolbar').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      receipt.checks.push(`${locale}/360: first error distinct from empty, node header/loading without false unassigned rows, retry to empty, toolbar fits`);
      await context.close(); context = null;
    }
  }
  assert.deepEqual(receipt.browserErrors, []);
} catch (error) { receipt.failure = error.stack; fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify(receipt, null, 2)); await shot('failure').catch(() => {}); throw error; }
finally {
  for (const item of holds) item.release();
  await context?.close(); await browser?.close(); await server?.close();
  await Promise.all([...pendingApi]);
  receipt.d1 = { a: a && await (await a.fetch('/test/worker-stats')).json(), b: b && await (await b.fetch('/test/worker-stats')).json() };
  await a?.dispose(); await b?.dispose(); receipt.closed = true;
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(receipt, null, 2)); console.log(out);
}
