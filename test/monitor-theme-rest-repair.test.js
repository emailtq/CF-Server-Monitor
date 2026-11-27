import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { writeFileSync } from 'node:fs';
import { generateToken } from '../src/middleware/auth.js';
import { createMonitorRuntimeFixture, until, frames, send } from './fixtures/monitor-runtime.mjs';
import { changeLatencyTasks, readLatencyTaskDocument } from '../src/database/latencyTasks.js';
import { getMonitorCompatIds } from '../src/database/monitorCompatIds.js';

const origin='https://example.com',secret='s'.repeat(64);
function evidence(name,value) {if(process.env.CFSM_S2_REPAIR_EVIDENCE)writeFileSync(`${process.env.CFSM_S2_REPAIR_EVIDENCE}/S2-REPAIR-${name}.json`,JSON.stringify(value,null,2));}
async function probes(t) {
  const h=await createMonitorRuntimeFixture(t),token=await generateToken({}, {jwt_secret:secret});
  h.headers={Cookie:`cfsm_auth=${token}`,Origin:origin,'Content-Type':'application/json'};
  h.json=(path,body,method='PUT')=>h.fetch(path,{method,headers:h.headers,body:JSON.stringify(body)});
  h.ids=await getMonitorCompatIds(h.db,['node-a','node-b']);
  await h.db.prepare("UPDATE servers SET ping_mode='icmp' WHERE id='node-b'").run();
  return h;
}

test('native empty complete order succeeds while the old CF empty order remains rejected',async t=>{
  const h=await probes(t);await h.db.prepare('DELETE FROM servers').run();
  const native=await h.json('/api/nodes/order',{ids:[]});assert.equal(native.status,200,await native.clone().text());assert.deepEqual(await native.json(),{ok:true});
  const old=await h.json('/admin/api',{action:'save_order',orders:[]},'POST');assert.equal(old.status,400);
  evidence('empty-order',{native:200,cf:400});
});

test('standard task creation and autojoin refuse ICMP scope without changing catalog or node mode',async t=>{
  const h=await probes(t),before=await readLatencyTaskDocument(h.db);
  const cases=[{nodes:[h.ids.get('node-b')],auto_join:false},{nodes:[h.ids.get('node-a')],auto_join:true}];
  for(const body of cases){const r=await h.json('/api/ping-tasks',{name:'must remain TCP',target:'example.test:443',interval:60,...body},'POST');assert.equal(r.status,422);assert.match(r.headers.get('Content-Type'),/^text\/plain/);assert.deepEqual(await readLatencyTaskDocument(h.db),before);}
  assert.equal((await h.db.prepare("SELECT ping_mode FROM servers WHERE id='node-b'").first()).ping_mode,'icmp');
  evidence('icmp-create',{statuses:[422,422],catalogUnchanged:true});
});

test('assignment/update/base guards preserve real standard TCP offer and existing CF ICMP offer',async t=>{
  const h=await probes(t),a=h.ids.get('node-a'),b=h.ids.get('node-b');
  const created=await h.json('/api/ping-tasks',{name:'TCP',target:'example.test:443',interval:60,nodes:[a],auto_join:false},'POST');assert.equal(created.status,200);const id=(await created.json()).id;
  const baseline=await readLatencyTaskDocument(h.db);
  for(const [path,body,method] of [
    [`/api/nodes/${b}/ping-tasks`,{tasks:[id],base:[]},'PUT'],
    ['/api/ping-tasks',{id,name:'changed',target:'example.test:444',interval:60,nodes:[a,b],base:[a],auto_join:false},'POST'],
    ['/api/ping-tasks',{id,name:'changed',target:'example.test:444',interval:60,nodes:[a],base:[],auto_join:true},'POST']
  ]){assert.equal((await h.json(path,body,method)).status,422);assert.deepEqual(await readLatencyTaskDocument(h.db),baseline);}
  const tcp=await h.socket();await until(()=>frames(tcp).some(f=>f.method==='ping.tasks'&&f.params.length===1));
  assert.deepEqual(frames(tcp).find(f=>f.method==='ping.tasks').params,[{id,target:'example.test:443',interval:60}]);
  const legacy=await changeLatencyTasks(h.db,{},'save',{name:'Existing CF ICMP',target:'example.test',interval:60,nodes:['node-b'],auto_join:false});
  const list=await (await h.fetch('/api/ping-tasks',{headers:h.headers})).json(),icmp=list.tasks.find(t=>t.name==='Existing CF ICMP');
  assert.equal(icmp.mode,'icmp');assert.equal(icmp.standard_supported,false);assert.equal(icmp.unsupported,'monitor_icmp_tasks_unavailable');
  const peer=await h.socket('/api/agent/ws','node-b');assert.equal(peer.headers['x-cfsm-monitor-probes'],'monitor_icmp_tasks_unavailable');
  send(peer,'cf.capabilities',{version:1,supports:['cf.report.batch','cf.ping.tasks'].map(method=>({method,version:1}))},'caps');
  await until(()=>frames(peer).some(f=>f.method==='cf.ping.tasks'));
  const offer=frames(peer).find(f=>f.method==='cf.ping.tasks').params;
  assert.equal(offer.tasks[0].mode,'icmp');assert.equal(offer.tasks[0].target,'example.test');assert.equal(offer.tasks[0].metricId,legacy.tasks.at(-1).id);
  const snapshot=await h.snapshot(),owner=snapshot.owners.find(([serverId])=>serverId==='node-b')[1];assert.deepEqual(owner.taskOffer.tasks,offer.tasks);
  evidence('task-offer',{tcp:frames(tcp).find(f=>f.method==='ping.tasks'),icmp,offer,stored:owner.taskOffer,guards:[422,422,422]});
});

