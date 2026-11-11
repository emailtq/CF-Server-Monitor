import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, controls, openPair, until } from './terminal-harness.js';
import { addServerColumns } from '../src/database/updateDatabase.js';
import { clearServersListCache, getServerDetail } from '../src/utils/cache.js';
import { handleUpdate } from '../src/handlers/update.js';
import { saveSiteOptions, clearSiteSettingsCache } from '../src/utils/settings.js';
import { saveTerminalObservation } from '../src/database/terminal.js';

const secret = 'test-report-secret';
let sampleSequence = 0;
const report = (enabled, at = Date.now(), extra = {}) => ({id:'node-a', secret,
  ...(enabled === undefined ? {} : {terminal_enabled:enabled}),
  time:{local_ts:at}, metrics:{cpu:'1', timestamp:Date.now() - 3600000 + (++sampleSequence * 1000)}, ...extra});
const post = (h, body) => h.fetch('/update', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
const status = async h => (await h.action('terminal_status', {serverId:'node-a'})).json();
const row = h => h.db.prepare("SELECT * FROM servers WHERE id = 'node-a'").first();
async function setup() {
  const h = await harness();
  await addServerColumns(h.db);
  await h.db.prepare("UPDATE servers SET history_partition_id=CASE id WHEN 'node-a' THEN 1 ELSE 2 END").run();
  await saveSiteOptions(h.db, {wss_report_enabled:'true'});
  clearServersListCache();
  return h;
}
async function send(peer, body) {
  const count = peer.messages.length;
  peer.ws.send(JSON.stringify({type:'update', payload:body}));
  await until(() => controls(peer).slice(count).some(frame => frame.type === 'ack' || frame.type === 'error'));
  return controls(peer).slice(count).find(frame => frame.type === 'ack' || frame.type === 'error');
}
async function broadcasterBinding(h) {
  const namespace = await h.mf.getDurableObjectNamespace('METRICS_BROADCASTER');
  return {idFromName:id=>namespace.idFromName(id),get:id=>({async fetch(request, options) {
    const stub=namespace.get(id);
    // Miniflare's Node bridge uses its own Request class, unlike Worker bindings.
    if (typeof request==='string') return stub.fetch(request,options);
    return stub.fetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()});
  }})};
}

test('nullable local observation migration is repeatable and preserves legacy data', async () => {
  const h = await harness();
  try {
    for (const field of ['terminal_local_enabled','terminal_local_observed_at','terminal_local_report_at']) {
      await h.db.prepare(`ALTER TABLE servers DROP COLUMN ${field}`).run();
    }
    assert.equal((await addServerColumns(h.db)).success, true);
    assert.equal((await row(h)).terminal_local_enabled, null);
    await h.db.prepare("UPDATE servers SET terminal_local_enabled=0, terminal_local_observed_at=123, terminal_local_report_at=122 WHERE id='node-a'").run();
    assert.equal((await addServerColumns(h.db)).added, 0);
    const server = await row(h);
    assert.equal(server.name, 'node-a');
    assert.equal(server.terminal_local_enabled, 0);
    assert.equal(server.terminal_local_observed_at, 123);
  } finally {await h.dispose();}
});

