import { getHistoryIdRange, normalizeHistoryPartitionId, normalizeHistoryTimestamp } from '../database/indexOptimization.js';
import { getMonitorCompatIds, MONITOR_COMPAT_VISIBLE } from '../database/monitorCompatIds.js';
import { getDurableRealtimeState } from '../handlers/dashboard.js';
import { getWorkerLatestReportUpdates } from '../utils/latestReportCache.js';
import { normalizeBillingCycle } from '../utils/serverBilling.js';

const ONLINE_TIMEOUT_MS = 300_000;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const BILLING_CYCLE = {
  month: 'monthly', quarter: 'quarterly', half_year: 'semiannual', year: 'yearly',
  two_years: 'biennial', three_years: 'triennial', four_years: '48m', five_years: '60m'
};
const CURRENCY = new Map(Object.entries({
  $: 'USD', '¥': 'CNY', '￥': 'CNY', '€': 'EUR', '£': 'GBP', '¥JPY': 'JPY', 'HK$': 'HKD',
  'A$': 'AUD', 'C$': 'CAD', 'S$': 'SGD', 'NZ$': 'NZD', '₣': 'CHF', '₩': 'KRW', '₹': 'INR',
  '฿': 'THB', '₫': 'VND', '₱': 'PHP', Rp: 'IDR', RM: 'MYR', '₺': 'TRY', '₪': 'ILS',
  '৳': 'BDT', '₨': 'PKR', LKR: 'LKR', '₮': 'MNT', '₽': 'RUB', 'R$': 'BRL', kr: 'SEK',
  'zł': 'PLN', '₴': 'UAH', '₸': 'KZT', R: 'ZAR', '₦': 'NGN', EGP: 'EGP', 'د.إ': 'AED', '﷼': 'SAR', Q: 'GTQ'
}));

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

