import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';

import { generateToken } from '../src/middleware/auth.js';
import { issueTerminalNodeToken } from '../src/database/terminal.js';
import { saveSiteOptions, clearSiteSettingsCache } from '../src/utils/settings.js';

export async function harness() {
  const source = `
    import worker from './src/index.js';
    import { TerminalBroker } from './src/durable/TerminalBroker.js';
    import * as terminalDatabase from './src/database/terminal.js';
    export { MetricsBroadcaster } from './src/index.js';
    const counts = {d1:0, authReads:0, authWrites:0, timeouts:0, intervals:0, terminalQueries:[], errors:[]};
    const nativeError = console.error;
    console.error = (...args) => {counts.errors.push(args.map(value=>value instanceof Error ? value.message : String(value))); nativeError(...args);};
    const nativeTimeout = globalThis.setTimeout, nativeInterval = globalThis.setInterval;
    const nativeNow = Date.now; let clockOffset = 0;
    Date.now = () => nativeNow() + clockOffset;
    globalThis.setTimeout = (...args) => {counts.timeouts++; return nativeTimeout(...args);};
    globalThis.setInterval = (...args) => {counts.intervals++; return nativeInterval(...args);};
    function countedDb(db) {
      function statement(stmt, sql) {return new Proxy(stmt, {get(target,key) {
        if (key === 'bind') return (...args) => statement(target.bind(...args), sql);
        if (['run','first','all','raw'].includes(key)) return (...args) => {
          counts.d1++;
          if (/terminal_(audit|auth_sessions|nodes)/.test(sql)) counts.terminalQueries.push(sql.trim());
          if (sql.includes('terminal_auth_sessions')) {
            if (sql.trim().startsWith('SELECT')) counts.authReads++; else counts.authWrites++;
          }
          return target[key](...args);
        };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      }});}
      return new Proxy(db, {get(target,key) {
        if (key === 'prepare') return sql => statement(target.prepare(sql), sql);
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      }});
    }
    export class TestBroker {
      constructor(state, env) {
        this.state = state; this.stats = {reads:0, alarmReads:0, writes:0, alarms:0, d1:0, closes:0, closeErrors:0}; this.failAudit = false;
        const stats = this.stats, self = this;
        const storage = new Proxy(state.storage, {get(target, key) {
          if (typeof target[key] !== 'function') return target[key];
          return (...args) => {
            if (key === 'get') stats.reads++;
            if (key === 'getAlarm') stats.alarmReads++;
            if (key === 'put' || key === 'delete') stats.writes++;
            if (key === 'setAlarm' || key === 'deleteAlarm') stats.alarms++;
            if (key === 'get' && self.failStorageReads) return Promise.reject(new Error('test storage read outage'));
            if (key === (self.failStorageOperation || 'put') && self.failStorageIn > 0 && --self.failStorageIn === 0) {
              if (self.commitThenFail) return target[key](...args).then(() => {throw new Error('test ambiguous write acknowledgement');});
              return Promise.reject(new Error('test storage write outage'));
            }
            if (key === 'setAlarm' && self.pauseAlarmOnce) {
              self.pauseAlarmOnce=false;
              return target[key](...args).then(async result => {self.alarmPending=true; await new Promise(resolve=>{self.releaseAlarm=resolve;}); return result;});
            }
            return target[key](...args);
          };
        }});
        this.context = new Proxy(state, {get(target, key) {
          if (key === 'storage') return storage;
          if (key === 'acceptWebSocket') return (ws, tags) => {
            const close = ws.close.bind(ws);
            const send = ws.send.bind(ws);
            ws.send = (...args) => {if (self.failSendSession === ws.deserializeAttachment()?.sessionId) throw new Error('test peer write failure'); return send(...args);};
            const attach = ws.serializeAttachment.bind(ws);
            ws.serializeAttachment = value => {
              self.attachmentWrites = (self.attachmentWrites || 0) + 1;
              if (self.failAttachmentSession === value.sessionId) {self.failAttachmentSession=null; throw new Error('test attachment write failure');}
              return attach(value);
            };
            ws.close = (...args) => {stats.closes++; try {return close(...args);} catch (e) {stats.closeErrors++; throw e;}};
            return target.acceptWebSocket(ws, tags);
          };
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
        }});
        this.env = {...env, DB: new Proxy(env.DB, {get(target, key) {
          if (key === 'prepare') return sql => {
            stats.d1++;
            if (self.failAudit && sql.includes('INSERT INTO terminal_audit')) throw new Error('test audit outage');
            const statement = target.prepare(sql);
            if (sql.includes('FROM settings JOIN servers') && self.delayAuthorityOnceMs) return {bind(...values) {
              const bound=statement.bind(...values); return {async first() {
                const result=await bound.first();
                const delay=self.delayAuthorityOnceMs; self.delayAuthorityOnceMs=0;
                await target.prepare('UPDATE terminal_auth_sessions SET revoked_at=?').bind(Date.now()).run();
                clockOffset+=delay;
                return result;
              }};
            }};
            if (sql.includes('INSERT INTO terminal_audit')) return {bind(...values) {
              const bound = statement.bind(...values);
              return {async run() {
                if (self.pauseAudit && values[3] === 'start') {
                  self.auditPending = true;
                  await new Promise(resolve => { self.releaseAudit = resolve; });
                }
                return bound.run();
              }};
            }};
            return statement;
          };
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
        }})};
        this.broker = new TerminalBroker(this.context, this.env);
      }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/test/stats') return Response.json(this.stats);
        if (path === '/test/pause-alarm') {this.pauseAlarmOnce=true; return new Response('OK');}
        if (path === '/test/alarm-pending') return Response.json({pending:!!this.alarmPending});
        if (path === '/test/release-alarm') {this.alarmPending=false; this.releaseAlarm?.(); return new Response('OK');}
        if (path === '/test/delay-authority') {this.delayAuthorityOnceMs=Number(new URL(request.url).searchParams.get('advance')); return new Response('OK');}
        if (path === '/test/attachment-stats') return Response.json({writes:this.attachmentWrites || 0});
        if (path === '/test/fail-attachment') {this.failAttachmentSession=new URL(request.url).searchParams.get('session'); return new Response('OK');}
        if (path === '/test/corrupt-attachment') {const query=new URL(request.url).searchParams; const ws=this.state.getWebSockets().find(ws=>ws.deserializeAttachment()?.sessionId===query.get('session') && ws.deserializeAttachment()?.role===query.get('role')); const a=ws.deserializeAttachment(); a.forwarded=Number(query.get('forwarded')); ws.serializeAttachment(a); return new Response('OK');}
        if (path === '/test/clock') {clockOffset += Number(new URL(request.url).searchParams.get('advance') || 0); return Response.json({now:Date.now()});}
        if (path === '/test/alarm') {await this.state.storage.deleteAlarm(); await this.broker.alarm(); return new Response('OK');}
        if (path === '/test/fail-send') {this.failSendSession=new URL(request.url).searchParams.get('session'); return new Response('OK');}
        if (path === '/test/fail-audit') { this.failAudit = true; return new Response('OK'); }
        if (path === '/test/fail-storage-once') {const query=new URL(request.url).searchParams; this.failStorageIn=Number(query.get('nth')||1); this.failStorageOperation=query.get('kind')||'put'; this.commitThenFail=query.get('commit')==='1'; return new Response('OK');}
        if (path === '/test/fail-storage-read') {this.failStorageReads=true; return new Response('OK');}
        if (path === '/test/restore-storage') {this.failStorageReads=false; this.failStorageIn=0; return new Response('OK');}
        if (path === '/test/pause-audit') { this.pauseAudit = true; return new Response('OK'); }
        if (path === '/test/audit-pending') return Response.json({pending:!!this.auditPending});
        if (path === '/test/release-audit') {this.pauseAudit = false; this.releaseAudit?.(); return new Response('OK');}
        if (path === '/test/internal') return this.broker.fetch(new Request('https://terminal.internal/' + new URL(request.url).searchParams.get('op'), request));
        if (path === '/test/snapshot') return Response.json({meta:await this.state.storage.get('terminal'), blocked:!!this.broker.blocked, alarm:await this.state.storage.getAlarm(), peers:this.broker.peers.size, attachments:this.state.getWebSockets().map(ws=>ws.deserializeAttachment())});
        if (path === '/test/legacy-capability') {const meta=await this.state.storage.get('terminal');delete meta.hello;await this.state.storage.put('terminal',meta);this.broker=new TerminalBroker(this.context,this.env);await this.broker.ready;return new Response('OK');}
        if (path === '/test/rebuild') { this.broker = new TerminalBroker(this.context, this.env); await this.broker.ready; return new Response('OK'); }
        if (path === '/test/expire') { await this.broker.ready; await this.broker.mutate((effects,meta) => {for (const s of meta.sessions) s.deadline = Date.now()-1;}); return new Response('OK'); }
        return this.broker.fetch(request);
      }
      webSocketMessage(...args) { return this.broker.webSocketMessage(...args); }
      webSocketClose(...args) { return this.broker.webSocketClose(...args); }
      webSocketError(...args) { return this.broker.webSocketError(...args); }
      alarm() { return this.broker.alarm(); }
    }
    export default {async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/test/worker-stats') return Response.json(counts);
      if (url.pathname === '/test/cleanup') return terminalDatabase.cleanupTerminalRecords(countedDb(env.DB), Number(url.searchParams.get('now'))).then(() => new Response('OK'));
      if (url.pathname === '/test/cron') {await worker.scheduled({cron:url.searchParams.get('cron')}, {...env,DB:countedDb(env.DB)}, ctx); return new Response('OK');}
      if (url.pathname.startsWith('/test/')) {
        return env.TERMINAL_BROKER.get(env.TERMINAL_BROKER.idFromName(url.searchParams.get('node') || 'node-a')).fetch(request);
      }
      return worker.fetch(request, {...env,DB:countedDb(env.DB)}, ctx);
    }};
  `;
  const output = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'terminal-test.js' }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'terminal-test' }, durableObjects: { TERMINAL_BROKER: {className: 'TestBroker', useSQLite: true}, METRICS_BROADCASTER: {className: 'MetricsBroadcaster', useSQLite: true} }, bindings: {API_SECRET: 'test-report-secret'} });
  const db = await mf.getD1Database('DB');
  const { initDatabase } = await import('../src/database/schema.js?fixture=' + crypto.randomUUID());
  await initDatabase(db);
  clearSiteSettingsCache();
  const sys = {jwt_secret: 's'.repeat(64), terminal_enabled: 'true', theme_url: ''};
  await saveSiteOptions(db, sys);
  for (const node of ['node-a', 'node-b']) await db.prepare('INSERT INTO servers (id, name) VALUES (?, ?)').bind(node, node).run();
  const token = await generateToken({API_SECRET: 'test-report-secret'}, sys);
  const otherToken = await generateToken({API_SECRET: 'test-report-secret'}, sys);
  const nodes = { 'node-a': await issueTerminalNodeToken(db, 'node-a'), 'node-b': await issueTerminalNodeToken(db, 'node-b') };
  const clients = [];
  async function fetch(path, options = {}) { return mf.dispatchFetch(`https://example.com${path}`, options); }
  async function action(action, data = {}, options = {}) {
    return fetch('/admin/api', {method: 'POST', headers: {Cookie: `cfsm_auth=${encodeURIComponent(token)}`, Origin: 'https://example.com', 'Content-Type': 'application/json', ...options.headers}, body: JSON.stringify({action, ...data})});
  }
  async function socket(path, headers = {}) {
    const runtime = new URL(await mf.ready);
    runtime.protocol = runtime.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(new URL(path, runtime), {headers:{'MF-Original-URL':`https://example.com${path}`, ...headers}});
    const messages = [];
    ws.on('error', () => {});
    ws.on('message', (data, binary) => messages.push(binary ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.toString()));
    return new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.once('open', () => { clients.push(ws); resolve({response:{status:101}, ws, messages}); });
      ws.once('unexpected-response', (request, response) => {
        request.on('error', reject);
        request.socket.on('error', reject);
        response.on('error', reject);
        response.once('end', () => {request.destroy(); resolve({response:{status:response.statusCode}});});
        response.resume();
      });
    });
  }
  function agentHeaders(node = 'node-a') { return {Authorization: `Bearer ${nodes[node].token}`, 'X-CFSM-Server-Id': node}; }
  async function control(node = 'node-a') {
    const peer = await socket('/api/agent/terminal/control', agentHeaders(node));
    if (peer.ws) { peer.ws.send(JSON.stringify({type:'hello', protocol:1, platform:'linux', capabilities:['terminal.pty.v1']})); await until(async () => (await (await action('terminal_status', {serverId:node})).json()).supported); }
    return peer;
  }
  return {mf, db, token, otherToken, nodes, fetch, action, socket, agentHeaders, control, clients, async dispose() {for (const ws of clients) {try {ws.terminate();} catch {}} await mf.dispose(); clearSiteSettingsCache();}};
}

export async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for observable terminal event');
}
export const controls = peer => peer.messages.filter(value => typeof value === 'string').map(value => JSON.parse(value));

export async function openPair(h, control, requestId = crypto.randomUUID(), node = 'node-a') {
  const response = await h.action('terminal_open', {serverId:node, clientRequestId:requestId, cols:80, rows:24});
  const session = await response.json();
  if (response.status !== 200) throw new Error(`Open rejected: ${response.status} ${JSON.stringify(session)}`);
  await until(() => controls(control).some(frame => frame.sessionId === session.sessionId));
  const open = controls(control).find(frame => frame.sessionId === session.sessionId);
  const browser = await h.socket(session.browserPath, {Cookie:`cfsm_auth=${encodeURIComponent(h.token)}`, Origin:'https://example.com'});
  const agent = await h.socket(`/api/agent/terminal/session/${session.sessionId}`, {...h.agentHeaders(node), 'X-CFSM-Terminal-Ticket':open.ticket});
  return {session, open, browser, agent};
}
