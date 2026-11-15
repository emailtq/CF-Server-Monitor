import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentConfig } from '../src/utils/agentConfig.js';
import { validatePingNode as backendValidateTarget } from '../src/utils/agentConfig.js';
import { validatePingNode as frontendValidateTarget } from '../src/frontend/utils/pingNode.js';
import { migrateLatencyConfig, changeLatencyTasks, loadLatencyTasks } from '../src/database/latencyTasks.js';
import { mergeLatencyAssignments, withLegacyLatencyHistory, validateLatencyBackup } from '../src/shared/latencyTasks.js';
import { harness } from './terminal-harness.js';
import { controls, until } from './terminal-harness.js';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { saveMetricsHistory } from '../src/database/schema.js';

const evidence = path.resolve(process.env.CFSM_LATENCY_EVIDENCE_ROOT || `C:/Users/Administrator/AppData/Local/Temp/cfsm-admin-ui-evidence/round3-latency-${process.env.CODEX_THREAD_ID || 'local'}`);
const go = path.resolve('.planning/2026-11-05-agent-terminal-proposal/tools/go/bin/go.exe');
const agent = path.resolve('../cfsm-agent');
test('task trust boundaries use the same validator without a settings/config dependency cycle', () => {
  assert.equal(frontendValidateTarget, backendValidateTarget);
});
const run = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, ...options });
  let output = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  child.on('error', reject); child.on('close', code => resolve({ code, output }));
});

