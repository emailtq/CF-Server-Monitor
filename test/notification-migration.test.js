import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { checkOfflineNodes, checkResourceAlerts, checkExpiringServers, evaluateTrafficAlert } from '../src/services/notification.js';
import { clearAllCaches } from '../src/utils/cache.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { GB } from '../src/utils/traffic.js';
import { importNotificationConfig } from '../src/database/notifications.js';
import fs from 'node:fs';
import path from 'node:path';

globalThis.WebSocketRequestResponsePair = class {};
const NOW = Date.UTC(2026, 10, 7, 12);
const channels = ['a', 'b'].map(id => ({ id, name: id, type: 'telegram', enabled: true, config: { chatId: id }, secrets: { botToken: `123:fixture-${id}` }, template: `${id} {{message}}` }));
const rule = (id, type, ids, targetIds, options) => ({ id, name: id, type, enabled: true, scope: { mode: ids ? 'selected' : 'all', serverIds: ids || [] }, targetIds, options });
const config = rules => ({ schema: 1, revision: 1, timezone: 'UTC', language: 'en', channels: structuredClone(channels), rules });

async function fixture(t, c, site = {}, restartable = false) {
  clearAllCaches();
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const evidencePath = path.resolve('docs/superpowers/admin-ui-refactor/evidence/task-2');
  fs.mkdirSync(evidencePath, { recursive: true });
  const evidence = fs.realpathSync(evidencePath);
  assert.ok(evidence.startsWith(fs.realpathSync(process.cwd()) + path.sep));
  const persist = restartable ? fs.mkdtempSync(path.join(evidence, 'd1-restart-')) : null;
  const options = { modules: true, script: 'export default {fetch(){return new Response("OK")}}', d1Databases: { DB: crypto.randomUUID() }, ...(persist ? { resourcePersistencePath: persist } : {}) };
  let mf = new Miniflare(options);
  t.after(async () => {
    clearAllCaches(); await mf.dispose();
    if (persist) {
      const noLinks = dir => fs.readdirSync(dir).every(name => { const p=path.join(dir,name),stat=fs.lstatSync(p); return !stat.isSymbolicLink() && (!stat.isDirectory() || noLinks(p)); });
      assert.ok(fs.realpathSync(persist).startsWith(evidence + path.sep) && noLinks(persist));
      fs.rmSync(persist, { recursive: true });
    }
  });
  let db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT)').run();
  await db.prepare(`CREATE TABLE servers (id TEXT PRIMARY KEY,name TEXT,sort_order INTEGER,history_partition_id INTEGER,timestamp INTEGER,offline_notify_disabled TEXT,traffic_limit TEXT,traffic_calc_type TEXT,traffic_alert_percent INTEGER,traffic_alert_state TEXT,expire_date TEXT,billing_cycle TEXT,price TEXT,auto_renewal TEXT)`).run();
  await db.prepare('CREATE TABLE metrics_history (id INTEGER PRIMARY KEY,timestamp INTEGER)').run();
  for (const [i, id] of ['A', 'B'].entries()) await db.prepare(`INSERT INTO servers (id,name,sort_order,history_partition_id,timestamp,traffic_limit,traffic_calc_type,expire_date,billing_cycle,auto_renewal) VALUES (?,?,?, ?,0,'100','total','2026-11-09','month','0')`).bind(id,id,i,i+1).run();
  await db.prepare("INSERT INTO settings VALUES ('site_options',?)").bind(JSON.stringify({ jwt_secret: 'a'.repeat(64), tg_bot_token: '123:old', tg_chat_id: 'old', tg_notify: '5', traffic_alert_threshold: '80', expire_reminder: '5', notification_timezone: 'UTC', ...site })).run();
  if (c !== undefined) await db.prepare("INSERT INTO settings VALUES ('notification_config',?)").bind(typeof c === 'string' ? c : JSON.stringify(c)).run();
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { payloads.push(JSON.parse(options.body)); return Response.json({ ok: true }); });
  const setConfig = c => db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(JSON.stringify(c)).run();
  const read = async key => { const r=await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first(); return r ? JSON.parse(r.value) : null; };
  return { get db() { return db; }, payloads, setConfig, read, server: id => db.prepare('SELECT * FROM servers WHERE id=?').bind(id).first(), async restart() { assert.ok(persist); await mf.dispose(); clearAllCaches(); mf=new Miniflare(options); db=await mf.getD1Database('DB'); } };
}

