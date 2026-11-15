import { loadNotificationConfig, notificationChannelSettings } from '../database/notifications.js';
import { LOGIN_NOTIFICATION_EVENTS } from '../shared/notificationConfig.js';
import { routeNotificationEvents } from './notificationRouting.js';
import { createNotificationRuleIdentity, matchesNotificationRuleIdentity } from './notificationState.js';
import { getNotificationMessages } from './notificationMessages.js';
import { sendNotification } from './notification.js';
import { AppError } from '../utils/errors.js';

const idPattern = /^[A-Za-z0-9._:-]{1,256}$/;
const sourceStates = ['disabled', 'watching', 'unsupported', 'unavailable', 'permission_denied', 'state_error', 'queue_full', 'rotation_gap'];
const sources = ['', 'auth.log', 'secure', 'journal'];
const isTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;

function validSshAddress(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F:.]{1,64}(?:%[A-Za-z0-9_.:-]{1,32})?$/.test(value)) return false;
  const address = value.split('%')[0];
  if (address.includes(':')) { try { new URL(`http://[${address}]/`); return true; } catch (_) { return false; } }
  const parts = address.split('.');
  return !value.includes('%') && parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function validateSshEventReport(value) {
  if (value === undefined) return null;
  const invalid = () => { throw new AppError('invalid_ssh_events', 400); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version','stream','events','state','source'].includes(key)) || value.version !== 1 || typeof value.stream !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(value.stream) || !sourceStates.includes(value.state) || !sources.includes(value.source) || !Array.isArray(value.events) || value.events.length > 32) invalid();
  let previous = 0;
  const events = value.events.map(event => {
    if (!event || Object.keys(event).some(key => !['sequence','occurredAt','user','address','method'].includes(key)) || !Number.isSafeInteger(event.sequence) || event.sequence <= previous || !isTime(event.occurredAt) || typeof event.user !== 'string' || !/^[^\x00-\x20\x7f]{1,64}$/u.test(event.user) || !validSshAddress(event.address) || !['password','publickey','keyboard-interactive/pam','hostbased','gssapi-with-mic'].includes(event.method)) invalid();
    previous = event.sequence;
    return { sequence: event.sequence, occurredAt: event.occurredAt, user: event.user, address: event.address, method: event.method };
  });
  return { version: 1, stream: value.stream, state: value.state, source: value.source, events };
}

async function eventTargets(config, event) {
  const rules = config.rules.filter(rule => rule.enabled && rule.type === event.type);
  const context = { event: event.type, message: '', client: event.serverId || 'CF Server Monitor' };
  const routed = routeNotificationEvents(config, rules.map(rule => ({ ruleId: rule.id, serverId: event.serverId, scope: event.type === 'panelLogin' ? 'site' : 'node', eventKey: `${event.type}:${event.id}`, msg: '', context })));
  if (!routed.length) return [];
  const signatures = new Map(await Promise.all(rules.map(async rule => [rule.id, (await createNotificationRuleIdentity(rule)).signature])));
  return routed.map(batch => ({ key: batch.deliveryKeys[0], channelId: batch.channelId,
    rules: batch.events[0].ruleIds.map(ruleId => ({ id: ruleId, signature: signatures.get(ruleId) })) }));
}

export async function captureLoginEvent(env, event) {
  try {
    const config = await loadNotificationConfig(env.DB);
    return { ...event, policyRevision: config.revision, targets: await eventTargets(config, event) };
  } catch (_) {
    // Missing policy cannot authorize retrospective recipients after recovery.
    console.error('[Login events] success policy unavailable');
    return { ...event, policyRevision: 0, targets: [] };
  }
}

async function queueStatements(db, config, event, guard = '', guardArgs = []) {
  if (!LOGIN_NOTIFICATION_EVENTS.includes(event.type) || !idPattern.test(event.id) || !isTime(event.occurredAt) || (event.type !== 'panelLogin' && (!event.serverId || !Number.isSafeInteger(event.tokenVersion))) || (event.type === 'terminalConnected' && !Number.isSafeInteger(event.credentialVersion))) throw new AppError('invalid_login_event', 400);
  const payload = { type: event.type, occurredAt: event.occurredAt, ...(event.type === 'sshLogin' ? { user: event.user, address: event.address, method: event.method } : {}) };
  let targets = await eventTargets(config, event);
  if (event.targets) targets = targets.flatMap(target => {
    const saved = event.targets.find(item => item.key === target.key);
    const rules = saved ? target.rules.filter(rule => saved.rules.some(old => old.id === rule.id && old.signature === rule.signature)) : [];
    return rules.length ? [{ ...target, rules }] : [];
  });
  if (event.type === 'sshLogin' && !targets.length) { delete payload.user; delete payload.address; delete payload.method; }
  const authority = event.serverId ? `EXISTS (SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=? AND (? IS NULL OR n.credential_version=?))` : '1';
  return [
    db.prepare(`INSERT OR IGNORE INTO login_events(id,type,server_id,token_version,credential_version,payload,targets,policy_revision,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${authority} ${guard}`).bind(event.id, event.type, event.serverId ?? null, event.tokenVersion ?? null, event.credentialVersion ?? null, JSON.stringify(payload), JSON.stringify(targets), event.policyRevision ?? config.revision, Date.now(), ...(event.serverId ? [event.serverId, event.tokenVersion, event.credentialVersion ?? null, event.credentialVersion ?? null] : []), ...guardArgs),
    db.prepare(`INSERT OR IGNORE INTO login_event_deliveries(delivery_key,event_id,channel_id,rules,updated_at)
      SELECT json_extract(t.value,'$.key'),e.id,json_extract(t.value,'$.channelId'),json_extract(t.value,'$.rules'),e.created_at
      FROM login_events e,json_each(e.targets) t WHERE e.id=? AND EXISTS (
        SELECT 1 FROM json_each(json_extract(t.value,'$.rules')) r WHERE NOT EXISTS (
          SELECT 1 FROM login_event_policy_invalidations i WHERE i.rule_id=json_extract(r.value,'$.id')
          AND i.channel_id=json_extract(t.value,'$.channelId') AND i.revision>e.policy_revision))`).bind(event.id)
  ];
}

export async function queueLoginEvent(env, event) {
  const config = await loadNotificationConfig(env.DB);
  await env.DB.batch(await queueStatements(env.DB, config, event));
}

export async function queuePanelLoginEvent(env, event, ctx) {
  event = await captureLoginEvent(env, event);
  if (env.METRICS_BROADCASTER) {
    try {
      const stub = env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global'));
      const response = await stub.fetch('https://metrics.internal/panel-login-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: event.id, occurredAt: event.occurredAt, policyRevision: event.policyRevision, targets: event.targets }) });
      if (!response.ok) throw new Error('panel_event_unavailable');
      return;
    } catch (_) {}
  }
  await queueLoginEvent(env, event);
  scheduleLoginDelivery(env, ctx);
}

export function recoverPanelLoginEvents(env, ctx) {
  if (!env.METRICS_BROADCASTER) return;
  const stub = env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global'));
  const job = stub.fetch('https://metrics.internal/panel-login-recovery', { method: 'POST' }).catch(() => console.error('[Login events] panel recovery pending'));
  ctx?.waitUntil?.(job);
  return job;
}

export async function sshLoginEnabled(db, serverId, schema) {
  if (schema < 10) return false;
  const config = await loadNotificationConfig(db);
  return config.rules.some(rule => rule.enabled && rule.type === 'sshLogin' && (rule.scope.mode === 'all' || rule.scope.serverIds.includes(serverId)) && rule.targetIds.some(id => config.channels.some(channel => channel.id === id && channel.enabled)));
}

export async function acceptSshEvents(env, node, report) {
  if (!report) return null;
  const db = env.DB, config = report.events.length ? await loadNotificationConfig(db) : null, statements = [];
  statements.push(db.prepare(`INSERT INTO ssh_event_sources(server_id,token_version,state,source,observed_at)
    SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=?)
    ON CONFLICT(server_id) DO UPDATE SET token_version=excluded.token_version,state=excluded.state,source=excluded.source,observed_at=excluded.observed_at`)
    .bind(node.serverId, node.tokenVersion, report.state, report.source, Date.now(), node.serverId, node.tokenVersion));
  for (const event of report.events) {
    const cursorArgs = [node.serverId, node.tokenVersion, report.stream];
    statements.push(...await queueStatements(db, config, { ...event, type: 'sshLogin', serverId: node.serverId, tokenVersion: node.tokenVersion, id: `ssh:${node.serverId}:${node.tokenVersion}:${report.stream}:${event.sequence}` },
      'AND ? > COALESCE((SELECT sequence FROM ssh_event_cursors WHERE server_id=? AND token_version=? AND stream=?),0)', [event.sequence, ...cursorArgs]));
    statements.push(db.prepare(`INSERT INTO ssh_event_cursors(server_id,token_version,stream,sequence)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=?)
      ON CONFLICT(server_id,token_version,stream) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`)
      .bind(...cursorArgs, event.sequence, node.serverId, node.tokenVersion));
  }
  await db.batch(statements);
  const row = await db.prepare('SELECT sequence FROM ssh_event_cursors WHERE server_id=? AND token_version=? AND stream=?').bind(node.serverId, node.tokenVersion, report.stream).first();
  return { stream: report.stream, sequence: row?.sequence || 0 };
}

export async function flushLoginEvents(env, { send } = {}) {
  const db = env.DB, config = await loadNotificationConfig(db);
  // A crashed/timeout sender may already have delivered. Never replay its side effect.
  await db.prepare("UPDATE login_event_deliveries SET state='uncertain',updated_at=? WHERE state='sending' AND updated_at < ?").bind(Date.now(), Date.now() - 60000).run();
  const { results } = await db.prepare(`SELECT d.delivery_key,d.channel_id,e.type,e.server_id,e.token_version,e.credential_version,e.payload,
    (SELECT json_group_array(json(r.value)) FROM json_each(d.rules) r WHERE NOT EXISTS (
      SELECT 1 FROM login_event_policy_invalidations i WHERE i.rule_id=json_extract(r.value,'$.id')
      AND i.channel_id=d.channel_id AND i.revision>e.policy_revision)) AS rules
    FROM login_event_deliveries d JOIN login_events e ON e.id=d.event_id
    WHERE d.state='pending' ORDER BY d.updated_at LIMIT 64`).all();
  for (const row of results) {
    const channel = config.channels.find(channel => channel.id === row.channel_id && channel.enabled);
    const rules = JSON.parse(row.rules);
    let applicable = false;
    if (channel) for (const saved of rules) {
      const rule = config.rules.find(rule => rule.id === saved.id && rule.enabled && rule.type === row.type && rule.targetIds.includes(channel.id));
      if (rule && matchesNotificationRuleIdentity(saved.signature, await createNotificationRuleIdentity(rule))) applicable = true;
    }
    const authority = row.server_id ? await db.prepare(`SELECT s.name FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=? AND (? IS NULL OR n.credential_version=?)`).bind(row.server_id, row.token_version, row.credential_version, row.credential_version).first() : true;
    if (!applicable || !authority) {
      await db.prepare("UPDATE login_event_deliveries SET state='cancelled',updated_at=? WHERE delivery_key=? AND state='pending'").bind(Date.now(), row.delivery_key).run();
      continue;
    }
    const claim = await db.prepare(`UPDATE login_event_deliveries SET state='sending',updated_at=? WHERE delivery_key=? AND state='pending'
      AND EXISTS (SELECT 1 FROM settings WHERE key='notification_config' AND json_extract(value,'$.revision')=?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM terminal_nodes n JOIN servers s ON s.id=n.server_id WHERE n.server_id=? AND n.token_version=? AND (? IS NULL OR n.credential_version=?)))`)
      .bind(Date.now(), row.delivery_key, config.revision, row.server_id, row.server_id, row.token_version, row.credential_version, row.credential_version).run();
    if (!claim.meta.changes) continue;
    const payload = JSON.parse(row.payload), messages = getNotificationMessages({ notification_language: config.language });
    const label = messages.events[row.type];
    const client = authority?.name || row.server_id || 'CF Server Monitor';
    const msg = row.type === 'sshLogin' ? `${client} · ${payload.user} · ${payload.address} · ${payload.method}` : client;
    const context = { event: label, message: msg, client, time: new Intl.DateTimeFormat(config.language, { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(payload.occurredAt) };
    let success = false;
    try { success = !(await (send ? send(channel, msg, context) : sendNotification(notificationChannelSettings(channel, config), msg, context, { attempts: 1, signal: AbortSignal.timeout(8000) }))); } catch (_) {}
    await db.prepare("UPDATE login_event_deliveries SET state=?,updated_at=? WHERE delivery_key=? AND state='sending'").bind(success ? 'sent' : 'uncertain', Date.now(), row.delivery_key).run();
  }
}

export function scheduleLoginDelivery(env, ctx) {
  const job = flushLoginEvents(env).catch(() => console.error('[Login events] delivery pending'));
  ctx?.waitUntil?.(job);
  return job;
}
