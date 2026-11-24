import assert from 'node:assert/strict';
import { readMonitorTelemetry } from '../../src/database/monitorTelemetry.js';

export async function readMonitorRecoverySnapshot(db,serverId,window) {
  const [nodes,receipts,buckets]=await db.batch([
    db.prepare('SELECT * FROM monitor_telemetry_nodes WHERE server_id=?').bind(serverId),
    db.prepare('SELECT * FROM monitor_telemetry_receipts WHERE server_id=? ORDER BY token_version,stream,sequence').bind(serverId),
    db.prepare('SELECT * FROM monitor_telemetry_buckets WHERE server_id=? ORDER BY token_version,stream,sequence,part').bind(serverId)
  ]);
  assert.ok([nodes,receipts,buckets].every(r=>r.success));
  return {core:await readMonitorTelemetry(db,serverId,window),nodes:nodes.results,receipts:receipts.results,buckets:buckets.results};
}

export function historicalMonitorFacts(core) {
  const {from,to,step,rawSamples,resourceBuckets,probeSeries,coverage}=core;
  const {sampleCount,probeCount,elapsedMs,firstSampledAt,lastSampledAt}=coverage;
  return {from,to,step,rawSamples,resourceBuckets,probeSeries,coverage:{sampleCount,probeCount,elapsedMs,firstSampledAt,lastSampledAt}};
}

export function assertOriginalMonitorFacts(before,after) {
  assert.deepEqual(historicalMonitorFacts(after.core),historicalMonitorFacts(before.core));
  const key=r=>JSON.stringify([r.token_version,r.stream,r.sequence,r.part ?? null]);
  const receipts=new Set(before.receipts.map(key)),buckets=new Set(before.buckets.map(key));
  assert.deepEqual(after.receipts.filter(r=>receipts.has(key(r))),before.receipts);
  assert.deepEqual(after.buckets.filter(r=>buckets.has(key(r))),before.buckets);
  assert.deepEqual(after.core.traffic,before.core.traffic);
  assert.deepEqual(after.core.latest,before.core.latest);
}