test('actual 9 and 32 task API configs → Go collection/report → authenticated HTTP/WSS → D1/latest/history/detail/public', { timeout: 180000, skip: !fs.existsSync(go) || !fs.existsSync(agent) ? 'requires the adjacent Go Agent and existing local Go toolchain' : false }, async () => {
  assert.ok(fs.existsSync(go), 'existing Go toolchain required');
  fs.mkdirSync(evidence, { recursive: true });
  const binary = path.join(evidence, 'latency-integration.test.exe');
  const build = await run(go, ['test', '-c', '-o', binary, './internal/cfprobe'], { cwd: agent, env: { ...process.env, GOTMPDIR: evidence } });
  fs.writeFileSync(path.join(evidence, 'go-build.log'), build.output);
  assert.equal(build.code, 0, build.output);
  const listener = net.createServer(socket => socket.destroy());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    for (const count of [9, 32]) {
      const h = await harness();
      try {
        await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=? WHERE id='node-a'").bind(Date.now() - 3600000).run();
        await h.action('latency_list');
        let tasks = (await (await h.action('latency_list')).json()).tasks;
        for (const task of tasks) assert.equal((await h.action('latency_delete', { id: task.id })).status, 200);
        const target = `127.0.0.1:${listener.address().port}`;
        for (let i = 0; i < count; i++) assert.equal((await h.action('latency_save', { task: { name: `Probe ${i}`, target, interval: i ? 60 : 5, nodes: ['node-a'], auto_join: true } })).status, 200);
        const configResponse = await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json', 'X-Agent-Config-Schema': '9' }, body: JSON.stringify({ id: 'node-a', metrics: { timestamp: Date.now() - 60000, cpu: 0 } }) });
        assert.equal(configResponse.status, 200);
        const configFile = path.join(evidence, `config-${count}.txt`), reportFile = path.join(evidence, `report-${count}.json`);
        fs.writeFileSync(configFile, await configResponse.text());
        assert.equal(JSON.parse(new URLSearchParams(fs.readFileSync(configFile, 'utf8')).get('latency_tasks')).length, count);
        const collected = await run(binary, ['-test.run=^TestLatencyWorkerRoundTrip$', '-test.v'], { cwd: agent, env: { ...process.env, GOTMPDIR: '', CFSM_LATENCY_CONFIG_FIXTURE: configFile, CFSM_LATENCY_REPORT_FIXTURE: reportFile } });
        fs.writeFileSync(path.join(evidence, `go-roundtrip-${count}.log`), collected.output);
        assert.equal(collected.code, 0, collected.output);
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        report.id = 'node-a'; report.metrics.timestamp = Date.now() - 1000;
        assert.equal(report.config_schema, '9');
        assert.equal(Object.keys(report.metrics.extra_probes).length, count);
        assert.ok(Object.values(report.metrics.extra_probes).every(probe => Number(probe.ping) >= 1 && Number(probe.loss) === 0));
        assert.ok(!JSON.stringify(report).includes(target));
        assert.equal((await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json', 'X-Agent-Config-Schema': '9' }, body: JSON.stringify(report) })).status, 200);
        const history = await (await h.fetch('/api/history/all?id=node-a&hours=1')).json();
        assert.ok(history.some(row => Object.keys(row.extra_probes || {}).length === count));
        const adminList = await h.action('list');
        assert.equal(adminList.status, 200);
        assert.equal((await adminList.json()).servers.length, 2);
        const detail = await (await h.fetch('/api/server?id=node-a')).json();
        assert.equal(detail.sysConfig.extra_ping_nodes.length, count);
        assert.ok(!JSON.stringify(detail).includes(target));
        const frontend = await h.socket('/api/ws'), peer = await h.socket('/update?config_schema=9', h.agentHeaders());
        assert.equal(frontend.response.status, 101);
        assert.equal(peer.response.status, 101);
        frontend.ws.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids: ['node-a'] }));
        await until(() => controls(frontend).some(frame => frame.type === 'subscribed'));
        await until(() => controls(peer).some(frame => frame.type === 'hello'));
        report.metrics.timestamp = Date.now();
        peer.ws.send(JSON.stringify({ type: 'update', payload: report }));
        await until(() => controls(peer).some(frame => frame.type === 'ack'));
        try {
          await until(() => controls(frontend).some(frame => frame.type === 'batchUpdate' && frame.updates?.some(update => update.samples?.some(sample => Object.keys((sample.data || sample.payload)?.extra_probes || {}).length === count))));
        } catch (error) {
          fs.writeFileSync(path.join(evidence, `frames-${count}.json`), JSON.stringify({ frontend: controls(frontend), agent: controls(peer), stats: await (await h.fetch('/test/report-stats')).json() }, null, 2));
          throw error;
        }
        const publicData = await (await h.fetch('/api/servers')).json();
        assert.equal(publicData.sysConfig.extra_ping_nodes.length, count);
        assert.ok(!JSON.stringify(publicData).includes(target));
        fs.writeFileSync(path.join(evidence, `public-${count}.json`), JSON.stringify(publicData, null, 2));
      } finally { await h.dispose(); }
    }
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('migration separates same-slot targets and preserves disabled, inheritance, extra identity and raw recovery', () => {
  const settings = { custom_ct: 'global.test', custom_ct_name: 'Transit', extra_ping_nodes: [{ id: 'p_stable', name: 'Existing', target: 'extra.test' }] };
  const servers = [{ id: 'a', custom_ct: '' }, { id: 'b', custom_ct: 'private.test' }, { id: 'c', custom_ct: '0' }];
  const document = migrateLatencyConfig(settings, servers, 123);
  assert.deepEqual(document.tasks.map(task => [task.target, task.nodes, task.auto_join]), [['global.test', ['a'], true], ['private.test', ['b'], false], ['extra.test', ['a', 'b', 'c'], true]]);
  assert.equal(document.tasks[2].id, 'p_stable');
  assert.deepEqual(document.legacy.servers, servers.map(server => ({ ...server })) .map(server => ({ ...server, custom_cu: undefined, custom_cm: undefined, custom_bd: undefined, node_1: undefined, node_2: undefined, node_3: undefined, node_4: undefined })));
  assert.equal(document.sources[0].node, 'a');
  assert.equal(document.sources[1].target, 'private.test');
  assert.equal(document.migrated_at, 123);
});

test('assignment base delta preserves concurrent edits and newly auto-joined nodes', () => {
  assert.deepEqual(mergeLatencyAssignments(['a', 'fresh', 'other'], ['b'], ['a']), ['fresh', 'other', 'b']);
  assert.deepEqual(mergeLatencyAssignments([], ['a'], ['a']), [], 'unchanged old selection cannot restore someone else’s removal');
});

test('authenticated task save, assignment, target identity rotation, order and delete survive real D1', async () => {
  const h = await harness();
  try {
    const list = await h.action('latency_list');
    assert.equal(list.status, 200);
    const task = { name: 'Local', target: '127.0.0.1:443', interval: 5, nodes: ['node-a'], auto_join: true };
    const save = await h.action('latency_save', { task });
    assert.equal(save.status, 200);
    const tasks = (await save.json()).tasks;
    const created = tasks.find(item => item.name === 'Local');
    assert.ok(created);
    const edit = await h.action('latency_save', { task: { ...created, target: '127.0.0.1:80', base: created.nodes } });
    assert.equal(edit.status, 200);
    const changed = (await edit.json()).tasks.find(item => item.id === created.id);
    assert.notEqual(changed.metric_id, created.id);
    assert.equal((await h.action('latency_delete', { id: created.id })).status, 200);
    assert.equal((await h.action('latency_list')).status, 200);
    const row = await loadLatencyTasks(h.db);
    assert.ok(!row.tasks.some(item => item.id === created.id));
    assert.equal(row.archives.filter(item => item.id === created.id).length, 2);
  } finally { await h.dispose(); }
});

test('canonical assignments, not hidden per-node overrides, control schema 9 collection', () => {
  const tasks = Array.from({ length: 32 }, (_, i) => ({ id: `p_${i}`, name: `Probe ${i}`, target: '127.0.0.1:443', interval: i ? 60 : 5, nodes: ['a'], auto_join: true }));
  const config = buildAgentConfig({ id: 'a', custom_ct: 'hidden.test' }, { latency_tasks: { tasks } }, 9);
  assert.equal(config.schema_version, 9);
  assert.equal(config.custom_ct, '');
  assert.equal(config.latency_tasks.length, 32);
  assert.deepEqual(config.latency_tasks[0], { id: 'p_0', target: '127.0.0.1:443', interval: 5 });
  assert.deepEqual(buildAgentConfig({ id: 'b' }, { latency_tasks: { tasks } }, 9).latency_tasks, []);
});

test('a disjoint legacy override inventory is not limited by a single node’s 64 KiB configuration', async () => {
  const h = await harness();
  try {
    await h.db.batch(Array.from({ length: 600 }, (_, i) => h.db.prepare('INSERT INTO servers(id,name,custom_ct) VALUES(?,?,?)').bind(`legacy-${i}`, `Legacy ${i}`, `${'part.'.repeat(7)}node${i}.test:443`)));
    const result = await h.action('latency_list');
    assert.equal(result.status, 200, await result.clone().text());
    const catalog = await result.json();
    assert.equal(catalog.tasks.filter(task => task.target.includes('part.')).length, 600);
    assert.ok(catalog.tasks.filter(task => task.target.includes('part.')).every(task => task.nodes.length === 1));
  } finally { await h.dispose(); }
});

test('real D1 base snapshots retain concurrent selections and auto-joined nodes', async () => {
  const h = await harness();
  try {
    const create = await h.action('latency_save', { task: { name: 'Concurrent', target: '127.0.0.1:443', interval: 60, nodes: ['node-a'], auto_join: true } });
    const task = (await create.json()).tasks.find(task => task.name === 'Concurrent');
    await h.db.prepare("INSERT INTO servers(id,name) VALUES('fresh','New node')").run();
    const edits = await Promise.all([
      h.action('latency_node', { node: 'node-b', tasks: [task.id], base: [] }),
      h.action('latency_save', { task: { ...task, nodes: [], base: ['node-a'] } })
    ]);
    assert.ok(edits.every(response => response.status === 200));
    const updated = (await (await h.action('latency_list')).json()).tasks.find(item => item.id === task.id);
    assert.deepEqual(updated.nodes.sort(), ['fresh', 'node-b']);
  } finally { await h.dispose(); }
});

test('unrelated node edits retain raw retired columns before and after activation', async () => {
  const h = await harness();
  const id = '00000000-0000-4000-8000-000000000001';
  try {
    await h.db.prepare('INSERT INTO servers(id,name,custom_ct,node_4) VALUES(?,?,?,?)').bind(id, 'Original', 'private.test:443', '0').run();
    for (const activated of [false, true]) {
      if (activated) assert.equal((await h.action('latency_list')).status, 200);
      const result = await h.action('edit', { id, name: 'Renamed', collect_interval: 0, report_interval: 60, wss_report_interval: 2, reset_day: 1, connection_mode: 'http', ping_mode: 'tcp' });
      assert.equal(result.status, 200, await result.clone().text());
      assert.deepEqual(await h.db.prepare('SELECT custom_ct,node_4 FROM servers WHERE id=?').bind(id).first(), { custom_ct: 'private.test:443', node_4: '0' });
    }
  } finally { await h.dispose(); }
});

test('history projection separates node, slot, cutoff and current target identity', () => {
  const document = migrateLatencyConfig({ custom_ct: 'global.test' }, [{ id: 'a' }, { id: 'b', custom_ct: 'other.test' }, { id: 'c', custom_ct: '0' }], 1000);
  const a = document.tasks.find(task => task.nodes.includes('a')), b = document.tasks.find(task => task.nodes.includes('b'));
  const row = { timestamp: 999, ping_ct: 31, loss_ct: 0, extra_probes: '{}' };
  assert.deepEqual(withLegacyLatencyHistory(row, 'a', document).extra_probes, { [a.id]: { ping: 31, loss: 0 } });
  assert.deepEqual(withLegacyLatencyHistory(row, 'b', document).extra_probes, { [b.id]: { ping: 31, loss: 0 } });
  assert.deepEqual(withLegacyLatencyHistory(row, 'c', document).extra_probes, {});
  assert.deepEqual(withLegacyLatencyHistory({ ...row, timestamp: 1001 }, 'a', document).extra_probes, {});
  a.metric_id = 'p_next';
  assert.deepEqual(withLegacyLatencyHistory(row, 'a', document).extra_probes, {});
});

test('backup rejects duplicate metric identities even when task IDs differ', () => {
  const task = { id: 'p_one', metric_id: 'p_shared', name: 'One', target: 'one.test:443', interval: 60, nodes: ['node-a'], auto_join: false };
  assert.equal(validateLatencyBackup({ version: 1, tasks: [task, { ...task, id: 'p_two', target: 'two.test:443' }] }, backendValidateTarget), false);
});

test('restoring a task backup restores mapped legacy sources and retains target generations for deletion', async () => {
  const h = await harness();
  try {
    const backup = migrateLatencyConfig({ custom_ct: 'old.test:443' }, [{ id: 'old-node' }], 1000);
    const task = backup.tasks[0];
    backup.archives = [{ ...task, metric_id: 'p_prior', target: 'prior.test:443', archived_at: 900 }];
    const restored = await changeLatencyTasks(h.db, {}, 'import', { document: backup, serverIdMap: new Map([['old-node', 'node-a']]) });
    assert.deepEqual(withLegacyLatencyHistory({ timestamp: 999, ping_ct: 44, loss_ct: 0, extra_probes: '{}' }, 'node-a', restored).extra_probes, { [task.id]: { ping: 44, loss: 0 } });
    assert.ok(restored.archives.some(entry => entry.metric_id === 'p_prior'));
  } finally { await h.dispose(); }
});

test('rename keeps history identity; target generations, deletion and delayed reports remain isolated in D1', async () => {
  const h = await harness();
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=? WHERE id='node-a'").bind(Date.now()-3600000).run();
    const create = await h.action('latency_save', { task: { name: 'First', target: 'first.test:443', interval: 60, nodes: ['node-a'], auto_join: false } });
    let task = (await create.json()).tasks.find(task => task.name === 'First');
    const first = task.id;
    await saveMetricsHistory(h.db, 'node-a', 1, { ping_ct: 71, loss_ct: 0, extra_probes: { [first]: { ping: 31, loss: 0 } } }, '', Date.now()-90000, 'test');
    const rename = await h.action('latency_save', { task: { ...task, name: 'Renamed', base: task.nodes } });
    task = (await rename.json()).tasks.find(item => item.id === first);
    assert.equal(task.metric_id, undefined);
    const edit = await h.action('latency_save', { task: { ...task, target: 'second.test:443', base: task.nodes } });
    task = (await edit.json()).tasks.find(item => item.id === first);
    const second = task.metric_id;
    await saveMetricsHistory(h.db, 'node-a', 1, { extra_probes: { [first]: { ping: 99, loss: 0 }, [second]: { ping: 42, loss: 0 } } }, '', Date.now()-60000, 'test');
    const before = (await h.db.prepare('SELECT extra_probes FROM metrics_history ORDER BY id').all()).results.map(row => JSON.parse(row.extra_probes));
    assert.ok(before.some(probes => probes[first]?.ping === 31));
    assert.ok(before.some(probes => probes[second]?.ping === 42 && !probes[first]));
    assert.equal((await h.action('latency_delete', { id: first })).status, 200);
    await saveMetricsHistory(h.db, 'node-a', 1, { extra_probes: { [first]: { ping: 33, loss: 0 }, [second]: { ping: 44, loss: 0 } } }, '', Date.now()-30000, 'test');
    const after = (await h.db.prepare('SELECT ping_ct,extra_probes FROM metrics_history').all()).results;
    assert.ok(after.every(row => !JSON.parse(row.extra_probes)[first] && !JSON.parse(row.extra_probes)[second]));
    assert.ok(after.some(row => row.ping_ct === 71), 'raw fixed-slot history survives explicit canonical deletion');
    const readd = await h.action('latency_save', { task: { name: 'First', target: 'first.test:443', interval: 60, nodes: ['node-a'], auto_join: false } });
    assert.notEqual((await readd.json()).tasks.find(item => item.name === 'First').id, first);
  } finally { await h.dispose(); }
});

