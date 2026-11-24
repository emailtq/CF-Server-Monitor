import { EXTRA_PING_ID_PATTERN } from './extraPing.js';
import { validatePingNode } from './pingNode.js';
import { parseTerminalControl } from './terminalProtocol.js';
import { isReportCredentialKey } from './reportCredentials.js';

export const MONITOR_AGENT_LIMITS = Object.freeze({
  standardBytes: 65536, batchBytes: 524288, reportSamples: 300, sshEvents: 32,
  configBytes: 65536, terminalControlBytes: 4096, terminalDataBytes: 16384, terminalCreditBytes: 262144
});
const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;
const COUNTERS = ['net_rx_total', 'net_tx_total'];
const REPORT_NUMBERS = ['uptime', 'cpu', 'mem_total', 'mem_used', 'swap_total', 'swap_used', 'disk_total', 'disk_used', 'net_rx', 'net_tx', 'tcp', 'udp', 'procs'];
const REPORT_INTEGERS = REPORT_NUMBERS.filter(key => key !== 'cpu');
const TERMINAL_METHODS = ['hello', 'bound', 'open', 'close', 'disable', 'disabled', 'start', 'ready', 'resize', 'credit', 'exit', 'error', 'ping', 'pong'];
const CAPABILITY_NAMES = ['cf.report.batch', 'cf.reporting.configure', 'cf.ping.tasks', 'cf.ssh.events', ...TERMINAL_METHODS.map(type => `cf.terminal.${type}`)];
const REQUEST_ROLES = {
  'cf.capabilities': ['agent', 'hub'], 'cf.report.batch': ['agent', 'hub'],
  'cf.reporting.configure': ['hub', 'agent'], 'cf.ping.tasks': ['hub', 'agent'], 'cf.ssh.events': ['agent', 'hub']
};
const STANDARD_ROLES = { hello: ['agent', 'hub'], report: ['agent', 'hub'], 'ping.result': ['agent', 'hub'], 'ping.tasks': ['hub', 'agent'] };
const TERMINAL_PAIRS = {
  hello: ['agent-control:broker-control'], bound: ['broker-control:agent-control'],
  open: ['broker-control:agent-control'], close: ['broker-control:agent-control'],
  disable: ['broker-control:agent-control'], disabled: ['agent-control:broker-control'],
  start: ['broker:agent'], ready: ['agent:broker', 'broker:browser'],
  resize: ['browser:broker', 'broker:agent'], credit: ['browser:broker', 'agent:broker', 'broker:agent', 'broker:browser'],
  exit: ['agent:broker', 'broker:browser'], error: ['agent:broker', 'broker:browser'],
  ping: ['agent-control:broker-control', 'broker-control:agent-control', 'browser:broker', 'agent:broker', 'broker:agent', 'broker:browser'],
  pong: ['agent-control:broker-control', 'broker-control:agent-control', 'browser:broker', 'agent:broker', 'broker:agent', 'broker:browser']
};
const SAFE_MESSAGES = new Map([
  [-32700, 'Invalid JSON'], [-32600, 'Invalid request'], [-32602, 'Invalid params'], [-32601, 'Method not found'], [-32002, 'Unsupported version']
]);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const wholeNumber = (value, min = 0) => Number.isInteger(value) && value >= min;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const time = value => integer(value, 1, 8640000000000000);
const text = (value, pattern) => typeof value === 'string' && pattern.test(value);
const rpcId = value => integer(value, -Number.MAX_SAFE_INTEGER) || text(value, /^[A-Za-z0-9_.:-]{1,128}$/);
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

export class MonitorAgentProtocolError extends Error {
  constructor(code, id) {
    super(SAFE_MESSAGES.get(code) || 'Invalid request');
    this.name = 'MonitorAgentProtocolError';
    this.code = code;
    if (rpcId(id)) this.id = id;
  }
}
const fail = (code = -32602) => { throw new MonitorAgentProtocolError(code); };
const check = value => { if (!value) fail(); };

export function agentRpcErrorResponse(error) {
  if (!(error instanceof MonitorAgentProtocolError) || !Object.hasOwn(error, 'id')) return null;
  return { jsonrpc: '2.0', id: error.id, error: { code: error.code, message: SAFE_MESSAGES.get(error.code) || 'Invalid request' } };
}

