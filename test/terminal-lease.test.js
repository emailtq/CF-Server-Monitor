import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, until, controls, openPair } from './terminal-harness.js';
import { handleTerminalAdminAction } from '../src/handlers/terminal.js';
import { loadSiteSettings, clearSiteSettingsCache } from '../src/utils/settings.js';
import { TerminalBroker } from '../src/durable/TerminalBroker.js';
import worker from '../src/index.js';

const snapshot = async h => (await h.fetch('/test/snapshot')).json();
async function running(h, control) {
  const p = await openPair(h, control);
  await until(() => controls(p.agent).some(f => f.type === 'start'));
  p.agent.ws.send('{"type":"ready"}');
  await until(() => controls(p.browser).some(f => f.type === 'ready'));
  return p;
}
const renew = (h, p, options) => h.action('terminal_renew', {serverId:'node-a', sessionId:p.session.sessionId}, options);

test('60s lease expiry alarm and constructor both close peers; failed close audit still releases capacity', async () => {
  for (const operation of ['alarm', 'rebuild']) {
    const h = await harness();
    try {
      const control = await h.control(), p = await running(h, control);
      await h.fetch('/test/fail-audit');
      await h.fetch('/test/clock?advance=60001');
      await h.fetch('/test/' + operation);
      await until(() => p.browser.ws.readyState !== 1 && p.agent.ws.readyState !== 1);
      assert.equal((await snapshot(h)).meta.sessions.length, 0);
      assert.equal((await snapshot(h)).alarm, null, operation);
    } finally { await h.dispose(); }
  }
});

test('renewal checks owner Cookie, Origin, fresh authority and control; only valid renewal extends lease', async () => {
  const h = await harness();
  try {
    const p = await running(h, await h.control());
    const before = (await snapshot(h)).meta.sessions[0].leaseUntil;
    await h.fetch('/test/clock?advance=45000');
    for (const headers of [{Origin:'https://evil.example'}, {Cookie:`cfsm_auth=${encodeURIComponent(h.otherToken)}`}, {Cookie:'',Authorization:`Bearer ${h.token}`}]) {
      assert.notEqual((await renew(h,p,{headers})).status, 200);
      assert.equal((await snapshot(h)).meta.sessions[0].leaseUntil, before);
    }
    assert.equal((await renew(h,p)).status, 200);
    assert.ok((await snapshot(h)).meta.sessions[0].leaseUntil > before + 40000);
    await h.fetch('/test/rebuild');
    await h.fetch('/test/clock?advance=16000');
    await h.fetch('/test/alarm');
    assert.equal(p.browser.ws.readyState, 1);
    p.browser.ws.send(new Uint8Array([1]));
    await until(() => p.agent.messages.some(m => typeof m !== 'string'));
    assert.equal(controls(p.agent).filter(f => f.type === 'start').length, 1);
  } finally { await h.dispose(); }
});

for (const mutation of ['logout', 'site', 'node', 'rotate', 'delete', 'jwt']) {
  test(`${mutation} authority prevents renew and bounds surviving sessions to their old 60s lease`, async () => {
    const h = await harness();
    try {
      const p = await running(h, await h.control());
      if (mutation === 'logout') assert.equal((await h.action('logout')).status,200);
      if (mutation === 'site') await h.db.prepare(`UPDATE settings SET value = json_set(value, '$.terminal_enabled', 'false') WHERE key = 'site_options'`).run();
      if (mutation === 'node') await h.db.prepare("UPDATE terminal_nodes SET enabled=0 WHERE server_id='node-a'").run();
      if (mutation === 'rotate') await h.db.prepare("UPDATE terminal_nodes SET credential_version = 2 WHERE server_id='node-a'").run();
      if (mutation === 'delete') await h.db.prepare("DELETE FROM servers WHERE id='node-a'").run();
      if (mutation === 'jwt') await h.db.prepare(`UPDATE settings SET value = json_set(value, '$.jwt_secret', ?) WHERE key='site_options'`).bind('k'.repeat(64)).run();
      const oldLease = (await snapshot(h)).meta.sessions[0].leaseUntil;
      assert.notEqual((await renew(h,p)).status, 200);
      const current = (await snapshot(h)).meta.sessions[0];
      if (current) assert.equal(current.leaseUntil,oldLease);
      await h.fetch('/test/clock?advance=60001');
      await h.fetch('/test/rebuild');
      await h.fetch('/test/alarm');
      await until(() => p.agent.ws.readyState !== 1 && p.browser.ws.readyState !== 1);
      assert.equal((await snapshot(h)).meta.sessions.length,0);
      if (mutation === 'logout') assert.equal((await h.action('terminal_status',{serverId:'node-a'})).status,401);
    } finally {await h.dispose();}
  });
}