test('real D1 offline scopes isolate actual payloads and legacy consumed events do not replay', async t => {
  const c = config([rule('offline_default','offline',['A'],['a'],{minutes:5}),rule('rb','offline',['B'],['b'],{minutes:5})]);
  const h = await fixture(t,c);
  await h.db.prepare("INSERT INTO settings VALUES ('alert_state',?)").bind(JSON.stringify({A:true})).run();
  await checkOfflineNodes(h.db);
  assert.equal(h.payloads.length,1);
  assert.equal(h.payloads[0].chat_id,'b');
  assert.doesNotMatch(h.payloads[0].text,/\bA\b/);
  await checkOfflineNodes(h.db);
  assert.equal(h.payloads.length,1);
});

test('rename/template/target additions and a disabled period cannot replay an offline event', async t => {
  const c=config([rule('offline_default','offline',null,['a'],{minutes:5})]);
  const h=await fixture(t,c);
  await checkOfflineNodes(h.db);
  assert.equal(h.payloads.length,1);
  c.rules[0].name='Renamed'; c.channels[0].template='changed {{message}}'; c.rules[0].targetIds=['b','a'];
  await h.setConfig(c); await checkOfflineNodes(h.db);
  assert.equal(h.payloads.length,1);
  c.channels.forEach(ch=>ch.enabled=false); await h.setConfig(c); await checkOfflineNodes(h.db);
  c.channels.forEach(ch=>ch.enabled=true); await h.setConfig(c); await checkOfflineNodes(h.db);
  assert.equal(h.payloads.length,1);
});

test('authoritative empty/future/invalid config and missing selected nodes stop all old sends', async t => {
  const h=await fixture(t,config([]));
  for (const c of [config([]), {...config([]),channels:[],rules:[]}, {...config([]),schema:2}, '{broken', config([rule('stale','offline',['gone'],['a'],{minutes:5})])]) {
    await h.db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(typeof c==='string'?c:JSON.stringify(c)).run();
    await checkOfflineNodes(h.db);
    await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:90*GB,net_tx_monthly:0});
  }
  assert.equal(h.payloads.length,0);
});

test('traffic partial delivery persists per target, survives restart and retries only failed targets', async t => {
  const c=config([rule('traffic_default','traffic',['A'],['a','b'],{threshold:80})]);
  const h=await fixture(t,c,{},true); let failB=true;
  // Fail at dispatch boundary: do not wait through transport retries or contact SMTP/providers.
  const send=async channel=>channel.id==='b'&&failB?'failed':'';
  const metrics={net_rx_monthly:90*GB,net_tx_monthly:0};
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),metrics,{send});
  const state=JSON.parse((await h.server('A')).traffic_alert_state);
  assert.equal(state.schema,2);
  assert.deepEqual(state.rules.traffic_default.success,['a']);
  await h.restart(); failB=false; const sent=[];
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),metrics,{send:async ch=>{sent.push(ch.id);return '';}});
  assert.deepEqual(sent,['b']);
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),metrics,{send:async ch=>{sent.push(ch.id);return '';}});
  assert.deepEqual(sent,['b']);
});

test('traffic CAS permits one concurrent claim and target addition does not backfill history', async t => {
  const c=config([rule('traffic_default','traffic',['A'],['a'],{threshold:80})]);
  const h=await fixture(t,c);const metrics={net_rx_monthly:90*GB,net_tx_monthly:0};const stale=await h.server('A');
  let sends=0;const send=async()=>{sends++;await new Promise(r=>setTimeout(r,5));return '';};
  await Promise.all([evaluateTrafficAlert({DB:h.db},stale,metrics,{send}),evaluateTrafficAlert({DB:h.db},stale,metrics,{send})]);
  assert.equal(sends,1);
  c.rules[0].targetIds=['a','b']; await h.setConfig(c);
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),metrics,{send});
  assert.equal(sends,1);
  assert.ok((await h.server('A')).traffic_alert_state.length<8192);
});