test('standard guard validates the merged base scope and rolls back a mode flip inside catalog CAS',async t=>{
  const h=await probes(t),a=h.ids.get('node-a');
  const old=await changeLatencyTasks(h.db,{},'save',{name:'CF mixed',target:'example.test:443',interval:60,nodes:['node-a','node-b'],auto_join:false});
  const list=await (await h.fetch('/api/ping-tasks',{headers:h.headers})).json(),mixed=list.tasks.find(t=>t.name==='CF mixed');
  assert.equal(mixed.mode,'mixed');assert.equal(mixed.standard_supported,false);
  const response=await h.json('/api/ping-tasks',{id:mixed.id,name:'same',target:'example.test:444',interval:60,nodes:[a],base:[a],auto_join:false},'POST');
  assert.equal(response.status,422,'base delta retains omitted ICMP node');assert.deepEqual(await readLatencyTaskDocument(h.db),old);
  await h.db.prepare("UPDATE servers SET ping_mode='tcp' WHERE id='node-b'").run();
  const before=await readLatencyTaskDocument(h.db);
  await h.db.prepare("CREATE TRIGGER flip_probe_mode AFTER UPDATE ON settings WHEN NEW.key='latency_tasks' BEGIN UPDATE servers SET ping_mode='icmp' WHERE id='node-a'; END").run();
  const raced=await h.json('/api/ping-tasks',{name:'new TCP',target:'example.test:445',interval:60,nodes:[a],auto_join:false},'POST');assert.equal(raced.status,422);
  assert.deepEqual(await readLatencyTaskDocument(h.db),before);
  assert.equal((await h.db.prepare("SELECT ping_mode FROM servers WHERE id='node-a'").first()).ping_mode,'tcp');
  evidence('mode-cas',{mergedScope:422,modeRace:422,catalogUnchanged:true,modeFlipRolledBack:true});
});

