import assert from 'node:assert/strict';
import path from 'node:path';

export async function runLatencyMetadataChecks({a,b,browser,origin,hold,waitHold,receipt,out,metadataOnly,addNodeOnly,stagedOnly,errorsOnly}) {
  const secureOrigin = origin.replace('http:', 'https:');
  await a.db.prepare("UPDATE servers SET history_partition_id=CASE id WHEN 'node-a' THEN 1 ELSE 2 END").run();
  await b.db.prepare("UPDATE servers SET history_partition_id=CASE id WHEN 'node-a' THEN 1 ELSE 2 END").run();
  const cases = metadataOnly || addNodeOnly || stagedOnly || errorsOnly ? [[390,true]] : [360,390,1440,1920].flatMap(width=>[false,true].map(dark=>[width,dark]));
  for (const [width,dark] of cases) {
    receipt.dark = dark;
    const context = await browser.newContext({viewport:{width,height:844}, hasTouch:width<640, isMobile:width<640});
    await context.addInitScript(()=>{
      const fetch=window.fetch;
      window.phase43Reads={active:0,max:0};
      window.fetch=async (url,options)=>{
        const data=options?.body && JSON.parse(options.body), tracked=data && (data.action==='terminal_status' || data.action==='list' && Array.isArray(data.metadataIds));
        if(tracked){window.phase43Reads.active++;window.phase43Reads.max=Math.max(window.phase43Reads.max,window.phase43Reads.active);}
        try{return await fetch(url,options);}finally{if(tracked)window.phase43Reads.active--;}
      };
    });
    const page = await context.newPage();
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const shot = async name => { const file=path.join(out, `phase43-${width}-${dark?'dark':'light'}-${name}.png`); await page.screenshot({path:file}); receipt.screenshots.push(file); };
    let rejectMetadata = '';
    try {
      page.on('pageerror', error => receipt.browserErrors.push(error.message));
      // HTTPS browser admission with unchanged API bytes forwarded to the real local Worker/D1 bridge.
      await context.route('**/*', async route => {
        const url=route.request().url();
        if (new URL(url).origin!==secureOrigin) return route.abort();
        const data=route.request().postDataJSON();
        if (rejectMetadata && data?.action==='list' && Array.isArray(data.metadataIds)) {
          const mode=rejectMetadata; rejectMetadata='';
          if(mode==='network') return route.abort('failed');
          return route.fulfill({status:503,json:{error:'injected_metadata_failure'}});
        }
        const forwarded=url.replace(secureOrigin,origin).replace('/admin?', '/test/fixtures/admin-ui/latency-loading.html?');
        try { const response=await route.fetch({url:forwarded,timeout:0}); await route.fulfill({response}); }
        catch (error) { if (!page.isClosed()) throw error; }
      });
      await page.goto(`${secureOrigin}/admin?native=1&locale=zh#/admin`);
      await page.waitForFunction(() => window.adminState?.().servers.length===2);
      await page.evaluate(dark => document.body.classList.toggle('light', !dark),dark);
      assert.equal(await page.evaluate(() => matchMedia('(pointer:coarse)').matches), width<640);
      if (errorsOnly) {
        const at=Date.now();
        for (const [id,enabled,os] of [['node-a',false,'Ubuntu 24.04.3 LTS'],['node-b',true,'Debian GNU/Linux 13']]) {
          assert.equal((await a.fetch('/update',{method:'POST',cf:{country:'JP'},headers:{...a.agentHeaders(id),'Content-Type':'application/json'},body:JSON.stringify({id,terminal_enabled:enabled,time:{local_ts:at},metrics:{cpu:1,os,ip_v4:'192.0.2.43',timestamp:at}})})).status,200);
        }
        await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
        await page.waitForFunction(()=>window.adminState().terminalStatuses['node-a']?.localEnabled===false && window.phase43Reads.active===0);
        const states = () => page.evaluate(()=>Object.fromEntries(Object.entries(window.adminState().terminalStatuses).map(([id,status])=>[id,status.state])));
        const expected = {'node-a':'local_disabled','node-b':'offline'};
        assert.deepEqual(await states(),expected);
        await page.evaluate(()=>{window.failedMetadataNodes=[...window.adminState().servers];window.adminState().selectedServers=['node-b'];window.adminState().openEditModal(window.adminState().servers[1]);window.adminState().editForm.note='Keep draft after failed metadata';});
        for (const mode of ['http','network']) {
          await page.evaluate(()=>window.adminState().servers.forEach(node=>{node.last_updated=0;}));
          rejectMetadata=mode;
          await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
          assert.equal(rejectMetadata,'','actual metadata request reached the rejecting transport');
          assert.deepEqual(await states(),expected,`${mode} metadata failure does not replace successful terminal statuses`);
          assert.equal(await page.evaluate(()=>window.phase43Reads.active),0);
        }
        // HTTP converts ordinary fetch rejections into result.error. Exercise the separate throwing transport
        // boundary too, which covers failures before HTTP's fetch catch (for example header construction).
        const throwOnce = action => page.evaluate(action=>{
          const http=window.phase43Http, post=http.postByIndex;
          http.postByIndex=function(url,data,...args){
            if(data.action===action && (action!=='list'||Array.isArray(data.metadataIds))){
              http.postByIndex=post;window.transportThrowConsumed=true;
              return Promise.reject(new TypeError('injected transport rejection'));
            }
            return post.call(http,url,data,...args);
          };
          window.transportThrowConsumed=false;
        },action);
        await page.evaluate(()=>window.adminState().servers.forEach(node=>{node.last_updated=0;}));
        await throwOnce('list'); await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
        assert.equal(await page.evaluate(()=>window.transportThrowConsumed),true);
        assert.deepEqual(await states(),expected,'a throwing metadata transport preserves the just-adopted terminal statuses');
        assert.equal(await page.evaluate(()=>window.phase43Reads.active),0);
        await page.waitForFunction(()=>window.adminState().servers.every(node=>node.os && node.last_updated>0),null,{timeout:9000});
        assert.equal(await page.evaluate(()=>window.adminState().servers.every((node,i)=>node===window.failedMetadataNodes[i])),true);
        assert.deepEqual(await page.evaluate(()=>window.adminState().selectedServers),['node-b']);
        assert.equal(await page.evaluate(()=>window.adminState().editForm.note),'Keep draft after failed metadata');
        await throwOnce('terminal_status'); await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
        assert.deepEqual(await states(),{'node-a':'query_failed','node-b':'query_failed'},'terminal transport errors still replace the failed terminal batch');
        await page.waitForFunction(()=>window.adminState().terminalStatuses['node-a']?.state==='local_disabled' && window.adminState().terminalStatuses['node-b']?.state==='offline',null,{timeout:9000});
        assert.equal(await page.evaluate(()=>window.phase43Reads.active),0);
        assert.equal(await page.evaluate(()=>window.phase43Reads.max),1);
        await page.evaluate(()=>{window.adminState().showEditModal=false;}); await frames(); await shot('metadata-error-recovered');
        await page.locator('[data-page=collection]').click();
        await page.locator('.latency-task-name').first().waitFor();
        const reads=receipt.timings.filter(item=>item.action==='terminal_status').length;
        await page.waitForTimeout(5500);
        assert.equal(receipt.timings.filter(item=>item.action==='terminal_status').length,reads,'recovered chain has no leaked hidden timer');
        receipt.checks.push('390 dark: real HTTP503 and fetch rejection preserve successful local-disabled/offline terminal states; throwing HTTP transport does not erase adopted states, next native5s cycle recovers metadata with node/selection/draft preserved; terminal transport throw retains query_failed contract and next cycle recovers; max1 request,0 leaked active reads/hidden timer');
        continue;
      }
      const addNode = async () => {
        await page.getByRole('button',{name:'添加节点',exact:true}).click();
        await page.getByRole('dialog').getByRole('textbox').fill('First report after actual Add');
        await page.getByRole('dialog').getByRole('button',{name:'添加节点',exact:true}).click();
        await page.waitForFunction(()=>window.adminState().servers.length===3);
        await page.getByRole('dialog').locator('.admin-dialog-footer').getByRole('button',{name:'关闭',exact:true}).click();
        const id=await page.evaluate(()=>window.adminState().servers.find(node=>node.name==='First report after actual Add').id);
        const row=page.locator(`.server-row[data-server-id="${id}"]`);
        assert.equal(await page.evaluate(id=>window.adminState().servers.find(node=>node.id===id).last_updated,id),0,'actual Add has no report yet');
        await page.evaluate(id=>{const s=window.adminState();window.addedNode=s.servers.find(node=>node.id===id);s.selectedServers=[id];s.openEditModal(window.addedNode);s.editForm.note='Draft kept through first report';},id);
        const credentials=await (await a.action('node_read_install',{serverId:id})).json();
        assert.ok(credentials.token);
        const start=performance.now(), at=(await (await a.fetch('/test/report-clock?advance=0')).json()).now;
        // A normal report without terminal observations must still update generic metadata.
        const body={id,time:{local_ts:at},metrics:{cpu:1,os:'Alpine Linux 3.22.1',ip_v4:'192.0.2.45',timestamp:at}};
        assert.equal((await a.fetch('/update',{method:'POST',cf:{country:'SG'},headers:{Authorization:`Bearer ${credentials.token}`,'X-CFSM-Server-Id':id,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,200);
        await page.waitForFunction(id=>window.adminState().servers.find(node=>node.id===id)?.os==='Alpine Linux 3.22.1',id,{timeout:14000});
        assert.equal(await page.evaluate(id=>window.adminState().servers.find(node=>node.id===id)===window.addedNode,id),true);
        assert.equal(await page.evaluate(()=>window.adminState().editForm.note),'Draft kept through first report');
        assert.deepEqual(await page.evaluate(()=>window.adminState().selectedServers),[id]);
        assert.equal(await page.evaluate(id=>window.adminState().terminalStatuses[id].credentialEnabled,id),false);
        await page.evaluate(()=>{window.adminState().showEditModal=false;}); await frames();
        await row.locator('.os-icon-img').waitFor();
        assert.equal(await row.locator('.admin-node-os').textContent(),'Alpine Linux 3');
        assert.equal(await row.locator('.admin-country-code').textContent(),'SG');
        assert.ok((await row.textContent()).includes('192.0.2.45'));
        await shot('actual-add-first-report');
        assert.equal(await page.evaluate(()=>window.phase43Reads.max),1,'status/metadata never overlap native frontend requests');
        receipt.timings.push({side:'first-report',width,dark,fixtureReportToAdoptMs:performance.now()-start,terminalObservationSent:false});
        await page.evaluate(()=>{window.adminState().selectedServers=[];});
        assert.equal((await a.action('delete',{id})).status,200); await page.evaluate(()=>window.adminState().loadServers({refresh:true}));
        receipt.checks.push('390 dark: actual Add dialog→authenticated add/token/list→normal first report without terminal observation updates Alpine icon/version/SG flag/country/IP in the same row, preserving selected node and open edit note');
      };
      if (addNodeOnly) { await addNode(); continue; }
      if (!metadataOnly && !stagedOnly) {
        await page.locator('[data-page=collection]').click();
        await page.locator('.latency-task-name').first().waitFor();
        await page.waitForFunction(() => !window.latencyState().loading);
        const names = await page.locator('.latency-task-name').allTextContents();
        await page.evaluate(() => { window.keptLatency = window.latencyState(); });
        await page.locator('[data-page=servers]').click();
        const revisit = hold('a','latency_list');
        await page.locator('[data-page=collection]').click(); await waitHold(revisit); await frames();
        assert.deepEqual(await page.locator('.latency-task-name').allTextContents(), names, 'return keeps already loaded current-site rows while response is held');
        assert.equal(await page.evaluate(() => window.keptLatency===window.latencyState()), true, 'same site retains instance');
        assert.equal(await page.locator('.latency-table thead th').count(),5);
        await shot('revisit-held'); revisit.release(); await page.waitForFunction(() => !window.latencyState().loading);
        if (width===1440 && !dark) {
          const handle=await page.locator('.latency-task-name .drag-handle').first().boundingBox();
          await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2); await page.mouse.down(); await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2+10);
          await page.waitForFunction(() => !!window.latencyState().dragging);
          await page.evaluate(() => {window.adminState().activeTab='servers';}); await page.mouse.up(); await frames();
          assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-server-reordering')),false);
          assert.equal(await page.evaluate(() => window.latencyState().dragging),null);
          await page.locator('[data-page=collection]').click(); await page.waitForFunction(() => !window.latencyState().loading);
          receipt.checks.push('actual fine-pointer latency drag is cancelled when hidden, no retained capture/reorder marker');
        }
        await page.getByRole('button',{name:'添加监控',exact:true}).click();
        await page.getByRole('textbox',{name:'名称',exact:true}).fill('discarded hidden draft');
        await page.evaluate(() => { window.adminState().activeTab='servers'; }); await frames();
        assert.equal(await page.getByRole('dialog').count(),0,'hidden latency draft is closed, including teleported dialog');
        const quietBefore = receipt.timings.filter(item=>item.action==='latency_list').length;
        await a.db.prepare("INSERT OR IGNORE INTO servers(id,name) VALUES('phase43-late','Late registration')").run();
        await page.evaluate(() => window.adminState().loadServers({refresh:true})); await frames();
        assert.equal(receipt.timings.filter(item=>item.action==='latency_list').length,quietBefore,'hidden node membership change does not fetch latency');
        await page.locator('[data-page=collection]').click(); await page.waitForFunction(() => !window.latencyState().loading);
        assert.equal(await page.evaluate(() => window.latencyState().tasks.every(task=>!task.auto_join||task.nodes.includes('phase43-late'))),true,'return reconciles registration while hidden');
        assert.equal(await page.evaluate(() => window.latencyState().draft),null);
        await a.db.prepare("DELETE FROM servers WHERE id='phase43-late'").run();
        await page.evaluate(() => window.adminState().loadServers({refresh:true}));
        await page.waitForFunction(() => !window.latencyState().loading && window.latencyState().tasks.every(task=>!task.nodes.includes('phase43-late')));
        const old = hold('a','latency_list',401);
        await page.locator('.latency-toolbar').getByRole('button',{name:'刷新',exact:true}).click(); await waitHold(old);
        await page.locator('[data-page=servers]').click(); await page.locator('[data-page=collection]').click(); old.release();
        await page.waitForFunction(() => !window.latencyState().loading);
        assert.ok(await page.locator('.latency-task-name').count(),'late hidden 401 does not erase/logout same-site return');
        await page.getByRole('button',{name:'删除监控: '+(await page.evaluate(()=>window.latencyState().tasks[0].name)),exact:true}).click();
        await page.evaluate(() => {window.adminState().activeTab='servers';}); await frames();
        assert.equal(await page.getByRole('dialog').count(),0,'hidden delete confirmation closes');
        if (width===390 && dark) {
          await page.locator('[data-page=collection]').click(); await page.waitForFunction(() => !window.latencyState().loading);
          await page.getByRole('button',{name:'添加监控',exact:true}).click();
          await page.getByRole('textbox',{name:'名称',exact:true}).fill('Hidden save reconciled');
          await page.getByRole('textbox',{name:'目标地址',exact:true}).fill('hidden-save.test:443');
          const saved=hold('a','latency_save');
          await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click(); await waitHold(saved);
          await page.evaluate(()=>{window.adminState().activeTab='servers';});
          await page.locator('[data-page=collection]').click(); saved.release();
          await page.getByText('Hidden save reconciled',{exact:true}).waitFor(); await frames();
          assert.equal(await page.evaluate(()=>window.latencyState().busy),false);
          assert.equal(await page.getByRole('dialog').count(),0);
          assert.equal(await page.locator('[data-latency-success]').count(),0,'late save cannot show hidden-owner feedback');
          const hidden=hold('a','latency_list',401);
          await page.locator('.latency-toolbar').getByRole('button',{name:'刷新',exact:true}).click(); await waitHold(hidden);
          await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
          const quiet=receipt.timings.length; hidden.release(); await frames();
          assert.equal(await page.evaluate(()=>window.latencyState().loading),false);
          await page.waitForTimeout(5500);
          assert.equal(receipt.timings.length,quiet,'visibility boundary leaves both retained latency and node status quiet');
          await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
          await page.waitForFunction(()=>!window.latencyState().loading && !window.latencyState().error);
          await page.locator('[data-page=servers]').click();
          receipt.checks.push('390 dark: held mutation is owned by departed view, return reconciles committed D1 save without old feedback; injected document visibility boundary cancels and remains quiet, foreground refreshes');
        }
        receipt.checks.push(`${width}/${dark}: held revisit retains instance/rows/header, closes draft/delete, hidden membership quiet, registration/delete reconciliation and tab ABA old401 rejected`);
      }
      // Recreate a genuinely pending report, without refreshing the loaded UI list.
      await a.db.prepare('DELETE FROM metrics_history').run();
      await page.evaluate(() => { const s=window.adminState(); s.servers.forEach(node=>{node.last_updated=0;node.os='';node.region='';node.region_override='';node.ip_v4='0';node.ip_v6='0';}); s.activeTab='servers'; window.keptNodes=[...s.servers]; window.keptRows=[...document.querySelectorAll('.server-row')]; s.selectedServers=['node-b']; s.openEditModal(s.servers[1]); s.editForm.name='Unsaved edit'; });
      const pending = hold('a','list');
      await page.evaluate(() => { void window.adminState().refreshTerminalStatuses(); }); await waitHold(pending);
      const at=Date.now();
      for (const [id,terminal,os,region,ip] of [['node-a',false,'Ubuntu 24.04.3 LTS','JP','192.0.2.43'],['node-b',true,'Debian GNU/Linux 13','DE','192.0.2.44']]) {
        const body={id,terminal_enabled:terminal,time:{local_ts:at},metrics:{cpu:1,os,ip_v4:ip,ip_v6:'2001:db8::43',timestamp:at}};
        assert.equal((await a.fetch('/update',{method:'POST',cf:{country:region},headers:{...a.agentHeaders(id),'Content-Type':'application/json'},body:JSON.stringify(body)})).status,200);
      }
      const reporting=hold('a','list'); pending.release(); await waitHold(reporting);
      await page.waitForFunction(()=>window.adminState().terminalStatuses['node-a']?.localEnabled===false,null,{timeout:3000});
      assert.equal(await page.evaluate(()=>window.adminState().servers.every(node=>!node.last_updated)),true,'held metadata has not yet been adopted');
      reporting.release();
      await page.waitForFunction(() => window.adminState().servers.every(node=>node.os && node.last_updated>0),null,{timeout:14000});
      assert.deepEqual(await page.evaluate(() => window.adminState().servers.map(node=>[node.id,node.os,node.region,node.ip_v4])),[['node-a','Ubuntu 24.04.3 LTS','JP','192.0.2.43'],['node-b','Debian GNU/Linux 13','DE','192.0.2.44']]);
      assert.equal(await page.evaluate(() => window.adminState().servers.every((node,i)=>node===window.keptNodes[i])),true,'metadata patches objects, not the list');
      assert.deepEqual(await page.evaluate(() => window.adminState().selectedServers),['node-b']);
      assert.equal(await page.evaluate(() => window.adminState().editForm.name),'Unsaved edit');
      assert.equal(await page.evaluate(() => window.adminState().terminalStatuses['node-a'].localEnabled),false);
      await page.evaluate(() => { window.adminState().showEditModal=false; }); await frames();
      await page.locator('.server-row').first().locator('.os-icon-img').waitFor();
      assert.ok((await page.locator('.server-row').first().locator('.flag-img').getAttribute('src')).endsWith('/jp.svg'));
      assert.equal(await page.locator('.server-row').first().locator('.admin-country-code').textContent(),'JP');
      assert.equal(await page.locator('.server-row').first().locator('.admin-node-os').textContent(),'Ubuntu 24');
      assert.equal(await page.locator('.server-row').first().locator('.admin-node-metadata').getAttribute('title'),'Ubuntu 24.04.3 LTS');
      await shot('first-report-metadata');
      const before=(await (await a.fetch('/test/worker-stats')).json()).queryTrace.length;
      await page.evaluate(() => window.adminState().refreshTerminalStatuses());
      const trace=(await (await a.fetch('/test/worker-stats')).json()).queryTrace.slice(before);
      assert.equal(trace.filter(item=>item.sql.includes('FROM metrics_history')).length,0,'reported rows stop fast metadata reads inside the 30s window');
      receipt.checks.push(`${width}/${dark}: real first HTTP reports patch same node objects, OS icon/version/flag/country/IP visible, terminal-disabled report, selection/edit draft preserved, reported fast metadata reads stop`);
      if (stagedOnly || width===390 && dark) {
        const post=async(id,os,country,ip4,ip6,at)=>a.fetch('/update',{method:'POST',cf:{country},headers:{...a.agentHeaders(id),'Content-Type':'application/json'},body:JSON.stringify({id,time:{local_ts:at},metrics:{cpu:1,os,ip_v4:ip4,ip_v6:ip6,timestamp:at}})});
        let at=Date.now()+1000;
        assert.equal((await post('node-a','Ubuntu 24.04.3 LTS','','0','0',at)).status,200);
        assert.equal((await post('node-b','Debian GNU/Linux 13','DE','0','2001:db8::44',at)).status,200);
        await page.evaluate(()=>{window.adminState().servers.forEach(node=>{node.last_updated=0;node.region='';});});
        await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
        await page.waitForFunction(()=>window.adminState().servers.every(node=>node.last_updated>0));
        assert.equal(await page.evaluate(()=>window.adminState().servers[0].ip_v4),'0');
        at+=1000;
        assert.equal((await post('node-a','Ubuntu 24.04.3 LTS','JP','192.0.2.47','0',at)).status,200);
        const before=receipt.timings.filter(item=>item.action==='list').length;
        // Advance the existing 30s cache/throttle clocks, not add a faster timer or bypass the production request path.
        await a.fetch('/test/report-clock?advance=31000');
        await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+31000;});
        await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
        await page.waitForFunction(()=>window.adminState().servers[0].ip_v4==='192.0.2.47' && window.adminState().servers[0].region==='JP');
        assert.equal(await page.evaluate(()=>window.adminState().servers[0].ip_v6),'0','IPv4-only is a normal final report');
        assert.equal(await page.evaluate(()=>window.adminState().servers[1].ip_v4),'0');
        assert.equal(await page.evaluate(()=>window.adminState().servers[1].ip_v6),'2001:db8::44','IPv6-only is a normal final report');
        assert.equal(receipt.timings.filter(item=>item.action==='list').length,before+1);
        for (let i=0;i<3;i++) await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
        assert.equal(receipt.timings.filter(item=>item.action==='list').length,before+1,'no per-5s infinite missing-family or empty-country fast reads');
        await page.evaluate(()=>{const node=window.adminState().servers[0];node.region_override='CA';node.region='CA';});
        await a.fetch('/test/report-clock?advance=31000'); await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+31000;});
        await page.evaluate(()=>window.adminState().refreshTerminalStatuses());
        assert.equal(await page.evaluate(()=>window.adminState().servers[0].region),'CA','saved manual country override stays ahead of report country');
        assert.deepEqual(await page.evaluate(()=>window.adminState().selectedServers),['node-b']);
        await shot('staged-zero-to-single-stack');
        receipt.checks.push('390 dark: first OS+0/0+empty country does not stop later projection; advanced real 30s cache/throttle accepts delayed IPv4+JP, IPv6-only stays normal, three extra status cycles issue zero metadata requests');
        if(stagedOnly) continue;
      }
      if (width===1440 && dark) {
        await page.evaluate(()=>{window.adminState().servers.forEach(node=>{node.last_updated=0;});});
        const update=hold('a','list'); await page.evaluate(()=>{void window.adminState().refreshTerminalStatuses();}); await waitHold(update);
        const handle=await page.locator('.server-row .drag-handle').first().boundingBox(), target=await page.locator('.server-row').nth(1).boundingBox();
        await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2); await page.mouse.down();
        await page.mouse.move(handle.x+handle.width/2,target.y+target.height-4,{steps:8}); await frames();
        assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-server-reordering')),true);
        const preview=await page.locator('.server-row').evaluateAll(rows=>rows.map(row=>row.dataset.serverId));
        assert.deepEqual(preview,['node-b','node-a']);
        update.release(); await page.waitForFunction(()=>window.adminState().servers.every(node=>node.last_updated>0));
        assert.deepEqual(await page.locator('.server-row').evaluateAll(rows=>rows.map(row=>row.dataset.serverId)),preview,'metadata does not reset active unsaved drag preview');
        assert.equal(await page.evaluate(()=>window.adminState().servers.every((node,i)=>node===window.keptNodes[i])),true);
        assert.equal(await page.evaluate(()=>window.keptRows.every(row=>row.isConnected)),true,'same row elements survive metadata patch');
        await shot('metadata-during-unsaved-drag'); await page.keyboard.press('Escape'); await page.mouse.up();
        assert.deepEqual(await page.locator('.server-row').evaluateAll(rows=>rows.map(row=>row.dataset.serverId)),['node-a','node-b']);
        assert.deepEqual(await page.evaluate(()=>window.adminState().selectedServers),['node-b']);
        receipt.checks.push('1440 dark: actual fine-pointer unsaved node-order preview survives held metadata reply with identical nodes/DOM rows/selection; Escape still cancels order');
      }
      if (width===390 && dark && !metadataOnly) {
        await addNode();
        // A late first-report reply must not cross site generations, even when the API index returns to A.
        await page.evaluate(()=>{window.adminState().servers.forEach(node=>{node.last_updated=0;});});
        const oldA=hold('a','list',401); await page.evaluate(()=>{void window.adminState().refreshTerminalStatuses();}); await waitHold(oldA);
        const post=async (h,id,os,country)=>{
          const {latest}=await h.db.prepare('SELECT MAX(timestamp) AS latest FROM metrics_history WHERE server_id=?').bind(id).first();
          const reportAt=Math.max((await (await h.fetch('/test/report-clock?advance=0')).json()).now,Number(latest || 0)+1000);
          return h.fetch('/update',{method:'POST',cf:{country},headers:{...h.agentHeaders(id),'Content-Type':'application/json'},body:JSON.stringify({id,time:{local_ts:reportAt},metrics:{cpu:1,os,ip_v4:'192.0.2.99',timestamp:reportAt}})});
        };
        assert.equal((await post(b,'node-a','macOS 15.4','US')).status,200);
        await page.evaluate(()=>{const s=window.adminState();s.selectedApiIndex=1;void s.switchAdminSite();});
        await page.waitForFunction(()=>!window.adminState().adminSiteLoading && window.adminState().servers.find(node=>node.id==='node-a')?.os==='macOS 15.4');
        assert.equal(await page.evaluate(()=>window.adminState().terminalStatuses['node-a'].state),'terminal_origin_denied','remote site terminal remains forbidden while its metadata works');
        await shot('site-b-metadata');
        assert.equal((await post(a,'node-a','Windows Server 2025','FR')).status,200);
        await a.fetch('/test/report-clock?advance=31000'); await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+31000;});
        await page.evaluate(()=>{const s=window.adminState();s.selectedApiIndex=0;void s.switchAdminSite();});
        await page.waitForFunction(()=>!window.adminState().adminSiteLoading);
        oldA.release(); await page.waitForFunction(()=>window.adminState().servers.find(node=>node.id==='node-a')?.os==='Windows Server 2025');
        assert.equal(await page.evaluate(()=>window.adminState().servers.find(node=>node.id==='node-a').region),'FR');
        assert.ok(await page.locator('.admin-ui').count());
        // Metadata and status share cancellation at tab leave and component unmount.
        await page.evaluate(()=>{window.adminState().servers.forEach(node=>{node.last_updated=0;});});
        const late=hold('a','list',401); await page.evaluate(()=>{void window.adminState().refreshTerminalStatuses();}); await waitHold(late);
        await page.locator('[data-page=collection]').click(); late.release(); await page.locator('.latency-task-name').first().waitFor();
        const statusBefore=receipt.timings.filter(item=>item.action==='terminal_status').length;
        await page.waitForTimeout(5500); assert.equal(receipt.timings.filter(item=>item.action==='terminal_status').length,statusBefore);
        const catalog=hold('a','latency_list'); await page.locator('.latency-toolbar').getByRole('button',{name:'刷新',exact:true}).click(); await waitHold(catalog);
        await page.evaluate(()=>window.adminState().router.push('/')); await page.locator('#outside-admin').waitFor(); catalog.release(); await frames();
        assert.equal(await page.locator('.latency-page').count(),0);
        receipt.checks.push('390 dark: real SiteB remote metadata with terminal admission denied, A→B→A generations reject late401, metadata/status cancel on tab leave, no hidden status timer, real router unmount cancels held latency read');
      }
      assert.equal(await page.evaluate(() => matchMedia('(pointer:coarse)').matches),width<640);
    } catch (error) { await shot('failure'); throw error; }
    finally { await context.close(); }
  }
}