test('resource scope, legacy active state and missing samples do not recover or leak', async t => {
  const c=config([rule('cpu','resource',['A'],['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'}),rule('rb','resource',['B'],['b'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'})]);
  const h=await fixture(t,c);
  await h.db.prepare("INSERT INTO settings VALUES ('resource_alert_state',?)").bind(JSON.stringify({signature:'legacy',servers:{'cpu:A':{status:'active',lastTriggeredAt:NOW,metrics:[{metric:'cpu',threshold:80,current:90}]}}})).run();
  const broadcaster=new MetricsBroadcaster({setWebSocketAutoResponse(){},getWebSockets(){return [];},storage:{async get(){return null;},async put(){}}},{DB:h.db});
  const samples=id=>broadcaster.resourceAlertWindows.set(id,{samples:Array.from({length:5},(_,i)=>({ts:NOW-(4-i)*60000,minuteTs:NOW-(4-i)*60000,cpu:90,ram:90,disk:90,netIn:0,netOut:0}))});
  samples('A');samples('B');let requests=0;
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(url,options){requests++;return broadcaster.fetch(new Request(url,options));}};}}};
  await checkResourceAlerts(env);
  assert.equal(h.payloads.length,1);assert.equal(h.payloads[0].chat_id,'b');assert.doesNotMatch(h.payloads[0].text,/\bA\b/);
  broadcaster.resourceAlertWindows.clear();await checkResourceAlerts(env);
  assert.equal(h.payloads.length,1);assert.equal((await h.read('resource_alert_state')).servers['cpu:A'].status,'active');
  assert.equal(requests,2);
});

test('multiple expiry rules renew each server once and route only scoped messages', async t => {
  const c=config([rule('ea','expiry',['A'],['a'],{days:5,hour:12}),rule('eb','expiry',['A'],['b'],{days:3,hour:12})]);
  const h=await fixture(t,c);await h.db.prepare("UPDATE servers SET auto_renewal='1' WHERE id='A'").run();
  await checkExpiringServers(h.db,{scheduled:true,now:NOW});
  assert.equal((await h.server('A')).expire_date,'2026-12-09');
  assert.equal(h.payloads.length,2);assert.ok(h.payloads.every(p=>!p.text.includes('B')));
  await checkExpiringServers(h.db,{scheduled:true,now:NOW});assert.equal(h.payloads.length,2);
});

test('backup import establishes baseline without replaying pre-import offline or traffic events', async t => {
  const h=await fixture(t,config([]));
  const c=config([rule('new-offline','offline',null,['a'],{minutes:5}),rule('new-traffic','traffic',null,['b'],{threshold:80})]);
  await importNotificationConfig(h.db,c);
  await checkOfflineNodes(h.db);
  const metrics={net_rx_monthly:90*GB,net_tx_monthly:0};
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),metrics);
  assert.equal(h.payloads.length,0);
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:10*GB,net_tx_monthly:0});
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),metrics);
  assert.equal(h.payloads.length,1,'a new post-import billing event should send');
});

test('resource rename, target removal/disable and missing samples preserve consumed state', async t => {
  const c=config([rule('r','resource',['A'],['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'})]);
  const h=await fixture(t,c);
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(){return Response.json({results:[{ruleId:'r',alerts:[{serverId:'A',metrics:[{metric:'cpu',mode:'average',threshold:80,triggerValue:90,current:90}]}],evaluatedServerIds:['A'],evaluations:[]}]});}};}}};
  await checkResourceAlerts(env);assert.equal(h.payloads.length,1);
  c.rules[0].name='rename';c.rules[0].targetIds=['b','a'];await h.setConfig(c);await checkResourceAlerts(env);
  assert.equal(h.payloads.length,1);
  const state=await h.read('resource_alert_state');
  c.channels.forEach(ch=>ch.enabled=false);await h.setConfig(c);await checkResourceAlerts(env);
  assert.deepEqual(await h.read('resource_alert_state'),state);
  c.channels.forEach(ch=>ch.enabled=true);await h.setConfig(c);await checkResourceAlerts(env);
  assert.equal(h.payloads.length,1);
});

test('completed traffic events do not write D1 for each changed byte count', async t => {
  const h=await fixture(t,config([rule('traffic_default','traffic',['A'],['a'],{threshold:80})]));
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:90*GB,net_tx_monthly:0});
  const state=(await h.server('A')).traffic_alert_state;
  for (const value of [91,92,93]) await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:value*GB,net_tx_monthly:0});
  assert.equal((await h.server('A')).traffic_alert_state,state);
  assert.equal(h.payloads.length,1);
});

test('renewal routes one financial event to rules with different reminder hours', async t => {
  const h=await fixture(t,config([rule('a','expiry',['A'],['a'],{days:5,hour:12}),rule('b','expiry',['A'],['b'],{days:0,hour:13})]));
  await h.db.prepare("UPDATE servers SET auto_renewal='1' WHERE id='A'").run();
  await checkExpiringServers(h.db,{scheduled:true,now:NOW});
  assert.equal(h.payloads.length,2);
  assert.equal((await h.server('A')).expire_date,'2026-12-09');
});

