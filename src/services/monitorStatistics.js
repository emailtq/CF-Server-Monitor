import { DISK_IO_METRIC_FIELDS,DISK_IO_FIELD_TO_COLUMN } from '../utils/metrics.js';

export const MONITOR_I64_MAX = 9223372036854775807n;

export function trafficCounter(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value) || BigInt(value) > MONITOR_I64_MAX) {
    throw new RangeError('Invalid traffic counter token');
  }
  return BigInt(value);
}
const add = (a, b) => String(BigInt(a || '0') + b > MONITOR_I64_MAX ? MONITOR_I64_MAX : BigInt(a || '0') + b);
const dateString = (y, m, d) => `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

export function trafficCalendar(observedAt, {timeZone = 'UTC', resetDay = 1} = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(observedAt).map(p=>[p.type,p.value]));
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const reset = Math.max(1,Math.min(31,resetDay));
  const start = (year,month) => dateString(year,month,Math.min(reset,new Date(Date.UTC(year,month,0)).getUTCDate()));
  const dayStart = dateString(y,m,d), current = start(y,m);
  return {dayStart,monthStart:dayStart >= current ? current : start(m === 1 ? y-1 : y,m === 1 ? 12 : m-1)};
}

/** CF uses sender times; standard-only may supply the hub's unseen-boot evidence. */
export function reduceTrafficLedger(previous, reading) {
  const rx = trafficCounter(reading.rx), tx = trafficCounter(reading.tx);
  if (typeof reading.epoch !== 'string' || !reading.epoch || !Number.isSafeInteger(reading.observedAt)) throw new RangeError('Invalid traffic reading');
  if (previous && reading.observedAt <= previous.observedAt) return previous;
  const continued = previous && previous.epoch === reading.epoch;
  // hub04a6fa1 db.rs:1615: only a changed kernel boot after last_seen counts its whole reading.
  const unseenBoot = previous && reading.source === 'standard' && previous.epoch.split('/')[0] !== reading.epoch.split('/')[0] && reading.lastSeen > 0 && reading.bootedAt > reading.lastSeen;
  const deltaRx = unseenBoot ? rx : continued && rx >= trafficCounter(previous.rx) ? rx-trafficCounter(previous.rx) : 0n;
  const deltaTx = unseenBoot ? tx : continued && tx >= trafficCounter(previous.tx) ? tx-trafficCounter(previous.tx) : 0n;
  const today = reading.today || reading.dayStart;
  const dated = (stored, incoming) => stored && stored <= today && stored > incoming ? stored : incoming;
  const dayStart = dated(previous?.dayStart,reading.dayStart);
  let monthStart = dated(previous?.monthStart,reading.monthStart);
  if (reading.resetDay !== undefined) {
    const date = dated(previous?.monthStart,reading.dayStart);
    const [y,m,d] = date.split('-').map(Number);
    monthStart = trafficCalendar(Date.UTC(y,m-1,d),{resetDay:reading.resetDay}).monthStart;
  }
  return {epoch:reading.epoch,rx:reading.rx,tx:reading.tx,observedAt:reading.observedAt,dayStart,monthStart,
    totalRx:add(previous?.totalRx,deltaRx),totalTx:add(previous?.totalTx,deltaTx),
    dayRx:add(previous?.dayStart === dayStart ? previous.dayRx : '0',deltaRx),dayTx:add(previous?.dayStart === dayStart ? previous.dayTx : '0',deltaTx),
    monthRx:add(previous?.monthStart === monthStart ? previous.monthRx : '0',deltaRx),monthTx:add(previous?.monthStart === monthStart ? previous.monthTx : '0',deltaTx)};
}

const RESOURCE_FIELDS = ['cpu','mem_total','mem_used','swap_total','swap_used','disk_total','disk_used','tcp','udp','procs','net_rx','net_tx'];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const networkReading = report => report?.boot_id && typeof report.net_rx_total === 'string' && typeof report.net_tx_total === 'string';

/** Keep the valid counter mark and all subsequent monotonic intervals until another comparable reading. */
export function reduceNetworkMark(previous, sample) {
  if (!networkReading(previous?.report)) previous = null;
  // Neither counter nor counterless history may change the active baseline or its pending weight.
  if (previous && sample.sampledAt <= previous.sampledAt) return {network:null,mark:previous};
  const r = sample.report;
  if (!networkReading(r)) {
    const changedEpoch = r.boot_id && previous && r.boot_id !== previous.report.boot_id;
    return {network:null,mark:previous && !changedEpoch ? {...previous,pendingElapsedMs:(previous.pendingElapsedMs || 0)+sample.elapsedMs} : null};
  }
  let network = null;
  if (previous?.report.boot_id === r.boot_id) {
    const rx = trafficCounter(r.net_rx_total), tx = trafficCounter(r.net_tx_total);
    const lastRx = trafficCounter(previous.report.net_rx_total), lastTx = trafficCounter(previous.report.net_tx_total);
    if (rx >= lastRx && tx >= lastTx) {
      const coverageMs = (previous.pendingElapsedMs || 0)+sample.elapsedMs;
      network = {rxBytes:String(rx-lastRx),txBytes:String(tx-lastTx),coverageMs,
        rxMean:Number(rx-lastRx)*1000/coverageMs,txMean:Number(tx-lastTx)*1000/coverageMs};
    }
  }
  return {network,mark:{sampledAt:sample.sampledAt,pendingElapsedMs:0,
    report:{boot_id:r.boot_id,net_rx_total:r.net_rx_total,net_tx_total:r.net_tx_total}}};
}

export function aggregateMinuteSamples(samples, {previous = null} = {}) {
  const fields = {};
  let gpuSnapshot;
  let coverageMs = 0, rxBytes = 0n, txBytes = 0n, networkCoverageMs = 0;
  for (const sample of samples) {
    const duration = sample.coverageMs ?? sample.elapsedMs;
    coverageMs += duration;
    for (const key of RESOURCE_FIELDS) {
      const value = sample.report[key];
      if (!finite(value)) continue;
      const f = fields[key] ||= {count:0,sum:0,weightedSum:0,coverageMs:0,max:null};
      f.count++; f.sum += value; f.weightedSum += value*duration; f.coverageMs += duration;
      f.max = f.max === null ? value : Math.max(f.max,value);
    }
    for(const key of DISK_IO_METRIC_FIELDS) {
      const value=sample.extra?.diskIO?.[key];if(!finite(value))continue;
      const f=fields[DISK_IO_FIELD_TO_COLUMN[key]] ||= {count:0,sum:0,weightedSum:0,coverageMs:0,max:null};
      f.count++;f.sum+=value;f.weightedSum+=value*duration;f.coverageMs+=duration;f.max=f.max===null ? value : Math.max(f.max,value);
    }
    if(Object.hasOwn(sample.extra || {},'gpu') && (!gpuSnapshot || sample.sampledAt>=gpuSnapshot.sampledAt)) {
      gpuSnapshot={sampledAt:sample.sampledAt,value:sample.extra.gpu,source:'last-observed-snapshot',precision:'legacy-GPU-units'};
    }
    const reduced = sample.source === 'standard' && sample.network !== undefined
      ? {network:sample.network,mark:previous} : reduceNetworkMark(previous,sample);
    const network = sample.network !== undefined ? sample.network : reduced.network;
    if (network) {
      rxBytes += BigInt(network.rxBytes); txBytes += BigInt(network.txBytes);
      networkCoverageMs += network.coverageMs;
    }
    previous = reduced.mark;
  }
  for (const f of Object.values(fields)) f.mean = f.coverageMs ? f.weightedSum/f.coverageMs : null;
  return {count:samples.length,coverageMs,fields,...(gpuSnapshot ? {gpuSnapshot} : {}),network:{rxBytes:String(rxBytes),txBytes:String(txBytes),coverageMs:networkCoverageMs,
    rxMean:networkCoverageMs ? Number(rxBytes)*1000/networkCoverageMs : null,txMean:networkCoverageMs ? Number(txBytes)*1000/networkCoverageMs : null}};
}

export function mergeResourceBuckets(buckets) {
  const result = {count:0,coverageMs:0,fields:{},network:{rxBytes:'0',txBytes:'0',coverageMs:0,rxMean:null,txMean:null}};
  for (const bucket of buckets) {
    result.count += bucket.count; result.coverageMs += bucket.coverageMs;
    for (const [key,field] of Object.entries(bucket.fields)) {
      const f = result.fields[key] ||= {count:0,sum:0,weightedSum:0,coverageMs:0,max:null};
      for (const k of ['count','sum','weightedSum','coverageMs']) f[k] += field[k];
      f.max = f.max === null ? field.max : Math.max(f.max,field.max);
    }
    for (const key of ['rxBytes','txBytes']) result.network[key] = String(BigInt(result.network[key])+BigInt(bucket.network[key]));
    result.network.coverageMs += bucket.network.coverageMs;
    if(bucket.gpuSnapshot && (!result.gpuSnapshot || bucket.gpuSnapshot.sampledAt>=result.gpuSnapshot.sampledAt))result.gpuSnapshot=bucket.gpuSnapshot;
  }
  for (const f of Object.values(result.fields)) f.mean = f.coverageMs ? f.weightedSum/f.coverageMs : null;
  for (const key of ['rx','tx']) result.network[key+'Mean'] = result.network.coverageMs ? Number(result.network[key+'Bytes'])*1000/result.network.coverageMs : null;
  return result;
}

export function aggregateProbeSamples(probes) {
  const groups = new Map();
  for (const probe of probes) {
    const key = `${probe.taskId}:${probe.metricId}`;
    const group = groups.get(key) || {taskId:probe.taskId,metricId:probe.metricId,attempts:0,timeouts:0,samples:[],sum:0,max:null};
    const timeout = probe.latencyMs < 0;
    group.attempts++; group.timeouts += Number(timeout); group.samples.push({...probe,timeout});
    if (!timeout) { group.sum += probe.latencyMs; group.max = group.max === null ? probe.latencyMs : Math.max(group.max,probe.latencyMs); }
    groups.set(key,group);
  }
  return [...groups.values()].map(g=>({...g,mean:g.attempts > g.timeouts ? g.sum/(g.attempts-g.timeouts) : null,loss:g.timeouts/g.attempts*100}));
}