function capabilities(value) {
  check(Array.isArray(value));
  const seen = new Set();
  for (const item of value) {
    check(exact(item, ['method', 'version']) && CAPABILITY_NAMES.includes(item.method) && item.version === 1 && !seen.has(item.method));
    seen.add(item.method);
  }
}

// The caller lists capabilities it actually implements; knowing their schema is not implementation.
export function negotiateMonitorCapabilities(offered, implemented = []) {
  capabilities(offered);
  capabilities(implemented);
  return offered.filter(item => implemented.some(own => own.method === item.method && own.version === item.version))
    .map(({ method, version }) => ({ method, version }));
}

function sensitiveFields(value, allowTicket = false) {
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || typeof entry !== 'object') continue;
    for (const [key, child] of Object.entries(entry)) {
      if (isReportCredentialKey(key) || /^(?:bearer|password|cookie|command|exec|env|path|__proto__|constructor|prototype)$/i.test(key) || /^(?:token_|jwt_|reporting_secret|terminalEnabled|autoUpdate|updateProxy)$/i.test(key) || key === 'ticket' && !allowTicket) fail();
      if (child && typeof child === 'object') pending.push(child);
    }
  }
}

function i64Token(value, source) {
  if (typeof value !== 'number' || typeof source !== 'string' || source === '-0' || !/^-?(?:0|[1-9]\d*)$/.test(source)) return null;
  const n = BigInt(source);
  return n >= I64_MIN && n <= I64_MAX ? n : null;
}

function validateReport(params, tokens, strict = false) {
  check(object(params));
  if (strict) {
    check(exact(params, [], ['boot_id', 'iface', ...REPORT_NUMBERS, ...COUNTERS, 'load']));
    if (Object.hasOwn(params, 'boot_id')) check(typeof params.boot_id === 'string' && params.boot_id.length > 0);
    if (Object.hasOwn(params, 'iface')) check(typeof params.iface === 'string');
  }
  for (const key of REPORT_NUMBERS) if (Object.hasOwn(params, key)) {
    check(number(params[key]) && (!strict || !REPORT_INTEGERS.includes(key) || wholeNumber(params[key])));
  }
  if (Object.hasOwn(params, 'load')) check(Array.isArray(params.load) && params.load.length === 3 && params.load.every(number));
  const counters = [];
  for (const key of COUNTERS) {
    if (!Object.hasOwn(params, key)) { counters.push(null); continue; }
    const source = tokens.get(params)?.get(key);
    // Read the original token, never String(the already-rounded Number).
    check(typeof params[key] === 'number' && typeof source === 'string');
    const count = i64Token(params[key], source);
    check(count !== null ? count >= 0n : Number.isFinite(Number(source)) && Number(source) >= 0);
    if (strict) check(count !== null && count >= 0n);
    params[key] = source;
    counters.push(count);
  }
  return typeof params.boot_id === 'string' && params.boot_id.length > 0 && counters.every(value => value !== null)
    ? { epoch: params.boot_id, rx: counters[0], tx: counters[1] } : null;
}

function validatePingResult(params, tokens) {
  if (!object(params)) return null;
  const task = i64Token(params.task_id, tokens.get(params)?.get('task_id'));
  const latency = i64Token(params.latency_ms, tokens.get(params)?.get('latency_ms'));
  if (task === null || task <= 0n || latency === null) return null;
  for (const key of ['task_id', 'latency_ms']) if (!Number.isSafeInteger(params[key])) params[key] = tokens.get(params).get(key);
  return { taskId: task <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(task) : task,
    latencyMs: latency >= BigInt(Number.MIN_SAFE_INTEGER) && latency <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(latency) : latency };
}

function standardTarget(value) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 260 || /[\x00-\x20\x7f\s/@?#\\]/.test(value)) return false;
  const match = value.startsWith('[') ? value.match(/^\[([^\]]+)\]:(\d{1,5})$/) : value.match(/^([^:]+):(\d{1,5})$/);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 65535;
}