test('legacy automatic renewal timing survives an absent notification target', async t => {
  const h=await fixture(t,undefined,{tg_bot_token:'',tg_chat_id:'',expire_reminder:'5'});
  await h.db.prepare("UPDATE servers SET auto_renewal='1' WHERE id='A'").run();
  await checkExpiringServers(h.db,{scheduled:true,now:NOW});
  assert.equal((await h.server('A')).expire_date,'2026-12-09');
  assert.equal(h.payloads.length,0);
});

test('D1 scans and metric evaluation counts do not grow with channel count', async t => {
  const h=await fixture(t,config([]));const observations=[];
  for (const count of [1,16]) {
    clearAllCaches();
    await h.db.prepare("DELETE FROM settings WHERE key IN ('alert_state','resource_alert_state')").run();
    const c=config([rule('offline','offline',['A'],['a'],{minutes:5}),rule('resource','resource',['A'],['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'})]);
    c.channels=Array.from({length:count},(_,i)=>({...channels[0],id:`c${i}`,name:`c${i}`,secrets:{botToken:`123:fixture-${i}`}}));
    c.rules.forEach(r=>r.targetIds=c.channels.map(ch=>ch.id));await h.setConfig(c);
    const sqls=[];let evaluations=0;
    const db={prepare(sql){sqls.push(sql);return h.db.prepare(sql);},batch(statements){return h.db.batch(statements);}};
    const env={DB:db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(){evaluations++;return Response.json({results:[{ruleId:'resource',alerts:[],evaluatedServerIds:[],evaluations:[]}]});}};}}};
    await checkOfflineNodes(db);await checkResourceAlerts(env);
    observations.push({channels:count,configReads:sqls.filter(s=>s.startsWith('SELECT value FROM settings WHERE key = ?')).length,serverScans:sqls.filter(s=>s.includes('SELECT * FROM servers')).length,historyQueries:sqls.filter(s=>s.startsWith('SELECT timestamp')).length,evaluations});
  }
  assert.deepEqual(observations.map(({channels,...counts})=>counts),[{configReads:3,serverScans:1,historyQueries:1,evaluations:1},{configReads:3,serverScans:1,historyQueries:1,evaluations:1}]);
  console.log('TASK2_PERFORMANCE '+JSON.stringify(observations));
});

test('sensitive import binds the large config once rather than once per node or state key', async t => {
  const h=await fixture(t,config([]));
  const c=config([rule('offline','offline',null,['a'],{minutes:5}),rule('traffic','traffic',null,['a'],{threshold:80}),rule('resource','resource',null,['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'}),rule('expiry','expiry',null,['a'],{days:5,hour:12})]);
  c.channels=Array.from({length:16},(_,i)=>({...channels[0],id:i===0?'a':`c${i}`,template:'x'.repeat(4000)}));
  let boundBytes=0;
  const db={prepare(sql){const statement=h.db.prepare(sql);return {bind(...args){boundBytes+=args.reduce((n,value)=>n+(typeof value==='string'?Buffer.byteLength(value):0),0);return statement.bind(...args);},first(){return statement.first();},all(){return statement.all();}};},batch(statements){return h.db.batch(statements);}};
  await importNotificationConfig(db,c);
  assert.ok(boundBytes<100000,`oversized repeated bindings: ${boundBytes}`);
  assert.equal((await h.read('notification_config')).channels.length,16);
  console.log('TASK2_IMPORT_BOUND_BYTES '+boundBytes);
});

test('legacy resource IDs disambiguated by migration preserve already consumed state', async t => {
  const h=await fixture(t,undefined,{resource_alert_rules:[{id:'offline_default',metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'}]});
  await h.db.prepare("INSERT INTO settings VALUES ('resource_alert_state',?)").bind(JSON.stringify({signature:'legacy',servers:{'offline_default:A':{status:'active',lastTriggeredAt:NOW,metrics:[{metric:'cpu',threshold:80,current:90}]}}})).run();
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(url,options){const id=JSON.parse(options.body).rules[0].ruleId;assert.equal(id,'r.offline_default');return Response.json({results:[{ruleId:id,alerts:[{serverId:'A',metrics:[{metric:'cpu',mode:'average',threshold:80,current:90,triggerValue:90}]}],evaluatedServerIds:['A'],evaluations:[]}]});}};}}};
  await checkResourceAlerts(env);
  assert.equal(h.payloads.length,0);
  assert.equal((await h.read('resource_alert_state')).servers['r.offline_default:A'].status,'active');
});

