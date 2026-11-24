import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createMonitorRuntimeFixture } from './fixtures/monitor-runtime.mjs';
import { packMonitorBucket } from '../src/shared/monitorTelemetry.js';
import { clearAllCaches } from '../src/utils/cache.js';

const now=Date.UTC(2026,10,25,12),old=now-8*86400000;
const rawStatement=Symbol('rawStatement');

async function setup(t) {
  clearAllCaches();t.after(clearAllCaches);
  const h=await createMonitorRuntimeFixture(t);
  await h.db.batch([
    h.db.prepare("INSERT INTO terminal_audit(server_id,event,created_at) VALUES('node-a','old',?),('node-a','current',?)").bind(old,now),
    h.db.prepare("INSERT INTO terminal_auth_sessions(jti,expires_at) VALUES('expired',?),('current',?)").bind(Math.floor(old/1000),Math.floor(now/1000)+3600),
    h.db.prepare("INSERT INTO login_events(id,type,payload,targets,policy_revision,created_at) VALUES('old','sshLogin','{}','[]',1,?),('current','sshLogin','{}','[]',1,?)").bind(old,now),
    h.db.prepare("INSERT INTO login_event_deliveries(delivery_key,event_id,channel_id,rules,state,updated_at) VALUES('old','old','fixture','[]','sent',?),('current','current','fixture','[]','pending',?)").bind(old,now)
  ]);
  const raw=(await packMonitorBucket([{sampledAt:old,elapsedMs:1000,report:{cpu:12},extra:{},network:null}],[]))[0];
  await h.db.prepare(`INSERT INTO monitor_telemetry_buckets(server_id,token_version,stream,sequence,part,bucket_start,min_ts,max_ts,payload)
    VALUES('node-a',1,'cleanup',1,0,?,?,?,?)`).bind(old,old,old,raw).run();
  t.mock.timers.enable({apis:['Date'],now});
  return h;
}

function tracedDb(db,beforeBatch=async()=>{}) {
  const calls=[];
  const wrap=(statement,sql)=>new Proxy(statement,{get(s,key) {
    if(key===rawStatement)return {statement:s,sql};
    if(key==='bind')return (...values)=>wrap(s.bind(...values),sql);
    if(['all','first','run'].includes(key))return async(...args)=>{calls.push(sql);return s[key](...args);};
    return typeof s[key]==='function'?s[key].bind(s):s[key];
  }});
  return {calls,DB:{prepare:sql=>wrap(db.prepare(sql),sql),batch:async statements=>{
    const raw=statements.map(s=>s[rawStatement]);calls.push(...raw.map(s=>s.sql));
    await beforeBatch(raw.map(s=>s.sql));return db.batch(raw.map(s=>s.statement));
  }}};
}
async function assertCleaned(h,calls) {
  assert.deepEqual((await h.db.prepare('SELECT event FROM terminal_audit').all()).results,[{event:'current'}]);
  assert.deepEqual((await h.db.prepare('SELECT jti FROM terminal_auth_sessions').all()).results,[{jti:'current'}]);
  assert.deepEqual((await h.db.prepare('SELECT id FROM login_events').all()).results,[{id:'current'}]);
  assert.deepEqual((await h.db.prepare('SELECT delivery_key FROM login_event_deliveries').all()).results,[{delivery_key:'current'}]);
  const audit=calls.findIndex(sql=>sql.startsWith('DELETE FROM terminal_audit'));
  const auth=calls.findIndex(sql=>sql.startsWith('DELETE FROM terminal_auth_sessions'));
  const login=calls.findIndex(sql=>sql.startsWith('DELETE FROM login_event_deliveries'));
  assert.ok(audit>=0 && auth>audit && login>auth,'original terminal audit -> auth -> login cleanup executes in order');
}
const maintenanceCalls=calls=>calls.filter(sql=>sql.startsWith('SELECT server_id,token_version,stream,sequence,part,max_ts,length(payload)'));

