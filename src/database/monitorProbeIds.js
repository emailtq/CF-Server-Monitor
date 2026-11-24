import { EXTRA_PING_ID_PATTERN } from '../shared/extraPing.js';

export async function getMonitorProbeIds(db, metricIds) {
  if (!Array.isArray(metricIds) || metricIds.some(id => typeof id !== 'string' || !EXTRA_PING_ID_PATTERN.test(id))) {
    throw new TypeError('Invalid monitor metric IDs');
  }
  const ids = new Map();
  if (!metricIds.length) return ids;
  // No FK/cascade: archived/deleted metric generations must keep their reserved IDs.
  const schema = await db.prepare(`CREATE TABLE IF NOT EXISTS monitor_probe_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
    metric_id TEXT NOT NULL UNIQUE
  )`).run();
  if (!schema.success) throw new Error('Monitor probe ID schema unavailable');
  for (let offset = 0; offset < metricIds.length; offset += 100) {
    const chunk = JSON.stringify(metricIds.slice(offset, offset + 100));
    const [insert, lookup] = await db.batch([
      db.prepare(`INSERT INTO monitor_probe_ids (metric_id)
        SELECT DISTINCT incoming.value FROM json_each(?) AS incoming
        WHERE NOT EXISTS (SELECT 1 FROM monitor_probe_ids WHERE metric_id = incoming.value)
        ON CONFLICT (metric_id) DO NOTHING`).bind(chunk),
      db.prepare(`SELECT id, metric_id FROM monitor_probe_ids
        WHERE metric_id IN (SELECT value FROM json_each(?))`).bind(chunk)
    ]);
    if (!insert.success || !lookup.success) throw new Error('Monitor probe ID lookup failed');
    for (const row of lookup.results) ids.set(row.metric_id, row.id);
  }
  return ids;
}