test('interleaved HTTP/WSS same-value watermarks reject stale inverse observations from the other transport', async () => {
  const h = await setup();
  try {
    const at=Date.now(), peer=await h.socket('/update');
    const env={DB:h.db,API_SECRET:secret,METRICS_BROADCASTER:await broadcasterBinding(h)};
    const pending=[];
    const direct=async body=>{
      const result=await handleUpdate(new Request('https://example.com/update',{method:'POST',body:JSON.stringify(body)}),env,{waitUntil(promise) {pending.push(promise);}});
      await Promise.all(pending.splice(0));
      return result;
    };
    assert.equal((await direct(report(false,at))).status,200);
    await send(peer,report(false,at+40));
    assert.equal((await direct(report(true,at+20))).status,200);
    assert.equal((await status(h)).localEnabled,false);
    assert.equal((await post(h,report(true,at+60))).status,200);
    assert.equal((await post(h,report(true,at+100))).status,200);
    await send(peer,report(false,at+80));
    assert.equal((await status(h)).localEnabled,true);
    assert.notEqual((await h.fetch('/terminal-observation',{method:'POST',headers:{'X-CFSM-Terminal-Context':'forged'},body:JSON.stringify(report(false,at+120))})).status,200);
    assert.notEqual((await h.fetch('/__do/terminal-observation',{method:'POST',body:JSON.stringify(report(false,at+120))})).status,200);
    assert.equal((await status(h)).localEnabled,true);
  } finally {await h.dispose();}
});

test('failed local false notification is retried by the identical false report and never changes credentials', async () => {
  const h=await setup();
  try {
    const control=await h.control(), pair=await openPair(h,control);
    const credential=await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    let calls=0;
    const env={DB:h.db, TERMINAL_BROKER:{idFromName:id=>id,get:()=>({fetch:async request=>{
      calls++;
      if (calls<=2) return new Response('unavailable',{status:503});
      return h.fetch('/test/internal?op=local-disable',{headers:request.headers});
    }})}};
    const at=Date.now(), server=await row(h), data=report(false,at);
    await assert.rejects(saveTerminalObservation(env,server,data,at,at),/terminal_local_disable_unavailable/);
    assert.equal((await row(h)).terminal_local_enabled,0);
    const denied=await status(h);
    assert.equal(denied.enabled,false);
    assert.equal(denied.connected,true);
    assert.equal(denied.supported,true);
    assert.equal(denied.activeCount,1);
    assert.equal((await h.action('terminal_renew',{serverId:'node-a',sessionId:pair.session.sessionId})).status,403);
    await assert.rejects(saveTerminalObservation(env,server,data,at,at+1),/terminal_local_disable_unavailable/);
    assert.equal(calls,2);
    await saveTerminalObservation(env,server,report(false,at+1),at,at+2);
    assert.equal(calls,3);
    await until(()=>pair.browser.ws.readyState!==1 && pair.agent.ws.readyState!==1);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(),credential);
  } finally {await h.dispose();}
});

test('same-value receipts use minute heartbeats and a stale/future source watermark has a bounded recovery path', async () => {
  const h=await setup();
  try {
    const at=Date.now(), peer=await h.socket('/update');
    await send(peer,report(false,at));
    const before=await row(h);
    await send(peer,report(false,at+1));
    assert.equal((await row(h)).terminal_local_observed_at,before.terminal_local_observed_at);
    const {now}=await (await h.fetch('/test/report-clock?advance=61000')).json();
    await send(peer,report(false,now));
    assert.ok((await row(h)).terminal_local_observed_at>=before.terminal_local_observed_at+60000);
    const writes=(await (await h.fetch('/test/report-stats')).json()).metadataWrites;
    assert.equal(writes,2);
    // An earlier source clock is not allowed to flip a fresh observation.
    await send(peer,report(true,now-1000));
    assert.equal((await row(h)).terminal_local_enabled,0);
    await h.fetch('/test/report-rebuild');
    const later=await (await h.fetch('/test/report-clock?advance=300000')).json();
    await send(peer,report(true,later.now-1000));
    assert.equal((await row(h)).terminal_local_enabled,1);
    // An implausibly future report never poisons the accepted watermark.
    await send(peer,report(false,later.now+86400000));
    assert.equal((await row(h)).terminal_local_enabled,1);
  } finally {await h.dispose();}
});

