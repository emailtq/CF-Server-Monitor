import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNotificationConfig } from '../src/shared/notificationConfig.js';
import { routeNotificationEvents } from '../src/services/notificationRouting.js';
import { harness, controls, until, openPair } from './terminal-harness.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { hashPassword } from '../src/utils/common.js';
import { cleanupLoginEvents } from '../src/database/loginEvents.js';
import fs from 'node:fs';

const eventConfig = (type = 'panelLogin') => ({ schema: 1, revision: 1, timezone: 'UTC', language: 'en', channels: [{ id: 'channel', name: 'Fixture', type: 'telegram', enabled: true, config: { chatId: 'fixture' }, secrets: { botToken: 'fixture-token' }, template: '{{event}} {{message}} {{time}}' }], rules: [{ id: 'rule', name: 'Success', type, enabled: true, scope: { mode: type === 'panelLogin' ? 'site' : 'all', serverIds: [] }, targetIds: ['channel'], options: {} }] });

test('HTTP and WSS SSH receipts reach D1 and the selected channel without dashboard or cron', async t => {
  const sends = [];
  const h = await harness({ outboundService: async request => { sends.push({ at: performance.now(), payload: await request.json() }); return Response.json({ ok: true }); } });
  try {
    await saveSiteOptions(h.db, { wss_report_enabled: 'true' });
    await h.db.prepare("UPDATE servers SET history_partition_id=1 WHERE id='node-a'").run();
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(eventConfig('sshLogin'))).run();
    for (const [index, mode] of ['HTTP','WSS'].entries()) {
      const body = { id: 'node-a', time: { local_ts: Date.now() }, metrics: { cpu: '5' }, ssh_events: { version: 1, stream: `timing-${mode}`, state: 'watching', source: 'journal', events: [{ sequence: 1, occurredAt: Date.now(), user: 'fixture-user', address: '127.0.0.1', method: 'password' }] } };
      const peer = mode === 'WSS' ? await h.socket('/update?config_schema=10', h.agentHeaders()) : null;
      const startedAt = performance.now();
      if (peer) {
        peer.ws.send(JSON.stringify(body));
        await until(() => controls(peer).some(frame => frame.ssh_ack?.stream === body.ssh_events.stream && frame.ssh_ack.sequence === 1));
      } else {
        const response = await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json', 'X-Agent-Config-Schema': '10' }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.headers.get('X-CFSM-Ssh-Ack')), { stream: body.ssh_events.stream, sequence: 1 });
      }
      const acknowledgedAt = performance.now();
      assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count, index + 1, 'ACK must follow durable D1 event');
      await until(() => sends.length === index + 1);
      const sendMs = sends[index].at - startedAt;
      assert.ok(sendMs < 5000, `${mode} delivery required external refresh/cron`);
      assert.match(sends[index].payload.text, /fixture-user/);
      await until(async () => (await h.db.prepare("SELECT COUNT(*) AS count FROM login_event_deliveries WHERE state='sent'").first()).count === index + 1);
      t.diagnostic(`${mode}: report-to-durable-ACK=${(acknowledgedAt-startedAt).toFixed(1)}ms report-to-fake-channel=${sendMs.toFixed(1)}ms`);
    }
  } finally { await h.dispose(); }
});

