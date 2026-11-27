import { getHistoryIdRange, normalizeHistoryPartitionId, normalizeHistoryTimestamp } from '../database/indexOptimization.js';
import { getMonitorCompatIds, MONITOR_COMPAT_VISIBLE } from '../database/monitorCompatIds.js';
import { getDurableRealtimeState } from '../handlers/dashboard.js';
import { getWorkerLatestReportUpdates } from '../utils/latestReportCache.js';
import { readMonitorLatest } from '../database/monitorTelemetry.js';
import { projectMonitorNode } from './monitorProjection.js';
import { projectCompatNode, collectLatestSamples } from './monitorCompatNode.js';

async function loadLatestPersisted(db, servers) {
  const ranges = [];
  for (const server of servers) {
    const partition = normalizeHistoryPartitionId(server.history_partition_id);
    if (!partition) continue;
    try {
      const { startId, endId } = getHistoryIdRange(partition, normalizeHistoryTimestamp(server.timestamp, 0) || null);
      ranges.push([server.id, startId, endId]);
    } catch {
      // A bad legacy partition/start cannot identify trustworthy rows for that node.
    }
  }
  const latest = new Map();
  for (let offset = 0; offset < ranges.length; offset += 100) {
    // Seek the newest row in each encoded partition, with a UUID check for reused partitions.
    const { success, results } = await db.prepare(`
      SELECT m.server_id, m.timestamp, m.cpu, m.load_avg, m.ram_total, m.ram_used,
        m.swap_total, m.swap_used, m.disk_total, m.disk_used, m.net_in_speed, m.net_out_speed,
        m.net_rx, m.net_tx, m.net_rx_monthly, m.net_tx_monthly, m.processes, m.tcp_conn, m.udp_conn,
        m.cpu_cores, m.cpu_info, m.os, m.arch, m.kernel_version, m.boot_time, m.agent_version, m.region
      FROM json_each(?) AS ranges
      JOIN metrics_history AS m ON m.id = (
        SELECT id FROM metrics_history
        WHERE id BETWEEN ranges.value ->> 1 AND ranges.value ->> 2
          AND server_id = ranges.value ->> 0
        ORDER BY id DESC LIMIT 1
      )
    `).bind(JSON.stringify(ranges.slice(offset, offset + 100))).all();
    if (!success) throw new Error('Monitor metrics unavailable');
    for (const row of results) latest.set(row.server_id, row);
  }
  return latest;
}

export async function loadMonitorCompatBaseline(db) {
  // Re-read visibility directly; the legacy list cache may contain hidden/deleted nodes.
  const columns = (await db.prepare('PRAGMA table_info(servers)').all()).results;
  const publicRemark = columns.some(c => c.name === 'public_remark') ? ', public_remark' : '';
  const { success, results: servers } = await db.prepare(`
    SELECT id, name, sort_order, server_group, region, history_partition_id, timestamp,
      price, billing_cycle, currency, expire_date, traffic_limit, traffic_calc_type, reset_day${publicRemark}
    FROM servers WHERE ${MONITOR_COMPAT_VISIBLE} ORDER BY sort_order ASC, id ASC
  `).all();
  if (!success) throw new Error('Monitor node list unavailable');
  const serverIds = servers.map(server => server.id);
  const [persisted, ids] = await Promise.all([
    loadLatestPersisted(db, servers),
    getMonitorCompatIds(db, serverIds)
  ]);
  for(const [id,row] of await readMonitorLatest(db,serverIds))if(row)persisted.set(id,row);
  return { servers, serverIds, persisted, ids };
}

export function projectMonitorCompatSnapshot({ servers, persisted, ids }, { display, latestReportUpdates, now, standard = false }) {
  const latest = collectLatestSamples(latestReportUpdates);
  const nodes = servers.map(server => {
    const id = ids.get(server.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Monitor ID unavailable');
    return standard ? projectMonitorNode({server,id,persisted:persisted.get(server.id),latest:latest.get(server.id)},{display},now) : projectCompatNode(server, id, persisted.get(server.id), latest.get(server.id), display, now);
  });
  return { nodes, admin: false };
}

export async function loadMonitorCompatSnapshot(env, { display, latestReportUpdates, now = Date.now(), standard = false }) {
  const baseline = await loadMonitorCompatBaseline(env.DB);
  if (latestReportUpdates == null) {
    const { serverIds } = baseline;
    const realtime = await getDurableRealtimeState(env, serverIds);
    latestReportUpdates = [...realtime.latestReportUpdates, ...getWorkerLatestReportUpdates(serverIds)];
  }
  return projectMonitorCompatSnapshot(baseline, { display, latestReportUpdates, now, standard });
}
