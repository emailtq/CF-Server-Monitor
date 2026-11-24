import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorRuntimeFixture,send,frames,until } from './fixtures/monitor-runtime.mjs';
import { frame,sample } from './helpers/monitorTelemetry.js';
import { handleServerAPI,handleServersAPI } from '../src/handlers/dashboard.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
import { createSuccessResponse } from '../src/utils/errors.js';
import { coerceNumericMetricFields } from '../src/utils/metrics.js';
import { getLatestMetrics,getLatestMetricsForAllServers,getLatestTimestampsForAllServers,getMetricsHistory } from '../src/database/schema.js';
import { readMonitorTelemetry,readMonitorHistoryRows,projectMonitorLatest } from '../src/database/monitorTelemetry.js';
import { checkOfflineNodes } from '../src/services/notification.js';
import { clearAllCaches } from '../src/utils/cache.js';

const counters=['net_rx','net_tx','net_rx_monthly','net_tx_monthly'];
const exact={net_rx:'9007199254740993',net_tx:'9007199254740995',net_rx_monthly:'9007199254740993',net_tx_monthly:'9007199254740995'};
function checkTokens(text,metric,expected=exact) {
  for(const field of counters) {
    assert.equal(typeof metric[field],expected[field]===null ? 'object' : 'number',field);
    assert.equal(metric[field]===null,expected[field]===null,field);
    assert.match(text,new RegExp(`"${field}":${expected[field]===null ? 'null' : expected[field]}(?:[,}])`),field);
  }
}
async function native(t) {
  const h=await createMonitorRuntimeFixture(t),peer=await h.socket();
  send(peer,'cf.capabilities',{version:1,supports:[{method:'cf.report.batch',version:1}]},'cap');
  await until(()=>frames(peer).some(f=>f.id==='cap'));
  send(peer,'hello',{ipv4:'192.0.2.42',ipv6:'2001:db8::42'});await h.control('drain');
  const ts=Date.now();
  peer.ws.send(frame(1,{samples:[{...sample('0',ts),report:{...sample('0',ts).report,net_tx_total:'0'}},
    {...sample(exact.net_rx,ts+2000),report:{...sample(exact.net_rx,ts+2000).report,net_tx_total:exact.net_tx}}],probes:[]},'huge'));
  await until(()=>frames(peer).some(f=>f.id==='huge'));
  assert.equal(frames(peer).find(f=>f.id==='huge').result.durableThrough,1);
  send(peer,'report',{cpu:12});await h.control('drain');
  const env={DB:h.db,METRICS_BROADCASTER:{idFromName(){return 'global';},get(){return {fetch:async(url,init)=>
    h.fetch('/test/control',{method:'POST',body:JSON.stringify({op:'latest',...JSON.parse(init.body)})})};}}};
  return {h,peer,env,sys:{is_public:'true',jwt_secret:'s'.repeat(64)}};
}

test('CF existing HTTP server/list/admin keep four exact numeric tokens and native unknown null without changing backup decimals',async t=> {
  const {h,env,sys}=await native(t);
  const one=await handleServerAPI(new Request('https://example.com/api/server?id=node-a'),env,sys),text=await one.text(),body=JSON.parse(text);
  checkTokens(text,body);checkTokens(text,body.latestReportUpdates[0].samples[0].data);
  assert.deepEqual([body.ip_v4,body.ip_v6],['1','1']);assert.equal(text.includes('192.0.2.42'),false);
  const allText=await (await handleServersAPI(new Request('https://example.com/api/servers'),env,sys)).text();
  checkTokens(allText,JSON.parse(allText).servers.find(s=>s.id==='node-a'));
  const token=await generateToken(env,sys);
  const adminText=await (await handleAdminAPI(new Request('https://example.com/admin/api',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'list'})}),env,sys,null,{waitUntil(){}})).text();
  checkTokens(adminText,JSON.parse(adminText).servers.find(s=>s.id==='node-a'));
  const unknown=await h.socket('/api/agent/ws','node-b');send(unknown,'cf.capabilities',{version:1,supports:[{method:'cf.report.batch',version:1}]},'cap');await until(()=>frames(unknown).some(f=>f.id==='cap'));
  send(unknown,'report',{cpu:7});await h.control('drain');
  const nullText=await (await handleServerAPI(new Request('https://example.com/api/server?id=node-b'),env,sys)).text();
  checkTokens(nullText,JSON.parse(nullText),Object.fromEntries(counters.map(k=>[k,null])));
  const state=JSON.parse((await h.db.prepare("SELECT state FROM monitor_telemetry_nodes WHERE server_id='node-a'").first()).state);
  assert.equal(state.traffic.totalRx,exact.net_rx);
  const metadata=await createSuccessResponse({monitor_metadata:{nodes:[{state}]}}).text();
  assert.equal(JSON.parse(metadata).monitor_metadata.nodes[0].state.traffic.totalRx,exact.net_rx);
  t.diagnostic(JSON.stringify({httpTokens:exact,unknown:Object.fromEntries(counters.map(k=>[k,JSON.parse(nullText)[k]])),internalTotalRx:state.traffic.totalRx,backupTotalRxType:'string'}));
  t.diagnostic(JSON.stringify({boundary:'CF HTTP /api/server',raw:text}));
});

