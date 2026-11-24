import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseTerminalControl } from '../src/shared/terminalProtocol.js';
import { validateSshEventReport } from '../src/services/loginEvents.js';

const root = new URL('./fixtures/monitor-protocol/', import.meta.url);
function load(name) {
  const file = new URL(`${name}.json`, root);
  assert.ok(existsSync(file), `missing consumable ${name} contract`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Fixture-only JSON Schema subset; no product codec is introduced in Task1.
function accepts(schema, value, definitions) {
  if (typeof schema === 'boolean') return schema;
  if (schema.anyOf) return schema.anyOf.some(option => accepts(option, value, definitions));
  if (schema.$ref) return accepts(definitions[schema.$ref.split('/').at(-1)], value, definitions);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = [].concat(schema.type || type);
  if (!types.includes(type) && !(type === 'number' && types.includes('integer') && Number.isInteger(value))) return false;
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern, 'u').test(value))) return false;
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    return value.every((item, index) => accepts(schema.prefixItems?.[index] ?? schema.items, item, definitions));
  }
  if (type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => schema.properties?.[key]
      ? accepts(schema.properties[key], item, definitions) : schema.additionalProperties !== false);
  }
  return true;
}

function checkRefs(value, definitions) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) assert.ok(definitions[value.$ref.split('/').at(-1)], `unresolved ${value.$ref}`);
  for (const child of Object.values(value)) checkRefs(child, definitions);
}

function checkSchemaTypes(schema, path) {
  if (typeof schema === 'boolean') return;
  if (Object.hasOwn(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.length, `${path}.type is empty`);
    for (const type of types) assert.ok(
      ['null','boolean','object','array','number','integer','string'].includes(type),
      `${path}.type has invalid member ${JSON.stringify(type)}`);
  }
  for (const [key, child] of Object.entries(schema.properties || {})) checkSchemaTypes(child, `${path}.properties.${key}`);
  for (const key of ['items','additionalProperties']) if (schema[key] !== undefined) checkSchemaTypes(schema[key], `${path}.${key}`);
  for (const key of ['prefixItems','anyOf']) for (const [index, child] of (schema[key] || []).entries()) checkSchemaTypes(child, `${path}.${key}[${index}]`);
}

test('all nested contract schema type members are valid JSON Schema type names', () => {
  for (const name of ['standard','extensions']) {
    const fixture = load(name);
    for (const [key, schema] of Object.entries(fixture.definitions)) checkSchemaTypes(schema, `${name}.definitions.${key}`);
    for (const method of fixture.methods) {
      for (const key of ['paramsSchema','resultSchema','receiverParamsSchema','ingestionSchema']) {
        if (method[key]) checkSchemaTypes(method[key], `${name}.${method.name}.${key}`);
      }
      if (method.trafficReading) checkSchemaTypes(method.trafficReading.counterSchema, `${name}.${method.name}.trafficReading.counterSchema`);
    }
  }
});

test('whole resource batch accepts unavailable or complete disk IO and rejects invalid disk IO', () => {
  const fixture = load('extensions');
  const method = fixture.methods.find(item => item.name === 'cf.report.batch');
  const params = JSON.parse(method.examples.find(item => item.valid).raw).params;
  const diskIO = { read_bps: 100, write_bps: 200, read_iops: 1.5, write_iops: 2, await_ms: 0.5, util: 2 };
  const cases = [
    [null, true, 'unavailable'],
    [diskIO, true, 'complete measurements'],
    ['unavailable', false, 'string'],
    [[], false, 'array'],
    [{}, false, 'empty object'],
    [{ read_bps: 100 }, false, 'incomplete object'],
    [{ ...diskIO, read_bps: '100' }, false, 'wrong field type'],
    [{ ...diskIO, command: 'forbidden' }, false, 'unknown field']
  ];
  for (const [value, expected, note] of cases) {
    const batch = { ...params, samples: params.samples.map(sample => ({ ...sample, extra: { ...sample.extra, diskIO: value } })) };
    assert.equal(accepts(method.paramsSchema, batch, fixture.definitions), expected, note);
  }
});

