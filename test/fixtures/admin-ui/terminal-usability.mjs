import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import en from '../../../src/frontend/locales/en.js';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = path.resolve('docs/superpowers/terminal-usability-2026-11-11');
const out = process.env.TERMINAL_USABILITY_REPORT_DIR || fs.mkdtempSync(path.join(base,'task-3-browser-'));
fs.mkdirSync(out,{recursive:true});
const report = {checks:[],errors:[],actions:[],statusBatches:[],syntheticStatusBoundary:true};
let server, browser, page;
const held = [];
let status = {enabled:false,credentialEnabled:true,localEnabled:false,localObservationFresh:true,connected:false,supported:false,state:'local_disabled'};
let holdNext = false, failStatus = false, site = 0, holdLogout = false, serverCount = 1;
const check = async (name, fn) => { await fn(); report.checks.push({name,pass:true}); console.log(name); };
try {
  server = await createServer({frontendExports:true,fixtureEntries:[path.resolve('test/fixtures/admin-ui/terminal-install-access.html')],cacheDir:path.join(out,'.cache'),plugins:[vue()],publicDir:path.resolve('public')});
  const httpOrigin = `http://127.0.0.1:${server.httpServer.address().port}`, origin = httpOrigin.replace('http:','https:');
  const bundle = fs.readdirSync(out).find(name=>name.startsWith('compiled-fixture-'));
  const exports = JSON.parse(fs.readFileSync(path.join(out,bundle,'build-receipt.json'))).exports;
  browser = await chromium.launch({headless:true,executablePath:'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  report.browserVersion=browser.version();
  const context = await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(() => {
    const later = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window), fetch = window.fetch.bind(window);
    window.pollTimers = new Map(); window.statusPending = 0; window.maxPending = 0; window.statusAborts = 0;
    let id = -1;
    window.setTimeout = (fn,ms,...args) => {
      if (ms !== 5000) return later(fn,ms,...args);
      const key = id--; window.pollTimers.set(key,()=>fn(...args)); return key;
    };
    window.clearTimeout = key => { if (!window.pollTimers.delete(key)) cancel(key); };
    window.tickPoll = () => { const due = [...window.pollTimers.values()]; window.pollTimers.clear(); due.forEach(fn=>fn()); };
    window.fetch = async (url,init) => {
      if (!init?.body || JSON.parse(init.body).action !== 'terminal_status') return fetch(url,init);
      window.statusPending++; window.maxPending = Math.max(window.maxPending,window.statusPending);
      try { return await fetch(url,init); } catch (error) { if(init.signal?.aborted) window.statusAborts++; throw error; }
      finally { window.statusPending--; }
    };
    window.opened = []; window.open = (...args) => { window.opened.push(args); return null; };
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});
    window.setHidden = hidden => {
      Object.defineProperty(document,'hidden',{configurable:true,value:hidden});
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await context.route('**/*',async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://api.github.com') {
      if (url.pathname.includes('/contents/')) return route.fulfill({json:{encoding:'base64',content:Buffer.from(url.pathname.includes('terminal_control.go') ? 'func (a *Agent) startTerminal(ctx context.Context) {}' : 'fs.BoolVar(&terminal,"terminal",false,""); fs.StringVar(&token,"token-file","",""); fs.StringVar(&key,"register-key","","")').toString('base64')}});
      return route.fulfill({json:{tag_name:'task5.synthetic',draft:false,assets:[{name:'cf-probe-linux-amd64',state:'uploaded',browser_download_url:'https://github.com/emailtq/cfsm-agent/releases/download/task5.synthetic/cf-probe-linux-amd64'}]}});
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/admin/api') {
      const data = request.postDataJSON(); report.actions.push(data.action);
      if (data.action === 'terminal_status') {
        if(data.serverIds) report.statusBatches.push({count:data.serverIds.length,first:data.serverIds[0],last:data.serverIds.at(-1),unique:new Set(data.serverIds).size});
        const snapshot = {...status}, failed = failStatus;
        if (holdNext) { holdNext=false; await new Promise(resolve=>held.push(resolve)); }
        return route.fulfill(failed ? {status:503,json:{error:'terminal_query_failed'}} : {json:data.serverIds ? {nodes:Object.fromEntries(data.serverIds.map(id=>[id,snapshot]))} : snapshot}).catch(()=>{});
      }
      if (data.action === 'node_read_install') return route.fulfill({json:{enabled:true,token:'a'.repeat(64),version:1,tokenVersion:1,needsRotation:false}});
      if (data.action === 'logout') { if (holdLogout) await new Promise(resolve=>held.push(resolve)); return route.fulfill({json:{success:true}}).catch(()=>{}); }
      return route.fulfill({json:{settings:{site_title:'Fixture',terminal_enabled:true,username:'fixture',password_configured:true},servers:Array.from({length:serverCount},(_,i)=>({id:i ? `node-${i}` : 'node-a',name:i ? `Node ${i}` : site ? 'Site B Node' : 'Site A Node',os:'Linux',is_online:true})),stats:{total:serverCount}}});
    }
    if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({json:{}});
    const target = url.pathname === '/admin' ? '/test/fixtures/admin-ui/terminal-install-access.html' : url.pathname;
    const response = await route.fetch({url:httpOrigin+target+url.search});
    if(url.pathname === '/admin') return route.fulfill({response,body:(await response.text()).replace('<head>','<head><meta name="apiBase" content="'+origin+','+origin+'">')});
    return route.fulfill({response});
  });
  page = await context.newPage(); page.on('pageerror',error=>report.errors.push(error.stack));
  page.setDefaultTimeout(10000);
  const entry = () => page.locator('[data-server-id=node-a] .terminal-entry button');
  const idle = () => page.waitForFunction(()=>window.statusPending === 0);
  const tick = async () => {
    await page.waitForFunction(()=>window.pollTimers.size === 1);
    await page.evaluate(()=>window.tickPoll());
    await idle();
    // fetch resolving precedes JSON parsing and the component's next poll schedule.
    await page.waitForFunction(()=>window.pollTimers.size === 1);
  };
  const show = async () => { await page.evaluate(()=>window.setHidden(false)); await idle(); };
  const hide = async () => { await page.evaluate(()=>window.setHidden(true)); await idle(); };
  const reload = async () => { await page.goto(`${origin}/admin?locale=en#/admin?apiIndex=0`); await page.reload(); await entry().waitFor(); await idle(); };
  await reload();
  await check('1001 nodes use sequential unique batches without silently omitting the last node',async()=>{
    serverCount=1001; const before=report.statusBatches.length; await reload();
    const last=page.locator('[data-server-id=node-1000] .terminal-entry button');
    assert.equal(await page.locator('#terminal-reason-node-1000').textContent(),'Local terminal is disabled. Enable it in the Agent installation.');
    assert.deepEqual(report.statusBatches.slice(before).map(b=>b.count),[1000,1]);
    assert.ok(report.statusBatches.slice(before).every(b=>b.count===b.unique&&b.count<=1000));
    status={...status,enabled:true,localEnabled:true,state:'offline'}; await tick(); assert.equal(await last.isDisabled(),false);
    assert.equal(await page.evaluate(()=>window.maxPending),1);
    serverCount=1; status={...status,enabled:false,localEnabled:false,state:'local_disabled'}; await reload();
  });
  await check('explicit local false has disabled keyboard/mouse entry and a truthful reason; node Edit remains',async()=>{
    assert.equal(await entry().isDisabled(),true);
    assert.ok(Number(await entry().evaluate(el=>getComputedStyle(el).opacity))<1,'disabled terminal must retain grey styling');
    assert.equal(await page.locator('.terminal-reason').textContent(), 'Local terminal is disabled. Enable it in the Agent installation.');
    await entry().evaluate(button=>button.click());
    await page.locator('.terminal-entry').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.opened.length),0);
    await page.getByRole('button',{name:en.edit,exact:true}).click();
    assert.equal(await page.locator('.admin-dialog-edit').count(),1); await page.keyboard.press('Escape');
  });
  await check('after-install true offline auto-unlocks and click opens correct built-in page without awaited query',async()=>{
    status = {...status,enabled:true,localEnabled:true,localObservationFresh:false,state:'offline'};
    await tick(); assert.equal(await entry().isDisabled(),false);
    const before=report.actions.length;
    holdNext=true;
    await entry().click();
    assert.deepEqual(await page.evaluate(()=>window.opened),[[`${origin}/admin#/admin/terminal/node-a?apiIndex=0`,'_blank','noopener,noreferrer']]);
    assert.equal(await entry().evaluate(button=>{const before=window.opened.length;button.click();return window.opened.length-before;}),1,'open must happen in the click stack, not after an await');
    assert.equal(report.actions.length,before,'navigation must not query or create credentials/sessions'); holdNext=false;
  });
  await check('poll true to false and revoke grey immediately; unknown and unsupported are never ready',async()=>{
    for(const next of [
      {enabled:false,localEnabled:false,state:'local_disabled'},
      {enabled:false,credentialEnabled:false,state:'revoked'},
      {enabled:false,localEnabled:null,state:'pending'},
      {enabled:true,localEnabled:true,observed:'unsupported',state:'unsupported'}
    ]) { status={...status,...next}; await tick(); assert.equal(await entry().isDisabled(),true); }
    failStatus=true; await tick();
    assert.equal(await page.locator('.terminal-reason').textContent(),en.terminal_query_failed);
    assert.equal(await entry().isDisabled(),true); failStatus=false;
  });
  await check('single pending poll is superseded by fresh close query; late reply cannot restore true',async()=>{
    status={...status,enabled:true,credentialEnabled:true,localEnabled:true,observed:null,state:'offline'};
    await tick(); holdNext=true;
    await page.evaluate(()=>window.tickPoll()); await page.waitForFunction(()=>window.statusPending===1);
    await page.getByRole('button',{name:en.copy,exact:true}).click(); await page.getByRole('dialog').waitFor();
    status={...status,enabled:false,localEnabled:false,state:'local_disabled'};
    await page.getByRole('dialog').locator('footer').getByRole('button',{name:en.close,exact:true}).click();
    held.shift()(); await idle(); await page.waitForFunction(()=>document.querySelector('.terminal-entry button').disabled);
    assert.equal(await page.evaluate(()=>window.maxPending),1);
    assert.equal(await page.evaluate(()=>window.pollTimers.size),1);
  });
  await check('hidden cancels pending request/timer and invalidates late response; visible resumes',async()=>{
    status={...status,enabled:true,localEnabled:true,state:'offline'}; holdNext=true;
    await page.evaluate(()=>window.tickPoll()); await page.waitForFunction(()=>window.statusPending===1);
    await hide();
    assert.equal(await page.evaluate(()=>window.pollTimers.size),0);
    assert.ok(await page.evaluate(()=>window.statusAborts)>0);
    status={...status,enabled:false,localEnabled:false,state:'local_disabled'};
    held.shift()(); await page.waitForTimeout(30);
    assert.equal(await entry().isDisabled(),true);
    await show(); assert.equal(await entry().isDisabled(),true);
  });
  await check('rapid site generation changes discard old responses and open the selected API index',async()=>{
    status={...status,enabled:true,localEnabled:true,state:'offline'}; holdNext=true;
    await page.evaluate(()=>window.tickPoll()); await page.waitForFunction(()=>window.statusPending===1);
    status={...status,enabled:false,localEnabled:false,state:'local_disabled'}; site=1;
    await page.evaluate(()=>{location.hash='/admin?apiIndex=1';});
    await page.waitForFunction(()=>document.querySelector('.server-name-link')?.textContent==='Site B Node'); await idle();
    held.shift()(); await page.waitForTimeout(30); assert.equal(await entry().isDisabled(),true);
    status={...status,enabled:true,localEnabled:true,state:'offline'}; await tick();
    await entry().click(); assert.equal((await page.evaluate(()=>window.opened.at(-1)))[0],`${origin}/admin#/admin/terminal/node-a?apiIndex=1`);
    assert.equal(await page.evaluate(()=>window.maxPending),1);
  });
  await check('unmount cancels pending status/timer, returning admin starts one new cadence',async()=>{
    holdNext=true; await page.evaluate(()=>window.tickPoll()); await page.waitForFunction(()=>window.statusPending===1);
    await page.evaluate(()=>{location.hash='/admin/terminal/node-a?apiIndex=1';});
    await page.locator('.terminal-page').waitFor(); held.shift()(); await idle();
    assert.equal(await page.evaluate(()=>window.pollTimers.size),0);
    await page.locator('[data-terminal-back]').click(); await entry().waitFor(); await idle();
    assert.equal(await page.evaluate(()=>window.pollTimers.size),1);
  });
  await check('seven locales desktop/mobile footer is Copy and Close only, copied state does not rename Copy',async()=>{
    for(const locale of ['en','zh','zh-TW','es','fr','id','ja']) {
      const labels=(await import(`../../../src/frontend/locales/${locale}.js`)).default;
      await page.evaluate(async ({file,locale})=>(await import(file)).setLanguage(locale),{file:exports['/src/frontend/utils/i18n.js'],locale});
      for(const width of [320,390,1440]) {
        await page.setViewportSize({width,height:900});
        await page.locator('[data-server-id=node-a] .action-btns button').nth(1).click();
        const dialog=page.getByRole('dialog'); await dialog.waitFor();
        await page.waitForFunction(()=>!document.querySelector('[data-copy-command]')?.disabled);
        assert.deepEqual(await dialog.locator('footer button').allTextContents(),[labels.close,labels.copy]);
        await dialog.locator('[data-copy-command]').click();
        assert.equal(await dialog.locator('[data-copy-command]').innerText(),labels.copy);
        const contrast=await dialog.locator('[data-copy-command]').evaluate(button=>{
          const css=getComputedStyle(button),canvas=document.createElement('canvas');canvas.width=canvas.height=1;
          const context=canvas.getContext('2d');
          const luminance=color=>{
            context.fillStyle=color;context.fillRect(0,0,1,1);
            const rgb=[...context.getImageData(0,0,1,1).data].slice(0,3).map(value=>{const s=value/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});
            return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
          };
          const fg=luminance(css.color),bg=luminance(css.backgroundColor);
          return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
        });
        assert.ok(contrast>=4.5,'hovered Copy must remain readable: '+contrast);
        assert.equal(await page.evaluate(()=>window.copied),await dialog.locator('.cmd-output').innerText());
        const geometry=await dialog.evaluate(el=>({width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth,buttons:[...el.querySelectorAll('footer button')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right};})}));
        assert.ok(Math.abs(geometry.width-Math.min(576,width-32))<2); assert.equal(geometry.overflow,false);
        assert.ok(geometry.buttons.every(b=>b.left>=0&&b.right<=width));
        await page.screenshot({path:path.join(out,`copy-${locale}-${width}.png`)});
        await dialog.locator('footer').getByRole('button',{name:labels.close,exact:true}).click(); await idle();
      }
    }
    assert.equal(report.actions.some(a=>['terminal_enable_install','terminal_prepare_install','terminal_open'].includes(a)),false);
  });
  await check('logout event cancels status transport and cadence before late response',async()=>{
    holdNext=true; await page.evaluate(()=>window.tickPoll()); await page.waitForFunction(()=>window.statusPending===1);
    await page.evaluate(()=>window.dispatchEvent(new Event('terminal-logout'))); await idle();
    assert.equal(await page.evaluate(()=>window.pollTimers.size),0); held.shift()();
    await page.waitForTimeout(30); assert.equal(await entry().isDisabled(),true);
  });
  await check('storage and cross-tab cookie-only logout cancel polling without leftovers',async()=>{
    for(const channel of ['storage','broadcast']) {
      await reload(); holdNext=true;
      await page.evaluate(()=>window.tickPoll()); await page.waitForFunction(()=>window.statusPending===1);
      await page.evaluate(channel=>{
        if(channel==='storage') window.dispatchEvent(new StorageEvent('storage',{key:'jwt_token',newValue:null}));
        else {const c=new BroadcastChannel('cfsm-terminal-logout'); c.postMessage({type:'logout'}); c.close();}
      },channel);
      await idle(); assert.equal(await page.evaluate(()=>window.pollTimers.size),0);
      held.shift()(); await page.waitForTimeout(30); assert.equal(await entry().isDisabled(),true);
    }
  });
  await check('actual logout button cancels status immediately even while logout API awaits',async()=>{
    await reload(); holdNext=true; holdLogout=true;
    await page.evaluate(()=>window.tickPoll()); await page.waitForFunction(()=>window.statusPending===1);
    await page.getByRole('button',{name:en.logout,exact:true}).click(); await idle();
    assert.equal(await page.evaluate(()=>window.pollTimers.size),0);
    assert.equal(await entry().isDisabled(),true); holdLogout=false;
  });
} catch(error) { report.errors.push(error.stack); await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{}); }
finally { held.splice(0).forEach(resolve=>resolve()); await browser?.close(); await server?.close(); fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); }
assert.deepEqual(report.errors,[]);