test('CF original realtime WebSocket boundary emits exact native counter tokens; null and legacy numeric defaults remain intact',async t=> {
  const {h,env,sys}=await native(t),token=await generateToken(env,sys);
  const viewer=await h.socket('/api/ws?subscribe=all',null,{Authorization:`Bearer ${token}`});assert.equal(viewer.status,101);
  viewer.ws.send(JSON.stringify({type:'subscribe',scope:'all',ids:['node-a','node-b']}));
  await until(()=>frames(viewer).some(f=>f.type==='subscribed' && f.count===2));
  // Send actual D1-backed native live cache through the existing production broadcaster boundary.
  await h.control('broadcastLatest',{serverIds:['node-a']});
  await until(()=>frames(viewer).some(f=>f.type==='batchUpdate'));
  const raw=viewer.messages.find(raw=>JSON.parse(raw).type==='batchUpdate');
  checkTokens(raw,JSON.parse(raw).updates[0].samples[0].data);assert.equal(raw.includes('192.0.2.42'),false);
  await h.control('batch',{updates:[{serverId:'node-b',samples:[{ts:Date.now(),data:coerceNumericMetricFields({net_rx:'12',net_tx:'13',net_rx_monthly:'14',net_tx_monthly:'15'})}]}]});
  await until(()=>frames(viewer).some(f=>f.type==='batchUpdate' && f.updates[0].serverId==='node-b'));
  const legacy=frames(viewer).find(f=>f.type==='batchUpdate' && f.updates[0].serverId==='node-b').updates[0].samples[0].data;
  // Original batch-push transports already-normalized legacy metrics; it has no native marker.
  assert.equal(legacy.net_rx,12);
  const unknown=await h.socket('/api/agent/ws','node-b');send(unknown,'cf.capabilities',{version:1,supports:[{method:'cf.report.batch',version:1}]},'cap');await until(()=>frames(unknown).some(f=>f.id==='cap'));
  send(unknown,'report',{cpu:7});await h.control('drain');await h.control('broadcastLatest',{serverIds:['node-b']});
  await until(()=>frames(viewer).some(f=>f.type==='batchUpdate' && f.updates[0].samples[0].data.monitor));
  const nullRaw=viewer.messages.find(raw=>{const f=JSON.parse(raw);return f.type==='batchUpdate' && f.updates[0].serverId==='node-b' && f.updates[0].samples[0].data.monitor;});
  assert.ok(nullRaw);checkTokens(nullRaw,JSON.parse(nullRaw).updates[0].samples[0].data,Object.fromEntries(counters.map(k=>[k,null])));
  t.diagnostic(JSON.stringify({realtimeTokens:exact,publicAddressesMasked:true,nativeUnknown:null,legacyUnmarkedType:typeof legacy.net_rx}));
  t.diagnostic(JSON.stringify({boundary:'CF WS batchUpdate',raw}));
});

test('unmigrated CF legacy HTTP counters remain numeric without new capability or ledger prerequisites',async t=> {
  const h=await createMonitorRuntimeFixture(t);
  const response=await h.post({id:'node-a',metrics:{cpu:7,net_rx:12,net_tx:13,net_rx_monthly:1000.5,net_tx_monthly:2000.5,timestamp:Date.now()}});
  assert.equal(response.status,200);
  const text=await (await handleServerAPI(new Request('https://example.com/api/server?id=node-a'),{DB:h.db},{is_public:'true',jwt_secret:'s'.repeat(64)})).text();
  checkTokens(text,JSON.parse(text),{net_rx:'12',net_tx:'13',net_rx_monthly:'1000.5',net_tx_monthly:'2000.5'});
});

