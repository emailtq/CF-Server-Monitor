import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';
import { generateToken } from '../src/middleware/auth.js';
import { encryptTurnstileData } from '../src/middleware/turnstile.js';
import { handleMonitorAccess } from '../src/handlers/monitorAccess.js';
import { readFile } from 'node:fs/promises';

async function fixture(t) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response();}}', d1Databases: {DB:'default-frontend'} });
  t.after(()=>mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT)').run();
  const sys = { is_public:'true', jwt_secret:'local-default-frontend-test-authority-only' };
  const set = value => db.prepare("INSERT OR REPLACE INTO settings VALUES ('site_options',?)").bind(JSON.stringify(value)).run();
  await set(sys);
  const env = {DB:db,ASSETS:{fetch:async req=>{
    const path=new URL(req.url).pathname;
    return /\/(index.html|dashboard.html|assets\/app.js)$/.test(path) ? new Response(`<html><head></head><body>${path}</body></html>`,{headers:{'Content-Type':path.endsWith('.js')?'application/javascript':'text/html'}}) : new Response('Not Found',{status:404});
  }}};
  const fetch = (path,headers={},method='GET')=>worker.fetch(new Request(`https://cf.example.test${path}`,{method,headers}),env);
  return {env,db,sys,set,fetch,token:await generateToken(env,sys)};
}

test('Worker default homepage and node deep links use the original Minimal theme without hostname activation',async t=>{
  const h=await fixture(t);
  for(const path of ['/','/node/1']) {
    const res=await h.fetch(path);
    assert.equal(res.status,200);
    assert.match(await res.text(),/_monitor_theme\/default\/index.html/);
  }
  const asset=await h.fetch('/assets/app.js');
  assert.equal(asset.status,200);
  assert.match(await asset.text(),/_monitor_theme\/default\/assets\/app.js/);
  assert.equal((await h.fetch('/_monitor_theme/default/index.html')).status,404);
  const me=await h.fetch('/api/me');
  assert.equal(me.status,200);
  assert.equal((await me.json()).public_page,true);
  assert.equal((await h.fetch('/api/themes/default/config')).status,200);
  assert.equal((await h.fetch('/admin/')).status,302);
  assert.equal((await h.fetch('/api/agent/register',{},'POST')).status,401);
  h.env.MONITOR_COMPAT_HOST='cf.example.test';
  assert.equal((await h.fetch('/api/agent/register',{},'POST')).status,401,'default host must not swallow Agent handlers');
});

test('unavailable access policy returns a controlled me error rather than a misleading login state',async t=>{
  const h=await fixture(t);
  await h.db.prepare('DROP TABLE settings').run();
  assert.equal((await h.fetch('/api/me')).status,503);
});

test('old UUID links relocate only visible nodes to stable numeric original-theme deep links',async t=>{
  const h=await fixture(t);
  await h.db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY,is_hidden TEXT)').run();
  await h.db.prepare("INSERT INTO servers VALUES ('old-uuid','0'),('hidden-uuid','1'),('null-uuid',NULL)").run();
  const first=await h.fetch('/server/old-uuid');
  assert.equal(first.status,302);
  assert.match(first.headers.get('Location'),/^https:\/\/cf\.example\.test\/node\/[1-9]\d*$/);
  assert.equal((await h.fetch('/server/old-uuid')).headers.get('Location'),first.headers.get('Location'));
  for(const id of ['hidden-uuid','null-uuid','deleted-uuid']) assert.equal((await h.fetch('/server/'+id)).status,404);
  await h.db.prepare("UPDATE servers SET is_hidden='1' WHERE id='old-uuid'").run();
  assert.equal((await h.fetch('/server/old-uuid')).status,404);
});

test('access verification issues a reusable HttpOnly receipt only after siteverify succeeds, including legacy settings',async t=>{
  const h=await fixture(t);
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let success=true, calls=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(JSON.parse(options.body).response,'fixture-response');
    calls++;
    return Response.json({success});
  };
  const verify=()=>handleMonitorAccess(new Request('https://cf.example.test/api/monitor-access',{method:'POST',headers:{Origin:'https://cf.example.test','Content-Type':'application/json'},body:JSON.stringify({token:'fixture-response'})}),h.env,new URL('https://cf.example.test/api/monitor-access'));
  await h.set({...h.sys,turnstile_enabled:true,turnstile_secret_key:'fixture-secret',turnstile_site_key:'fixture-site'});
  const verified=await verify();
  assert.equal(verified.status,200);
  const cookie=verified.headers.get('Set-Cookie');
  assert.match(cookie,/HttpOnly; SameSite=Lax; Secure/);
  assert.equal((await h.fetch('/api/themes/default/config',{Cookie:cookie.split(';')[0]})).status,200);
  success=false;
  const denied=await verify();
  assert.equal(denied.status,403);
  assert.equal(denied.headers.get('Set-Cookie'),null);
  await h.db.prepare("DELETE FROM settings WHERE key='site_options'").run();
  for(const [key,value] of Object.entries({...h.sys,turnstile_enabled:'true',turnstile_secret_key:'fixture-secret',turnstile_site_key:'fixture-site'})) await h.db.prepare('INSERT INTO settings VALUES (?,?)').bind(key,value).run();
  success=true;
  assert.equal((await verify()).status,200,'existing legacy configuration remains usable');
  assert.match(await h.fetch('/').then(res=>res.text()),/fixture-site/);
  assert.equal(calls,3);
});

