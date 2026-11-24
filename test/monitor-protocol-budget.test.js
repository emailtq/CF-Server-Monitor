import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { generateBatches, projectMessages, runStorageProbe, writeStorageReport } from '../scripts/probe-monitor-storage.mjs';

test('storage report output creates missing parents and overwrites an existing report', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'cfsm-s2-output-'));
  t.after(async () => {
    const absolute = resolve(temp);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(absolute).startsWith('cfsm-s2-output-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const directory = join(temp, 'missing', 'nested');
  const path = join(directory, 'S2-storage-probe.json');
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await writeStorageReport({ phase: 'first', value: 1 }, path);
  assert.equal(await readFile(path, 'utf8'), '{\n  "phase": "first",\n  "value": 1\n}\n');
  assert.ok((await stat(directory)).isDirectory());
  await writeStorageReport({ phase: 'second', value: 2 }, path);
  assert.equal(await readFile(path, 'utf8'), '{\n  "phase": "second",\n  "value": 2\n}\n');
});

test('active and idle frames are not database rows or Worker HTTP requests', () => {
  const active = projectMessages(20, true), idle = projectMessages(20, false);
  assert.equal(active.batches, 28800);
  assert.equal(active.realtime, 864000);
  assert.equal(idle.realtime, 0);
  assert.equal(active.samples, idle.samples);
  assert.equal(active.probes, 115200);
  assert.equal(active.wsRequestUnits, Math.ceil(active.incomingFrames / 20));
  assert.ok(active.workerRequests < 80000);
  assert.ok(active.doRequestUnits < 80000);
  assert.ok(idle.doRequestUnits < active.doRequestUnits);
  assert.equal(projectMessages(100, true).batches, active.batches * 5);
});

test('frozen real batches contain 30 varied resource samples and four raw successes/timeouts each minute', () => {
  const batches = generateBatches(20, 10);
  assert.equal(batches.length, 200);
  assert.equal(batches[0].params.samples.length, 30);
  assert.equal(batches[0].params.probes.length, 4);
  assert.ok(batches.some(b => b.params.probes.some(p => p.latencyMs === -1)));
  assert.ok(new Set(batches.flatMap(b => b.params.probes.map(p => p.latencyMs))).size > 10);
  assert.ok(batches.every(b => Buffer.byteLength(b.raw) <= 512 * 1024));
});

test('actual D1 buckets and DO SQL journal survive crash, reconstruction, ACK loss and replay without second booking', { timeout: 180000 }, async () => {
  const report = await runStorageProbe({ scenarios: [{ nodes: 20, minutes: 10 }, { nodes: 100, minutes: 10 }] });
  assert.equal(report.scenarios.length, 2);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.input.sampleCount, scenario.nodes * 10 * 30);
    assert.equal(scenario.input.probeCount, scenario.nodes * 10 * 4);
    assert.equal(scenario.d1Only.checks.acknowledgedRestartReplayNoSecondBooking, true);
    assert.equal(scenario.d1Only.acknowledgedRecovery.persistedStates.length, scenario.nodes);
    assert.ok(scenario.d1Only.acknowledgedRecovery.persistedStates.every(state => state.through === 10));
    assert.equal(scenario.d1Only.acknowledgedRecovery.rawBatchCount, scenario.nodes * 10);
    assert.deepEqual(scenario.d1Only.acknowledgedRecovery.replayAck, scenario.d1Only.acknowledgedRecovery.observedAck);
    assert.ok(scenario.d1Only.d1.categories.acknowledgedResume.rowsRead > 0);
    assert.equal(scenario.d1Only.d1.categories.acknowledgedReplay.rowsWritten, 0);
    assert.deepEqual(scenario.d1Only.reconstructed, scenario.expected);
    assert.deepEqual(scenario.journal.reconstructed, scenario.expected);
    for (const path of [scenario.d1Only, scenario.journal]) {
      assert.equal(path.checks.beforeDurabilityNoAck, true);
      assert.equal(path.checks.atomicRollback, true);
      assert.equal(path.checks.restartedSamePersistedDatabase, true);
      assert.equal(path.checks.ackLostReplayNoSecondBooking, true);
      assert.equal(path.checks.conflictAndGapRejected, true);
      assert.equal(path.checks.rawDistributionRecovered, true);
      assert.ok(path.d1.categories.ingest.rowsWritten > 0);
      assert.ok(path.filesAfter.bytes > path.filesBefore.bytes);
      assert.ok(path.logicalBytes > 0);
    }
    assert.equal(scenario.journal.checks.journalBeforeCheckpoint, true);
    assert.equal(scenario.journal.checks.checkpointCommittedBeforeMarkerReplay, true);
    assert.ok(scenario.journal.doSql.rowsWritten > 0);
    assert.ok(scenario.d1Only.d1.categories.cleanup.rowsWritten > 0);
    assert.ok(scenario.d1Only.d1.categories.replay.rowsWritten === 0);
  }
  const normal = report.scenarios[0].d1Only.daily;
  const first = report.scenarios[0].d1Only.reconstructed[0];
  assert.equal(first.sampleCount, 300);
  assert.equal(first.elapsedMs, 600000);
  assert.equal(first.totalRx, 299299);
  assert.equal(first.totalTx, 149799);
  assert.equal(first.probeCount, 40);
  assert.equal(first.timeoutCount, 4);
  assert.equal(first.distribution.length, 40);
  assert.ok(normal.rowsWritten < 80000);
  assert.equal(normal.rowsWritten, 63360);
  assert.equal(report.scenarios[1].d1Only.daily.rowsWritten, 316800);
  assert.equal(report.scenarios[0].journal.daily.rowsWritten, 17280);
  assert.ok(normal.rowsRead < 4000000);
  assert.ok(normal.retainedLogicalBytes < 400000000);
  assert.equal(report.strategy, 'd1-node-buckets');
});
