import { md5Hash } from '../utils/common.js';
import { serializeAgentRpc } from '../shared/monitorAgentProtocol.js';
import { loadSiteSettings, sanitizeUserAgent } from '../utils/settings.js';

export async function readMonitorReporting(db, serverId) {
  const row = await db.prepare('SELECT * FROM servers WHERE id=?').bind(serverId).first();
  if (!row) throw new Error('Node reporting unavailable');
  const stored = await db.prepare('SELECT value FROM settings WHERE key=?').bind('monitor_reporting:' + serverId).first();
  // A node's explicit local collect0 cannot be overwritten by a backend default.
  if (!stored) return null;
  const persistent = {...JSON.parse(stored.value),userAgent:sanitizeUserAgent((await loadSiteSettings(db,{forceRefresh:true})).ua)};
  if (persistent.sshLoginEnabled) throw new Error('Native SSH unavailable');
  const params = {version:1,revision:await md5Hash(JSON.stringify(persistent)),persistent};
  // The service emits only the implemented reporting subset; correction remains unapplied.
  return params;
}

export function prepareMonitorReporting(db, serverId, config, networkInterface) {
  const persistent = {collectIntervalSeconds:config.collect_interval,batchIntervalSeconds:config.report_interval,
    activeReportIntervalSeconds:config.wss_report_interval,resetDay:config.reset_day,interface:networkInterface,
    connectionMode:config.connection_mode,sshLoginEnabled:false,userAgent:'cfsm'};
  serializeAgentRpc({method:'cf.reporting.configure',id:'validate',params:{version:1,revision:'0'.repeat(32),persistent}},
    {senderRole:'hub',receiverRole:'agent',implemented:[{method:'cf.reporting.configure',version:1}],negotiated:[{method:'cf.reporting.configure',version:1}]});
  return db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind('monitor_reporting:' + serverId,JSON.stringify(persistent));
}