function standardTasks(params, sending, tokens) {
  check(Array.isArray(params));
  if (sending) check(params.length <= 64);
  for (const task of params) {
    if (sending) check(exact(task, ['id', 'target', 'interval']) && integer(task.id, 1) && standardTarget(task.target) && integer(task.interval, 5, 3600));
    else {
      check(object(task) && i64Token(task.id, tokens.get(task)?.get('id')) !== null && typeof task.target === 'string');
      const interval = tokens.get(task)?.get('interval');
      check(typeof interval === 'string' && /^(?:0|[1-9]\d*)$/.test(interval) && BigInt(interval) <= 18446744073709551615n);
      for (const key of ['id', 'interval']) if (!Number.isSafeInteger(task[key])) task[key] = tokens.get(task).get(key);
    }
  }
}

function clock(value) {
  check(exact(value, ['local_ts', 'accurate_ts', 'offset_ms', 'source', 'round_trip_ms', 'sample_age_ms']) && time(value.local_ts));
  check(value.accurate_ts === null || time(value.accurate_ts));
  check(value.offset_ms === null || wholeNumber(value.offset_ms, -Infinity));
  check(value.source === null || value.source === 'date');
  check([value.round_trip_ms, value.sample_age_ms].every(v => v === null || wholeNumber(v)));
}

function extraMetrics(value) {
  check(exact(value, [], ['diskIO', 'gpu']));
  if (value.diskIO !== undefined && value.diskIO !== null) {
    const io = value.diskIO;
    check(exact(io, ['read_bps', 'write_bps', 'read_iops', 'write_iops', 'await_ms', 'util']));
    check(wholeNumber(io.read_bps) && wholeNumber(io.write_bps) && [io.read_iops, io.write_iops, io.await_ms, io.util].every(number) && io.util <= 100);
  }
  if (value.gpu !== undefined && value.gpu !== null) {
    check(Array.isArray(value.gpu));
    for (const gpu of value.gpu) {
      check(exact(gpu, ['name', 'info', 'id'], ['mem_used', 'mem_total', 'sm_clock', 'power']) && typeof gpu.name === 'string' && typeof gpu.id === 'string');
      for (const key of ['info', 'mem_used', 'mem_total', 'sm_clock', 'power']) if (Object.hasOwn(gpu, key)) check(gpu[key] === null || number(gpu[key]));
    }
  }
}

function batch(params, tokens) {
  check(exact(params, ['version', 'stream', 'sequence', 'samples', 'probes', 'clock']) && text(params.stream, /^[A-Za-z0-9_-]{1,128}$/) && integer(params.sequence, 1));
  check(Array.isArray(params.samples) && params.samples.length <= 300 && Array.isArray(params.probes));
  for (const sample of params.samples) {
    check(exact(sample, ['sampledAt', 'elapsedMs', 'report', 'extra']) && time(sample.sampledAt) && wholeNumber(sample.elapsedMs, 1));
    validateReport(sample.report, tokens, true);
    extraMetrics(sample.extra);
  }
  for (const probe of params.probes) check(exact(probe, ['taskId', 'metricId', 'sampledAt', 'latencyMs']) && integer(probe.taskId, 1) && text(probe.metricId, EXTRA_PING_ID_PATTERN) && time(probe.sampledAt) && wholeNumber(probe.latencyMs, -1));
  clock(params.clock);
}

function correction(value) {
  check(exact(value, ['rxGB', 'txGB']));
  for (const key of ['rxGB', 'txGB']) {
    check(text(value[key], /^\d+(?:\.\d+)?$/));
    const [whole, fraction = ''] = value[key].split('.');
    const n = BigInt(whole);
    check(n < 1000000n || n === 1000000n && !/[1-9]/.test(fraction));
  }
}

