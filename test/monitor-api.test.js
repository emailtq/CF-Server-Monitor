import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { generateToken } from '../src/middleware/auth.js';
import { createHistoryTableSql } from '../src/utils/historyFields.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { ensureMonitorTelemetrySchema, recordMonitorBatch, maintainMonitorTelemetry } from '../src/database/monitorTelemetry.js';
import { frame, sample, session, principal } from './helpers/monitorTelemetry.js';
import { loadMonitorCompatSnapshot } from '../src/services/monitorCompatSnapshot.js';
import { loadMonitorStandardHistory } from '../src/services/monitorCompatHistory.js';
import { projectMonitorNode, stringifyMonitor } from '../src/services/monitorProjection.js';

const origin = 'https://s1.example.test';
const secret = 's1-local-only-jwt-secret-that-is-at-least-32-characters';
const bundle = build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] });
async function fixture(t, { zero = true } = {}) {
  const mf = new Miniflare({ modules: true, script: (await bundle).outputFiles[0].text,
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 's1-api' }, durableObjects: { METRICS_BROADCASTER: { className: 'MetricsBroadcaster', useSQLite: true } } });
  const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); await mf.dispose(); });
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)'),
    db.prepare(`CREATE TABLE servers(id TEXT PRIMARY KEY,name TEXT,sort_order INTEGER DEFAULT 0,is_hidden TEXT DEFAULT '0',server_group TEXT,region TEXT,history_partition_id INTEGER,timestamp INTEGER DEFAULT 0,price TEXT,currency TEXT,billing_cycle TEXT,expire_date TEXT,traffic_limit TEXT,traffic_calc_type TEXT,reset_day INTEGER,public_remark TEXT,note TEXT)`),
    db.prepare(createHistoryTableSql('metrics_history')),
    db.prepare('CREATE TABLE terminal_nodes(server_id TEXT PRIMARY KEY,token_version INTEGER)'),
    db.prepare("INSERT INTO servers(id,name,history_partition_id,reset_day,public_remark,note,expire_date) VALUES('uuid-a','A',777,1,'public tag','PRIVATE NOTE','2026-12-31'),('hidden','Hidden',778,1,'hidden tag','secret',NULL)"),
    db.prepare("UPDATE servers SET is_hidden='1' WHERE id='hidden'"),
    db.prepare("INSERT INTO terminal_nodes VALUES('uuid-a',1)"),
    db.prepare('INSERT INTO settings VALUES(?,?)').bind('site_options', JSON.stringify({ is_public: 'true', jwt_secret: secret })),
    db.prepare('INSERT INTO settings VALUES(?,?)').bind('latency_tasks', JSON.stringify({version:1,revision:1,tasks:[{id:'p_a',metric_id:'p_a',name:'Local probe',nodes:['uuid-a'],target:'secret.example:123',interval:60}]}))
  ]);
  await ensureMonitorTelemetrySchema(db);
  const now = Math.floor(Date.now()/60000)*60000;
  const report = rx => ({...sample(rx,now),report:{...sample(rx,now).report,uptime:60,load:[1,2,3],mem_total:1000,mem_used:250,swap_total:0,swap_used:0,disk_total:2000,disk_used:500,net_rx:10,net_tx:20,tcp:1,udp:2,procs:3}});
  await recordMonitorBatch({DB:db},principal,session({facts:{os:'Debian',virt:'kvm',cpu_cores:2,ipv4:'192.0.2.9',hostname:'private-host'}}),frame(1,{samples:[{...report('10'),elapsedMs:1000,report:{...report('10').report,cpu:100}},{...report('20'),sampledAt:now+1000,elapsedMs:59000,report:{...report('20').report,cpu:0}}],probes:(zero ? [10,20,-1,0] : [10,20,-1]).map((latencyMs,i)=>({taskId:1,metricId:'p_a',sampledAt:now+i*1000,latencyMs}))}));
  const getState = async () => JSON.parse((await db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='uuid-a'").first()).state);
  const saveState = state => db.prepare("UPDATE monitor_telemetry_nodes SET state=?,revision=revision+1 WHERE server_id='uuid-a'").bind(JSON.stringify(state)).run();
  const auth = { Cookie: `cfsm_auth=${await generateToken({}, {jwt_secret:secret})}` };
  return {db,mf,now,getState,saveState,auth,
    fetch: (path,options) => mf.dispatchFetch(origin+path,options),
    async socket(headers={}) {
      const url = new URL('/api/ws?monitor_protocol=1',await mf.ready); url.protocol='ws:';
      const ws = new WebSocket(url,{headers:{'MF-Original-URL':origin+'/api/ws?monitor_protocol=1',...headers}}); sockets.push(ws);
      const messages=[]; ws.on('message',data=>messages.push(data.toString()));
      await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
      return {ws,messages};
    }
  };
}
async function wait(predicate) { for(let i=0;i<650;i++){const value=predicate();if(value)return value;await sleep(25)}assert.fail('socket outcome timeout'); }
function evidence(name,value) { if(process.env.CFSM_S1_EVIDENCE)writeFileSync(`${process.env.CFSM_S1_EVIDENCE}/S1-${name}.json`,JSON.stringify(value,null,2)); }

test('actual HTTP and WS keep exact number tokens, full month and public facts without secrets',async t=>{
  const h=await fixture(t),state=await h.getState();
  Object.assign(state.traffic,{totalRx:'9007199254740993',totalTx:'9223372036854775807',monthRx:'9007199254740993',monthTx:'7',dayRx:'3',dayTx:'4'});
  await h.saveState(state);
  const response=await h.fetch('/api/nodes'),raw=await response.text(); assert.equal(response.status,200);
  assert.match(raw,/"total_rx":9007199254740993(?:[,}])/); assert.match(raw,/"total_tx":9223372036854775807(?:[,}])/);
  assert.match(raw,/"month_used":9007199254741000(?:[,}])/);
  const node=JSON.parse(raw).nodes[0]; assert.equal(node.public_remark,'public tag'); assert.equal(node.virt,'kvm'); assert.equal(node.day_rx,3);
  const consumer = await build({entryPoints:['.planning/2026-11-20-monitor-theme-api/ecosystem-20261123/samples/jikasei/source/src/lib/summary.ts'],bundle:true,write:false,format:'esm',platform:'node'});
  const {summarize} = await import('data:text/javascript;base64,'+Buffer.from(consumer.outputFiles[0].text).toString('base64'));
  assert.equal(summarize([node]).dayRx,3);assert.equal(summarize([node]).dayTx,4,'actual JIKASEI summary consumes native daily values');
  assert.equal(typeof node.expires_in,'number'); assert.doesNotMatch(raw,/PRIVATE NOTE|192\.0\.2|private-host|secret\.example|net_rx_total/);
  const sequence=[];
  for(const value of ['0','1','9007199254740992','9007199254740993','9223372036854775806','9223372036854775807']){
    const next=await h.getState();Object.assign(next.traffic,{totalRx:value,totalTx:value,monthRx:value,monthTx:value,dayRx:value,dayTx:value});await h.saveState(next);
    const text=await (await h.fetch('/api/nodes')).text();assert.match(text,new RegExp(`"total_rx":${value}(?:[,}])`));assert.match(text,new RegExp(`"day_tx":${value}(?:[,}])`));sequence.push(text);
  }
  await h.saveState(state);evidence('http-number-series',{sequence});
  const socket=await h.socket(),wire=await wait(()=>socket.messages[0]); assert.match(wire,/"total_rx":9007199254740993(?:[,}])/); assert.match(wire,/"total_tx":9223372036854775807(?:[,}])/);
  evidence('numeric-wire',{http:raw,ws:wire});
  const unknown=await h.getState(); unknown.migration.knownMonth={rx:'1000.5',tx:'2',exactBaseline:false,monthStart:unknown.traffic.monthStart}; unknown.traffic.monthRx='1'; unknown.traffic.monthTx='0'; await h.saveState(unknown);
  const unknownNode=(await (await h.fetch('/api/nodes')).json()).nodes[0]; assert.equal(unknownNode.month_rx,null); assert.equal(unknownNode.month_used,null); assert.equal(unknownNode.metrics.month_rx,null);
  assert.equal(unknownNode.traffic_source.month,'unknown-legacy-baseline');
  const unknownWire=await wait(()=>socket.messages.find(text=>JSON.parse(text).nodes[0]?.month_rx===null));
  assert.match(unknownWire,/"month_rx":null/);
  const again=await h.socket(); assert.match(await wait(()=>again.messages[0]),/"month_rx":null/);
  await h.db.prepare("UPDATE servers SET is_hidden='1' WHERE id='uuid-a'").run();
  await wait(()=>socket.messages.find(text=>JSON.parse(text).nodes.length===0));
  evidence('ws-lifecycle',{initial:wire,unknown:unknownWire,reconnected:again.messages[0],hidden:socket.messages.at(-1)});
});

