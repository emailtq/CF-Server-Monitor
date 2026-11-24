import { authenticateNodeRequest } from '../middleware/nodeAuth.js';
import { readLatencyTaskDocument, ensureLatencyTasks } from '../database/latencyTasks.js';
import { getMonitorProbeIds } from '../database/monitorProbeIds.js';
import { latencyTaskAssigned } from '../shared/latencyTasks.js';
import { validatePingNode } from '../shared/pingNode.js';
import { loadSiteSettings } from '../utils/settings.js';
import { clearLatestReportUpdate } from '../utils/latestReportCache.js';
import { parseAgentRpc, serializeAgentRpc, agentRpcErrorResponse, negotiateMonitorCapabilities } from '../shared/monitorAgentProtocol.js';

export const MONITOR_AGENT_KIND = 'monitor-agent';
const OWNER_KEY = 'monitor-owner:';
const LEASE_MS = 60000;
const IMPLEMENTED = [];
const TEXT_FACTS = ['hostname','os','kernel','arch','virt','cpu_name','agent_version','ipv4','ipv6'];
const REPORT_FIELDS = ['boot_id','iface','uptime','cpu','load','mem_total','mem_used','swap_total','swap_used','disk_total','disk_used','net_rx_total','net_tx_total','net_rx','net_tx','tcp','udp','procs'];
const cleanText = value => typeof value === 'string' ? [...value].filter(c => !/[\p{Cc}<>"']/u.test(c)).slice(0,128).join('') : '';
export const isValidMonitorPrincipal = p => p && typeof p.serverId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(p.serverId) && Number.isSafeInteger(p.tokenVersion) && p.tokenVersion > 0;
const unavailable = (error, status = 503) => Response.json({error}, {status, headers:{'Cache-Control':'no-store'}});
const probeAvailability = tasks => ({available:!tasks.error,mode:'tcp',count:tasks.count ?? tasks.assigned.length,limit:64,
  ...(tasks.error ? {error:tasks.error} : {})});

// One queue covers socket admission AND actual legacy HTTP/WS writes, not just broadcast filtering.
export class MonitorAgentSession {
  constructor(broadcaster) {
    this.host = broadcaster;
    this.owners = new Map();
    this.inputs = new Map();
    this.queues = new Map();
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
    if (previous && previous.tokenVersion > principal.tokenVersion) throw new Error('Node token revoked');
    const generation = (previous?.generation || 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Node generation exhausted');
    const owner = {serverId:principal.serverId, tokenVersion:principal.tokenVersion, credentialVersion:principal.version,
      generation, source, active:true, nativeTakenOver:source === 'monitor' || previous?.nativeTakenOver === true};
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
      const owner = {...this.owners.get(attachment.serverId), active:false};
      this.owners.set(owner.serverId, owner);
      await this.host.state.storage?.put?.(OWNER_KEY + owner.serverId, owner);
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
      Array.isArray(current.capabilities) && Array.isArray(current.tasks) && current.tasks.length <= 64 &&
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

  async tasks(serverId, initialize = false) {
    let document = await readLatencyTaskDocument(this.host.env.DB);
    if (!document && initialize) document = await ensureLatencyTasks(this.host.env.DB, await loadSiteSettings(this.host.env.DB, {forceRefresh:true}));
    if (!document) throw new Error('Node tasks unavailable');
    const tasks = document.tasks.filter(task => latencyTaskAssigned(task, serverId, document));
    const row = await this.host.env.DB.prepare('SELECT ping_mode FROM servers WHERE id = ?').bind(serverId).first();
    if (!row) throw new Error('Node tasks unavailable');
    if (tasks.length > 64) return {error:'monitor_tcp_tasks_limit', count:tasks.length, revision:document.revision};
    if (tasks.length && row.ping_mode === 'icmp') return {error:'monitor_icmp_tasks_unavailable',count:tasks.length,revision:document.revision};
    const ids = await getMonitorProbeIds(this.host.env.DB, tasks.map(task => task.metric_id || task.id));
    // Existing CF TCP probes use port 80 for bare hosts (probe.go defaultTaskPingTCPPort).
    const assigned = tasks.map(task => ({id:ids.get(task.metric_id || task.id),
      target:/^(?:\[[^\]]+\]|[^:]+):\d+$/.test(task.target) ? task.target : `${task.target}:80`,interval:task.interval}));
    if (assigned.some(task => !validatePingNode(task.target).valid || !/^(?:\[[^\]]+\]|[^:]+):\d+$/.test(task.target))) {
      return {error:'monitor_tcp_port_required',count:tasks.length,revision:document.revision};
    }
    const wire = serializeAgentRpc({method:'ping.tasks',params:assigned},{senderRole:'hub',receiverRole:'agent'});
    return {wire, assigned:tasks.map((task,i) => ({taskId:assigned[i].id, metricId:task.metric_id || task.id})), revision:document.revision};
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
        const tasks = await this.tasks(principal.serverId,true);
        const availability = probeAvailability(tasks);
        const owner = await this.claim(principal,'monitor');
        const [client,server] = Object.values(new WebSocketPair());
        this.host.state.acceptWebSocket(server,['monitor-agent']);
        server.serializeAttachment({kind:MONITOR_AGENT_KIND,serverId:owner.serverId,tokenVersion:owner.tokenVersion,
          credentialVersion:owner.credentialVersion,generation:owner.generation,authenticated:true,leaseUntil:checkedAt + LEASE_MS,
          capabilities:[],tasks:tasks.assigned || [],taskRevision:tasks.revision,probeAvailability:availability});
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

  // Task4 consumes these exact transient inputs; no legacy MiB projection or durable receipt is created here.
  async message(ws, raw) {
    const initial = ws.deserializeAttachment();
    return this.run(initial.serverId, async () => {
      if (!await this.authorize(ws)) return;
      const attachment = ws.deserializeAttachment();
      let rpc;
      try { rpc = parseAgentRpc(raw,{implemented:IMPLEMENTED,negotiated:attachment.capabilities}); }
      catch (error) {
        const response = agentRpcErrorResponse(error);
        if (response) ws.send(JSON.stringify(response));
        else this.close(ws,'Invalid monitor frame');
        return;
      }
      if (!rpc.known) return;
      const receivedAt = Date.now();
      if (rpc.method === 'cf.capabilities') {
        const accepted = negotiateMonitorCapabilities(rpc.params.supports,IMPLEMENTED);
        ws.serializeAttachment({...attachment,capabilities:accepted});
        const result = {version:1,accepted,limits:{reportBatchBytes:524288,reportSamples:300,sshEvents:32,configBytes:65536,
          terminalControlBytes:4096,terminalDataBytes:16384,terminalCreditBytes:262144},fallbackPath:null};
        ws.send(serializeAgentRpc({kind:'response',id:rpc.id,result},{senderRole:'hub',receiverRole:'agent',implemented:IMPLEMENTED,expectedResponse:{id:rpc.id,method:rpc.method}}));
        return;
      }
      const input = this.input(attachment);
      if (rpc.method === 'hello') {
        const facts = Object.fromEntries(TEXT_FACTS.map(key=>[key,cleanText(rpc.params?.[key])]));
        facts.cpu_cores = rpc.factCores === null ? 0 :
          (rpc.factCores >= BigInt(Number.MIN_SAFE_INTEGER) && rpc.factCores <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rpc.factCores) : String(rpc.factCores));
        input.facts = {...facts,receivedAt,source:'monitor',generation:attachment.generation};
      } else if (rpc.method === 'report') {
        const report = Object.fromEntries(REPORT_FIELDS.filter(key=>Object.hasOwn(rpc.params,key)).map(key=>[key,rpc.params[key]]));
        for (const key of ['boot_id','iface']) if (Object.hasOwn(report,key) && typeof report[key] !== 'string') delete report[key];
        const trafficReading = rpc.trafficReading ? {epoch:rpc.trafficReading.epoch,rx:String(rpc.trafficReading.rx),tx:String(rpc.trafficReading.tx)} : null;
        input.latest = {report,trafficReading,receivedAt,source:'monitor',owner:{serverId:attachment.serverId,tokenVersion:attachment.tokenVersion,generation:attachment.generation},capabilities:attachment.capabilities};
      } else if (rpc.method === 'ping.result' && rpc.probeResult) {
        // Validate the delivered generation against the live catalog; result notifications never allocate IDs/write D1.
        const document = await readLatencyTaskDocument(this.host.env.DB);
        if (!document) throw new Error('Node tasks unavailable');
        if (!await this.authorize(ws,true,false) || !this.hasLease(ws,attachment)) return;
        const current = ws.deserializeAttachment();
        const assigned = current.tasks.find(task=>task.taskId === rpc.probeResult.taskId && document.tasks.some(taskGeneration=>
          (taskGeneration.metric_id || taskGeneration.id) === task.metricId && latencyTaskAssigned(taskGeneration,current.serverId,document)));
        if (!assigned) return;
        const recent = input.probes.filter(probe=>receivedAt - probe.receivedAt < 5000);
        if (recent.length >= 128) return;
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

  async checkAlarm() {
    for (const ws of this.sockets()) {
      const attachment = ws.deserializeAttachment();
      await this.run(attachment.serverId,()=>this.authorize(ws,true,false));
    }
  }
}
