import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
// Compile the actual consumer modules, including their real React renderer.
async function consumer(theme, entry) {
  const root = path.resolve('monitor-themes', theme, 'source');
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true,
    platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    alias: { '@': path.join(root, 'src') }, jsx: 'automatic',
    define: { 'import.meta.glob': '__glob', 'import.meta.env': '{}' },
    banner: { js: 'const __glob = () => ({});' },
    plugins: [{ name: 'actual-vue-consumer', setup(b) {
      b.onLoad({ filter: /\.vue$/ }, ({ path: filename }) => {
        const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
        return { contents: compileScript(descriptor, { id: filename, inlineTemplate: true }).content, loader: 'ts', resolveDir: path.dirname(filename) };
      });
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

const node = (overrides = {}) => ({
  id: 1, name: 'consumer-fixture', online: true, cpu_cores: 2, mem_total: 1024,
  disk_total: 2048, metrics: null, os: '', arch: '', virt: '', country: '',
  last_seen: 1, last_seen_ago: 0, traffic_mode: 'sum', traffic_limit: 1024,
  month_rx: null, month_tx: 0, month_used: null, day_rx: null, day_tx: 0,
  total_rx: null, total_tx: 0, price: 0, currency: 'CNY', billing_cycle: 'monthly',
  expires_at: null, expires_in: null, ...overrides,
});

for (const theme of ['default', 'serverstatus', 'jikasei', 'kanso']) {
  const format = await consumer(theme, 'export * from "./src/lib/format";');
  const api = await consumer(theme, 'export {safeNodes} from "./src/lib/api";');
  test(`${theme}: nullable counters must not discard other live metrics`, () => {
    const metrics = Object.fromEntries(['uptime', 'cpu', 'mem_total', 'mem_used', 'disk_total', 'disk_used', 'swap_total', 'swap_used', 'net_rx', 'net_tx', 'tcp', 'udp', 'procs'].map(k => [k, 0]));
    Object.assign(metrics, { load: [0, 0, 0], total_rx: null, total_tx: 0, month_rx: null, month_tx: 0 });
    assert.deepEqual(api.safeNodes([node({ metrics, cpu_name: '' })])[0].metrics, metrics);
  });
  test(`${theme}: byte formatter distinguishes unknown, zero and known`, () => {
    assert.equal(format.bytes(null), '—');
    assert.equal(format.bytes(undefined), '—');
    assert.equal(format.bytes(0), '0 B');
    assert.equal(format.bytes(1024), '1.00 KB');
    assert.equal(format.pair(null, 1024), '— / 1.00 KB');
    assert.equal(format.percent(null, 1024), null);
    assert.equal(format.percent(0, 1024), 0);
    assert.equal(format.percent(512, 1024), 50);
    assert.equal(format.monthUsage({ month_rx: null, month_tx: 7, traffic_mode: 'up' }), 7);
    assert.equal(format.monthUsage({ month_rx: null, month_tx: 7, traffic_mode: 'sum' }), null);
    assert.equal(format.monthUsage({ month_rx: 4, month_tx: 7, month_used: null, traffic_mode: 'up' }), null);
    assert.equal(format.monthUsage({ month_rx: 4, month_tx: 7, traffic_mode: 'max' }), 7);
  });
  const loss = await consumer(theme, 'export {bucketLoss} from "./src/lib/loss";');
  test(`${theme}: history bucket keeps source/denominator semantics`, () => {
    assert.equal(loss.bucketLoss({ latency: 0 }, 0), 0);
    assert.equal(loss.bucketLoss({ loss: 100, source: 'legacy-summary/unknown-denominator' }, null), null);
    assert.equal(loss.bucketLoss({ loss: null }, 25), null);
    assert.equal(loss.bucketLoss({ loss: 25 }, 25), 25);
    assert.equal(loss.bucketLoss({ loss: 100 }, 100), 100);
  });
  const view = await consumer(theme, `
    import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {${theme === 'serverstatus' ? 'ServerTable' : 'NodeCard'} as View} from './src/components/${theme === 'serverstatus' ? 'ServerTable' : 'NodeCard'}';
    export const render = node => renderToStaticMarkup(<View node={node} nodes={[node]} group={null} onGroup={()=>{}} onOpen={()=>{}} cardStyle="classic" latencyLines=""/>);
  `);
  test(`${theme}: actual card/table does not present unknown monthly use as zero`, () => {
    const text = n => view.render(n).replace(/<[^>]+>/g, '');
    const html = text(node());
    assert.match(html, /—\s*\/\s*1(?:\.00)?\s*K/);
    assert.doesNotMatch(html, /NaN|undefined%|null%/);
    const zero = text(node({ month_rx: 0, month_used: 0 }));
    assert.match(zero, /0\s*B\s*\/\s*1(?:\.00)?\s*K/);
    assert.match(text(node({ month_rx: 512, month_used: 512 })), /512\s*B\s*\/\s*1(?:\.00)?\s*K/);
  });
  if (theme === 'kanso') {
    const metrics = { cpu: 0, mem_used: 0, mem_total: 1024, disk_used: 0, disk_total: 2048,
      net_rx: 0, net_tx: 0, total_rx: 0, total_tx: 0, month_rx: 512, month_tx: 128 };
    const legacy = node({ month_rx: undefined, month_tx: undefined, month_used: undefined, metrics });
    test('kanso: old-hub monthly fallback preserves every counting mode and measured zero', () => {
      assert.equal(format.monthUsage({ traffic_mode: 'sum', metrics: { month_rx: 512, month_tx: 0 } }), 512);
      for (const [mode, expected] of [['up', 128], ['down', 512], ['sum', 640], ['max', 512]]) {
        const input = { ...legacy, traffic_mode: mode };
        assert.equal(format.monthUsage(input), expected, mode);
        const html = view.render(input);
        assert.ok(html.replace(/<[^>]+>/g, '').includes(format.pair(expected, 1024)), mode);
        assert.ok(html.includes(`style="width:${expected / 1024 * 100}%"`), `${mode} quota progress`);
        const zero = { ...input, metrics: { ...metrics, month_rx: 0, month_tx: 0 } };
        assert.equal(format.monthUsage(zero), 0, `${mode} measured zero`);
        assert.ok(view.render(zero).replace(/<[^>]+>/g, '').includes('0 B / 1.00 KB'), `${mode} zero card`);
      }
    });
    test('kanso: top-level monthly values and explicit unknown outrank live fallback', () => {
      for (const mode of ['up', 'down', 'sum', 'max']) {
        const input = { ...legacy, traffic_mode: mode };
        assert.equal(format.monthUsage({ ...input, month_rx: null, month_tx: null }), null, `${mode} explicit null`);
        assert.equal(format.monthUsage({ ...input, month_used: null }), null, `${mode} authoritative used null`);
        assert.equal(format.monthUsage({ ...input, month_used: 0 }), 0, `${mode} authoritative used zero`);
        assert.equal(format.monthUsage({ ...input, month_used: 7 }), 7, `${mode} authoritative used known`);
        const zero = { ...input, month_rx: 0, month_tx: 0 };
        assert.equal(format.monthUsage(zero), 0, `${mode} top-level zero`);
        const unknown = view.render({ ...input, month_used: null });
        assert.ok(unknown.replace(/<[^>]+>/g, '').includes('— / 1.00 KB'), `${mode} unknown card`);
        assert.doesNotMatch(unknown, /NaN|undefined%|null%/);
        const topUnknown = view.render({ ...input, month_rx: null, month_tx: null });
        assert.ok(topUnknown.replace(/<[^>]+>/g, '').includes('— / 1.00 KB'), `${mode} top-level unknown card`);
        assert.doesNotMatch(topUnknown, /style="width:(?:12\.5|50|62\.5)%"/);
      }
      const mixed = { ...legacy, month_rx: 64 };
      assert.equal(format.monthUsage({ ...mixed, traffic_mode: 'sum' }), 192);
      assert.equal(format.monthUsage({ ...mixed, traffic_mode: 'down' }), 64);
      assert.equal(format.monthUsage({ ...legacy, month_tx: 32, traffic_mode: 'up' }), 32);
      assert.equal(format.monthUsage({ ...legacy, month_rx: 64, month_tx: 32, traffic_mode: 'max' }), 64);
      assert.equal(format.monthUsage({ ...legacy, month_rx: null, traffic_mode: 'sum' }), null);
      assert.equal(format.monthUsage({ ...legacy, month_rx: null, traffic_mode: 'max' }), null);
      assert.equal(format.monthUsage({ ...legacy, month_rx: null, traffic_mode: 'down' }), null);
      assert.equal(format.monthUsage({ ...legacy, month_rx: null, traffic_mode: 'up' }), 128);
      assert.equal(format.monthUsage({ ...legacy, month_tx: null, traffic_mode: 'up' }), null);
      assert.equal(format.monthUsage({ ...legacy, month_tx: null, traffic_mode: 'down' }), 512);
    });
  }
}

const summary = await consumer('jikasei', 'export * from "./src/lib/summary"; export * from "./src/lib/today-traffic";');
test('JIKASEI: mixed fleet and daily ordering preserve unknown totals', () => {
  assert.equal(summary.summarize([node(), node({ day_rx: 20 })]).dayRx, null);
  assert.equal(summary.summarize([node({ day_rx: 0 })]).dayRx, 0);
  assert.equal(summary.summarize([node({ day_rx: 20 })]).dayRx, 20);
  assert.equal(summary.trafficTotal(node()), null);
  assert.equal(summary.trafficTotal(node({ day_rx: 20, day_tx: 10 })), 30);
});

for (const theme of ['jikasei', 'kanso']) {
  const tooltip = await consumer(theme, `
    import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {PingTooltip} from './src/components/ChartTooltip';
    export const render = (loss, latency=0) => renderToStaticMarkup(<PingTooltip active label={1000} rowByTs={new Map([[1000,{t1:latency,l1:loss}]])} probes={[{id:1,name:'probe'}]} smooth={false} style={()=>({stroke:'red'})}/>);
  `);
  test(`${theme}: real ping tooltip distinguishes unknown denominator and 0ms success`, () => {
    assert.match(tooltip.render(null), /0 ms.*丢包未知/s);
    assert.doesNotMatch(tooltip.render(0), /未知|无响应/);
    assert.match(tooltip.render(25, 10), /25%/);
    assert.match(tooltip.render(100, null), /无响应.*100%/s);
  });
}

for (const theme of ['naive', 'glassmorphism']) {
  const mapping = await consumer(theme, 'export * from "./src/monitor/mapping";');
  const helper = await consumer(theme, 'export * from "./src/utils/helper";');
  test(`${theme}: real mapping and byte formatters retain unknown traffic`, () => {
    const mapped = mapping.mapNode(node()).status;
    assert.equal(theme === 'naive' ? mapped.net_total_down : mapped.traffic_down, null);
    assert.equal(helper.formatBytes(null), '—');
    assert.deepEqual(helper.formatBytesSplit(null), { value: '—', unit: '' });
    assert.equal(helper.formatBytes(0), '0 B');
  });
  const traffic = await consumer(theme, 'export * from "./src/utils/traffic";');
  test(`${theme}: mixed summary, direction and authoritative monthly use`, () => {
    assert.equal(traffic.sumKnown([7, null]), null);
    assert.equal(traffic.sumKnown([7, 0]), 7);
    assert.equal(traffic.trafficUsage(7, null, 'up'), 7);
    assert.equal(traffic.trafficUsage(7, null, 'sum'), null);
    assert.equal(traffic.trafficUsage(7, 3, 'max', null), null);
    assert.equal(traffic.trafficUsage(7, 3, 'max'), 7);
  });
  const progress = await consumer(theme, `
    import {createSSRApp,h} from 'vue'; import {renderToString} from 'vue/server-renderer';
    import Progress from './src/components/TrafficProgress.vue';
    export const render = (upload,download) => renderToString(createSSRApp({render:()=>h(Progress,{upload,download,trafficLimit:1024,trafficLimitType:'sum',showIndicator:true})}));
  `);
  test(`${theme}: actual quota component distinguishes unknown from zero`, async () => {
    const unknown = await progress.render(null, 0);
    assert.match(unknown.replace(/<[^>]+>/g, ''), /—.*—\s*\/\s*1/s);
    assert.doesNotMatch(unknown, /NaN|Infinity/);
    assert.match(await progress.render(0, 0), /0\.0%/);
    assert.match(await progress.render(512, 0), /50\.0%/);
  });
  const transport = await consumer(theme, 'export * from "./src/monitor/transport";');
  test(`${theme}: actual history input distinguishes omitted healthy bucket from legacy summary`, async t => {
    let input;
    t.mock.method(globalThis, 'fetch', async () => Response.json(input));
    for (const [id, point, windowLoss, expected] of [
      [2001, { latency: 0 }, 0, 0],
      [2002, { latency: 10, loss: 100, source: 'legacy-summary/unknown-denominator' }, null, null],
    ]) {
      input = { metrics: [], ping: [{ ts: 1, task_id: 1, ...point }], probes: { 1: 'probe' }, loss: { 1: windowLoss } };
      if (transport.acceptFrame) transport.acceptFrame({ nodes: [node({ id })] });
      else transport.acceptNodes([node({ id })]);
      const output = await transport.records({ uuid: String(id), hours: 1 }, true);
      assert.equal(output.records[0].monitor_bucket_loss, expected);
    }
  });
  for (const loss of [null, 0, 25, 100]) {
    test(`${theme}: real history adapter preserves window/bucket loss ${loss}`, async (t) => {
      const input = { metrics: [], ping: [{ ts: 1, task_id: 1, latency: loss === 100 ? null : 0, loss }], probes: { 1: 'probe' }, loss: { 1: loss } };
      t.mock.method(globalThis, 'fetch', async () => Response.json(input));
      const n = node({ id: 1000 + (loss ?? -1) });
      if (transport.acceptFrame) transport.acceptFrame({ nodes: [n] });
      else transport.acceptNodes([n]);
      const output = await transport.records({ uuid: String(n.id), hours: 1 }, true);
      assert.equal(output.tasks[0].loss, loss);
      if (theme === 'glassmorphism') {
        assert.equal(output.records[0].monitor_window_loss, loss);
        assert.equal(output.records[0].monitor_bucket_loss, loss);
      }
      assert.equal(output.records[0].value, loss === 100 ? -1 : 0);
    });
  }
}

const glassStats = await consumer('glassmorphism', 'export {buildStats} from "./src/composables/useNodePingStats";');
test('Glass real card history summary retains an unknown denominator', () => {
  for (const loss of [null, 0, 25, 100]) {
    const record = { client: '1', task_id: 1, time: '2026-11-26T00:00:00Z', value: loss === 100 ? -1 : 0, monitor_window_loss: loss, monitor_bucket_loss: loss };
    const result = glassStats.buildStats([record]);
    assert.equal(result.avgLoss, loss);
    assert.equal(result.history.at(-1).loss, loss);
    if (loss !== 100) assert.equal(result.avgLatency, 0);
  }
});