test('D1 recovery chunks preserve emoji across UTF-16 boundaries and subsequent rewrites', async () => {
  const h = await harness();
  try {
    let crossedBoundary = false;
    for (const prefix of ['', 'x']) {
      const raw = prefix + '😀'.repeat(40000);
      const saved = await changeLatencyTasks(h.db, {}, 'import', { document: { version: 1, tasks: [], legacy: { settings: { raw }, servers: [] } } });
      const serialized = JSON.stringify(saved);
      for (let end = 32768; end < serialized.length; end += 32768) {
        if (serialized.charCodeAt(end - 1) >= 0xd800 && serialized.charCodeAt(end - 1) <= 0xdbff &&
          serialized.charCodeAt(end) >= 0xdc00 && serialized.charCodeAt(end) <= 0xdfff) crossedBoundary = true;
      }
      const restored = await loadLatencyTasks(h.db);
      assert.ok(JSON.stringify(restored) === serialized, 'D1 must restore the complete document without changing surrogate pairs');
      const chunks = (await h.db.prepare("SELECT value,length(CAST(value AS BLOB)) bytes FROM settings WHERE key GLOB 'latency_tasks:document:*' ORDER BY key").all()).results;
      assert.ok(chunks.every(chunk => chunk.value.isWellFormed() && chunk.value.length <= 32768 && chunk.bytes < 2000000), 'each bounded D1 chunk contains complete Unicode code points');
      assert.equal(restored.imported_legacy.legacy.settings.raw, raw);
    }
    assert.ok(crossedBoundary, 'fixture must place an emoji across the old fixed-size boundary');
    await h.db.prepare("INSERT INTO servers(id,name) VALUES('unicode-fresh','Fresh')").run();
    const reconciled = await loadLatencyTasks(h.db);
    assert.equal(reconciled.imported_legacy.legacy.settings.raw, 'x' + '😀'.repeat(40000));
    assert.ok(JSON.stringify(await loadLatencyTasks(h.db)) === JSON.stringify(reconciled), 'reconciliation rewrites also preserve recovery material');
  } finally { await h.dispose(); }
});