test('private-site sessions use CF login authority without exposing hidden/admin data; unauthenticated access remains closed',async t=>{
  const h=await fixture(t);
  await h.set({...h.sys,is_public:'false'});
  const anonymous=await h.fetch('/api/me').then(res=>res.json());
  assert.equal(anonymous.authed,false);
  assert.equal(anonymous.public_page,false);
  assert.equal((await h.fetch('/api/themes/default/config')).status,401);
  const headers={Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`};
  const loggedIn=await h.fetch('/api/me',headers).then(res=>res.json());
  assert.equal(loggedIn.authed,true);
  assert.equal(loggedIn.public_page,false);
  assert.equal((await h.fetch('/api/themes/default/config',headers)).status,200);
  assert.equal((await h.fetch('/api/themes/default/config',{Cookie:'cfsm_auth=invalid'})).status,401);
  const previewHeaders={Cookie:`cfsm_theme_preview_auth=${encodeURIComponent(h.token)}`,Referer:'https://cf.example.test/?monitor_preview=default'};
  assert.equal((await h.fetch('/api/themes/default/config',previewHeaders)).status,200);
});

test('Turnstile gate uses the existing encrypted verification authority and cannot be bypassed by login or a forged receipt',async t=>{
  const h=await fixture(t);
  await h.set({...h.sys,turnstile_enabled:'true',turnstile_site_key:'local-test-site-key'});
  const html=await h.fetch('/');
  assert.equal(html.status,200);
  assert.match(await html.text(),/cf-turnstile/);
  assert.equal((await h.fetch('/api/themes/default/config',{Cookie:`cfsm_auth=${h.token}`})).status,403);
  assert.equal((await h.fetch('/api/themes/default/config',{Cookie:'cfsm_monitor_verified=forged'})).status,403);
  const valid=await encryptTurnstileData({verified:true,expires:Math.floor(Date.now()/1000)+60},h.env,h.sys);
  const headers={Cookie:`cfsm_monitor_verified=${encodeURIComponent(valid)}`};
  assert.equal((await h.fetch('/api/themes/default/config',headers)).status,200);
  assert.match(await h.fetch('/',headers).then(res=>res.text()),/_monitor_theme\/default/);
  const expired=await encryptTurnstileData({verified:true,expires:Math.floor(Date.now()/1000)-1},h.env,h.sys);
  assert.equal((await h.fetch('/api/themes/default/config',{Cookie:`cfsm_monitor_verified=${encodeURIComponent(expired)}`})).status,403);
  assert.equal((await h.fetch('/api/monitor-access',{'Content-Type':'application/json'},'POST')).status,403,'verification writes require exact same-origin Origin');
});

test('default theme does not take over legacy unmarked CF WebSockets or opt-out frontend',async t=>{
  const h=await fixture(t);
  const home=await h.fetch('/').then(res=>res.text());
  assert.match(home,/monitor_protocol/);
  let forwarded;
  h.env.METRICS_BROADCASTER={idFromName:()=> 'global',get:()=>({fetch:async (url,options)=>{forwarded={url,options};return new Response('socket');}})};
  assert.equal((await h.fetch('/api/ws?monitor_protocol=1',{Upgrade:'websocket',Origin:'https://cf.example.test'})).status,200);
  assert.match(forwarded.url,/monitor/);
  h.env.MONITOR_FRONTEND_MODE='legacy';
  const legacy=await h.fetch('/').then(res=>res.text());
  assert.match(legacy,/dashboard.html/);
  assert.doesNotMatch(legacy,/_monitor_theme\/default/);
});

test('default theme settings retain admin appearance and public data controls while excluding legacy-only appearance',async()=>{
  const admin=await readFile(new URL('../src/frontend/views/admin/index.vue',import.meta.url),'utf8');
  const appearance=await readFile(new URL('../src/frontend/views/admin/components/AppearanceSettings.vue',import.meta.url),'utf8');
  assert.match(admin,/:monitor-frontend="monitorDefaultFrontend"/);
  assert.doesNotMatch(admin,/\? 'monitorThemes' : activeTab/);
  assert.match(appearance,/canEditSiteSettings && !monitorFrontend/);
  for(const field of ['show_price','show_expire','show_tf']) assert.match(appearance,new RegExp(`data-setting-field="${field}"`));
});