test('correction: a secondary traffic event preserves a consumed legacy default across schema2 promotion', async t => {
  const h=await fixture(t,config([rule('traffic_default','traffic',['A'],['a'],{threshold:80}),rule('secondary','traffic',['A'],['b'],{threshold:90})]));
  await h.db.prepare("UPDATE servers SET traffic_alert_state=? WHERE id='A'").bind(JSON.stringify({u:90*GB,th:80,lim:100})).run();
  const sent=[],send=async ch=>{sent.push(ch.id);return '';};
  for (const value of [95,96]) await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:value*GB,net_tx_monthly:0},{send});
  assert.deepEqual(sent,['b']);
  const stored=JSON.parse((await h.server('A')).traffic_alert_state);
  assert.deepEqual(stored.rules.traffic_default.success,['a']);
  assert.equal(stored.rules.traffic_default.u,90*GB);
});

test('correction: legacy default consumption survives promotion even on a below-default report', async t => {
  const h=await fixture(t,config([rule('traffic_default','traffic',['A'],['a'],{threshold:80}),rule('secondary','traffic',['A'],['b'],{threshold:60})]));
  await h.db.prepare("UPDATE servers SET traffic_alert_state=? WHERE id='A'").bind(JSON.stringify({u:90*GB,th:80,lim:100})).run();
  const sent=[],send=async ch=>{sent.push(ch.id);return '';};
  for (const value of [70,95]) await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:value*GB,net_tx_monthly:0},{send});
  assert.deepEqual(sent,['b']);
});

test('correction: initial expiry observation outside the window does not swallow a future reminder', async t => {
  const h=await fixture(t,config([]));
  await h.db.prepare("UPDATE servers SET expire_date='2026-12-07' WHERE id='A'").run();
  await importNotificationConfig(h.db,config([rule('expiry','expiry',null,['a'],{days:1,hour:12})]));
  const sent=[],send=async ch=>{sent.push(ch.id);return '';};
  await checkExpiringServers(h.db,{scheduled:true,now:NOW,send});
  await checkExpiringServers(h.db,{scheduled:true,now:NOW+29*86400000,send});
  assert.equal(sent.length,1);
  await checkExpiringServers(h.db,{scheduled:true,now:NOW+29*86400000,send});
  assert.equal(sent.length,1);
});

test('correction: legal maximum traffic audiences stay consumed above the former 64KiB cap', async t => {
  const c=config(Array.from({length:64},(_,i)=>rule(`traffic-${i}`,'traffic',['A'],[],{threshold:80})));
  c.channels=Array.from({length:16},(_,i)=>({...channels[0],id:`channel_${crypto.randomUUID()}`,name:`Target ${i}`}));
  c.rules.forEach(r=>r.targetIds=c.channels.map(ch=>ch.id));
  const h=await fixture(t,c);let sends=0;const send=async()=>{sends++;return '';};
  for (const value of [90,91]) await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:value*GB,net_tx_monthly:0},{send});
  assert.equal(sends,16);
  console.log('CORRECTION_TRAFFIC_STATE_BYTES '+Buffer.byteLength((await h.server('A')).traffic_alert_state));
});

test('correction: a selected resource predicate is compact and hashed once for the entire rule', async t => {
  const h=await fixture(t,config([])),ids=Array.from({length:300},()=>crypto.randomUUID());
  await h.db.batch(ids.map(id=>h.db.prepare('INSERT INTO servers(id,name) VALUES(?,?)').bind(id,id)));
  const c=config([rule('resource','resource',ids,['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'})]);
  await h.setConfig(c);clearAllCaches();
  let hashes=0;const digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',(...args)=>{hashes++;return digest(...args);});
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(){return Response.json({results:[{ruleId:'resource',evaluatedServerIds:ids,alerts:ids.map(serverId=>({serverId,metrics:[{metric:'cpu',mode:'average',threshold:80,current:90,triggerValue:90}]})),evaluations:[]}]});}};}}};
  await checkResourceAlerts(env,{send:async()=>''});
  const stored=await h.read('resource_alert_state');assert.ok(stored);assert.equal(Object.keys(stored.servers).length,300);
  assert.ok(Buffer.byteLength(JSON.stringify(stored))<200000);
  assert.equal(hashes,1);
  console.log('CORRECTION_RESOURCE_STATE_BYTES '+Buffer.byteLength(JSON.stringify(stored))+' HASHES '+hashes);
});