test('central observation failure retries, independent nodes progress, and bounded queues clean up', async () => {
  const h=await setup();
  try {
    const binding=await broadcasterBinding(h);
    const internal=data=>binding.get(binding.idFromName('global')).fetch(new Request('https://metrics.internal/terminal-observation',{method:'POST',body:JSON.stringify(data)}));
    const at=Date.now();
    await h.fetch('/test/report-fail?node=node-a&count=1');
    assert.equal((await internal({id:'node-a',terminal_enabled:false,report_at:at})).status,503);
    assert.equal((await internal({id:'node-a',terminal_enabled:false,report_at:at})).status,200);
    assert.equal((await (await h.fetch('/test/report-stats')).json()).queues,0);
    assert.equal((await internal({id:'node-a',terminal_enabled:true,report_at:at+5})).status,200);
    await h.fetch('/test/report-pause?node=node-a');
    const waiting=Array.from({length:8},(_,i)=>internal({id:'node-a',terminal_enabled:false,report_at:at+10+i}));
    await until(async ()=>(await (await h.fetch('/test/report-stats')).json()).notificationPending);
    assert.equal((await internal({id:'node-a',terminal_enabled:false,report_at:at+40})).status,503);
    assert.equal((await internal({id:'node-b',terminal_enabled:true,report_at:at+40})).status,200);
    assert.equal((await h.db.prepare("SELECT terminal_local_enabled FROM servers WHERE id='node-b'").first()).terminal_local_enabled,1);
    await h.fetch('/test/report-release');
    assert.ok((await Promise.all(waiting)).every(result=>result.status===200));
    const stats=await (await h.fetch('/test/report-stats')).json();
    assert.equal(stats.queues,0);
    assert.equal(stats.observations,2);
  } finally {await h.fetch('/test/report-release');await h.dispose();}
});

test('HTTP forwards only validated metadata in a fresh minimal internal request, never external headers or secrets', async () => {
  const h=await setup();
  try {
    const binding=await broadcasterBinding(h), seen=[], pending=[];
    const env={DB:h.db,API_SECRET:secret,METRICS_BROADCASTER:{idFromName:id=>binding.idFromName(id),get:id=>({async fetch(request,options) {
      if (typeof request!=='string') seen.push({url:request.url,headers:Object.fromEntries(request.headers),body:await request.clone().json()});
      return binding.get(id).fetch(request,options);
    }})}};
    const direct=async body=>{
      const result=await handleUpdate(new Request('https://example.com/update',{method:'POST',headers:{Cookie:'forged','X-CFSM-Terminal-Context':'forged',Authorization:'Bearer forged'},body:JSON.stringify(body)}),env,{waitUntil(p){pending.push(p);}});
      await Promise.all(pending.splice(0));return result;
    };
    assert.equal((await direct(report(true))).status,200);
    assert.equal(seen.length,1);
    assert.deepEqual(Object.keys(seen[0].body).sort(),['id','report_at','terminal_enabled']);
    assert.deepEqual(seen[0].headers,{'content-type':'application/json'});
    assert.equal(JSON.stringify(seen).includes(secret),false);
    assert.equal((await direct(report('true'))).status,400);
    assert.equal((await direct(report(true,Date.now(),{secret:'wrong'}))).status,401);
    assert.equal((await direct(report(undefined))).status,200);
    assert.equal(seen.length,1);
    await saveSiteOptions(h.db,{is_public:'true'});
    const publicResponse=await h.fetch('/api/servers');
    assert.equal(publicResponse.status,200);
    const publicList=await publicResponse.json();
    assert.equal(JSON.stringify(publicList).includes('terminal_local_'),false);
  } finally {await h.dispose();}
});

test('a once-future watermark expires so a plausible regressed clock can recover without a credential write', async () => {
  const h=await setup();
  try {
    const server=await row(h),at=Date.now(),env={DB:h.db};
    await saveTerminalObservation(env,server,report(false,at+59000),at,at);
    await saveTerminalObservation(env,server,report(true,at+58000),at,at+1000);
    assert.equal((await row(h)).terminal_local_enabled,0);
    await saveTerminalObservation(env,server,report(true,at+58000),at,at+241001);
    assert.equal((await row(h)).terminal_local_enabled,1);
    assert.equal((await row(h)).terminal_local_report_at,at+58000);
    assert.equal((await h.db.prepare("SELECT credential_version FROM terminal_nodes WHERE server_id='node-a'").first()).credential_version,1);
  } finally {await h.dispose();}
});

