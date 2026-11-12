import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness, controls, until } from '../../terminal-harness.js';
import { saveSiteOptions } from '../../../src/utils/settings.js';
import en from '../../../src/frontend/locales/en.js';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const evidence = path.resolve('docs/superpowers/admin-download-repair-2026-11-11');
fs.mkdirSync(evidence, {recursive:true});
const out = process.env.TERMINAL_INSTALL_REPORT_DIR ? path.resolve(process.env.TERMINAL_INSTALL_REPORT_DIR) : fs.mkdtempSync(path.join(evidence,'registered-'));
fs.mkdirSync(out, {recursive:true});
const report = {checks:[], errors:[], actions:[], denied:[]};
let server, browser, h, page, release, releaseMetadata;
const check = async (name, fn) => { await fn(); report.checks.push({name,pass:true}); console.log(name); };
try {
  h = await harness();
  h.nodes['node-a'] = await (await h.action('terminal_prepare_install',{serverId:'node-a',terminal:true,acceptRisk:true})).json();
  await saveSiteOptions(h.db, {theme_url:'https://github.com/test/theme/tree/main'});
  await h.control();
  server = await createServer({frontendExports:true, fixtureEntries:[path.resolve('test/fixtures/admin-ui/terminal-install-access.html')], cacheDir:path.join(out,'.cache'), plugins:[vue()], publicDir:path.resolve('public')});
  const httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const origin = httpOrigin.replace('http:', 'https:');
  const bundle = fs.readdirSync(out).find(name=>name.startsWith('compiled-fixture-'));
  const exports = JSON.parse(fs.readFileSync(path.join(out,bundle,'build-receipt.json'))).exports;
  browser = await chromium.launch({headless:true, executablePath:'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  const context = await browser.newContext({viewport:{width:1440,height:900},hasTouch:true});
  await context.addCookies([{name:'cfsm_auth',value:encodeURIComponent(h.token),url:origin,secure:true,httpOnly:true}]);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text => {window.fixtureClipboard=text;}}});
    window.fixtureOpened = [];
    window.open = (...args) => { window.fixtureOpened.push(args); return null; };
  });
  let hold = false, failStatus = false, lostRotation = false, holdRelease = false;
  const handleRoute = async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === 'https://api.github.com') {
      if (holdRelease) { holdRelease=false; await new Promise(resolve=>{releaseMetadata=resolve;}); }
      const tag = url.pathname.includes('/tags/') ? decodeURIComponent(url.pathname.split('/tags/')[1]) : 'v9.0';
      if (tag === 'missing') return route.fulfill({status:404,json:{message:'Not Found'}});
      if (url.pathname.includes('/contents/')) return route.fulfill({json:{encoding:'base64',content:Buffer.from(url.pathname.includes('terminal_control.go') ? 'func (a *Agent) startTerminal(ctx context.Context) {}' : url.search.includes('v0.1') ? '// old' : 'fs.BoolVar(&terminal,"terminal",false,""); fs.StringVar(&token,"terminal-token-file","","")').toString('base64')}});
      return route.fulfill({json:{tag_name:tag,draft:false,assets:['linux-amd64','darwin-arm64','windows-amd64.exe','freebsd-amd64'].map(platform=>({name:'cf-probe-'+platform,state:'uploaded',browser_download_url:'https://github.com/emailtq/cfsm-agent/releases/download/'+tag+'/cf-probe-'+platform}))}});
    }
    if (url.origin === 'https://ghcr.io') return route.fulfill({json:url.pathname === '/token' ? {token:'synthetic-public-registry'} : {schemaVersion:2,manifests:[{}]}});
    if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); }
    if (url.pathname === '/admin/api') {
      const data = req.postDataJSON();
      report.actions.push({action:data.action,serverId:data.serverId,terminal:data.terminal,acceptRisk:data.acceptRisk});
      if (data.action === 'agent_install_image') return route.fulfill({json:{available:true}});
      if (data.action.startsWith('terminal_')) {
        if (failStatus && data.action === 'terminal_status') return route.fulfill({status:503,json:{error:'terminal_query_failed'}});
        const response = await h.mf.dispatchFetch(req.url(), {method:'POST',headers:await req.allHeaders(),body:req.postData()});
        const body = await response.text();
        if (hold && ['terminal_read_install','terminal_enable_install','terminal_prepare_install'].includes(data.action)) { hold=false; await new Promise(resolve=>{release=resolve;}); }
        if (lostRotation && data.action === 'terminal_prepare_install') { lostRotation=false; return route.abort(); }
        return route.fulfill({status:response.status,headers:{'content-type':'application/json'},body});
      }
      return route.fulfill({json:{settings:{site_title:'CF Monitor',username:'fixture',password_configured:true,terminal_enabled:true,theme_url:'https://github.com/test/theme/tree/main'},servers:[{id:'node-a',name:'Node A',os:'Linux',is_online:true},{id:'node-b',name:'Node B',os:'Windows',is_online:false}],stats:{total:2},api_secret:'synthetic-report-only'}});
    }
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({json:{}});
    const target = url.pathname === '/admin' ? '/test/fixtures/admin-ui/terminal-install-access.html' : url.pathname;
    const response = await route.fetch({url:httpOrigin+target+url.search});
    return route.fulfill({response});
  };
  await context.route('**/*', handleRoute);
  page = await context.newPage();
  page.on('pageerror', error=>report.errors.push(error.message));
  await page.goto(`${origin}/admin?mode=admin&locale=en#/admin`);
  await page.locator('.server-row').first().waitFor();
  const row = page.locator('[data-server-id=node-a]');
  const install = async (serverId = 'node-a') => { await page.locator(`[data-server-id=${serverId}]`).getByRole('button',{name:en.copy,exact:true}).click(); await page.getByRole('dialog').waitFor(); };
  const dialog = page.getByRole('dialog');
  const versionInput = dialog.locator('[data-install-version]');
  const command = () => dialog.locator('.cmd-output').innerText();
  const mutations = () => report.actions.filter(a=>['terminal_prepare_install','terminal_enable_install','terminal_revoke_node'].includes(a.action)).length;
  const ready = () => page.waitForFunction(()=>!document.querySelector('[data-copy-command]')?.disabled);
  const toggle = () => dialog.locator('[data-terminal-install]');
  const rotate = () => dialog.locator('[data-terminal-reissue]');
  const currentCredential = async () => (await (await h.action('terminal_read_install',{serverId:'node-a'})).json()).token;
  await check('trusted theme keeps original download options and default-off open only reads existing credential', async () => {
    const before = mutations(), token = await currentCredential();
    await install(); await ready();
    assert.equal(await dialog.locator('.download-options').count(),1);
    assert.equal(await dialog.locator('.config-list').count(),0);
    assert.equal(await dialog.locator('[data-terminal-risk], [data-terminal-path], #terminal-install-token').count(),0);
    assert.equal(await toggle().isChecked(),false);
    assert.match(await command(),/-terminal=0(?:\s|$)/);
    assert.equal((await command()).includes(token),false);
    assert.equal(mutations(),before);
    await page.keyboard.press('Escape');
    await install(); await ready();
    assert.equal(await currentCredential(),token);
    assert.equal(mutations(),before);
  });
  await check('protected admin preview query allows the real download dialog without changing the credential', async () => {
    await page.keyboard.press('Escape');
    await page.goto(`${origin}/admin?locale=en&theme_url=https%3A%2F%2Fgithub.com%2Ftest%2Ftheme%2Ftree%2Fmain#/admin`);
    await page.locator('.server-row').first().waitFor();
    const before = mutations(), token = await currentCredential();
    await install(); await ready();
    assert.equal(await toggle().isDisabled(), false);
    await toggle().check(); await ready();
    assert.ok((await command()).includes(token));
    assert.equal(mutations(), before);
    await toggle().uncheck(); await ready();
  });
  await check('selecting terminal reuses long-lived Token and copies the single complete install command', async () => {
    const token=await currentCredential(), before=mutations();
    await toggle().check(); await ready();
    assert.ok((await command()).includes("-terminal=1 --install-terminal-token='"+token+"'"));
    assert.equal((await command()).includes('-terminal-token-file'),false);
    await dialog.locator('[data-copy-command]').click();
    assert.equal(await page.evaluate(()=>window.fixtureClipboard),await command());
    assert.equal(mutations(),before);
    assert.equal(await page.evaluate(t=>Object.values({...localStorage,...sessionStorage}).some(v=>String(v).includes(t)),token),false);
    await toggle().uncheck(); await ready();
    assert.match(await command(),/-terminal=0(?:\s|$)/);
    assert.equal((await command()).includes(token),false);
  });
  await check('fixed versions are checked individually: old monitoring works, supported terminal works, absent downloads block copy', async () => {
    const before=mutations();
    await versionInput.fill('v0.1'); await ready();
    assert.match(await command(),/--install-version='v0.1'/);
    assert.match(await command(),/-terminal=0(?:\s|$)/);
    assert.equal(await toggle().isDisabled(),true);
    await versionInput.fill('v9.0'); await ready();
    assert.equal(await toggle().isDisabled(),false);
    await toggle().check(); await ready();
    assert.match(await command(),/-terminal=1 --install-terminal-token=/);
    await versionInput.fill('missing');
    await dialog.locator('[data-install-blocked]').waitFor();
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    assert.equal((await command()).includes('curl -fsSL'),false);
    await page.evaluate(()=>{window.fixtureClipboard='unchanged';});
    await dialog.locator('[data-copy-command]').evaluate(button=>{button.disabled=false;button.click();});
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(()=>window.fixtureClipboard),'unchanged');
    assert.equal(mutations(),before);
    await versionInput.fill(''); await ready();
  });
  await check('all native and Docker monitoring options remain available, terminal only Linux', async () => {
    for(const os of ['windows','mac','unix','docker','linux']) {
      await dialog.locator('[data-target-os]').selectOption(os); await ready();
      assert.ok((await command()).length>0);
      assert.equal(await toggle().isDisabled(),os !== 'linux');
      assert.equal(await dialog.locator('[data-auto-update]').count(),os === 'docker' ? 0 : 1);
    }
    await dialog.locator('[data-auto-update]').check();
    assert.match(await command(),/-auto_update=1/);
    await dialog.locator('[data-auto-update]').uncheck();
    assert.match(await command(),/-auto_update=0/);
    await dialog.locator('[data-install-mode]').selectOption('cfsm-user');
    assert.ok((await command()).includes('runuser -u cfsm'));
    await dialog.locator('[data-install-mode]').selectOption('current-user');
  });
  await check('explicit reissue has one confirmation; cancelling never rotates and confirmation retires only once', async () => {
    const old=await currentCredential(), before=mutations();
    await rotate().click();
    const confirm=page.locator('.admin-dialog-download-confirm');
    await confirm.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await currentCredential(),old);
    assert.equal(mutations(),before);
    await toggle().check(); await ready();
    await rotate().click(); await confirm.locator('[data-confirm-reissue]').click();
    await confirm.waitFor({state:'hidden'}); await ready();
    const token=await currentCredential();
    assert.notEqual(token,old);
    assert.ok((await command()).includes(token));
    assert.equal((await command()).includes(old),false);
    assert.equal(mutations(),before+1);
  });
  await check('lost rotation response rereads current Token instead of keeping retired command', async () => {
    const old=await currentCredential(); lostRotation=true;
    await rotate().click();
    await page.locator('[data-confirm-reissue]').click();
    await page.locator('.admin-dialog-download-confirm').waitFor({state:'hidden'}); await ready();
    const token=await currentCredential();
    assert.notEqual(token,old);
    assert.ok((await command()).includes(token));
    assert.equal((await command()).includes(old),false);
  });
  await check('background read is cancellable; stale response never enters another node', async () => {
    await page.keyboard.press('Escape');
    hold=true; await install();
    await until(()=>!!release);
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    await install('node-b'); await ready();
    release(); release=null;
    await page.waitForTimeout(50);
    assert.equal(await toggle().isChecked(),false);
    assert.equal((await command()).includes(await currentCredential()),false);
    await page.keyboard.press('Escape');
  });
  await check('legacy hash-only credential asks for explicit reissue; no hidden prepare or manual path', async () => {
    await install('node-b'); await ready();
    const before=mutations();
    await toggle().check();
    await dialog.locator('[data-terminal-error]').waitFor();
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    assert.equal(mutations(),before);
    await page.keyboard.press('Escape');
  });
  await check('download footer has only Copy and Close; node table Edit and keyboard close remain connected', async () => {
    await install(); await ready();
    assert.equal(await dialog.locator('[data-edit-install]').count(),0);
    assert.deepEqual(await dialog.locator('footer button').allTextContents(),[en.close,en.copy]);
    await page.keyboard.press('Escape');
    await row.getByRole('button',{name:en.edit,exact:true}).click();
    assert.equal(await page.locator('.admin-dialog-edit').count(),1);
    await page.keyboard.press('Escape');
  });
  await check('language change restarts a pending public release lookup and clears the old selected Token', async () => {
    await install(); await ready();
    await toggle().check(); await ready();
    holdRelease=true; await versionInput.fill('v9.1');
    await until(()=>!!releaseMetadata);
    await page.evaluate(async file=>{const i18n=await import(file);await i18n.setLanguage('zh');},exports['/src/frontend/utils/i18n.js']);
    releaseMetadata(); releaseMetadata=null;
    await ready();
    assert.equal(await toggle().isChecked(),false);
    assert.equal((await command()).includes(await currentCredential()),false);
    await page.keyboard.press('Escape');
    await page.evaluate(async file=>{const i18n=await import(file);await i18n.setLanguage('en');},exports['/src/frontend/utils/i18n.js']);
  });
  await check('first opt-in creates one stable credential; repeated off-on never reissues it', async () => {
    await h.db.prepare("DELETE FROM terminal_nodes WHERE server_id='node-b'").run();
    await install('node-b'); await ready();
    const before=mutations();
    await toggle().check(); await ready();
    const first=await (await h.action('terminal_read_install',{serverId:'node-b'})).json();
    assert.match(first.token,/^[a-f0-9]{64}$/);
    assert.ok((await command()).includes(first.token));
    assert.equal(mutations(),before+1);
    await toggle().uncheck(); await toggle().check(); await ready();
    assert.equal(mutations(),before+1);
    assert.equal((await (await h.action('terminal_read_install',{serverId:'node-b'})).json()).token,first.token);
    await page.keyboard.press('Escape');
  });
  await check('source-derived geometry and all seven locales fit 320,390,1440 light/dark without overflow', async () => {
    for(const locale of ['en','zh','zh-TW','es','fr','id','ja']) {
      for(const [width,light] of [[320,true],[390,false],[1440,true],[1440,false]]) {
        await page.setViewportSize({width,height:900});
        await page.goto(`${origin}/admin?locale=${locale}#/admin`);
        await page.locator('.server-row').first().waitFor();
        await page.evaluate(light=>document.body.classList.toggle('light',light),light);
        await page.locator('[data-server-id=node-a] .action-btns button').nth(1).click(); await ready();
        assert.equal(await toggle().isChecked(),false);
        const geometry=await page.locator('.admin-dialog-download').evaluate(d=>{
          const css=getComputedStyle(d), header=getComputedStyle(d.querySelector('h2')), command=getComputedStyle(d.querySelector('.cmd-output')), footer=getComputedStyle(d.querySelector('footer'));
          return {width:d.getBoundingClientRect().width,padding:css.padding,radius:css.borderRadius,font:header.fontSize,weight:header.fontWeight,line:header.lineHeight,commandFont:command.fontSize,commandLine:command.lineHeight,commandFamily:command.fontFamily,footer:footer.flexDirection,overflow:d.scrollWidth>d.clientWidth};
        });
        assert.ok(Math.abs(geometry.width-Math.min(576,width-32))<2);
        assert.equal(geometry.padding,'24px'); assert.equal(geometry.radius,'10px');
        assert.equal(geometry.font,'18px'); assert.equal(geometry.weight,'600'); assert.equal(geometry.line,'18px');
        assert.equal(geometry.commandFont,'12px'); assert.equal(geometry.commandLine,'19.5px');
        assert.ok(geometry.commandFamily.includes('monospace'));
        assert.equal(geometry.footer,width<640?'column-reverse':'row');
        assert.equal(geometry.overflow,false);
        if(locale==='zh' || width===320) await page.screenshot({path:path.join(out,`download-${locale}-${width}-${light?'light':'dark'}.png`)});
        await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
      }
    }
  });
  await check('remote disable modal distinguishes offline local unconfirmed in all seven locales', async () => {
    for (const locale of ['en','zh','zh-TW','es','fr','id','ja']) {
      await page.setViewportSize({width:1440,height:900});
      await page.goto(`${origin}/admin?locale=${locale}#/admin/terminal/node-a`);
      await page.locator('.terminal-actions button').nth(1).click();
      await page.setViewportSize({width:320,height:540});
      assert.equal(await dialog.locator('.btn-red').isDisabled(),true);
      await dialog.locator('.terminal-consent input').check();
      await dialog.locator('.btn-red').click();
      await dialog.locator('[role="status"]').waitFor();
      assert.equal(await dialog.locator('[data-disable-result="unconfirmed"]').count(),1,'server-only revoke must show local shutdown unconfirmed');
      assert.ok((await dialog.locator('[data-disable-result]').innerText()).length>10);
      await page.screenshot({path:path.join(out,`disable-unconfirmed-${locale}.png`)});
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
    }
  });
  await check('current Cookie online disable shows local confirmed only after matched control ACK', async () => {
    h.nodes['node-a'] = await (await h.action('terminal_prepare_install',{serverId:'node-a',terminal:true,acceptRisk:true})).json();
    const peer = await h.socket('/api/agent/terminal/control',h.agentHeaders());
    peer.ws.send(JSON.stringify({type:'hello',protocol:1,platform:'linux',capabilities:['terminal.pty.v1','terminal.disable.v1']}));
    await until(()=>controls(peer).some(frame=>frame.type==='bound'));
    await page.setViewportSize({width:1440,height:900});
    await page.goto(`${origin}/admin?locale=en#/admin/terminal/node-a`);
    await page.locator('.terminal-actions button').nth(1).click();
    await dialog.locator('.terminal-consent input').check();
    await dialog.locator('.btn-red').click();
    await until(()=>controls(peer).some(frame=>frame.type==='disable'));
    assert.equal(await dialog.locator('[data-disable-result]').count(),0);
    assert.equal(await dialog.locator('.btn-red').isDisabled(),true);
    const frame=controls(peer).find(frame=>frame.type==='disable');
    peer.ws.send(JSON.stringify({...frame,type:'disabled'}));
    await dialog.locator('[data-disable-result="confirmed"]').waitFor();
    await page.screenshot({path:path.join(out,'disable-confirmed-desktop.png')});
  });
} catch (error) { report.errors.push(error.stack); await page?.locator('#terminal-install-token').evaluateAll(inputs=>inputs.forEach(input=>{input.type='password';})).catch(()=>{}); await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{}); }
finally { release?.(); releaseMetadata?.(); await browser?.close(); await server?.close(); await h?.dispose(); fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); }
assert.deepEqual(report.errors,[]);
