import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, openPair, controls, until } from './terminal-harness.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { serveFrontend } from '../src/handlers/frontend.js';
import { saveSiteOptions, loadSiteSettings } from '../src/utils/settings.js';
import { issueTerminalNodeToken } from '../src/database/terminal.js';
import { handleTerminalUpgrade, handleTerminalAdminAction } from '../src/handlers/terminal.js';

test('terminal status is an authenticated dispatcher action, contains no credential', async () => {
  const h = await harness();
  try {
    const response = await h.action('terminal_status', {serverId:'node-a'});
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.connected, false);
    assert.equal(status.activeCount, 0);
    assert.equal(JSON.stringify(status).includes(h.nodes['node-a'].token), false);
    assert.equal((await h.action('terminal_status', {serverId:'node-a'}, {headers:{Cookie:''}})).status, 401);
  } finally { await h.dispose(); }
});

test('terminal actions require exact Origin and fresh independent administrator identity', async () => {
  const h = await harness();
  try {
    for (const origin of ['', 'https://evil.example', 'https://example.com.evil', 'null']) {
      assert.equal((await h.action('terminal_status', {serverId:'node-a'}, {headers:{Origin:origin}})).status, 403);
    }
    assert.equal((await h.action('terminal_enable_site', {password:'wrong'})).status, 401);
    assert.equal((await h.action('terminal_authorize_node', {serverId:'node-a', password:'wrong'})).status, 401);
  } finally { await h.dispose(); }
});

test('logout revokes a valid JWT before its first terminal use and still clears unauthenticated cookies', async () => {
  const h = await harness();
  try {
    const response = await h.action('logout');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal((await h.action('terminal_status', {serverId:'node-a'})).status, 401);
    assert.equal((await h.action('logout', {}, {headers:{Cookie:''}})).status, 200);
  } finally { await h.dispose(); }
});

test('an invalid bearer header cannot shadow the valid logout Cookie and two valid identities are both revoked', async () => {
  const h = await harness();
  try {
    assert.equal((await h.action('logout', {}, {headers:{Authorization:'Bearer invalid'}})).status,200);
    assert.equal((await h.action('terminal_status', {serverId:'node-a'})).status,401);
    const first = h.otherToken;
    const env = {DB:h.db,API_SECRET:'test-report-secret'};
    const sys = await loadSiteSettings(h.db,true);
    const {generateToken} = await import('../src/middleware/auth.js');
    const second = await generateToken(env,sys);
    assert.equal((await h.action('logout',{}, {headers:{Cookie:`cfsm_auth=${encodeURIComponent(first)}`,Authorization:`Bearer ${second}`}})).status,200);
    for (const token of [first,second]) {
      assert.equal((await h.action('terminal_status',{serverId:'node-a'},{headers:{Cookie:`cfsm_auth=${encodeURIComponent(token)}`}})).status,401);
    }
  } finally {await h.dispose();}
});

test('site/node enable require step-up, ordinary settings cannot enable, custom previews are blocked', async () => {
  const h = await harness();
  try {
    assert.equal((await h.action('terminal_authorize_node', {serverId:'node-a', password:'test-report-secret'})).status, 200);
    await saveSiteOptions(h.db, {terminal_enabled:'false'});
    assert.equal((await h.action('terminal_enable_site', {password:'test-report-secret'})).status, 200);
    const sys = await loadSiteSettings(h.db, true);
    const preview = new Request('https://example.com/?theme_url=https://github.com/test/theme/tree/main', {headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
    assert.equal((await serveFrontend(preview, {DB:h.db}, sys)).status, 409);
    assert.equal((await h.action('start_theme_preview', {theme_url:'https://github.com/test/theme/tree/main'})).status, 409);
    await saveSiteOptions(h.db, {theme_url:'https://github.com/test/theme/tree/main', terminal_enabled:'false'});
    assert.equal((await h.action('terminal_enable_site', {password:'test-report-secret'})).status, 409);
  } finally { await h.dispose(); }
});

test('custom theme import disables terminal and tombstones all existing administrator authorizations', async () => {
  const h = await harness();
  try {
    assert.equal((await h.action('terminal_status', {serverId:'node-a'})).status, 200);
    assert.equal((await h.action('terminal_status', {serverId:'node-a'}, {headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.otherToken)}`}})).status, 200);
    const response = await h.action('import_servers', {settings:{site:{theme_url:'https://github.com/test/theme/tree/main'}}});
    assert.equal(response.status, 200);
    const row = await h.db.prepare("SELECT value FROM settings WHERE key = 'site_options'").first();
    assert.equal(JSON.parse(row.value).terminal_enabled, 'false');
    assert.ok((await h.db.prepare('SELECT revoked_at FROM terminal_auth_sessions').first()).revoked_at);
    await saveSiteOptions(h.db, {theme_url:'', terminal_enabled:'true'});
    assert.equal((await h.action('terminal_status', {serverId:'node-a'})).status, 401);
    assert.equal((await h.action('terminal_status', {serverId:'node-a'}, {headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.otherToken)}`}})).status, 401);
  } finally { await h.dispose(); }
});