test('output/ACK/ping/renew never reset user idle; valid input and resize alone refresh it', async () => {
  const h = await harness();
  try {
    const control = await h.control(), p = await running(h,control);
    const activity = (await snapshot(h)).attachments.find(a => a.role === 'browser').lastUserActivity;
    assert.ok(activity > 0);
    for (let i=1;i<=44;i++) {
      await h.fetch('/test/clock?advance=40000');
      assert.equal((await renew(h,p)).status,200);
      p.agent.ws.send(new Uint8Array([1]));
      await until(() => p.browser.messages.filter(m => typeof m !== 'string').length === i);
      p.browser.ws.send(JSON.stringify({type:'ack',bytes:i}));
      p.browser.ws.send('{"type":"ping"}');
      await until(() => controls(p.agent).some(f => f.type==='ack' && f.bytes===i));
      assert.equal((await snapshot(h)).attachments.find(a=>a.role==='browser').lastUserActivity,activity);
      await h.fetch('/test/alarm');
    }
    await h.fetch('/test/rebuild');
    await h.fetch('/test/clock?advance=40001');
    await h.fetch('/test/alarm');
    await until(()=>p.agent.ws.readyState!==1);
    // Close and notification arrive on different WebSockets, with no cross-socket order.
    await until(()=>controls(control).some(f=>f.sessionId===p.session.sessionId && f.reason==='user_idle'));
    assert.ok(controls(control).some(f=>f.sessionId===p.session.sessionId && f.reason==='user_idle'));
    const next = await running(h,control);
    const before = (await snapshot(h)).attachments.find(a=>a.sessionId===next.session.sessionId && a.role==='browser').lastUserActivity;
    await h.fetch('/test/clock?advance=10000');
    next.browser.ws.send(new Uint8Array([1]));
    await until(()=>next.agent.messages.some(m=>typeof m!=='string'));
    const after = (await snapshot(h)).attachments.find(a=>a.role==='browser').lastUserActivity;
    assert.ok(after >= before+10000);
    await h.fetch('/test/clock?advance=10000');
    next.browser.ws.send('{"type":"resize","cols":1,"rows":500}');
    await until(()=>controls(next.agent).some(f=>f.type==='resize'));
    assert.ok((await snapshot(h)).attachments.find(a=>a.role==='browser').lastUserActivity >= after+10000);
  } finally {await h.dispose();}
});

