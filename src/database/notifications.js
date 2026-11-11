import {
  assertNotificationObject, notificationConfigError, notificationSecretFields, validateNotificationSecrets,
  validateNotificationConfig, maskNotificationConfig, migrateLegacyNotifications, NOTIFICATION_CONFIG_MAX_BYTES
} from '../shared/notificationConfig.js';
import { LEGACY_NOTIFICATION_FIELDS } from '../utils/settings.js';
import { validateNotificationTransport } from '../services/notification.js';

const KEY = 'notification_config';

async function legacySettings(db) {
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key = 'site_options' OR key IN (${LEGACY_NOTIFICATION_FIELDS.map(() => '?').join(',')})`).bind(...LEGACY_NOTIFICATION_FIELDS).all();
  const legacy = {};
  for (const row of results) if (row.key !== 'site_options') legacy[row.key] = row.value;
  const site = results.find(row => row.key === 'site_options');
  if (site) {
    try {
      const parsed = JSON.parse(site.value);
      for (const key of LEGACY_NOTIFICATION_FIELDS) if (Object.hasOwn(parsed, key)) legacy[key] = parsed[key];
    } catch (_) { throw notificationConfigError(); }
  }
  return legacy;
}

async function snapshot(db, siteSettings, enumerateServers = true) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first();
  const { results } = enumerateServers ? await db.prepare('SELECT id FROM servers').all() : { results: [] };
  const serverIds = new Set(results.map(row => String(row.id)));
  let raw;
  if (row) {
    try { raw = JSON.parse(row.value); } catch (_) { throw notificationConfigError(); }
  } else raw = migrateLegacyNotifications(siteSettings ?? await legacySettings(db));
  if (!row) {
    for (const c of raw.channels) if (c.enabled) {
      try { notificationChannelSettings(c, raw); } catch (_) { c.enabled = false; }
    }
    for (const r of raw.rules) if (!r.targetIds.some(id => raw.channels.some(c => c.id === id && c.enabled))) r.enabled = false;
  }
  const config = validateNotificationConfig(raw, { previousConfig: raw, validateServerReferences: false });
  for (const c of config.channels) if (c.enabled) notificationChannelSettings(c, config);
  return { config, serverIds, value: row?.value ?? null };
}

export async function loadNotificationConfig(db, siteSettings) {
  return (await snapshot(db, siteSettings, false)).config;
}

function mergeChannel(raw, current, updates = {}) {
  assertNotificationObject(raw, ['id', 'name', 'type', 'enabled', 'config', 'secrets', 'template', 'secretFields', 'clearSecrets']);
  const old = raw.id === undefined ? null : current.channels.find(c => c.id === raw.id);
  if (raw.id !== undefined && !old) throw notificationConfigError();
  if (old && old.type !== raw.type) throw notificationConfigError();
  const fields = notificationSecretFields(raw.type);
  const clear = raw.clearSecrets === undefined ? [] : raw.clearSecrets;
  if (!Array.isArray(clear) || new Set(clear).size !== clear.length || clear.some(field => !fields.includes(field))) throw notificationConfigError();
  const inline = validateNotificationSecrets(raw.type, raw.secrets === undefined ? {} : raw.secrets);
  const replacements = validateNotificationSecrets(raw.type, updates);
  if (clear.some(field => Object.hasOwn(inline, field) || Object.hasOwn(replacements, field))) throw notificationConfigError();
  const secrets = { ...old?.secrets, ...inline, ...replacements };
  for (const field of clear) delete secrets[field];
  const { clearSecrets, ...channel } = raw;
  return { ...channel, id: old?.id ?? `channel_${crypto.randomUUID()}`, secrets };
}

export function notificationChannelSettings(channel, config) {
  const settings = { notification_template: channel.template, notification_timezone: config.timezone, notification_language: config.language, notification_webhook_enabled: 'false', tg_chat_id: channel.config.chatId || '' };
  if (channel.type === 'webhook') {
    Object.assign(settings, { notification_webhook_enabled: 'true', notification_webhook_url: channel.secrets.url,
      notification_webhook_headers: channel.secrets.headers || '', notification_webhook_method: channel.config.method || 'POST',
      notification_webhook_format: channel.config.format || 'json', notification_webhook_body: channel.config.body ?? '' });
  } else if (channel.type === 'smtp') {
    try {
      const c = channel.config;
      const url = new URL(`smtp://${c.host}`);
      url.port = String(c.port || (c.secure === 'tls' ? 465 : 587));
      url.username = encodeURIComponent(c.username || '');
      url.password = encodeURIComponent(channel.secrets.password || '');
      url.searchParams.set('from', c.from || c.username || '');
      url.searchParams.set('to', c.to || '');
      url.searchParams.set('secure', c.secure || 'auto');
      settings.tg_bot_token = url.toString();
    } catch (_) { throw notificationConfigError(); }
  } else settings.tg_bot_token = channel.secrets[channel.type === 'telegram' ? 'botToken' : 'token'];
  try { validateNotificationTransport(settings); } catch (_) { throw notificationConfigError(); }
  return settings;
}

