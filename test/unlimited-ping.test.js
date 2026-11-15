import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentConfig, serializeAgentConfig } from '../src/utils/agentConfig.js';
import { normalizeMetricSamples, getHistoryMetrics, toBroadcastSamples } from '../src/handlers/update.js';
import { coerceNumericMetricFields, normalizeProbeMetricRow } from '../src/utils/metrics.js';
import { validateExtraPingNodes, normalizeExtraProbes, publicExtraPingNodes, extraPingDefinitions, mergeExtraProbeMetrics } from '../src/shared/extraPing.js';
import { validatePingNode } from '../src/utils/agentConfig.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { harness, controls, until } from './terminal-harness.js';
import { getLatestMetrics, getMetricsHistory, getDashboardLatencyHistory } from '../src/database/schema.js';
import { addHistoryColumns } from '../src/database/updateDatabase.js';
import { createHistoryTableSql, HISTORY_ALL_QUERY_COLUMNS } from '../src/utils/historyFields.js';
import { Miniflare } from 'miniflare';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const nodes = Array.from({ length: 24 }, (_, i) => ({ id: `p_${i}`, name: `Node ${i + 9}`, target: '127.0.0.1:12345' }));
const goBinary = process.env.CFSM_GO_BIN || path.resolve('.planning/2026-11-05-agent-terminal-proposal/tools/go/bin/go.exe');
const agentRoot = process.env.CFSM_AGENT_ROOT || path.resolve('../cfsm-agent');

test('schema 8 delivers stable additional targets while schema 7 keeps its exact eight-slot contract', () => {
  const settings = { extra_ping_nodes: nodes, custom_ct: 'ct.test', node_1: 'one.test' };
  const modern = buildAgentConfig({ custom_ct: '0', node_1: 'override.test' }, settings, 8);
  assert.deepEqual(modern.extra_ping_nodes, nodes.map(({ id, target }) => ({ id, target })));
  assert.equal(modern.custom_ct, '');
  assert.equal(modern.node_1, 'override.test');
  assert.deepEqual(JSON.parse(new URLSearchParams(serializeAgentConfig(modern)).get('extra_ping_nodes')), modern.extra_ping_nodes);
  const legacy = buildAgentConfig({}, settings, 7);
  assert.equal(legacy.schema_version, 7);
  assert.equal(Object.hasOwn(legacy, 'extra_ping_nodes'), false);
  assert.equal(serializeAgentConfig(legacy).includes('extra_ping_nodes'), false);
});

test('additional target and report trust boundaries reject bad identities, addresses, values and excess bytes', () => {
  assert.equal(validateExtraPingNodes(nodes, validatePingNode).valid, true);
  for (const value of [null, {}, [...nodes, nodes[0]], [{ ...nodes[0], target: 'https://private.test' }], [{ ...nodes[0], id: '__proto__' }], [{ ...nodes[0], name: 'x'.repeat(129) }]]) {
    assert.equal(validateExtraPingNodes(value, validatePingNode).valid, false);
  }
  assert.equal(validateExtraPingNodes(Array.from({ length: 2000 }, (_, i) => ({ ...nodes[0], id: `p_${i}`, name: 'x'.repeat(128) })), validatePingNode).valid, false);
  for (const probe of [{ ping: 1, loss: 101 }, { ping: false, loss: 0 }, { ping: 1, loss: 0, target: 'private.test' }]) {
    assert.equal(normalizeExtraProbes({ p_0: probe }), null);
    assert.throws(() => normalizeMetricSamples({ metrics: { extra_probes: { p_0: probe } } }), error => error.code === 400);
  }
  assert.throws(() => normalizeMetricSamples({ metrics: { extra_probes: 'invalid JSON' } }), error => error.code === 400);
  assert.throws(() => normalizeMetricSamples({ samples: [{ ts: 1000, metrics: { extra_ping_nodes: nodes } }] }), error => error.code === 400, 'configuration addresses must never enter the public sample stream');
  assert.deepEqual(publicExtraPingNodes(nodes)[0], { id: 'p_0', name: 'Node 9' });
  assert.equal(extraPingDefinitions([{ ...nodes[0], name: 'Renamed' }])[0].field, 'ping_extra_p_0');
  assert.equal(Object.hasOwn(coerceNumericMetricFields({ extra_probes: { p_0: { ping: null, loss: null } } }), 'ping_extra_p_0'), false, 'no measurement is distinct from a measured timeout');
  const server = { ping_extra_p_0: 30, loss_extra_p_0: 0, ping_ct: 41 };
  mergeExtraProbeMetrics(server, { p_0: { ping: null, loss: null } });
  assert.equal(Object.hasOwn(server, 'ping_extra_p_0'), false, 'a changed target without a sample must clear its previous reading');
  assert.equal(server.ping_ct, 41);
});