test('correction: legacy full predicate signatures compact without replaying successful traffic or active resource state', async t => {
  const traffic=rule('traffic_default','traffic',['A'],['a'],{threshold:80});
  const resource=rule('resource','resource',['A'],['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'});
  const h=await fixture(t,config([traffic,resource]));
  const oldTraffic='["traffic",{"threshold":80},"selected",["A"]]';
  const oldResource='["resource",{"metric":"cpu","threshold":80,"intervalMinutes":5,"mode":"average"},"selected",["A"]]';
  await h.db.prepare("UPDATE servers SET traffic_alert_state=? WHERE id='A'").bind(JSON.stringify({schema:2,u:90*GB,th:80,lim:100,rules:{traffic_default:{u:90*GB,th:80,lim:100,signature:oldTraffic,targets:['a'],success:['a']}}})).run();
  await h.db.prepare("INSERT INTO settings VALUES('resource_alert_state',?)").bind(JSON.stringify({signature:'legacy',servers:{'resource:A':{signature:oldResource,status:'active',lastTriggeredAt:NOW,metrics:[{metric:'cpu',threshold:80,current:90}]}}})).run();
  let sends=0;const send=async()=>{sends++;return '';};
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:91*GB,net_tx_monthly:0},{send});
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(){return Response.json({results:[{ruleId:'resource',evaluatedServerIds:['A'],alerts:[{serverId:'A',metrics:[{metric:'cpu',mode:'average',threshold:80,current:90,triggerValue:90}]}],evaluations:[]}]});}};}}};
  await checkResourceAlerts(env,{send});assert.equal(sends,0);
  assert.match(JSON.parse((await h.server('A')).traffic_alert_state).rules.traffic_default.signature,/^sha256:/);
  assert.match((await h.read('resource_alert_state')).servers['resource:A'].signature,/^sha256:/);
});

test('correction: malformed and future notification JSON cannot stop independent auto-renew metadata updates', async t => {
  const h=await fixture(t,'{broken');let sends=0;
  for (const raw of ['{broken',JSON.stringify({...config([]),schema:2})]) {
    await h.db.prepare("UPDATE settings SET value=? WHERE key='notification_config'").bind(raw).run();
    await h.db.prepare("UPDATE servers SET expire_date='2026-11-09',auto_renewal='1' WHERE id='A'").run();clearAllCaches();
    await checkExpiringServers(h.db,{scheduled:true,now:NOW,send:async()=>{sends++;return '';}});
    assert.equal((await h.server('A')).expire_date,'2026-12-09');
  }
  assert.equal(sends,0);
});

test('correction: offline state removes deleted rule IDs but preserves disabled rules and legacy history', async t => {
  const h=await fixture(t,config([]));
  await h.db.prepare("INSERT INTO settings VALUES('alert_state',?)").bind(JSON.stringify({schema:2,legacy:{deleted:true},rules:{hold:{signature:'unchanged',servers:{A:true}}}})).run();
  for (let i=0;i<66;i++) {
    const hold={...rule('hold','offline',['A'],['a'],{minutes:5}),enabled:false};
    await h.setConfig(config([hold,rule(`offline-${i}`,'offline',['A'],['a'],{minutes:5})]));
    await checkOfflineNodes(h.db,{send:async()=>''});
  }
  const stored=await h.read('alert_state');assert.deepEqual(Object.keys(stored.rules),['hold','offline-65']);
  assert.deepEqual(stored.rules.hold,{signature:'unchanged',servers:{A:true}});assert.deepEqual(stored.legacy,{deleted:true});
});