test('large recovery catalogs stay below D1’s row boundary and restore the complete document', async () => {
  const h = await harness();
  try {
    await h.db.prepare("UPDATE servers SET history_partition_id=1,timestamp=? WHERE id='node-a'").bind(Date.now()-3600000).run();
    const task = { id: 'p_active', name: 'Current target', target: 'current.test:443', interval: 60, nodes: ['node-a'], auto_join: false };
    const archives = Array.from({ length: 11000 }, (_, i) => ({ ...task, name: 'Archived target configuration with full recovery material', metric_id: `p_archive_${i}`, target: `old${i}.test:443`, archived_at: i + 1 }));
    const backup = { version: 1, tasks: [task], archives, legacy: { settings: { original: 'raw recovery '.repeat(50000) }, servers: [] } };
    const saved = await changeLatencyTasks(h.db, {}, 'import', { document: backup });
    assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length > 2000000);
    const rows = (await h.db.prepare("SELECT key,length(CAST(value AS BLOB)) bytes FROM settings WHERE key LIKE 'latency_tasks%'").all()).results;
    assert.ok(rows.every(row => row.bytes < 2000000), 'every persisted string/row respects actual D1 2MB boundary');
    const restored = await loadLatencyTasks(h.db);
    assert.equal(JSON.stringify(restored), JSON.stringify(saved));
    const report = await h.fetch('/update', { method: 'POST', headers: { ...h.agentHeaders(), 'Content-Type': 'application/json', 'X-Agent-Config-Schema': '9' }, body: JSON.stringify({ id: 'node-a', metrics: { cpu: 0, timestamp: Date.now()-1000, extra_probes: { p_active: { ping: 42, loss: 0 }, p_archive_1: { ping: 99, loss: 0 } } } }) });
    assert.equal(report.status, 200, await report.clone().text());
    assert.deepEqual(JSON.parse((await h.db.prepare('SELECT extra_probes FROM metrics_history ORDER BY id DESC LIMIT 1').first()).extra_probes), { p_active: { ping: 42, loss: 0 } });
  } finally { await h.dispose(); }
});

