import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import en from '../../../src/frontend/locales/en.js';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.NODE_TOKEN_UI_REPORT_DIR || 'docs/superpowers/admin-download-repair-2026-11-11/node-token-task5');
fs.mkdirSync(out,{recursive:true});
const report = {checks:[], errors:[], actions:[], syntheticRelease:true, node:process.version};
const tokens = {'node-a':'a'.repeat(64),'node-b':'b'.repeat(64)};
const permissions = {'node-a':false,'node-b':false};
const cli = 'fs.StringVar(&nodeTokenFile,"token-file","","")\nfs.StringVar(&registerKey,"register-key","","")\nfs.StringVar(&terminal,"terminal","","")';
let server, browser, page;
let holdAction='', held=[], readError='', enableError='', failRecovery=false, lostReset=false, registrationTtl=900000, keyCount=0;
let siteTerminal=true;
let registrationFailure=false, discoveryEnabled=true;
let holdLogout=false, releaseLogout;
const nameProbe = process.argv.includes('--registration-name-probe');
const logoutProbe = process.argv.includes('--logout-navigation-probe');
const check = async (name, fn) => {
  if (nameProbe && !name.startsWith('registration name validation')) return;
  if (logoutProbe && !name.startsWith('pending read and key replies after logout')) return;
  await fn(); report.checks.push({name,pass:true}); console.log(name);
};
try {
  server = await createServer({frontendExports:true,fixtureEntries:[path.resolve('test/fixtures/admin-ui/terminal-install-access.html')],cacheDir:path.join(out,'.cache'),plugins:[vue()],publicDir:path.resolve('public')});
  const bundle=fs.readdirSync(out).filter(name=>name.startsWith('compiled-fixture-')).sort((a,b)=>fs.statSync(path.join(out,b)).mtimeMs-fs.statSync(path.join(out,a)).mtimeMs)[0];
  const exports=JSON.parse(fs.readFileSync(path.join(out,bundle,'build-receipt.json'))).exports;
  const httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`, origin = httpOrigin.replace('http:','https:');
  browser = await chromium.launch({headless:true,executablePath:'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  const context = await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(() => {
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});
    window.opened=[]; window.open=(...args)=>{window.opened.push(args);return null;};
  });
  await context.route('**/*',async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === 'https://api.github.com') {
      if (url.pathname.includes('/contents/')) return route.fulfill({json:{encoding:'base64',content:Buffer.from(url.pathname.includes('terminal_control.go') ? 'func (a *Agent) startTerminal(ctx context.Context) {}' : url.search.includes('old.synthetic') ? 'fs.StringVar(&secret,"secret","","")' : cli).toString('base64')}});
      const tag=url.pathname.includes('/tags/') ? decodeURIComponent(url.pathname.split('/tags/')[1]) : 'task5.synthetic';
      return route.fulfill({json:{tag_name:tag,draft:false,assets:['linux-amd64','darwin-arm64','windows-amd64.exe','freebsd-amd64'].map(platform=>({name:'cf-probe-'+platform,state:'uploaded',browser_download_url:'https://github.com/emailtq/cfsm-agent/releases/download/'+tag+'/cf-probe-'+platform}))}});
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/admin/api') {
      const data=req.postDataJSON(); report.actions.push(data);
      if (data.action === 'logout' && holdLogout) {
        holdLogout=false;
        await new Promise(resolve=>{releaseLogout=resolve;});
      }
      if (['node_read_install','terminal_read_install','terminal_enable_install','node_reset_token'].includes(data.action)) {
        const error=data.action === 'node_read_install' ? readError : data.action === 'terminal_enable_install' ? enableError : '';
        if (data.action === 'terminal_enable_install' && !error) permissions[data.serverId]=siteTerminal=true;
        if (data.action === 'node_reset_token') tokens[data.serverId]=(tokens[data.serverId][0] === 'c' ? 'd' : 'c').repeat(64);
        const json=error ? {error} : {token:tokens[data.serverId],version:1,tokenVersion:1,enabled:permissions[data.serverId],needsRotation:false};
        if (holdAction === data.action) { holdAction=''; await new Promise(resolve=>held.push(resolve)); }
        if (lostReset && data.action === 'node_reset_token') {lostReset=false; return route.abort();}
        if (data.action === 'terminal_enable_install' && failRecovery) readError='node_login_required';
        return route.fulfill({status:error ? 409 : 200,json}).catch(()=>{});
      }
      if (data.action === 'node_prepare_registration') {
        if (registrationFailure) return route.fulfill({status:503,json:{error:'registration_unavailable'}});
        const json={key:(++keyCount).toString(16).padStart(64,'0'),expiresAt:Date.now()+registrationTtl};
        if (holdAction === data.action) {holdAction='';await new Promise(resolve=>held.push(resolve));}
        return route.fulfill({json}).catch(()=>{});
      }
      if (data.action === 'terminal_status') return route.fulfill({json:{nodes:Object.fromEntries((data.serverIds || [data.serverId]).map(id=>[id,{enabled:true,localEnabled:true,state:'offline'}]))}});
      return route.fulfill({json:{settings:{site_title:'Fixture',username:'fixture',password_configured:true,terminal_enabled:siteTerminal,auto_discovery:discoveryEnabled,theme_url:'https://github.com/test/theme/tree/main'},servers:[{id:'node-a',name:'Node A',os:'Linux',is_online:true},{id:'node-b',name:'Node B',os:'Windows'}],stats:{total:2}}});
    }
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({json:{}});
    const response=await route.fetch({url:httpOrigin+(url.pathname === '/admin' ? '/test/fixtures/admin-ui/terminal-install-access.html' : url.pathname)+url.search});
    return route.fulfill({response});
  });
  page=await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror',error=>report.errors.push(error.stack));
  await page.goto(`${origin}/admin?locale=en#/admin`); await page.locator('.server-row').first().waitFor();
  const dialog=page.locator('.admin-dialog-download');
  const ready=()=>page.waitForFunction(()=>document.querySelector('[data-copy-command]')?.disabled === false);
  const command=()=>dialog.locator('.cmd-output').innerText();
  const install=async(id='node-a')=>{await page.locator(`[data-server-id=${id}]`).getByRole('button',{name:en.copy,exact:true}).click();await dialog.waitFor();};
  const close=async()=>{await dialog.locator('footer button').first().click();await dialog.waitFor({state:'hidden'});};
  const reload=async()=>{await page.goto(`${origin}/admin?locale=en#/admin`);await page.reload();await page.locator('.server-row').first().waitFor();};
  await check('terminal-off command contains exactly one node token and no shared secret',async()=>{
    await page.locator('[data-server-id=node-a]').getByRole('button',{name:en.copy,exact:true}).click(); await ready();
    const text=await command();
    assert.equal(text.split(tokens['node-a']).length-1,1,text);
    assert.doesNotMatch(text,/-secret=|\bSECRET=|terminal-token/);
    assert.match(text,/-terminal=0/);
    assert.equal(await page.evaluate(token=>Object.values({...localStorage,...sessionStorage}).some(v=>String(v).includes(token)),tokens['node-a']),false);
    assert.equal(report.actions.filter(a=>a.action === 'node_read_install').length,1);
    assert.equal(report.actions.some(a=>a.action === 'terminal_enable_install'),false);
  });
  await check('terminal checkbox reuses the monitoring token and only enables permission',async()=>{
    await dialog.locator('[data-terminal-install]').check(); await ready();
    const text=await command();
    assert.equal(text.split(tokens['node-a']).length-1,1,text);
    assert.match(text,/-terminal=1/);
    assert.equal(report.actions.filter(a=>a.action === 'terminal_enable_install').length,1);
    assert.equal(report.actions.some(a=>a.action === 'terminal_prepare_install'),false);
    assert.equal(await page.locator('[data-credential-notice]').count(),0,'terminal permission opt-in must not announce rotation');
    await dialog.locator('[data-terminal-install]').uncheck(); await ready();
    assert.ok((await command()).includes(tokens['node-a']));
  });
  await check('download footer stays Copy/Close without Edit or preview and copy is exact',async()=>{
    assert.deepEqual(await dialog.locator('footer button').allTextContents(),[en.close,en.copy]);
    await dialog.locator('[data-copy-command]').click();
    assert.equal(await page.evaluate(()=>window.copied),await command());
    await dialog.locator('footer button').first().click(); assert.equal(await dialog.count(),0);
  });
  await check('enable failure and failed recovery never silently downgrade a checked terminal to off',async()=>{
    siteTerminal=false; permissions['node-a']=false; await reload(); await install(); await ready();
    enableError='terminal_request_failed';
    await dialog.locator('[data-terminal-install]').check(); await dialog.locator('[data-terminal-error]').waitFor();
    assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),true);
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    assert.doesNotMatch(await command(),/curl|install-node-token|-terminal=0/);
    await dialog.locator('[data-terminal-install]').uncheck(); await ready();
    failRecovery=true; await dialog.locator('[data-terminal-install]').check();
    await page.waitForFunction(()=>document.querySelector('[data-terminal-error]')?.textContent.includes('Cannot') || document.querySelector('[data-terminal-error]')?.textContent.includes('login') || document.querySelector('[data-terminal-error]')?.textContent.includes('request'));
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),true);
    readError=enableError='';failRecovery=false;await close();
  });
  await check('late close and node-switch reads cannot restore the previous token',async()=>{
    holdAction='node_read_install';await install();await page.waitForFunction(()=>document.querySelector('[data-copy-command]')?.disabled === true);
    while(!held.length) await page.waitForTimeout(10);
    await close();await install('node-b');await ready();
    held.shift()();await page.waitForTimeout(30);
    assert.ok((await command()).includes(tokens['node-b']));assert.ok(!(await command()).includes(tokens['node-a']));
    await close();
    holdAction='node_read_install';await install();while(!held.length)await page.waitForTimeout(10);
    await page.locator('[data-server-id=node-b]').getByRole('button',{name:en.copy,exact:true}).evaluate(el=>el.click());await ready();
    held.shift()();await page.waitForTimeout(30);assert.ok((await command()).includes(tokens['node-b']));await close();
  });
  await check('explicit reset stays available on all OS, read errors block Copy, lost reset reply rereads',async()=>{
    readError='node_token_reset_required';await install();await dialog.locator('[data-terminal-error]').waitFor();
    assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    readError='';
    for(const os of ['windows','mac','unix','docker','linux']) {
      await dialog.locator('[data-target-os]').selectOption(os);
      const old=tokens['node-a'];assert.equal(await dialog.locator('[data-terminal-reissue]').isDisabled(),false);
      await dialog.locator('[data-terminal-reissue]').click();await page.locator('[data-confirm-reissue]').click();
      await page.locator('.admin-dialog-download-confirm').waitFor({state:'hidden'});
      const notice=page.locator('[data-credential-notice]');
      assert.equal(await notice.count(),1);assert.equal(await notice.locator('[data-credential-notice-text]').innerText(),en.downloadReissued);
      assert.doesNotMatch(await notice.innerText(),/[a-f0-9]{64}/);
      if(os === 'docker') {assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);}
      else {await ready();assert.ok((await command()).includes(tokens['node-a']));assert.ok(!(await command()).includes(old));}
    }
    lostReset=true;const old=tokens['node-a'];await dialog.locator('[data-terminal-reissue]').click();await page.locator('[data-confirm-reissue]').click();await page.locator('.admin-dialog-download-confirm').waitFor({state:'hidden'});await ready();
    assert.ok((await command()).includes(tokens['node-a']));assert.ok(!(await command()).includes(old));
    assert.equal(await page.locator('[data-credential-notice]').count(),0,'uncertain reply is not a successful rotation');await close();
    assert.equal(await page.locator('[data-credential-notice]').count(),0);
  });
  await check('changing OS or language during pending enable always matches the checkbox and token',async()=>{
    enableError='';permissions['node-a']=false;siteTerminal=false;await reload();await install();await ready();
    holdAction='terminal_enable_install';await dialog.locator('[data-terminal-install]').check();while(!held.length)await page.waitForTimeout(10);
    await dialog.locator('[data-target-os]').selectOption('windows');held.shift()();await ready();
    assert.equal(await dialog.locator('[data-terminal-install]').isChecked(),false);assert.match(await command(),/-terminal=0/);
    await dialog.locator('[data-target-os]').selectOption('linux');await ready();await dialog.locator('[data-terminal-install]').check();await ready();
    const token=tokens['node-a'];await page.evaluate(async url=>(await import(url)).setLanguage('zh'),exports['/src/frontend/utils/i18n.js']);await ready();
    const checked=await dialog.locator('[data-terminal-install]').isChecked();assert.match(await command(),new RegExp('-terminal='+Number(checked)));assert.ok((await command()).includes(token));await close();await reload();
  });
  await check('trusted-theme terminal entry stays synchronous and does not issue credentials',async()=>{
    const before=report.actions.length;await page.locator('[data-server-id=node-a] .terminal-entry button').click();
    assert.equal((await page.evaluate(()=>window.opened.at(-1)))[0],`${origin}/admin#/admin/terminal/node-a?apiIndex=0`);
    assert.equal(report.actions.length,before);
  });
  const openRegistration=async()=>{await page.locator('[data-page=servers]').click();
    await page.getByRole('button',{name:en.adminBulkAdd,exact:true}).click();await page.locator('.admin-dialog-edit').waitFor();};
  await check('registration name validation blocks Copy even when input maxlength is bypassed',async()=>{
    await openRegistration();
    const registration=page.locator('.admin-dialog-edit');
    await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit footer button:last-child')?.disabled === false);
    const input=registration.locator('input[type=text]').first();
    const keyCountBefore=keyCount;
    for(const name of ['x'.repeat(101),'\u{1f600}'.repeat(51),'node\u007fname']) {
      await input.evaluate((el,name)=>{el.value=name;el.dispatchEvent(new Event('input',{bubbles:true}));},name);
      await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit footer button:last-child')?.disabled === true);
      assert.equal(await registration.locator('pre').textContent(),'');
      assert.equal(await registration.locator('[data-registration-status]').innerText(),en.invalidServerName);
      await page.evaluate(()=>{window.copied='unchanged';});
      await registration.locator('footer button').last().evaluate(el=>{el.disabled=false;el.click();el.disabled=true;});
      await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>window.copied),'unchanged');
    }
    await input.evaluate(el=>{el.value='x'.repeat(100);el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit footer button:last-child')?.disabled === false);
    await registration.locator('footer button').last().click();
    assert.equal(await page.evaluate(()=>window.copied),await registration.locator('pre').textContent());
    assert.ok((await page.evaluate(()=>window.copied)).includes("-name='"+'x'.repeat(100)+"'"));
    assert.equal(keyCount,keyCountBefore,'name edits must not rotate the registration key');
    assert.equal(await registration.locator('pre').isVisible(),false,'no command preview is added');
    await registration.locator('footer button').first().click();
  });
  await check('registration key is explicit, short-lived, stable while editing and contains no node/shared token',async()=>{
    await page.setViewportSize({width:390,height:900});const before=keyCount;await openRegistration();
    const registration=page.locator('.admin-dialog-edit');await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit pre')?.textContent.includes('-register-key='));
    const text=await registration.locator('pre').innerText(), key=text.match(/-register-key='([^']+)'/)[1];
    assert.equal(keyCount,before+1);assert.doesNotMatch(text,/-secret=|install-node-token|-id=/);
    assert.equal(await registration.locator('pre').isVisible(),false,'preserve the existing no-preview registration UI');
    assert.deepEqual((await registration.locator('footer button').allTextContents()).map(t=>t.trim()),[en.close,en.copy]);
    assert.equal(await registration.evaluate(el=>el.scrollWidth>el.clientWidth),false);await page.screenshot({path:path.join(out,'registration-390.png')});
    await registration.locator('input[type=text]').first().fill("node ' $() ` \" danger");
    await registration.locator('select').first().selectOption('windows');await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit pre')?.textContent.includes('Invoke-WebRequest'));
    assert.ok((await registration.locator('pre').innerText()).includes(key));assert.equal(keyCount,before+1);
    await registration.locator('footer button').last().click();assert.equal(await page.evaluate(()=>window.copied),await registration.locator('pre').innerText());
    assert.equal(await page.evaluate(k=>Object.values({...localStorage,...sessionStorage}).some(v=>String(v).includes(k)),key),false);
    await registration.locator('footer button').first().click();
    await page.setViewportSize({width:1440,height:900});
    registrationTtl=1400;await openRegistration();await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit pre')?.textContent.includes('-register-key='));
    await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit footer button:last-child')?.disabled === true);
    assert.ok(!(await registration.locator('pre').innerText()).includes('-register-key='));await registration.locator('footer button').first().click();registrationTtl=900000;
    holdAction='node_prepare_registration';await openRegistration();while(!held.length)await page.waitForTimeout(10);await registration.locator('footer button').first().click();
    await openRegistration();await page.waitForFunction(()=>document.querySelector('.admin-dialog-edit pre')?.textContent.includes('-register-key='));
    const fresh=await registration.locator('pre').innerText();held.shift()();await page.waitForTimeout(30);assert.equal(await registration.locator('pre').innerText(),fresh);await registration.locator('footer button').first().click();
  });
  await check('registration error and disabled discovery cannot copy a partial or retired key',async()=>{
    registrationFailure=true;await openRegistration();
    const registration=page.locator('.admin-dialog-edit');await registration.locator('[data-registration-status][role=alert]').waitFor();
    assert.equal(await registration.locator('footer button').last().isDisabled(),true);assert.doesNotMatch(await registration.locator('[data-registration-status]').innerText(),/-register-key=|curl|Invoke-WebRequest/);
    await registration.locator('footer button').first().click();registrationFailure=false;
    discoveryEnabled=false;await reload();await page.getByRole('button',{name:en.adminBulkAdd,exact:true}).click();assert.equal(await registration.count(),0);
    await page.keyboard.press('Escape');discoveryEnabled=true;await reload();
  });
  await check('pending read and key replies after logout cannot restore credentials',async()=>{
    await page.locator('[data-page=servers]').click();holdAction='node_read_install';await install();while(!held.length)await page.waitForTimeout(10);
    holdLogout=true;
    // Logout clears credentials, loads config, then navigates; reload must not race it.
    const loggedOut=page.waitForURL(`${origin}/`,{waitUntil:'load'});
    await page.getByRole('button',{name:en.logout}).evaluate(el=>el.click());held.shift()();while(!releaseLogout)await page.waitForTimeout(10);
    assert.equal(typeof releaseLogout,'function');releaseLogout();releaseLogout=undefined;
    await loggedOut;
    assert.equal(new URL(page.url()).pathname,'/','logout navigation must finish before fixture reload');
    await dialog.waitFor({state:'hidden'});assert.equal(await page.locator('[data-copy-command]').count(),0);
    await reload();
    holdAction='node_prepare_registration';await openRegistration();while(!held.length)await page.waitForTimeout(10);
    holdLogout=true;const keyLoggedOut=page.waitForURL(`${origin}/`,{waitUntil:'load'});
    await page.getByRole('button',{name:en.logout}).evaluate(el=>el.click());held.shift()();while(!releaseLogout)await page.waitForTimeout(10);
    releaseLogout();releaseLogout=undefined;await keyLoggedOut;
    await page.locator('.admin-dialog-edit').waitFor({state:'hidden'});assert.equal(await page.locator('.admin-dialog-edit pre').count(),0);await reload();
  });
  await check('all native options, proxy/user/version, and unavailable old release/Docker stay truthful',async()=>{
    await install();await ready();
    for(const os of ['windows','mac','unix','linux']) {await dialog.locator('[data-target-os]').selectOption(os);await ready();assert.ok((await command()).includes(tokens['node-a']));assert.match(await command(),/-terminal=0/);}
    await dialog.locator('[data-install-version]').fill('old.synthetic');await dialog.locator('[data-install-blocked]').waitFor();assert.equal(await dialog.locator('[data-copy-command]').isDisabled(),true);
    await dialog.locator('[data-install-version]').fill('task5.synthetic');await ready();await dialog.locator('[data-install-mode]').selectOption('cfsm-user');assert.match(await command(),/runuser -u cfsm/);
    await dialog.locator('#download-proxy').selectOption('https://ghfast.top/');assert.match(await command(),/https:\/\/ghfast.top\/https:\/\/raw.githubusercontent.com\/emailtq/);
    await dialog.locator('[data-auto-update]').check();assert.match(await command(),/-auto_update=1/);await close();
  });
  if (!nameProbe && !logoutProbe) for(const locale of ['en','zh','zh-TW','es','fr','id','ja']) {
    await page.evaluate(async({url,locale})=>(await import(url)).setLanguage(locale),{url:exports['/src/frontend/utils/i18n.js'],locale});
    for(const width of [320,390,1440]) for(const light of [true,false]) await check(`frozen download geometry ${locale}/${width}/${light?'light':'dark'}`,async()=>{
      await page.setViewportSize({width,height:900});await page.evaluate(light=>document.body.classList.toggle('light',light),light);
      await page.locator('[data-server-id=node-a] .action-btns button').nth(1).click();await ready();
      const geometry=await dialog.evaluate(d=>{const css=getComputedStyle(d),h=getComputedStyle(d.querySelector('h2')),cmd=getComputedStyle(d.querySelector('pre'));return {width:d.getBoundingClientRect().width,padding:css.padding,radius:css.borderRadius,font:h.fontSize,weight:h.fontWeight,line:h.lineHeight,commandFont:cmd.fontSize,commandLine:cmd.lineHeight,commandFamily:cmd.fontFamily,footer:getComputedStyle(d.querySelector('footer')).flexDirection,overflow:d.scrollWidth>d.clientWidth};});
      assert.ok(Math.abs(geometry.width-Math.min(576,width-32))<2);assert.equal(geometry.padding,'24px');assert.equal(geometry.radius,'10px');assert.equal(geometry.font,'18px');assert.equal(geometry.weight,'600');assert.equal(geometry.line,'18px');assert.equal(geometry.commandFont,'12px');assert.equal(geometry.commandLine,'19.5px');assert.ok(geometry.commandFamily.includes('monospace'));assert.equal(geometry.footer,width<640?'column-reverse':'row');assert.equal(geometry.overflow,false);
      report.geometry ||= [];report.geometry.push({locale,width,light,...geometry});
      if(width===320 || locale==='zh') await page.screenshot({path:path.join(out,`download-${locale}-${width}-${light?'light':'dark'}.png`)});
      await dialog.locator('footer button').first().click();await dialog.waitFor({state:'hidden'});
    });
  }
  assert.deepEqual(report.errors,[]);
} catch (error) {
  report.errors.push(error.stack); await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
} finally {
  releaseLogout?.();
  held.splice(0).forEach(resolve=>resolve());
  await browser?.close(); await server?.close();
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
}
if (report.errors.length) { console.error(report.errors.join('\n')); process.exitCode=1; }
