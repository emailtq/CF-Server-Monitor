import { patchServerDetailCache } from '../utils/cache.js';
import { hashNodeToken, verifyNodeToken } from './nodeCredentials.js';

const LOCAL_OBSERVATION_HEARTBEAT_MS = 60000;
export const terminalObservationMaxAge = server => Math.max(180000, (Number(server.report_interval) || 60) * 3000 + LOCAL_OBSERVATION_HEARTBEAT_MS);
export const validTerminalObservation = data => !Object.hasOwn(data, 'terminal_enabled') || typeof data.terminal_enabled === 'boolean';

async function withdrawLocalTerminal(env, server) {
  if (!env.TERMINAL_BROKER || server.terminalLocalDisablePending === false) return;
  server.terminalLocalDisablePending = true;
  let timer;
  try {
    const result = await Promise.race([
      env.TERMINAL_BROKER.get(env.TERMINAL_BROKER.idFromName(server.id)).fetch(new Request('https://terminal.internal/local-disable', {
        headers:{'X-CFSM-Terminal-Context':JSON.stringify({serverId:server.id,
          observedAt:server.terminal_local_observed_at, reportAt:server.terminalLocalPersistedReportAt ?? server.terminal_local_report_at})}
      })),
      new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('terminal_local_disable_unavailable')), 5000);})
    ]);
    if (!result.ok) throw new Error('terminal_local_disable_unavailable');
    server.terminalLocalDisablePending = (await result.json()).closed !== true;
  } finally {clearTimeout(timer);}
}

export async function saveTerminalObservation(env, server, data, sampleTimestamp, receivedAt = Date.now()) {
  if (!Object.hasOwn(data, 'terminal_enabled')) return;
  if (server.terminalLocalPersistedReportAt === undefined) server.terminalLocalPersistedReportAt = server.terminal_local_report_at;
  const reportAt = data.time?.accurate_ts ?? data.time?.local_ts ?? sampleTimestamp;
  // Ignore stale/future envelopes; buffered metrics do not date a current cfg snapshot.
  if (!Number.isSafeInteger(reportAt) || reportAt <= 0 || reportAt > receivedAt + 60000 || receivedAt - reportAt > terminalObservationMaxAge(server)) return;
  const enabled = data.terminal_enabled ? 1 : 0;
  const fresh = receivedAt - (server.terminal_local_observed_at || 0) <= terminalObservationMaxAge(server);
  if (reportAt <= (server.terminal_local_report_at || 0) && fresh) {
    if (enabled === 0 && server.terminal_local_enabled === 0) await withdrawLocalTerminal(env, server);
    return;
  }
  if (server.terminal_local_enabled === enabled && receivedAt - (server.terminal_local_observed_at || 0) < LOCAL_OBSERVATION_HEARTBEAT_MS) {
    server.terminal_local_report_at = reportAt;
    patchServerDetailCache(server.id, {terminal_local_report_at:reportAt});
    if (enabled === 0) await withdrawLocalTerminal(env, server);
    return;
  }
  const observation = await env.DB.prepare(`UPDATE servers
    SET terminal_local_enabled = ?, terminal_local_observed_at = ?, terminal_local_report_at = ?
    WHERE id = ? AND (terminal_local_report_at IS NULL OR terminal_local_report_at < ? OR terminal_local_observed_at < ?)
    RETURNING terminal_local_enabled, terminal_local_observed_at, terminal_local_report_at`)
    .bind(enabled, receivedAt, reportAt, server.id, reportAt, receivedAt - terminalObservationMaxAge(server)).first();
  if (!observation) {
    const current = await env.DB.prepare('SELECT terminal_local_enabled, terminal_local_observed_at, terminal_local_report_at FROM servers WHERE id = ?').bind(server.id).first();
    if (current) { Object.assign(server, current); server.terminalLocalPersistedReportAt = current.terminal_local_report_at; patchServerDetailCache(server.id, current); }
    if (enabled === 0 && current?.terminal_local_enabled === 0) await withdrawLocalTerminal(env, server);
    return;
  }
  Object.assign(server, observation);
  server.terminalLocalPersistedReportAt = observation.terminal_local_report_at;
  patchServerDetailCache(server.id, observation);
  server.terminalLocalDisablePending = enabled === 0;
  // Commit denial before notification; a failed close is retried on the same false.
  if (enabled === 0) await withdrawLocalTerminal(env, server);
}

export async function ensureTerminalSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS terminal_auth_sessions (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS terminal_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      session_id TEXT,
      actor_jti TEXT,
      event TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS terminal_audit_created_at ON terminal_audit(created_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS terminal_auth_sessions_expires_at ON terminal_auth_sessions(expires_at)')
  ]);
}

const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);

export async function terminalAuthorizationKey(settings) {
  return hashNodeToken(settings.jwt_secret || '');
}