test('legacy extra-only backup updates canonical targets rather than leaving imported configuration inactive', async () => {
  const h = await harness();
  try {
    assert.equal((await h.action('latency_list')).status,200);
    const result = await h.action('import_servers',{settings:{site:{extra_ping_nodes:[{id:'p_old_backup',name:'Recovered',target:'recovered.test:443'}]}}});
    assert.equal(result.status,200);
    const tasks=(await(await h.action('latency_list')).json()).tasks;
    assert.ok(tasks.some(task=>task.id==='p_old_backup'&&task.target==='recovered.test:443'));
  } finally { await h.dispose(); }
});

test('importing another target generation archives the currently active generation', async () => {
  const h=await harness();
  try {
    const create=await h.action('latency_save',{task:{name:'Backup',target:'one.test:443',interval:60,nodes:['node-a'],auto_join:false}});
    const original=(await create.json()).tasks.find(task=>task.name==='Backup');
    const edit=await h.action('latency_save',{task:{...original,target:'two.test:443',base:original.nodes}});
    const current=(await edit.json()).tasks.find(task=>task.id===original.id);
    const restored=await changeLatencyTasks(h.db,{},'import',{document:{version:1,tasks:[original]}});
    assert.ok(restored.archives.some(entry=>entry.metric_id===current.metric_id&&entry.target==='two.test:443'));
  } finally { await h.dispose(); }
});