test('durable panel and terminal spools do not revive disabled rules or adopt newly enabled targets', async () => {
  for (const type of ['panelLogin', 'terminalConnected']) {
    const sent = [];
    const h = await harness({ outboundService: async request => { sent.push(await request.json()); return Response.json({ ok: true }); } });
    try {
      const config = eventConfig(type);
      config.rules.push({ ...config.rules[0], id: 'later', enabled: false });
      await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(config)).run();
      const panel = type === 'panelLogin';
      await h.fetch(panel ? '/test/report-panel-db-fail' : '/test/fail-login-events');
      if (panel) {
        await saveSiteOptions(h.db, { username: 'fixture-admin', password: await hashPassword('fixture-pass') });
        assert.equal((await h.fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', username: 'fixture-admin', password: 'fixture-pass' }) })).status, 200);
      } else {
        const pair = await openPair(h, await h.control());
        await until(() => controls(pair.agent).some(frame => frame.type === 'start'));
        pair.agent.ws.send('{"type":"ready"}');
        await until(() => controls(pair.browser).some(frame => frame.type === 'ready'));
      }
      const spool = panel ? '/test/report-panel-spool' : '/test/login-spool';
      await until(async () => { const state = await (await h.fetch(spool)).json(); return state.count === 1 && !state.flushing; });
      let dto = await (await h.action('get_notification_config')).json();
      dto.rules[0].enabled = false;
      dto = await (await h.action('save_notification_config', { expectedRevision: dto.revision, channels: dto.channels, rules: dto.rules })).json();
      dto.rules.forEach(rule => { rule.enabled = true; });
      assert.equal((await h.action('save_notification_config', { expectedRevision: dto.revision, channels: dto.channels, rules: dto.rules })).status, 200);
      await h.fetch(panel ? '/test/report-panel-db-fail?enabled=0' : '/test/fail-login-events?enabled=0');
      await h.fetch(panel ? '/test/cron?cron=*/1%20*%20*%20*%20*' : '/test/alarm');
      await until(async () => (await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count === 1);
      assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_event_deliveries').first()).count, 0, type);
      assert.equal(sent.length, 0, type);
    } finally { await h.dispose(); }
  }
});

test('success target snapshots survive unrelated policy changes without adopting later rules', async () => {
  const { captureLoginEvent, queueLoginEvent, flushLoginEvents } = await import('../src/services/loginEvents.js');
  const h = await harness();
  try {
    const config = eventConfig();
    config.rules.push({ ...config.rules[0], id: 'later', enabled: false });
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(config)).run();
    const event = await captureLoginEvent({ DB: h.db }, { type: 'panelLogin', id: 'unchanged-target', occurredAt: Date.now() });
    const dto = await (await h.action('get_notification_config')).json();
    dto.rules[1].enabled = true;
    assert.equal((await h.action('save_notification_config', { expectedRevision: dto.revision, channels: dto.channels, rules: dto.rules })).status, 200);
    await queueLoginEvent({ DB: h.db }, event);
    let sent = 0;
    await flushLoginEvents({ DB: h.db }, { send: async () => { sent++; } });
    assert.equal(sent, 1);
    const row = await h.db.prepare('SELECT rules FROM login_event_deliveries').first();
    assert.deepEqual(JSON.parse(row.rules).map(rule => rule.id), ['rule']);
  } finally { await h.dispose(); }
});

test('native Go collector report crosses authenticated HTTP/WSS, D1 and the selected fake channel once', { skip: !process.env.CFSM_SSH_REPORT_INPUT }, async () => {
  const payload = JSON.parse(fs.readFileSync(process.env.CFSM_SSH_REPORT_INPUT, 'utf8'));
  const sent = [];
  const h = await harness({ outboundService: async request => { sent.push(await request.json()); return Response.json({ ok: true }); } });
  try {
    await saveSiteOptions(h.db, { wss_report_enabled: 'true' });
    await h.db.prepare("UPDATE servers SET history_partition_id=1 WHERE id='node-a'").run();
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(eventConfig('sshLogin'))).run();
    const response = await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json', 'X-Agent-Config-Schema': '10' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.headers.get('X-CFSM-Ssh-Ack')).sequence, 1);
    const peer = await h.socket('/update?config_schema=10', h.agentHeaders());
    peer.ws.send(JSON.stringify(payload));
    await until(() => controls(peer).some(frame => frame.ssh_ack?.sequence === 1));
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /SSH login succeeded/);
    assert.match(sent[0].text, /fixture-user/);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count, 1);
    assert.equal(/fixture-user|not-reported|ssh_events/.test(JSON.stringify((await h.db.prepare('SELECT * FROM metrics_history').all()).results)), false);
  } finally { await h.dispose(); }
});