test('logout tombstone removes private standard REST access and closes an already open viewer',async t=>{
  const h=await fixture(t);
  await h.db.prepare("UPDATE settings SET value=json_set(value,'$.is_public','false') WHERE key='site_options'").run();
  const token=h.auth.Cookie.slice('cfsm_auth='.length),payload=JSON.parse(Buffer.from(token.split('.')[1],'base64').toString());
  await h.db.prepare('CREATE TABLE terminal_auth_sessions(jti TEXT PRIMARY KEY,expires_at INTEGER,revoked_at INTEGER)').run();
  assert.equal((await h.fetch('/api/nodes',{headers:h.auth})).status,200);
  const socket=await h.socket(h.auth);await wait(()=>socket.messages[0]);let closed=false;socket.ws.on('close',()=>{closed=true});
  await h.db.prepare('INSERT INTO terminal_auth_sessions VALUES(?,?,?)').bind(payload.jti,payload.exp,Date.now()).run();
  assert.equal((await h.fetch('/api/nodes',{headers:h.auth})).status,401);
  await wait(()=>closed);evidence('revocation',{rest:401,socketClosed:closed});
});

test('actual long history retains hour rollup weights and zero-ms raw probes; old summary loss stays unknown',async t=>{
  const h=await fixture(t),id=(await (await h.fetch('/api/nodes')).json()).nodes[0].id;
  const old=h.now-10*86400000;
  await recordMonitorBatch({DB:h.db},principal,session(),frame(2,{samples:[{...sample('5',old),elapsedMs:1000,report:{...sample('5',old).report,cpu:100}},{...sample('6',old+1000),elapsedMs:59000,report:{...sample('6',old).report,cpu:0}}],probes:[10,20,-1].map((latencyMs,i)=>({taskId:1,metricId:'p_a',sampledAt:old+i*1000,latencyMs}))}));
  await maintainMonitorTelemetry(h.db,{now:h.now});
  const body=await (await h.fetch(`/api/nodes/${id}/metrics?hours=720`,{headers:h.auth})).json();
  const past=body.metrics.find(p=>p.ts<=old/1000 && p.ts+body.step>old/1000);
  assert.ok(past);assert.ok(Math.abs(past.cpu-100/60)<1e-10);assert.equal(past.cpu_max,100);assert.equal(past.minutes,1);
  assert.equal(body.coverage.rawAvailable,false);assert.ok(body.ping.some(p=>p.latency===15));
  evidence('rollup',body);
});