test('actual hourly scheduled D1 rollup failure stops monitor without skipping terminal and login retention',async t=> {
  const h=await setup(t),trace=tracedDb(h.db),errors=[];
  await h.db.prepare("CREATE TRIGGER fail_monitor_rollup BEFORE INSERT ON monitor_telemetry_rollups BEGIN SELECT RAISE(ABORT,'injected monitor rollup D1 failure');END").run();
  t.mock.method(console,'error',(...args)=>errors.push(args));
  await worker.scheduled({cron:'0 * * * *'},{DB:trace.DB},{});
  assert.equal(errors.length,1);assert.match(errors[0][1].message,/injected monitor rollup D1 failure/);
  assert.equal(maintenanceCalls(trace.calls).length,1,'failed chunk must not retry');
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_buckets').first()).n,1);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_rollups').first()).n,0);
  await assertCleaned(h,trace.calls);
  assert.equal(errors[0][0],'[Monitor] Retention cleanup failed:');
  t.diagnostic(JSON.stringify({failure:errors[0][1].message,monitorChunks:1,rawRetained:1,rollups:0,terminalAndLoginCleaned:true}));
});

test('actual hourly scheduled rollup revision CAS failure rolls back raw and still runs terminal then login cleanup once',async t=> {
  const h=await setup(t),hour=Math.floor(old/3600000)*3600000,empty=(await packMonitorBucket([],[]))[0];
  await h.db.prepare('INSERT INTO monitor_telemetry_rollups VALUES(?,?,?,?)').bind('node-a',hour,1,empty).run();
  let races=0;const errors=[];
  const trace=tracedDb(h.db,async sqls=>{
    if(sqls.some(sql=>sql.startsWith('INSERT INTO monitor_telemetry_rollups'))) {
      races++;await h.db.prepare('UPDATE monitor_telemetry_rollups SET revision=revision+1 WHERE server_id=? AND hour_start=?').bind('node-a',hour).run();
    }
  });
  t.mock.method(console,'error',(...args)=>errors.push(args));
  await worker.scheduled({cron:'0 * * * *'},{DB:trace.DB},{});
  assert.equal(races,1);assert.equal(errors.length,1);
  assert.match(errors[0][1].message,/NOT NULL constraint failed: monitor_telemetry_rollups.revision/);
  assert.equal(maintenanceCalls(trace.calls).length,1);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_buckets').first()).n,1);
  assert.equal((await h.db.prepare('SELECT revision FROM monitor_telemetry_rollups').first()).revision,2);
  await assertCleaned(h,trace.calls);
  t.diagnostic(JSON.stringify({failure:errors[0][1].message,concurrentRevision:2,monitorChunks:1,rawRetained:1,terminalAndLoginCleaned:true}));
});

test('actual hourly scheduled keeps twenty successful monitor chunks bounded with backlog before terminal and login cleanup',async t=> {
  const h=await setup(t);
  // Immutable same-layout raw fixture clones create 2521 fragments, without changing production limits.
  await h.db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM seq WHERE n<2521)
    INSERT INTO monitor_telemetry_buckets SELECT server_id,token_version,stream,n,part,bucket_start,min_ts,max_ts,payload
    FROM monitor_telemetry_buckets,seq WHERE sequence=1`).run();
  const trace=tracedDb(h.db),errors=[];t.mock.method(console,'error',(...args)=>errors.push(args));
  await worker.scheduled({cron:'0 * * * *'},{DB:trace.DB},{});
  assert.deepEqual(errors,[]);assert.equal(maintenanceCalls(trace.calls).length,20);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_buckets').first()).n,121);
  const rollup=await h.db.prepare('SELECT revision FROM monitor_telemetry_rollups').first();assert.equal(rollup.revision,20);
  await assertCleaned(h,trace.calls);
  t.diagnostic(JSON.stringify({inputFragments:2521,monitorChunks:20,remaining:121,rollupRevision:20,terminalAndLoginCleaned:true}));
});

test('actual hourly scheduled stops after a completed monitor chunk before preserving terminal then login cleanup',async t=> {
  const h=await setup(t),trace=tracedDb(h.db),errors=[];t.mock.method(console,'error',(...args)=>errors.push(args));
  await worker.scheduled({cron:'0 * * * *'},{DB:trace.DB},{});
  assert.deepEqual(errors,[]);assert.equal(maintenanceCalls(trace.calls).length,1);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM monitor_telemetry_buckets').first()).n,0);
  await assertCleaned(h,trace.calls);
  t.diagnostic(JSON.stringify({monitorChunks:1,remaining:0,terminalAndLoginCleaned:true}));
});
