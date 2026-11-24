import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const protocol = await import('../src/shared/monitorAgentProtocol.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const invoke = (name, ...args) => {
  assert.equal(typeof protocol[name], 'function', `${name} must be implemented`);
  return protocol[name](...args);
};
const parse = (raw, context) => invoke('parseAgentRpc', raw, context);
const encode = (rpc, context) => invoke('serializeAgentRpc', rpc, context);
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/monitor-protocol/${name}.json`, import.meta.url), 'utf8'));
const standard = fixture('standard');
const extensions = fixture('extensions');
const permissions = fixture('permissions');
const allCapabilities = extensions.negotiation.capabilityNames.map(method => ({ method, version: 1 }));
function context(method) {
  const privateChannel = method.name.startsWith('cf.terminal.');
  const senderRole = method.senderRoles[0], receiverRole = method.receiverRoles[0];
  return {
    senderRole, receiverRole,
    channel: privateChannel ? senderRole.endsWith('control') ? 'terminal-control' : 'terminal-session' : 'monitor',
    implemented: allCapabilities, negotiated: allCapabilities,
    terminalNegotiated: true, terminalCapabilities: ['terminal.pty.v1', 'terminal.disable.v1']
  };
}
const notification = (method, params) => JSON.stringify({ jsonrpc: '2.0', method, params });
const report = (rx, tx = '0', boot = '"boot-a"') => `{"jsonrpc":"2.0","method":"report","params":{"boot_id":${boot},"net_rx_total":${rx},"net_tx_total":${tx}}}`;
function rejects(raw, code = -32602, ctx) {
  assert.throws(() => parse(raw, ctx), error => {
    assert.equal(error.code, code);
    assert.ok(!String(error).includes('do-not-echo-secret'));
    return true;
  });
}

test('fixed standard raw notifications retain shape and require no ACK', () => {
  for (const method of standard.methods) for (const example of method.examples) {
    if (!example.valid) continue;
    const rpc = parse(example.raw, context(method));
    assert.equal(rpc.kind, 'notification');
    assert.equal(rpc.method, method.name);
    assert.equal(Object.hasOwn(rpc, 'id'), false);
    assert.equal(invoke('agentRpcErrorResponse', { code: -32602 }), null);
    if (method.name === 'ping.tasks') assert.ok(Array.isArray(rpc.params));
  }
});

test('raw counter 0, above-safe and i64MAX survive parse, reading and numeric serialization', () => {
  for (const token of ['0', '9007199254740993', '9223372036854775807']) {
    const raw = report(token);
    const rpc = parse(raw);
    assert.equal(rpc.params.net_rx_total, token);
    assert.equal(rpc.params.net_tx_total, '0');
    assert.equal(rpc.trafficReading.rx, BigInt(token));
    assert.equal(rpc.trafficReading.tx, 0n);
    assert.equal(rpc.trafficReading.epoch, 'boot-a');
    assert.equal(encode(rpc), raw);
    assert.equal(parse(encode(rpc)).params.net_rx_total, token);
  }
});

test('accepted fractional and out-of-i64 counters preserve original token but cannot change traffic baseline', () => {
  for (const token of ['1.5', '1.0', '1e0', '9223372036854775808', '18446744073709551615']) {
    const rpc = parse(report(token));
    assert.equal(rpc.params.net_rx_total, token);
    assert.equal(rpc.trafficReading, null);
    assert.equal(encode(rpc), report(token));
  }
  for (const boot of ['null', '0', '""']) assert.equal(parse(report('1', '0', boot)).trafficReading, null);
  for (const params of [{}, { boot_id: 'b', net_rx_total: 1 }, { cpu: 1.5, uptime: 0.5, tcp: 2.5 }]) {
    assert.equal(parse(notification('report', params)).trafficReading, null);
  }
});

test('report rejects present null, string, negative, infinite and malformed load without leaking fields', () => {
  for (const token of ['null', '"9007199254740993"', '-1', '1e400']) rejects(report(token));
  for (const field of ['uptime', 'cpu', 'mem_total', 'mem_used', 'swap_total', 'swap_used', 'disk_total', 'disk_used', 'net_rx', 'net_tx', 'tcp', 'udp', 'procs']) {
    for (const value of [null, '1', -1]) rejects(notification('report', { [field]: value }));
  }
  for (const load of [null, [1, 2], [1, 2, 3, 4], [1, null, 3], [1, -1, 3]]) rejects(notification('report', { load }));
  rejects(notification('report', []));
});

test('hello keeps actual upstream receive tolerance, independent of normal emitter schema', () => {
  for (const params of [null, 1, [], {}, { hostname: null, cpu_cores: '2', mem_total: null }, { os: 'x\n' }]) {
    assert.equal(parse(notification('hello', params)).kind, 'notification');
  }
  assert.equal(parse('{"jsonrpc":"2.0","method":"hello"}').params, null);
});

test('ping results have real positive numeric IDs, any negative integer loss, and no invented missing sample', () => {
  for (const latency of [42, 0, -1, -20]) {
    const rpc = parse(notification('ping.result', { task_id: 123, latency_ms: latency }));
    assert.deepEqual(rpc.probeResult, { taskId: 123, latencyMs: latency });
  }
  for (const params of [null, {}, { task_id: 1 }, { task_id: 1, latency_ms: null }, { task_id: '1', latency_ms: 0 }, { task_id: 0, latency_ms: 0 }, { task_id: 1, latency_ms: 0.5 }]) {
    assert.equal(parse(notification('ping.result', params)).probeResult, null);
  }
});

test('standard task output enforces entire-array TCP 64/interval limits without truncating', () => {
  const ctx = { senderRole: 'hub', receiverRole: 'agent' };
  const tasks = Array.from({ length: 64 }, (_, i) => ({ id: i + 1, target: 'example.com:443', interval: 60 }));
  assert.equal(JSON.parse(encode({ method: 'ping.tasks', params: tasks }, ctx)).params.length, 64);
  assert.throws(() => encode({ method: 'ping.tasks', params: [...tasks, { id: 65, target: 'example.com:443', interval: 60 }] }, ctx));
  for (const interval of [4, 3601]) assert.throws(() => encode({ method: 'ping.tasks', params: [{ id: 1, target: 'example.com:443', interval }] }, ctx));
  assert.throws(() => encode({ method: 'ping.tasks', params: { tasks: [] } }, ctx));
  assert.throws(() => encode({ method: 'ping.tasks', params: [{ id: 1, target: 'example.com', interval: 60 }] }, ctx));
});

test('UTF8 limit counts complete envelope bytes, including multibyte characters', () => {
  const base = notification('hello', { hostname: '' });
  const raw = notification('hello', { hostname: '测'.repeat(21000) });
  assert.ok(new TextEncoder().encode(raw).length < 65536);
  assert.equal(parse(raw).method, 'hello');
  const exact = notification('hello', { hostname: 'x'.repeat(65536 - base.length) });
  assert.equal(parse(exact).method, 'hello');
  rejects(exact + ' ', -32600);
  rejects(notification('hello', { hostname: '测'.repeat(22000) }), -32600);
  rejects(new Uint8Array([1]), -32600);
});

test('malformed envelopes and unsafe IDs are rejected before dispatch', () => {
  rejects('{bad do-not-echo-secret', -32700);
  for (const value of [null, [], 1, {}, { jsonrpc: '1.0', method: 'hello' }, { jsonrpc: '2.0', method: 1 }, { jsonrpc: '2.0', method: 'hello', result: {} }, { jsonrpc: '2.0', method: 'hello', extra: 'do-not-echo-secret' }]) rejects(JSON.stringify(value), -32600);
  for (const id of [null, true, {}, [], '', 'a\n', 'x'.repeat(129), 0.5, 9007199254740992]) {
    rejects(JSON.stringify({ jsonrpc: '2.0', method: 'cf.capabilities', params: { version: 1, supports: [] }, id }), -32600);
  }
  for (const id of [0, -1, 9007199254740991, 'req-1']) {
    assert.equal(parse(JSON.stringify({ jsonrpc: '2.0', method: 'cf.capabilities', params: { version: 1, supports: [] }, id })).id, id);
  }
  rejects('{"jsonrpc":"2.0","method":"hello","id":1}', -32600);
});

test('unknown notifications discard payload; unknown requests get safe -32601 only', () => {
  const rpc = parse(notification('future.method', { token: 'do-not-echo-secret' }));
  assert.equal(rpc.known, false);
  assert.equal(Object.hasOwn(rpc, 'params'), false);
  try { parse('{"jsonrpc":"2.0","method":"future.method","id":"r1","params":{"token":"do-not-echo-secret"}}'); assert.fail(); }
  catch (error) {
    assert.equal(error.code, -32601);
    const response = invoke('agentRpcErrorResponse', error);
    assert.deepEqual(response, { jsonrpc: '2.0', id: 'r1', error: { code: -32601, message: 'Method not found' } });
  }
});

test('trusted roles and channels prevent monitor agents invoking private/public/admin actions', () => {
  for (const method of [...standard.methods, ...extensions.methods]) {
    const example = method.examples.find(example => example.valid);
    rejects(example.raw, -32600, { ...context(method), senderRole: 'public' });
    rejects(example.raw, -32600, { ...context(method), receiverRole: 'admin' });
    if (method.name.startsWith('cf.terminal.')) rejects(example.raw, -32600, { ...context(method), channel: 'monitor' });
  }
  assert.equal(permissions.capabilityIsPermission, false);
  rejects(notification('report', { token: 'do-not-echo-secret' }));
  rejects(notification('hello', { nested: { authorization: 'do-not-echo-secret' } }));
});

test('frozen CF method fixtures enforce explicit fields/version, exact negotiation and no default implementation advertisement', () => {
  for (const method of extensions.methods) for (const example of method.examples) {
    if (example.valid) assert.equal(parse(example.raw, context(method)).method, method.name);
    else rejects(example.raw, example.note === 'unsupported version' ? -32002 : -32602, context(method));
  }
  const batch = extensions.methods.find(method => method.name === 'cf.report.batch').examples[0].raw;
  rejects(batch, -32601);
  rejects(batch, -32601, { implemented: allCapabilities, negotiated: [] });
  assert.deepEqual(invoke('negotiateMonitorCapabilities', allCapabilities), []);
  assert.deepEqual(invoke('negotiateMonitorCapabilities', allCapabilities, [{ method: 'cf.ping.tasks', version: 1 }]), [{ method: 'cf.ping.tasks', version: 1 }]);
  for (const supports of [[{ method: 'cf.*', version: 1 }], [{ method: 'cf.report.batch', version: 2 }], [{ method: 'cf.ping.tasks', version: 1 }, { method: 'cf.ping.tasks', version: 1 }]]) {
    rejects(JSON.stringify({ jsonrpc: '2.0', method: 'cf.capabilities', id: 1, params: { version: 1, supports } }));
  }
});

test('CF batch enforces sample count, strict i64, extra metrics and safe configuration independently of standard traffic tolerance', () => {
  const method = extensions.methods.find(method => method.name === 'cf.report.batch');
  const frame = JSON.parse(method.examples[0].raw);
  frame.params.samples = Array.from({ length: 301 }, () => frame.params.samples[0]);
  rejects(JSON.stringify(frame), -32602, context(method));
  for (const token of ['1.5', '9223372036854775808', '"1"']) rejects(method.examples[0].raw.replace('9007199254740993', token), -32602, context(method));
  const tasksMethod = extensions.methods.find(method => method.name === 'cf.ping.tasks');
  const tasks = Array.from({ length: 65 }, (_, i) => ({ taskId: i + 1, metricId: `p_${i}`, target: 'example.com', intervalSeconds: 60, mode: 'icmp' }));
  const raw = encode({ method: 'cf.ping.tasks', id: 1, params: { version: 1, revision: 1, tasks } }, context(tasksMethod));
  assert.equal(JSON.parse(raw).params.tasks.length, 65);
  const config = extensions.methods.find(method => method.name === 'cf.reporting.configure');
  const value = JSON.parse(config.examples[0].raw);
  value.params.trafficCorrection = { rxGB: '1000000.000000000000000001', txGB: '0' };
  rejects(JSON.stringify(value), -32602, context(config));
  value.params.trafficCorrection.rxGB = '1000000';
  assert.equal(parse(JSON.stringify(value), context(config)).method, config.name);
});

test('responses require pending request id/method and reverse roles, validate result/error without authority from payload', () => {
  const ctx = { senderRole: 'agent', receiverRole: 'hub', expectedResponse: { id: 7, method: 'cf.ping.tasks' }, implemented: allCapabilities, negotiated: allCapabilities };
  const result = { version: 1, revision: 1, persisted: true, taskCount: 65 };
  assert.equal(parse(JSON.stringify({ jsonrpc: '2.0', id: 7, result }), ctx).kind, 'response');
  for (const value of [{ jsonrpc: '2.0', id: 8, result }, { jsonrpc: '2.0', id: 7, result, error: {} }, { jsonrpc: '2.0', id: 7, result: { ...result, token: 'do-not-echo-secret' } }]) rejects(JSON.stringify(value), value.id === 8 || value.error ? -32600 : -32602, ctx);
  rejects(JSON.stringify({ jsonrpc: '2.0', id: 7, result }), -32600);
  rejects(JSON.stringify({ jsonrpc: '2.0', id: 7, result }), -32600, { ...ctx, senderRole: 'hub', receiverRole: 'agent' });
  assert.deepEqual(parse('{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}', ctx).error, { code: -32601, message: 'Method not found' });
  rejects('{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"do-not-echo-secret","data":{}}}', -32602, ctx);
});

test('private terminal params cannot override legacy type and require the actual negotiated PTY/disable groups', () => {
  const method = extensions.methods.find(method => method.name === 'cf.terminal.ready');
  const frame = JSON.parse(method.examples[0].raw);
  frame.params.type = 'ready';
  rejects(JSON.stringify(frame), -32602, context(method));
  rejects(method.examples[0].raw, -32601, { ...context(method), terminalCapabilities: [] });
  rejects(method.examples[0].raw, -32601, { ...context(method), terminalNegotiated: false });
  for (const name of ['cf.terminal.hello', 'cf.terminal.bound']) {
    const bootstrap = extensions.methods.find(method => method.name === name);
    assert.equal(parse(bootstrap.examples[0].raw, { ...context(bootstrap), negotiated: [], implemented: [], terminalNegotiated: false }).method, name);
  }
  const disable = extensions.methods.find(method => method.name === 'cf.terminal.disabled');
  rejects(disable.examples[0].raw, -32601, { ...context(disable), terminalCapabilities: ['terminal.pty.v1'] });
  rejects(method.examples[0].raw, -32600, { ...context(method), senderRole: 'agent', receiverRole: 'browser' });
});

test('full i64 standard probe IDs and latencies retain numeric wire tokens on reserialization', () => {
  const raw = '{"jsonrpc":"2.0","method":"ping.result","params":{"task_id":9223372036854775807,"latency_ms":-9223372036854775808}}';
  const rpc = parse(raw);
  assert.equal(rpc.probeResult.taskId, 9223372036854775807n);
  assert.equal(rpc.probeResult.latencyMs, -9223372036854775808n);
  assert.equal(encode(rpc), raw);
  assert.equal(parse(report('-0')).trafficReading, null);
});

test('all fixed CF result examples validate only in paired reverse-role request contexts', () => {
  for (const method of extensions.methods.filter(method => method.resultExamples)) {
    const request = JSON.parse(method.examples[0].raw);
    const ctx = { ...context(method), senderRole: method.receiverRoles[0], receiverRole: method.senderRoles[0], expectedResponse: { id: request.id, method: method.name } };
    for (const raw of method.resultExamples) assert.equal(parse(raw, ctx).kind, 'response');
  }
  rejects(notification('report', { password: 'do-not-echo-secret' }));
  rejects(notification('hello', { ticket: 'do-not-echo-secret' }));
});

test('CF full-envelope 512KiB and private 4KiB limits are independent of standard 64KiB', () => {
  const method = extensions.methods.find(method => method.name === 'cf.report.batch');
  const frame = JSON.parse(method.examples[0].raw);
  frame.params.samples = [{ sampledAt: 1, elapsedMs: 1, report: {}, extra: { gpu: [{ name: '', info: null, id: '' }] } }];
  const base = JSON.stringify(frame);
  frame.params.samples[0].extra.gpu[0].name = 'x'.repeat(524288 - base.length);
  assert.equal(parse(JSON.stringify(frame), context(method)).method, method.name);
  rejects(JSON.stringify(frame), -32600);
  rejects(JSON.stringify(frame) + ' ', -32600, context(method));
  const terminal = extensions.methods.find(method => method.name === 'cf.terminal.ready');
  rejects(terminal.examples[0].raw + ' '.repeat(4096), -32600, context(terminal));
});

test('the bundled codec itself preserves counters inside the actual Workers runtime', async t => {
  const bundled = await build({
    stdin: { contents: `
      import { parseAgentRpc, serializeAgentRpc } from './src/shared/monitorAgentProtocol.js';
      export default { async fetch(request) {
        const rpc = parseAgentRpc(await request.text());
        return new Response(serializeAgentRpc(rpc), { headers: { 'x-reading-rx': rpc.trafficReading?.rx.toString() || 'none' } });
      } };`, resolveDir: process.cwd(), sourcefile: 'S1-codec-runtime.js' },
    bundle: true, format: 'esm', platform: 'browser', write: false
  });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2024-12-01' });
  t.after(() => mf.dispose());
  for (const token of ['0', '9007199254740993', '9223372036854775807', '9223372036854775808', '1.5']) {
    const response = await mf.dispatchFetch('https://codec.test', { method: 'POST', body: report(token) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), report(token));
    assert.equal(response.headers.get('x-reading-rx'), token === '9223372036854775808' || token === '1.5' ? 'none' : token);
  }
});

test('blank/control task targets cannot enter either outgoing task protocol', () => {
  assert.throws(() => encode({ method: 'ping.tasks', params: [{ id: 1, target: 'example\u0000.com:443', interval: 60 }] }, { senderRole: 'hub', receiverRole: 'agent' }));
  const method = extensions.methods.find(method => method.name === 'cf.ping.tasks');
  const frame = JSON.parse(method.examples[0].raw);
  frame.params.tasks[0].target = ' ';
  rejects(JSON.stringify(frame), -32602, context(method));
});

test('CF sample/SSH counts are inclusive and malformed nested extras and oversized SSH batches fail', () => {
  const method = extensions.methods.find(method => method.name === 'cf.report.batch');
  const frame = JSON.parse(method.examples[0].raw);
  frame.params.samples = Array.from({ length: 300 }, () => ({ sampledAt: 1, elapsedMs: 1, report: {}, extra: {} }));
  assert.equal(parse(JSON.stringify(frame), context(method)).params.samples.length, 300);
  frame.params.samples[0].extra = { diskIO: { read_bps: 0 } };
  rejects(JSON.stringify(frame), -32602, context(method));
  frame.params.samples[0].extra = { gpu: [{ name: 'GPU', id: '0', info: null, power: -1 }] };
  rejects(JSON.stringify(frame), -32602, context(method));
  const ssh = extensions.methods.find(method => method.name === 'cf.ssh.events');
  const events = JSON.parse(ssh.examples[0].raw);
  const event = events.params.events[0];
  events.params.events = Array.from({ length: 32 }, (_, i) => ({ ...event, sequence: i + 1 }));
  assert.equal(parse(JSON.stringify(events), context(ssh)).params.events.length, 32);
  events.params.events.push({ ...event, sequence: 33 });
  rejects(JSON.stringify(events), -32602, context(ssh));
});

test('capability response cannot advertise an unimplemented method or fallback without accepted durable batch', () => {
  const method = extensions.methods.find(method => method.name === 'cf.capabilities');
  const response = JSON.parse(method.resultExamples[0]);
  const ctx = { senderRole: 'hub', receiverRole: 'agent', expectedResponse: { id: response.id, method: method.name } };
  rejects(JSON.stringify(response), -32602, ctx);
  response.result.accepted = [];
  rejects(JSON.stringify(response), -32602, ctx);
  response.result.fallbackPath = null;
  assert.equal(parse(JSON.stringify(response), ctx).kind, 'response');
});

test('CF resource integer fields do not inherit the identifier-only MAX_SAFE_INTEGER bound', () => {
  const method = extensions.methods.find(method => method.name === 'cf.report.batch');
  const frame = JSON.parse(method.examples[0].raw);
  frame.params.samples[0].report = { mem_total: 9007199254740992 };
  frame.params.samples[0].extra = { diskIO: { read_bps: 9007199254740992, write_bps: 0, read_iops: 0, write_iops: 0, await_ms: 0, util: 0 } };
  assert.equal(parse(JSON.stringify(frame), context(method)).params.samples[0].report.mem_total, 9007199254740992);
  frame.params.samples[0].elapsedMs = 9007199254740992;
  frame.params.probes[0].latencyMs = 9007199254740992;
  frame.params.clock.offset_ms = -9007199254740992;
  frame.params.clock.round_trip_ms = 9007199254740992;
  assert.equal(parse(JSON.stringify(frame), context(method)).params.probes[0].latencyMs, 9007199254740992);
  const config = extensions.methods.find(method => method.name === 'cf.reporting.configure');
  const configure = JSON.parse(config.examples[0].raw);
  configure.params.transient.reportAfterMs = 9007199254740992;
  configure.params.transient.idleBatchIntervalSeconds = 9007199254740992;
  assert.equal(parse(JSON.stringify(configure), context(config)).params.transient.reportAfterMs, 9007199254740992);
});

const credentialAliases = ['secret', 'token', 'node_token', 'nodeToken', 'nodetoken',
  'terminal_token', 'terminalToken', 'terminaltoken', 'api_secret', 'apiSecret', 'apisecret',
  'authorization', 'auth_token', 'authToken', 'authtoken', 'ws_token', 'wsToken', 'wstoken'];

test('all nodeAuth credential aliases are rejected at any known notification depth without payload in errors', () => {
  for (const alias of credentialAliases.flatMap(key => [key, key.toUpperCase()])) {
    for (const params of [{ [alias]: 'do-not-echo-secret' }, { facts: [{ collector: { [alias]: 'do-not-echo-secret' } }] }]) {
      for (const method of ['hello', 'report', 'ping.result']) {
        assert.throws(() => parse(notification(method, params)), error => {
          assert.equal(error.code, -32602, `${method} must reject ${alias}`);
          assert.equal(invoke('agentRpcErrorResponse', error), null);
          assert.equal(String(error).includes('do-not-echo-secret'), false);
          assert.equal(JSON.stringify(error).includes('do-not-echo-secret'), false);
          assert.ok(!Object.hasOwn(error, 'params') && !Object.hasOwn(error, 'payload') && !Object.hasOwn(error, 'raw'));
          return true;
        }, `${method} must reject credential alias ${alias}`);
      }
    }
  }
});

test('credential aliases in unknown notifications are discarded without reply, unknown requests stay safe -32601', () => {
  for (const alias of credentialAliases) {
    const params = { nested: [{ [alias]: 'do-not-echo-secret' }] };
    const rpc = parse(notification('future.method', params));
    assert.deepEqual(rpc, { kind: 'notification', method: 'future.method', known: false });
    assert.equal(JSON.stringify(rpc).includes('do-not-echo-secret'), false);
    assert.equal(invoke('agentRpcErrorResponse', rpc), null);
    assert.throws(() => parse(JSON.stringify({ jsonrpc: '2.0', method: 'future.method', params, id: 'alias-request' })), error => {
      assert.deepEqual(invoke('agentRpcErrorResponse', error), { jsonrpc: '2.0', id: 'alias-request', error: { code: -32601, message: 'Method not found' } });
      assert.equal(JSON.stringify(error).includes('do-not-echo-secret'), false);
      return true;
    });
  }
});

test('exact credential keys preserve private ticket exception and harmless version/status metadata', () => {
  const open = extensions.methods.find(method => method.name === 'cf.terminal.open');
  assert.equal(parse(open.examples[0].raw, context(open)).params.ticket, 'a'.repeat(64));
  const bound = extensions.methods.find(method => method.name === 'cf.terminal.bound');
  assert.equal(parse(bound.examples[0].raw, context(bound)).params.credentialVersion, 1);
  const metadata = { node_token_status: 'disabled', tokenVersion: 2, credentialVersion: 3 };
  assert.deepEqual(parse(notification('hello', metadata)).params, metadata);
  rejects(notification('hello', { ticket: 'do-not-echo-secret' }));
});