export async function prepareNotificationChannel(db, raw) {
  if (typeof raw?.enabled !== 'boolean') throw notificationConfigError();
  const state = await snapshot(db);
  const c = mergeChannel(raw, state.config);
  const checked = validateNotificationConfig({ ...state.config, channels: [{ ...c, enabled: true }], rules: [] }, { serverIds: state.serverIds });
  notificationChannelSettings(checked.channels[0], checked);
  return { channel: checked.channels[0], config: checked };
}

export async function saveNotificationConfig(db, input) {
  assertNotificationObject(input, ['expectedRevision', 'schema', 'revision', 'channels', 'rules', 'secretUpdates', 'timezone', 'language']);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER - 1 || (input.schema !== undefined && input.schema !== 1) || (input.revision !== undefined && input.revision !== input.expectedRevision)) throw notificationConfigError();
  if (new TextEncoder().encode(JSON.stringify(input)).length > NOTIFICATION_CONFIG_MAX_BYTES) throw notificationConfigError();
  const state = await snapshot(db);
  if (state.config.revision !== input.expectedRevision) throw notificationConfigError('notification_revision_conflict', 409);
  if (!Array.isArray(input.channels) || input.channels.length > 64) throw notificationConfigError();
  const updates = input.secretUpdates === undefined ? {} : input.secretUpdates;
  assertNotificationObject(updates, state.config.channels.map(c => c.id));
  if (Object.keys(updates).some(key => !input.channels.some(c => c?.id === key))) throw notificationConfigError();
  for (const [channelId, secrets] of Object.entries(updates)) validateNotificationSecrets(state.config.channels.find(c => c.id === channelId).type, secrets);
  const channels = input.channels.map(raw => mergeChannel(raw, state.config, Object.hasOwn(updates, raw?.id) ? updates[raw.id] : {}));
  const ids = new Set(channels.map(c => c.id));
  if (state.value !== null && state.config.rules.some(r => r.targetIds.some(target => !ids.has(target)))) throw notificationConfigError('notification_channel_referenced', 409);
  const config = validateNotificationConfig({ schema: 1, revision: input.expectedRevision + 1, channels, rules: input.rules, timezone: input.timezone === undefined ? state.config.timezone : input.timezone, language: input.language === undefined ? state.config.language : input.language }, { serverIds: state.serverIds, previousConfig: state.config });
  for (const r of config.rules) {
    const old = state.config.rules.find(previous => previous.id === r.id && previous.type === r.type);
    if (r.enabled && !old?.enabled && r.scope.serverIds.some(id => !state.serverIds.has(id))) throw notificationConfigError();
  }
  for (const c of config.channels) if (c.enabled) notificationChannelSettings(c, config);
  await persistNotificationConfig(db, config, state.value);
  return maskNotificationConfig(config);
}

async function persistNotificationConfig(db, config, previousValue) {
  const result = await notificationConfigStatement(db, config, previousValue).run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw notificationConfigError('notification_revision_conflict', 409);
}

function notificationConfigStatement(db, config, previousValue) {
  // Compare the full snapshot, not only revision: secret merge/clear is protected by this same SQL CAS.
  return db.prepare(`INSERT INTO settings (key, value) SELECT ?, ?
    WHERE ? IS NULL OR EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value = ?`).bind(KEY, JSON.stringify(config), previousValue, KEY, previousValue, previousValue);
}

export function validateNotificationBackup(raw) {
  const config = validateNotificationConfig(raw, { previousConfig: raw, validateServerReferences: false });
  for (const c of config.channels) if (c.enabled) notificationChannelSettings(c, config);
  return config;
}