test('panel success is site-scoped and cannot enter a node rule', () => {
  const config = validateNotificationConfig(eventConfig());
  const event = { ruleId: 'rule', scope: 'site', eventKey: 'panelLogin:one', msg: 'Panel login', context: {} };
  assert.equal(routeNotificationEvents(config, [event]).length, 1);
  assert.equal(routeNotificationEvents(config, [{ ...event, serverId: 'node-a', scope: 'node' }]).length, 0);
  assert.throws(() => validateNotificationConfig({ ...config, rules: [{ ...config.rules[0], scope: { mode: 'all', serverIds: [] } }] }));
});

test('SSH persistence outage does not acknowledge or discard an event; retry recovers once', async () => {
  const h = await harness({ outboundService: async () => Response.json({ ok: true }) });
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=1 WHERE id='node-a'").run();
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(eventConfig('sshLogin'))).run();
    const body = { id: 'node-a', metrics: { cpu: '5', timestamp: Date.now() - 60000 }, ssh_events: { version: 1, stream: 'recover-stream', state: 'watching', source: 'auth.log', events: [{ sequence: 1, occurredAt: Date.now(), user: 'fixture', address: '127.0.0.1', method: 'password' }] } };
    const post = () => { body.metrics.timestamp += 1000; return h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); };
    await h.fetch('/test/ssh-db-fail');
    const failed = await post();
    assert.equal(failed.status, 500); assert.equal(failed.headers.has('X-CFSM-Ssh-Ack'), false);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count, 0);
    await h.fetch('/test/ssh-db-fail?enabled=0');
    const recovered = await post(); assert.equal(recovered.status, 200);
    assert.equal(JSON.parse(recovered.headers.get('X-CFSM-Ssh-Ack')).sequence, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count, 1);
  } finally { await h.dispose(); }
});

test('disabling then immediately reenabling a success rule cannot revive its pending deliveries', async () => {
  const { queueLoginEvent, flushLoginEvents } = await import('../src/services/loginEvents.js');
  const h = await harness({ outboundService: async () => { assert.fail('cancelled delivery revived'); } });
  try {
    const config = eventConfig('sshLogin');
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(config)).run();
    await queueLoginEvent({DB:h.db}, { type:'sshLogin',id:'disable-once',occurredAt:Date.now(),serverId:'node-a',tokenVersion:h.nodes['node-a'].tokenVersion,user:'fixture',address:'127.0.0.1',method:'password' });
    let dto = await (await h.action('get_notification_config')).json();
    const save = () => h.action('save_notification_config', { expectedRevision:dto.revision,channels:dto.channels,rules:dto.rules });
    dto.rules[0].enabled=false;let response=await save();assert.equal(response.status,200);dto=await response.json();
    assert.equal((await h.db.prepare('SELECT state FROM login_event_deliveries').first()).state,'cancelled');
    dto.rules[0].enabled=true;response=await save();assert.equal(response.status,200);
    await flushLoginEvents({DB:h.db},{send:async()=>assert.fail('reenable replayed cancelled event')});
  } finally { await h.dispose(); }
});