test('delayed local false notification cannot close a new authenticated control generation after reinstall', async () => {
  const h=await setup();
  let delayed;
  try {
    await h.control();
    const at=Date.now(),server=await row(h);
    await saveTerminalObservation({DB:h.db},server,report(false,at),at,at);
    await h.fetch('/test/pause-local-observation');
    delayed=h.fetch('/test/internal?op=local-disable',{headers:{'X-CFSM-Terminal-Context':JSON.stringify({serverId:'node-a',observedAt:at,reportAt:at})}});
    await until(async ()=>(await (await h.fetch('/test/local-observation-pending')).json()).pending);
    assert.equal((await post(h,report(true,at+1))).status,200);
    const issued=await (await h.action('terminal_prepare_install',{serverId:'node-a',terminal:true,acceptRisk:true})).json();
    h.nodes['node-a']=issued;
    const current=await h.control();
    await h.fetch('/test/release-local-observation');
    assert.equal((await delayed).status,200);
    assert.equal(current.ws.readyState,1);
    assert.equal((await status(h)).connected,true);
    assert.equal((await h.db.prepare("SELECT credential_version FROM terminal_nodes WHERE server_id='node-a'").first()).credential_version,issued.version);
  } finally {await h.fetch('/test/release-local-observation');if(delayed) await delayed;await h.dispose();}
});

test('a failed withdrawal denies renewals immediately and existing forwarding expires with its bounded lease', async () => {
  const h=await setup();
  try {
    const control=await h.control(),pair=await openPair(h,control);
    await until(()=>controls(pair.agent).some(frame=>frame.type==='start'));
    pair.agent.ws.send('{"type":"ready"}');
    await until(()=>controls(pair.browser).some(frame=>frame.type==='ready'));
    const server=await row(h),at=Date.now();
    const env={DB:h.db,TERMINAL_BROKER:{idFromName:id=>id,get:()=>({fetch:async()=>new Response('failed',{status:503})})}};
    await assert.rejects(saveTerminalObservation(env,server,report(false,at),at,at));
    assert.equal((await h.action('terminal_renew',{serverId:'node-a',sessionId:pair.session.sessionId})).status,403);
    await h.fetch('/test/clock?advance=61000');
    pair.browser.ws.send(new Uint8Array([99]));
    await until(()=>pair.browser.ws.readyState!==1);
    assert.equal(pair.agent.messages.some(frame=>typeof frame!=='string'),false);
  } finally {await h.dispose();}
});

test('HTTP strict bool, unauthorized and no-metrics reports have no metadata or discovery side effects', async () => {
  const h = await setup();
  try {
    await saveSiteOptions(h.db, {auto_discovery:'true'});
    for (const value of ['true','false',1,0,{},[],null]) {
      assert.equal((await post(h, report(value))).status, 400);
      assert.equal((await post(h, report(value, Date.now(), {id:'',name:'invalid-discovery'}))).status, 400);
    }
    assert.equal((await post(h, report(true, Date.now(), {secret:'wrong'}))).status, 401);
    assert.equal((await post(h, {id:'node-a',secret,terminal_enabled:true})).status, 400);
    assert.equal((await row(h)).terminal_local_enabled, null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count, 2);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count, 0);
  } finally {await h.dispose();}
});

