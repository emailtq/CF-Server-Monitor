import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness, controls, until } from '../../terminal-harness.js';
import en from '../../../src/frontend/locales/en.js';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const evidence = path.resolve('docs/superpowers/admin-ui-refactor/evidence/task-6a');
fs.mkdirSync(evidence, {recursive:true});
const out = process.env.TERMINAL_INSTALL_REPORT_DIR ? path.resolve(process.env.TERMINAL_INSTALL_REPORT_DIR) : fs.mkdtempSync(path.join(evidence,'registered-'));
fs.mkdirSync(out, {recursive:true});
const report = {checks:[], errors:[], actions:[], denied:[]};
let server, browser, h, page, release;
const check = async (name, fn) => { await fn(); report.checks.push({name,pass:true}); console.log(name); };
try {
  h = await harness();
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
  let hold = false, failStatus = false;
  const handleRoute = async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { report.denied.push(url.origin); return route.abort(); }
    if (url.pathname === '/admin/api') {
      const data = req.postDataJSON();
      report.actions.push({action:data.action,serverId:data.serverId,terminal:data.terminal,acceptRisk:data.acceptRisk});
      if (data.action.startsWith('terminal_')) {
        if (failStatus && data.action === 'terminal_status') return route.fulfill({status:503,json:{error:'terminal_query_failed'}});
        const response = await h.mf.dispatchFetch(req.url(), {method:'POST',headers:await req.allHeaders(),body:req.postData()});
        const body = await response.text();
        if (hold && data.action === 'terminal_prepare_install') { hold=false; await new Promise(resolve=>{release=resolve;}); }
        return route.fulfill({status:response.status,headers:{'content-type':'application/json'},body});
      }
      return route.fulfill({json:{settings:{site_title:'CF Monitor',username:'fixture',password_configured:true,terminal_enabled:true},servers:[{id:'node-a',name:'Node A',os:'Linux',is_online:true},{id:'node-b',name:'Node B',os:'Windows',is_online:false}],stats:{total:2},api_secret:'synthetic-report-only'}});
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
  const versionInput = dialog.locator('input[type=text]').first();
  const command = () => dialog.locator('.cmd-output').innerText();
  const assertBlocked = async () => {
    assert.equal(await command(),'', 'unsafe off reinstall must not expose an executable command');
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true,'unsafe off reinstall must block copy');
    assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),false);
    assert.equal(await dialog.locator('[data-terminal-install]').isDisabled(),true);
    assert.equal(await dialog.locator('[data-install-blocked]').isVisible(),true);
  };
  await check('capable existing node pinned off reinstall cannot omit terminal while remaining executable or copyable', async () => {
    await install();
    await versionInput.fill('v0.1');
    await assertBlocked();
    const noSideEffects=report.actions.filter(a=>['terminal_prepare_install','terminal_revoke_node'].includes(a.action)).length;
    assert.equal(noSideEffects,0);
    await page.evaluate(()=>{window.fixtureClipboard='unchanged';});
    await dialog.locator('[data-copy-command]').evaluate(button=>{button.disabled=false;button.click();});
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.fixtureClipboard),'unchanged','copy handler itself must reject empty/unsafe commands');
    await page.screenshot({path:path.join(out,'pinned-off-blocked.png')});
    await page.keyboard.press('Escape');
  });
  await check('blank and explicit latest off keep an explicit disable flag and copy the same safe command', async () => {
    await install();
    for(const version of ['', 'latest']) {
      await versionInput.fill(version);
      assert.match(await command(),/-terminal=0(?:\s|$)/);
      assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),false);
      assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),false);
      await dialog.locator('[data-copy-command]').click();
      assert.equal(await page.evaluate(()=>window.fixtureClipboard),await command());
    }
    assert.equal(report.actions.filter(a=>['terminal_prepare_install','terminal_revoke_node'].includes(a.action)).length,0);
    await page.keyboard.press('Escape');
  });
  await check('missing credentials or failed status cannot prove local off; current disable and non-Linux monitoring remain usable', async () => {
    await h.db.prepare("DELETE FROM terminal_nodes WHERE server_id = 'node-b'").run();
    const pending=await (await h.action('terminal_status',{serverId:'node-b'})).json();
    assert.equal(pending.state,'pending');
    await install('node-b');
    // Even a node without known credentials may be a reinstall on an existing host.
    await page.evaluate(()=>{window.fixtureClipboard='unchanged';});
    await versionInput.fill('v0.1');
    await assertBlocked();
    for(const os of ['unix','docker']) {
      await dialog.locator('select').first().selectOption(os);
      await assertBlocked();
    }
    for(const os of ['mac','windows']) {
      await dialog.locator('select').first().selectOption(os);
      assert.ok((await command()).length>0);
      assert.match(await command(),/--install-version=/);
      assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),false);
      assert.equal((await command()).includes('-terminal='),false,'do not add unverified flags to pinned non-Linux binaries');
      if(os === 'mac') {
        const shell=process.platform === 'win32' ? 'D:/Extra_Downloads/APPs/Git/bin/bash.exe' : '/bin/sh';
        for(const [host,status,calls] of [['Linux',1,0],['Darwin',0,2]]) {
          const file=`mac-${host}-calls.log`;
          const script=`uname() { printf '%s\\n' '${host}'; }\ncurl() { printf 'called\\n' >> '${file}'; }\nsh() { printf 'called\\n' >> '${file}'; }\n${await command()}`;
          const result=spawnSync(shell,['-c',script],{cwd:out,encoding:'utf8',windowsHide:true,timeout:10000});
          fs.writeFileSync(path.join(out,`mac-shell-${host}.json`),JSON.stringify({shell,argv:['-c',script],cwd:out,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr,inertCurlAndSh:true,syntheticUname:true,actualInstallation:false},null,2));
          assert.equal(result.error,undefined);
          assert.equal(result.status,status,'pinned macOS command must deny a real Linux host before its auto-detect installer');
          const observed=fs.existsSync(path.join(out,file)) ? fs.readFileSync(path.join(out,file),'utf8').trim().split('\n').length : 0;
          assert.equal(observed,calls,'only an actual Darwin host may reach the two inert transport/installer functions');
        }
      }
    }
    await dialog.locator('select').first().selectOption('linux');
    await page.keyboard.press('Escape');
    failStatus=true;
    await page.reload(); await page.locator('.server-row').first().waitFor();
    await page.locator('[data-server-id=node-a] .terminal-entry').focus();
    await page.waitForFunction(()=>document.querySelector('[data-server-id=node-a] .terminal-entry')?.getAttribute('aria-label')?.includes('Cannot confirm'));
    await install(); await versionInput.fill('v0.1'); await assertBlocked();
    await versionInput.fill('latest');
    assert.match(await command(),/-terminal=0(?:\s|$)/);
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),false,'verified explicit disable does not depend on a status query');
    assert.equal(report.actions.filter(a=>['terminal_prepare_install','terminal_revoke_node'].includes(a.action)).length,0);
    await page.keyboard.press('Escape'); failStatus=false;
    await page.reload(); await page.locator('.server-row').first().waitFor();
  });
  await install();
  await check('install consent defaults off and cancel never issues credentials', async () => {
    assert.equal(await dialog.locator('[data-terminal-install]').count(),1);
    assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),false);
    assert.match(await dialog.locator('.cmd-output').innerText(), /-terminal=0/);
    await dialog.getByRole('button',{name:/^cancel$/i}).click();
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,0);
  });
  await check('installed capable node opens one existing route without preparing another token', async () => {
    await page.waitForFunction(() => !document.querySelector('[data-server-id=node-a] button[aria-label="Open terminal in new tab"]').disabled);
    await row.getByRole('button',{name:en.terminalOpen,exact:true}).click();
    await page.waitForFunction(()=>window.fixtureOpened.length === 1);
    const opened = await page.evaluate(()=>window.fixtureOpened);
    assert.equal(opened.length,1);
    assert.ok(opened[0][0].endsWith('/admin#/admin/terminal/node-a?apiIndex=0'));
    assert.equal(opened[0][2],'noopener,noreferrer');
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,0);
  });
  await check('real terminal page attempts exactly one authenticated reservation and exposes native transport failure without reissue', async () => {
    const shell = await context.newPage();
    const before = report.actions.filter(a=>a.action==='terminal_open').length;
    await shell.goto(`${origin}/admin?locale=en#/admin/terminal/node-a?apiIndex=0`);
    await shell.locator('.terminal-screen').waitFor();
    await shell.waitForFunction(() => document.querySelector('.terminal-status')?.textContent.includes('PTY') || document.querySelector('.terminal-error'));
    assert.equal(report.actions.filter(a=>a.action==='terminal_open').length,before+1);
    assert.equal(await shell.locator('#terminal-secret').count(),0);
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,0);
    await shell.waitForTimeout(200);
    assert.equal(report.actions.filter(a=>a.action==='terminal_open').length,before+1);
    await shell.screenshot({path:path.join(out,'terminal-native-attempt.png')});
    await shell.close();
  });
  await install();
  await check('checkbox requires a separate risk confirmation before one masked ephemeral token', async () => {
    await dialog.locator('[data-terminal-install]').check();
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,0);
    assert.equal(await dialog.locator('[data-terminal-prepare]').isDisabled(),true);
    await dialog.locator('[data-terminal-risk]').check();
    await dialog.locator('[data-terminal-prepare]').click();
    await dialog.locator('#terminal-install-token').waitFor();
    assert.equal(await dialog.locator('#terminal-install-token').getAttribute('type'),'password');
    const token = await dialog.locator('#terminal-install-token').inputValue();
    assert.match(token,/^[a-f0-9]{64}$/);
    assert.equal((await dialog.locator('.cmd-output').innerText()).includes(token),false);
    await dialog.getByRole('button',{name:en.terminalShowSecret,exact:true}).click();
    assert.equal(await dialog.locator('#terminal-install-token').getAttribute('type'),'text');
    await dialog.locator('#terminal-install-token').locator('..').getByRole('button',{name:en.copy,exact:true}).click();
    assert.equal(await page.evaluate(()=>window.fixtureClipboard),token);
    await dialog.getByRole('button',{name:en.terminalShowSecret,exact:true}).click();
    await dialog.locator('[data-terminal-path]').fill('relative');
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    await dialog.locator('[data-terminal-path]').fill('/var/lib/cfsm/terminal-token');
    assert.match(await dialog.locator('.cmd-output').innerText(),/-terminal=1 -terminal-token-file='\/var\/lib\/cfsm\/terminal-token'/);
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,1);
    assert.equal(await page.evaluate(t=>Object.values({...localStorage,...sessionStorage}).some(v=>String(v).includes(t)),token),false);
    await page.screenshot({path:path.join(out,'desktop-masked.png')});
    await dialog.getByRole('button',{name:/^cancel$/i}).click();
    await install();
    assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),false);
    assert.equal(await dialog.locator('#terminal-install-token').count(),0);
  });
  await check('unsupported platform and unverified script versions disable consent without rotation', async () => {
    const select = dialog.locator('select').first();
    for (const os of ['windows','mac','unix','docker']) {
      await select.selectOption(os);
      assert.equal(await dialog.locator('[data-terminal-install]').isDisabled(),true);
    }
    await select.selectOption('linux');
    await dialog.locator('input[type=text]').first().fill('v0.1');
    assert.equal(await dialog.locator('[data-terminal-install]').isDisabled(),true);
    await dialog.locator('input[type=text]').first().fill('');
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,1);
  });
  await check('late preparation cannot display a token after language change or duplicate while busy', async () => {
    await dialog.locator('[data-terminal-install]').check();
    await dialog.locator('[data-terminal-risk]').check();
    hold=true;
    await dialog.locator('[data-terminal-prepare]').click();
    await page.waitForFunction(()=>document.querySelector('[data-terminal-prepare]')?.disabled);
    assert.equal(await dialog.getByRole('button',{name:/^cancel$/i}).isDisabled(),true);
    await page.evaluate(async file => { const i18n=await import(file); await i18n.setLanguage('zh'); }, exports['/src/frontend/utils/i18n.js']);
    release?.(); release=null;
    await page.waitForFunction(()=>!document.querySelector('[data-terminal-install]').checked);
    assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),false);
    assert.equal(await dialog.locator('#terminal-install-token').count(),0);
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,2);
    await page.evaluate(async file => { const i18n=await import(file); await i18n.setLanguage('en'); }, exports['/src/frontend/utils/i18n.js']);
  });
  await check('seven locales preserve default-off mobile consent and keyboard close', async () => {
    await dialog.getByRole('button',{name:/^cancel$/i}).click();
    for (const locale of ['en','zh','zh-TW','es','fr','id','ja']) {
      await page.setViewportSize({width:320,height:540});
      await page.goto(`${origin}/admin?mode=admin&locale=${locale}#/admin`);
      await page.locator('.server-row').first().waitFor();
      await page.locator('[data-server-id=node-a] .action-btns button').nth(1).click();
      assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),false);
      assert.ok((await dialog.locator('[data-terminal-label]').innerText()).length>3);
      await page.screenshot({path:path.join(out,`mobile-${locale}.png`)});
      await versionInput.fill('v0.1');
      await assertBlocked();
      await dialog.locator('[data-install-blocked]').scrollIntoViewIfNeeded();
      assert.ok((await dialog.locator('[data-install-blocked]').innerText()).includes('-terminal=0'));
      await page.screenshot({path:path.join(out,`mobile-pinned-blocked-${locale}.png`)});
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
    }
  });
  await check('fine-pointer desktop keeps keyboard-accessible unavailable reasons and default-off installation', async () => {
    const fine = await browser.newContext({viewport:{width:1440,height:900},hasTouch:false});
    await fine.addCookies([{name:'cfsm_auth',value:encodeURIComponent(h.token),url:origin,secure:true,httpOnly:true}]);
    await fine.route('**/*',handleRoute);
    const desktop = await fine.newPage();
    await desktop.goto(`${origin}/admin?locale=en#/admin`);
    await desktop.locator('.server-row').first().waitFor();
    await desktop.locator('[data-server-id=node-b] .terminal-entry').focus();
    assert.equal(await desktop.locator('[data-server-id=node-b] .terminal-reason').isVisible(),true);
    const count=report.actions.filter(a=>a.action==='terminal_prepare_install').length;
    await desktop.locator('[data-server-id=node-a] .action-btns button').nth(1).click();
    assert.equal(await desktop.locator('[data-terminal-install]').isChecked(),false);
    await desktop.screenshot({path:path.join(out,'fine-desktop-off.png')});
    await desktop.keyboard.press('Escape');
    await desktop.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,count);
    await fine.close();
  });
  await check('explicit latest confirmed on uses one masked token-file command; switching back off removes token arguments', async () => {
    await page.setViewportSize({width:1440,height:900});
    await page.goto(`${origin}/admin?locale=en#/admin`); await page.locator('.server-row').first().waitFor();
    await install(); await versionInput.fill('latest');
    const before=report.actions.filter(a=>a.action==='terminal_prepare_install').length;
    await dialog.locator('[data-terminal-install]').check();
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    await dialog.locator('[data-terminal-risk]').check();
    await dialog.locator('[data-terminal-prepare]').click();
    await dialog.locator('#terminal-install-token').waitFor();
    const token=await dialog.locator('#terminal-install-token').inputValue();
    assert.equal(await dialog.locator('#terminal-install-token').getAttribute('type'),'password');
    await dialog.locator('[data-terminal-path]').fill('/var/lib/cfsm/terminal-token');
    assert.match(await command(),/-terminal=1 -terminal-token-file='\/var\/lib\/cfsm\/terminal-token'/);
    assert.equal((await command()).includes(token),false);
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),false);
    assert.equal(report.actions.filter(a=>a.action==='terminal_prepare_install').length,before+1);
    await dialog.locator('[data-terminal-install]').uncheck();
    assert.match(await command(),/-terminal=0(?:\s|$)/);
    assert.equal((await command()).includes('-terminal-token-file'),false);
    assert.equal(await dialog.locator('#terminal-install-token').count(),0);
    assert.equal(report.actions.filter(a=>a.action==='terminal_revoke_node').length,0);
    await page.keyboard.press('Escape');
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
finally { release?.(); await browser?.close(); await server?.close(); await h?.dispose(); fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); }
assert.deepEqual(report.errors,[]);