test('correction: import atomically merges concurrent offline/resource/expiry/traffic state observations', async t => {
  const h=await fixture(t,config([]));
  for (const key of ['alert_state','resource_alert_state','expiry_notification_state']) await h.db.prepare('INSERT INTO settings VALUES(?,?)').bind(key,'{}').run();
  const c=config([rule('new-offline','offline',null,['a'],{minutes:5}),rule('new-resource','resource',null,['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'}),rule('new-expiry','expiry',null,['a'],{days:5,hour:12}),rule('new-traffic','traffic',null,['a'],{threshold:80})]);
  const wrapper={prepare:sql=>h.db.prepare(sql),async batch(statements){
    await h.db.prepare("UPDATE settings SET value=? WHERE key='alert_state'").bind(JSON.stringify({schema:2,legacy:{deleted:true},rules:{concurrent:{servers:{A:true}}}})).run();
    await h.db.prepare("UPDATE settings SET value=? WHERE key='resource_alert_state'").bind(JSON.stringify({signature:'concurrent',servers:{'unrelated:A':{status:'active'},'new-resource:A':{status:'active',signature:'old-predicate'}}})).run();
    await h.db.prepare("UPDATE settings SET value=? WHERE key='expiry_notification_state'").bind(JSON.stringify({concurrent:{A:'keep'}})).run();
    await h.db.prepare("UPDATE servers SET traffic_alert_state=? WHERE id='A'").bind(JSON.stringify({schema:2,u:90*GB,th:80,lim:100,rules:{concurrent:{baseline:true},'new-traffic':{u:90*GB,th:80,lim:100,signature:'["traffic",{"threshold":80},"all",[]]',targets:['a'],success:[]}}})).run();
    return h.db.batch(statements);
  }};
  await importNotificationConfig(wrapper,c);
  assert.equal((await h.read('alert_state')).rules['new-offline'].baseline,true);
  assert.deepEqual((await h.read('alert_state')).legacy,{deleted:true});
  assert.equal((await h.read('resource_alert_state')).servers['new-resource:A'].pending,true);
  assert.equal((await h.read('resource_alert_state')).servers['unrelated:A'].status,'active');
  assert.equal((await h.read('expiry_notification_state')).concurrent.A,'keep');
  assert.equal(JSON.parse((await h.server('A')).traffic_alert_state).rules.concurrent.baseline,true);
  let sends=0;const send=async()=>{sends++;return '';};
  await checkOfflineNodes(h.db,{send});await checkExpiringServers(h.db,{scheduled:true,now:NOW,send});
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:95*GB,net_tx_monthly:0},{send});
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(){return Response.json({results:[{ruleId:'new-resource',evaluatedServerIds:['A'],alerts:[{serverId:'A',metrics:[{metric:'cpu',mode:'average',threshold:80,current:90,triggerValue:90}]}],evaluations:[]}]});}};}}};
  await checkResourceAlerts(env,{send});assert.equal(sends,0);
});

test('correction: an import batch failure rolls back its config and all baseline writes', async t => {
  const h=await fixture(t,config([]));const before=await h.read('notification_config');
  const c=config([rule('offline','offline',null,['a'],{minutes:5}),rule('traffic','traffic',null,['a'],{threshold:80})]);
  const wrapper={prepare:sql=>h.db.prepare(sql),batch:statements=>h.db.batch([...statements,h.db.prepare("SELECT json('invalid-json')")])};
  await assert.rejects(importNotificationConfig(wrapper,c));
  assert.deepEqual(await h.read('notification_config'),before);assert.equal(await h.read('alert_state'),null);
  assert.equal((await h.server('A')).traffic_alert_state,null);
});

test('correction: a competing config writer cannot lose state to a stale imported baseline', async t => {
  const h=await fixture(t,config([]));const winner={...config([]),revision:2};
  const wrapper={prepare:sql=>h.db.prepare(sql),async batch(statements){await h.setConfig(winner);return h.db.batch(statements);}};
  await assert.rejects(importNotificationConfig(wrapper,config([rule('offline','offline',null,['a'],{minutes:5})])),{code:'notification_revision_conflict'});
  assert.deepEqual(await h.read('notification_config'),winner);assert.equal(await h.read('alert_state'),null);
});

test('correction: selected expiry state also keeps one compact predicate per event rather than a copied scope', async t => {
  const h=await fixture(t,config([])),ids=Array.from({length:300},()=>crypto.randomUUID());
  await h.db.batch(ids.map(id=>h.db.prepare("INSERT INTO servers(id,name,expire_date) VALUES(?,?,'2026-11-08')").bind(id,id)));
  await h.setConfig(config([rule('expiry','expiry',ids,['a'],{days:5,hour:12})]));clearAllCaches();
  let hashes=0,sends=0;const digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',(...args)=>{hashes++;return digest(...args);});
  await checkExpiringServers(h.db,{scheduled:true,now:NOW,send:async()=>{sends++;return '';}});
  const stored=await h.read('expiry_notification_state');assert.ok(stored);assert.equal(Object.keys(stored.expiry).length,300);
  assert.ok(Buffer.byteLength(JSON.stringify(stored))<100000);assert.equal(hashes,1);assert.ok(sends>0);
  console.log('CORRECTION_EXPIRY_STATE_BYTES '+Buffer.byteLength(JSON.stringify(stored))+' HASHES '+hashes);
});