test('terminal running and data/ACK continue while a durable success spool recovers a D1 outage', async () => {
  const h = await harness({ outboundService: async () => Response.json({ok:true}) });
  try {
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(eventConfig('terminalConnected'))).run();
    await h.fetch('/test/fail-login-events');
    const pair=await openPair(h,await h.control());await until(()=>controls(pair.agent).some(frame=>frame.type==='start'));
    pair.agent.ws.send('{"type":"ready"}');await until(()=>controls(pair.browser).some(frame=>frame.type==='ready'));
    await until(async()=> (await (await h.fetch('/test/login-spool')).json()).count===1);
    pair.agent.ws.send(new Uint8Array([7]));await until(()=>pair.browser.messages.some(value=>typeof value!=='string'));
    pair.browser.ws.send('{"type":"ack","bytes":1}');await until(()=>controls(pair.agent).some(frame=>frame.type==='ack'&&frame.bytes===1));
    await h.fetch('/test/rebuild');
    await until(async()=> !(await(await h.fetch('/test/login-spool')).json()).flushing);
    assert.equal((await (await h.fetch('/test/login-spool')).json()).count,1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count,0);
    await h.fetch('/test/fail-login-events?enabled=0');await h.fetch('/test/alarm');
    await until(async()=> (await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count===1);
    assert.equal((await (await h.fetch('/test/login-spool')).json()).count,0);
    assert.equal(pair.browser.ws.readyState,1);
  } finally { await h.dispose(); }
});

test('terminal ready and immediate Agent bytes stay ordered while policy capture is pending', async () => {
  const h = await harness();
  try {
    const pair = await openPair(h, await h.control());
    await until(() => controls(pair.agent).some(frame => frame.type === 'start'));
    await h.fetch('/test/delay-login-policy');
    pair.agent.ws.send('{"type":"ready"}');
    pair.agent.ws.send(new Uint8Array([7]));
    pair.agent.ws.send(new Uint8Array([8]));
    await until(() => pair.browser.messages.filter(value => typeof value !== 'string').length === 2);
    const ready = pair.browser.messages.findIndex(value => typeof value === 'string' && JSON.parse(value).type === 'ready');
    const output = pair.browser.messages.findIndex(value => typeof value !== 'string');
    assert.ok(ready >= 0 && ready < output);
    pair.browser.ws.send('{"type":"ack","bytes":2}');
    await until(() => controls(pair.agent).some(frame => frame.type === 'ack' && frame.bytes === 2));
    assert.equal(pair.browser.ws.readyState, 1);
  } finally { await h.dispose(); }
});

test('terminal policy capture does not grant extra output credit before running', async () => {
  const h = await harness();
  try {
    const pair = await openPair(h, await h.control());
    await until(() => controls(pair.agent).some(frame => frame.type === 'start'));
    await h.fetch('/test/delay-login-policy');
    pair.agent.ws.send('{"type":"ready"}');
    for (let n = 0; n < 17; n++) pair.agent.ws.send(new Uint8Array(16384));
    await until(() => pair.browser.ws.readyState !== 1);
    assert.equal(pair.browser.messages.some(value => typeof value === 'string' && JSON.parse(value).type === 'ready'), false);
  } finally { await h.dispose(); }
});

test('panel Turnstile verification failure never emits a success event', async () => {
  const h=await harness();
  try{
    await saveSiteOptions(h.db,{username:'fixture-admin',password:await hashPassword('fixture-pass'),turnstile_login_enabled:'true',turnstile_secret_key:'fixture-secret'});
    const response=await h.fetch('/admin/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',username:'fixture-admin',password:'fixture-pass'})});
    assert.equal(response.status,403);assert.equal(response.headers.has('Set-Cookie'),false);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count,0);
  }finally{await h.dispose();}
});

test('panel login succeeds with a durable private spool while D1 delivery recovers', async () => {
  const h=await harness({outboundService:async()=>Response.json({ok:true})});
  try{
    await saveSiteOptions(h.db,{username:'fixture-admin',password:await hashPassword('fixture-pass')});
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(eventConfig())).run();
    await h.fetch('/test/report-panel-db-fail');
    const response=await h.fetch('/admin/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',username:'fixture-admin',password:'fixture-pass'})});
    assert.equal(response.status,200);assert.ok((await response.json()).token);
    await until(async()=>{const state=await(await h.fetch('/test/report-panel-spool')).json();return state.count===1&&!state.flushing});
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count,0);
    await h.fetch('/test/report-panel-db-fail?enabled=0');await h.fetch('/test/cron?cron=*/1%20*%20*%20*%20*');
    await until(async()=> (await h.db.prepare('SELECT COUNT(*) AS count FROM login_events').first()).count===1);
    assert.equal((await(await h.fetch('/test/report-panel-spool')).json()).count,0);
    const row=await h.db.prepare('SELECT server_id,payload FROM login_events').first();
    assert.equal(row.server_id,null);assert.equal(/fixture-pass|token|password/.test(row.payload),false);
  }finally{await h.dispose();}
});

