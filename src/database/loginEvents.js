export async function ensureLoginEventSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS login_events (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, server_id TEXT, token_version INTEGER, credential_version INTEGER,
      payload TEXT NOT NULL, targets TEXT NOT NULL, policy_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_event_deliveries (
      delivery_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      rules TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS login_event_pending ON login_event_deliveries(state, updated_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_event_policy_invalidations (
      rule_id TEXT NOT NULL, channel_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(rule_id, channel_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ssh_event_cursors (
      server_id TEXT NOT NULL, token_version INTEGER NOT NULL, stream TEXT NOT NULL, sequence INTEGER NOT NULL,
      PRIMARY KEY(server_id, token_version, stream)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ssh_event_sources (
      server_id TEXT PRIMARY KEY, token_version INTEGER NOT NULL, state TEXT NOT NULL,
      source TEXT NOT NULL, observed_at INTEGER NOT NULL
    )`)
  ]);
}

export async function cleanupLoginEvents(db, now = Date.now()) {
  await db.batch([
    db.prepare(`DELETE FROM login_event_deliveries WHERE event_id IN (
      SELECT id FROM login_events e WHERE e.server_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id
        WHERE n.server_id=e.server_id AND n.token_version=e.token_version AND (e.credential_version IS NULL OR n.credential_version=e.credential_version)))`),
    db.prepare(`DELETE FROM login_events WHERE server_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id
      WHERE n.server_id=login_events.server_id AND n.token_version=login_events.token_version AND (login_events.credential_version IS NULL OR n.credential_version=login_events.credential_version))`),
    db.prepare(`DELETE FROM ssh_event_cursors WHERE NOT EXISTS (SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id
      WHERE n.server_id=ssh_event_cursors.server_id AND n.token_version=ssh_event_cursors.token_version)`),
    db.prepare(`DELETE FROM ssh_event_sources WHERE NOT EXISTS (SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id
      WHERE n.server_id=ssh_event_sources.server_id AND n.token_version=ssh_event_sources.token_version)`),
    // Receipts for SSH survive in the monotonic stream cursor, without retaining login details.
    db.prepare(`DELETE FROM login_event_deliveries WHERE state IN ('sent','cancelled','uncertain') AND updated_at < ?`).bind(now - 7 * 86400000),
    db.prepare(`DELETE FROM login_events WHERE type='sshLogin' AND created_at < ? AND NOT EXISTS (
      SELECT 1 FROM login_event_deliveries d WHERE d.event_id=login_events.id)`).bind(now - 7 * 86400000),
    db.prepare(`UPDATE login_events SET payload='{}',targets='[]' WHERE created_at < ? AND NOT EXISTS (
      SELECT 1 FROM login_event_deliveries d WHERE d.event_id=login_events.id)`).bind(now - 7 * 86400000)
  ]);
}

export async function loginEventDiagnostics(db) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ssh_event_sources','login_event_deliveries','terminal_nodes')").all();
  if (tables.results.length !== 3) return { sources: [], deliveries: [] };
  const sources = await db.prepare(`SELECT x.server_id AS serverId, s.name, x.state, x.source, x.observed_at AS observedAt
    FROM ssh_event_sources x JOIN servers s ON s.id=x.server_id JOIN terminal_nodes n ON n.server_id=x.server_id
    WHERE x.token_version=n.token_version`).all();
  const counts = await db.prepare("SELECT state, COUNT(*) AS count FROM login_event_deliveries WHERE state IN ('pending','sending','uncertain') GROUP BY state").all();
  return { sources: sources.results, deliveries: counts.results };
}
