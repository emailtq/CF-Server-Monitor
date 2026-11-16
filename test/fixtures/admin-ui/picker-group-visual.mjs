import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { referenceAssets } from './round3-dialogs.mjs';

export async function pickerGroupVisual({ browser, origin, out, report, check, shot }) {
  const reference = await referenceAssets(out), fixture = path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/reference-audit/dialogs/reference');
  const admin = fs.readFileSync(path.join(reference.source, 'src/components/Admin.tsx'), 'utf8');
  const start = admin.indexOf('function NodeForm('), end = admin.indexOf('\nconst CURRENCY_NAMES', start);
  assert.ok(start > 0 && end > start);
  const nodeForm = admin.slice(start, end).trimEnd();
  const constants = admin.slice(admin.indexOf('const TRAFFIC_FIELDS'), admin.indexOf('// Displaced rows'));
  let entry = fs.readFileSync(path.join(fixture, 'entry.tsx'), 'utf8');
  entry = entry.replace('import {api,', 'import {changes,GIB,trafficCorrection,api,');
  entry = entry.replace('const params=new URLSearchParams', `${constants}\n${nodeForm}\nconst params=new URLSearchParams`);
  entry = entry.replace('const nodes=Array.from({length:9}', 'const nodes=Array.from({length:30}');
  entry = entry.replace("group:i<3?'Asia':i<6?'Europe':''", "group:i<3?'Asia':i<6?'Europe':i===29?'':'Group '+i");
  entry = entry.replace("interval:1,agent_version", "traffic_limit:0,traffic_reset_day:1,traffic_mode:'sum',total_rx:0,total_tx:0,month_rx:0,month_tx:0,public:true,interval:1,agent_version");
  entry = entry.replace("kind==='group'?", "kind==='edit'?<NodeForm node={nodes[0]} nodes={nodes} onClose={()=>setKind('')} onSaved={noop}/>:kind==='group'?");
  fs.writeFileSync(path.join(reference.dir, 'entry-round5.tsx'), entry);
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: fixture, sourcefile: 'round5-reference.tsx' }, bundle: true, format: 'iife', outfile: path.join(reference.dir, 'reference.js'), nodePaths: [path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/reference-audit/nodes-shell/reference/node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': path.join(fixture, 'src'), 'radix-ui': path.join(fixture, 'radix.ts') }, jsx: 'automatic' });
  report.reference = { ...reference, edit: 'Original NodeForm from Admin.tsx, including original GroupInput call; only App mounting/data host extended locally', functions: [...reference.functions, 'NodeForm'] };
  const style = locator => locator.evaluate(el => {
    const css = getComputedStyle(el), r = el.getBoundingClientRect();
    const paint = new OffscreenCanvas(1,1).getContext('2d'); paint.fillStyle=css.backgroundColor;paint.fillRect(0,0,1,1);
    return { width: r.width, height: r.height, backgroundRGBA:[...paint.getImageData(0,0,1,1).data], ...Object.fromEntries(['fontFamily','fontSize','lineHeight','fontWeight','borderRadius','borderColor','backgroundColor','color','padding','boxShadow','transitionDuration','transitionTimingFunction'].map(key => [key, css[key]])) };
  });
  const groups = Array.from({ length: 30 }, (_, i) => ({ id: `node-${i}`, name: `Node ${i + 1}`, server_group: i < 3 ? 'Asia' : i < 6 ? 'Europe' : i === 29 ? '' : 'Group ' + i }));
  const cases = [360,390,1440,1920].flatMap(width => [false,true].map(dark => ({ width, dark, locale: width === 360 ? 'zh' : width === 390 ? 'fr' : width === 1440 ? 'en' : 'ja' })));
  cases.push({ width:390,dark:false,locale:'es' }, { width:1440,dark:false,locale:'id' }, { width:1920,dark:true,locale:'zh-TW' });
  for (const { width, dark, locale } of process.argv.includes('--motion-only') ? [cases[0],cases[3],cases[4]] : cases) {
    const mobile = width < 640, height = mobile ? 844 : 900, stem = `${width}-${dark ? 'dark' : 'light'}-${locale}`;
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile });
    try {
      await context.route('**/*', route => {
        const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/reference')) { const file = path.join(reference.dir, path.basename(url.pathname)); return route.fulfill({ path: file, contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' }); }
        if (url.pathname === '/api/config' || url.pathname === '/theme') return route.fulfill({ json: {} });
        if (url.pathname.endsWith('/admin/api')) return route.fulfill({ json: { servers: [], settings: {}, stats: {} } });
        return route.continue();
      });
      const target = await context.newPage(), ref = await context.newPage();
      for (const p of [target, ref]) { p.setDefaultTimeout(8000); p.on('pageerror', error => report.errors.push(error.stack)); }
      await target.goto(`${origin}/test/fixtures/admin-ui/dialogs.html?locale=${locale}#/admin`); await target.waitForFunction(() => window.dialogFixture);
      await target.evaluate(() => dialogFixture.open('edit')); await target.getByRole('dialog').waitFor();
      await target.evaluate(({ dark, groups }) => { document.body.classList.toggle('light', !dark); dialogFixture.state.props.servers = groups; dialogFixture.state.props.editForm.server_group = 'Asia'; }, { dark, groups });
      await ref.goto(`${origin}/reference.html?dark=${Number(dark)}`); await ref.waitForFunction(() => window.referenceOpen); await ref.evaluate(() => referenceOpen('edit')); await ref.getByRole('dialog').waitFor();
      await ref.waitForFunction(() => document.querySelector('[data-slot=dialog-content]').getAnimations().every(a => a.playState === 'finished'));
      await check(`actual minimal/CF edit group ${stem}: input/list geometry, focus, Enter prefix and keyboard selection`, async () => {
        const states = [];
        for (const [p, isRef] of [[ref,true],[target,false]]) {
          await p.bringToFront(); const input = p.locator(isRef ? 'input[role=combobox]' : '[name=edit_server_group]');
          await (mobile ? input.tap() : input.click());
          const menu = p.locator(isRef ? '[data-slot=popover-content]' : '.admin-group-options'); await menu.waitFor();
          if (process.argv.includes('--motion-only')) {
            await p.waitForFunction(isRef => {
              const el=document.querySelector(isRef?'[data-slot=popover-content]':'.admin-group-options'), animations=el?.getAnimations();
              if(!animations?.length)return false;
              for(const animation of animations)animation.pause();
              window.groupMotion=animations.map(a=>({duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing,frames:a.effect.getKeyframes().map(f=>({...f,...(f.transform?{slideY:new DOMMatrix(f.transform).m42,scaleX:new DOMMatrix(f.transform).m11}:{})}))}));return true;
            },isRef);
            const motion=await p.evaluate(()=>window.groupMotion);report.traces.push({kind:'group-native-open-motion',isRef,motion});
            assert.ok(motion.some(a=>a.duration===150 && a.frames.some(f=>Math.abs(f.slideY+8)<1e-6 && Math.abs(f.scaleX-.95)<1e-6)),'reference opening includes the actual 8px slide with 95% scale and opacity');
            await menu.evaluate(el=>el.getAnimations().forEach(a=>a.finish()));
          }
          await p.waitForFunction(() => !document.querySelector('.admin-group-popover-enter-active') && !document.querySelector('[data-slot=popover-content]')?.getAnimations().some(a => a.playState !== 'finished'));
          assert.equal(await input.evaluate(el => el === document.activeElement), true);
          assert.equal(await p.evaluate(() => matchMedia('(pointer:coarse)').matches), mobile);
          const inputStyle = await style(input), optionStyle = await style(menu.getByRole('option').first()), menuStyle = await style(menu);
          states.push({ isRef, input: inputStyle, option: optionStyle, menu: menuStyle, coarse: mobile, touch: await p.evaluate(() => navigator.maxTouchPoints) });
          await shot(p, `${isRef ? 'reference' : 'target'}-edit-group-${stem}`);
          if (mobile) {
            const scroll = isRef ? menu.getByRole('listbox') : menu, session = await context.newCDPSession(p), r=await scroll.boundingBox(), samples=[];
            try {
              const x=r.x+20,y=r.y+r.height-20;
              await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
              for(let i=1;i<=8;i++){await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+i,y:y-i*14}]}); await p.evaluate(() => new Promise(requestAnimationFrame)); samples.push(await scroll.evaluate(el=>el.scrollTop));}
              await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
              assert.ok(samples.at(-1)>20,'group menu keeps native content swipe'); assert.equal(await input.evaluate(el=>el===document.activeElement),true);
              report.traces.push({kind:'native-group-touch-scroll',isRef,stem,samples});
              await scroll.evaluate(el => new Promise(resolve => { let last=el.scrollTop,stable=0; const settle=()=>{stable=el.scrollTop===last?stable+1:0;last=el.scrollTop;if(stable>=12)resolve();else requestAnimationFrame(settle);};requestAnimationFrame(settle); }));
              await scroll.evaluate(el=>el.scrollTop=0); await p.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            } finally {await session.detach();}
          }
          await (mobile ? menu.getByRole('option', { name:/Europe/ }).tap() : menu.getByRole('option', { name:/Europe/ }).click());
          assert.equal(await input.inputValue(), 'Europe'); assert.equal(await input.evaluate(el => el === document.activeElement), true);
          await input.fill('As'); await p.keyboard.press('Enter'); assert.equal(await input.inputValue(), 'As');
          await input.click(); await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('Enter'); assert.equal(await input.inputValue(), 'Asia');
        }
        report.bounds.push({ kind:'actual-edit-group-reference', stem, states });
        const [a,b] = states;
        for (const key of ['width','height','fontFamily','fontSize','lineHeight','borderRadius','borderColor','padding','transitionTimingFunction']) assert.equal(b.input[key], a.input[key], `input ${key}`);
        assert.deepEqual(b.input.backgroundRGBA,a.input.backgroundRGBA,'input rendered background color');
        for (const key of ['height','fontSize','lineHeight','borderRadius','padding']) assert.equal(b.option[key], a.option[key], `option ${key}`);
      });
      await check(`CF real alert ${stem}: both input pickers, native scroll owner, footer axes and no-remount touch`, async () => {
        await target.bringToFront(); await target.evaluate(() => dialogFixture.open('alert'));
        await target.evaluate(({ dark, groups }) => { document.body.classList.toggle('light', !dark); dialogFixture.state.props.servers = groups; }, { dark, groups });
        const dialog = target.getByRole('dialog'), input = dialog.locator('.admin-picker-summary').first();
        await (mobile ? input.tap() : input.click()); assert.equal(await input.evaluate(el => el === document.activeElement), true);
        assert.equal(await dialog.locator('.admin-picker-summary').count(), 2); await input.fill('Group 2');
        assert.equal(await input.evaluate(el => el === document.activeElement), true); await shot(target, `target-alert-search-${stem}`); await input.fill('');
        const bounds = await dialog.evaluate(el => {
          const rect = el => { const r=el.getBoundingClientRect(); return [r.left,r.right,r.width]; }, port = el.querySelector('.admin-dialog-scroll'), body = el.querySelector('.admin-dialog-body'), footer = el.querySelector('footer');
          return { body:rect(body),footer:rect(footer), scroll: { height:port.clientHeight,total:port.scrollHeight,width:port.clientWidth,totalWidth:port.scrollWidth,overflow:getComputedStyle(port).overflowY }, xHit:!!document.elementFromPoint(...(() => { const r=el.querySelector('.admin-dialog-close').getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]; })())?.closest('.admin-dialog-close') };
        });
        assert.deepEqual(bounds.body, bounds.footer); assert.ok(bounds.scroll.totalWidth <= bounds.scroll.width + 1); assert.equal(bounds.scroll.overflow,'auto'); assert.equal(bounds.xHit,true);
        if (mobile) {
          const list = dialog.locator('.admin-picker-options'), cdp = await context.newCDPSession(target), r = await list.boundingBox(), before = await dialog.locator('.admin-dialog-scroll').evaluate(el => el.scrollTop);
          try {
            const x=r.x+20,y=r.y+r.height-20,samples=[];
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
            for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+i,y:y-i*14}]}); await target.evaluate(() => new Promise(requestAnimationFrame)); samples.push(await list.evaluate(el=>el.scrollTop));}
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            assert.ok(samples.at(-1)>20,'native content swipe must scroll the list'); assert.equal(await input.evaluate(el=>el===document.activeElement),true); assert.equal(await dialog.locator('.admin-dialog-scroll').evaluate(el=>el.scrollTop),before);
            report.traces.push({kind:'native-picker-touch-scroll',stem,samples});
          } finally {await cdp.detach();}
        }
        report.bounds.push({kind:'alert-shell',stem,...bounds}); await target.keyboard.press('Escape'); await dialog.locator('.admin-dialog-close').click();
      });
    } finally { await context.close(); }
  }
}