test('HTTP true/false observation stays separate from credentials, legacy and public/import/export configuration', async () => {
  const h = await setup();
  try {
    assert.equal((await status(h)).localEnabled, null);
    const credential = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    const at = Date.now();
    assert.equal((await post(h, report(true, at))).status, 200);
    let current = await status(h);
    assert.equal(current.localEnabled, true);
    assert.equal(current.credentialEnabled, true);
    assert.equal(current.enabled, true);
    assert.equal(current.connected, false);
    assert.equal(current.supported, false);
    assert.equal(current.localObservationFresh, true);
    assert.ok(current.localObservedAt >= at);
    assert.equal((await post(h, report(false, at + 1))).status, 200);
    current = await status(h);
    assert.equal(current.localEnabled, false);
    assert.equal(current.credentialEnabled, true);
    assert.equal(current.enabled, false);
    assert.equal(current.state, 'local_disabled');
    assert.equal((await post(h, report(undefined, at + 2))).status, 200);
    assert.equal((await status(h)).localEnabled, false);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), credential);
    const batch = await (await h.action('terminal_status', {serverIds:['node-a','node-b']})).json();
    assert.equal(batch.nodes['node-a'].localEnabled, false);
    assert.equal(batch.nodes['node-b'].localEnabled, null);
    const backup = await (await h.action('export_servers')).json();
    assert.equal(JSON.stringify(backup).includes('terminal_local_'), false);
    assert.equal(JSON.stringify(current).includes(credential.token_hash), false);
    assert.equal(Object.hasOwn(current,'token_ciphertext'),false);
    if (credential.token_ciphertext) assert.equal(JSON.stringify(current).includes(credential.token_ciphertext), false);
    assert.equal((await h.action('import_servers', {servers:[{id:'node-a',name:'node-a',terminal_local_enabled:1}]})).status, 200);
    assert.equal((await row(h)).terminal_local_enabled, 0);
  } finally {await h.dispose();}
});

test('true reports never create, rotate or revive terminal authority, and cannot authenticate control', async () => {
  const h = await setup();
  try {
    await h.db.prepare("DELETE FROM terminal_nodes WHERE server_id='node-a'").run();
    assert.equal((await post(h, report(true))).status, 200);
    assert.equal((await status(h)).credentialEnabled, false);
    assert.equal((await status(h)).enabled, false);
    assert.equal(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), null);
    assert.equal((await h.socket('/api/agent/terminal/control', {Authorization:`Bearer ${secret}`, 'X-CFSM-Server-Id':'node-a'})).response.status, 401);
    await h.db.prepare("UPDATE terminal_nodes SET enabled=0 WHERE server_id='node-b'").run();
    const before = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-b'").first();
    assert.equal((await post(h, report(true, Date.now(), {id:'node-b'}))).status, 200);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-b'").first(), before);
    const revoked = await (await h.action('terminal_status',{serverId:'node-b'})).json();
    assert.equal(revoked.localEnabled, true);
    assert.equal(revoked.state, 'revoked');
    assert.equal((await h.action('terminal_status', {serverId:'node-a'}, {headers:{Cookie:''}})).status, 401);
    await saveSiteOptions(h.db,{terminal_enabled:'false',wss_report_enabled:'false'});
    assert.equal((await post(h,report(true,Date.now()+1,{id:'node-b'}))).status,200);
    assert.equal((await (await h.action('terminal_status',{serverId:'node-b'})).json()).state,'terminal_disabled');
    const options=JSON.parse((await h.db.prepare("SELECT value FROM settings WHERE key='site_options'").first()).value);
    assert.equal(options.terminal_enabled,'false');
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-b'").first(),before);
  } finally {await h.dispose();}
});

test('real WSS common handler rejects malformed/unauth/no-metrics before observation writes', async () => {
  const h = await setup();
  try {
    for (const value of ['true','false',1,0,{},[],null]) {
      const peer = await h.socket('/update');
      const frame = await send(peer, report(value));
      assert.equal(frame.code, 400);
    }
    const unauthorized = await h.socket('/update');
    assert.equal((await send(unauthorized, report(true,Date.now(),{secret:'wrong'}))).code, 401);
    const empty = await h.socket('/update');
    assert.equal((await send(empty,{id:'node-a',secret,terminal_enabled:true})).code, 400);
    assert.equal((await row(h)).terminal_local_enabled, null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count, 0);
  } finally {await h.dispose();}
});

