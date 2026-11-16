import assert from 'node:assert/strict';
import path from 'node:path';
import en from '../../../src/frontend/locales/en.js';

export async function downloadCopyChecks({page, load, ready, noticeReady, nextFrame, check, screenshot, out}) {
  const toast = () => page.locator('[data-credential-notice]');
  const copy = () => page.locator('[data-copy-command]');
  const verify = async (success, done = en.copySuccess) => {
    await toast().waitFor();
    assert.equal(await toast().getAttribute('role'), success ? 'status' : 'alert');
    assert.equal(await toast().innerText(), success ? done : en.copyFailed);
    assert.doesNotMatch(await toast().innerText(), /[a-f0-9]{64}/);
  };
  await check('copy feedback download success/rejection preserves labels, dialog and input selection', async () => {
    for (const success of [true, false]) {
      await load();
      const input = page.locator('#download-version');
      await input.fill('latest'); await ready(); await input.focus();
      await input.evaluate(el => el.setSelectionRange(1, 4));
      await page.evaluate(success => { window.copyReject = !success; window.execCalls = 0; document.execCommand = () => {window.execCalls++; return true}; },success);
      await copy().evaluate(el => el.click()); await verify(success);
      assert.equal(await copy().innerText(), en.copy); assert.equal(await copy().locator('svg').count(),1);
      assert.equal(await page.locator('.admin-dialog-download').count(),1);
      assert.equal(await input.evaluate(el => document.activeElement === el && el.selectionStart === 1 && el.selectionEnd === 4),true);
      assert.equal(await page.evaluate(() => window.execCalls),0);
    }
  });
  await check('copy feedback HTTP native event succeeds without textarea, blur or selection changes; false/throw fail', async () => {
    for (const result of ['native','false','throw']) {
      await load({http:true, controlled:false, openDownload:false});
      await page.evaluate(result => {
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
        const native = document.execCommand.bind(document);
        const input = document.querySelector('.toolbar-input'); input.focus(); input.setSelectionRange(0,0);
        window.copyInput = input; window.copyBlur = 0; input.addEventListener('blur',()=>window.copyBlur++);
        window.copyTextareas = 0;
        const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeName === 'TEXTAREA') window.copyTextareas++; });
        observer.observe(document.body,{childList:true,subtree:true});
        document.addEventListener('copy',event => {
          const setData = event.clipboardData.setData.bind(event.clipboardData);
          event.clipboardData.setData = (type,text) => { window.nativeCopyText = text; return setData(type,text); };
        });
        document.execCommand = command => {
          if (result === 'throw') throw new Error('denied');
          if (result === 'false') return false;
          return native(command);
        };
      },result);
      await page.locator('[data-server-id=node-a] .admin-copy-value').first().evaluate(el => el.click()); await verify(result === 'native',`${en.copySuccess} 192.0.2.1`);
      assert.equal(await page.evaluate(() => document.activeElement === window.copyInput && window.copyBlur === 0 && window.copyTextareas === 0),true);
      if (result === 'native') assert.equal(await page.evaluate(() => window.nativeCopyText),'192.0.2.1');
    }
  });
  await check('copy feedback late write cannot announce success after node/site/close/reopen or token rotation', async () => {
    for (const change of ['node','siteABA','closeABA','rotation']) {
      await load(); await page.evaluate(() => {window.copyHold = true}); await copy().click();
      await page.waitForFunction(() => typeof window.releaseCopy === 'function');
      await page.evaluate(change => {
        const s = window.downloadFixture.state;
        if (change === 'node') s.serverId = 'node-b';
        if (change === 'siteABA') s.generation++;
        if (change === 'closeABA') s.show = false;
      },change); await nextFrame();
      if (change === 'closeABA') { await page.evaluate(() => {window.downloadFixture.state.show = true}); await ready(); }
      if (change === 'rotation') {
        await page.locator('[data-terminal-reissue]').click(); await page.locator('[data-confirm-reissue]').click();
        await page.locator('.admin-dialog-download-confirm').waitFor({state:'hidden'}); await ready();
      }
      await page.evaluate(() => window.releaseCopy()); await nextFrame();
      if (change === 'rotation') assert.equal(await toast().innerText(),en.downloadReissued);
      else assert.equal(await toast().count(),0);
    }
  });
  await check('copy feedback actual admin address/price/note, registration and uninstall share one success/error host', async () => {
    for (const kind of ['address','price','note','registration','uninstall']) for (const success of [true,false]) {
      await load({controlled:false, locale:'en', width:kind === 'uninstall' ? 390 : 1440});
      await page.locator('.admin-dialog-download footer button').first().click();
      await page.locator('.admin-dialog-download').waitFor({state:'hidden'});
      await page.evaluate(success => {window.copyReject = !success},success);
      if (kind === 'registration') {
        await page.getByRole('button',{name:en.adminBulkAdd,exact:true}).click();
        const button = page.locator('.admin-dialog-edit footer button').last(); await button.waitFor();
        await page.waitForFunction(() => document.querySelector('.admin-dialog-edit footer button:last-child')?.disabled === false);
        const preview = page.locator('.admin-registration-form .cmd-output');
        assert.equal(await preview.isVisible(), true, 'copy uses a command the user can actually read');
        const visibleCommand = await preview.innerText();
        await button.click(); assert.equal(await button.innerText(),en.copy);
        if (success) assert.equal(await page.evaluate(() => window.copied), visibleCommand, 'clipboard receives the exact visible installation command');
      } else if (kind === 'uninstall') {
        await page.locator('[data-server-id=node-a] .action-btns').getByRole('button',{name:en.delete,exact:true}).click();
        await page.locator('.cmd-input-wrapper button').click();
        assert.equal(await page.locator('.cmd-input-wrapper button').innerText(),en.copy);
      } else if (kind === 'note') {
        await page.locator('[data-server-id=node-a]').evaluate(row => {
          let component = row.__vueParentComponent;
          while (component && !component.vnode.props?.onCopyNote) component = component.parent;
          if (!component) throw new Error('missing mounted note event consumer');
          component.vnode.props.onCopyNote({id:'node-a',note:'Fixture note'});
        });
      } else {
        await page.locator('[data-server-id=node-a] .admin-copy-value').nth(kind === 'address' ? 0 : 1).click();
      }
      await verify(success,kind === 'address' ? `${en.copySuccess} 192.0.2.1` : en.copySuccess); assert.equal(await toast().count(),1);
      assert.equal(await page.locator('.spec-copied, .copied').count(),0);
      if (['registration','uninstall'].includes(kind)) assert.equal(await toast().evaluate(el => !!el.closest('.admin-dialog')),true,'toast remains in its keyboard focus owner');
      await noticeReady();
      await screenshot(page,path.join(out,`copy-${kind}-${success ? 'success':'error'}.png`));
    }
  });
  await check('copy feedback admin pending results cannot follow navigation or a replaced command dialog', async () => {
    for (const kind of ['address','registration','uninstall']) for (const success of [true,false]) {
      await load({controlled:false,openDownload:false});
      await page.evaluate(success => {window.copyHold = true; window.copyReject = !success},success);
      if (kind === 'address') await page.locator('[data-server-id=node-a] .admin-copy-value').first().click();
      else if (kind === 'registration') {
        await page.getByRole('button',{name:en.adminBulkAdd,exact:true}).click();
        await page.waitForFunction(() => document.querySelector('.admin-dialog-edit footer button:last-child')?.disabled === false);
        await page.locator('.admin-dialog-edit footer button').last().click();
      } else {
        await page.locator('[data-server-id=node-a] .action-btns').getByRole('button',{name:en.delete,exact:true}).click();
        await page.locator('.cmd-input-wrapper button').click();
      }
      await page.waitForFunction(() => typeof window.releaseCopy === 'function');
      if (kind === 'address') await page.locator('.admin-nav-item').last().click();
      else {
        await page.locator('.admin-dialog-close').click();
        await page.locator('[role=dialog]').waitFor({state:'hidden'});
        if (kind === 'registration') await page.getByRole('button',{name:en.adminBulkAdd,exact:true}).click();
        else await page.locator('[data-server-id=node-b] .action-btns').getByRole('button',{name:en.delete,exact:true}).click();
      }
      await page.evaluate(() => window.releaseCopy()); await nextFrame();
      assert.equal(await toast().count(),0);
    }
  });
  await check('copy feedback registration controls update the readable command and copy its current value', async () => {
    await load({controlled:false,openDownload:false});
    await page.getByRole('button',{name:en.adminBulkAdd,exact:true}).click();
    const form = page.locator('.admin-registration-form'), button = page.locator('.admin-dialog-edit footer button').last();
    const available = () => page.waitForFunction(() => document.querySelector('.admin-dialog-edit footer button:last-child')?.disabled === false);
    await available();
    await form.locator('.admin-responsive-fields').first().locator('input').fill('Desktop fixture node');
    await form.locator('.admin-responsive-fields').last().locator('input').fill('v9.8.7');
    await available();
    await form.locator('.admin-responsive-fields').last().locator('select').selectOption('__custom__');
    await form.locator('#auto-discovery-custom-proxy').fill('https://fixture-proxy.invalid/');
    await form.locator('#cfg_auto_discovery_auto_update').check();
    await form.locator(':scope > .form-group select').first().selectOption('cfsm-user');
    await available();
    let command = await form.locator('pre').innerText();
    assert.match(command,/v9\.8\.7/); assert.match(command,/fixture-proxy\.invalid/); assert.match(command,/-auto_update=1/); assert.match(command,/Desktop fixture node/);
    await button.click(); assert.equal(await page.evaluate(() => window.copied),command);
    await form.locator('.admin-responsive-fields').first().locator('select').selectOption('windows');
    await available();
    assert.equal(await form.locator(':scope > .form-group select').count(),0,'Linux installation user is not offered on Windows');
    command = await form.locator('pre').innerText(); assert.match(command,/Invoke-WebRequest/); assert.match(command,/-auto_update='1'/);
    await button.click(); assert.equal(await page.evaluate(() => window.copied),command);
    await screenshot(page,path.join(out,'copy-registration-windows-current-command.png'));
    await page.locator('.admin-dialog-close').click(); await page.getByRole('dialog').waitFor({state:'hidden'});
  });
  await check('copy feedback page toast Alt+T and blur restore the prior control like actual Sonner', async () => {
    await load({controlled:false,openDownload:false});
    const prior = page.locator('[data-server-id=node-a] .admin-copy-value').first();
    await prior.click(); await verify(true,`${en.copySuccess} 192.0.2.1`);
    await page.keyboard.press('Alt+KeyT');
    assert.equal(await page.locator('.download-credential-toaster').evaluate(el => document.activeElement === el),true);
    await page.evaluate(() => {
      window.copyFocusTrace = [];
      document.addEventListener('focusin',event => { if (event.target.matches('.admin-copy-value')) window.copyFocusTrace.push('prior'); },true);
    });
    await page.locator('.toolbar-input').focus(); await nextFrame();
    assert.ok((await page.evaluate(() => window.copyFocusTrace)).includes('prior'),'blur must invoke prior-focus restoration, not leave the page consumer behind');
    await page.locator('.download-credential-toaster').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('[role=dialog]').count(),0);
  });
}
