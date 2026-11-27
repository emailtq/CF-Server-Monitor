import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMonitorNode, projectMonitorHistory, stringifyMonitor } from '../src/services/monitorProjection.js';

test('a node without traffic baseline keeps day and month unknown on the wire', () => {
  const persisted = { timestamp: 1, monitor: {} };
  const node = JSON.parse(stringifyMonitor(projectMonitorNode(
    { server: { id: 'legacy-only' }, id: 6, persisted }, { display: { showTraffic: true } }, 1_000
  )));

  assert.deepEqual(
    [node.day_rx, node.day_tx, node.month_rx, node.month_tx, node.month_used],
    [null, null, null, null, null]
  );
  assert.deepEqual(node.traffic_source, {
    total: 'unknown', month: 'unknown', month_precision: 'unknown', day: 'unknown'
  });
});

test('a history window with no known attempt denominator keeps loss unknown', () => {
  const history = projectMonitorHistory({
    step: 60,
    resourceBuckets: [],
    probeSeries: [{ taskId: 1, name: 'Loopback TCP', attempts: 0, timeouts: 0, samples: [] }],
    coverage: { legacyProbeDenominator: 'unknown' }
  });

  assert.equal(history.loss['1'], null);
  assert.equal(history.coverage.legacyProbeDenominator, 'unknown');
});
