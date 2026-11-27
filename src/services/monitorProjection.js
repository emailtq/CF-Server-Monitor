import { projectCompatNode } from './monitorCompatNode.js';
import { mergeResourceBuckets, trafficCalendar } from './monitorStatistics.js';
import { MONITOR_BYTE_FIELDS } from '../shared/monitorAgentProtocol.js';

const I64_MAX = 9223372036854775807n;
const integer = value => value == null ? null : BigInt(value);
const numberToken = value => value == null ? null : JSON.rawJSON(String(value));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0,10) === value;
const periodValue = (value, period, current) => period === current ? integer(value) : validDate(period) && period < current ? 0n : null;
function monthUsed(rx, tx, mode) {
  if (rx == null || tx == null) return null;
  if (mode === 'up') return tx;
  if (mode === 'down') return rx;
  if (mode === 'max') return rx > tx ? rx : tx;
  return rx + tx > I64_MAX ? I64_MAX : rx + tx;
}

// Standard JSON numbers stay exact on the wire, independently of a browser's Number precision.
export function stringifyMonitor(data) {
  return JSON.stringify(data, (_, value) => typeof value === 'bigint' ? numberToken(value) : value);
}

export function projectMonitorNode(coreNode, viewerPolicy, now) {
  const { server, id, persisted, latest } = coreNode;
  const display = viewerPolicy.display;
  const node = projectCompatNode(server, id, persisted, latest, display, now);
  // CF stores allowances in GiB; decimal arithmetic preserves native i64 bytes.
  if(display.showTraffic && typeof server.traffic_limit==='string' && /^\d+(?:\.\d+)?$/.test(server.traffic_limit)) {
    const [whole,fraction='']=server.traffic_limit.split('.'),scale=10n**BigInt(fraction.length);
    const value=((BigInt(whole)*scale+BigInt(fraction||'0'))*1073741824n+scale/2n)/scale;
    node.traffic_limit=value<=I64_MAX?value:null;
  }
  const data = latest && latest.timestamp >= (persisted?.timestamp || 0) ? latest.data : persisted;
  const core = persisted?.monitor?.traffic ? persisted.monitor : data?.monitor;
  node.public_remark = typeof server.public_remark === 'string' ? server.public_remark : '';
  node.virt = data?.virt || persisted?.virt || '';
  // CF telemetry/calendar is UTC; notification_timezone is a separate presentation setting.
  node.expires_in = node.expires_at == null ? null : Math.round((Date.parse(node.expires_at) - Date.parse(new Date(now).toISOString().slice(0,10))) / 86400000);
  if (display.showTraffic && core?.traffic) {
    const t = core.traffic, month = core.month;
    node.total_rx = integer(t.totalRx); node.total_tx = integer(t.totalTx);
    const calendar = trafficCalendar(now,{resetDay:node.traffic_reset_day});
    node.month_rx = periodValue(month?.rx,month?.periodStart,calendar.monthStart);
    node.month_tx = periodValue(month?.tx,month?.periodStart,calendar.monthStart);
    node.day_rx = periodValue(t.dayRx,t.dayStart,calendar.dayStart);
    node.day_tx = periodValue(t.dayTx,t.dayStart,calendar.dayStart);
    node.month_start = calendar.monthStart;
    node.month_used = monthUsed(node.month_rx,node.month_tx,node.traffic_mode);
    const unknownMonth = node.month_rx === null || node.month_tx === null;
    const monthSource = unknownMonth ? (month?.source?.startsWith('unknown') ? month.source : 'unknown') : month?.source || 'ledger';
    node.traffic_source = { total:core.source || 'ledger', month:monthSource, month_precision:unknownMonth ? 'unknown' : month?.precision || 'exact-bytes', day:'ledger' };
  }
  if (display.showTraffic && !data?.monitor && !core?.traffic) {
    const legacy = key => {
      const value = data?.[key] ?? persisted?.[key];
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    };
    node.total_rx=legacy('net_rx'); node.total_tx=legacy('net_tx');
    node.month_rx=legacy('net_rx_monthly'); node.month_tx=legacy('net_tx_monthly');
    node.month_used=monthUsed(node.month_rx,node.month_tx,node.traffic_mode);
    node.traffic_source={total:'legacy-counter',month:'legacy-number',month_precision:'legacy-number',day:'unknown'};
  }
  if (display.showTraffic && data?.monitor && !core?.traffic) {
    for (const key of ['total_rx','total_tx','month_rx','month_tx','month_used','day_rx','day_tx']) node[key] = null;
    node.month_start = '';
    node.traffic_source={total:'unknown',month:'unknown',month_precision:'unknown',day:'unknown'};
  }
  // Missing one reading (including a full-month baseline) doesn't discard all current resource facts.
  if (node.online && data?.monitor) {
    const value = key => data[key] ?? null;
    node.metrics = { uptime: data.boot_time == null ? null : Math.max(0,Math.floor(((data.monitor.sampledAt ?? data.timestamp)-Number(data.boot_time))/1000)),
      cpu: value('cpu'), load: typeof data.load_avg === 'string' ? data.load_avg.split(/\s+/).map(Number) : null,
      mem_total: data.ram_total == null ? null : data.ram_total*1048576, mem_used: data.ram_used == null ? null : data.ram_used*1048576,
      swap_total: data.swap_total == null ? null : data.swap_total*1048576, swap_used: data.swap_used == null ? null : data.swap_used*1048576,
      disk_total: data.disk_total == null ? null : data.disk_total*1048576, disk_used: data.disk_used == null ? null : data.disk_used*1048576,
      net_rx: value('net_in_speed'), net_tx: value('net_out_speed'), tcp: value('tcp_conn'), udp: value('udp_conn'), procs: value('processes'),
      total_rx: node.total_rx, total_tx: node.total_tx, month_rx: node.month_rx, month_tx: node.month_tx };
  }
  if (data?.monitor) {
    // Native byte observations bypass the lossy CF MiB bridge; old unsafe numbers have no recoverable token.
    for (const key of MONITOR_BYTE_FIELDS) {
      const token=data.monitor.byteTokens?.[key];
      const value=token == null ? null : JSON.rawJSON(token);
      if (key.endsWith('_total')) node[key]=value;
      if (node.metrics) node.metrics[key]=value;
    }
  }
  if (node.metrics) for (const key of ['total_rx','total_tx','month_rx','month_tx']) node.metrics[key]=node[key];
  return node;
}

