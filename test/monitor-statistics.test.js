import test from 'node:test';
import assert from 'node:assert/strict';

const statistics = await import('../src/services/monitorStatistics.js').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const call = (name, ...args) => {
  assert.equal(typeof statistics[name], 'function', `${name} must be implemented`);
  return statistics[name](...args);
};
const at = Date.UTC(2026, 10, 24, 12);
const reading = (rx, observedAt = at, epoch = 'kernel/a') => ({epoch, rx, tx:'0', observedAt, dayStart:'2026-11-24', monthStart:'2026-11-01'});

test('original decimal tokens retain a one-byte delta beyond Number precision', () => {
  const first = call('reduceTrafficLedger', null, reading('9007199254740992'));
  const next = call('reduceTrafficLedger', first, reading('9007199254740993', at + 1000));
  assert.equal(next.totalRx, '1');
  assert.equal(next.dayRx, '1');
  for (const rx of ['-1','9223372036854775808','1.0',9007199254740992]) assert.throws(() => call('reduceTrafficLedger', next, reading(rx)));
});

test('native epochs, drops, late samples and saturation never invent traffic', () => {
  let state = null;
  const series = [['100',at,'k/a'],['110',at+1000,'k/a'],['5',at+2000,'k/a'],['9',at+3000,'k/a'],['50',at+4000,'z/a'],['51',at+5000,'z/a'],['300',at+2000,'k/a']];
  const totals = series.map(([rx,ts,epoch]) => (state = call('reduceTrafficLedger',state,reading(rx,ts,epoch))).totalRx);
  assert.deepEqual(totals,['0','10','10','14','14','15','15']);
  assert.equal(state.rx,'51');
  const saturated = call('reduceTrafficLedger',{...state,totalRx:'9223372036854775806'},reading('100',at+6000,'z/a'));
  assert.equal(saturated.totalRx,'9223372036854775807');
});

test('standard unseen kernel reboot exception is distinct from native rebaselining', () => {
  const first = call('reduceTrafficLedger',null,reading('100'));
  const reboot = {...reading('25',at+60000,'new/a'), source:'standard',bootedAt:at+1000,lastSeen:at};
  assert.equal(call('reduceTrafficLedger',first,reboot).totalRx,'25');
  assert.equal(call('reduceTrafficLedger',first,{...reboot,epoch:'kernel/b'}).totalRx,'0');
  assert.equal(call('reduceTrafficLedger',first,{...reboot,source:'cf-batch'}).totalRx,'0');
});

test('calendar periods clamp reset days 29–31 including leap February and hub timezone', () => {
  for (const resetDay of [29,30,31]) {
    assert.equal(call('trafficCalendar',Date.UTC(2026,1,28,12),{resetDay,timeZone:'UTC'}).monthStart,'2026-02-28');
    assert.equal(call('trafficCalendar',Date.UTC(2028,1,29,12),{resetDay,timeZone:'UTC'}).monthStart,'2028-02-29');
  }
  assert.deepEqual(call('trafficCalendar',Date.UTC(2026,10,23,16),{resetDay:1,timeZone:'Asia/Shanghai'}),{dayStart:'2026-11-24',monthStart:'2026-11-01'});
  assert.equal(call('trafficCalendar',Date.UTC(2026,0,10),{resetDay:15,timeZone:'UTC'}).monthStart,'2025-12-15');
});

test('held readings keep their own day; corrected periods are not rolled backward', () => {
  const base = call('reduceTrafficLedger',null,{...reading('100'),dayStart:'2026-11-23'});
  const held = call('reduceTrafficLedger',base,{...reading('110',at+1000),dayStart:'2026-11-23'});
  const next = call('reduceTrafficLedger',held,reading('115',at+2000));
  assert.deepEqual([held.dayRx,next.dayRx,next.totalRx],['10','5','15']);
  const corrected = {...held,dayStart:'2026-11-24',dayRx:'80'};
  assert.equal(call('reduceTrafficLedger',corrected,{...reading('120',at+3000),dayStart:'2026-11-23',today:'2026-11-24'}).dayRx,'90');
});

