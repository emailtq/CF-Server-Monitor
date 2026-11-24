import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';
import { issueNodeToken } from '../../src/database/nodeCredentials.js';
import { saveSiteOptions, clearSiteSettingsCache } from '../../src/utils/settings.js';

// Faults are below the production session/Worker boundary; all frames use actual ws networking.
export async function createMonitorRuntimeFixture(t, options = {}) {
  const output = await build({stdin:{contents:runtimeSource,resolveDir:process.cwd(),sourcefile:'monitor-runtime-worker.mjs'},
    bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:*']});
  const mf = new Miniflare({modules:true, script:output.outputFiles[0].text, compatibilityDate:'2024-12-01', compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'monitor-session'}, durableObjects:{METRICS_BROADCASTER:{className:'TestMetricsBroadcaster', useSQLite:true}},
    ...(options.persistencePath ? {resourcePersistencePath:options.persistencePath} : {})});
  const clients = [];
  const dispose = async () => {for (const ws of clients) ws.terminate(); await mf.dispose(); clearSiteSettingsCache();};
  t?.after(dispose);
  const db = await mf.getD1Database('DB');
  const {initDatabase} = await import('../../src/database/schema.js?fixture=' + crypto.randomUUID());
  await initDatabase(db);
  if (options.seed !== false) await saveSiteOptions(db, {jwt_secret:'s'.repeat(64), wss_report_enabled:'true', terminal_enabled:'false', is_public:'false',
    custom_ct:'',custom_cu:'',custom_cm:'',custom_bd:'',node_1:'',node_2:'',node_3:'',node_4:'',extra_ping_nodes:[]});
  const nodes = {};
  for (const [index, id] of ['node-a','node-b'].entries()) {
    await db.prepare('INSERT OR IGNORE INTO servers(id,name,history_partition_id) VALUES(?,?,?)').bind(id,id,index+1).run();
    nodes[id] = options.nodes?.[id] || await issueNodeToken(db,id);
  }
  const fetch = (path, init) => mf.dispatchFetch(`https://example.com${path}`, init);
  const control = async (op, fields = {}) => (await fetch('/test/control', {method:'POST',body:JSON.stringify({op,...fields})})).json();
  async function socket(path = '/api/agent/ws', node = 'node-a', extra = {}) {
    const runtime = new URL(await mf.ready); runtime.protocol = 'ws:';
    const ws = new WebSocket(new URL(path,runtime), {headers:{'MF-Original-URL':`https://example.com${path}`,
      ...(node ? {Authorization:`Bearer ${nodes[node].token}`} : {}), ...extra}});
    const messages = [];
    let headers;
    ws.once('upgrade',response=>{headers=response.headers;});
    ws.on('error', () => {});
    ws.on('message', data => messages.push(data.toString()));
    return new Promise((resolve,reject) => {
      ws.once('error',reject);
      ws.once('open',() => {clients.push(ws); resolve({ws,messages,status:101,headers});});
      ws.once('unexpected-response',(request,response) => {
        request.on('error',reject);request.socket.on('error',reject);response.on('error',reject);
        response.resume(); response.once('end',() => {request.destroy(); resolve({messages,status:response.statusCode});});
      });
    });
  }
  const post = (body, node = 'node-a') => fetch('/update',{method:'POST',headers:{Authorization:`Bearer ${nodes[node].token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {mf,db,nodes,fetch,socket,post,control,dispose,snapshot:() => control('snapshot')};
}

export async function until(predicate, event = 'monitor event') {
  for (let i=0;i<200;i++) {if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,10));}
  throw new Error(`Timed out waiting for ${event}`);
}
export const frames = peer => peer.messages.map(raw => JSON.parse(raw));
export const send = (peer, method, params, id) => peer.ws.send(JSON.stringify({jsonrpc:'2.0',method,params,...(id === undefined ? {} : {id})}));

const runtimeSource = `
import worker, {MetricsBroadcaster} from './src/index.js';
const runtimeNow=Date.now;let clockOffset=0;Date.now=()=>runtimeNow()+clockOffset;
const runtimeTick=performance.now.bind(performance);let fixedTick=null;
Object.defineProperty(performance,'now',{value:()=>fixedTick ?? runtimeTick()});

export class TestMetricsBroadcaster extends MetricsBroadcaster {
  constructor(state,env) {
    const fault = {}, counts = {puts:0,alarms:0,dbRowsWritten:0,dbRowsRead:0,dbCalls:0,gets:0,lists:0,deletes:0,alarmReads:0};
    const context = new Proxy(state,{get(target,key) {
      if (key === 'storage') return new Proxy(target.storage,{get(storage,op) {
        if (op === 'setAlarm' && fault.missingAlarm) return undefined;
        if (op === 'put') return (...args) => {counts.puts++;return storage.put(...args);};
        if (op === 'get') return (...args) => {counts.gets++;return storage.get(...args);};
        if (op === 'list') return (...args) => {counts.lists++;return storage.list(...args);};
        if (op === 'delete') return (...args) => {counts.deletes++;return storage.delete(...args);};
        if (op === 'getAlarm') return async (...args)=>{counts.alarmReads++;const alarm=await storage.getAlarm(...args);if(fault.delayedAlarmRead){fault.delayedAlarmRead=false;clockOffset+=61000;}return alarm;};
        if (op === 'setAlarm') return async (...args) => {
          counts.alarms++; if (fault.alarm) throw Error('test alarm outage');
          const result = await storage.setAlarm(...args);
          if (fault.pauseAlarm) {fault.pauseAlarm=false;fault.paused=true;await new Promise(resolve=>fault.release=resolve);fault.paused=false;}
          return result;
        };
        return typeof storage[op]==='function'?storage[op].bind(storage):storage[op];
      }});
      return typeof target[key]==='function'?target[key].bind(target):target[key];
    }});
    const db=new Proxy(env.DB,{get(target,key) {
      if (key==='batch') return async statements=>{
        const results=await target.batch(statements);
        counts.dbRowsWritten+=results.reduce((n,r)=>n+(r.meta?.rows_written || 0),0);
        counts.dbRowsRead+=results.reduce((n,r)=>n+(r.meta?.rows_read || 0),0);counts.dbCalls+=statements.length;
        return results;
      };
      if (key==='prepare') return sql => {
        if (fault.auth && /n.token_version/.test(sql)) throw Error('test auth outage');
        if (fault.tasks && /latency_tasks/.test(sql)) throw Error('test tasks outage');
        if (fault.policy && /site_options/.test(sql)) throw Error('test policy outage');
        if (fault.telemetryRead && /monitor_telemetry_receipts/.test(sql)) throw Error('test D1 receipt unavailable');
        const statement=target.prepare(sql);
        if(fault.pauseReset && sql.startsWith('SELECT reset_day FROM servers'))return new Proxy(statement,{get(s,operation){
          if(operation==='bind')return (...args)=>{const b=s.bind(...args);return {async first(){const row=await b.first();fault.pauseReset=false;fault.paused=true;await new Promise(r=>fault.release=r);fault.paused=false;return row;}};};
          return typeof s[operation]==='function'?s[operation].bind(s):s[operation];
        }});
        if (fault.pauseAuthorityNode && /n.token_version/.test(sql)) return new Proxy(statement,{get(s,operation) {
          if (operation==='bind') return (...args)=>{
            const bound=s.bind(...args);
            if (args[0]!==fault.pauseAuthorityNode) return bound;
            return new Proxy(bound,{get(b,key) {
              if (key==='first') return async (...values)=>{const row=await b.first(...values);fault.pauseAuthorityNode=null;fault.paused=true;fault.pausedNode=args[0];await new Promise(resolve=>fault.release=resolve);fault.paused=false;return row;};
              return typeof b[key]==='function'?b[key].bind(b):b[key];
            }});
          };
          return typeof s[operation]==='function'?s[operation].bind(s):s[operation];
        }});
        if (fault.pausePolicy && /site_options/.test(sql)) return new Proxy(statement,{get(s,operation) {
          if (operation==='first') return async (...args)=>{const row=await s.first(...args);fault.pausePolicy=false;fault.paused=true;await new Promise(resolve=>fault.release=resolve);fault.paused=false;return row;};
          return typeof s[operation]==='function'?s[operation].bind(s):s[operation];
        }});
        if (fault.pauseHistory && /INSERT INTO metrics_history/.test(sql)) {
          const wrap = s => new Proxy(s,{get(bound,operation) {
            if (operation==='bind') return (...args)=>wrap(bound.bind(...args));
            if (operation==='run') return async (...args)=>{fault.pauseHistory=false;fault.paused=true;await new Promise(resolve=>fault.release=resolve);fault.paused=false;return bound.run(...args);};
            return typeof bound[operation]==='function'?bound[operation].bind(bound):bound[operation];
          }});return wrap(statement);
        }
        if (fault.pauseTasks && /latency_tasks/.test(sql)) return new Proxy(statement,{get(s,operation) {
          if (operation==='all') return async (...args) => {const result=await s.all(...args);fault.pauseTasks=false;fault.paused=true;await new Promise(resolve=>fault.release=resolve);fault.paused=false;return result;};
          return typeof s[operation]==='function'?s[operation].bind(s):s[operation];
        }});
        const measured=s=>new Proxy(s,{get(s,op){
          if(op==='bind')return (...args)=>measured(s.bind(...args));
          if(['run','all'].includes(op))return async (...args)=>{const r=await s[op](...args);counts.dbCalls++;counts.dbRowsRead+=r.meta?.rows_read || 0;counts.dbRowsWritten+=r.meta?.rows_written || 0;return r;};
          if(op==='first')return async (...args)=>{const r=await s.all();counts.dbCalls++;counts.dbRowsRead+=r.meta?.rows_read || 0;return args.length?r.results[0]?.[args[0]]:r.results[0] ?? null;};
          return typeof s[op]==='function'?s[op].bind(s):s[op];
        }});
        return measured(statement);
      };
      return typeof target[key]==='function'?target[key].bind(target):target[key];
    }});
    super(context,{...env,DB:db});this.fault=fault;this.counts=counts;this.testStorage=state.storage;
  }
  async fetch(request) {
    if (new URL(request.url).pathname !== '/test/control') return super.fetch(request);
    const {op,...fields}=await request.json();
    if (op==='tick') fixedTick=fields.value;
    if (op==='advance') {clockOffset+=fields.ms;fixedTick=(fixedTick ?? runtimeTick())+fields.ms;}
    if (op==='drain') await this.monitorAgentSession.run(fields.serverId || 'node-a',async()=>{});
    if (op==='fault') Object.assign(this.fault,fields);
    if (op==='release') this.fault.release?.();
    if (op==='config') await this._handleAgentConfigChanged(new Request('http://internal/agent-config-changed',{method:'POST',body:JSON.stringify({latencyTasksChanged:true})}));
    if (op==='rebuild') {this.monitorAgentSession=new this.monitorAgentSession.constructor(this);await this.monitorAgentSession.ready;}
    if (op==='alarm') {await this.state.storage.deleteAlarm();await this.alarm();}
    if (op==='removeAlarm') await this.state.storage.deleteAlarm();
    if (op==='resource') return super.fetch(new Request('http://internal/evaluate-resource-alerts',{method:'POST',body:JSON.stringify(fields)}));
    if (op==='latest') return super.fetch(new Request('http://internal/latest-report-updates',{method:'POST',body:JSON.stringify(fields)}));
    if (op==='broadcastLatest') this._broadcastBatch(this._getLatestReportUpdates(fields.serverIds));
    if (op==='orphanOwner') for(const [id,owner] of this.monitorAgentSession.owners) await this.state.storage.put('monitor-owner:'+id,{...owner,active:true});
    if (op==='batch') await super.fetch(new Request('http://internal/batch-push',{method:'POST',body:JSON.stringify({updates:fields.updates,latestReportOnly:true})}));
    if (op==='invalidate') await super.fetch(new Request('https://metrics.internal/node-invalidated',{method:'POST',body:JSON.stringify(fields)}));
    if (op==='expire') for(const ws of this.state.getWebSockets()) {const a=ws.deserializeAttachment();if(a?.kind==='monitor-agent') ws.serializeAttachment({...a,leaseUntil:Date.now()-1});}
    const agent=this.monitorAgentSession;
    return Response.json({fault:{paused:this.fault.paused===true,pausedNode:this.fault.pausedNode},counts:this.counts,
      attachments:this.state.getWebSockets().map(ws=>ws.deserializeAttachment()),alarm:await this.testStorage.getAlarm(),
      helperIdentity:agent ? (agent.testIdentity ||= crypto.randomUUID()) : null,
      owners:agent ? [...agent.owners.entries()] : [],inputs:agent ? [...agent.inputs.entries()] : [],
      latest:[...this.latestReportUpdates.entries()],durable:[...await this.state.storage.list({prefix:'monitor-owner:'})]});
  }
}
export default {fetch(request,env,ctx) {
  if(new URL(request.url).pathname==='/test/control') return env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global')).fetch(request);
  return worker.fetch(request,env,ctx);
}};
`;