test('CF receiver freshness survives future and late sender samples and rebuild; actual offline caller expires without moving history clocks',async t=> {
  clearAllCaches();t.after(clearAllCaches);
  const h=await createMonitorRuntimeFixture(t),states=new Map(),observed=[];
  for(const [id,offset] of [['node-a',7*86400000],['node-b',-20*60000]]) {
    const peer=await h.socket('/api/agent/ws',id);
    send(peer,'cf.capabilities',{version:1,supports:[{method:'cf.report.batch',version:1}]},'cap');await until(()=>frames(peer).some(f=>f.id==='cap'));
    const sampledAt=Date.now()+offset,clock={local_ts:sampledAt,accurate_ts:null,offset_ms:null,source:null,round_trip_ms:null,sample_age_ms:null};
    peer.ws.send(frame(1,{samples:[sample('0',sampledAt),sample('1',sampledAt+2000)],probes:[],clock},id));
    await until(()=>frames(peer).some(f=>f.id===id));assert.equal(frames(peer).find(f=>f.id===id).result.durableThrough,1);
    const state=JSON.parse((await h.db.prepare('SELECT state FROM monitor_telemetry_nodes WHERE server_id=?').bind(id).first()).state);
    states.set(id,state);
    clearAllCaches();
    assert.equal((await getLatestMetrics(h.db,id)).timestamp,state.receivedAt);
    assert.equal((await getLatestMetricsForAllServers(h.db)).get(id).timestamp,state.receivedAt);
    assert.equal((await getLatestTimestampsForAllServers(h.db)).get(id),state.receivedAt);
    const core=await readMonitorTelemetry(h.db,id,{from:sampledAt-1,to:sampledAt+3000});
    assert.deepEqual(core.rawSamples.map(s=>s.sampledAt),[sampledAt,sampledAt+2000]);assert.deepEqual(core.clock,clock);
    assert.equal(core.traffic.totalRx,'1');assert.equal(core.traffic.observedAt,sampledAt+2000);
    const history=await readMonitorHistoryRows(h.db,id,{from:sampledAt-1,to:sampledAt+3000});
    assert.ok(history.length);assert.ok(history.every(row=>row.timestamp===Math.floor(sampledAt/60000)*60000 || row.timestamp===Math.floor((sampledAt+2000)/60000)*60000));
    if(offset<0)assert.ok((await getMetricsHistory(h.db,id,1,'cpu')).some(row=>row.timestamp===Math.floor(sampledAt/60000)*60000));
    peer.ws.close();await until(()=>peer.ws.readyState===3);await h.control('drain');
    observed.push({id,sampledAt,receiver:state.receivedAt,history:history.map(row=>row.timestamp),trafficObservedAt:core.traffic.observedAt});
  }
  await h.control('rebuild');clearAllCaches();
  for(const [id,state] of states)assert.equal((await getLatestTimestampsForAllServers(h.db)).get(id),state.receivedAt);
  const receiver=Math.max(...[...states.values()].map(s=>s.receivedAt)),sys={is_public:'true',jwt_secret:'s'.repeat(64)};
  const config={schema:1,revision:1,timezone:'UTC',language:'en',channels:[{id:'fixture',name:'fixture',type:'telegram',enabled:true,
    config:{chatId:'fixture'},secrets:{botToken:'fixture'},template:'{{message}}'}],rules:[{id:'freshness',name:'freshness',type:'offline',enabled:true,
    scope:{mode:'selected',serverIds:['node-a','node-b']},targetIds:['fixture'],options:{minutes:5}}]};
  const sends=[];
  t.mock.method(Date,'now',()=>receiver+1000);
  await checkOfflineNodes(h.db,{notificationConfig:config,send:async(channel,msg,context)=>{sends.push({msg,context});}});
  assert.equal(sends.length,0);
  const online=await (await handleServersAPI(new Request('https://example.com/api/servers'),{DB:h.db},sys)).json();
  assert.equal(online.stats.online,2);
  t.mock.method(Date,'now',()=>receiver+6*60000);clearAllCaches();
  await checkOfflineNodes(h.db,{notificationConfig:config,send:async(channel,msg,context)=>{sends.push({msg,context});}});
  const alert=JSON.parse((await h.db.prepare("SELECT value FROM settings WHERE key='alert_state'").first()).value);
  assert.deepEqual(alert.rules.freshness.servers,{'node-a':true,'node-b':true});assert.ok(sends.length>0);
  const offline=await (await handleServersAPI(new Request('https://example.com/api/servers'),{DB:h.db},sys)).json();
  assert.equal(offline.stats.online,0);assert.equal(offline.stats.offline,2);
  for(const [id,state] of states)assert.deepEqual(JSON.parse((await h.db.prepare('SELECT state FROM monitor_telemetry_nodes WHERE server_id=?').bind(id).first()).state),state);
  const historical=projectMonitorLatest('history',{latest:{sampledAt:123000,elapsedMs:1000,report:{cpu:7},source:'cf-batch'}});
  assert.equal(historical.timestamp,123000);
  assert.equal(projectMonitorLatest('zero',{receivedAt:0,latest:{sampledAt:123000,elapsedMs:0,report:{},source:'cf-live'}}).timestamp,0);
  t.diagnostic(JSON.stringify({observed,rebuildReceiverUnchanged:true,online:online.stats.online,afterSixMinutesOnline:offline.stats.online,
    offlineNodes:alert.rules.freshness.servers,historicalFallback:historical.timestamp,ledgerAndRawUnchanged:true}));
});
