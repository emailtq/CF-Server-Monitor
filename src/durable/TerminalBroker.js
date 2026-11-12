import { TERMINAL_LIMITS, parseTerminalControl, validateTerminalDataFrame, validateTerminalSize } from '../shared/terminalProtocol.js';
import { generateRandomSecret } from '../utils/settings.js';
import { writeTerminalAudit, verifyTerminalAuthority, revokeTerminalNode } from '../database/terminal.js';

const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const denied = (code, status = 409) => Response.json({error:code, code:status}, {status});
const emptyMetadata = () => ({serverId:null, generation:0, credentialVersion:0, sessions:[], closed:[]});
const validFlow = a => ['forwarded','acked','progressAt'].every(key => Number.isSafeInteger(a[key]) && a[key] >= 0) &&
  a.acked <= a.forwarded && a.forwarded - a.acked <= TERMINAL_LIMITS.creditBytes &&
  (a.role !== 'browser' || (Number.isSafeInteger(a.lastUserActivity) && a.lastUserActivity >= 0));
async function hashTicket(ticket) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class TerminalBroker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.jobs = new Map();
    this.disables = new Map();
    this.mustClose = new Set();
    this.tail = Promise.resolve();
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    this.ready = state.blockConcurrencyWhile(async () => {
      this.meta = await state.storage.get('terminal') || emptyMetadata();
      this.alarmAt = await state.storage.getAlarm();
      this.restorePeers('stale_connection');
      // A reservation has no surviving create operation after a cold construction.
      for (const s of this.meta.sessions) if (s.status === 'reserved') this.mustClose.add(s.id);
      if (this.meta.sessions.some(s => this.needsClosure(s))) await this.recover();
      else await this.scheduleAlarm();
      for (const s of [...this.meta.sessions]) {
        const reason = this.expirationReason(s);
        if (reason) await this.closeSession(s.id, reason);
      }
    });
  }

  // Only metadata/storage operations enter this short queue, never D1 or network awaits.
  mutate(operation) {
    const task = this.tail.then(async () => {
      if (this.blocked) await this.recover();
      const draft = structuredClone(this.meta);
      const effects = [];
      try {
        const result = await operation(effects, draft);
        const changed = JSON.stringify(draft) !== JSON.stringify(this.meta);
        if (changed) await this.state.storage.put('terminal', draft);
        this.meta = draft;
        if (changed) await this.scheduleAlarm();
        // No socket acceptance, notification or close precedes its durable transition.
        for (const effect of effects) effect();
        return result;
      } catch (_) {
        await this.recover();
        throw new Error('terminal_transition_failed');
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  restorePeers(reason) {
    this.peers = new Map();
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      const s = this.meta.sessions.find(s => s.id === a?.sessionId);
      const current = a?.serverId === this.meta.serverId && a.generation === this.meta.generation &&
        a.credentialVersion === this.meta.credentialVersion && (a.role === 'agent-control' ||
          (['browser','agent'].includes(a.role) && s && s[a.role] === a.connectionId && s.owner === a.owner && validFlow(a)));
      if (current && ws.readyState === 1) this.peers.set(a.connectionId, ws);
      else { try { ws.close(1000, reason); } catch (_) {} }
    }
  }

  async recover() {
    try {
      this.meta = await this.state.storage.get('terminal') || emptyMetadata();
      this.alarmAt = await this.state.storage.getAlarm();
      this.restorePeers('storage_error');
      const lost = this.meta.sessions.filter(s => this.needsClosure(s));
      if (lost.length) {
        for (const s of lost) for (const role of ['browser','agent']) {
          const ws = this.peers.get(s[role]);
          if (ws) { try { ws.close(1000, 'storage_error'); } catch (_) {} this.peers.delete(s[role]); }
        }
        this.meta.sessions = this.meta.sessions.filter(s => !lost.includes(s));
        this.meta.closed = [...this.meta.closed, ...lost.map(s => ({id:s.id, clientRequestId:s.clientRequestId, owner:s.owner, cols:s.cols, rows:s.rows}))].slice(-32);
        await this.state.storage.put('terminal', this.meta);
      }
      await this.scheduleAlarm();
      for (const id of this.mustClose) if (!this.meta.sessions.some(s => s.id === id)) this.mustClose.delete(id);
      this.blocked = false;
    } catch (_) {
      // Unknown authority never permits forwarding; retain disk state for a healthy retry.
      this.blocked = true;
      for (const ws of this.state.getWebSockets()) { try { ws.close(1000, 'storage_error'); } catch (_) {} }
      this.peers.clear();
      throw new Error('terminal_storage_unavailable');
    }
  }

  needsClosure(session) {
    return this.mustClose.has(session.id) || session.generation !== this.meta.generation ||
      session.credentialVersion !== this.meta.credentialVersion ||
      ['browser','agent'].some(role => session[role] && !this.peer(session, role));
  }

  async scheduleAlarm() {
    const deadlines = this.meta.sessions.map(s => this.sessionDeadline(s));
    const nearest = deadlines.length ? Math.min(...deadlines) : null;
    // Keep an earlier safe wakeup rather than rewriting the alarm on every ACK/renewal.
    if (nearest === this.alarmAt || (nearest !== null && this.alarmAt !== null && this.alarmAt <= nearest)) return;
    const previous = this.alarmAt;
    this.alarmAt = nearest;
    try {
      if (nearest === null) await this.state.storage.deleteAlarm();
      else await this.state.storage.setAlarm(nearest);
    } catch (error) {
      if (this.alarmAt === nearest) this.alarmAt = previous;
      throw error;
    }
  }

  sessionDeadline(session) {
    let deadline = Math.min(session.leaseUntil, session.status === 'running' ? Infinity : session.deadline);
    if (session.status === 'running') {
      const browser = this.peer(session, 'browser')?.deserializeAttachment();
      deadline = Math.min(deadline, (browser?.lastUserActivity ?? session.createdAt) + TERMINAL_LIMITS.userIdleMs);
      for (const role of ['browser', 'agent']) {
        const a = this.peer(session, role)?.deserializeAttachment();
        if (a && a.forwarded > a.acked) deadline = Math.min(deadline, a.progressAt + TERMINAL_LIMITS.ackTimeoutMs);
      }
    }
    return deadline;
  }

  expirationReason(session) {
    const now = Date.now();
    if (session.leaseUntil <= now || (session.status !== 'running' && session.deadline <= now)) return 'session_expired';
    if (session.status === 'running') {
      const browser = this.peer(session, 'browser')?.deserializeAttachment();
      if ((browser?.lastUserActivity ?? session.createdAt) + TERMINAL_LIMITS.userIdleMs <= now) return 'user_idle';
      for (const role of ['browser', 'agent']) {
        const a = this.peer(session, role)?.deserializeAttachment();
        if (a && a.forwarded > a.acked && a.progressAt + TERMINAL_LIMITS.ackTimeoutMs <= now) return 'ack_stalled';
      }
    }
    return null;
  }

  peer(session, role) {
    const ws = this.peers.get(session[role]);
    return ws && ws.readyState === 1 ? ws : null;
  }

  control() {
    for (const ws of this.peers.values()) {
      const a = ws.deserializeAttachment();
      if (ws.readyState === 1 && a?.role === 'agent-control' && a.generation === this.meta.generation && a.credentialVersion === this.meta.credentialVersion) return ws;
    }
    return null;
  }

  live(session) {
    return session && session.generation === this.meta.generation && session.credentialVersion === this.meta.credentialVersion &&
      !this.mustClose.has(session.id) && !this.expirationReason(session);
  }

  accept(context, role, session, effects) {
    const [client, ws] = Object.values(new WebSocketPair());
    const connectionId = crypto.randomUUID();
    const attachment = {connectionId, serverId:this.meta.serverId, role, generation:this.meta.generation,
      credentialVersion:context.credentialVersion, sessionId:session?.id || null, owner:session?.owner || null};
    if (session) Object.assign(attachment, {forwarded:0, acked:0, progressAt:Date.now(),
      ...(role === 'browser' ? {lastUserActivity:session.createdAt} : {})});
    effects.push(() => {
      this.state.acceptWebSocket(ws, [role, session ? `session:${session.id}` : 'control']);
      ws.serializeAttachment(attachment);
      this.peers.set(connectionId, ws);
    });
    if (session) session[role] = connectionId;
    return new Response(null, {status:101, webSocket:client});
  }

  async fetch(request) {
    await this.ready;
    if (this.blocked) {
      try { await this.mutate(() => null); } catch (_) { return denied('terminal_storage_unavailable', 503); }
    }
    let context;
    try { context = JSON.parse(request.headers.get('X-CFSM-Terminal-Context')); } catch (_) {}
    const operation = new URL(request.url).pathname.slice(1);
    if (!isId(context?.serverId) || !['status','invalidate','disable','local-disable','control','attach','open','renew','close'].includes(operation)) return denied('terminal_internal_denied', 403);
    if (this.meta.serverId && context.serverId !== this.meta.serverId) return denied('terminal_node_mismatch', 403);
    if (!this.meta.serverId) await this.mutate((effects, meta) => { meta.serverId = context.serverId; });
    if (operation === 'status') {
      const current = context.credentialVersion === undefined || context.credentialVersion === this.meta.credentialVersion;
      let control = current ? this.control() : null;
      let supported = control?.deserializeAttachment()?.supported === true;
      if (supported && this.meta.hello?.version !== this.meta.credentialVersion) {
        await this.mutate((effects, meta) => { if (control === this.control() && control.deserializeAttachment()?.supported === true) meta.hello = {version:meta.credentialVersion, supported:true}; });
        control = context.credentialVersion === undefined || context.credentialVersion === this.meta.credentialVersion ? this.control() : null;
        supported = control?.deserializeAttachment()?.supported === true;
      }
      const hello = this.meta.hello?.version === context.credentialVersion ? this.meta.hello : null;
      return Response.json({connected:!!control, supported, protocol:supported ? 1 : null, platform:supported ? 'linux' : null, activeCount:this.meta.sessions.length, observed:hello ? hello.supported ? 'supported' : 'unsupported' : null});
    }
    if (operation === 'invalidate') {
      if (context.credentialVersion < this.meta.credentialVersion) return Response.json({closed:false});
      await this.replaceControl(null, context.credentialVersion);
      return Response.json({closed:true});
    }
    if (operation === 'disable') return this.disable(context);
    if (operation === 'local-disable') {
      const generation = this.meta.generation;
      const node = await this.env.DB.prepare('SELECT terminal_local_enabled, terminal_local_observed_at, terminal_local_report_at FROM servers WHERE id = ?').bind(context.serverId).first();
      if (node?.terminal_local_enabled !== 0 || node.terminal_local_observed_at !== context.observedAt || node.terminal_local_report_at !== context.reportAt) return Response.json({closed:false});
      const closed = await this.replaceControl(null, 0, generation);
      return Response.json({closed:closed !== null});
    }
    if (!Number.isSafeInteger(context.credentialVersion) || context.credentialVersion < 1) return denied('terminal_version_denied', 403);
    if (operation !== 'close') {
      const validUntil = context.leaseUntil ?? context.validUntil;
      if (!Number.isSafeInteger(validUntil) || validUntil <= Date.now() ||
          validUntil > Date.now() + TERMINAL_LIMITS.authLeaseMs ||
          !await verifyTerminalAuthority(this.env.DB, context) || validUntil <= Date.now()) return denied('terminal_authority_denied', 403);
    }
    if (operation === 'control') {
      if (request.headers.get('Upgrade') !== 'websocket') return denied('terminal_upgrade_required', 426);
      if (context.credentialVersion < this.meta.credentialVersion) return denied('terminal_version_denied', 403);
      const generation = await this.replaceControl(context.credentialVersion);
      return this.mutate((effects, meta) => {
        if (generation === null || generation !== meta.generation || context.credentialVersion !== meta.credentialVersion ||
            (context.validUntil ?? context.leaseUntil) <= Date.now()) return denied('terminal_version_denied', 403);
        return this.accept(context, 'agent-control', null, effects);
      });
    }
    if (context.credentialVersion !== this.meta.credentialVersion) return denied('terminal_version_denied', 403);
    if (operation === 'open') {
      let data;
      try { data = await request.json(); } catch (_) { return denied('terminal_invalid_open', 400); }
      if (!isId(context.owner) || !isId(data.clientRequestId) || !validateTerminalSize(data.cols, data.rows) ||
          !Number.isSafeInteger(context.leaseUntil) || context.leaseUntil <= Date.now() || context.leaseUntil > Date.now() + TERMINAL_LIMITS.authLeaseMs) return denied('terminal_invalid_open', 400);
      const key = data.clientRequestId;
      const existingJob = this.jobs.get(key);
      if (existingJob) {
        if (existingJob.owner !== context.owner || existingJob.cols !== data.cols || existingJob.rows !== data.rows) return denied('terminal_retry_mismatch');
        return (await existingJob.promise).clone();
      }
      if (this.jobs.size >= TERMINAL_LIMITS.maxSessions) return denied('terminal_capacity');
      const promise = this.open(context, data);
      this.jobs.set(key, {promise, owner:context.owner, cols:data.cols, rows:data.rows});
      try { return await promise; } finally { this.jobs.delete(key); }
    }
    const session = this.meta.sessions.find(s => s.id === context.sessionId);
    if (operation === 'attach') {
      if (request.headers.get('Upgrade') !== 'websocket' || !['browser','agent'].includes(context.role)) return denied('terminal_role_denied', 403);
      const hash = context.role === 'agent' && typeof context.ticket === 'string' ? await hashTicket(context.ticket) : null;
      const result = await this.mutate((effects, meta) => {
        const s = meta.sessions.find(s => s.id === context.sessionId);
        if (!this.live(s) || s.status !== 'pending' || context.validUntil <= Date.now()) return denied('terminal_session_not_pending');
        if (context.role === 'browser' && context.owner !== s.owner) return denied('terminal_owner_denied', 403);
        if (s[context.role]) return denied('terminal_duplicate_peer');
        if (context.role === 'agent' && (!s.ticketHash || hash !== s.ticketHash || s.deadline <= Date.now())) return denied('terminal_ticket_denied', 403);
        if (context.role === 'agent') s.ticketHash = null;
        return this.accept(context, context.role, s, effects);
      });
      if (result.status === 101) await this.tryStart(context.sessionId);
      return result;
    }
    if (!isId(context.owner)) return denied('terminal_owner_denied', 403);
    const previous = session || this.meta.closed.find(s => s.id === context.sessionId);
    if (!previous || previous.owner !== context.owner) return denied('terminal_owner_denied', 403);
    if (operation === 'close') {
      await this.closeSession(context.sessionId, 'user_close');
      return Response.json({closed:true});
    }
    if (!this.live(session) || !Number.isSafeInteger(context.leaseUntil) || context.leaseUntil <= Date.now() || context.leaseUntil > Date.now() + TERMINAL_LIMITS.authLeaseMs) return denied('terminal_session_expired');
    const renewed = await this.mutate((effects, meta) => {
      const current = meta.sessions.find(s => s.id === context.sessionId);
      if (!this.live(current) || current.owner !== context.owner || !this.control() ||
          current.generation !== session.generation || context.credentialVersion !== meta.credentialVersion ||
          context.leaseUntil <= Date.now() || current.ownerExpiry !== context.ownerExpiry ||
          current.authorizationKey !== context.authorizationKey) return false;
      current.leaseUntil = Math.max(current.leaseUntil, context.leaseUntil);
      return current.leaseUntil;
    });
    if (!renewed) return denied('terminal_session_expired');
    return Response.json({leaseUntil:renewed});
  }

  async open(context, data) {
    const ticket = generateRandomSecret(32);
    const ticketHash = await hashTicket(ticket);
    let session;
    let reservation;
    try {
      reservation = await this.mutate((effects, meta) => {
        if (context.credentialVersion !== meta.credentialVersion) return denied('terminal_version_denied', 403);
        const previous = [...meta.sessions, ...meta.closed].find(s => s.clientRequestId === data.clientRequestId);
        if (previous) {
          if (previous.owner !== context.owner || previous.cols !== data.cols || previous.rows !== data.rows) return denied('terminal_retry_mismatch');
          if (!this.live(previous) || previous.status === 'reserved') return denied('terminal_session_expired');
          return Response.json({sessionId:previous.id, leaseUntil:previous.leaseUntil});
        }
        if (!this.control()?.deserializeAttachment()?.supported) return denied('terminal_agent_unavailable');
        if (meta.sessions.length >= TERMINAL_LIMITS.maxSessions) return denied('terminal_capacity');
        session = {id:crypto.randomUUID(), clientRequestId:data.clientRequestId, owner:context.owner, cols:data.cols, rows:data.rows,
          generation:meta.generation, credentialVersion:context.credentialVersion, ticketHash, status:'reserved',
          ownerExpiry:context.ownerExpiry, authorizationKey:context.authorizationKey, serverId:context.serverId, createdAt:Date.now(),
          deadline:Date.now() + TERMINAL_LIMITS.startTimeoutMs, leaseUntil:context.leaseUntil, browser:null, agent:null};
        meta.sessions.push(session);
        return null;
      });
    } catch (_) {
      if (session) await this.closeSession(session.id, 'admission_failed');
      return denied('terminal_admission_failed', 503);
    }
    if (reservation) return reservation;
    try {
      await this.audit(session, 'admission', null);
      if (!await verifyTerminalAuthority(this.env.DB, session)) throw new Error('terminal_authority_denied');
      const admitted = await this.mutate((effects, meta) => {
        const current = meta.sessions.find(s => s.id === session.id);
        const control = this.control();
        if (!this.live(current) || current.status !== 'reserved' || !control) return false;
        current.status = 'pending';
        effects.push(() => control.send(JSON.stringify({type:'open', protocol:1, sessionId:current.id, ticket, cols:current.cols, rows:current.rows})));
        return true;
      });
      if (!admitted) throw new Error('terminal_cancelled');
      return Response.json({sessionId:session.id, leaseUntil:session.leaseUntil});
    } catch (_) {
      await this.closeSession(session.id, 'admission_failed');
      return denied('terminal_admission_failed', 503);
    }
  }

  async tryStart(id) {
    let claimed;
    try {
      await this.mutate((effects, meta) => {
        const s = meta.sessions.find(s => s.id === id);
        if (!this.live(s) || s.status !== 'pending' || !this.peer(s, 'browser') || !this.peer(s, 'agent')) return;
        s.status = 'admitting';
        claimed = s;
      });
      if (!claimed) return;
      await this.audit(claimed, 'start', null);
      if (!await verifyTerminalAuthority(this.env.DB, claimed)) throw new Error('terminal_authority_denied');
      await this.mutate((effects, meta) => {
        const s = meta.sessions.find(s => s.id === id);
        if (!this.live(s) || s.status !== 'admitting') return;
        const agent = this.peer(s, 'agent');
        const browser = this.peer(s, 'browser');
        if (!agent || !browser) throw new Error('terminal_pair_lost');
        s.status = 'starting';
        effects.push(() => browser.send(JSON.stringify({type:'start', cols:s.cols, rows:s.rows})));
        effects.push(() => agent.send(JSON.stringify({type:'start', cols:s.cols, rows:s.rows})));
      });
    } catch (_) {
      await this.closeSession(id, 'admission_failed');
    }
  }

  async audit(session, event, reason) {
    await writeTerminalAudit(this.env.DB, {serverId:this.meta.serverId, sessionId:session.id, actorJti:session.owner, event, reason, createdAt:Date.now()});
  }

  async closeSession(id, reason) {
    let closed;
    // Failed admission/lifecycle cleanup remains mandatory after a storage outage.
    if (reason !== 'user_close') this.mustClose.add(id);
    await this.mutate((effects, meta) => {
      const index = meta.sessions.findIndex(s => s.id === id);
      if (index < 0) return;
      closed = meta.sessions.splice(index, 1)[0];
      for (const role of ['browser', 'agent']) {
        const ws = this.peers.get(closed[role]);
        if (ws) effects.push(() => { try { ws.close(1000, reason); } catch (_) {} this.peers.delete(closed[role]); });
      }
      effects.push(() => { try { this.control()?.send(JSON.stringify({type:'close', sessionId:id, reason})); } catch (_) {} });
      meta.closed.push({id:closed.id, clientRequestId:closed.clientRequestId, owner:closed.owner, cols:closed.cols, rows:closed.rows});
      // A bounded retry tombstone ring; no permanent session/idempotency history.
      meta.closed = meta.closed.slice(-32);
    });
    this.mustClose.delete(id);
    // Best-effort audit cannot pin constructor recovery or unrelated session events.
    if (closed) this.state.waitUntil(this.audit(closed, 'close', reason).catch(() => {}));
  }

  async replaceControl(version, minimumVersion = 0, expectedGeneration = null) {
    const replacement = await this.mutate((effects, meta) => {
      if (expectedGeneration !== null && meta.generation !== expectedGeneration) return null;
      if (version !== null && version < meta.credentialVersion) return null;
      meta.generation++;
      if (version !== null) meta.credentialVersion = version;
      else if (Number.isSafeInteger(minimumVersion)) meta.credentialVersion = Math.max(meta.credentialVersion, minimumVersion);
      for (const [id, ws] of this.peers) {
        if (ws.deserializeAttachment()?.role === 'agent-control') {
          effects.push(() => { try { ws.close(1000, 'control_replaced'); } catch (_) {} this.peers.delete(id); });
        }
      }
      return {generation:meta.generation, ids:meta.sessions.map(s => s.id)};
    });
    if (!replacement) return null;
    await Promise.all(replacement.ids.map(id => this.closeSession(id, 'control_replaced')));
    return replacement.generation;
  }

  async disable(context) {
    if (!isId(context.owner) || !Number.isSafeInteger(context.credentialVersion) || context.credentialVersion < 1) return denied('terminal_internal_denied', 403);
    const control = this.control();
    const a = control?.deserializeAttachment();
    const captured = a?.credentialVersion === context.credentialVersion ? control : null;
    const operationId = crypto.randomUUID();
    const revoked = await revokeTerminalNode(this.env.DB, context.serverId, Date.now(), context);
    if (!revoked) return denied('terminal_authority_denied', 409);
    if (!revoked.wasEnabled) return Response.json({enabled:false, serverRevoked:true, localConfirmed:false, localReason:'already_revoked'});
    let localReason = captured ? a.disableSupported ? 'timeout' : 'unsupported' : 'offline';
    let localConfirmed = false;
    let timer;
    let pending;
    let revokedGeneration;
    for (const session of this.meta.sessions) if (session.credentialVersion <= context.credentialVersion) this.mustClose.add(session.id);
    try {
      // Fence old data immediately, but retain the exact old control for disable/ACK only.
      revokedGeneration = await this.mutate((effects, meta) => {
        for (const session of meta.sessions) if (session.credentialVersion <= context.credentialVersion) this.mustClose.add(session.id);
        if (meta.credentialVersion <= context.credentialVersion) {
          meta.credentialVersion = revoked.credential_version;
          meta.generation++;
        }
        for (const [id, ws] of this.peers) if (ws !== captured && ws.deserializeAttachment()?.credentialVersion <= context.credentialVersion) {
          effects.push(() => { try { ws.close(1000, 'node_revoked'); } catch (_) {} this.peers.delete(id); });
        }
        return meta.generation;
      });
      for (const session of [...this.meta.sessions]) if (session.credentialVersion <= context.credentialVersion) await this.closeSession(session.id, 'node_revoked');
      if (captured && a.disableSupported && captured.readyState === 1 && this.peers.get(a.connectionId) === captured) {
        const frame = {type:'disable', operationId, serverId:context.serverId, connectionId:a.connectionId,
          generation:a.generation, credentialVersion:a.credentialVersion};
        const ack = new Promise(resolve => { pending = {ws:captured, frame, resolve}; });
        this.disables.set(a.connectionId, pending);
        timer = setTimeout(() => pending.resolve(false), TERMINAL_LIMITS.disableTimeoutMs);
        captured.send(JSON.stringify(frame));
        localConfirmed = await ack;
        localReason = localConfirmed ? 'confirmed' : 'unconfirmed';
      }
    } catch (_) { localReason = 'broker_failure'; }
    finally {
      clearTimeout(timer);
      if (pending && this.disables.get(a.connectionId) === pending) this.disables.delete(a.connectionId);
      if (captured) {
        try { captured.close(1000, 'node_revoked'); } catch (_) {}
        if (this.peers.get(a.connectionId) === captured) this.peers.delete(a.connectionId);
      }
    }
    const current = await this.env.DB.prepare('SELECT enabled, credential_version, token_version FROM terminal_nodes WHERE server_id = ?').bind(context.serverId).first();
    // Repeated denial may advance the epoch; it cannot confirm a reset token or new control generation.
    if (!current || current.enabled !== 0 || current.token_version !== revoked.token_version ||
        current.credential_version < revoked.credential_version || localConfirmed &&
        (this.meta.credentialVersion !== revoked.credential_version || this.meta.generation !== revokedGeneration)) {
      return Response.json({error:'terminal_authority_denied', code:409, serverRevoked:current?.enabled === 0,
        localConfirmed:false, localReason:'identity_changed'}, {status:409});
    }
    return Response.json({enabled:false, serverRevoked:true, localConfirmed, localReason});
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    if (this.blocked) { try { ws.close(1000, 'storage_error'); } catch (_) {} return; }
    const a = ws.deserializeAttachment();
    const disable = this.disables.get(a?.connectionId);
    if (disable?.ws === ws) {
      try {
        const frame = parseTerminalControl(message, 'agent-control');
        if (frame.type === 'ping') { ws.send('{"type":"pong"}'); return; }
        if (frame.type === 'pong') return;
        if (frame.type !== 'disabled' || Object.keys(disable.frame).some(key => key !== 'type' && frame[key] !== disable.frame[key])) throw new Error('invalid_disabled');
        disable.resolve(true);
      } catch (_) { disable.resolve(false); try { ws.close(1000, 'invalid_disabled'); } catch (_) {} }
      return;
    }
    if (!a || this.peers.get(a.connectionId) !== ws || a.generation !== this.meta.generation || a.credentialVersion !== this.meta.credentialVersion) {
      try { ws.close(1000, 'stale_connection'); } catch (_) {}
      return;
    }
    if (a.role === 'agent-control') {
      try {
        const frame = parseTerminalControl(message, 'agent-control');
        if (frame.type === 'hello') {
          if (a.supported) throw new Error('duplicate_hello');
          await this.mutate((effects, meta) => {
            if (a.generation !== meta.generation || a.credentialVersion !== meta.credentialVersion) return;
            meta.hello = {version:a.credentialVersion, supported:true};
            effects.push(() => {
              a.supported = true;
              a.disableSupported = frame.capabilities.includes('terminal.disable.v1');
              ws.serializeAttachment(a);
              if (a.disableSupported) ws.send(JSON.stringify({type:'bound', serverId:a.serverId, connectionId:a.connectionId,
                generation:a.generation, credentialVersion:a.credentialVersion}));
            });
          });
        } else if (frame.type === 'ping') ws.send('{"type":"pong"}');
        else if (frame.type !== 'pong') throw new Error('unexpected_control');
      } catch (_) {
        // Diagnostic observation only; the strict protocol parser still rejects this peer.
        if (typeof message === 'string' && new TextEncoder().encode(message).byteLength <= TERMINAL_LIMITS.controlFrameBytes && !a.supported) {
          let frame;
          try { frame = JSON.parse(message); } catch (_) {}
          if (frame?.type === 'hello' && Object.keys(frame).length === 4 && Number.isSafeInteger(frame.protocol) && typeof frame.platform === 'string' && /^[a-z]{1,32}$/.test(frame.platform) && Array.isArray(frame.capabilities) && frame.capabilities.length <= 16 && frame.capabilities.every(value => typeof value === 'string' && value.length <= 64)) {
            await this.mutate((effects, meta) => { if (a.generation === meta.generation && a.credentialVersion === meta.credentialVersion) meta.hello = {version:a.credentialVersion, supported:false}; });
          }
        }
        await this.replaceControl(null);
      }
      return;
    }
    const s = this.meta.sessions.find(s => s.id === a.sessionId);
    if (!this.live(s) || s[a.role] !== a.connectionId || s.owner !== a.owner || !validFlow(a)) { await this.closeSession(a.sessionId, s ? this.expirationReason(s) || 'session_expired' : 'session_expired'); return; }
    try {
      if (typeof message !== 'string') {
        if (s.status !== 'running' || !validateTerminalDataFrame(message)) throw new Error('invalid_data');
        const target = this.peer(s, a.role === 'browser' ? 'agent' : 'browser');
        if (!target) throw new Error('peer_lost');
        if (!Number.isSafeInteger(a.forwarded + message.byteLength) ||
            a.forwarded - a.acked + message.byteLength > TERMINAL_LIMITS.creditBytes) throw new Error('credit_exceeded');
        const wasEmpty = a.forwarded === a.acked;
        if (message.byteLength) {
          if (wasEmpty) a.progressAt = Date.now();
          a.forwarded += message.byteLength;
          if (a.role === 'browser') a.lastUserActivity = Date.now();
          ws.serializeAttachment(a);
        }
        // DO send is synchronous enqueue, not an 8s transport-write acknowledgement.
        // Credit bounds the enqueue; consumption ACK/stall bounds a non-reading peer.
        target.send(message);
        if (wasEmpty && message.byteLength) await this.scheduleAlarm();
        return;
      }
      const frame = parseTerminalControl(message, a.role);
      if (frame.type === 'ping') { ws.send('{"type":"pong"}'); return; }
      if (frame.type === 'pong') return;
      if (frame.type === 'ready') {
        if (s.status !== 'starting') throw new Error('invalid_ready');
        await this.mutate((effects, meta) => {
          const current = meta.sessions.find(s => s.id === a.sessionId);
          if (!this.live(current) || current.status !== 'starting' || current.agent !== a.connectionId) throw new Error('invalid_ready');
          const browser = this.peer(current, 'browser');
          if (!browser) throw new Error('peer_lost');
          current.status = 'running';
          effects.push(() => browser.send('{"type":"ready"}'));
        });
        return;
      }
      if (frame.type === 'exit' || frame.type === 'error') {
        if (frame.type === 'exit') this.peer(s, 'browser')?.send(JSON.stringify(frame));
        await this.closeSession(s.id, frame.type === 'exit' ? 'process_exit' : 'pty_start_failed');
        return;
      }
      if (s.status !== 'running') throw new Error('not_ready');
      const target = this.peer(s, a.role === 'browser' ? 'agent' : 'browser');
      if (!target) throw new Error('peer_lost');
      if (frame.type === 'ack') {
        const producer = target.deserializeAttachment();
        if (frame.bytes < producer.acked || frame.bytes > producer.forwarded) throw new Error('invalid_ack');
        if (frame.bytes === producer.acked) return;
        producer.acked = frame.bytes;
        producer.progressAt = Date.now();
        target.serializeAttachment(producer);
      } else if (frame.type === 'resize') {
        a.lastUserActivity = Date.now();
        ws.serializeAttachment(a);
      }
      target.send(message);
    } catch (_) { await this.closeSession(s.id, 'protocol_error'); }
  }

  async webSocketClose(ws) {
    await this.ready;
    const a = ws.deserializeAttachment();
    this.disables.get(a?.connectionId)?.resolve(false);
    try { ws.close(1000, 'peer_disconnected'); } catch (_) {}
    if (!a || this.peers.get(a.connectionId) !== ws) return;
    this.peers.delete(a.connectionId);
    if (a.generation !== this.meta.generation) return;
    if (a.role === 'agent-control') await this.replaceControl(null);
    else await this.closeSession(a.sessionId, 'peer_disconnected');
  }

  webSocketError(ws) { return this.webSocketClose(ws); }

  async alarm() {
    await this.ready;
    if (this.blocked) await this.mutate(() => null);
    this.alarmAt = null;
    const expired = this.meta.sessions.map(s => ({id:s.id, reason:this.expirationReason(s)})).filter(s => s.reason);
    await Promise.all(expired.map(s => this.closeSession(s.id, s.reason)));
    await this.scheduleAlarm();
  }
}