test('WSS local false is prompt during history throttle and closes existing input without revoking credentials', async () => {
  const h = await setup();
  try {
    const control = await h.control();
    assert.equal((await status(h)).localEnabled, null);
    assert.equal((await status(h)).enabled, true);
    const pair = await openPair(h,control);
    await until(() => controls(pair.agent).some(frame=>frame.type==='start'));
    pair.agent.ws.send('{"type":"ready"}');
    await until(() => controls(pair.browser).some(frame=>frame.type==='ready'));
    const credential = await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first();
    const peer = await h.socket('/update');
    const at = Date.now();
    assert.equal((await send(peer,report(true,at))).persisted, true);
    for (let i=1;i<=12;i++) assert.equal((await send(peer,report(true,at+i))).persisted, false);
    assert.equal((await (await h.fetch('/test/report-stats')).json()).metadataWrites, 1);
    assert.equal((await send(peer,report(false,at+20))).persisted, false);
    assert.equal((await status(h)).state, 'local_disabled');
    await until(() => pair.browser.ws.readyState !== 1 && pair.agent.ws.readyState !== 1);
    assert.equal((await h.action('terminal_open',{serverId:'node-a',clientRequestId:'disabled',cols:80,rows:24})).status,403);
    assert.deepEqual(await h.db.prepare("SELECT * FROM terminal_nodes WHERE server_id='node-a'").first(), credential);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count,1);
    assert.equal((await (await h.fetch('/test/report-stats')).json()).metadataWrites,2);
    assert.equal((await send(peer,report(undefined,at+21))).persisted,false);
    assert.equal((await status(h)).localEnabled,false);
  } finally {await h.dispose();}
});

test('stale/order/duplicate observations cannot override newer D1 state, cached equality bounds writes and freshness is honest', async () => {
  const h = await setup();
  try {
    const at=Date.now();
    const env={DB:h.db,API_SECRET:secret,METRICS_BROADCASTER:await broadcasterBinding(h)};
    const pending=[];
    const ctx={waitUntil(promise) {pending.push(promise);}};
    const direct = async body => {
      const result=await handleUpdate(new Request('https://example.com/update',{method:'POST',body:JSON.stringify(body)}),env,ctx);
      await Promise.all(pending.splice(0));
      return result;
    };
    assert.equal((await direct(report(true,at))).status,200);
    assert.equal((await getServerDetail(h.db,'node-a',true)).terminal_local_enabled,1);
    assert.equal((await post(h,report(false,at+20))).status,200);
    assert.equal((await direct(report(true,at+10))).status,200);
    assert.equal((await row(h)).terminal_local_enabled,0);
    assert.equal((await direct(report(true,at+20))).status,200);
    assert.equal((await row(h)).terminal_local_enabled,0);
    const before=await row(h);
    assert.equal((await post(h,report(true,at+30,{time:{local_ts:at-600000}}))).status,200);
    assert.equal((await row(h)).terminal_local_enabled,0);
    assert.equal((await row(h)).terminal_local_observed_at,before.terminal_local_observed_at);
    await h.db.prepare("UPDATE servers SET terminal_local_observed_at=?, terminal_local_report_at=? WHERE id='node-a'").bind(at-600000,at-600000).run();
    const stale=await status(h);
    assert.equal(stale.localEnabled,false);
    assert.equal(stale.localObservationFresh,false);
    assert.equal(stale.enabled,false);
    assert.equal((await post(h,report(true,at+40))).status,200);
    assert.equal((await status(h)).localObservationFresh,true);
    clearSiteSettingsCache();
  } finally {await h.dispose();}
});