test('correction: compacting a legacy full expiry identity does not replay its daily reminder', async t => {
  const h=await fixture(t,config([rule('expiry','expiry',['A'],['a'],{days:5,hour:12})]));
  const old='["expiry",{"days":5,"hour":12},"selected",["A"]]';
  await h.db.prepare("INSERT INTO settings VALUES('expiry_notification_state',?)").bind(JSON.stringify({expiry:{A:JSON.stringify(['expiring',Math.floor(NOW/86400000),'2026-11-09',old])}})).run();
  let sends=0;await checkExpiringServers(h.db,{scheduled:true,now:NOW,send:async()=>{sends++;return '';}});
  assert.equal(sends,0);assert.ok((await h.read('expiry_notification_state')).expiry.A.includes('sha256:'));
});

test('correction: an already consumed maximum-size legacy traffic row compacts without deliveries', async t => {
  const c=config(Array.from({length:64},(_,i)=>rule(`traffic-${i}`,'traffic',['A'],[],{threshold:80})));
  c.channels=Array.from({length:16},(_,i)=>({...channels[0],id:`channel_${crypto.randomUUID()}`,name:`Target ${i}`}));
  const targets=c.channels.map(ch=>ch.id);c.rules.forEach(r=>r.targetIds=targets);
  const h=await fixture(t,c);
  const legacy={schema:2,u:90*GB,th:80,lim:100,rules:Object.fromEntries(c.rules.map(r=>[r.id,{u:90*GB,th:80,lim:100,signature:'["traffic",{"threshold":80},"selected",["A"]]',targets,success:targets}]))};
  assert.ok(Buffer.byteLength(JSON.stringify(legacy))>65536);
  await h.db.prepare("UPDATE servers SET traffic_alert_state=? WHERE id='A'").bind(JSON.stringify(legacy)).run();
  let sends=0;const send=async()=>{sends++;return '';};
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:91*GB,net_tx_monthly:0},{send});
  const compact=(await h.server('A')).traffic_alert_state;
  assert.ok(Object.values(JSON.parse(compact).rules).every(r=>r.signature.startsWith('sha256:')));
  await evaluateTrafficAlert({DB:h.db},await h.server('A'),{net_rx_monthly:92*GB,net_tx_monthly:0},{send});
  assert.equal((await h.server('A')).traffic_alert_state,compact);assert.equal(sends,0);
});

test('correction: the full 1000-node selected scope persists with one hash and normal metric batches', async t => {
  const h=await fixture(t,config([])),ids=Array.from({length:1000},()=>crypto.randomUUID());
  await h.db.batch(ids.map(id=>h.db.prepare('INSERT INTO servers(id,name) VALUES(?,?)').bind(id,id)));
  await h.setConfig(config([rule('resource','resource',ids,['a'],{metric:'cpu',threshold:80,intervalMinutes:5,mode:'average'})]));clearAllCaches();
  let hashes=0;const digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',(...args)=>{hashes++;return digest(...args);});
  const requested=[];
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {async fetch(url,options){const body=JSON.parse(options.body);requested.push(...body.rules.flatMap(r=>r.serverIds));return Response.json({results:body.rules.map(r=>({ruleId:r.ruleId,evaluatedServerIds:r.serverIds,alerts:r.serverIds.map(serverId=>({serverId,metrics:[{metric:'cpu',mode:'average',threshold:80,current:90,triggerValue:90}]})),evaluations:[]}))});}};}}};
  await checkResourceAlerts(env,{send:async()=>''});
  const stored=await h.read('resource_alert_state');assert.ok(stored);assert.equal(Object.keys(stored.servers).length,1000);
  assert.equal(requested.length,1000);assert.deepEqual(new Set(requested),new Set(ids));assert.equal(hashes,1);assert.ok(Buffer.byteLength(JSON.stringify(stored))<512000);
  console.log('CORRECTION_RESOURCE_1000_BYTES '+Buffer.byteLength(JSON.stringify(stored))+' HASHES '+hashes);
});

test('correction: observing a node without an expiry date clears import suppression before a date is added', async t => {
  const h=await fixture(t,config([]));await h.db.prepare("UPDATE servers SET expire_date='' ").run();
  await importNotificationConfig(h.db,config([rule('expiry','expiry',null,['a'],{days:1,hour:12})]));
  let sends=0;const send=async()=>{sends++;return '';};
  await checkExpiringServers(h.db,{scheduled:true,now:NOW,send});
  await h.db.prepare("UPDATE servers SET expire_date='2026-11-09' WHERE id='A'").run();clearAllCaches();
  await checkExpiringServers(h.db,{scheduled:true,now:NOW+86400000,send});assert.equal(sends,1);
});