test('one additive JSON column migrates current and old histories without altering legacy data', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("OK"); } }', d1Databases: { DB: 'extra-ping-migration' } });
  try {
    const db = await mf.getD1Database('DB');
    for (const table of ['metrics_history', 'metrics_history_old']) {
      await db.prepare(createHistoryTableSql(table).replace(/,\n\s+extra_probes TEXT DEFAULT '\{\}'/, '')).run();
      await db.prepare(`INSERT INTO ${table} (id,server_id,ping_ct,loss_ct,ping_node_4,loss_node_4) VALUES (1,'old',33,'false',44,100)`).run();
    }
    const result = await addHistoryColumns(db);
    assert.equal(result.success, true);
    assert.equal(result.added, 2);
    for (const table of ['metrics_history', 'metrics_history_old']) {
      const row = await db.prepare(`SELECT ping_ct,loss_ct,ping_node_4,loss_node_4,extra_probes FROM ${table}`).first();
      assert.deepEqual(row, { ping_ct: 33, loss_ct: 'false', ping_node_4: 44, loss_node_4: 100, extra_probes: '{}' });
    }
    assert.equal((await addHistoryColumns(db)).added, 0);
  } finally { await mf.dispose(); }
});

test('authenticated Worker/D1 accepts variable probe collections without a Go test toolchain', async () => {
  const h = await harness();
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=? WHERE id='node-a'").bind(Date.now() - 3600000).run();
    const extra_probes = Object.fromEntries(nodes.map((node, i) => [node.id, { ping: i + 1, loss: 0 }]));
    const response = await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'node-a', metrics: { timestamp: Date.now() - 1000, extra_probes } }) });
    assert.equal(response.status, 200);
    const server = await h.db.prepare("SELECT * FROM servers WHERE id='node-a'").first();
    assert.equal((await getLatestMetrics(h.db, 'node-a', server)).ping_extra_p_23, 24);
    const history = await getMetricsHistory(h.db, 'node-a', 1, 'extra_probes', server);
    assert.equal(history.at(-1).loss_extra_p_23, 0);
  } finally { await h.dispose(); }
});

test('changing the extra target collection invalidates cached history for its new identities', async () => {
  const h = await harness();
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=? WHERE id='node-a'").bind(Date.now() - 3600000).run();
    await saveSiteOptions(h.db, { ['pass' + 'word']: 'fixture-only-hash', is_public: 'true' });
    const post = (id, timestamp) => h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'node-a', metrics: { timestamp, extra_probes: { [id]: { ping: 31, loss: 0 } } } }) });
    await post('p_old', Date.now() - 60000);
    await h.fetch('/api/history/all?id=node-a&hours=0.167');
    assert.equal((await h.action('save_settings', { settings: { extra_ping_nodes: [{ id: 'p_new', name: 'New target', target: '127.0.0.1:1' }] } })).status, 200);
    await post('p_new', Date.now() - 1000);
    const data = await (await h.fetch('/api/history/all?id=node-a&hours=0.167')).json();
    assert.ok(data.some(row => row.ping_extra_p_new === 31), 'old cached target IDs must not hide newly collected history');
  } finally { await h.dispose(); }
});

