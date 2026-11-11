import { generateRandomSecret } from '../utils/settings.js';

export async function ensureTerminalSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS terminal_nodes (
      server_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      credential_version INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`),
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

async function hashToken(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function terminalAuthorizationKey(settings) {
  return hashToken(settings.jwt_secret || '');
}

// Recheck outside the broker metadata queue; dashboard caches are never authority.
export async function verifyTerminalAuthority(db, context, now = Date.now()) {
  const row = await db.prepare(`SELECT settings.value, n.enabled, n.credential_version, a.expires_at, a.revoked_at
    FROM settings JOIN servers s ON s.id = ? JOIN terminal_nodes n ON n.server_id = s.id
    LEFT JOIN terminal_auth_sessions a ON a.jti = ? WHERE settings.key = 'site_options'`)
    .bind(context.serverId, context.owner || '').first();
  if (!row || row.enabled !== 1 || row.credential_version !== context.credentialVersion) return false;
  const settings = JSON.parse(row.value);
  if (!settings || ![true, 'true'].includes(settings.terminal_enabled) || settings.theme_url) return false;
  if (context.owner && (row.revoked_at !== null || row.expires_at !== context.ownerExpiry ||
      row.expires_at * 1000 <= now || context.authorizationKey !== await terminalAuthorizationKey(settings))) return false;
  return true;
}

export async function cleanupTerminalRecords(db, now = Date.now()) {
  if (!isTime(now)) throw new RangeError('Invalid terminal maintenance time');
  await db.prepare('DELETE FROM terminal_audit WHERE created_at < ?').bind(now - 7 * 86400000).run();
  await db.prepare('DELETE FROM terminal_auth_sessions WHERE expires_at <= ?').bind(Math.floor(now / 1000)).run();
}

export async function issueTerminalNodeToken(db, serverId, now = Date.now()) {
  if (!isId(serverId) || !isTime(now)) throw new RangeError('Invalid terminal node issuance');
  const token = generateRandomSecret(32);
  const hash = await hashToken(token);
  const row = await db.prepare(`
    INSERT INTO terminal_nodes (server_id, token_hash, credential_version, enabled, updated_at)
    VALUES (?, ?, 1, 1, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      credential_version = terminal_nodes.credential_version + 1,
      enabled = 1,
      updated_at = excluded.updated_at
    WHERE terminal_nodes.credential_version < 9007199254740991
    RETURNING credential_version
  `).bind(serverId, hash, now).first();
  if (!row) throw new RangeError('Terminal credential version exhausted');
  return { token, version: row.credential_version };
}

export async function verifyTerminalNodeToken(db, serverId, token) {
  if (!isId(serverId) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.prepare(`
    SELECT credential_version FROM terminal_nodes
    WHERE server_id = ? AND token_hash = ? AND enabled = 1
  `).bind(serverId, await hashToken(token)).first();
  if (!row || !Number.isSafeInteger(row.credential_version) || row.credential_version < 1) return null;
  return { serverId, version: row.credential_version };
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
    // CAS binds rotation, logout and the exact uncached settings snapshot to this write.
    const revoked = await db.prepare(`UPDATE terminal_nodes SET enabled = 0, updated_at = ?,
      credential_version = MIN(credential_version + enabled, 9007199254740991)
      WHERE server_id = ? AND credential_version = ? AND enabled = ?
        AND EXISTS (SELECT 1 FROM settings WHERE key = 'site_options' AND value = ?)
        AND EXISTS (SELECT 1 FROM terminal_auth_sessions WHERE jti = ? AND revoked_at IS NULL AND expires_at = ? AND expires_at * 1000 > ? AND expires_at > unixepoch())
      RETURNING credential_version`)
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