test('contracts give every method one schema, source, and exact role authorization', () => {
  const standard = load('standard'), extensions = load('extensions'), permissions = load('permissions');
  const methods = [...standard.methods, ...extensions.methods];
  for (const fixture of [standard, extensions]) {
    checkRefs(fixture.definitions, fixture.definitions);
    checkRefs(fixture.methods, fixture.definitions);
  }
  assert.equal(new Set(methods.map(item => item.name)).size, methods.length, 'duplicate method');
  assert.deepEqual(standard.methods.map(item => item.name).sort(), ['hello', 'ping.result', 'ping.tasks', 'report']);
  assert.deepEqual(permissions.methods.map(item => item.name).sort(), methods.map(item => item.name).sort());
  for (const method of methods) {
    assert.ok(method.paramsSchema && method.sources.length, method.name);
    const permission = permissions.methods.find(item => item.name === method.name);
    assert.deepEqual(permission.senderRoles, method.senderRoles, method.name);
    assert.deepEqual(permission.receiverRoles, method.receiverRoles, method.name);
    for (const role of method.senderRoles) assert.ok(permissions.roles[role].methods.includes(method.name), `${method.name}: missing sender grant ${role}`);
    assert.ok(permission.guards.length, method.name);
    for (const source of method.sources) assert.ok((method.name.startsWith('cf.') ? extensions : standard).sources[source], `${method.name}: broken source reference`);
    assert.ok(method.examples.some(item => item.valid), `${method.name}: missing positive example`);
    const fixture = method.name.startsWith('cf.') ? extensions : standard;
    for (const example of method.examples) {
      const message = JSON.parse(example.raw);
      assert.equal(message.method, method.name);
      assert.equal(accepts(method.paramsSchema, message.params, fixture.definitions), example.valid, `${method.name}: ${example.note}`);
      if (example.valid) {
        assert.equal(message.jsonrpc, '2.0');
        assert.equal(Object.hasOwn(message, 'id'), method.kind === 'request', method.name);
        assert.ok(Buffer.byteLength(example.raw) <= method.maxBytes, method.name);
      }
    }
    for (const raw of method.resultExamples || []) {
      const response = JSON.parse(raw);
      assert.equal(response.id, JSON.parse(method.examples[0].raw).id);
      assert.ok(accepts(method.resultSchema, response.result, fixture.definitions), `${method.name}: invalid response fixture`);
      assert.ok(!Object.hasOwn(response, 'method') && !Object.hasOwn(response, 'error'));
    }
  }
  assert.ok(!JSON.stringify(permissions).includes('cf.*'), 'wildcard grants authority');
  assert.deepEqual(permissions.roles.public.methods, []);
  assert.deepEqual(permissions.roles.preview.methods, []);
  assert.ok(!permissions.methods.find(item => item.name === 'cf.terminal.open').senderRoles.includes('agent'));
  assert.ok(permissions.methods.find(item => item.name === 'cf.terminal.hello').guards.includes('private_terminal_v1_bootstrap'));
  const tasks = extensions.methods.find(item => item.name === 'cf.ping.tasks');
  const taskList = Array.from({ length: 65 }, (_, i) => ({ taskId: i + 1, metricId: `p_${i}`, target: 'example.com', intervalSeconds: 60, mode: 'icmp' }));
  assert.ok(accepts(tasks.paramsSchema, { version: 1, revision: 1, tasks: taskList }, extensions.definitions), 'CF must not inherit the standard64 task cap');
});

test('upstream parser tolerance is separate from valid samples and standard task execution caps', () => {
  const fixture = load('standard');
  const [hello, report, result, tasks] = ['hello','report','ping.result','ping.tasks'].map(name => fixture.methods.find(method => method.name === name));
  assert.ok(accepts(hello.receiverParamsSchema, null, fixture.definitions));
  assert.ok(accepts(report.receiverParamsSchema, { cpu: 0.5 }, fixture.definitions));
  assert.ok(!accepts(report.receiverParamsSchema, { cpu: null }, fixture.definitions));
  assert.ok(!accepts(result.ingestionSchema, { task_id: 1 }, fixture.definitions));
  assert.ok(accepts(result.ingestionSchema, { task_id: 1, latency_ms: -2 }, fixture.definitions));
  const list = Array.from({ length: 65 }, (_, i) => ({ id: i + 1, target: 'example.com:443', interval: 1 }));
  assert.ok(accepts(tasks.receiverParamsSchema, list, fixture.definitions));
  assert.ok(!accepts(tasks.paramsSchema, list, fixture.definitions));
});

test('terminal and SSH extension examples retain existing trust-boundary validation', () => {
  const fixture = load('extensions');
  for (const method of fixture.methods.filter(item => item.legacyTerminalType)) {
    const params = JSON.parse(method.examples.find(item => item.valid).raw).params;
    const { version, ...legacy } = params;
    assert.equal(version, 1);
    for (const role of method.senderRoles) {
      const parsed = parseTerminalControl(JSON.stringify({ type: method.legacyTerminalType, ...legacy }), role);
      assert.equal(parsed.type, method.legacyTerminalType);
    }
  }
  const ssh = fixture.methods.find(item => item.name === 'cf.ssh.events');
  const params = JSON.parse(ssh.examples.find(item => item.valid).raw).params;
  assert.deepEqual(validateSshEventReport(params), params);
  assert.throws(() => validateSshEventReport({ ...params, events: Array(33).fill(params.events[0]) }));
  assert.throws(() => parseTerminalControl('{"type":"open","protocol":1,"sessionId":"s","ticket":"bad","cols":80,"rows":24}', 'broker-control'));
});

test('durable batch is bounded and replay examples keep numeric counter tokens intact', () => {
  const standard = load('standard'), extensions = load('extensions');
  const raw = standard.methods.find(item => item.name === 'report').examples.find(item => item.note === 'raw i64 counter').raw;
  assert.equal(BigInt(raw.match(/"net_rx_total":(\d+)/)[1]), 9007199254740993n);
  const batch = extensions.methods.find(item => item.name === 'cf.report.batch');
  assert.equal(batch.maxBytes, 524288);
  assert.equal(extensions.definitions.batch.properties.samples.maxItems, 300);
  const replay = extensions.replayExamples;
  assert.equal(replay.ws.paramsRaw, replay.http.paramsRaw);
  assert.equal(replay.ack.durableThrough, 1);
  assert.deepEqual(replay.ack.accepted, { from: 1, to: 1 });
  assert.equal(replay.ack.stream, JSON.parse(replay.ws.paramsRaw).stream);
  const sample = JSON.parse(replay.ws.paramsRaw);
  assert.ok(accepts(batch.paramsSchema, sample, extensions.definitions));
  assert.ok(!accepts(batch.paramsSchema, { ...sample, sequence: 0 }, extensions.definitions));
  assert.ok(!accepts(batch.paramsSchema, { ...sample, samples: Array(301).fill(sample.samples[0]) }, extensions.definitions));
  assert.ok(!accepts(batch.paramsSchema, { ...sample, token: 'forbidden' }, extensions.definitions));
  assert.ok(accepts(batch.resultSchema, replay.ack, extensions.definitions));
});