function nonnegative(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function bytes(value, unit = 1) {
  const number = nonnegative(value);
  const converted = number == null ? null : Math.round(number * unit);
  return Number.isSafeInteger(converted) ? converted : null;
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

function loadValues(value) {
  const values = Array.isArray(value) ? value : string(value).trim().split(/\s+/);
  if (values.length !== 3) return null;
  const numbers = Array.from(values, nonnegative);
  return numbers.every(number => number !== null) ? numbers : null;
}

function collectLatestSamples(updates) {
  const latest = new Map();
  for (const update of updates) {
    if (!update?.serverId || !Array.isArray(update.samples)) continue;
    for (const sample of update.samples) {
      const data = sample?.data ?? sample?.payload ?? sample?.metrics;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const timestamp = normalizeHistoryTimestamp(sample.ts ?? sample.timestamp ?? data.sample_timestamp ?? data.last_updated ?? data.timestamp, 0);
      if (timestamp && timestamp >= (latest.get(update.serverId)?.timestamp ?? 0)) {
        latest.set(update.serverId, { timestamp, data });
      }
    }
  }
  return latest;
}

function projectMetrics(data, bootTime, timestamp, traffic) {
  const boot = normalizeHistoryTimestamp(bootTime, 0);
  const m = {
    uptime: boot > 0 && boot <= timestamp ? Math.floor((timestamp - boot) / 1000) : null,
    cpu: nonnegative(data?.cpu),
    load: loadValues(data?.load ?? data?.load_avg),
    mem_total: bytes(data?.ram_total, MIB), mem_used: bytes(data?.ram_used, MIB),
    swap_total: bytes(data?.swap_total, MIB), swap_used: bytes(data?.swap_used, MIB),
    disk_total: bytes(data?.disk_total, MIB), disk_used: bytes(data?.disk_used, MIB),
    net_rx: bytes(data?.net_in_speed), net_tx: bytes(data?.net_out_speed),
    ...traffic,
    tcp: nonnegative(data?.tcp_conn), udp: nonnegative(data?.udp_conn), procs: nonnegative(data?.processes)
  };
  // Default v1.4.3 requires every live metric. Retain last_seen but don't invent measurements.
  return Object.values(m).includes(null) ? null : m;
}

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && new Date(ts).toISOString().startsWith(value) ? value : null;
}

function projectNode(server, id, persisted, latest, display, now) {
  const oldest = normalizeHistoryTimestamp(server.timestamp, 0);
  const persistedTs = normalizeHistoryTimestamp(persisted?.timestamp, 0);
  if (latest && latest.timestamp < oldest) latest = null;
  const useLatest = latest && latest.timestamp >= persistedTs;
  const data = useLatest ? latest.data : persisted;
  const timestamp = useLatest ? latest.timestamp : persistedTs;
  const lastSeen = Math.floor(timestamp / 1000);
  const online = timestamp > 0 && now - timestamp < ONLINE_TIMEOUT_MS;
  const staticField = key => string(data?.[key]) || string(persisted?.[key]);
  const total = (key, unit = 1) => bytes(data?.[key], unit) ?? bytes(persisted?.[key], unit) ?? 0;
  const country = (string(server.region) || staticField('region')).toUpperCase();
  // The cumulative values are CF agent counters, not Monitor's hub-maintained lifetime ledger.
  const traffic = {
    total_rx: display.showTraffic ? total('net_rx') : 0,
    total_tx: display.showTraffic ? total('net_tx') : 0,
    month_rx: display.showTraffic ? total('net_rx_monthly') : 0,
    month_tx: display.showTraffic ? total('net_tx_monthly') : 0
  };
  const mode = display.showTraffic ? server.traffic_calc_type : '';
  const trafficMode = mode === 'ul' ? 'up' : mode === 'dl' ? 'down' : mode === 'max' ? 'max' : 'sum';
  const { month_rx: rx, month_tx: tx } = traffic;
  const price = display.showPrice ? nonnegative(server.price) ?? 0 : 0;

  return {
    id, name: string(server.name), sort: Number(server.sort_order) || 0, public: true, online,
    country: /^[A-Z]{2}$/.test(country) ? country : '', group: string(server.server_group),
    last_seen: lastSeen, last_seen_ago: lastSeen ? Math.max(0, Math.floor(now / 1000) - lastSeen) : null,
    metrics: online ? projectMetrics(data, staticField('boot_time'), timestamp, traffic) : null,
    os: staticField('os'), kernel: staticField('kernel_version'), arch: staticField('arch'), virt: '',
    cpu_name: staticField('cpu_info'), cpu_cores: total('cpu_cores'),
    mem_total: total('ram_total', MIB), swap_total: total('swap_total', MIB), disk_total: total('disk_total', MIB),
    agent_version: staticField('agent_version'),
    price, currency: price > 0 ? CURRENCY.get(server.currency) ?? '' : '',
    billing_cycle: price > 0 ? BILLING_CYCLE[normalizeBillingCycle(server.billing_cycle)] : '',
    expires_at: display.showExpire ? dateOnly(server.expire_date) : null,
    traffic_limit: display.showTraffic ? bytes(server.traffic_limit, GIB) ?? 0 : 0,
    traffic_mode: trafficMode,
    traffic_reset_day: display.showTraffic && Number.isInteger(server.reset_day) && server.reset_day >= 1 && server.reset_day <= 31 ? server.reset_day : 1,
    ...traffic,
    month_used: trafficMode === 'up' ? tx : trafficMode === 'down' ? rx : trafficMode === 'max' ? Math.max(rx, tx) : rx + tx,
    // CF only stores total/month counters, not daily counters or the actual period start.
    month_start: '', day_rx: null, day_tx: null
  };
}

export async function loadMonitorCompatSnapshot(env, { display, latestReportUpdates, now = Date.now() }) {
  const db = env.DB;
  // Re-read visibility directly; the legacy list cache may contain hidden/deleted nodes.
  const { success, results: servers } = await db.prepare(`
    SELECT id, name, sort_order, server_group, region, history_partition_id, timestamp,
      price, billing_cycle, currency, expire_date, traffic_limit, traffic_calc_type, reset_day
    FROM servers WHERE ${MONITOR_COMPAT_VISIBLE} ORDER BY sort_order ASC, id ASC
  `).all();
  if (!success) throw new Error('Monitor node list unavailable');
  const serverIds = servers.map(server => server.id);
  const [persisted, realtime] = await Promise.all([
    loadLatestPersisted(db, servers),
    // The hub supplies its already loaded updates to reuse this projection without self-fetching.
    latestReportUpdates ?? getDurableRealtimeState(env, serverIds).then(state => [
      ...state.latestReportUpdates, ...getWorkerLatestReportUpdates(serverIds)
    ])
  ]);
  const ids = await getMonitorCompatIds(db, serverIds);
  const latest = collectLatestSamples(realtime);
  const nodes = servers.map(server => {
    const id = ids.get(server.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Monitor ID unavailable');
    return projectNode(server, id, persisted.get(server.id), latest.get(server.id), display, now);
  });
  return { nodes, admin: false };
}