test('SSH structure accepts international/domain accounts and scoped IPv6, rejects malformed data', async()=>{
  const {validateSshEventReport}=await import('../src/services/loginEvents.js');
  const report={version:1,stream:'unicode',state:'watching',source:'journal',events:[{sequence:1,occurredAt:Date.now()+3600000,user:'域\\用户',address:'fe80::1%eth0',method:'publickey'}]};
  assert.equal(validateSshEventReport(report).events[0].user,'域\\用户');
  for(const address of ['999.0.0.1','deadbeef','1::2::3','127.0.0.1%eth0'])assert.throws(()=>validateSshEventReport({...report,events:[{...report.events[0],address}]}));
  assert.throws(()=>validateSshEventReport({...report,events:[{...report.events[0],user:'bad\nuser'}]}));
});

test('pending terminal success is cancelled by credential invalidation and rule scope edit', async () => {
  const { queueLoginEvent, flushLoginEvents } = await import('../src/services/loginEvents.js');
  const h = await harness();
  try {
    const config = eventConfig('terminalConnected');
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(config)).run();
    const node = h.nodes['node-a'];
    const event = { type: 'terminalConnected', id: 'terminal-one', occurredAt: Date.now(), serverId: 'node-a', tokenVersion: node.tokenVersion, credentialVersion: node.version };
    await queueLoginEvent({ DB: h.db }, event);
    config.rules[0].scope = { mode: 'selected', serverIds: ['node-b'] };
    await h.db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(JSON.stringify(config)).run();
    await flushLoginEvents({ DB: h.db }, { send: async () => assert.fail('old scope delivered') });
    assert.equal((await h.db.prepare('SELECT state FROM login_event_deliveries').first()).state, 'cancelled');
    config.rules[0].scope = { mode: 'all', serverIds: [] };
    await h.db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(JSON.stringify(config)).run();
    await queueLoginEvent({ DB: h.db }, { ...event, id: 'terminal-two' });
    await h.db.prepare("UPDATE terminal_nodes SET credential_version=credential_version+? WHERE server_id='node-a'").bind(1).run();
    await flushLoginEvents({ DB: h.db }, { send: async () => assert.fail('old terminal credential delivered') });
    assert.equal((await h.db.prepare("SELECT state FROM login_event_deliveries WHERE event_id='terminal-two'").first()).state, 'cancelled');
  } finally { await h.dispose(); }
});