function archive(version='1') {
  const entry=(name,text)=>{const data=Buffer.from(text),header=Buffer.alloc(512);header.write(name);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(data.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512)]);};
  return gzipSync(Buffer.concat([entry('theme.json',JSON.stringify({name:'Repair',short:'repair',description:'',version,author:'test',url:'https://github.com/fixture/repair'})),entry('dist/index.html','<html><head></head><body>repair</body></html>'),Buffer.alloc(1024)]));
}
const bundle=build({stdin:{contents:`import worker from './src/index.js'; export {MetricsBroadcaster,TerminalBroker} from './src/index.js';const now=Date.now;let delta=0;Date.now=()=>now()+delta;export default {fetch(request,env,ctx){const url=new URL(request.url);if(url.pathname==='/test/clock'){delta+=Number(url.searchParams.get('advance'));return new Response('ok');}return worker.fetch(request,env,ctx);}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:*']});
async function themes(t,outboundService) {
  const mf=new Miniflare({modules:true,script:(await bundle).outputFiles[0].text,compatibilityDate:'2024-12-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'repair-theme'},outboundService});
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB'),{initDatabase}=await import('../src/database/schema.js?repair='+crypto.randomUUID());await initDatabase(db);
  await db.prepare("INSERT INTO settings(key,value) VALUES('site_options',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({is_public:'true',jwt_secret:secret})).run();
  const token=await generateToken({}, {jwt_secret:secret}),headers={Cookie:`cfsm_auth=${token}`,Origin:origin};
  return {db,token,headers,fetch:(path,options={})=>mf.dispatchFetch(origin+path,options)};
}

test('old whole upload cannot publish after logout occurring inside the archive write',async t=>{
  const h=await themes(t),p=JSON.parse(Buffer.from(h.token.split('.')[1],'base64').toString());
  await h.db.prepare('INSERT INTO terminal_auth_sessions VALUES(?,?,NULL)').bind(p.jti,p.exp).run();
  await h.db.prepare('CREATE TABLE monitor_theme_chunks(revision TEXT,part INTEGER,data BLOB,PRIMARY KEY(revision,part)) WITHOUT ROWID').run();
  await h.db.prepare('CREATE TRIGGER revoke_old_upload AFTER INSERT ON monitor_theme_chunks BEGIN UPDATE terminal_auth_sessions SET revoked_at=1; END').run();
  const r=await h.fetch('/admin/api/monitor-themes/upload',{method:'POST',headers:h.headers,body:archive()});assert.equal(r.status,401);
  assert.equal(await h.db.prepare("SELECT value FROM settings WHERE key='monitor_theme_packages'").first(),null);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM monitor_theme_chunks').first()).n,0);
  evidence('old-upload-logout',{status:r.status,published:false,unpublishedChunks:0});
});

test('old whole upload still supports legacy authority rows without creating terminal session state',async t=>{
  const h=await themes(t);await h.db.prepare("DELETE FROM settings WHERE key='site_options'").run();
  await h.db.prepare("INSERT INTO settings(key,value) VALUES('jwt_secret',?),('is_public','true')").bind(secret).run();
  const r=await h.fetch('/admin/api/monitor-themes/upload',{method:'POST',headers:h.headers,body:archive()});assert.equal(r.status,200);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM terminal_auth_sessions').first()).n,0);
  evidence('legacy-publisher',{upload:200,terminalSessionsCreated:0});
});

test('old admin link install and update cannot publish after logout or JWT expiry during download',async t=>{
  for(const operation of ['install','update'])for(const failure of ['logout','expiry']) {
    let release,started;const waiting=new Promise(resolve=>{started=resolve;});let blocked=true;
    const h=await themes(t,async request=>{if(new URL(request.url).pathname.endsWith('/releases/latest'))return new Response(null,{status:302,headers:{Location:'https://github.com/fixture/repair/releases/tag/v2'}});if(blocked){started();await new Promise(resolve=>{release=resolve;});}return new Response(archive('2'));});
    const p=JSON.parse(Buffer.from(h.token.split('.')[1],'base64').toString());
    if(operation==='update')assert.equal((await h.fetch('/admin/api/monitor-themes/upload',{method:'POST',headers:h.headers,body:archive()})).status,200);
    const before=await h.db.prepare("SELECT value FROM settings WHERE key='monitor_theme_packages'").first();
    const pending=h.fetch('/admin/api',{method:'POST',headers:{...h.headers,'Content-Type':'application/json'},body:JSON.stringify({action:operation==='install'?'install_monitor_theme':'update_monitor_theme',repository:'https://github.com/fixture/repair',theme:'repair'})});
    await waiting;
    if(failure==='logout')await h.db.prepare('INSERT INTO terminal_auth_sessions VALUES(?,?,?)').bind(p.jti,p.exp,Date.now()).run();
    else await h.fetch('/test/clock?advance=604801000');
    blocked=false;release();const response=await pending;assert.equal(response.status,401,`${operation} ${failure}: ${await response.clone().text()}`);
    assert.deepEqual(await h.db.prepare("SELECT value FROM settings WHERE key='monitor_theme_packages'").first(),before);
    evidence(`old-${operation}-${failure}`,{status:401,registryUnchanged:true});
  }
});