test('standard legacy history reports unknown denominators rather than zero loss',async t=>{
  const h=await fixture(t),id=(await (await h.fetch('/api/nodes')).json()).nodes[0].id;
  await h.db.prepare("DELETE FROM settings WHERE key='latency_tasks'").run();
  const ts=h.now-600000;
  await h.db.prepare('INSERT INTO metrics_history(id,server_id,timestamp,ping_ct,loss_ct) VALUES(?,?,?,?,?)').bind(buildHistoryId(777,ts),'uuid-a',ts,10,100).run();
  const body=await (await h.fetch(`/api/nodes/${id}/metrics?hours=1&series=ping`)).json();
  assert.ok(body.ping.some(p=>p.loss===100));assert.ok(Object.values(body.loss).includes(null));
  evidence('unknown-denominator',body);
});

test('actual history exposes weighted mean/peak/minutes and real loss, median band and zero-ms success',async t=>{
  const h=await fixture(t),response=await h.fetch('/api/nodes'); const id=(await response.json()).nodes[0].id;
  const body=await (await h.fetch(`/api/nodes/${id}/metrics?hours=1`)).json();
  assert.ok(Math.abs(body.metrics[0].cpu-100/60)<1e-10); assert.equal(body.metrics[0].cpu_max,100); assert.equal(body.metrics[0].minutes,1);
  assert.equal(body.loss['1'],25); assert.equal(body.ping[0].latency,10); assert.deepEqual(body.ping[0].band,[0,20]); assert.equal(body.ping[0].loss,25);
  assert.equal(Number(body.loss['1']??0),25,'JIKASEI/KANSO fallback sees the actual loss');
  assert.doesNotMatch(JSON.stringify(body),/secret\.example/); evidence('history',body);
});

