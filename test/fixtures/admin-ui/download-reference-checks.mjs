import assert from 'node:assert/strict';
import path from 'node:path';

export async function downloadReferenceChecks({page, context, origin, load, check, screenshot, out, report}) {
  if (!process.env.ADMIN_DOWNLOAD_REFERENCE_DIR) return;
  await check('exact reference InstallDialog/ConfirmDialog actions, header description and prevented initial focus', async () => {
    const reference = await context.newPage(), cdp = await context.newCDPSession(reference);
    const style = el => {
      const css = getComputedStyle(el), box = el.getBoundingClientRect();
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      const rgba = color => {ctx.clearRect(0,0,1,1); ctx.fillStyle=color; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data]};
      return {width:box.width,height:box.height,font:css.fontSize,weight:css.fontWeight,line:css.lineHeight,padding:css.padding,gap:css.gap,radius:css.borderRadius,border:css.borderWidth,bg:rgba(css.backgroundColor),color:rgba(css.color),borderColor:css.borderWidth === '0px' ? null : rgba(css.borderColor),shadow:css.boxShadow.split(/,(?![^(]*\))/).filter(part => !part.includes('rgba(0, 0, 0, 0)')).join(',').trim() || 'none',icon:el.querySelector('svg')?.getAttribute('viewBox') || null,disabled:el.disabled,opacity:css.opacity};
    };
    try {
      for (const width of [360,390,1440,1920]) for (const dark of [false,true]) {
        await reference.setViewportSize({width,height:width < 640 ? 844 : 900});
        await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width < 640});
        await reference.goto(`${origin}/reference.html?dark=${Number(dark)}`);
        await reference.waitForFunction(() => typeof window.referenceOpen === 'function');
        await reference.evaluate(() => window.referenceOpen('download'));
        const expected = reference.locator('[role=dialog]'); await expected.waitFor();
        await reference.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.includes('复制') && !button.disabled));
        await expected.evaluate(async el => {await Promise.all(el.getAnimations({subtree:true}).map(animation => animation.finished));});
        await load({locale:'zh',width,dark});
        assert.equal(await page.evaluate(() => document.activeElement.matches('.admin-dialog-close,input,select')),false,'InstallDialog prevents default initial autofocus');
        assert.equal(await reference.evaluate(() => document.activeElement.matches('button,input,select')),false);
        const actual = page.locator('.admin-dialog-download');
        const selectors = [
          [expected.getByRole('button',{name:'换发',exact:true}),actual.locator('[data-terminal-reissue]'),'reissue'],
          [expected.getByRole('button',{name:'关闭',exact:true}),actual.locator('footer button').first(),'close'],
          [expected.getByRole('button',{name:'复制',exact:true}),actual.locator('[data-copy-command]'),'copy']
        ];
        for (const [ref,cf,kind] of selectors) {
          for (const button of [ref,cf]) await button.evaluate(async el => {await Promise.all(el.getAnimations().map(animation => animation.finished));});
          const a = await cf.evaluate(style), e = await ref.evaluate(style);
          report.geometry.push({actions:true,width,dark,kind,expected:e,actual:a});
          // CF's footer keeps the accepted wrapping/touch contracts; intrinsic desktop and small-action dimensions still match.
          if (width < 640 && kind !== 'reissue') { assert.equal(a.height,44); assert.equal(e.height,36); delete a.width; delete e.width; delete a.height; delete e.height; }
          assert.deepEqual(a,e,`${kind}/${width}/${dark}`);
          if (width >= 640) {
            await ref.hover(); await cf.hover();
            await ref.evaluate(async el => {await Promise.all(el.getAnimations().map(animation => animation.finished));});
            await cf.evaluate(async el => {await Promise.all(el.getAnimations().map(animation => animation.finished));});
            const hoverActual=await cf.evaluate(style),hoverExpected=await ref.evaluate(style);
            report.geometry.push({hover:true,width,dark,kind,expected:hoverExpected,actual:hoverActual});
            assert.deepEqual(hoverActual,hoverExpected,`hover ${kind}/${width}/${dark}`);
            await reference.mouse.move(1,1); await page.mouse.move(1,1);
            await reference.keyboard.press('Tab'); await page.keyboard.press('Tab');
            await ref.evaluate(el => el.focus()); await cf.evaluate(el => el.focus());
            for (const button of [ref,cf]) {
              await button.evaluate(async el => {await Promise.all(el.getAnimations().map(animation => animation.finished));});
              const focus = await button.evaluate(el => ({visible:el.matches(':focus-visible'),outline:getComputedStyle(el).outlineStyle,shadow:getComputedStyle(el).boxShadow}));
              assert.equal(focus.visible && focus.outline === 'none' && focus.shadow.includes('3px'),true,`reference keyboard focus ring: ${JSON.stringify(focus)}`);
            }
            await ref.evaluate(el => el.blur()); await cf.evaluate(el => el.blur());
          }
        }
        await screenshot(reference,path.join(out,`reference-install-${width}-${dark ? 'dark':'light'}.png`));
        await actual.locator('footer').scrollIntoViewIfNeeded();
        await screenshot(page,path.join(out,`target-install-${width}-${dark ? 'dark':'light'}.png`));
        await expected.getByRole('button',{name:'换发',exact:true}).click(); await actual.locator('[data-terminal-reissue]').click();
        const cfConfirm = page.locator('.admin-dialog-download-confirm'), refConfirm = reference.locator('[role=dialog]').last();
        await cfConfirm.waitFor(); await refConfirm.waitFor();
        await refConfirm.evaluate(async el => {await Promise.all(el.getAnimations({subtree:true}).map(animation => animation.finished));});
        for (const d of [cfConfirm,refConfirm]) {
          const geometry = await d.evaluate(el => {
            const description = el.querySelector('[id="'+el.getAttribute('aria-describedby')+'"]'), footer = el.querySelector('footer,[data-slot=dialog-footer]');
            const css = getComputedStyle(description), f = getComputedStyle(footer);
            return {inHeader:description.parentElement.contains(el.querySelector('h2')),font:css.fontSize,line:css.lineHeight,padding:f.paddingTop,border:f.borderTopWidth};
          });
          assert.deepEqual(geometry,{inHeader:true,font:'14px',line:'22.75px',padding:'16px',border:'1px'});
        }
        for (const kind of ['cancel','confirm']) {
          const ref = refConfirm.getByRole('button',{name:kind === 'cancel' ? '取消':'换发凭证',exact:true});
          const cf = cfConfirm.locator('footer button').nth(kind === 'cancel' ? 0:1);
          const a=await cf.evaluate(style),e=await ref.evaluate(style);
          if (width < 640) {assert.equal(a.height,44); assert.equal(e.height,36); delete a.width; delete e.width; delete a.height; delete e.height}
          report.geometry.push({confirmation:true,width,dark,kind,expected:e,actual:a});
          assert.deepEqual(a,e,`${kind}/${width}/${dark}`);
          if (width >= 640) {
            await ref.hover(); await cf.hover();
            for (const button of [ref,cf]) await button.evaluate(async el => {await Promise.all(el.getAnimations().map(animation => animation.finished));});
            const hoverActual=await cf.evaluate(style),hoverExpected=await ref.evaluate(style);
            report.geometry.push({confirmationHover:true,width,dark,kind,expected:hoverExpected,actual:hoverActual});
            assert.deepEqual(hoverActual,hoverExpected,`confirm hover ${kind}/${width}/${dark}`);
            if (kind === 'confirm') for (const button of [ref,cf]) {
              const contrast = await button.evaluate(el => {
                const css=getComputedStyle(el),ctx=document.createElement('canvas').getContext('2d');
                const luminance=(color,base) => {
                  ctx.clearRect(0,0,1,1);
                  if (base) {ctx.fillStyle=base;ctx.fillRect(0,0,1,1);}
                  ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
                  const rgb=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(value => {const c=value/255;return c<=.04045 ? c/12.92 : ((c+.055)/1.055)**2.4;});
                  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
                };
                const text=luminance(css.color),background=luminance(css.backgroundColor,getComputedStyle(el.closest('[role=dialog]')).backgroundColor);
                return (Math.max(text,background)+.05)/(Math.min(text,background)+.05);
              });
              assert.ok(contrast >= 4.5,`actual destructive hover contrast ${width}/${dark}: ${contrast}`);
              report.geometry.push({confirmationHoverContrast:true,width,dark,contrast});
            }
            await reference.mouse.move(1,1); await page.mouse.move(1,1);
          }
        }
        for (const d of [cfConfirm,refConfirm]) await d.evaluate(async el => {await Promise.all(el.getAnimations({subtree:true}).map(animation => animation.finished));});
        await screenshot(reference,path.join(out,`reference-confirm-${width}-${dark ? 'dark':'light'}.png`));
        await screenshot(page,path.join(out,`target-confirm-${width}-${dark ? 'dark':'light'}.png`));
      }
    } finally {await cdp.detach();await reference.close()}
  });
}
