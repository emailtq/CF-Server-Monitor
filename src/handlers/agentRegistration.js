import { getTerminalAdminPrincipal } from '../middleware/auth.js';
import { hashNodeToken, prepareNodeCredential } from '../database/nodeCredentials.js';
import { SERVER_INSERT_SQL } from '../database/indexOptimization.js';
import { ensureAgentRegistrationSchema, REGISTRATION_DB_NOW_SQL, REGISTRATION_ENABLED_SQL, REGISTRATION_VALID_SQL } from '../database/agentRegistration.js';
import { generateRandomSecret, isValidJwtSecret } from '../utils/settings.js';
import { isAutoDiscoveryEnabled, resolveDiscoveredServerName } from '../utils/autoDiscovery.js';
import { clearServersListCache } from '../utils/cache.js';

const MAX_BODY_BYTES = 4096;
const response = (body, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
const error = (code, status) => response({error:code}, status);

async function authority(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'site_options'").first();
  const settings = row ? JSON.parse(row.value) : null;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('registration_authority_unavailable');
  return settings;
}

export async function handlePrepareRegistration(request, env, data) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || request.headers.get('Origin') !== url.origin) return error('node_origin_denied', 403);
  try {
    const settings = await authority(env.DB);
    const owner = await getTerminalAdminPrincipal(request, env, settings);
    if (!owner) return error('node_login_required', 401);
    if (Object.keys(data).some(key => key !== 'action')) return error('registration_invalid_request', 400);
    if (!isAutoDiscoveryEnabled(settings)) return error('registration_disabled', 403);
    await ensureAgentRegistrationSchema(env.DB);
    const key = generateRandomSecret(32);
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000;
    const issued = await env.DB.prepare(`INSERT INTO agent_registration_keys (id, key_hash, issued_at, expires_at, registration_count)
      SELECT 1, ?, ?, ?, 0 WHERE ${REGISTRATION_ENABLED_SQL}
        AND EXISTS (SELECT 1 FROM settings WHERE key='site_options' AND json_extract(value, '$.jwt_secret') = ?)
        AND EXISTS (SELECT 1 FROM terminal_auth_sessions WHERE jti=? AND expires_at=? AND revoked_at IS NULL
          AND expires_at * 1000 > ? AND expires_at * 1000 > ${REGISTRATION_DB_NOW_SQL})
      ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, issued_at=excluded.issued_at,
        expires_at=excluded.expires_at, registration_count=0`)
      .bind(await hashNodeToken(key), now, expiresAt, settings.jwt_secret, owner.jti, owner.exp, Date.now()).run();
    if (issued.meta?.changes !== 1) return error('registration_authority_changed', 403);
    return response({key, expiresAt});
  } catch (_) { return error('registration_unavailable', 503); }
}

async function readBody(request) {
  const rawLength = request.headers.get('Content-Length');
  if (rawLength !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)))) return {failure:error('registration_invalid_length', 400)};
  const declared = rawLength === null ? null : Number(rawLength);
  if (declared > MAX_BODY_BYTES) return {failure:error('registration_payload_too_large', 413)};
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) return {failure:error('registration_json_required', 415)};
  const reader = request.body?.getReader();
  if (!reader) return {failure:error('registration_invalid_json', 400)};
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return {failure:error('registration_payload_too_large', 413)};
      }
      chunks.push(value);
    }
    if (declared !== null && size !== declared) return {failure:error('registration_invalid_length', 400)};
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'name') ||
        (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100))) return {failure:error('registration_invalid_json', 400)};
    return {body};
  } catch (_) { return {failure:error('registration_invalid_json', 400)}; }
  finally { reader.releaseLock(); }
}

async function admission(db, hash) {
  const settings = await authority(db);
  if (!isAutoDiscoveryEnabled(settings)) return {failure:error('registration_disabled', 403)};
  const key = await db.prepare(`SELECT registration_count FROM agent_registration_keys
    WHERE id=1 AND key_hash=? AND expires_at > ? AND expires_at > ${REGISTRATION_DB_NOW_SQL}`)
    .bind(hash, Date.now()).first();
  if (!key) return {failure:error('registration_key_denied', 401)};
  if (key.registration_count >= 100) return {failure:error('registration_limit_reached', 409)};
  if (!isValidJwtSecret(settings.jwt_secret)) throw new Error('registration_authority_unavailable');
  return {settings};
}

export async function handleAgentRegistration(request, env) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password) return error('registration_https_required', 403);
  if (request.method !== 'POST') return error('registration_method_denied', 405);
  const key = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!key || url.search) return error('registration_key_denied', 401);
  try {
    const parsed = await readBody(request);
    if (parsed.failure) return parsed.failure;
    const hash = await hashNodeToken(key);
    const authorized = await admission(env.DB, hash);
    if (authorized.failure) return authorized.failure;
    const name = resolveDiscoveredServerName({name:parsed.body.name, request});
    if (!name) return error('registration_name_required', 400);
    const serverId = crypto.randomUUID();
    const credential = await prepareNodeCredential(serverId, authorized.settings.jwt_secret);
    try {
      // D1 batch is a transaction. changes() links each write; the final NOT NULL
      // credential hash aborts the whole batch on any failed admission or node insert.
      await env.DB.batch([
        env.DB.prepare(`UPDATE agent_registration_keys SET registration_count=registration_count+1
          WHERE id=1 AND registration_count < 100 AND ${REGISTRATION_VALID_SQL}`)
          .bind(hash, Date.now(), authorized.settings.jwt_secret),
        env.DB.prepare(`${SERVER_INSERT_SQL} AND changes()=1 AND ${REGISTRATION_VALID_SQL}`)
          .bind(0, serverId, name, 'Default', '', '', Date.now(), hash, Date.now(), authorized.settings.jwt_secret),
        env.DB.prepare(`INSERT INTO terminal_nodes
          (server_id, token_hash, token_ciphertext, token_version, credential_version, enabled, updated_at)
          VALUES (?, CASE WHEN changes()=1 AND ${REGISTRATION_VALID_SQL}
            AND EXISTS (SELECT 1 FROM servers WHERE id=?) THEN ? ELSE NULL END, ?, 1, 1, 0, ?)`)
          .bind(serverId, hash, Date.now(), authorized.settings.jwt_secret, serverId, credential.hash, credential.ciphertext, Date.now())
      ]);
    } catch (_) {
      const current = await admission(env.DB, hash);
      return current.failure || error('registration_unavailable', 503);
    }
    clearServersListCache();
    return response({serverId, token:credential.token});
  } catch (_) { return error('registration_unavailable', 503); }
}
