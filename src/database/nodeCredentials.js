import { generateRandomSecret } from '../utils/settings.js';

const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isVersion = value => Number.isSafeInteger(value) && value > 0;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));

export async function ensureNodeCredentialSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS terminal_nodes (
    server_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    token_ciphertext TEXT,
    token_version INTEGER NOT NULL DEFAULT 1,
    credential_version INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`).run();
  const columns = await db.prepare('PRAGMA table_info(terminal_nodes)').all();
  for (const [name, definition] of [['token_ciphertext', 'TEXT'], ['token_version', 'INTEGER NOT NULL DEFAULT 1']]) {
    if (columns.results.some(column => column.name === name)) continue;
    try { await db.prepare(`ALTER TABLE terminal_nodes ADD COLUMN ${name} ${definition}`).run(); }
    catch (error) {
      const current = await db.prepare('PRAGMA table_info(terminal_nodes)').all();
      if (!current.results.some(column => column.name === name)) throw error;
    }
  }
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS terminal_nodes_token_hash_unique ON terminal_nodes(token_hash)').run();
}

export async function hashNodeToken(token) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

async function credentialKey(secret) {
  if (!secret) throw new Error('node_credential_key_missing');
  // Keep the historical derivation so existing server-bound ciphertext remains readable.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cfsm-terminal-install:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt','decrypt']);
}

async function encryptCredential(token, serverId, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:new TextEncoder().encode(serverId)}, await credentialKey(secret), new TextEncoder().encode(token));
  return hex(iv) + hex(new Uint8Array(encrypted));
}

export async function readNodeToken(db, serverId, encryptionSecret) {
  if (!isId(serverId)) throw new RangeError('Invalid node');
  const row = await db.prepare(`SELECT n.token_hash, n.token_ciphertext, n.token_version, n.credential_version, n.enabled
    FROM terminal_nodes n JOIN servers s ON s.id = n.server_id WHERE n.server_id = ?`).bind(serverId).first();
  if (!row) return {token:'', version:0, tokenVersion:0, enabled:false, needsRotation:false};
  const result = {token:'', version:row.credential_version, tokenVersion:row.token_version, enabled:row.enabled === 1, needsRotation:true};
  if (!isVersion(row.credential_version) || !isVersion(row.token_version) || !/^[a-f0-9]{184}$/.test(row.token_ciphertext || '')) return result;
  try {
    const data = unhex(row.token_ciphertext);
    const token = new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM', iv:data.slice(0,12), additionalData:new TextEncoder().encode(serverId)}, await credentialKey(encryptionSecret), data.slice(12)));
    if (/^[a-f0-9]{64}$/.test(token) && await hashNodeToken(token) === row.token_hash) return {...result, token, needsRotation:false};
  } catch (_) { /* Unreadable credentials require an explicit reset, never replacement on read. */ }
  return result;
}

export async function ensureNodeToken(db, serverId, encryptionSecret, now = Date.now()) {
  if (!isId(serverId) || !isTime(now)) throw new RangeError('Invalid node issuance');
  const current = await readNodeToken(db, serverId, encryptionSecret);
  if (current.version) return current;
  const token = generateRandomSecret(32);
  const ciphertext = await encryptCredential(token, serverId, encryptionSecret);
  await db.prepare(`INSERT INTO terminal_nodes (server_id, token_hash, token_ciphertext, token_version, credential_version, enabled, updated_at)
    SELECT id, ?, ?, 1, 1, 0, ? FROM servers WHERE id = ?
    ON CONFLICT(server_id) DO NOTHING`).bind(await hashNodeToken(token), ciphertext, now, serverId).run();
  const issued = await readNodeToken(db, serverId, encryptionSecret);
  if (!issued.version) throw new Error('node_missing');
  return issued;
}

export async function issueNodeToken(db, serverId, now = Date.now(), encryptionSecret = '') {
  if (!isId(serverId) || !isTime(now)) throw new RangeError('Invalid node issuance');
  const token = generateRandomSecret(32);
  const ciphertext = encryptionSecret ? await encryptCredential(token, serverId, encryptionSecret) : null;
  const row = await db.prepare(`INSERT INTO terminal_nodes (server_id, token_hash, token_ciphertext, token_version, credential_version, enabled, updated_at)
    SELECT id, ?, ?, 1, 1, 0, ? FROM servers WHERE id = ?
    ON CONFLICT(server_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      token_ciphertext = excluded.token_ciphertext,
      token_version = terminal_nodes.token_version + 1,
      credential_version = terminal_nodes.credential_version + 1,
      updated_at = excluded.updated_at
    WHERE terminal_nodes.token_version BETWEEN 1 AND 9007199254740990
      AND terminal_nodes.credential_version BETWEEN 1 AND 9007199254740990
    RETURNING token_version, credential_version, enabled
  `).bind(await hashNodeToken(token), ciphertext, now, serverId).first();
  if (!row) throw new RangeError('Node missing or credential version exhausted');
  return {token, version:row.credential_version, tokenVersion:row.token_version, enabled:row.enabled === 1, needsRotation:!ciphertext};
}

export async function verifyNodeToken(db, token, requestedId = undefined) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || (requestedId !== undefined && !isId(requestedId))) return null;
  // Deny ambiguous legacy hashes even when the uniqueness migration failed.
  const row = await db.prepare(`SELECT n.server_id, n.token_version, n.credential_version
    FROM terminal_nodes n JOIN servers s ON s.id = n.server_id
    WHERE n.token_hash = ? AND (? IS NULL OR n.server_id = ?)
      AND NOT EXISTS (SELECT 1 FROM terminal_nodes other WHERE other.token_hash = n.token_hash AND other.server_id <> n.server_id)`)
    .bind(await hashNodeToken(token), requestedId ?? null, requestedId ?? null).first();
  if (!row || !isId(row.server_id) || !isVersion(row.token_version) || !isVersion(row.credential_version)) return null;
  return {serverId:row.server_id, tokenVersion:row.token_version, version:row.credential_version};
}