test('hub independent counter drop and reset-day edits preserve supported period meaning', () => {
  const previous = {...call('reduceTrafficLedger',null,reading('100')),monthStart:'2026-11-20',monthRx:'800',tx:'10'};
  const next = call('reduceTrafficLedger',previous,{...reading('110',at+1000),tx:'5',resetDay:1});
  assert.equal(next.totalRx,'10');
  assert.equal(next.totalTx,'0');
  assert.equal(next.monthStart,'2026-11-01');
  assert.equal(next.monthRx,'10');
});

test('all total/day/month directions saturate and future correction stamps do not pin periods', () => {
  const max='9223372036854775807';
  const previous=call('reduceTrafficLedger',null,reading('100'));
  const nearMax={...previous,totalRx:max,totalTx:max,dayRx:max,dayTx:max,monthRx:max,monthTx:max};
  const next=call('reduceTrafficLedger',nearMax,{...reading('101',at+1000),tx:'1'});
  for(const field of ['totalRx','totalTx','dayRx','dayTx','monthRx','monthTx']) assert.equal(next[field],max);
  const corrected=call('reduceTrafficLedger',{...previous,dayStart:'2099-01-01',monthStart:'2099-01-01',dayRx:'999',monthRx:'999'},reading('101',at+1000));
  assert.deepEqual([corrected.dayStart,corrected.monthStart,corrected.dayRx,corrected.monthRx],['2026-11-24','2026-11-01','1','1']);
});

test('minute and hour preserve full count, sums, coverage, peaks and unknowns', () => {
  const samples = Array.from({length:60},(_,i)=>({sampledAt:at+i*1000,elapsedMs:1000,report:{cpu:i===0?100:0},extra:{}}));
  const minute = call('aggregateMinuteSamples',samples);
  assert.equal(minute.count,60);
  assert.equal(minute.fields.cpu.sum,100);
  assert.equal(minute.fields.cpu.max,100);
  assert.equal(minute.fields.cpu.coverageMs,60000);
  assert.ok(Math.abs(minute.fields.cpu.mean-100/60)<1e-10);
  assert.equal(minute.fields.mem_used,undefined);
  const short = call('aggregateMinuteSamples',[{sampledAt:at+60000,elapsedMs:1000,report:{cpu:100},extra:{}}]);
  const hour = call('mergeResourceBuckets',[minute,short]);
  assert.equal(hour.fields.cpu.count,61);
  assert.ok(Math.abs(hour.fields.cpu.mean-200/61)<1e-10);
  const irregular = call('aggregateMinuteSamples',[{sampledAt:at,elapsedMs:1000,report:{cpu:100}}, {sampledAt:at+59000,elapsedMs:59000,report:{cpu:0}}]);
  assert.equal(irregular.fields.cpu.sum,100);
  assert.ok(Math.abs(irregular.fields.cpu.mean-100/60)<1e-10);
});

test('counter-derived network rate measures exact delta across batches, not live speed', () => {
  const samples = [0,1].map(i=>({sampledAt:at+i*2000,elapsedMs:2000,report:{boot_id:'k',net_rx_total:String(9007199254740992n+BigInt(i)),net_tx_total:'0',net_rx:99999},extra:{}}));
  const bucket = call('aggregateMinuteSamples',samples);
  assert.equal(bucket.network.rxBytes,'1');
  assert.equal(bucket.network.coverageMs,2000);
  assert.equal(bucket.network.rxMean,0.5);
  assert.equal(bucket.fields.net_rx.max,99999);
  const continuation = call('aggregateMinuteSamples',[{...samples[1],sampledAt:at+4000,report:{...samples[1].report,net_rx_total:'9007199254740993'}}],{previous:samples[1]});
  assert.equal(continuation.network.coverageMs,2000);
  assert.equal(continuation.network.rxBytes,'0');
});

test('network counter gaps retain all elapsed weights instead of losing the valid baseline', () => {
  const observation=(rx,ts,elapsedMs=2000)=>({sampledAt:ts,elapsedMs,report:rx===null?{cpu:10}:{boot_id:'k',net_rx_total:rx,net_tx_total:'0'},extra:{}});
  const bucket=call('aggregateMinuteSamples',[observation('100',at),observation(null,at+2000),observation('104',at+4000)]);
  assert.equal(bucket.network.rxBytes,'4');
  assert.equal(bucket.network.coverageMs,4000);
  assert.equal(bucket.network.rxMean,1);
  const stepped=call('aggregateMinuteSamples',[observation('100',at),observation(null,at+3600000,1000),observation(null,at+1000,3000),observation('106',at+4000,2000)]);
  assert.equal(stepped.network.rxBytes,'6');
  assert.equal(stepped.network.coverageMs,6000);
  assert.equal(stepped.network.rxMean,1);
});