test('real Worker config → Go local probes/report → authenticated HTTP/WSS → D1/public history and private backup', {
  timeout: 180000,
  skip: !fs.existsSync(goBinary) || !fs.existsSync(agentRoot) ? 'cross-repository Go integration requires CFSM_GO_BIN and CFSM_AGENT_ROOT' : false
}, async () => {
  const root = process.env.CFSM_PING_EVIDENCE_ROOT || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `stage3-${process.env.CODEX_THREAD_ID || 'unlimited-ping'}`);
  fs.mkdirSync(root, { recursive: true });
  const configFile = path.join(root, 'worker-agent-config.txt'), reportFile = path.join(root, 'agent-report.json');
  const listener = net.createServer(socket => socket.destroy());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  let h;
  try {
    const target = `127.0.0.1:${listener.address().port}`;
    const extra = nodes.map(node => ({ ...node, target }));
    const settings = { extra_ping_nodes: extra, custom_ct: target, custom_cu: target, custom_cm: target, custom_bd: target, node_1: target, node_2: target, node_3: target, node_4: target, is_public: 'true', show_three_net_details: 'true', wss_report_enabled: 'true' };
    fs.writeFileSync(configFile, serializeAgentConfig(buildAgentConfig({ connection_mode: 'http' }, settings, 8)));
    fs.mkdirSync(path.join(root, 'go-tmp'), { recursive: true });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(goBinary, ['test', './internal/cfprobe', '-run', '^TestUnlimitedPingWorkerRoundTrip$', '-count=1'], { cwd: agentRoot, windowsHide: true, env: { ...process.env, GOCACHE: path.join(root, 'go-cache'), GOTMPDIR: path.join(root, 'go-tmp'), CFSM_PING_CONFIG_FIXTURE: configFile, CFSM_PING_REPORT_FIXTURE: reportFile } });
      let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value); child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    fs.writeFileSync(path.join(root, 'go-worker-bridge.txt'), result.output);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(report.config_schema, '8');
    assert.equal(Object.keys(report.metrics.extra_probes).length, 24);
    assert.ok(Object.values(report.metrics.extra_probes).every(probe => Number(probe.ping) >= 1 && Number(probe.loss) === 0));
    assert.ok(['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4'].every(field => Number(report.metrics[`ping_${field}`]) >= 1 && Number(report.metrics[`loss_${field}`]) === 0), 'all original eight targets also use real local TCP measurements');
    assert.equal(JSON.stringify(report).includes(target), false, 'report contains only metric IDs/values, not targets');
    h = await harness();
    await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=? WHERE id='node-a'").bind(Date.now() - 3600000).run();
    await saveSiteOptions(h.db, { ...settings, ['pass' + 'word']: 'fixture-only-hash' });
    const sentAt = Date.now() - 10000;
    report.id = 'node-a'; report.metrics.timestamp = sentAt;
    const response = await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json', 'X-Agent-Config-Schema': '8' }, body: JSON.stringify(report) });
    assert.equal(response.status, 200);
    assert.equal(new URLSearchParams(await response.text()).get('schema_version'), '8');
    const server = await h.db.prepare("SELECT * FROM servers WHERE id='node-a'").first();
    const latest = await getLatestMetrics(h.db, 'node-a', server);
    assert.ok(latest.ping_extra_p_23 >= 1);
    const history = await getMetricsHistory(h.db, 'node-a', 1, HISTORY_ALL_QUERY_COLUMNS.join(','), server);
    assert.ok(history.some(row => row.ping_extra_p_23 >= 1));
    const window = (await getDashboardLatencyHistory(h.db, [server], { cache: false })).get('node-a');
    assert.ok(window.ping.some(point => point.extra_p_23 >= 1));
    const publicData = await (await h.fetch('/api/server?id=node-a')).json();
    assert.ok(publicData.ping_extra_p_23 >= 1);
    assert.deepEqual(publicData.sysConfig.extra_ping_nodes.at(-1), { id: 'p_23', name: 'Node 32' });
    assert.equal(JSON.stringify(publicData).includes(target), false);
    const exported = await (await h.action('export_servers')).json();
    assert.deepEqual(exported.settings.site.extra_ping_nodes, extra);
    assert.equal((await h.action('save_settings', { settings: { extra_ping_nodes: [{ ...extra[0], target: 'invalid://target' }] } })).status, 400);
    const renamed = extra.slice(1).map(node => ({ ...node, name: `Renamed ${node.id}` }));
    assert.equal((await h.action('save_settings', { settings: { extra_ping_nodes: renamed } })).status, 200);
    const saved = await (await h.action('get_settings')).json();
    assert.deepEqual(saved.settings.extra_ping_nodes, renamed);
    assert.equal((await getLatestMetrics(h.db, 'node-a', server)).ping_extra_p_23, latest.ping_extra_p_23);
    const imported = await h.action('import_servers', { settings: { site: { extra_ping_nodes: extra } } });
    assert.equal(imported.status, 200);
    assert.deepEqual((await (await h.action('get_settings')).json()).settings.extra_ping_nodes, extra);
    const peer = await h.socket('/update?config_schema=8', h.agentHeaders());
    assert.equal(peer.response.status, 101);
    report.metrics.timestamp = sentAt + 1000;
    report.metrics.extra_probes.p_23 = { ping: null, loss: 100 };
    peer.ws.send(JSON.stringify({ type: 'update', payload: report }));
    await until(() => controls(peer).some(frame => frame.type === 'ack'));
    const realtime = await (await h.fetch('/api/server?id=node-a')).json();
    assert.ok(realtime.latestReportUpdates.some(update => update.samples.some(sample => sample.data?.loss_extra_p_23 === 100 || sample.payload?.loss_extra_p_23 === 100)));
    const invalid = { ...report, metrics: { extra_probes: { p_0: { ping: 1, loss: 101 } } } };
    peer.ws.send(JSON.stringify({ type: 'update', payload: invalid }));
    await until(() => controls(peer).some(frame => frame.type === 'error' && frame.code === 400));
  } finally {
    await h?.dispose();
    await new Promise(resolve => listener.close(resolve));
  }
});

test('additional probe identity survives current-value history, realtime and persisted JSON normalization', () => {
  const samples = normalizeMetricSamples({ samples: [
    { ts: 1000, metrics: { extra_probes: { p_0: { ping: 20, loss: 0 }, p_1: { ping: false, loss: false } } } },
    { ts: 2000, metrics: { extra_probes: { p_0: { ping: null, loss: 100 }, p_1: { ping: false, loss: false } } } }
  ] });
  const history = getHistoryMetrics({}, samples, samples.at(-1));
  assert.deepEqual(history.extra_probes.p_0, { ping: null, loss: 100 });
  const broadcast = toBroadcastSamples('s', samples, '', 'fixture');
  assert.equal(broadcast.at(-1).payload.ping_extra_p_0, null);
  assert.equal(broadcast.at(-1).payload.loss_extra_p_0, 100);
  assert.equal(coerceNumericMetricFields({ extra_probes: { p_1: { ping: false, loss: false } } }).ping_extra_p_1, false);
  assert.equal(normalizeProbeMetricRow({ extra_probes: JSON.stringify(history.extra_probes) }).ping_extra_p_0, null);
});