function reportingConfig(params) {
  check(exact(params, ['version', 'revision', 'persistent'], ['transient', 'trafficCorrection']) && text(params.revision, /^[a-f0-9]{32}$/));
  const p = params.persistent;
  check(exact(p, ['collectIntervalSeconds', 'batchIntervalSeconds', 'activeReportIntervalSeconds', 'resetDay', 'interface', 'connectionMode', 'sshLoginEnabled', 'userAgent']));
  check([0, 1, 2, 5, 10].includes(p.collectIntervalSeconds) && [30, 60, 120, 180].includes(p.batchIntervalSeconds) && integer(p.activeReportIntervalSeconds, 1, 5) && integer(p.resetDay, 0, 31));
  check(typeof p.interface === 'string' && p.interface.length <= 255 && /^[A-Za-z0-9_.:,\-*?\[\]]*$/.test(p.interface) && p.interface.split(',').every(item => item.length <= 64));
  check(['auto', 'http'].includes(p.connectionMode) && typeof p.sshLoginEnabled === 'boolean' && typeof p.userAgent === 'string' && p.userAgent.length <= 100 && /^[A-Za-z0-9 _.\-/,:;()+=@#*?~]+$/.test(p.userAgent));
  if (params.transient !== undefined) {
    const t = params.transient;
    check(exact(t, [], ['active', 'reportAfterMs', 'idleBatchIntervalSeconds', 'expiresAt']));
    if (t.active !== undefined) check(typeof t.active === 'boolean');
    if (t.reportAfterMs !== undefined) check(wholeNumber(t.reportAfterMs, 1000));
    if (t.idleBatchIntervalSeconds !== undefined) check(wholeNumber(t.idleBatchIntervalSeconds, 60));
    if (t.expiresAt !== undefined) check(time(t.expiresAt));
  }
  if (params.trafficCorrection !== undefined) correction(params.trafficCorrection);
}

function cfTasks(params) {
  check(exact(params, ['version', 'revision', 'tasks']) && integer(params.revision, 1) && Array.isArray(params.tasks));
  for (const task of params.tasks) {
    check(exact(task, ['taskId', 'metricId', 'target', 'intervalSeconds', 'mode']) && integer(task.taskId, 1) && text(task.metricId, EXTRA_PING_ID_PATTERN) && typeof task.target === 'string' && !!task.target.trim() && validatePingNode(task.target).valid && integer(task.intervalSeconds, 5, 3600) && ['tcp', 'icmp'].includes(task.mode));
  }
}

function ssh(params) {
  check(exact(params, ['version', 'stream', 'events', 'state', 'source']) && text(params.stream, /^[A-Za-z0-9._:-]{1,64}$/) && Array.isArray(params.events) && params.events.length <= 32);
  check(['disabled', 'watching', 'unsupported', 'unavailable', 'permission_denied', 'state_error', 'queue_full', 'rotation_gap'].includes(params.state) && ['', 'auth.log', 'secure', 'journal'].includes(params.source));
  let previous = 0;
  for (const event of params.events) {
    check(exact(event, ['sequence', 'occurredAt', 'user', 'address', 'method']) && integer(event.sequence, previous + 1) && time(event.occurredAt) && text(event.user, /^[^\x00-\x20\x7f]{1,64}$/u) && ['password', 'publickey', 'keyboard-interactive/pam', 'hostbased', 'gssapi-with-mic'].includes(event.method));
    check(text(event.address, /^[0-9a-fA-F:.]{1,64}(?:%[A-Za-z0-9_.:-]{1,32})?$/));
    const address = event.address.split('%')[0];
    if (address.includes(':')) { try { new URL(`http://[${address}]/`); } catch { fail(); } }
    else check(!event.address.includes('%') && address.split('.').length === 4 && address.split('.').every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255));
    previous = event.sequence;
  }
}

function validateVersion(value) {
  check(object(value) && integer(value.version));
  if (value.version !== 1) fail(-32002);
}

function cfParams(method, params, tokens) {
  validateVersion(params);
  switch (method) {
    case 'cf.capabilities': check(exact(params, ['version', 'supports'])); capabilities(params.supports); break;
    case 'cf.report.batch': batch(params, tokens); break;
    case 'cf.reporting.configure': reportingConfig(params); break;
    case 'cf.ping.tasks': cfTasks(params); break;
    case 'cf.ssh.events': ssh(params); break;
  }
}

function cfResult(method, result, context) {
  validateVersion(result);
  switch (method) {
    case 'cf.capabilities': {
      check(exact(result, ['version', 'accepted', 'limits', 'fallbackPath']));
      capabilities(result.accepted);
      const supported = negotiateMonitorCapabilities(result.accepted, context.implemented || []);
      check(supported.length === result.accepted.length);
      const limits = { reportBatchBytes: 524288, reportSamples: 300, sshEvents: 32, configBytes: 65536, terminalControlBytes: 4096, terminalDataBytes: 16384, terminalCreditBytes: 262144 };
      check(exact(result.limits, Object.keys(limits)) && Object.entries(limits).every(([key, value]) => result.limits[key] === value));
      check(result.fallbackPath === null || result.fallbackPath === '/api/agent/cf-report');
      check(result.fallbackPath === null || result.accepted.some(item => item.method === 'cf.report.batch'));
      break;
    }
    case 'cf.report.batch':
      check(exact(result, ['version', 'stream', 'accepted', 'durableThrough']) && text(result.stream, /^[A-Za-z0-9_-]{1,128}$/) && exact(result.accepted, ['from', 'to']) && integer(result.accepted.from, 1) && result.accepted.from === result.accepted.to && integer(result.durableThrough, result.accepted.to));
      break;
    case 'cf.reporting.configure':
      check(exact(result, ['version', 'revision', 'persisted', 'correctionApplied']) && text(result.revision, /^[a-f0-9]{32}$/) && typeof result.persisted === 'boolean' && typeof result.correctionApplied === 'boolean');
      break;
    case 'cf.ping.tasks':
      check(exact(result, ['version', 'revision', 'persisted', 'taskCount']) && integer(result.revision, 1) && typeof result.persisted === 'boolean' && integer(result.taskCount));
      break;
    case 'cf.ssh.events':
      check(exact(result, ['version', 'stream', 'sequence']) && text(result.stream, /^[A-Za-z0-9._:-]{1,64}$/) && integer(result.sequence));
      break;
  }
}

function assertRoute(method, context, response = false) {
  const { senderRole = 'agent', receiverRole = 'hub', channel = 'monitor' } = context;
  if (method.startsWith('cf.terminal.')) {
    const type = method.slice(12), pair = `${senderRole}:${receiverRole}`;
    const control = senderRole.endsWith('control') && receiverRole.endsWith('control');
    if (!TERMINAL_PAIRS[type]?.includes(pair) || channel !== (control ? 'terminal-control' : 'terminal-session')) fail(-32600);
    if (!['hello', 'bound'].includes(type) && (context.terminalNegotiated !== true || !context.terminalCapabilities?.includes('terminal.pty.v1'))) fail(-32601);
    if (['disable', 'disabled'].includes(type) && !context.terminalCapabilities?.includes('terminal.disable.v1')) fail(-32601);
    return;
  }
  const pair = STANDARD_ROLES[method] || REQUEST_ROLES[method];
  if (channel !== 'monitor' || !pair || senderRole !== pair[response ? 1 : 0] || receiverRole !== pair[response ? 0 : 1]) fail(-32600);
}

function isImplementedAndNegotiated(method, context) {
  const matches = list => Array.isArray(list) && list.some(item => item.method === method && item.version === 1);
  return matches(context.implemented) && matches(context.negotiated);
}

function assertImplemented(method, context) {
  if (!REQUEST_ROLES[method] || method === 'cf.capabilities') return;
  if (!isImplementedAndNegotiated(method, context)) fail(-32601);
}

/** Trusted context comes from the authenticated route/socket, never from params. */
export function parseAgentRpc(raw, context = {}) {
  if (typeof raw !== 'string' || raw.length > MONITOR_AGENT_LIMITS.batchBytes || new TextEncoder().encode(raw).length > MONITOR_AGENT_LIMITS.batchBytes) fail(-32600);
  const tokens = new WeakMap();
  let frame;
  try {
    frame = JSON.parse(raw, function (key, value, source) {
      if (typeof value === 'number') {
        if (!tokens.has(this)) tokens.set(this, new Map());
        tokens.get(this).set(key, source?.source);
      }
      return value;
    });
  } catch { fail(-32700); }
  if (!object(frame) || frame.jsonrpc !== '2.0') fail(-32600);
  const hasId = Object.hasOwn(frame, 'id');
  if (hasId && (!rpcId(frame.id) || typeof frame.id === 'number' && !/^-?(?:0|[1-9]\d*)$/.test(tokens.get(frame)?.get('id') || ''))) fail(-32600);
  const response = !Object.hasOwn(frame, 'method');
  const method = response ? context.expectedResponse?.method : frame.method;
  if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(method)) fail(-32600);
  const terminal = method.startsWith('cf.terminal.');
  const known = Object.hasOwn(STANDARD_ROLES, method) || Object.hasOwn(REQUEST_ROLES, method) || terminal && TERMINAL_METHODS.includes(method.slice(12));
  const maxBytes = terminal && known ? 4096 : method === 'cf.report.batch' && !response && isImplementedAndNegotiated(method, context) ? 524288 : 65536;
  if (new TextEncoder().encode(raw).length > maxBytes) fail(-32600);
  if (response) {
    if (!hasId || !context.expectedResponse || frame.id !== context.expectedResponse.id || !Object.hasOwn(REQUEST_ROLES, method) || !exact(frame, ['jsonrpc', 'id'], ['result', 'error']) || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) fail(-32600);
  } else if (!exact(frame, ['jsonrpc', 'method'], ['params', 'id']) || known && hasId !== Object.hasOwn(REQUEST_ROLES, method)) fail(-32600);
  try {
    if (!known) {
      if ((context.channel || 'monitor') !== 'monitor' || !['agent', 'hub'].includes(context.senderRole || 'agent') || !['agent', 'hub'].includes(context.receiverRole || 'hub')) fail(-32600);
      if (hasId) fail(-32601);
      return { kind: 'notification', method, known: false };
    }
    assertRoute(method, context, response);
    sensitiveFields(response ? frame.result || frame.error : frame.params, method === 'cf.terminal.open');
    if (response) {
      if (Object.hasOwn(frame, 'result')) cfResult(method, frame.result, context);
      else check(exact(frame.error, ['code', 'message']) && integer(frame.error.code, -32768, -32000) && typeof frame.error.message === 'string' && frame.error.message.length <= 128 && !/[\x00-\x1f\x7f]/.test(frame.error.message));
      assertImplemented(method, context);
      return { kind: 'response', method, known: true, id: frame.id, ...(Object.hasOwn(frame, 'result') ? { result: frame.result } : { error: frame.error }) };
    }
    const rpc = { kind: hasId ? 'request' : 'notification', method, known: true, params: frame.params === undefined ? null : frame.params };
    if (hasId) rpc.id = frame.id;
    switch (method) {
      case 'hello':
        rpc.factCores = object(rpc.params) ? i64Token(rpc.params.cpu_cores, tokens.get(rpc.params)?.get('cpu_cores')) : null;
        break;
      case 'report': rpc.trafficReading = validateReport(rpc.params, tokens); break;
      case 'ping.result': rpc.probeResult = validatePingResult(rpc.params, tokens); break;
      case 'ping.tasks': standardTasks(rpc.params, context.sending === true, tokens); break;
      default:
        if (terminal) {
          validateVersion(rpc.params);
          check(!Object.hasOwn(rpc.params, 'type'));
          const { version, ...params } = rpc.params;
          const type = method.slice(12) === 'credit' ? 'ack' : method.slice(12);
          try { parseTerminalControl(JSON.stringify({ ...params, type }), context.senderRole); } catch { fail(); }
        } else cfParams(method, rpc.params, tokens);
        assertImplemented(method, context);
    }
    return rpc;
  } catch (error) {
    if (!(error instanceof MonitorAgentProtocolError)) error = new MonitorAgentProtocolError(-32602);
    if (hasId && !response && !terminal) error.id = frame.id;
    throw error;
  }
}

/** Accepts a parsed RPC or an outbound envelope; parsed counters stay JSON numbers on the wire. */
export function serializeAgentRpc(rpc, context = {}) {
  const frame = { jsonrpc: '2.0' };
  if (rpc.kind === 'response' || !rpc.method) {
    frame.id = rpc.id;
    if (Object.hasOwn(rpc, 'error')) frame.error = rpc.error;
    else frame.result = rpc.result;
  } else {
    frame.method = rpc.method;
    frame.params = rpc.params;
    if (Object.hasOwn(rpc, 'id')) frame.id = rpc.id;
  }
  let raw;
  try {
    raw = JSON.stringify(frame, function (key, value) {
      const numericToken = COUNTERS.includes(key) || ['task_id', 'latency_ms', 'interval'].includes(key) || key === 'id' && Object.hasOwn(this, 'target');
      if (numericToken && (typeof value === 'string' || typeof value === 'bigint')) return JSON.rawJSON(String(value));
      return value;
    });
  } catch { fail(); }
  parseAgentRpc(raw, { ...context, sending: true });
  return raw;
}
