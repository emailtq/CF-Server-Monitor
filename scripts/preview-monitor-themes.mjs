import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHistoryTableSql } from '../src/utils/historyFields.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { generateToken } from '../src/middleware/auth.js';
import { hashPassword } from '../src/utils/common.js';
import { installMonitorTheme } from '../src/services/monitorThemePackages.js';
import { selectMonitorTheme } from '../src/services/monitorThemes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const theme = process.argv[2] || 'default';
if (!['default', 'serverstatus'].includes(theme) && !theme.endsWith('.tar.gz')) throw new Error('usage: node scripts/preview-monitor-themes.mjs [default|serverstatus|path/to/theme.tar.gz] [port]');
const host = '127.0.0.1.localhost';
const adminSettings = { is_public: 'true', username: 'preview', password: await hashPassword('preview-only'), jwt_secret: 'ephemeral-monitor-theme-fixture-authority' };
const adminToken = await generateToken({}, adminSettings);
const bundle = await build({ stdin: { resolveDir: root, contents: `
    import worker, { MetricsBroadcaster } from './src/index.js';
    export class PreviewHub extends MetricsBroadcaster {}
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/_fixture/admin') {
        return new Response('<!doctype html><script>localStorage.setItem("jwt_token",'+JSON.stringify(env.FIXTURE_ADMIN_TOKEN)+');localStorage.setItem("language_preference",'+JSON.stringify(url.searchParams.get('lang') === 'en' ? 'en' : 'zh')+');location.replace("/admin#/admin?tab=themeStore")</script>', {headers:{'Content-Type':'text/html','Cache-Control':'no-store'}});
      }
      if (url.pathname === '/theme') return Response.json({themes:[],schema:1});
      return worker.fetch(request, env, ctx);
    } };
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] });
const contentTypes = { html: 'text/html; charset=utf-8', js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' };
const assets = async request => {
  const pathname = new URL(request.url).pathname.replace(/^\/+/, '');
  const file = path.resolve(root, 'dist', pathname);
  if (!file.startsWith(path.resolve(root, 'dist') + path.sep)) return new Response('Not Found', { status: 404 });
  try {
    const body = await fs.readFile(file);
    const ext = path.extname(file).slice(1);
    return new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': contentTypes[ext] || 'application/octet-stream' } });
  } catch { return new Response('Not Found', { status: 404 }); }
};
const mf = new Miniflare({ ...(process.argv[3] ? { port: Number(process.argv[3]) } : {}), modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'monitor-theme-preview' }, durableObjects: { METRICS_BROADCASTER: { className: 'PreviewHub', useSQLite: true } }, serviceBindings: { ASSETS: assets }, bindings: { MONITOR_COMPAT_HOST: host, MONITOR_COMPAT_THEME: ['default', 'serverstatus'].includes(theme) ? theme : 'default', FIXTURE_ADMIN_TOKEN: adminToken } });
const db = await mf.getD1Database('DB');
const now = Math.floor(Date.now() / 1000) * 1000;
await db.batch([
  db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'),
  db.prepare(`CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, sort_order INTEGER DEFAULT 0, is_hidden TEXT DEFAULT '0', server_group TEXT, region TEXT, history_partition_id INTEGER, timestamp INTEGER DEFAULT 0, price TEXT DEFAULT '8.25', currency TEXT DEFAULT '¥', billing_cycle TEXT DEFAULT 'quarter', expire_date TEXT DEFAULT '2028-01-15', traffic_limit TEXT DEFAULT '2.5', traffic_calc_type TEXT DEFAULT 'ul', reset_day INTEGER DEFAULT 7)`),
  db.prepare(createHistoryTableSql('metrics_history')),
  db.prepare("INSERT INTO settings VALUES ('site_options', ?)").bind(JSON.stringify(adminSettings)),
  db.prepare("INSERT INTO settings VALUES ('appearance_options', '{\"site_title\":\"Monitor preview\"}')"),
  db.prepare("INSERT INTO servers (id,name,sort_order,server_group,region,history_partition_id,timestamp) VALUES ('preview-node','Preview node',1,'Demo','US',20,?)").bind(now),
  db.prepare(`INSERT INTO metrics_history (id,server_id,timestamp,cpu,load_avg,ram_total,ram_used,swap_total,swap_used,disk_total,disk_used,net_in_speed,net_out_speed,net_rx,net_tx,net_rx_monthly,net_tx_monthly,processes,tcp_conn,udp_conn,cpu_cores,cpu_info,os,arch,kernel_version,boot_time,agent_version,region) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(buildHistoryId(20, now), 'preview-node', now, 18.5, '0.3 0.2 0.1', 2048, 512, 128, 32, 51200, 12000, 4, 8, 123456, 654321, 11111, 22222, 44, 12, 3, 4, 'Preview CPU', 'Debian 12', 'x86_64', '6.1', now - 3600_000, 'preview-1.0', 'US')
]);
if (theme.endsWith('.tar.gz')) {
  const installed = await installMonitorTheme({ DB: db }, new Blob([await fs.readFile(path.resolve(theme))]).stream());
  await selectMonitorTheme(db, installed.short);
  console.log(`Installed original package ${installed.short} ${installed.version}`);
}
const broadcaster = await mf.getDurableObjectNamespace('METRICS_BROADCASTER');
const hub = broadcaster.get(broadcaster.idFromName('global'));
const sample = {
  cpu: 22.5, load: [0.4, 0.3, 0.2], ram_total: 2048, ram_used: 540, swap_total: 128, swap_used: 32,
  disk_total: 51200, disk_used: 12000, net_in_speed: 14, net_out_speed: 21, tcp_conn: 13, udp_conn: 4, processes: 46,
  boot_time: String(now - 3600_000), cpu_cores: 4, cpu_info: 'Preview CPU', os: 'Debian 12', arch: 'x86_64', kernel_version: '6.1',
  agent_version: 'preview-1.0', region: 'US', net_rx: 123456, net_tx: 654321, net_rx_monthly: 11111, net_tx_monthly: 22222
};
const doSeed = await hub.fetch('http://internal/batch-push', {
  method: 'POST',
  body: JSON.stringify({ latestReportOnly: true, updates: [{ serverId: 'preview-node', samples: [{ ts: now + 1000, data: sample }] }] })
});
if (!doSeed.ok) throw new Error(`DO preview seed failed (${doSeed.status}): ${await doSeed.text()}`);
const doSnapshot = await hub.fetch('http://internal/latest-report-updates', {
  method: 'POST', body: JSON.stringify({ serverIds: ['preview-node'] })
});
const updates = await doSnapshot.json();
if (updates.updates?.[0]?.samples?.[0]?.data?.cpu !== 22.5) {
  throw new Error(`DO preview data did not seed correctly: ${JSON.stringify(updates)}`);
}
const previewResponse = await mf.dispatchFetch(`http://${host}/api/nodes`);
const previewBody = await previewResponse.json();
const previewNode = previewBody.nodes?.[0];
if (previewResponse.status !== 200 || previewNode?.metrics?.cpu !== 22.5 ||
    previewNode.metrics.net_rx !== 14 || previewNode.metrics.net_tx !== 21) {
  throw new Error(`Monitor preview did not consume DO data: ${JSON.stringify(previewBody)}`);
}
const url = await mf.ready;
console.log(`Monitor ${theme} preview: http://${host}:${url.port}/`);
console.log(`Theme management (local-only auto-login): http://${host}:${url.port}/_fixture/admin`);
console.log(`Unmatched CF host / authenticated preview: http://localhost:${url.port}/_fixture/admin`);
console.log('API: /api/me  /api/nodes  /api/nodes/1/metrics  /api/ws');
console.log('Stop with Ctrl+C. State is ephemeral and held in memory.');
const refresh = setInterval(() => {
  hub.fetch('http://internal/batch-push', {
    method: 'POST',
    body: JSON.stringify({ latestReportOnly: true, updates: [{ serverId: 'preview-node', samples: [{ ts: Date.now(), data: sample }] }] })
  }).catch(() => {});
}, 10_000);
process.on('SIGINT', async () => {
  clearInterval(refresh);
  await mf.dispose();
  process.exit(0);
});
await new Promise(() => {});
