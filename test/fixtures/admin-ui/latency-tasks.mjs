import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import vue from '@vitejs/plugin-vue';
import { createServer } from './notification-matrix-server.mjs';
import { harness } from '../../terminal-harness.js';
import { saveSiteOptions } from '../../../src/utils/settings.js';
import { nativeScrollbar } from './scrollbar-assertions.mjs';
const require = createRequire(import.meta.url);
const dependencies=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT || path.join(dependencies,'playwright'));
const { PNG } = require(process.env.ADMIN_UI_PNGJS || path.join(dependencies,'pngjs'));
const root = path.resolve(process.env.CFSM_LATENCY_EVIDENCE_ROOT || path.join(os.tmpdir(),'cfsm-admin-ui-evidence',`round3-latency-${process.env.CODEX_THREAD_ID || 'local'}-browser`));
const out = path.join(root, 'ui'); fs.mkdirSync(out, { recursive: true });
const receipt = { checks: [], geometry: [], screenshots: [], errors: [], device: 'Actual CDP touch and visualViewport resizing, Chromium; no physical Android or system IME' };
const inventoryOnly=process.argv.includes('--inventory-only');
let h, server, browser, context, page, wss;
const peers = [];
const functions = ['slide', 'useDragOrder', 'DragHandle', 'nameText', 'ProbePicker', 'PingForm', 'NodeProbesForm', 'PingByNode', 'Ping'];
async function reference() {
  const source = path.resolve('../monitor/web-admin'), audit = path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/reference-audit'), dir = path.join(out, 'reference');
  const original = fs.readFileSync(path.join(source, 'src/components/Admin.tsx'), 'utf8');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['button','dialog','input','label','popover','select','switch','tooltip','card','badge','table']) {
    const relative = `src/components/ui/${file}.tsx`, destination = path.join(dir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(source, relative), destination);
  }
  for (const file of ['api.ts','utils.ts']) {
    fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true }); fs.copyFileSync(path.join(source, 'src/lib', file), path.join(dir, 'src/lib', file));
  }
  fs.copyFileSync(path.join(audit, 'dialogs/reference/radix.ts'), path.join(dir, 'radix.ts'));
  let entry = fs.readFileSync(path.join(audit, 'dialogs/reference/entry.tsx'), 'utf8').split('const params=new URLSearchParams')[0];
  for (const match of entry.matchAll(/^function (\w+)/gm)) {
    const name = match[1], start = original.search(new RegExp(`function ${name}\\b`)), next = /^(?:function |const |export |type |interface )/mg;
    next.lastIndex = start + 1; const boundary = next.exec(original)?.index ?? original.length;
    assert.ok(entry.includes(original.slice(start, original.lastIndexOf('\n}', boundary) + 2)), `actual reference ${name} changed`);
  }
  entry = entry.replace("import {Check,ChevronDown,CircleQuestionMark,Copy,Search}", "import {Check,ChevronDown,CircleQuestionMark,Copy,Search,GripVertical,Pencil,Plus,Trash2}");
  assert.ok(entry.includes('const toast={success:()=>{},error:()=>{}};'));entry=entry.replace('const toast={success:()=>{},error:()=>{}};','');
  const sonner=path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/credential/exact-reference/package/dist/index.mjs');
  entry += `\nimport {Toaster,toast} from ${JSON.stringify(sonner)};import {flushSync} from 'react-dom';import {Card} from './src/components/ui/card';import {Badge} from './src/components/ui/badge';import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from './src/components/ui/table';\n`;
  entry += original.match(/^const ems = .+$/m)[0] + '\n';
  for (const name of functions) {
    const start = original.search(new RegExp(`function ${name}\\b`)), next = /^(?:function |const |export |type |interface )/mg;
    assert.ok(start >= 0, name); next.lastIndex = start + 1; const boundary = next.exec(original)?.index ?? original.length;
    entry += original.slice(start, original.lastIndexOf('\n}', boundary) + 2) + '\n';
  }
  entry += `const dark=new URLSearchParams(location.search).get('dark')==='1';document.documentElement.classList.toggle('dark',dark);const nodes=Array.from({length:34},(_,i)=>({id:i+1,name:i<2?'node-'+(i===0?'a':'b'):'Node '+i,group:i%2?'Europe':'Asia',country:i%2?'US':'HK',online:true}));createRoot(document.getElementById('app')).render(<TooltipProvider><main className="mx-auto max-w-[1600px] p-4"><Ping nodes={nodes}/></main><Toaster position="top-center" theme={dark?'dark':'light'}/></TooltipProvider>);`;
  fs.writeFileSync(path.join(dir,'entry.tsx'), entry);
  const deps = path.join(audit, 'nodes-shell/reference/node_modules');
  await build({ entryPoints:[path.join(dir,'entry.tsx')], bundle:true, format:'iife', outfile:path.join(dir,'reference.js'), nodePaths:[deps], alias:{'@':path.join(dir,'src'),'radix-ui':path.join(dir,'radix.ts')}, define:{'process.env.NODE_ENV':'"production"'}, jsx:'automatic' });
  const tailwind = createRequire(path.join(deps, 'tailwindcss/package.json'))('tailwindcss');
  const expand = css => css.replace(/@import\s+["']([^"']+)["']([^;]*);/g, (_, imported, modifiers) => {
    const content = imported === 'tailwindcss' ? expand(fs.readFileSync(path.join(deps,'tailwindcss/index.css'),'utf8')) : imported === 'tw-animate-css' ? fs.readFileSync(path.join(deps,'tw-animate-css/dist/tw-animate.css'),'utf8') : fs.readFileSync(path.join(deps,'tailwindcss',imported),'utf8');
    const layer = modifiers.match(/layer\(([^)]+)\)/); return layer ? `@layer ${layer[1]} {${content}}` : content;
  }).replace(/^@source[^;]+;\s*$/gm,'');
  const sourceFiles = [];
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes:true })) { const file=path.join(dir,item.name); if(item.isDirectory())walk(file);else if(/\.(tsx?|css)$/.test(item.name))sourceFiles.push(file); } };
  walk(path.join(source,'src'));
  const candidates = [...new Set(sourceFiles.flatMap(file => {
    const text=fs.readFileSync(file,'utf8');return [...text.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g)].flatMap(match=>match[0].slice(1,-1).split(/\s+/)).concat(text.match(/[^\s"'`]+/g)||[]);
  }))];
  const compiled = await tailwind.compile(expand(fs.readFileSync(path.join(source,'src/index.css'),'utf8')));
  fs.writeFileSync(path.join(dir,'reference.css'),compiled.build(candidates));
  fs.writeFileSync(path.join(dir,'reference.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/reference.css"><div id="app"></div><script src="/reference.js"></script>');
  receipt.reference = { source, functions, primitives:11, css:'actual original index.css and existing lock-pinned Tailwind compilation', dir };
  return dir;
}
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const dialogMotionSettled = () => page.waitForFunction(() => [...document.querySelectorAll('.admin-dialog')].every(el => el.getAnimations().every(animation => animation.playState === 'finished')));
const noticeStyle = el => {const css=getComputedStyle(el),r=el.getBoundingClientRect(),title=getComputedStyle(el.querySelector('[data-title]'));return {width:r.width,height:r.height,top:r.top,font:css.fontFamily,size:css.fontSize,padding:css.padding,gap:css.gap,radius:css.borderRadius,border:css.borderTopColor,background:css.backgroundColor,color:css.color,shadow:css.boxShadow,weight:title.fontWeight,lineHeight:title.lineHeight,icon:el.querySelector('svg').outerHTML.replace(/ xmlns="[^"]*"/,'')};};
async function snapshot(name, cdp) {
  const file = path.join(out, `${name}.png`);
  if (cdp) { const image = await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); fs.writeFileSync(file,Buffer.from(image.data,'base64')); }
  else await page.screenshot({path:file});
  receipt.screenshots.push(file);
}
async function press(locator, cdp, mobile) {
  await locator.scrollIntoViewIfNeeded();
  if (!mobile) return locator.click();
  const box = await locator.boundingBox(), x = box.x+box.width/2, y = box.y+box.height/2;
  assert.ok(await locator.evaluate(el => { const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]}); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
async function scrollbars(dialog, cdp, mobile, name, inner = true) {
  const width = (await page.evaluate(()=>innerWidth));
  const resize = async height => { if(mobile)await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:844});else await page.setViewportSize({width,height});await frames(); };
  // Short height makes even empty/confirmation consumers exercise their real outer owner.
  const shortHeight=inner?300:180;
  await resize(shortHeight);
  await page.waitForFunction(()=>[...document.querySelectorAll('.admin-dialog')].every(el=>el.getAnimations().every(animation=>animation.playState==='finished')));
  const outer=dialog.locator('.admin-dialog-scroll');await outer.evaluate(el=>{el.scrollTop=0;});await frames();
  const layout=await dialog.evaluate(el=>{const r=el.getBoundingClientRect(),owner=el.querySelector('.admin-dialog-scroll'),body=el.querySelector('.admin-dialog-body').getBoundingClientRect(),footer=el.querySelector('footer').getBoundingClientRect(),close=el.querySelector('.admin-dialog-close'),glyph=close.querySelector('svg').getBoundingClientRect(),title=el.querySelector('h2').getBoundingClientRect();return {right:r.right,top:r.top,body:[body.left,body.right],footer:[footer.left,footer.right],glyph:glyph.left+glyph.width/2,chromeEnd:Math.max(close.getBoundingClientRect().bottom,title.bottom)-r.top,trackTop:parseFloat(getComputedStyle(owner,'::-webkit-scrollbar-track').marginTop),gutter:owner.offsetWidth-owner.clientWidth,hit:getComputedStyle(close).width,overflow:getComputedStyle(el.querySelector('.admin-dialog-body')).overflowY};});
  receipt.geometry.push({name,kind:'all-latency-dialog-scroll-layout',layout});
  assert.deepEqual(layout.body,layout.footer);assert.equal(layout.overflow,'visible');assert.equal(layout.gutter,20);assert.ok(layout.trackTop>=layout.chromeEnd+8);
  const paintX=Math.round(layout.right)-21;
  const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const paintFile=path.join(out,`${name}-outer-axis.png`);fs.writeFileSync(paintFile,Buffer.from(shot.data,'base64'));receipt.screenshots.push(paintFile);
  receipt.geometry.push({name,kind:'outer-paint-metrics',g:await outer.evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight,top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height,scrollTop:el.scrollTop,min:getComputedStyle(el,'::-webkit-scrollbar-thumb').minHeight}))});
  const frame=PNG.sync.read(Buffer.from(shot.data,'base64')), sourceY=Math.max(0,Math.round(layout.top)+9), pixels=new PNG({width:20,height:Math.min(Math.floor(shortHeight-32)-18,frame.height-sourceY)});
  assert.ok(pixels.height>0,`${name}: scrollbar sample remains inside the viewport`);
  PNG.bitblt(frame,pixels,paintX,sourceY,20,pixels.height,0,0);
  const rows=Array.from({length:pixels.height},(_,y)=>y).filter(y=>sourceY+y-Math.round(layout.top)>=layout.trackTop && [2,3,4].some(x=>[0,1,2].some(c=>Math.abs(pixels.data[(y*pixels.width+x)*4+c]-pixels.data[y*pixels.width*4+c])>20)));
  assert.ok(rows.length,`${name}: visible native outer paint`);
  const y=rows[Math.floor(rows.length/2)],cols=Array.from({length:20},(_,x)=>x).filter(x=>[0,1,2].some(c=>Math.abs(pixels.data[(y*pixels.width+x)*4+c]-pixels.data[y*pixels.width*4+c])>20));
  assert.equal(cols.length,3);assert.ok(Math.abs(paintX+cols.reduce((sum,x)=>sum+x+.5,0)/3-layout.glyph)<.75,`${name}: X and native paint share right axis`);
  const drag=async(locator,label)=>{
    if(!mobile)return nativeScrollbar({page,out,report:receipt,PNG},locator,'y',label);
    await locator.evaluate(el=>{el.scrollTop=0;});await frames();
    const g=await locator.evaluate(el=>{const r=el.getBoundingClientRect(),track=getComputedStyle(el,'::-webkit-scrollbar-track'),top=parseFloat(track.marginTop)||0,bottom=parseFloat(track.marginBottom)||0;return {x:r.right-14,y:r.top+top+Math.max(20,(el.clientHeight-top-bottom)*el.clientHeight/el.scrollHeight)/2,gutter:el.offsetWidth-el.clientWidth,scroll:el.scrollHeight,client:el.clientHeight};});
    assert.equal(g.gutter,20);assert.ok(g.scroll>g.client);
    const trace=[];await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:g.x,y:g.y}]});
    for(let n=1;n<=8;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:g.x-n,y:g.y+n*6}]});await frames();trace.push(await locator.evaluate(el=>el.scrollTop));}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(250);
    receipt.geometry.push({name:label,kind:'native-CDP-touch-scrollbar',g,trace});assert.ok(trace.at(-1)>0);assert.ok(trace.every((v,i)=>!i||v>=trace[i-1]));
  };
  await drag(outer,`${name}-outer`);await outer.evaluate(el=>{el.scrollTop=0;});await snapshot(`${name}-short`,cdp);
  await resize(844);
  if(inner){const list=dialog.locator('.latency-picker-list');await list.scrollIntoViewIfNeeded();await drag(list,`${name}-inner`);await list.evaluate(el=>{el.scrollTop=0;});}
  await outer.evaluate(el=>{el.scrollTop=0;});await frames();
  assert.equal(await dialog.locator('.admin-dialog-close').evaluate(el=>{const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,radius=matchMedia('(pointer:coarse)').matches?21:14;return [[x-radius,y],[x+radius,y],[x,y-radius],[x,y+radius]].every(([px,py])=>el.contains(document.elementFromPoint(px,py)));}),true);
  receipt.checks.push(`${name}: real 3px outer paint/X axis, 20px native outer hit, equal body/footer, ${inner?'inner native drag, ':''}full close hit`);
}
async function noScrollbar(dialog,cdp,name){
  const outer=dialog.locator('.admin-dialog-scroll');await outer.evaluate(el=>{el.scrollTop=0;});await frames();
  const g=await dialog.evaluate(el=>{const r=el.getBoundingClientRect(),owner=el.querySelector('.admin-dialog-scroll');return {right:r.right,top:r.top,height:r.height,scroll:owner.scrollHeight,client:owner.clientHeight,overflow:getComputedStyle(owner).overflowY};});
  assert.equal(g.overflow,'auto');assert.equal(g.scroll,g.client,`${name}: naturally fitting content has no scroll range`);
  const capture=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),pixels=PNG.sync.read(Buffer.from(capture.data,'base64'));
  const colored=[];for(let y=Math.ceil(g.top)+70;y<Math.floor(g.top+g.height)-10;y++){const x=Math.round(g.right)-18,background=Math.round(g.right)-21;for(const c of [0,1,2])if(Math.abs(pixels.data[(y*pixels.width+x)*4+c]-pixels.data[(y*pixels.width+background)*4+c])>10){colored.push(y);break;}}
  assert.equal(colored.length,0,`${name}: no painted thumb/empty rail when content fits`);receipt.geometry.push({name,kind:'no-overflow-no-scrollbar',g});await snapshot(name,cdp);
}
try {
  // Ordinary browser regressions retain their existing CF-only prerequisites; actual reference acceptance is explicit.
  const ref = process.argv.includes('--reference') ? await reference() : null;
  h = await harness();
  await saveSiteOptions(h.db,{is_public:'true',show_three_net_details:'true',username:'fixture',['pass'+'word']:'fixture-only-hash',theme_url:'',wss_report_enabled:'true',frontend_ws_timeout_minutes:'17',long_history_points:'180'});
  for(let i=2;i<34;i++) await h.db.prepare('INSERT INTO servers(id,name,server_group,region) VALUES(?,?,?,?)').bind(`node-${i}`,`Node ${i}`,i%2?'Europe':'Asia',i%2?'US':'HK').run();
  await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=?,server_group='Asia',region='HK' WHERE id='node-a'").bind(Date.now()-3600000).run();
  // Browser regressions stand alone. Explicit replay consumes completed Go evidence, never a concurrent test's output.
  const goReceipts = process.env.CFSM_LATENCY_GO_RECEIPTS;
  const config = goReceipts && new URLSearchParams(fs.readFileSync(path.join(goReceipts,'config-32.txt'),'utf8'));
  const definitions = (config ? JSON.parse(config.get('latency_tasks')) : Array.from({length:32},(_,i)=>({id:`p_browser_${i}`,target:'127.0.0.1:443',interval:i?60:5}))).map((task,i)=>({...task,name:`Probe ${i}`,nodes:['node-a'],auto_join:true}));
  assert.equal((await h.action('import_servers',{settings:{latency_tasks:{version:1,tasks:definitions}}})).status,200);
  const report = goReceipts ? JSON.parse(fs.readFileSync(path.join(goReceipts,'report-32.json'),'utf8')) : {config_schema:'9',metrics:{cpu:12,ram_total:1024,ram_used:512,extra_probes:Object.fromEntries(definitions.map((task,i)=>[task.id,{ping:31+i,loss:0}]))}}; report.id='node-a';
  receipt.reportSource = goReceipts || 'synthetic schema-9 report through authenticated Worker/D1/DO; actual Go is tested independently';
  for(let i=0;i<4;i++) { report.metrics.timestamp=Date.now()-120000+i*30000; assert.equal((await h.fetch('/update',{method:'POST',headers:{...h.agentHeaders(),'Content-Type':'application/json','X-Agent-Config-Schema':'9'},body:JSON.stringify(report)})).status,200); }
  server = await createServer({plugins:[vue()],publicDir:path.resolve('public'),fixtureEntries:[path.resolve('test/fixtures/admin-ui/unlimited-ping.html')],cacheDir:path.join(out,'cache'),apiMiddlewarePlugin:{name:'latency-actual-worker-d1',configureServer(vite){vite.middlewares.use(async(request,response,next)=>{
    const url=new URL(request.url,'http://fixture.invalid'); if(!url.pathname.startsWith('/api/')&&url.pathname!=='/admin/api')return next(); if(url.pathname==='/api/ws')return next();
    let body='';for await(const chunk of request)body+=chunk;const headers={...request.headers,Origin:'https://example.com'};delete headers.host;if(url.pathname==='/api/config')delete headers.cookie;
    const result=await h.fetch(url.pathname+url.search,{method:request.method,headers,...(body?{body}:{})});response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
  });}}});
  wss=new WebSocketServer({noServer:true});server.httpServer.on('upgrade',(request,socket,head)=>wss.handleUpgrade(request,socket,head,async ws=>{let peer;const pending=[];ws.on('message',data=>peer?peer.ws.send(data.toString()):pending.push(data.toString()));peer=await h.socket(request.url);peers.push(peer);peer.messages.forEach(message=>{if(ws.readyState===1)ws.send(message)});peer.ws.on('message',(data,binary)=>{if(ws.readyState===1)ws.send(data,{binary})});pending.forEach(message=>peer.ws.send(message));ws.on('close',()=>peer.ws.terminate());}));
  browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],executablePath:process.env.ADMIN_UI_CHROMIUM || path.join(os.homedir(),'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe')});
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  for(const width of inventoryOnly?[]:[360,390,1440,1920])for(const dark of [false,true]){
    await h.db.prepare('DELETE FROM metrics_history').run();
    assert.equal((await h.action('import_servers',{settings:{latency_tasks:{version:1,tasks:definitions}}})).status,200);
    const mobile=width<640;context=await browser.newContext({viewport:{width,height:844},hasTouch:mobile,isMobile:mobile,deviceScaleFactor:1});
    await context.addCookies([{name:'cfsm_auth',value:h.token,url:origin}]);
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    page=await context.newPage();page.on('pageerror',e=>receipt.errors.push(e.stack));const cdp=await context.newCDPSession(page);
    await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=zh#/admin`);await page.locator('[data-page=collection]').click();await page.locator('.latency-table tbody tr[data-server-id]').nth(31).waitFor();
    await page.evaluate(dark=>document.body.classList.toggle('light',!dark),dark);await frames();await snapshot(`${width}-${dark?'dark':'light'}-tasks`,mobile?cdp:null);
    assert.equal(await page.locator('.latency-table tbody tr[data-server-id]').count(),32);
    const handle=page.locator('.latency-task-name .drag-handle').first();const handleBox=await handle.boundingBox();
    assert.equal(handleBox.width,mobile?32:24,'reference task drag handle dimensions');assert.equal(handleBox.height,mobile?32:24);
    if(!mobile){
      const first=await page.locator('.latency-table tbody tr').nth(0).getAttribute('data-server-id'),second=await page.locator('.latency-table tbody tr').nth(1).getAttribute('data-server-id');
      const keyboardSave=page.waitForResponse(response=>response.url().endsWith('/admin/api')&&response.request().postDataJSON()?.action==='latency_order');await handle.focus();await page.keyboard.press('ArrowDown');assert.equal((await keyboardSave).status(),200);await page.waitForFunction(id=>document.querySelector('.latency-table tbody tr')?.dataset.serverId===id,second);
      const movedHandle=page.locator(`tr[data-server-id="${first}"] .drag-handle`),b=await movedHandle.boundingBox(),row=await movedHandle.locator('xpath=ancestor::tr').boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();assert.equal(await movedHandle.locator('xpath=ancestor::tr').evaluate(el=>el.dataset.lifted!==undefined),true);await page.mouse.move(b.x+b.width/2,b.y+b.height/2-row.height*1.2,{steps:8});await frames();await snapshot(`${width}-${dark}-task-drag`);
      const pointerSave=page.waitForResponse(response=>response.url().endsWith('/admin/api')&&response.request().postDataJSON()?.action==='latency_order');await page.mouse.up();assert.equal((await pointerSave).status(),200);await page.waitForFunction(id=>document.querySelector('.latency-table tbody tr')?.dataset.serverId===id,first);receipt.checks.push(`${width}/${dark}: task keyboard and pointer reorder persist through real CAS/API; source drag handle size and dimmed row`);
    }else{
      const table=page.locator('.latency-page .table-wrapper');await table.focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.latency-page .table-wrapper').scrollLeft>0);assert.ok(await table.evaluate(el=>el.scrollWidth>el.clientWidth));await table.evaluate(el=>{el.scrollLeft=0;});receipt.checks.push(`${width}/${dark}: real horizontally overflowing table scrolls by keyboard without widening page`);
    }
    const add=page.getByRole('button',{name:'添加监控',exact:true});await press(add,cdp,mobile);const dialog=page.getByRole('dialog');
    if(mobile)assert.ok((await dialog.locator('.latency-picker-toolbar .admin-search').boundingBox()).width>=160,'mobile search retains a readable full row, not an icon-only box');
    await scrollbars(dialog,cdp,mobile,`${width}-${dark}-add`);
    assert.equal(await dialog.locator('.latency-picker-list input:checked').count(),34);assert.equal(await dialog.getByRole('spinbutton').inputValue(),'60');
    const name=dialog.locator('.latency-name input'),target=dialog.getByRole('textbox',{name:'目标地址',exact:true});await name.fill('Boundary');await target.fill('127.0.0.1:443');
    await target.focus();await target.evaluate(el=>el.setSelectionRange(2,7));
    if(mobile){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:430,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:844});await frames();assert.equal(await target.evaluate(el=>el===document.activeElement),true);assert.deepEqual(await target.evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,7]);assert.ok(await page.evaluate(()=>visualViewport.height<500));await snapshot(`${width}-${dark?'dark':'light'}-keyboard`,cdp);await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:844});await frames();}
    const geometry=await dialog.evaluate(el=>{const r=el.getBoundingClientRect(),body=el.querySelector('.admin-dialog-body').getBoundingClientRect(),footer=el.querySelector('.admin-dialog-footer').getBoundingClientRect();return{width:r.width,bodyWidth:body.width,footerWidth:footer.width,viewport:innerWidth,scroll:el.querySelector('.admin-dialog-scroll').scrollWidth}});
    receipt.geometry.push({width,dark,geometry});assert.ok(Math.abs(geometry.bodyWidth-geometry.footerWidth)<1);assert.ok(geometry.width<=width-30);
    await name.scrollIntoViewIfNeeded();await snapshot(`${width}-${dark?'dark':'light'}-form`,mobile?cdp:null);
    await dialog.locator('.latency-picker-toolbar .toolbar-input').fill('Node 2');
    const visibleBefore=await dialog.locator('.latency-picker-list label').count();assert.ok(visibleBefore>0&&visibleBefore<34);
    await press(dialog.getByRole('button',{name:'全不选',exact:true}),cdp,mobile);assert.equal(await dialog.locator('.latency-picker-list input:checked').count(),0);
    await press(dialog.getByRole('button',{name:'全选',exact:true}),cdp,mobile);await dialog.locator('.latency-picker-toolbar .toolbar-input').fill('');
    await target.fill('invalid://target');await press(dialog.getByRole('button',{name:'保存',exact:true}),cdp,mobile);assert.ok(await dialog.getByRole('alert').isVisible());
    if(width===390&&dark){await page.keyboard.press('Alt+t');assert.equal(await dialog.locator('.download-credential-toaster').evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Escape');assert.ok(await dialog.isVisible(),'notice Escape does not close editing dialog');await target.focus();}
    await target.fill('127.0.0.1:443');await press(dialog.getByRole('button',{name:'保存',exact:true}),cdp,mobile);await dialog.waitFor({state:'hidden'});
    assert.ok(await page.locator('[data-latency-success]').isVisible(),'successful task save gives an explicit live status');
    await page.locator('[data-latency-success]').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));await frames();
    const successStyle=await page.locator('[data-latency-success]').evaluate(noticeStyle);await snapshot(`${width}-${dark}-saved`,mobile?cdp:null);
    if(width===1440&&dark){await page.locator('[data-latency-success]').hover();await page.waitForTimeout(4200);assert.ok(await page.locator('[data-latency-success]').isVisible(),'hover pauses actual 4s notice lifetime');await page.mouse.move(0,0);await page.locator('[data-latency-success]').waitFor({state:'hidden',timeout:5000});receipt.checks.push('success Sonner lifetime pauses on mouse hover and removes after leaving');}
    if(width===390&&dark){const b=await page.locator('[data-latency-success]').boundingBox(),x=b.x+b.width/2,y=b.y+b.height/2;await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let n=1;n<=6;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-n*8}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.locator('[data-latency-success]').waitFor({state:'hidden'});await page.waitForTimeout(300);receipt.checks.push('actual CDP upward notice swipe dismisses; error Alt+T/Escape stays inside editor');}
    let catalog=(await(await h.action('latency_list')).json()).tasks;const added=catalog.find(task=>task.name==='Boundary');assert.ok(added);assert.equal(added.nodes.length,34);assert.equal(added.interval,60);assert.equal(added.auto_join,true);
    await press(page.getByRole('button',{name:'编辑监控: Boundary',exact:true}),cdp,mobile);await page.getByRole('dialog').getByRole('textbox',{name:'名称',exact:true}).fill('Revised');await page.getByRole('dialog').getByRole('textbox',{name:'目标地址',exact:true}).fill('127.0.0.1:80');await press(page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}),cdp,mobile);await page.getByRole('dialog').waitFor({state:'hidden'});
    catalog=(await(await h.action('latency_list')).json()).tasks;const revised=catalog.find(task=>task.id===added.id);assert.equal(revised.name,'Revised');assert.notEqual(revised.metric_id,revised.id);
    await press(page.getByRole('button',{name:'删除监控: Revised',exact:true}),cdp,mobile);assert.ok((await page.getByRole('dialog').textContent()).includes('原始旧版历史保留'));await noScrollbar(page.getByRole('dialog'),cdp,`${width}-${dark}-confirm-fitting`);await scrollbars(page.getByRole('dialog'),cdp,mobile,`${width}-${dark}-confirm`,false);await press(page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}),cdp,mobile);await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('.latency-table tbody tr[data-server-id]').count(),32);
    await press(page.getByRole('button',{name:'按节点',exact:true}),cdp,mobile);await press(page.getByRole('button',{name:'选择监控: node-a',exact:true}),cdp,mobile);assert.equal(await page.getByRole('dialog').locator('.latency-picker-list label').count(),32);await snapshot(`${width}-${dark?'dark':'light'}-node-picker`,mobile?cdp:null);
    await scrollbars(page.getByRole('dialog'),cdp,mobile,`${width}-${dark}-node`);
    const nodeSearch=page.getByRole('dialog').locator('.latency-picker-toolbar .toolbar-input');await nodeSearch.focus();await nodeSearch.fill('Probe');await nodeSearch.evaluate(el=>el.setSelectionRange(1,3));
    if(mobile){const before=await page.getByRole('dialog').boundingBox();for(const height of [700,480,360,300,430,844]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:844});await frames();assert.equal(await nodeSearch.evaluate(el=>el===document.activeElement),true);assert.deepEqual(await nodeSearch.evaluate(el=>[el.selectionStart,el.selectionEnd]),[1,3]);assert.equal((await page.getByRole('dialog').boundingBox()).width,before.width);}receipt.checks.push(`${width}/${dark}: node dialog continuous native visualViewport keyboard shrink/restore keeps focused search selection and width`);}await nodeSearch.fill('');
    await press(page.getByRole('dialog').getByRole('button',{name:'全不选',exact:true}),cdp,mobile);await press(page.getByRole('dialog').getByRole('checkbox',{name:'Probe 0',exact:true}),cdp,mobile);await press(page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}),cdp,mobile);await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal((await(await h.action('latency_list')).json()).tasks.filter(task=>task.nodes.includes('node-a')).length,1);
    assert.equal((await h.action('import_servers',{settings:{latency_tasks:{version:1,tasks:definitions}}})).status,200);
    receipt.checks.push(`${width}/${dark}: actual task/node view, defaults, picker, cancel, dialog width and keyboard selection`);
    await press(page.locator('[data-page=settings]'),cdp,mobile);await page.locator('#cfg_wss_report_enabled').waitFor();
    assert.equal(await page.locator('[data-setting-field=frontend_ws_timeout_minutes]').inputValue(),'17');
    assert.equal(await page.locator('[data-setting-field=long_history_points]').inputValue(),'180');
    assert.equal(await page.locator('.collection-settings [data-ping-node]').count(),0);
    await snapshot(`${width}-${dark?'dark':'light'}-settings`,mobile?cdp:null);
    receipt.checks.push(`${width}/${dark}: original WSS/timeouts/history settings relocated without changing values`);
    for(const count of [9,32]){
      const publicTasks=definitions.slice(0,count);
      assert.equal((await h.action('import_servers',{settings:{latency_tasks:{version:1,tasks:publicTasks}}})).status,200);
      const send=async(change={},timestamp=Date.now())=>{const payload={...report,metrics:{...report.metrics,timestamp,extra_probes:Object.fromEntries(publicTasks.map(task=>[task.id,change[task.id]||report.metrics.extra_probes[task.id]]))}};assert.equal((await h.fetch('/update',{method:'POST',headers:{...h.agentHeaders(),'Content-Type':'application/json','X-Agent-Config-Schema':'9'},body:JSON.stringify(payload)})).status,200);};
      await send({},Date.now()-(count===9?90000:60000));
      await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=zh#/`);await page.waitForFunction(()=>[...document.querySelectorAll('.three-net-name')].some(el=>el.textContent==='Probe 0'));await page.evaluate(dark=>document.body.classList.toggle('light',!dark),dark);await snapshot(`${width}-${dark}-public-${count}`,mobile?cdp:null);
      await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=zh#/server/node-a`);
      await page.waitForFunction(count=>window.pingCharts?.().some(chart=>chart.datasets.filter(ds=>ds.field?.startsWith('ping_extra_')&&ds.data.some(point=>typeof point.y==='number')).length===count),count);
      const charts=await page.evaluate(()=>window.pingCharts().filter(chart=>chart.datasets.some(ds=>ds.field?.startsWith('ping_extra_'))));
      assert.ok(charts.length>=2);assert.ok(charts.every(chart=>chart.datasets.slice(0,8).every(ds=>ds.hidden)));
      assert.ok(charts.every(chart=>chart.datasets.slice(8).map(ds=>ds.field).join()===publicTasks.map(task=>`ping_extra_${task.id}`).join()));
      await page.evaluate(dark=>document.body.classList.toggle('light',!dark),dark);await page.locator('.chart-card').filter({has:page.locator('canvas')}).last().scrollIntoViewIfNeeded();await snapshot(`${width}-${dark}-detail-${count}`,mobile?cdp:null);
      if(width===390&&dark&&count===32){
        const last=publicTasks.at(-1).id;
        // Keep the existing 30s chart/report cadence. Advance the fixture's clocks, not the production throttle.
        await page.evaluate(()=>{window.latencyNativeNow=Date.now;window.latencyClock=0;Date.now=()=>window.latencyNativeNow()+window.latencyClock;});
        const tick=async change=>{await h.fetch('/test/report-clock?advance=31000');await page.evaluate(()=>{window.latencyClock+=31000;});await send(change,await page.evaluate(()=>Date.now()));};
        await tick({[last]:{ping:null,loss:100}});await page.waitForFunction(id=>window.pingCharts().some(chart=>chart.datasets.some(ds=>ds.field===`ping_extra_${id}`&&ds.data.some(point=>point.y===100))),last);
        await tick({[last]:{ping:false,loss:false}});await page.waitForFunction(id=>window.pingCharts().filter(chart=>chart.datasets.some(ds=>ds.field===`ping_extra_${id}`)).every(chart=>chart.datasets.find(ds=>ds.field===`ping_extra_${id}`).hidden),last);
        await tick({});await page.waitForFunction(id=>window.pingCharts().filter(chart=>chart.datasets.some(ds=>ds.field===`ping_extra_${id}`)).every(chart=>!chart.datasets.find(ds=>ds.field===`ping_extra_${id}`).hidden),last);
        await h.fetch('/test/report-clock?advance=-93000');await page.evaluate(()=>{Date.now=window.latencyNativeNow;});receipt.checks.push('actual DO websocket/browser: dynamic task failure, disabled and recovery; 31s synthetic clock steps preserve original 30s chart cadence');
      }
      const publicData=await(await h.fetch('/api/servers')).json();assert.ok(!JSON.stringify(publicData).includes(publicTasks[0].target));receipt.checks.push(`${width}/${dark}: ${count} task public card, assigned ID history/chart datasets, eight hidden anchors, target privacy`);
    }
    if(ref){
    await context.route('**/reference*',route=>{const file=path.join(ref,new URL(route.request().url()).pathname.slice(1));return route.fulfill({path:file});});
    await context.route('**/ping-tasks',route=>route.fulfill({json:{tasks:definitions.map((task,i)=>({...task,id:i+1,nodes:[1]}))}}));
    await page.goto(`${origin}/reference.html?dark=${dark?1:0}`);await page.getByRole('button',{name:'添加监控',exact:true}).click();await page.getByRole('dialog').waitFor();await page.evaluate(()=>Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{}))));await frames();await snapshot(`${width}-${dark?'dark':'light'}-minimal-form`,mobile?cdp:null);receipt.checks.push(`${width}/${dark}: actual minimal React/Radix/Tailwind Ping and PingForm rendered`);
    await page.getByRole('dialog').getByRole('textbox').nth(0).fill('Boundary');await page.getByRole('dialog').getByRole('textbox').nth(1).fill('127.0.0.1:443');await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();await page.locator('[data-sonner-toast]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-sonner-toast]')?.dataset.mounted==='true');await page.locator('[data-sonner-toast]').evaluate(el=>new Promise(resolve=>setTimeout(resolve,420)));
    const referenceStyle=await page.locator('[data-sonner-toast]').evaluate(noticeStyle);assert.deepEqual(successStyle,referenceStyle);receipt.geometry.push({width,dark,kind:'actual-Sonner-success-parity',successStyle,referenceStyle});await snapshot(`${width}-${dark}-minimal-saved`,mobile?cdp:null);
    }
    await context.close();context=null;
  }
  for(const locale of inventoryOnly?[]:['zh','zh-TW','en','ja','fr','es','id'])for(const dark of [false,true]){
    const trans=(await import(`../../../src/frontend/locales/${locale}.js`)).default;
    const cancelLabel=/^[A-Z][A-Z /_-]+$/.test(trans.cancel)?trans.cancel[0]+trans.cancel.slice(1).toLowerCase():trans.cancel;
    assert.equal((await h.action('import_servers',{settings:{latency_tasks:{version:1,tasks:definitions}}})).status,200);
    context=await browser.newContext({viewport:{width:360,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});await context.addCookies([{name:'cfsm_auth',value:h.token,url:origin}]);await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());page=await context.newPage();const cdp=await context.newCDPSession(page);
    await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=${locale}#/admin`);await page.locator('[data-page=collection]').click();await page.evaluate(dark=>document.body.classList.toggle('light',!dark),dark);await press(page.getByRole('button',{name:trans.latencyAdd,exact:true}),cdp,true);
    await page.getByRole('dialog').locator('.latency-name input').fill('Long task name · 中文 · 日本語 · '.repeat(2));await page.getByRole('dialog').getByRole('textbox',{name:trans.latencyTarget,exact:true}).fill('very-long-but-valid-target-name.example.test:443');await dialogMotionSettled();
    const search=page.getByRole('dialog').locator('.latency-picker-toolbar .toolbar-input'), searchLayout=async()=>page.getByRole('dialog').evaluate(el=>{const box=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {y:r.y,height:r.height,minHeight:s.minHeight,maxHeight:s.maxHeight,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,scrollTop:node.scrollTop}};return {dialog:box(el),owner:box(el.querySelector('.admin-dialog-scroll')),list:box(el.querySelector('.latency-picker-list')),viewport:{height:innerHeight,visual:visualViewport?.height}}});await search.focus();await search.scrollIntoViewIfNeeded();await frames();const before=await search.boundingBox(),beforeLayout=await searchLayout();await search.fill('does-not-match-any-node');await dialogMotionSettled();await frames();assert.equal(await page.locator('.latency-picker-list label').count(),0);const after=await search.boundingBox(),afterLayout=await searchLayout();receipt.geometry.push({locale,dark,kind:'filtered-empty-list-floor',before,after,beforeLayout,afterLayout});assert.ok(Math.abs(after.y-before.y)<1,`empty search retains original list floor, not a jumping dialog: ${before.y} -> ${after.y}; ${JSON.stringify({beforeLayout,afterLayout})}`);
    assert.ok(await page.getByRole('dialog').evaluate(el=>{const r=el.getBoundingClientRect(),owner=el.querySelector('.admin-dialog-scroll');return r.left>=15&&r.right<=innerWidth-15&&owner.scrollWidth<=owner.clientWidth+1;}));await snapshot(`locale-${locale}-${dark}-empty-long-task`,cdp);
    await press(page.getByRole('dialog').getByRole('button',{name:cancelLabel,exact:true}),cdp,true);await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal((await h.action('import_servers',{settings:{latency_tasks:{version:1,tasks:[]}}})).status,200);await page.reload();await page.locator('[data-page=collection]').click();await page.evaluate(dark=>document.body.classList.toggle('light',!dark),dark);await press(page.getByRole('button',{name:trans.latencyByNode,exact:true}),cdp,true);await press(page.getByRole('button',{name:trans.latencySelect+': node-a',exact:true}),cdp,true);assert.equal(await page.locator('.latency-picker-list label').count(),0);await noScrollbar(page.getByRole('dialog'),cdp,`locale-${locale}-${dark}-empty-node-dialog`);assert.equal(await page.locator('.latency-picker-list').evaluate(el=>el.scrollHeight===el.clientHeight),true,'empty inner list has no scroll range');await context.close();context=null;receipt.checks.push(`${locale}/${dark}: small-screen task/empty-search/long-fields/cancel and empty node-task dialog`);
  }
  const longName='Long monitor title · '.repeat(5).trim();
  await h.db.prepare("UPDATE servers SET name=? WHERE id='node-a'").bind(longName).run();
  for(const width of [390,1440])for(const dark of [false,true]){
    const mobile=width<640;assert.equal((await h.action('import_servers',{settings:{latency_tasks:{version:1,tasks:[{...definitions[0],name:longName}]}}})).status,200);
    context=await browser.newContext({viewport:{width,height:844},hasTouch:mobile,isMobile:mobile,deviceScaleFactor:1});await context.addCookies([{name:'cfsm_auth',value:h.token,url:origin}]);await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());page=await context.newPage();const cdp=await context.newCDPSession(page);
    await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=zh#/admin`);await page.locator('[data-page=collection]').click();await page.evaluate(dark=>document.body.classList.toggle('light',!dark),dark);
    await press(page.getByRole('button',{name:'添加监控',exact:true}),cdp,mobile);let dialog=page.getByRole('dialog');await press(dialog.getByRole('combobox'),cdp,mobile);await page.getByRole('listbox').waitFor();await page.getByRole('listbox').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished.catch(()=>{}))));await frames();await snapshot(`task-group-menu-${width}-${dark}`,cdp);await press(page.getByRole('option',{name:'Europe',exact:true}),cdp,mobile);await page.getByRole('listbox').waitFor({state:'hidden'});assert.ok(await dialog.locator('.latency-picker-list label').count()>0);assert.ok((await dialog.locator('.latency-picker-list label').evaluateAll(items=>items.map(el=>el.title))).every(title=>title.endsWith('Europe')));await press(dialog.getByRole('button',{name:'全不选',exact:true}),cdp,mobile);assert.equal(await dialog.locator('.latency-picker-list input:checked').count(),0);await press(dialog.getByRole('combobox'),cdp,mobile);await press(page.getByRole('option',{name:'全部分组',exact:true}),cdp,mobile);await page.getByRole('listbox').waitFor({state:'hidden'});assert.ok(await dialog.locator('.latency-picker-list input:checked').count()>0,'visible-group deselection preserves other groups');await press(dialog.getByRole('button',{name:'取消',exact:true}),cdp,mobile);await dialog.waitFor({state:'hidden'});
    await press(page.getByRole('button',{name:'删除监控: '+longName,exact:true}),cdp,mobile);await frames();await snapshot(`long-confirm-${width}-${dark}`,cdp);assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));await page.keyboard.press('Escape');
    await press(page.getByRole('button',{name:'按节点',exact:true}),cdp,mobile);await press(page.getByRole('button',{name:'选择监控: '+longName,exact:true}),cdp,mobile);await frames();await snapshot(`long-node-title-${width}-${dark}`,cdp);assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));assert.equal(await page.locator('.latency-picker-list').evaluate(el=>el.scrollHeight===el.clientHeight),true);await context.close();context=null;receipt.checks.push(`${width}/${dark}: group dropdown/visible-group deselection, long confirmation/node title, single fitting inner item, natural width and dismissal`);
  }
  await h.dispose();h=await harness();await saveSiteOptions(h.db,{is_public:'true',show_three_net_details:'true',username:'fixture',['pass'+'word']:'fixture-only-hash',theme_url:'',wss_report_enabled:'true',frontend_ws_timeout_minutes:'17',long_history_points:'180'});await h.db.prepare('DELETE FROM servers').run();
  context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});await context.addCookies([{name:'cfsm_auth',value:h.token,url:origin}]);page=await context.newPage();await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(`${origin}/test/fixtures/admin-ui/unlimited-ping.html?locale=zh#/admin`);await page.locator('[data-page=collection]').click();await page.getByRole('button',{name:'添加监控',exact:true}).click();assert.equal(await page.locator('.latency-picker-list label').count(),0);await snapshot('empty-site-add-dialog',await context.newCDPSession(page));receipt.checks.push('no-node site keeps add reachable and empty picker; no phantom assignment');await context.close();context=null;
  assert.deepEqual(receipt.errors,[]);
}catch(error){receipt.failure=error.stack;receipt.websocket=peers.map(peer=>peer.messages.filter(message=>typeof message==='string').slice(-5));receipt.charts=await page?.evaluate(()=>window.pingCharts?.()).catch(()=>null);await snapshot('failure').catch(()=>{});throw error;}
finally{await context?.close();await browser?.close();for(const peer of peers)peer.ws?.terminate();if(wss){for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));}await server?.close();await h?.dispose();receipt.closed=true;fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(receipt,null,2));console.log(out);}