test('saving a custom theme revokes terminal authority, while plain CSS keeps it enabled', async () => {
  const h = await harness();
  const originalFetch = globalThis.fetch;
  try {
    const sys = await loadSiteSettings(h.db, true);
    const env = {DB:h.db, API_SECRET:'test-report-secret'};
    const req = settings => new Request('https://example.com/admin/api', {method:'POST', headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}, body:JSON.stringify({action:'save_settings', settings})});
    assert.equal((await handleAdminAPI(req({password:'testing-password', custom_css:'body { color: red; }'}), env, sys)).status, 200);
    assert.equal((await loadSiteSettings(h.db, true)).terminal_enabled, 'true');
    globalThis.fetch = async () => new Response('<html>custom theme</html>');
    assert.equal((await handleAdminAPI(req({theme_url:'https://github.com/test/theme/tree/main'}), env, sys)).status, 200);
    assert.equal((await loadSiteSettings(h.db, true)).terminal_enabled, 'false');
  } finally { globalThis.fetch = originalFetch; await h.dispose(); }
});

test('node revoke and delete close active peers after D1 authority changes, notification failure is reported', async () => {
  const h = await harness();
  try {
    const control = await h.control();
    const pair = await openPair(h, control);
    assert.equal((await h.action('terminal_revoke_node', {serverId:'node-a'})).status, 200);
    assert.equal((await h.db.prepare("SELECT enabled FROM terminal_nodes WHERE server_id = 'node-a'").first()).enabled, 0);
    await until(() => pair.agent.ws.readyState !== 1);
    assert.equal((await h.socket('/api/agent/terminal/control', h.agentHeaders())).response.status, 401);
    const sys = await loadSiteSettings(h.db, true);
    const request = new Request('https://example.com/admin/api', {method:'POST', headers:{Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`, Origin:'https://example.com'}, body:JSON.stringify({action:'terminal_revoke_node', serverId:'node-b'})});
    const env = {DB:h.db, API_SECRET:'test-report-secret', TERMINAL_BROKER:{idFromName:id=>id, get:()=>({fetch:async()=>{throw new Error('test failed notification');}})}};
    assert.equal((await handleAdminAPI(request, env, sys)).status, 503);
    assert.equal((await h.db.prepare("SELECT enabled FROM terminal_nodes WHERE server_id = 'node-b'").first()).enabled, 0);
  } finally { await h.dispose(); }
});

test('single and batch server deletion revoke node credentials and close the node broker', async () => {
  const h = await harness();
  try {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    for (const id of ids) {
      await h.db.prepare('INSERT INTO servers (id,name) VALUES (?,?)').bind(id,id).run();
      h.nodes[id] = await issueTerminalNodeToken(h.db, id);
    }
    const control = await h.control(ids[0]);
    const pair = await openPair(h, control, 'delete-session', ids[0]);
    assert.equal((await h.action('delete', {id:ids[0]})).status, 200);
    await until(() => pair.agent.ws.readyState !== 1 && pair.browser.ws.readyState !== 1);
    assert.equal(await h.db.prepare('SELECT id FROM servers WHERE id = ?').bind(ids[0]).first(), null);
    assert.equal((await h.db.prepare('SELECT enabled FROM terminal_nodes WHERE server_id = ?').bind(ids[0]).first()).enabled, 0);
    assert.equal((await h.action('batch_delete', {ids:ids.slice(1)})).status, 200);
    for (const id of ids.slice(1)) {
      assert.equal(await h.db.prepare('SELECT id FROM servers WHERE id = ?').bind(id).first(), null);
      assert.equal((await h.db.prepare('SELECT enabled FROM terminal_nodes WHERE server_id = ?').bind(id).first()).enabled, 0);
    }
  } finally { await h.dispose(); }
});

test('ordinary settings can disable but never enable terminal admission and disabling revokes authorizations', async () => {
  const h = await harness();
  try {
    assert.equal((await h.action('terminal_status', {serverId:'node-a'})).status, 200);
    assert.equal((await h.action('save_settings', {settings:{password:'test-admin-password', terminal_enabled:'false'}})).status, 200);
    assert.equal((await loadSiteSettings(h.db, true)).terminal_enabled, 'false');
    assert.ok((await h.db.prepare('SELECT revoked_at FROM terminal_auth_sessions').first()).revoked_at);
    assert.equal((await h.action('save_settings', {settings:{terminal_enabled:'true'}})).status, 200);
    assert.equal((await loadSiteSettings(h.db, true)).terminal_enabled, 'false');
  } finally { await h.dispose(); }
});

test('preview reads fresh terminal authority even with stale settings and fails closed on D1 errors', async () => {
  const h = await harness();
  try {
    const stale = {...await loadSiteSettings(h.db, true), terminal_enabled:'false'};
    const request = new Request('https://example.com/?theme_url=https://github.com/test/theme/tree/main');
    assert.equal((await serveFrontend(request, {DB:h.db}, stale)).status, 409);
    assert.equal((await serveFrontend(request, {DB:{prepare(){throw new Error('test unavailable');}}}, stale)).status, 503);
    const asset = new Request('https://example.com/assets/theme.js?theme_url=https://github.com/test/theme/tree/main');
    assert.equal((await serveFrontend(asset, {DB:h.db}, stale)).status, 409);
  } finally { await h.dispose(); }
});

test('forged internal context cannot authorize external routes and no terminal DO proxy exists', async () => {
  const h = await harness();
  try {
    const headers = {Upgrade:'websocket', Origin:'https://example.com', 'X-CFSM-Terminal-Context':JSON.stringify({serverId:'node-a', role:'agent', owner:'pretend-owner', credentialVersion:1})};
    assert.equal((await h.socket('/api/agent/terminal/control', {...headers, Authorization:'Bearer test-report-secret', 'X-CFSM-Server-Id':'node-a'})).response.status, 401);
    assert.notEqual((await h.fetch('/__do/terminal/control', {headers})).status, 101);
    assert.notEqual((await h.fetch('/terminal.internal/control', {headers})).status, 101);
  } finally { await h.dispose(); }
});

test('failed broker forwarding returns a canonical 503 rather than leaking or throwing an upstream error', async () => {
  const h = await harness();
  try {
    const env = {DB:h.db, API_SECRET:'test-report-secret', TERMINAL_BROKER:{idFromName:id=>id,get:()=>({fetch:async()=>{throw new Error('unsafe upstream detail');}})}};
    const sys = await loadSiteSettings(h.db, true);
    const request = new Request('https://example.com/api/agent/terminal/control', {headers:{Upgrade:'websocket', ...h.agentHeaders()}});
    const response = await handleTerminalUpgrade(request, env, sys);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('unsafe upstream detail'), false);
    const admin = new Request('https://example.com/admin/api', {headers:{Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
    const renewed = await handleTerminalAdminAction({request:admin, env, sys, data:{action:'terminal_renew',serverId:'node-a',sessionId:'test-session'}});
    assert.equal(renewed.status, 503);
  } finally { await h.dispose(); }
});

test('missing broker binding cannot prevent authoritative revoke/delete, and ordinary node deletion creates no broker', async () => {
  const h = await harness();
  try {
    const sys = await loadSiteSettings(h.db, true);
    const env = {DB:h.db, API_SECRET:'test-report-secret'};
    const request = data => new Request('https://example.com/admin/api', {method:'POST', headers:{Origin:'https://example.com', Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}, body:JSON.stringify(data)});
    assert.equal((await handleAdminAPI(request({action:'terminal_revoke_node',serverId:'node-a'}),env,sys)).status,503);
    assert.equal((await h.db.prepare("SELECT enabled FROM terminal_nodes WHERE server_id = 'node-a'").first()).enabled,0);
    const authorized = '44444444-4444-4444-8444-444444444444';
    const ordinary = '55555555-5555-4555-8555-555555555555';
    for (const id of [authorized,ordinary]) await h.db.prepare('INSERT INTO servers (id,name) VALUES (?,?)').bind(id,id).run();
    await issueTerminalNodeToken(h.db,authorized);
    assert.equal((await handleAdminAPI(request({action:'delete',id:authorized}),env,sys)).status,503);
    assert.equal(await h.db.prepare('SELECT id FROM servers WHERE id = ?').bind(authorized).first(),null);
    assert.equal((await h.db.prepare('SELECT enabled FROM terminal_nodes WHERE server_id = ?').bind(authorized).first()).enabled,0);
    const guardedEnv = {...env,TERMINAL_BROKER:{idFromName:id=>id,get:()=>({fetch:async()=>{throw new Error('ordinary deletion must not instantiate a broker');}})}};
    assert.equal((await handleAdminAPI(request({action:'delete',id:ordinary}),guardedEnv,sys)).status,200);
  } finally {await h.dispose();}
});

test('node disable or rotation between token validation and admission cannot forward an old credential', async () => {
  const h = await harness();
  try {
    const sys = await loadSiteSettings(h.db,true);
    for (const mutation of ['enabled = 0', 'credential_version = 2']) {
      await h.db.prepare("UPDATE terminal_nodes SET enabled = 1, credential_version = 1 WHERE server_id = 'node-a'").run();
      const db = new Proxy(h.db,{get(target,key) {
        if (key === 'prepare') return sql => {
          const statement = target.prepare(sql);
          if (sql.includes('token_hash = ?')) return {bind(...values) {const bound=statement.bind(...values);return {async first() {
            const verified=await bound.first();
            await h.db.prepare(`UPDATE terminal_nodes SET ${mutation} WHERE server_id = 'node-a'`).run();
            return verified;
          }};}};
          return statement;
        };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      }});
      const env = {DB:db,API_SECRET:'test-report-secret',TERMINAL_BROKER:{idFromName:id=>id,get:()=>({fetch:async()=>new Response('Unexpected admission')})}};
      const request = new Request('https://example.com/api/agent/terminal/control',{headers:{Upgrade:'websocket',...h.agentHeaders()}});
      assert.equal((await handleTerminalUpgrade(request,env,sys)).status,401);
    }
  } finally {await h.dispose();}
});

test('ordinary node terminal status validates authority but creates no cold broker', async () => {
  const h = await harness();
  try {
    await h.db.prepare("INSERT INTO servers (id,name) VALUES ('ordinary-node','ordinary')").run();
    let calls=0;
    const env={DB:h.db,API_SECRET:'test-report-secret',TERMINAL_BROKER:{idFromName:id=>id,get(){calls++;throw new Error('ordinary node must not instantiate broker');}}};
    const request=new Request('https://example.com/admin/api',{headers:{Origin:'https://example.com',Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`}});
    const response=await handleTerminalAdminAction({request,env,sys:await loadSiteSettings(h.db,true),data:{action:'terminal_status',serverId:'ordinary-node'}});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{enabled:false,connected:false,supported:false,protocol:null,platform:null,activeCount:0});
    assert.equal(calls,0);
  } finally {await h.dispose();}
});