export function projectMonitorHistory(coreWindow) {
  const { step, resourceBuckets, probeSeries } = coreWindow;
  const grouped = new Map();
  for (const b of resourceBuckets) {
    const ts = Math.floor(b.ts/(step*1000))*step*1000;
    const list = grouped.get(ts) || []; list.push(b); grouped.set(ts,list);
  }
  const metrics = [...grouped].map(([ts,buckets]) => {
    const b = mergeResourceBuckets(buckets), mean = key => b.fields[key]?.mean ?? null, max = key => b.fields[key]?.max ?? null;
    return { ts:ts/1000, cpu:mean('cpu'), cpu_max:max('cpu'), mem_used:mean('mem_used'), swap_used:mean('swap_used'), disk_used:mean('disk_used'),
      net_rx:b.network.rxMean, net_tx:b.network.txMean, net_rx_max:max('net_rx'), net_tx_max:max('net_tx'), minutes:b.coverageMs/60000 };
  });
  const ping = [], loss = {}, probes = {}, attempts = {};
  for (const series of probeSeries) {
    const id = series.taskId;
    probes[id] = series.name || series.metricId;
    loss[id] = series.attempts > 0 ? series.timeouts/series.attempts*100 : null;
    attempts[id] = { attempts:series.attempts, timeouts:series.timeouts, mean:series.mean };
    const buckets = new Map();
    for (const p of series.samples) {
      const ts = Math.floor(p.sampledAt/(step*1000))*step;
      const bucket = buckets.get(ts) || []; bucket.push(p); buckets.set(ts,bucket);
    }
    for (const [ts,samples] of buckets) {
      const answers = samples.filter(p=>p.latencyMs >= 0).map(p=>p.latencyMs).sort((a,b)=>a-b);
      const n = answers.length, failed = samples.length-n;
      const row = { task_id:id, ts, latency:n ? Math.floor((answers[Math.floor((n-1)/2)]+answers[Math.floor(n/2)])/2) : null };
      if (n && answers[0] < answers[n-1]) row.band = [answers[0],answers[n-1]];
      if (failed) row.loss = Math.ceil(100*failed/samples.length);
      ping.push(row);
    }
  }
  return { metrics, ping, probes, loss, step, attempts, coverage:coreWindow.coverage };
}