test('WSS success report has an independent durable event ACK while public subscribers never see login details', async () => {
  const h = await harness({ outboundService: async () => Response.json({ ok: true }) });
  try {
    await saveSiteOptions(h.db, { wss_report_enabled: 'true', is_public: 'true' });
    await h.db.prepare("UPDATE servers SET history_partition_id=1 WHERE id='node-a'").run();
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(eventConfig('sshLogin'))).run();
    const publicPeer = await h.socket('/api/ws?subscribe=node-a');
    assert.equal(publicPeer.response.status,101);
    publicPeer.ws.send(JSON.stringify({type:'subscribe',scope:'node-a',ids:['node-a']}));
    await until(()=>controls(publicPeer).some(frame=>frame.type==='subscribed'));
    const peer = await h.socket('/update?config_schema=10', h.agentHeaders());
    const body = { id: 'node-a', metrics: { cpu: '7', timestamp: Date.now() }, ssh_events: { version: 1, stream: 'wss-stream', state: 'watching', source: 'journal', events: [{ sequence: 1, occurredAt: Date.now(), user: 'private-login-user', address: '127.0.0.1', method: 'password' }] } };
    peer.ws.send(JSON.stringify({ type: 'update', payload: body }));
    await until(() => controls(peer).some(frame => frame.ssh_ack?.sequence === 1));
    peer.ws.send(JSON.stringify({ type: 'update', payload: body }));
    await until(() => controls(peer).filter(frame => frame.ssh_ack?.sequence === 1).length === 2);
    await until(() => publicPeer.messages.some(message => typeof message === 'string' && message.includes('"cpu"')));
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM login_events WHERE type='sshLogin'").first()).count, 1);
    assert.equal(/private-login-user|wss-stream|ssh_events/.test(JSON.stringify(publicPeer.messages)), false);
    const status = await (await h.action('get_login_event_status')).json();
    assert.equal(status.sources[0].source, 'journal');
    assert.equal(status.sources[0].state, 'watching');
    assert.equal((await h.fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_login_event_status' }) })).status, 401);
  } finally { await h.dispose(); }
});

test('SSH and terminal successes require node scope and have no threshold options', () => {
  for (const type of ['sshLogin', 'terminalConnected']) {
    const config = validateNotificationConfig(eventConfig(type));
    assert.equal(routeNotificationEvents(config, [{ ruleId: 'rule', serverId: 'node-a', eventKey: type + ':one', msg: 'Success' }]).length, 1);
    assert.equal(routeNotificationEvents(config, [{ ruleId: 'rule', scope: 'site', eventKey: type + ':one', msg: 'Success' }]).length, 0);
    assert.throws(() => validateNotificationConfig({ ...config, rules: [{ ...config.rules[0], options: { minutes: 5 } }] }));
  }
});

test('durable success outbox claims once, isolates failed channel, and cancels changed rule identities', async () => {
  const events = await import('../src/services/loginEvents.js').catch(() => ({}));
  assert.equal(typeof events.queueLoginEvent, 'function');
  const h = await harness();
  try {
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(eventConfig())).run();
    const env = { DB: h.db };
    const event = { type: 'panelLogin', id: 'success-one', occurredAt: Date.now() };
    await events.queueLoginEvent(env, event);
    await events.queueLoginEvent(env, event);
    let sends = 0;
    await Promise.all([events.flushLoginEvents(env, { send: async () => { sends++; return 'network result unknown'; } }), events.flushLoginEvents(env, { send: async () => { sends++; return 'network result unknown'; } })]);
    await events.flushLoginEvents(env, { send: async () => { sends++; } });
    assert.equal(sends, 1);
    assert.equal((await h.db.prepare('SELECT state FROM login_event_deliveries').first()).state, 'uncertain');
    await events.queueLoginEvent(env, { ...event, id: 'success-two' });
    const config = eventConfig(); config.rules[0].enabled = false;
    await h.db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(JSON.stringify(config)).run();
    await events.flushLoginEvents(env, { send: async () => { sends++; } });
    assert.equal(sends, 1);
    assert.equal((await h.db.prepare("SELECT state FROM login_event_deliveries WHERE event_id='success-two'").first()).state, 'cancelled');
  } finally { await h.dispose(); }
});

