import { authenticateNodeRequest } from '../middleware/nodeAuth.js';
import { readLatencyTaskDocument, ensureLatencyTasks } from '../database/latencyTasks.js';
import { getMonitorProbeIds } from '../database/monitorProbeIds.js';
import { latencyTaskAssigned } from '../shared/latencyTasks.js';
import { validatePingNode } from '../shared/pingNode.js';
import { loadSiteSettings } from '../utils/settings.js';
import { clearLatestReportUpdate } from '../utils/latestReportCache.js';
import { parseAgentRpc, serializeAgentRpc, agentRpcErrorResponse, negotiateMonitorCapabilities } from '../shared/monitorAgentProtocol.js';
import { ensureMonitorTelemetrySchema, recordMonitorBatch, recordMonitorStandard, recordMonitorLive, markMonitorLegacy, projectMonitorLatest, readMonitorLatest } from '../database/monitorTelemetry.js';
import { readMonitorReporting } from '../services/monitorReporting.js';
import { evaluateTrafficAlert } from '../services/notification.js';
import { isValidMonitorPrincipal, MonitorTelemetryError } from '../shared/monitorTelemetry.js';
export { isValidMonitorPrincipal } from '../shared/monitorTelemetry.js';

export const MONITOR_AGENT_KIND = 'monitor-agent';
const OWNER_KEY = 'monitor-owner:';
const LEASE_MS = 60000;
const IMPLEMENTED = ['cf.report.batch','cf.ping.tasks','cf.reporting.configure'].map(method=>({method,version:1}));
const TEXT_FACTS = ['hostname','os','kernel','arch','virt','cpu_name','agent_version','ipv4','ipv6'];
const REPORT_FIELDS = ['boot_id','iface','uptime','cpu','load','mem_total','mem_used','swap_total','swap_used','disk_total','disk_used','net_rx_total','net_tx_total','net_rx','net_tx','tcp','udp','procs'];
const cleanText = value => typeof value === 'string' ? [...value].filter(c => !/[\p{Cc}<>"']/u.test(c)).slice(0,128).join('') : '';
const unavailable = (error, status = 503) => Response.json({error}, {status, headers:{'Cache-Control':'no-store'}});
const probeAvailability = tasks => ({available:!tasks.error,mode:'tcp',count:tasks.count ?? tasks.assigned.length,limit:64,
  ...(tasks.error ? {error:tasks.error} : {})});
const batchFailure = (error,rpc) => {
  if(error instanceof MonitorTelemetryError && rpc) {
    const statuses={monitor_sequence_gap:409,monitor_receipt_conflict:409,monitor_inactive_stream:409,
      monitor_stream_admission:409,monitor_authority_denied:403,monitor_storage_overflow:413,monitor_probe_generation:400,monitor_invalid_batch:400};
    const known=Object.hasOwn(statuses,error.code),message=known ? error.code : 'monitor_invalid_batch';
    const expected=error.code === 'monitor_sequence_gap' && Number.isSafeInteger(error.expectedSequence) && error.expectedSequence>0
      ? ` expectedSequence=${error.expectedSequence}` : '';
    return {status:known ? statuses[error.code] : 400,body:{jsonrpc:'2.0',id:rpc.id,
      error:{code:error.code === 'monitor_authority_denied' ? -32001 : -32602,message:message+expected}}};
  }
  const protocol=agentRpcErrorResponse(error);
  if(protocol) return {status:400,body:protocol};
  return {status:500,body:rpc ? {jsonrpc:'2.0',id:rpc.id,error:{code:-32603,message:'monitor_persistence_unavailable'}} : {error:'monitor_persistence_unavailable'}};
};

// One queue covers socket admission AND actual legacy HTTP/WS writes, not just broadcast filtering.
export class MonitorAgentSession {
  constructor(broadcaster) {
    this.host = broadcaster;
    this.owners = new Map();
    this.inputs = new Map();
    this.queues = new Map();
    this.standardHeld = new Map();
    this.ready = this.restore();
  }

  async restore() {
    if (typeof this.host.state.storage?.list !== 'function') return;
    try {
      for (const [key, owner] of await this.host.state.storage.list({prefix:OWNER_KEY})) {
        if (isValidMonitorPrincipal(owner) && Number.isSafeInteger(owner.generation) && owner.generation > 0 &&
            Number.isSafeInteger(owner.credentialVersion) && owner.credentialVersion > 0 &&
            typeof owner.active === 'boolean' && ['monitor','legacy'].includes(owner.source) && key === OWNER_KEY + owner.serverId) {
          const live = [...this.sockets(), ...this.host._getAgentReportWebSockets()].some(ws => {
            const attachment = ws.deserializeAttachment();
            return attachment?.authenticated && attachment.serverId === owner.serverId && attachment.generation === owner.generation && attachment.tokenVersion === owner.tokenVersion;
          });
          const recovered = owner.active && !live ? {...owner,active:false} : owner;
          if (recovered !== owner) await this.host.state.storage.put(key,recovered);
          this.owners.set(owner.serverId, recovered);
        } else throw new Error('Invalid node ownership');
      }
    } catch (_) { this.restoreFailed = true; }
  }

  async run(serverId, operation) {
    await this.ready;
    if (this.restoreFailed) throw new Error('Node ownership unavailable');
    const previous = this.queues.get(serverId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(serverId, next);
    try { return await next; }
    finally { if (this.queues.get(serverId) === next) this.queues.delete(serverId); }
  }

  sockets() {
    return this.host.state.getWebSockets().filter(ws => ws.deserializeAttachment()?.kind === MONITOR_AGENT_KIND);
  }

  isCurrent(attachment) {
    const owner = this.owners.get(attachment?.serverId);
    return !!owner?.active && owner.generation === attachment.generation && owner.tokenVersion === attachment.tokenVersion;
  }

  async claim(principal, source) {
    const previous = this.owners.get(principal.serverId);
    if (previous) {
      try {await this.flushStandard(previous,Date.now(),performance.now(),true);}
      catch (error) {if(error.code !== 'monitor_authority_denied') throw error;this.standardHeld.delete(principal.serverId);}
    }
    if (previous && previous.tokenVersion > principal.tokenVersion) throw new Error('Node token revoked');
    const generation = (previous?.generation || 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Node generation exhausted');
    if(source==='legacy')await markMonitorLegacy(this.host.env.DB,principal.serverId,generation);
    const owner = {serverId:principal.serverId, tokenVersion:principal.tokenVersion, credentialVersion:principal.version,
      generation, source, active:true, nativeTakenOver:source === 'monitor' || previous?.nativeTakenOver === true,previousCF:previous?.capabilities?.some(c=>c.method === 'cf.report.batch') === true};
    if(previous?.taskOffer) owner.taskOffer=previous.taskOffer;
    if(previous?.tokenVersion === principal.tokenVersion && previous.reportingApplied) owner.reportingApplied=previous.reportingApplied;
    if (typeof this.host.state.storage?.put === 'function') await this.host.state.storage.put(OWNER_KEY + owner.serverId, owner);
    else if (source === 'monitor') throw new Error('Node ownership unavailable');
    this.owners.set(owner.serverId, owner);
    this.inputs.delete(owner.serverId);
    this.host.latestReportUpdates.delete(owner.serverId);
    this.host.pendingFrontendBroadcasts.delete(owner.serverId);
    this.host.agentHistoryWrites.delete(owner.serverId);
    clearLatestReportUpdate(owner.serverId);
    for (const ws of [...this.sockets(), ...this.host._getAgentReportWebSockets()]) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.serverId !== owner.serverId) continue;
      if (attachment.kind === MONITOR_AGENT_KIND) this.close(ws, 'Node session replaced');
      else this.host._closeWsWithError(ws, 'Node session replaced', 409);
    }
    return owner;
  }

  close(ws, reason = 'Node authorization unavailable') {
    const attachment = ws.deserializeAttachment();
    if (attachment) ws.serializeAttachment({...attachment, authenticated:false, leaseUntil:0});
    if (this.isCurrent(attachment)) this.owners.set(attachment.serverId,{...this.owners.get(attachment.serverId),active:false});
    try { ws.close(1008, reason); } catch (_) {}
    const cleanup = this.release(ws).catch(() => {});
    if (typeof this.host.state.waitUntil === 'function') this.host.state.waitUntil(cleanup);
  }

  async release(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.generation) return;
    await this.run(attachment.serverId, async () => {
      const current = this.owners.get(attachment.serverId);
      if (!current || current.generation !== attachment.generation || current.tokenVersion !== attachment.tokenVersion) return;
      try {await this.flushStandard(attachment,Date.now(),performance.now(),true);}
      finally {
        const owner = {...this.owners.get(attachment.serverId), active:false};
        this.owners.set(owner.serverId, owner);
        await this.host.state.storage?.put?.(OWNER_KEY + owner.serverId, owner);
      }
    });
  }

  async readAuthority(principal) {
    // Require readable site metadata, not the legacy WSS transport schedule or viewer/terminal permissions.
    const policy = await this.host.env.DB.prepare("SELECT value FROM settings WHERE key = 'site_options'").first();
    const settings = policy && JSON.parse(policy.value);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Node policy unavailable');
    const row = await this.host.env.DB.prepare(`SELECT n.token_version, n.credential_version, s.ping_mode
      FROM terminal_nodes n JOIN servers s ON s.id = n.server_id WHERE n.server_id = ?`).bind(principal.serverId).first();
    if (!row || row.token_version !== principal.tokenVersion) return null;
    return row;
  }

  hasLease(ws, expected) {
    const current = ws.deserializeAttachment(), now = Date.now();
    return isValidMonitorPrincipal(current) && current.authenticated && this.isCurrent(current) &&
      current.serverId === expected?.serverId && current.tokenVersion === expected.tokenVersion && current.generation === expected.generation &&
      Number.isSafeInteger(current.credentialVersion) && current.credentialVersion > 0 &&
      Array.isArray(current.capabilities) && Array.isArray(current.tasks) &&
      Number.isSafeInteger(current.leaseUntil) && current.leaseUntil > now && current.leaseUntil <= now + LEASE_MS &&
      typeof this.host.state.storage?.setAlarm === 'function';
  }

  async authorize(ws, force = false, renew = true) {
    const attachment = ws.deserializeAttachment(), checkedAt = Date.now();
    if (!this.hasLease(ws,attachment)) {this.close(ws);return false;}
    try {
      // The platform consumes a firing alarm before calling alarm(); that is not a lost lease.
      if (!this.host.agentAuthorizationAlarmRunning) {
        const alarm = await this.host.state.storage.getAlarm();
        if (!Number.isSafeInteger(alarm) || !this.hasLease(ws,attachment) || alarm > ws.deserializeAttachment().leaseUntil) {this.close(ws);return false;}
      }
      if (!this.hasLease(ws,attachment)) {this.close(ws);return false;}
      if (!force && checkedAt < ws.deserializeAttachment().leaseUntil - LEASE_MS / 2) return true;
      const row = await this.readAuthority(attachment);
      if (!row || !this.hasLease(ws,attachment)) {
        this.close(ws, 'Node token revoked'); return false;
      }
      if (renew) {
        ws.serializeAttachment({...ws.deserializeAttachment(), credentialVersion:row.credential_version, leaseUntil:checkedAt + LEASE_MS});
        if (!await this.host._scheduleAgentWssHourAlarm()) {this.close(ws); return false;}
      }
      if (!this.hasLease(ws,attachment)) {this.close(ws);return false;}
      return true;
    } catch (_) { this.close(ws); return false; }
  }

  async tasks(serverId, initialize = false, cf = false) {
    let document = await readLatencyTaskDocument(this.host.env.DB);
    if (initialize) document = await ensureLatencyTasks(this.host.env.DB, await loadSiteSettings(this.host.env.DB, {forceRefresh:true}));
    if (!document) throw new Error('Node tasks unavailable');
    const tasks = document.tasks.filter(task => latencyTaskAssigned(task, serverId, document));
    const row = await this.host.env.DB.prepare('SELECT ping_mode FROM servers WHERE id = ?').bind(serverId).first();
    if (!row) throw new Error('Node tasks unavailable');
    if (!cf && tasks.length > 64) return {error:'monitor_tcp_tasks_limit', count:tasks.length, revision:document.revision};
    if (!cf && tasks.length && row.ping_mode === 'icmp') return {error:'monitor_icmp_tasks_unavailable',count:tasks.length,revision:document.revision};
    const ids = await getMonitorProbeIds(this.host.env.DB, tasks.map(task => task.metric_id || task.id));
    // Existing CF TCP probes use port 80 for bare hosts (probe.go defaultTaskPingTCPPort).
    const assigned = tasks.map(task => ({id:ids.get(task.metric_id || task.id),
      target:/^(?:\[[^\]]+\]|[^:]+):\d+$/.test(task.target) ? task.target : `${task.target}:80`,interval:task.interval}));
    if (assigned.some(task => !validatePingNode(task.target).valid || !/^(?:\[[^\]]+\]|[^:]+):\d+$/.test(task.target))) {
      return {error:'monitor_tcp_port_required',count:tasks.length,revision:document.revision};
    }
    const params = {version:1,revision:document.revision,tasks:tasks.map((task,i)=>({taskId:assigned[i].id,metricId:task.metric_id || task.id,target:row.ping_mode === 'icmp' ? task.target : assigned[i].target,intervalSeconds:task.interval,mode:row.ping_mode || 'tcp'}))};
    const wire = cf ? null : serializeAgentRpc({method:'ping.tasks',params:assigned},{senderRole:'hub',receiverRole:'agent'});
    return {wire, params, assigned:tasks.map((task,i) => ({taskId:assigned[i].id, metricId:task.metric_id || task.id})), revision:document.revision};
  }

  async upgrade(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return unavailable('monitor_upgrade_required',426);
    let principal;
    try { principal = await authenticateNodeRequest(request,this.host.env.DB); }
    catch (_) { return unavailable('node_authentication_unavailable'); }
    if (!principal) return unavailable('node_token_invalid',401);
    const origin = request.headers.get('Origin');
    const allowed = (this.host.env.CORS_ALLOWED_ORIGINS || '').split(',').map(value=>value.trim()).filter(Boolean);
    if (origin && origin !== request.headers.get('X-Real-Origin') && !allowed.includes(origin)) return unavailable('node_origin_denied',403);
    try {
      return await this.run(principal.serverId, async () => {
        if (typeof this.host.state.storage?.setAlarm !== 'function' || typeof this.host.state.storage?.getAlarm !== 'function' || typeof this.host.state.acceptWebSocket !== 'function') return unavailable('node_authorization_alarm_unavailable');
        const checkedAt = Date.now();
        if (!await this.readAuthority(principal)) return unavailable('node_token_invalid',401);
        await ensureMonitorTelemetrySchema(this.host.env.DB);
        const tasks = await this.tasks(principal.serverId,true);
        const availability = probeAvailability(tasks);
        const owner = await this.claim(principal,'monitor');
        const [client,server] = Object.values(new WebSocketPair());
        this.host.state.acceptWebSocket(server,['monitor-agent']);
        server.serializeAttachment({kind:MONITOR_AGENT_KIND,serverId:owner.serverId,tokenVersion:owner.tokenVersion,
          credentialVersion:owner.credentialVersion,generation:owner.generation,authenticated:true,leaseUntil:checkedAt + LEASE_MS,
          capabilities:[],tasks:tasks.assigned || [],taskRevision:tasks.revision,probeAvailability:availability,pending:{},standardStarted:false});
        if (!await this.host._scheduleAgentWssHourAlarm()) {this.close(server);return unavailable('node_authorization_alarm_unavailable');}
        // All upgrade awaits (including alarm/storage) precede a fresh token/owner/lease check.
        if (!await this.authorize(server,true,false)) return unavailable('node_token_invalid',401);
        if (tasks.wire) server.send(tasks.wire);
        // Optional headers report probe incompatibility; standard monitoring has no CF prerequisite.
        return new Response(null,{status:101,webSocket:client,headers:{'X-CFSM-Monitor-Probes':tasks.error || 'available',
          'X-CFSM-Monitor-Task-Count':String(availability.count)}});
      });
    } catch (_) { return unavailable('node_session_unavailable'); }
  }

  input(attachment) {
    let input = this.inputs.get(attachment.serverId);
    if (!input || input.generation !== attachment.generation) {
      input = {serverId:attachment.serverId,tokenVersion:attachment.tokenVersion,generation:attachment.generation,source:'monitor',
        probeAvailability:attachment.probeAvailability,facts:null,latest:null,probes:[]};
      this.inputs.set(attachment.serverId,input);
    }
    while (this.inputs.size > 1000) this.inputs.delete(this.inputs.keys().next().value);
    return input;
  }

  // All monitor inputs and effects stay inside the same node owner interval.
  async message(ws, raw) {
    const initial = ws.deserializeAttachment();
    const arrivalTick=performance.now();
    return this.run(initial.serverId, async () => {
      if (!await this.authorize(ws)) return;
      const attachment = ws.deserializeAttachment();
      let rpc;
      try { rpc = parseAgentRpc(raw,{implemented:IMPLEMENTED,negotiated:attachment.capabilities,...(attachment.pending?.[JSON.parse(raw).id] ? {expectedResponse:attachment.pending[JSON.parse(raw).id]} : {})}); }
      catch (error) {
        const response = agentRpcErrorResponse(error);
        if (response) ws.send(JSON.stringify(response));
        else this.close(ws,'Invalid monitor frame');
        return;
      }
      if (!rpc.known) return;
      if (rpc.kind === 'response') {
        const job=attachment.pending?.[rpc.id];
        const pending = {...attachment.pending}; delete pending[rpc.id];
        ws.serializeAttachment({...ws.deserializeAttachment(),pending});
        if (rpc.result?.persisted === true && rpc.result.revision === job?.revision &&
            (rpc.method !== 'cf.ping.tasks' || rpc.result.taskCount === job.taskCount) &&
            (rpc.method !== 'cf.reporting.configure' || rpc.result.correctionApplied === false) &&
            await this.authorize(ws,true,false)) {
          const key = rpc.method === 'cf.ping.tasks' ? 'tasksApplied' : 'reportingApplied';
          const owner = {...this.owners.get(attachment.serverId),[key]:{...rpc.result,...(job.persistent ? {persistent:job.persistent} : {})}};
          await this.host.state.storage.put(OWNER_KEY+owner.serverId,owner);this.owners.set(owner.serverId,owner);
        }
        return;
      }
      const receivedAt = Date.now();
      if (rpc.method === 'cf.capabilities') {
        const input=this.inputs.get(attachment.serverId);if(input)delete input.liveCheckpoint;
        let accepted = negotiateMonitorCapabilities(rpc.params.supports,IMPLEMENTED);
        // A node with probes needs the complete CF probe transport, otherwise keep its standard profile.
        if (attachment.probeAvailability.count>0 && !accepted.some(c=>c.method === 'cf.ping.tasks')) accepted=accepted.filter(c=>c.method !== 'cf.report.batch');
        if (!accepted.some(c=>c.method === 'cf.report.batch')) accepted=accepted.filter(c=>!['cf.ping.tasks','cf.reporting.configure'].includes(c.method));
        const batchSelected=accepted.some(c=>c.method === 'cf.report.batch');
        if(batchSelected) {
          if (attachment.standardStarted) await this.flushStandard(attachment,Date.now(),performance.now(),true);
          else this.standardHeld.delete(attachment.serverId);
        }
        ws.serializeAttachment({...ws.deserializeAttachment(),capabilities:accepted});
        const owner={...this.owners.get(attachment.serverId),capabilities:accepted,
          previousCF:batchSelected ? this.owners.get(attachment.serverId).previousCF : false};
        await this.host.state.storage.put(OWNER_KEY+owner.serverId,owner);this.owners.set(owner.serverId,owner);
        const result = {version:1,accepted,limits:{reportBatchBytes:524288,reportSamples:300,sshEvents:32,configBytes:65536,
          terminalControlBytes:4096,terminalDataBytes:16384,terminalCreditBytes:262144},fallbackPath:accepted.some(c=>c.method === 'cf.report.batch') ? '/api/agent/cf-report' : null};
        ws.send(serializeAgentRpc({kind:'response',id:rpc.id,result},{senderRole:'hub',receiverRole:'agent',implemented:IMPLEMENTED,expectedResponse:{id:rpc.id,method:rpc.method}}));
        await this.dispatchConfiguration(ws);
        return;
      }
      if (rpc.method === 'cf.report.batch') {
        try {
          const input=this.inputs.get(attachment.serverId);if(input)delete input.liveCheckpoint;
          const ack=await recordMonitorBatch(this.host.env,attachment,await this.batchSession(attachment,ws),raw);
          this.evaluateTraffic(attachment.serverId);
          ws.send(serializeAgentRpc({kind:'response',id:rpc.id,result:ack},{senderRole:'hub',receiverRole:'agent',implemented:IMPLEMENTED,negotiated:attachment.capabilities,expectedResponse:{id:rpc.id,method:rpc.method}}));
        } catch (error) {ws.send(JSON.stringify(batchFailure(error,rpc).body));}
        return;
      }
      const input = this.input(attachment);
      if(rpc.method === 'report') {
        if(input.lastReportTick != null && Math.max(0,arrivalTick-input.lastReportTick)<500) return;
        input.lastReportTick=arrivalTick;
      }
      if(rpc.method === 'ping.result') {
        if(!input.resultWindow || Math.max(0,arrivalTick-input.resultWindow.start)>=5000) input.resultWindow={start:arrivalTick,count:0};
        if(++input.resultWindow.count>128) return;
      }
      if (rpc.method === 'hello') {
        const facts = Object.fromEntries(TEXT_FACTS.map(key=>[key,cleanText(rpc.params?.[key])]));
        facts.cpu_cores = rpc.factCores === null ? 0 :
          (rpc.factCores >= BigInt(Number.MIN_SAFE_INTEGER) && rpc.factCores <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rpc.factCores) : String(rpc.factCores));
        input.facts = {...facts,receivedAt,source:'monitor',generation:attachment.generation};
      } else if (rpc.method === 'report') {
        const report = Object.fromEntries(REPORT_FIELDS.filter(key=>Object.hasOwn(rpc.params,key)).map(key=>[key,rpc.params[key]]));
        for (const key of ['boot_id','iface']) if (Object.hasOwn(report,key) && typeof report[key] !== 'string') delete report[key];
        const trafficReading = rpc.trafficReading ? {epoch:rpc.trafficReading.epoch,rx:String(rpc.trafficReading.rx),tx:String(rpc.trafficReading.tx)} : null;
        if (!attachment.capabilities.some(c=>c.method === 'cf.report.batch')) {
          const held=this.standardHeld.get(attachment.serverId);
          if (held) {
            await this.flushStandard(attachment,receivedAt,performance.now());
            await recordMonitorStandard(this.host.env,attachment,await this.standardSession(attachment),{report,byteTokens:rpc.byteTokens,receivedAt,facts:input.facts});
            ws.serializeAttachment({...ws.deserializeAttachment(),standardStarted:true});
          }
          this.standardHeld.set(attachment.serverId,{report,byteTokens:rpc.byteTokens,receivedAt,monotonic:performance.now(),generation:attachment.generation,
            leaseUntil:ws.deserializeAttachment().leaseUntil,started:ws.deserializeAttachment().standardStarted});
        }
        input.latest = {report,trafficReading,receivedAt,source:'monitor',owner:{serverId:attachment.serverId,tokenVersion:attachment.tokenVersion,generation:attachment.generation},capabilities:attachment.capabilities};
        let persisted;
        if(attachment.capabilities.some(c=>c.method === 'cf.report.batch')) {
          // Only a successful D1 result schedules the next checkpoint; this hint never books traffic or ACKs.
          if(!input.liveCheckpoint || receivedAt<input.liveCheckpoint.persistedAt || receivedAt-input.liveCheckpoint.persistedAt>=60000) {
            input.liveCheckpoint=await recordMonitorLive(this.host.env,attachment,await this.standardSession(attachment),{report,byteTokens:rpc.byteTokens,receivedAt,facts:input.facts});
          }
          persisted=input.liveCheckpoint.latest;
        } else persisted=(await readMonitorLatest(this.host.env.DB,[attachment.serverId])).get(attachment.serverId);
        const projection=projectMonitorLatest(attachment.serverId,{latest:{sampledAt:receivedAt,elapsedMs:0,report,byteTokens:rpc.byteTokens,source:'cf-live'},
          facts:input.facts,traffic:persisted?.monitor?.traffic,migration:persisted?.monitor?.migration});
        if(persisted) {
          for(const key of ['disk','disk_read_bps','disk_write_bps','disk_read_iops','disk_write_iops','disk_await_ms','disk_util','gpu_info'])projection[key]=persisted[key];
        }
        this.host._cacheLatestReportUpdates([{serverId:attachment.serverId,samples:[{ts:receivedAt,data:projection}]}],receivedAt);
      } else if (rpc.method === 'ping.result' && rpc.probeResult) {
        // Validate the delivered generation against the live catalog before recording the standard receiver probe.
        const document = await readLatencyTaskDocument(this.host.env.DB);
        if (!document) throw new Error('Node tasks unavailable');
        const catalogRaw=(await this.host.env.DB.prepare("SELECT value FROM settings WHERE key='latency_tasks'").first())?.value;
        if (JSON.parse(catalogRaw).revision !== document.revision) return;
        if (!await this.authorize(ws,true,false) || !this.hasLease(ws,attachment)) return;
        const current = ws.deserializeAttachment();
        const assigned = current.tasks.find(task=>task.taskId === rpc.probeResult.taskId && document.tasks.some(taskGeneration=>
          (taskGeneration.metric_id || taskGeneration.id) === task.metricId && latencyTaskAssigned(taskGeneration,current.serverId,document)));
        if (!assigned) return;
        const owner=this.owners.get(attachment.serverId);
        if (attachment.capabilities.some(c=>c.method === 'cf.report.batch') && owner.tasksApplied?.revision === owner.taskOffer?.revision) return;
        await recordMonitorStandard(this.host.env,attachment,await this.standardSession(attachment,catalogRaw),
          {receivedAt,probe:{...assigned,sampledAt:receivedAt,latencyMs:Number(rpc.probeResult.latencyMs),latencyToken:String(rpc.probeResult.latencyMs)}});
        delete input.liveCheckpoint;
        input.probes.push({...assigned,receivedAt,latencyMs:String(rpc.probeResult.latencyMs),source:'monitor',generation:attachment.generation});
        input.probes = input.probes.slice(-128);
      }
    });
  }

  async refreshTasks(serverId) {
    await this.run(serverId, async () => {
      for (const ws of this.sockets()) {
        const attachment = ws.deserializeAttachment();
        if (attachment.serverId !== serverId || !await this.authorize(ws,true)) continue;
        try {
          if (attachment.capabilities.some(c=>c.method === 'cf.report.batch')) {await this.dispatchConfiguration(ws);continue;}
          const tasks = await this.tasks(serverId);
          if (!await this.authorize(ws,true,false) || !this.hasLease(ws,attachment)) continue;
          const availability = probeAvailability(tasks);
          if (tasks.wire) ws.send(tasks.wire);
          else if (attachment.tasks.length) {
            // Revoke previously delivered tasks, not a fake empty result for a failed catalog read.
            ws.send(serializeAgentRpc({method:'ping.tasks',params:[]},{senderRole:'hub',receiverRole:'agent'}));
          }
          ws.serializeAttachment({...ws.deserializeAttachment(),tasks:tasks.assigned || [],taskRevision:tasks.revision,probeAvailability:availability});
          if (this.inputs.has(serverId)) this.inputs.get(serverId).probeAvailability = availability;
        } catch (_) {this.close(ws,'Node tasks unavailable');}
      }
    });
  }

  evaluateTraffic(serverId) {
    if(typeof this.host.state.waitUntil!=='function')return;
    this.host.state.waitUntil(this.run(serverId,async()=> {
      const server=await this.host.env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(serverId).first();
      if(server?.traffic_limit)await evaluateTrafficAlert(this.host.env,server,{});
    }).catch(()=>{}));
  }

  async standardSession(attachment,catalogRaw=null) {
    const server=await this.host.env.DB.prepare('SELECT reset_day FROM servers WHERE id=?').bind(attachment.serverId).first();
    const live=this.sockets().find(ws=>{const a=ws.deserializeAttachment();return a.serverId === attachment.serverId && a.generation === attachment.generation;});
    const leaseUntil=attachment.leaseUntil ?? live?.deserializeAttachment().leaseUntil ?? this.standardHeld.get(attachment.serverId)?.leaseUntil;
    return {generation:attachment.generation,leaseUntil,isCurrent:()=>{
      const owner=this.owners.get(attachment.serverId);
      return owner?.generation === attachment.generation && owner.tokenVersion === attachment.tokenVersion;
    },assertCurrent:async()=>{
      if(!await this.readAuthority(attachment)) return false;
      if((await this.host.env.DB.prepare('SELECT reset_day FROM servers WHERE id=?').bind(attachment.serverId).first())?.reset_day!==server?.reset_day)return false;
      if(live && !await this.authorize(live,true,false)) return false;
      if(!live && !this.host.agentAuthorizationAlarmRunning && !Number.isSafeInteger(await this.host.state.storage.getAlarm())) return false;
      return catalogRaw == null || (await this.host.env.DB.prepare("SELECT value FROM settings WHERE key='latency_tasks'").first())?.value === catalogRaw;
    },catalogRaw,facts:this.inputs.get(attachment.serverId)?.facts,calendar:{resetDay:server?.reset_day ?? 1},calendarResetDay:server?.reset_day ?? null};
  }

  async flushStandard(attachment,receivedAt,monotonic,end=false) {
    const held=this.standardHeld.get(attachment.serverId);
    if (!held || held.generation !== attachment.generation) return;
    if (!attachment.standardStarted && !held.started) {
      if (this.owners.get(attachment.serverId)?.previousCF) {if(end)this.standardHeld.delete(attachment.serverId);return;}
      await recordMonitorStandard(this.host.env,attachment,await this.standardSession(attachment),{report:held.report,byteTokens:held.byteTokens,receivedAt:held.receivedAt});
      held.started=true;
      const live=this.sockets().find(ws=>ws.deserializeAttachment().serverId === attachment.serverId && ws.deserializeAttachment().generation === attachment.generation);
      if(live) live.serializeAttachment({...live.deserializeAttachment(),standardStarted:true});
    }
    const elapsedMs=Math.floor(monotonic-held.monotonic);
    if (elapsedMs>0) await recordMonitorStandard(this.host.env,attachment,await this.standardSession(attachment),
      {held:{...held,elapsedMs},receivedAt});
    if(end) this.standardHeld.delete(attachment.serverId);
    else this.standardHeld.set(attachment.serverId,{...held,receivedAt,monotonic});
  }

  async batchSession(attachment,ws=null) {
    const db=this.host.env.DB;
    const server=await db.prepare('SELECT reset_day FROM servers WHERE id=?').bind(attachment.serverId).first();
    const catalog=(await db.prepare("SELECT value FROM settings WHERE key='latency_tasks'").first())?.value;
    const document=await readLatencyTaskDocument(db);
    if (!document) throw new Error('Node tasks unavailable');
    if ((await db.prepare("SELECT value FROM settings WHERE key='latency_tasks'").first())?.value !== catalog) throw new Error('Node catalog changed');
    const periods=(document.monitorAssignments || []).filter(p=>p.serverId === attachment.serverId);
    const ids=await getMonitorProbeIds(db,[...new Set(periods.map(p=>p.metricId))]);
    const expected=this.owners.get(attachment.serverId);
    const same=()=>this.owners.get(attachment.serverId) === expected && expected.generation === attachment.generation && expected.tokenVersion === attachment.tokenVersion;
    return {generation:attachment.generation,leaseUntil:ws ? ws.deserializeAttachment().leaseUntil : Date.now()+LEASE_MS,
      isCurrent:()=>same() && (!ws || this.hasLease(ws,attachment)),
      assertCurrent:async()=>{
        if (!same() || !await this.readAuthority(attachment)) return false;
        if((await db.prepare('SELECT reset_day FROM servers WHERE id=?').bind(attachment.serverId).first())?.reset_day!==server?.reset_day)return false;
        const row=await db.prepare("SELECT value FROM settings WHERE key='latency_tasks'").first();
        return row?.value === catalog && (!ws || await this.authorize(ws,true,false));
      },admitStream:true,catalogRaw:catalog,tasks:periods.map(p=>({...p,taskId:ids.get(p.metricId)})),
      facts:this.inputs.get(attachment.serverId)?.facts,calendar:{resetDay:server?.reset_day ?? 1},calendarResetDay:server?.reset_day ?? null};
  }

  async dispatchConfiguration(ws) {
    const a=ws.deserializeAttachment();
    if (!a.capabilities.some(c=>c.method === 'cf.report.batch')) return;
    if(a.capabilities.some(c=>c.method === 'cf.ping.tasks')) {
      const tasks=await this.tasks(a.serverId,false,true);
      if(!await this.authorize(ws,true,false)) return;
      if(tasks.error) throw new Error(tasks.error);
      const expected=this.owners.get(a.serverId),old=expected.taskOffer;
      tasks.params.revision=old && JSON.stringify(old.tasks) === JSON.stringify(tasks.params.tasks)
        ? old.revision : Math.max(tasks.params.revision,(old?.revision || 0)+1);
      const owner={...expected,taskOffer:tasks.params};
      await this.host.state.storage.put(OWNER_KEY+a.serverId,owner);
      if(this.owners.get(a.serverId) !== expected || !await this.authorize(ws,true,false)) return;
      this.owners.set(a.serverId,owner);
      const probeAvailability={available:true,mode:tasks.params.tasks[0]?.mode || 'tcp',count:tasks.params.tasks.length,limit:null};
      ws.serializeAttachment({...ws.deserializeAttachment(),tasks:tasks.assigned,taskRevision:tasks.revision,probeAvailability});
      if(this.inputs.has(a.serverId)) this.inputs.get(a.serverId).probeAvailability=probeAvailability;
      this.sendControl(ws,'cf.ping.tasks',tasks.params);
    }
    if(a.capabilities.some(c=>c.method === 'cf.reporting.configure')) {
      await this.dispatchReporting(ws);
    }
  }

  sendControl(ws,method,params) {
    const a=ws.deserializeAttachment(),id=`${method}:${crypto.randomUUID()}`;
    let raw;
    try {raw=serializeAgentRpc({method,id,params},{senderRole:'hub',receiverRole:'agent',implemented:IMPLEMENTED,negotiated:a.capabilities});}
    catch(error) {if(error.code === -32600) this.close(ws,'Monitor configuration exceeds 64 KiB');throw error;}
    const pending={...a.pending,[id]:{id,method,revision:params.revision,taskCount:params.tasks?.length,persistent:params.persistent}};
    if(Object.keys(pending).length>16) throw new Error('Node configuration responses unavailable');
    ws.serializeAttachment({...a,pending});ws.send(raw);
  }

  async dispatchReporting(ws,realtimeState=null) {
    const a=ws.deserializeAttachment();
    const params=await readMonitorReporting(this.host.env.DB,a.serverId);
    if (!params) return;
    const active=(realtimeState || this.host._getAgentRealtimeState()).realtimeActive === true;
    params.transient={active,reportAfterMs:active ? params.persistent.activeReportIntervalSeconds*1000 : 60000,
      idleBatchIntervalSeconds:60,expiresAt:Date.now()+120000};
    if(!await this.authorize(ws,true,false)) return;
    this.sendControl(ws,'cf.reporting.configure',params);
    ws.serializeAttachment({...ws.deserializeAttachment(),monitorActive:active,hintExpiresAt:params.transient.expiresAt});
  }

  async refreshActivity(realtimeState=null) {
    for(const ws of this.sockets()) {
      const a=ws.deserializeAttachment();
      await this.run(a.serverId,async()=>{
        const current=ws.deserializeAttachment(),active=(realtimeState || this.host._getAgentRealtimeState()).realtimeActive === true;
        if(!current.capabilities.some(c=>c.method === 'cf.reporting.configure') ||
            current.monitorActive === active && current.hintExpiresAt>Date.now()+60000 || !await this.authorize(ws,true,false)) return;
        await this.dispatchReporting(ws,realtimeState);
      });
    }
  }

  async httpBatch(request) {
    const origin=request.headers.get('Origin');
    if(origin && origin !== request.headers.get('X-Real-Origin')) return unavailable('node_origin_denied',403);
    let principal;
    try {principal=await authenticateNodeRequest(request,this.host.env.DB);} catch (_) {return unavailable('node_authentication_unavailable');}
    if(!principal) return unavailable('node_token_invalid',401);
    await this.ready;
    const admission=this.owners.get(principal.serverId);
    if(admission?.source !== 'monitor' || admission.tokenVersion !== principal.tokenVersion || !admission.capabilities?.some(c=>c.method === 'cf.report.batch')) return unavailable('monitor_fallback_unavailable',409);
    let raw,rpc;
    try {
      // Read bounded original bytes; never stringify params or trust Content-Length alone.
      const reader=request.body?.getReader();if(!reader) return unavailable('monitor_invalid_batch',400);
      const chunks=[];let length=0;
      for (;;) {const {done,value}=await reader.read();if(done) break;length+=value.length;if(length>524288){await reader.cancel();return unavailable('monitor_batch_too_large',413);}chunks.push(value);}
      const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      return await this.run(principal.serverId,async()=>{
        const owner=this.owners.get(principal.serverId);
        if (owner?.generation !== admission.generation || owner.tokenVersion !== admission.tokenVersion) return unavailable('monitor_session_replaced',409);
        if(owner?.source !== 'monitor' || owner.tokenVersion !== principal.tokenVersion || !owner.capabilities?.some(c=>c.method === 'cf.report.batch')) return unavailable('monitor_fallback_unavailable',409);
        rpc=parseAgentRpc(raw,{implemented:IMPLEMENTED,negotiated:owner.capabilities});
        if(rpc.method !== 'cf.report.batch') return unavailable('monitor_invalid_batch',400);
        const input=this.inputs.get(principal.serverId);if(input)delete input.liveCheckpoint;
        const ack=await recordMonitorBatch(this.host.env,principal,await this.batchSession(owner),raw);
        this.evaluateTraffic(principal.serverId);
        return new Response(serializeAgentRpc({kind:'response',id:rpc.id,result:ack},{senderRole:'hub',receiverRole:'agent',implemented:IMPLEMENTED,negotiated:owner.capabilities,expectedResponse:{id:rpc.id,method:rpc.method}}),
          {headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      });
    } catch (error) {
      const failure=batchFailure(error,rpc);
      return Response.json(failure.body,{status:failure.status,headers:{'Cache-Control':'no-store'}});
    }
  }

  async checkAlarm() {
    for (const ws of this.sockets()) {
      const attachment = ws.deserializeAttachment();
      await this.run(attachment.serverId,async()=>{if(await this.authorize(ws,true,true)) await this.flushStandard(ws.deserializeAttachment(),Date.now(),performance.now());});
    }
    await this.refreshActivity();
  }
}