test('network gaps reset on a known epoch change or counter descent and remain unknown without counters', () => {
  const observation=(rx,ts,epoch='k')=>({sampledAt:ts,elapsedMs:2000,report:rx===null?{boot_id:epoch,cpu:10}:{boot_id:epoch,net_rx_total:rx,net_tx_total:'0'},extra:{}});
  const epoch=call('aggregateMinuteSamples',[observation('100',at),observation(null,at+2000,'new'),observation('104',at+4000,'new'),observation('106',at+6000,'new')]);
  assert.equal(epoch.network.rxBytes,'2');
  assert.equal(epoch.network.coverageMs,2000);
  assert.equal(epoch.network.rxMean,1);
  const changedAway=call('aggregateMinuteSamples',[observation('100',at),observation(null,at+2000,'new'),observation('104',at+4000)]);
  assert.equal(changedAway.network.coverageMs,0);
  assert.equal(changedAway.network.rxMean,null);
  const descent=call('aggregateMinuteSamples',[observation('100',at),observation(null,at+2000),observation('10',at+4000),observation(null,at+6000),observation('14',at+8000)]);
  assert.equal(descent.network.rxBytes,'4');
  assert.equal(descent.network.coverageMs,4000);
  assert.equal(descent.network.rxMean,1);
  const unknown=call('aggregateMinuteSamples',[observation('100',at),observation(null,at+2000)]);
  assert.equal(unknown.network.coverageMs,0);
  assert.equal(unknown.network.rxMean,null);
  const partial=call('aggregateMinuteSamples',[observation('100',at),
    {sampledAt:at+2000,elapsedMs:2000,report:{boot_id:'k',net_tx_total:'0'},extra:{}},observation('104',at+4000)]);
  assert.equal(partial.network.rxBytes,'4');
  assert.equal(partial.network.coverageMs,4000);
  assert.equal(partial.network.rxMean,1);
});

test('late counterless observations cannot accumulate pending weights or reset the active epoch', () => {
  const baseline={sampledAt:at,elapsedMs:2000,report:{boot_id:'k',net_rx_total:'100',net_tx_total:'0'},extra:{}};
  const first=call('reduceNetworkMark',null,baseline).mark;
  const pending=call('reduceNetworkMark',first,{sampledAt:at+1000,elapsedMs:1000,report:{cpu:10},extra:{}}).mark;
  assert.equal(pending.pendingElapsedMs,1000);
  for(const sampledAt of [at-40*86400000,at]) for(const report of [{cpu:10},{cpu:10,boot_id:'old'},{cpu:10,boot_id:'old',net_tx_total:'0'}]) {
    const late={sampledAt,elapsedMs:1000,report,extra:{}};
    const reduced=call('reduceNetworkMark',pending,late);
    assert.equal(reduced.mark,pending);
    assert.equal(reduced.network,null);
    const bucket=call('aggregateMinuteSamples',[baseline,late,{...baseline,sampledAt:at+2000,report:{...baseline.report,net_rx_total:'102'}}]);
    assert.equal(bucket.coverageMs,5000);
    assert.equal(bucket.fields.cpu.coverageMs,1000);
    assert.equal(bucket.network.rxBytes,'2');
    assert.equal(bucket.network.coverageMs,2000);
    assert.equal(bucket.network.rxMean,1);
  }
});

test('raw probe generations retain two successes and timeout with actual loss denominator', () => {
  const probes = [10,20,-1].map((latencyMs,i)=>({taskId:1,metricId:'p_a',sampledAt:at+i*1000,latencyMs}));
  const [series] = call('aggregateProbeSamples',probes);
  assert.deepEqual(series.samples,probes.map(p=>({...p,timeout:p.latencyMs<0})));
  assert.equal(series.attempts,3);
  assert.equal(series.timeouts,1);
  assert.equal(series.mean,15);
  assert.ok(Math.abs(series.loss-100/3)<1e-10);
});