export async function importNotificationConfig(db, raw, serverIdMap = new Map()) {
  const imported = validateNotificationBackup(raw);
  const state = await snapshot(db);
  const channelIdMap = new Map(imported.channels.map(c => [c.id, `channel_${crypto.randomUUID()}`]));
  const unresolvedRuleIds = [];
  const unresolvedReferences = [];
  const config = { ...imported, revision: state.config.revision + 1,
    channels: imported.channels.map(c => ({ ...c, id: channelIdMap.get(c.id) })),
    rules: imported.rules.map(r => {
      const unresolved = r.scope.mode === 'selected' && r.scope.serverIds.some(id => !serverIdMap.has(id));
      if (unresolved) { unresolvedRuleIds.push(r.id); unresolvedReferences.push({ ruleId: r.id, serverIds: r.scope.serverIds.filter(id => !serverIdMap.has(id)) }); }
      return { ...r, enabled: r.enabled && !unresolved, targetIds: r.targetIds.map(id => channelIdMap.get(id)),
        scope: { mode: r.scope.mode, serverIds: r.scope.serverIds.map(id => serverIdMap.get(id) || `unresolved_${crypto.randomUUID()}`) } };
    }) };
  validateNotificationBackup(config);
  const statements = [notificationConfigStatement(db, config, state.value)];
  // The unique imported channel ID identifies the winning CAS without rebinding 256 KiB per node.
  const importChannelId = config.channels[0]?.id;
  const scoped = rule => [...state.serverIds].filter(id => rule.scope.mode === 'all' || rule.scope.serverIds.includes(id));
  // Establish an initial observation, not a replay of pre-import alerts. Keep unrelated legacy state.
  for (const [type, key] of [['offline', 'alert_state'], ['resource', 'resource_alert_state'], ['expiry', 'expiry_notification_state']]) {
    const rules = config.rules.filter(r => r.type === type && r.enabled);
    if (!rules.length) continue;
    let stored = {};
    if (type === 'offline') {
      stored = { schema: 2, legacy: {}, rules: {} };
      for (const rule of rules) stored.rules[rule.id] = { baseline: true, servers: {} };
    } else if (type === 'resource') {
      stored = { servers: {} };
      for (const rule of rules) for (const id of scoped(rule)) stored.servers[`${rule.id}:${id}`] = { pending: true };
    } else {
      for (const rule of rules) { stored[rule.id] = {}; for (const id of scoped(rule)) stored[rule.id][id] = { baseline: true }; }
    }
    // Merge the live row inside the transaction; a stale state snapshot must not skip a baseline.
    const merge = type === 'offline'
      ? `CASE WHEN json_extract(settings.value,'$.schema')=2 THEN json_patch(settings.value,excluded.value)
        ELSE json_object('schema',2,'legacy',json(settings.value),'rules',json_extract(excluded.value,'$.rules')) END`
      : 'json_patch(settings.value,excluded.value)';
    statements.push(db.prepare(`INSERT INTO settings(key,value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM settings WHERE key=? AND json_extract(value,'$.revision')=? AND json_extract(value,'$.channels[0].id')=?)
      ON CONFLICT(key) DO UPDATE SET value=${merge}`).bind(key, JSON.stringify(stored), KEY, config.revision, importChannelId));
  }
  const trafficRules = config.rules.filter(r => r.type === 'traffic' && r.enabled);
  if (trafficRules.length) {
    for (const serverId of state.serverIds) {
      const applicable = trafficRules.filter(r => r.scope.mode === 'all' || r.scope.serverIds.includes(serverId));
      if (!applicable.length) continue;
      const stored = { schema: 2, rules: {} };
      for (const rule of applicable) stored.rules[rule.id] = { baseline: true };
      statements.push(db.prepare(`UPDATE servers SET traffic_alert_state=json_patch(COALESCE(NULLIF(traffic_alert_state,''),'{}'),?) WHERE id=?
        AND EXISTS (SELECT 1 FROM settings WHERE key=? AND json_extract(value,'$.revision')=? AND json_extract(value,'$.channels[0].id')=?)`).bind(JSON.stringify(stored), serverId, KEY, config.revision, importChannelId));
    }
  }
  const results = await db.batch(statements);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw notificationConfigError('notification_revision_conflict', 409);
  return { imported: true, revision: config.revision, channelIdMap: Object.fromEntries(channelIdMap), unresolvedRuleIds, unresolvedReferences };
}
