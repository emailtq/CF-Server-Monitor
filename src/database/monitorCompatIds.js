export const MONITOR_COMPAT_VISIBLE = "is_hidden = '0'";

export async function ensureMonitorCompatIdSchema(db) {
  // No FK/cascade: a deleted node's public ID remains reserved, independent of the history partition.
  const { success } = await db.prepare(`CREATE TABLE IF NOT EXISTS monitor_compat_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
    server_id TEXT NOT NULL UNIQUE
  )`).run();
  if (!success) throw new Error('Monitor ID schema unavailable');
}

export async function getMonitorCompatIds(db, serverIds) {
  const ids = new Map();
  if (!serverIds.length) return ids;
  await ensureMonitorCompatIdSchema(db);

  for (let offset = 0; offset < serverIds.length; offset += 100) {
    const chunk = JSON.stringify(serverIds.slice(offset, offset + 100));
    const [insert, lookup] = await db.batch([
      // Filtering before INSERT avoids burning AUTOINCREMENT values on every snapshot.
      db.prepare(`INSERT INTO monitor_compat_ids (server_id)
        SELECT DISTINCT incoming.value FROM json_each(?) AS incoming
        WHERE NOT EXISTS (SELECT 1 FROM monitor_compat_ids WHERE server_id = incoming.value)
        ON CONFLICT (server_id) DO NOTHING`).bind(chunk),
      db.prepare(`SELECT id, server_id FROM monitor_compat_ids
        WHERE server_id IN (SELECT value FROM json_each(?))`).bind(chunk)
    ]);
    if (!insert.success || !lookup.success) throw new Error('Monitor ID lookup failed');
    for (const row of lookup.results) ids.set(row.server_id, row.id);
  }
  return ids;
}