// Recheck outside the broker metadata queue; dashboard caches are never authority.
export async function verifyTerminalAuthority(db, context, now = Date.now()) {
  const row = await db.prepare(`SELECT settings.value, s.terminal_local_enabled, n.enabled, n.credential_version, a.expires_at, a.revoked_at
    FROM settings JOIN servers s ON s.id = ? JOIN terminal_nodes n ON n.server_id = s.id
    LEFT JOIN terminal_auth_sessions a ON a.jti = ? WHERE settings.key = 'site_options'`)
    .bind(context.serverId, context.owner || '').first();
  if (!row || row.enabled !== 1 || row.terminal_local_enabled === 0 || row.credential_version !== context.credentialVersion) return false;
  const settings = JSON.parse(row.value);
  if (!settings || ![true, 'true'].includes(settings.terminal_enabled)) return false;
  if (context.owner && (row.revoked_at !== null || row.expires_at !== context.ownerExpiry ||
      row.expires_at * 1000 <= now || context.authorizationKey !== await terminalAuthorizationKey(settings))) return false;
  return true;
}

export async function cleanupTerminalRecords(db, now = Date.now()) {
  if (!isTime(now)) throw new RangeError('Invalid terminal maintenance time');
  await db.prepare('DELETE FROM terminal_audit WHERE created_at < ?').bind(now - 7 * 86400000).run();
  await db.prepare('DELETE FROM terminal_auth_sessions WHERE expires_at <= ?').bind(Math.floor(now / 1000)).run();
}

export async function verifyTerminalNodeToken(db, serverId, token) {
  if (!isId(serverId)) return null;
  const credential = await verifyNodeToken(db, token, serverId);
  if (!credential) return null;
  const row = await db.prepare('SELECT enabled, credential_version FROM terminal_nodes WHERE server_id = ?').bind(serverId).first();
  if (!row || row.enabled !== 1 || row.credential_version !== credential.version) return null;
  return {serverId, version:credential.version};
}

export async function enableTerminalNode(db, serverId, version, now = Date.now()) {
  if (!isId(serverId) || !Number.isSafeInteger(version) || version < 1 || !isTime(now)) throw new RangeError('Invalid terminal permission');
  const row = await db.prepare(`UPDATE terminal_nodes SET enabled = 1, updated_at = ?
    WHERE server_id = ? AND credential_version = ? AND credential_version < 9007199254740991
      AND EXISTS (SELECT 1 FROM servers WHERE id = ?)
    RETURNING credential_version`).bind(now, serverId, version, serverId).first();
  return !!row;
}

export async function revokeTerminalNode(db, serverId, now = Date.now(), context = null) {
  if (!isId(serverId) || !isTime(now)) throw new RangeError('Invalid terminal node revocation');
  if (context) {
    const row = await db.prepare(`SELECT settings.value, a.expires_at, a.revoked_at, n.enabled
      FROM settings JOIN terminal_auth_sessions a ON a.jti = ?
      JOIN terminal_nodes n ON n.server_id = ? WHERE settings.key = 'site_options'`)
      .bind(context.owner, serverId).first();
    if (!row || row.revoked_at !== null || row.expires_at !== context.ownerExpiry ||
        row.expires_at * 1000 <= now || context.authorizationKey !== await terminalAuthorizationKey(JSON.parse(row.value))) return null;
    // Explicit admin denial fences pending enables even if permission is already off.
    const revoked = await db.prepare(`UPDATE terminal_nodes SET enabled = 0, updated_at = ?,
      credential_version = MIN(credential_version + 1, 9007199254740991)
      WHERE server_id = ? AND credential_version = ? AND enabled = ?
        AND EXISTS (SELECT 1 FROM settings WHERE key = 'site_options' AND value = ?)
        AND EXISTS (SELECT 1 FROM terminal_auth_sessions WHERE jti = ? AND revoked_at IS NULL AND expires_at = ? AND expires_at * 1000 > ? AND expires_at > unixepoch())
      RETURNING credential_version, token_version`)
      .bind(now, serverId, context.credentialVersion, row.enabled, row.value, context.owner, context.ownerExpiry, now).first();
    return revoked ? {...revoked, wasEnabled:row.enabled === 1} : null;
  }
  await db.prepare(`
    UPDATE terminal_nodes SET enabled = 0, updated_at = ?,
      credential_version = MIN(credential_version + 1, 9007199254740991)
    WHERE server_id = ? AND enabled = 1
  `).bind(now, serverId).run();
}

export async function revokeTerminalAdmin(db, jti, jwtExpiry, now = Date.now()) {
  if (!isId(jti) || !isTime(jwtExpiry) || !isTime(now)) throw new RangeError('Invalid terminal admin revocation');
  await db.prepare(`
    INSERT INTO terminal_auth_sessions (jti, expires_at, revoked_at) VALUES (?, ?, ?)
    ON CONFLICT(jti) DO UPDATE SET revoked_at = COALESCE(terminal_auth_sessions.revoked_at, excluded.revoked_at)
  `).bind(jti, jwtExpiry, now).run();
}

export async function writeTerminalAudit(db, record) {
  const fields = ['serverId', 'sessionId', 'actorJti', 'event', 'reason', 'createdAt'];
  if (!record || Object.keys(record).some(field => !fields.includes(field)) ||
      !isId(record.serverId) || !isCode(record.event) || !isTime(record.createdAt) ||
      (record.sessionId != null && !isId(record.sessionId)) ||
      (record.actorJti != null && !isId(record.actorJti)) ||
      (record.reason != null && !isCode(record.reason))) {
    throw new RangeError('Invalid terminal audit metadata');
  }
  await db.prepare(`
    INSERT INTO terminal_audit (server_id, session_id, actor_jti, event, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(record.serverId, record.sessionId ?? null, record.actorJti ?? null,
    record.event, record.reason ?? null, record.createdAt).run();
}