test('actual HTTP three probes use three attempts and successful mean15, not average loss percentages',async t=>{
  const h=await fixture(t,{zero:false});await h.fetch('/api/nodes');
  const body=await (await h.fetch('/api/nodes/1/metrics?hours=1&series=ping')).json();
  assert.ok(Math.abs(body.loss['1']-100/3)<1e-10);assert.deepEqual(body.attempts['1'],{attempts:3,timeouts:1,mean:15});
  assert.equal(body.ping[0].latency,15);assert.equal(body.ping[0].loss,34);evidence('probe-three',body);
});

test('standard CF show switches mask native traffic, price and expiry without hiding network rates',async t=>{
  const h=await fixture(t);await h.db.prepare("UPDATE settings SET value=json_set(value,'$.show_tf','false','$.show_expire','false','$.show_price','false') WHERE key='site_options'").run();
  const node=(await (await h.fetch('/api/nodes')).json()).nodes[0];
  assert.equal(node.total_rx,0);assert.equal(node.month_rx,0);assert.equal(node.expires_at,null);assert.equal(node.expires_in,null);assert.equal(node.price,0);
  assert.equal(node.metrics.net_rx,10);assert.equal(node.metrics.total_rx,0);assert.doesNotMatch(JSON.stringify(node),/192\.0\.2|private-host/);
});

test('identity limits history separately from real raw7/hour30 coverage and no secret settings reads',async t=>{
  const h=await fixture(t),id=(await (await h.fetch('/api/nodes')).json()).nodes[0].id;
  const anonymous=await (await h.fetch('/api/me')).json(),admin=await (await h.fetch('/api/me',{headers:h.auth})).json();
  assert.equal(anonymous.history_days,1); assert.equal(admin.history_days,30); assert.equal(admin.site,'');
  const old=h.now-25*3600000;
  await recordMonitorBatch({DB:h.db},principal,session(),frame(2,{samples:[sample('30',old)],probes:[]}));
  const path=`/api/nodes/${id}/metrics?hours=168&series=metrics`;
  const limited=await (await h.fetch(path)).json(),wide=await (await h.fetch(path,{headers:h.auth})).json();
  assert.ok(limited.metrics.every(p=>p.ts>old/1000)); assert.ok(wide.metrics.some(p=>p.ts<=old/1000 && p.ts+wide.step>old/1000),'the aligned bucket retains the 25-hour sample');
  assert.equal(wide.coverage.rawRetentionDays,7); assert.equal(wide.coverage.rollupRetentionDays,30); assert.equal(wide.coverage.accessDays,30);
  await h.db.prepare("UPDATE servers SET is_hidden='1' WHERE id='uuid-a'").run();
  assert.equal((await h.fetch(path,{headers:h.auth})).status,404);
  evidence('access',{anonymous,admin,limited,wide});
});

test('standard projection calendar, null and receiver freshness do not invent facts or extend online',async t=>{
  const h=await fixture(t),state=await h.getState();
  state.receivedAt=h.now-301000;state.latest.sampledAt=h.now+7*86400000;
  state.traffic.dayStart='2026-10-01';state.traffic.dayRx='42';state.traffic.monthStart='2026-10-01';state.traffic.monthRx='99';
  await h.saveState(state);
  const node=(await (await h.fetch('/api/nodes')).json()).nodes[0];
  assert.equal(node.online,false);assert.equal(node.metrics,null);assert.equal(node.last_seen,Math.floor(state.receivedAt/1000));
  assert.equal(node.day_rx,0);assert.equal(node.month_rx,0);assert.equal(node.month_start,new Date().toISOString().slice(0,7)+'-01');
});

test('standard missing ledger and wire errors stay unknown and expose usable HTTP failures',async t=>{
  const h=await fixture(t),state=await h.getState();delete state.traffic;await h.saveState(state);
  const node=(await (await h.fetch('/api/nodes')).json()).nodes[0];
  assert.equal(node.total_rx,null);assert.equal(node.month_rx,null);assert.equal(node.day_rx,null);
  const bad=await h.fetch('/api/nodes/1/metrics?hours=abc');assert.equal(bad.status,400);assert.match(bad.headers.get('Content-Type'),/^text\/plain/);
  await h.db.prepare("UPDATE settings SET value=json_set(value,'$.is_public','false') WHERE key='site_options'").run();
  const denied=await h.fetch('/api/nodes');assert.equal(denied.status,401);assert.match(denied.headers.get('Content-Type'),/^text\/plain/);
});