test('D1 renewal outage, delayed revoke, and generation replacement cannot grant a stale renewal', async () => {
  const h = await harness();
  try {
    const p = await running(h,await h.control());
    const sys=await loadSiteSettings(h.db,true);
    const request=new Request('https://example.com/admin/api',{headers:{Origin:'https://example.com',Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
    const data={action:'terminal_renew',serverId:'node-a',sessionId:p.session.sessionId};
    const unavailable={DB:{prepare(){throw new Error('test D1 outage');}}};
    assert.equal((await handleTerminalAdminAction({request,env:unavailable,sys,data})).status,503);
    for (const mutation of ['owner', 'node', 'generation']) {
      const env={DB:h.db,TERMINAL_BROKER:{idFromName:id=>id,get:()=>({async fetch(req) {
        if (mutation==='owner') await h.db.prepare('UPDATE terminal_auth_sessions SET revoked_at=?').bind(Date.now()).run();
        if (mutation==='node') await h.db.prepare("UPDATE terminal_nodes SET enabled=0 WHERE server_id='node-a'").run();
        if (mutation==='generation') await h.control();
        return h.fetch('/test/internal?op=renew',{headers:Object.fromEntries(req.headers)});
      }})}};
      assert.notEqual((await handleTerminalAdminAction({request,env,sys,data})).status,200);
      await h.db.prepare('UPDATE terminal_auth_sessions SET revoked_at=NULL').run();
      await h.db.prepare("UPDATE terminal_nodes SET enabled=1 WHERE server_id='node-a'").run();
    }
  } finally {await h.dispose();}
});

test('seven-day audit and expired JWT retention use D1 expiry indexes, exact ms/seconds boundaries and existing hourly cron', async () => {
  const h=await harness();
  try {
    const now=2000000000123, cutoff=1999395200123;
    await h.db.prepare('DELETE FROM terminal_auth_sessions').run();
    for (const [jti,expires] of [['old',1999999999],['edge',2000000000],['future',2000000001]]) await h.db.prepare('INSERT INTO terminal_auth_sessions(jti,expires_at) VALUES (?,?)').bind(jti,expires).run();
    for (const created of [cutoff-1,cutoff,cutoff+1]) await h.db.prepare("INSERT INTO terminal_audit(server_id,event,created_at) VALUES ('node-a','close',?)").bind(created).run();
    const authPlan=await h.db.prepare('EXPLAIN QUERY PLAN DELETE FROM terminal_auth_sessions WHERE expires_at <= ?').bind(2000000000).all();
    assert.ok(authPlan.results.some(row=>/USING.*INDEX terminal_auth_sessions_expires_at/.test(row.detail)),JSON.stringify(authPlan.results));
    const auditPlan=await h.db.prepare('EXPLAIN QUERY PLAN DELETE FROM terminal_audit WHERE created_at < ?').bind(cutoff).all();
    assert.ok(auditPlan.results.some(row=>/USING.*INDEX terminal_audit_created_at/.test(row.detail)));
    const before=await (await h.fetch('/test/worker-stats')).json();
    assert.equal((await h.fetch('/test/cleanup?now='+now)).status,200);
    const after=await (await h.fetch('/test/worker-stats')).json();
    assert.equal(after.d1-before.d1,2);
    assert.deepEqual((await h.db.prepare('SELECT jti FROM terminal_auth_sessions ORDER BY jti').all()).results,[{jti:'future'}]);
    assert.deepEqual((await h.db.prepare('SELECT created_at FROM terminal_audit ORDER BY created_at').all()).results,[{created_at:cutoff},{created_at:cutoff+1}]);
    assert.equal((await h.fetch('/test/cleanup?now='+now)).status,200);
  } finally {await h.dispose();}
});

test('maintenance performs two terminal indexed deletes hourly and none on the minute cron', async () => {
  const h=await harness();
  try {
    const now=Date.now();
    await h.db.prepare("INSERT INTO terminal_auth_sessions(jti,expires_at) VALUES ('expired-maintenance',?)").bind(Math.floor(now/1000)-1).run();
    await h.db.prepare("INSERT INTO terminal_audit(server_id,event,created_at) VALUES ('node-a','close',?)").bind(now-7*86400000-1000).run();
    const before=await (await h.fetch('/test/worker-stats')).json();
    assert.equal((await h.fetch('/test/cron?cron='+encodeURIComponent('*/1 * * * *'))).status,200);
    const minute=await (await h.fetch('/test/worker-stats')).json();
    assert.equal(minute.terminalQueries.length-before.terminalQueries.length,0);
    assert.equal((await h.fetch('/test/cron?cron='+encodeURIComponent('0 * * * *'))).status,200);
    const hourly=await (await h.fetch('/test/worker-stats')).json();
    assert.deepEqual(hourly.terminalQueries.slice(minute.terminalQueries.length),[
      'DELETE FROM terminal_audit WHERE created_at < ?',
      'DELETE FROM terminal_auth_sessions WHERE expires_at <= ?'
    ]);
    assert.equal(await h.db.prepare("SELECT jti FROM terminal_auth_sessions WHERE jti='expired-maintenance'").first(),null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM terminal_audit').first()).n,0);
  } finally {await h.dispose();}
});

test('a pre-revocation authority request delayed past 60s can never grant control or renew', async () => {
  for (const kind of ['control','renew']) {
    const h=await harness();
    try {
      const p=await running(h,await h.control());
      const meta=(await snapshot(h)).meta.sessions[0];
      // The test pauses only the D1 read, leaving the real broker state and sockets intact.
      const db=h.db;
      const env={DB:db,TERMINAL_BROKER:{idFromName:id=>id,get:()=>({async fetch(req) {
        await h.fetch('/test/delay-authority?advance=60001');
        return h.fetch('/test/internal?op='+kind,{headers:{...Object.fromEntries(req.headers), ...(kind==='control' ? {Upgrade:'websocket'} : {})}});
      }})}};
      const request=new Request('https://example.com/admin/api',{headers:{Origin:'https://example.com',Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
      const response=await handleTerminalAdminAction({request,env,sys:await loadSiteSettings(db,true),data:{action:'terminal_renew',serverId:'node-a',sessionId:p.session.sessionId}});
      assert.ok(response.status >= 400,kind+' must deny an expired authority result');
      assert.equal((await snapshot(h)).meta.sessions[0]?.leaseUntil,meta.leaseUntil);
    } finally {await h.dispose();}
  }
});

test('constructor cleanup never holds healthy sessions behind an unfinished D1 close audit', async () => {
  const previous=globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair=class {};
  let releaseAudit;
  const pendingAudit=new Promise(resolve=>{releaseAudit=resolve;});
  const now=Date.now(), sockets=[], audits=[];
  const sessions=['expired','healthy'].map((id,index)=>({id,owner:'owner',clientRequestId:id,serverId:'node-a',status:'running',
    generation:1,credentialVersion:1,leaseUntil:now+(index ? 60000 : -1),deadline:now+30000,createdAt:now,cols:80,rows:24,
    browser:id+'-browser',agent:id+'-agent'}));
  for (const s of sessions) for (const role of ['browser','agent']) {
    let attachment={serverId:'node-a',connectionId:s[role],sessionId:s.id,role,owner:'owner',generation:1,credentialVersion:1,
      forwarded:0,acked:0,progressAt:now,...(role==='browser'?{lastUserActivity:now}:{})};
    sockets.push({readyState:1,role,sessionId:s.id,messages:[],deserializeAttachment:()=>structuredClone(attachment),
      serializeAttachment(value){attachment=structuredClone(value);},send(value){this.messages.push(value);},close(){this.readyState=3;}});
  }
  let metadata={serverId:'node-a',generation:1,credentialVersion:1,sessions,closed:[]}, alarm=now+60000;
  const state={setWebSocketAutoResponse(){},blockConcurrencyWhile:fn=>fn(),getWebSockets:()=>sockets,waitUntil:promise=>audits.push(promise),
    storage:{get:async()=>structuredClone(metadata),put:async(key,value)=>{metadata=structuredClone(value);},getAlarm:async()=>alarm,
      setAlarm:async value=>{alarm=value;},deleteAlarm:async()=>{alarm=null;}}};
  const env={DB:{prepare:()=>({bind:()=>({run:()=>pendingAudit})})}};
  try {
    const broker=new TerminalBroker(state,env);
    assert.equal(await Promise.race([broker.ready.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]),true);
    assert.equal(metadata.sessions.length,1);
    assert.equal(audits.length,1);
    const browser=sockets.find(ws=>ws.sessionId==='healthy' && ws.role==='browser');
    await broker.webSocketMessage(browser,new Uint8Array([42]));
    assert.deepEqual(sockets.find(ws=>ws.sessionId==='healthy' && ws.role==='agent').messages,[new Uint8Array([42])]);
  } finally {releaseAudit(); globalThis.WebSocketRequestResponsePair=previous; await Promise.all(audits);}
});

test('missing terminal tables cannot prevent ordinary hourly maintenance and cleanup failure is logged', async () => {
  const h=await harness();
  try {
    await h.db.prepare('DROP TABLE terminal_audit').run();
    await h.db.prepare('DROP TABLE terminal_auth_sessions').run();
    const before=await (await h.fetch('/test/worker-stats')).json();
    const response=await h.fetch('/test/cron?cron='+encodeURIComponent('0 * * * *'));
    const after=await (await h.fetch('/test/worker-stats')).json();
    assert.equal(response.status,200);
    const terminalDelta=after.terminalQueries.length-before.terminalQueries.length;
    assert.equal(terminalDelta,1,'no schema probe or retry when terminal_audit is absent');
    assert.ok(after.d1-before.d1 > terminalDelta,'ordinary settings/expiry work still executes');
    assert.equal(after.errors.length-before.errors.length,1);
    assert.equal(after.errors.at(-1)[0],'[Terminal] Retention cleanup failed:');
    assert.match(after.errors.at(-1)[1],/no such table: terminal_audit/);
  } finally {await h.dispose();}
});

for (const scenario of ['hourly auth delete','Sunday rotation','Sunday rotation failure']) {
  test(`terminal cleanup failure is isolated from ${scenario} and every failure is reported`, async t => {
    const h=await harness(), calls=[], errors=[], NativeDate=Date;
    try {
      const sunday=scenario.startsWith('Sunday');
      const now=Date.UTC(2026,10,sunday?8:9,0);
      globalThis.Date=class extends NativeDate {
        constructor(...args) {super(...(args.length?args:[now]));}
        static now() {return now;}
      };
      t.mock.method(console,'error',(...args)=>errors.push(args));
      clearSiteSettingsCache();
      await h.db.prepare('CREATE INDEX task3_rotation_marker ON metrics_history(timestamp)').run();
      const db=new Proxy(h.db,{get(target,key) {
        if (key==='prepare') return sql=>{
          calls.push(sql);
          if (sql.startsWith('DELETE FROM terminal_auth_sessions')) throw new Error('terminal-specific auth cleanup fault');
          if (scenario==='Sunday rotation failure' && sql==='DROP TABLE IF EXISTS metrics_history_old') throw new Error('ordinary rotation fault');
          return target.prepare(sql);
        };
        return typeof target[key]==='function'?target[key].bind(target):target[key];
      }});
      await assert.doesNotReject(worker.scheduled({cron:'0 * * * *'},{DB:db},{}));
      assert.deepEqual(calls.filter(sql=>sql.startsWith('DELETE FROM terminal_')),[
        'DELETE FROM terminal_audit WHERE created_at < ?',
        'DELETE FROM terminal_auth_sessions WHERE expires_at <= ?'
      ]);
      assert.ok(calls.some(sql=>/SELECT.*value.*FROM settings/is.test(sql)),'expiry maintenance reads ordinary settings');
      assert.equal(errors[0][0],'[Terminal] Retention cleanup failed:');
      assert.equal(errors[0][1].message,'terminal-specific auth cleanup fault');
      const marker=await h.db.prepare("SELECT tbl_name FROM sqlite_master WHERE name='task3_rotation_marker'").first();
      if (scenario==='Sunday rotation') {
        assert.equal(marker.tbl_name,'metrics_history_old','existing history was rotated, not merely queried');
        assert.ok(await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metrics_history'").first());
      } else assert.equal(marker.tbl_name,'metrics_history');
      if (sunday) assert.ok(calls.includes('DROP TABLE IF EXISTS metrics_history_old'));
      else assert.equal(calls.some(sql=>sql.includes('CREATE TABLE') || sql.includes('sqlite_master')),false,'ordinary hours add no schema initialization or table probes');
      if (scenario==='Sunday rotation failure') {
        assert.equal(errors.length,2);
        assert.equal(errors[1][1].message,'ordinary rotation fault');
        const failedRotation=calls.indexOf('DROP TABLE IF EXISTS metrics_history_old');
        assert.ok(calls.slice(failedRotation+1).some(sql=>/SELECT.*value.*FROM settings/is.test(sql)),'expiry still executes after existing rotation error handling');
      } else assert.equal(errors.length,1);
    } finally {t.mock.restoreAll(); globalThis.Date=NativeDate; clearSiteSettingsCache(); await h.dispose();}
  });
}
