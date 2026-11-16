import assert from 'node:assert/strict';
import { harness } from '../../terminal-harness.js';
import { saveSiteOptions } from '../../../src/utils/settings.js';

export async function pickerGroupD1({ browser, origin, setTransport, report, check, shot }) {
  const upstream = async request => new URL(request.url).pathname.includes('/releases/latest') ? Response.json({ tag_name: 'v9.8.7' }) : Response.json({ workers: '2.8.7 Beta6' });
  const sites = {};
  const id = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
  const pending = new Set(), holds = [], requests = [];
  const hold = (action, status) => { const item = { action, status, arrived: false }; item.promise = new Promise(resolve => { item.release = resolve; }); holds.push(item); return item; };
  let context;
  report.d1Lifecycle = [];
  try {
    for (const name of ['a', 'b']) {
      report.d1Lifecycle.push({ site: name, phase: 'starting' });
      sites[name] = await harness({ outboundService: upstream });
      report.d1Lifecycle.push({ site: name, phase: 'ready' });
    }
    for (const [name, h] of Object.entries(sites)) {
      await saveSiteOptions(h.db, { is_public: 'true', site_title: `Site ${name}`, username: 'fixture', last_agent_version: 'v9.8.7' });
      await h.db.prepare('DELETE FROM servers').run();
      await h.db.prepare('INSERT INTO servers (id,name,server_group,region,tags,note,price,currency,billing_cycle,expire_date,traffic_limit,traffic_calc_type,traffic_alert_percent,"interface",reset_day,collect_interval,report_interval,wss_report_interval,connection_mode,ping_mode,rx_correction,tx_correction,auto_update,is_hidden,offline_notify_disabled,custom_ct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, `Node ${name}`, name === 'a' ? 'Asia' : 'B only', 'US', 'kept-tag', 'kept-note', '4.50', '$', 'month', '2027-01-01', '500', 'max', 80, 'eth0', 12, 0, 120, 3, 'http', 'icmp', 1.5, 2.5, '1', '1', '1', '1.1.1.1:443').run();
      await h.db.prepare('INSERT INTO servers (id,name,server_group) VALUES (?,?,?)').bind(other, 'Other node', name === 'a' ? 'Europe' : 'B only').run();
      assert.equal((await h.action('save_notification_config', { expectedRevision: 0, channels: [{ name: 'Active channel', type: 'telegram', enabled: true, config: { chatId: '42' }, secrets: { botToken: '123:fixture-only' }, template: '{{message}}' }, { name: 'Disabled channel', type: 'telegram', enabled: false, config: { chatId: '43' }, secrets: { botToken: '124:fixture-only' }, template: '{{message}}' }], rules: [] })).status, 200);
    }
    setTransport((request, response, next) => {
      const url = new URL(request.url, origin), match = url.pathname.match(/^\/site-(a|b)(\/.*)$/); if (!match) return next();
      const job = (async () => {
        const h = sites[match[1]]; let body = ''; for await (const chunk of request) body += chunk;
        const data = body ? JSON.parse(body) : {}, action = data.action || match[2];
        assert.notEqual(action, 'test_notification_channel', 'picker tests never deliver notifications');
        const item = match[1] === 'a' ? holds.find(item => !item.arrived && item.action === action) : null;
        const headers = { ...request.headers, Cookie: `cfsm_auth=${h.token}`, Authorization: `Bearer ${h.token}`, Origin: 'https://example.com' }; delete headers.host;
        const result = item?.status ? Response.json({ error: 'injected_failure' }, { status: item.status }) : await h.fetch(match[2] + url.search, { method: request.method, headers, ...(body ? { body } : {}) });
        const payload = Buffer.from(await result.arrayBuffer()); requests.push({ site: match[1], action, status: result.status, ...(action === 'edit' || action === 'save_notification_config' ? { data } : {}) });
        if (item) { item.arrived = true; await item.promise; }
        response.writeHead(result.status, { 'Content-Type': result.headers.get('Content-Type') || 'application/json' }); response.end(payload);
      })().catch(error => { report.errors.push(error.stack); response.writeHead(500); response.end(); });
      pending.add(job); job.finally(() => pending.delete(job));
    });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => report.errors.push(error.stack));
    await page.goto(`${origin}/test/fixtures/admin-ui/named-pages.html?locale=zh#/admin`);
    await page.waitForFunction(() => window.adminState?.().servers.length === 2);
    const edit = async () => { await page.evaluate(id => { const s = adminState(); s.openEditModal(s.servers.find(n => n.id === id)); }, id); await page.locator('.admin-dialog-edit').waitFor(); };
    const save = () => page.locator('.admin-dialog-edit footer .btn-primary').click();
    const closeResult = async () => { await page.locator('.admin-dialog-default .admin-dialog-close').click(); await page.locator('.admin-dialog-default').waitFor({ state: 'hidden' }); };
    const row = () => sites.a.db.prepare('SELECT * FROM servers WHERE id=?').bind(id).first();
    const original = await row();
    await check('real authenticated Worker/D1 edit changes only group and preserves all existing edit fields', async () => {
      await edit(); const group = page.locator('[name=edit_server_group]'); await group.tap();
      await page.locator('.admin-group-options').getByRole('option', { name: /Europe/ }).tap(); await save();
      await page.waitForFunction(() => adminState().saveResult?.success === true); await closeResult();
      assert.equal(await page.locator('.admin-dialog-edit').count(), 0);
      const after = await row(); assert.equal(after.server_group, 'Europe');
      for (const field of ['name','region','tags','note','price','currency','billing_cycle','expire_date','traffic_limit','traffic_calc_type','traffic_alert_percent','interface','reset_day','collect_interval','report_interval','wss_report_interval','connection_mode','ping_mode','rx_correction','tx_correction','auto_update','is_hidden','offline_notify_disabled','custom_ct']) assert.deepEqual(after[field], original[field], `group edit must preserve ${field}`);
      await edit(); await group.fill('Long CF group beyond thirteen characters'); await page.keyboard.press('Enter'); await save(); await page.waitForFunction(() => adminState().saveResult?.success === true); await closeResult();
      assert.equal((await row()).server_group, 'Long CF group beyond thirteen characters');
      await edit(); await group.fill(''); await save(); await page.waitForFunction(() => adminState().saveResult?.success === true); await closeResult();
      assert.equal((await row()).server_group, 'Default', 'retain the existing CF edit API empty-group semantics');
      await edit(); await group.fill('Cancelled'); await page.locator('.admin-dialog-edit footer .btn:not(.btn-primary)').click(); assert.equal((await row()).server_group, 'Default');
    });
    await check('failed group save retains the draft; late success cannot close or overwrite the next site', async () => {
      await edit(); const group = page.locator('[name=edit_server_group]'); await group.fill('Retry group');
      const failed = hold('edit', 503); await save(); await page.waitForFunction(() => adminState().editSaving); failed.release();
      await page.waitForFunction(() => adminState().saveResult?.success === false); await closeResult();
      assert.equal(await group.inputValue(), 'Retry group'); assert.equal((await row()).server_group, 'Default');
      const delayed = hold('edit'); await save();
      while (!delayed.arrived) await new Promise(resolve => setTimeout(resolve, 10));
      await page.evaluate(() => { const state = adminState(); state.selectedApiIndex = 1; void state.switchAdminSite(); });
      await page.waitForFunction(() => adminState().servers.some(n => n.name === 'Node b') && !adminState().adminSiteLoading);
      await edit(); await page.locator('[name=edit_server_group]').fill('Site B draft'); delayed.release();
      await page.waitForLoadState('networkidle'); assert.equal(await page.locator('[name=edit_server_group]').inputValue(), 'Site B draft');
      assert.equal(await page.locator('.admin-dialog-edit').count(), 1); assert.equal(await page.evaluate(() => adminState().saveResult), null);
      assert.equal((await sites.b.db.prepare('SELECT server_group FROM servers WHERE id=?').bind(id).first()).server_group, 'B only');
      await shot(page, 'real-D1-edit-site-B-retained'); await page.locator('.admin-dialog-edit footer .btn:not(.btn-primary)').click();
      await page.evaluate(() => { const state = adminState(); state.selectedApiIndex = 0; void state.switchAdminSite(); }); await page.waitForFunction(() => adminState().servers.some(n => n.name === 'Node a') && !adminState().adminSiteLoading);
    });
    await check('actual alert channel search, busy/failure recovery and site switch use the real save route', async () => {
      await page.locator('[data-page=alerts]').click(); await page.locator('[data-action=add-rule]').click();
      const dialog = page.locator('.admin-dialog-edit'), inputs = dialog.locator('.admin-picker-summary');
      await dialog.locator('[name=name]').fill('Picker rule'); await inputs.last().tap(); await inputs.last().fill('Disabled');
      assert.equal(await dialog.locator('.admin-picker-option input').isDisabled(), true); await inputs.last().fill('Active'); await dialog.locator('.admin-picker-option input').check();
      assert.equal(await inputs.last().evaluate(el => el === document.activeElement), true); await page.keyboard.press('Escape');
      const failed = hold('save_notification_config', 503); await dialog.locator('[data-action=save-rule]').click();
      await page.waitForFunction(() => document.querySelector('.admin-picker-summary').disabled || document.querySelector('.admin-picker-summary').matches(':disabled'));
      assert.equal(await inputs.last().isDisabled(), true); failed.release(); await dialog.locator('[data-error=unavailable]').waitFor();
      assert.equal(await dialog.locator('[name=name]').inputValue(), 'Picker rule'); await dialog.locator('[data-action=save-rule]').click(); await dialog.waitFor({ state: 'hidden' });
      const config = await (await sites.a.action('get_notification_config')).json(); assert.equal(config.rules.at(-1).name, 'Picker rule'); assert.deepEqual(config.rules.at(-1).scope, { mode: 'all', serverIds: [] }); assert.equal(config.rules.at(-1).targetIds.length, 1);
      await page.locator('[data-action=add-rule]').click(); await dialog.locator('[name=name]').fill('Discarded A rule');
      await page.evaluate(() => { const state = adminState(); state.selectedApiIndex = 1; void state.switchAdminSite(); }); await page.waitForFunction(() => adminState().servers.some(n => n.name === 'Node b') && !adminState().adminSiteLoading);
      assert.equal(await page.locator('.admin-picker-summary').count(), 0); assert.equal((await (await sites.b.action('get_notification_config')).json()).rules.length, 0);
    });
  } catch (error) {
    report.d1Lifecycle.push({ phase: 'failed', harnessPhase: error.harnessPhase, error: error.stack, ...(error.cleanupError ? { cleanupError: error.cleanupError.stack } : {}) });
    throw error;
  } finally {
    for (const item of holds) item.release(); await Promise.allSettled([...pending]); setTransport(null); await context?.close();
    report.d1Requests = requests; report.d1Transport = 'Production Vue/index caller → local HTTP middleware → authenticated production Worker → Miniflare D1. Only explicit 503/response holds are injected.';
    const results = await Promise.allSettled(Object.values(sites).map(h => h.dispose()));
    results.forEach((result, index) => {
      report.d1Lifecycle.push({ site: Object.keys(sites)[index], phase: result.status === 'fulfilled' ? 'disposed' : 'dispose-failed' });
      if (result.status === 'rejected') report.errors.push(result.reason.stack);
    });
  }
}