test('standard wire preserves an independent integer series and saturating month sum',()=>{
  const values=['0','1','9007199254740992','9007199254740993','9223372036854775806','9223372036854775807'];
  const wire=[];
  for(const value of values){
    const persisted={timestamp:Date.UTC(2026,10,25),monitor:{traffic:{totalRx:value,totalTx:value,dayRx:value,dayTx:value,dayStart:'2026-11-25'},month:{rx:value,tx:value,periodStart:'2026-11-01'}}};
    const node=projectMonitorNode({server:{id:'a',reset_day:1},id:1,persisted},{display:{showTraffic:true}},Date.UTC(2026,10,25));
    const raw=stringifyMonitor(node);assert.match(raw,new RegExp(`"total_rx":${value}(?:[,}])`));assert.match(raw,new RegExp(`"day_rx":${value}(?:[,}])`));wire.push(raw);
  }
  assert.match(wire.at(-1),/"month_used":9223372036854775807[,}]/);evidence('numeric-series',{values,wire});
});

test('standard old incomplete counters remain unknown instead of fabricated zero',()=>{
  const node=JSON.parse(stringifyMonitor(projectMonitorNode({server:{id:'a'},id:1,persisted:{timestamp:1,net_rx:0}},{display:{showTraffic:true}},1000)));
  assert.equal(node.total_rx,0);assert.equal(node.total_tx,null);assert.equal(node.month_rx,null);assert.equal(node.day_rx,null);
});

test('legacy standard live metrics repeat the same nullable traffic values as the node',()=>{
  const now=Date.UTC(2026,10,25),persisted={timestamp:now,boot_time:String(now-60000),cpu:2,load_avg:'1 2 3',ram_total:1,ram_used:1,swap_total:0,swap_used:0,disk_total:1,disk_used:1,net_in_speed:1,net_out_speed:2,tcp_conn:1,udp_conn:2,processes:3};
  const node=JSON.parse(stringifyMonitor(projectMonitorNode({server:{id:'a'},id:1,persisted},{display:{showTraffic:true}},now+1000)));
  assert.equal(node.metrics.total_rx,null);assert.equal(node.metrics.month_rx,null);
});

test('fresher live resource cache does not overwrite the newly committed complete ledger',()=>{
  const now=Date.UTC(2026,10,25),old={traffic:{totalRx:'10',totalTx:'0',dayRx:'10',dayTx:'0',dayStart:'2026-11-25'},month:{rx:'10',tx:'0',periodStart:'2026-11-01'}};
  const persisted={timestamp:now,monitor:{...old,traffic:{...old.traffic,totalRx:'20'},month:{...old.month,rx:'20'}}};
  const node=JSON.parse(stringifyMonitor(projectMonitorNode({server:{id:'a',reset_day:1},id:1,persisted,latest:{timestamp:now+1,data:{timestamp:now+1,cpu:77,monitor:old}}},{display:{showTraffic:true}},now+1)));
  assert.equal(node.total_rx,20);assert.equal(node.month_rx,20);assert.equal(node.metrics.cpu,77);
});

test('actual D1 read costs distinguish latest snapshot from one-node indexed history',async t=>{
  const h=await fixture(t);let costs={reads:0,writes:0,statements:0};
  await h.fetch('/api/nodes');
  const capture=result=>{costs.statements++;costs.reads+=result?.meta?.rows_read||0;costs.writes+=result?.meta?.rows_written||0;return result};
  const db={prepare(sql){const wrap=stmt=>({bind(...args){return wrap(stmt.bind(...args))},async all(){return capture(await stmt.all())},async first(){const result=capture(await stmt.all());return result.results[0]||null},async run(){return capture(await stmt.run())},_stmt:stmt});return wrap(h.db.prepare(sql))},async batch(stmts){return (await h.db.batch(stmts.map(s=>s._stmt))).map(capture)}};
  await loadMonitorCompatSnapshot({DB:db},{display:{showTraffic:true},latestReportUpdates:[],standard:true});const snapshot={...costs};
  costs={reads:0,writes:0,statements:0};await loadMonitorStandardHistory(db,1,new URLSearchParams('hours=24'));const history={...costs};
  evidence('read-cost',{nodes:1,resources:2,probes:4,snapshot,history,frame:'two projections on one cached latest baseline; no raw query every frame',refreshSeconds:10});
  assert.equal(snapshot.writes,0);assert.equal(history.writes,0);
});

