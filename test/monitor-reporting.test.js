import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorRuntimeFixture, until, frames, send } from './fixtures/monitor-runtime.mjs';
import { prepareMonitorReporting, readMonitorReporting } from '../src/services/monitorReporting.js';

test('only explicit reporting intent overrides local settings; matching Agent confirmation records applied revision',async t=>{
  const h=await createMonitorRuntimeFixture(t);
  assert.equal(await readMonitorReporting(h.db,'node-a'),null);
  await h.db.batch([prepareMonitorReporting(h.db,'node-a',{collect_interval:0,report_interval:60,wss_report_interval:2,reset_day:31,connection_mode:'auto'},'eth0')]);
  const desired=await readMonitorReporting(h.db,'node-a');assert.equal(desired.persistent.collectIntervalSeconds,0);
  const peer=await h.socket();
  send(peer,'cf.capabilities',{version:1,supports:['cf.report.batch','cf.reporting.configure'].map(method=>({method,version:1}))},'cap');
  await until(()=>frames(peer).some(f=>f.method==='cf.reporting.configure'));
  const job=frames(peer).find(f=>f.method==='cf.reporting.configure');
  assert.equal(job.params.transient.active,false);assert.equal(job.params.transient.reportAfterMs,60000);
  assert.equal(job.params.persistent.sshLoginEnabled,false);
  assert.equal((await h.snapshot()).owners[0][1].reportingApplied,undefined);
  peer.ws.send(JSON.stringify({jsonrpc:'2.0',id:job.id,result:{version:1,revision:job.params.revision,persisted:true,correctionApplied:false}}));
  await until(async()=> (await h.snapshot()).owners[0][1].reportingApplied?.revision===job.params.revision);
  assert.equal((await h.snapshot()).owners[0][1].reportingApplied.persistent.collectIntervalSeconds,0);
  const oldLease=(await h.snapshot()).attachments[0].leaseUntil;
  await new Promise(r=>setTimeout(r,20));await h.control('alarm');
  const current=(await h.snapshot()).attachments[0];
  assert.ok(current.leaseUntil>oldLease);assert.equal(current.authenticated,true);
});

test('backend reporting excludes remote consent/correction and ignores mismatched revision confirmations',async t=>{
  const h=await createMonitorRuntimeFixture(t);
  assert.throws(()=>prepareMonitorReporting(h.db,'node-a',{collect_interval:3,report_interval:60,wss_report_interval:2,reset_day:1,connection_mode:'auto'},''));
  await h.db.batch([prepareMonitorReporting(h.db,'node-a',{collect_interval:2,report_interval:60,wss_report_interval:2,reset_day:1,connection_mode:'auto'},'')]);
  const peer=await h.socket();send(peer,'cf.capabilities',{version:1,supports:['cf.report.batch','cf.reporting.configure'].map(method=>({method,version:1}))},'cap');
  await until(()=>frames(peer).some(f=>f.method==='cf.reporting.configure'));
  const job=frames(peer).find(f=>f.method==='cf.reporting.configure');
  peer.ws.send(JSON.stringify({jsonrpc:'2.0',id:job.id,result:{version:1,revision:'f'.repeat(32),persisted:true,correctionApplied:false}}));
  await until(async()=>!Object.keys((await h.snapshot()).attachments[0].pending).length);
  assert.equal((await h.snapshot()).owners[0][1].reportingApplied,undefined);
  assert.equal(job.params.trafficCorrection,undefined);
  assert.ok(!('terminalEnabled' in job.params.persistent));assert.ok(!('autoUpdate' in job.params.persistent));
});