test('only successful panel authentication and actual PTY ready produce durable success events', async () => {
  const h = await harness();
  try {
    await saveSiteOptions(h.db, { username: 'fixture-admin', password: await hashPassword('fixture-pass') });
    const login = password => h.fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: JSON.stringify({ action: 'login', username: 'fixture-admin', password }) });
    assert.equal((await login('wrong')).status, 401);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM login_events WHERE type='panelLogin'").first()).count, 0);
    assert.equal((await login('fixture-pass')).status, 200);
    await until(async () => (await h.db.prepare("SELECT COUNT(*) AS count FROM login_events WHERE type='panelLogin'").first()).count === 1);
    const pair = await openPair(h, await h.control());
    await until(() => controls(pair.agent).some(frame => frame.type === 'start'));
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM login_events WHERE type='terminalConnected'").first()).count, 0);
    pair.agent.ws.send('{"type":"ready"}');
    await until(() => controls(pair.browser).some(frame => frame.type === 'ready'));
    await until(async () => (await h.db.prepare("SELECT COUNT(*) AS count FROM login_events WHERE type='terminalConnected'").first()).count === 1);
    pair.agent.ws.send('{"type":"ready"}');
    await h.fetch('/test/rebuild');
    await until(async()=> !(await(await h.fetch('/test/login-spool')).json()).flushing);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM login_events WHERE type='terminalConnected'").first()).count, 1);
    const payload = JSON.stringify((await h.db.prepare('SELECT payload FROM login_events').all()).results);
    assert.equal(/fixture-pass|token|jti|password/.test(payload), false);
  } finally { await h.dispose(); }
});

test('authenticated SSH report confirms durable acceptance, replay and retention never redeliver', async () => {
  const events = await import('../src/services/loginEvents.js');
  const h = await harness({ outboundService: async () => Response.json({ ok: true }) });
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=1 WHERE id='node-a'").run();
    const config = eventConfig('sshLogin');
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(config)).run();
    const ssh = { version: 1, stream: 'fixture-stream', state: 'watching', source: 'auth.log', events: [{ sequence: 1, occurredAt: Date.now(), user: 'fixture-user', address: '127.0.0.1', method: 'publickey' }] };
    const body = { id: 'node-a', metrics: { cpu: '5', timestamp: Date.now() - 60000 }, ssh_events: ssh };
    const post = headers => { body.metrics.timestamp += 1000; return h.fetch('/update', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); };
    assert.equal((await post({})).status, 401);
    const response = await post(h.agentHeaders());
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.headers.get('X-CFSM-Ssh-Ack')), { stream: 'fixture-stream', sequence: 1 });
    assert.equal((await post(h.agentHeaders())).status, 200);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM login_events WHERE type='sshLogin'").first()).count, 1);
    const history = JSON.stringify((await h.db.prepare('SELECT * FROM metrics_history').all()).results);
    assert.equal(/fixture-user|fixture-stream|publickey/.test(history), false);
    assert.throws(() => events.validateSshEventReport({ ...ssh, path: '/etc/shadow' }));
    assert.throws(() => events.validateSshEventReport({ ...ssh, events: [{ ...ssh.events[0], raw: 'secret' }] }));
    const node = { serverId: 'node-a', tokenVersion: h.nodes['node-a'].tokenVersion };
    await until(async () => (await h.db.prepare('SELECT state FROM login_event_deliveries').first()).state === 'sent');
    await cleanupLoginEvents(h.db, Date.now() + 8 * 86400000);
    await events.acceptSshEvents({ DB: h.db }, node, ssh);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM login_event_deliveries').first()).count, 0);
    await events.queueLoginEvent({ DB: h.db }, { ...ssh.events[0], id: 'pending-revoke', type: 'sshLogin', serverId: 'node-a', tokenVersion: node.tokenVersion });
    await h.db.prepare("UPDATE terminal_nodes SET token_version=token_version+? WHERE server_id='node-a'").bind(1).run();
    await events.flushLoginEvents({ DB: h.db }, { send: async () => { assert.fail('revoked event delivered'); } });
    assert.equal((await h.db.prepare('SELECT state FROM login_event_deliveries').first()).state, 'cancelled');
    assert.equal((await events.acceptSshEvents({ DB: h.db }, node, { ...ssh, events: [{ ...ssh.events[0], sequence: 2 }] })).sequence, 1);
  } finally { await h.dispose(); }
});
