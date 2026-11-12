// Use the database clock as well as the request clock, including time spent queued for D1.
// Rounding up denies at most one second early, never grants past expiry.
export const REGISTRATION_DB_NOW_SQL = "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 999)";
export const REGISTRATION_ENABLED_SQL = `EXISTS (
  SELECT 1 FROM settings WHERE key = 'site_options' AND json_valid(value)
    AND lower(trim(CAST(json_extract(value, '$.auto_discovery') AS TEXT))) IN ('true', '1', 'yes', 'on')
)`;
export const REGISTRATION_VALID_SQL = `EXISTS (
  SELECT 1 FROM agent_registration_keys WHERE id = 1 AND key_hash = ?
    AND expires_at > ? AND expires_at > ${REGISTRATION_DB_NOW_SQL}
    AND registration_count BETWEEN 0 AND 100
) AND ${REGISTRATION_ENABLED_SQL} AND EXISTS (
  SELECT 1 FROM settings WHERE key='site_options' AND json_extract(value, '$.jwt_secret') = ?
)`;

export async function ensureAgentRegistrationSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS agent_registration_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key_hash TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    registration_count INTEGER NOT NULL DEFAULT 0 CHECK (registration_count BETWEEN 0 AND 100)
  )`).run();
  // Disabling discovery permanently invalidates the outstanding key, even after re-enabling.
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS agent_registration_disable
    AFTER UPDATE OF value ON settings WHEN NEW.key = 'site_options' AND NOT ${REGISTRATION_ENABLED_SQL}
    BEGIN DELETE FROM agent_registration_keys; END`).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS agent_registration_settings_delete
    AFTER DELETE ON settings WHEN OLD.key = 'site_options'
    BEGIN DELETE FROM agent_registration_keys; END`).run();
}
