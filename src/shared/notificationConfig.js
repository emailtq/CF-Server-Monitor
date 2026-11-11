import { NOTIFICATION_LANGUAGE_CODES } from './languages.js';
import {
  DEFAULT_NOTIFICATION_TEMPLATE, DEFAULT_NOTIFICATION_WEBHOOK_BODY,
  normalizeNotificationTimezone, normalizeNotificationLanguage, normalizeExpireNotificationTime,
  normalizeTgNotify, normalizeExpireReminder, normalizeResourceAlertRules, normalizeTrafficAlertThreshold
} from '../utils/settings.js';

export const NOTIFICATION_TYPES = Object.freeze(['telegram', 'smtp', 'webhook', 'onebot', 'feishu', 'dingtalk', 'bark', 'wecom', 'serverchan', 'wxpusher', 'gotify', 'legacy']);
export const NOTIFICATION_TEMPLATE_FIELDS = Object.freeze(['event', 'message', 'time', 'emoji', 'client', 'clients', 'count', 'notification', 'title']);
export const NOTIFICATION_CONFIG_MAX_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CONFIG_FIELDS = {
  telegram: ['chatId'], smtp: ['host', 'port', 'username', 'from', 'to', 'secure'],
  webhook: ['method', 'format', 'body'], onebot: ['chatId'], legacy: ['chatId']
};

export function notificationConfigError(code = 'notification_config_invalid', status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export function assertNotificationObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw notificationConfigError();
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key))) throw notificationConfigError();
}

function string(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw notificationConfigError();
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw notificationConfigError();
  return value;
}

function number(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw notificationConfigError();
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') throw notificationConfigError();
  return value;
}

function list(value, max) {
  if (!Array.isArray(value) || value.length > max) throw notificationConfigError();
  return value;
}

function ids(value, max) {
  const result = list(value, max).map(id);
  if (new Set(result).size !== result.length) throw notificationConfigError();
  return result;
}

export function notificationSecretFields(type) {
  return type === 'telegram' ? ['botToken'] : type === 'smtp' ? ['password'] : type === 'webhook' ? ['url', 'headers'] : ['token'];
}

export function validateNotificationSecrets(type, value) {
  const fields = notificationSecretFields(type);
  assertNotificationObject(value, fields);
  const result = {};
  for (const [field, secret] of Object.entries(value)) {
    string(secret, field === 'headers' ? 4000 : 8000);
    if (/^(?:\*{3,}|\u2022{3,}|<redacted>|\[redacted\])$/i.test(secret.trim())) throw notificationConfigError();
    if (secret) result[field] = secret;
  }
  return result;
}

export function identifyNotificationProvider(rawToken) {
  const token = String(rawToken || '');
  if (token.trim().toLowerCase().startsWith('smtp:')) return 'smtp';
  if (token.startsWith('onebot:')) return 'onebot';
  if (token.includes('open.feishu.cn')) return 'feishu';
  if (token.includes('oapi.dingtalk.com') || token.includes('api.dingtalk.com')) return 'dingtalk';
  if (token.includes('https://api.day.app/') || token.startsWith('bark:')) return 'bark';
  if (token.includes('https://qyapi.weixin.qq.com')) return 'wecom';
  if (token.includes('https://sctapi.ftqq.com/') || token.startsWith('server:')) return 'serverchan';
  if (token.includes('https://wxpusher.zjiecode.com/api/send/message/SPT_')) return 'wxpusher';
  if (token.includes('/message?token=')) return 'gotify';
  return 'legacy';
}

function channel(raw) {
  assertNotificationObject(raw, ['id', 'name', 'type', 'enabled', 'config', 'secrets', 'template', 'secretFields']);
  if (!NOTIFICATION_TYPES.includes(raw.type)) throw notificationConfigError();
  const fields = CONFIG_FIELDS[raw.type] || [];
  assertNotificationObject(raw.config, fields);
  const config = {};
  for (const [field, value] of Object.entries(raw.config)) {
    config[field] = field === 'port' ? number(value, 1, 65535, true) : string(value, field === 'body' ? 8000 : 4000);
  }
  if (raw.secretFields !== undefined) {
    assertNotificationObject(raw.secretFields, notificationSecretFields(raw.type));
    Object.values(raw.secretFields).forEach(boolean);
  }
  const secrets = validateNotificationSecrets(raw.type, raw.secrets === undefined ? {} : raw.secrets);
  const enabled = boolean(raw.enabled);
  if (raw.type === 'webhook') {
    if (config.method !== undefined && !['GET', 'POST'].includes(config.method)) throw notificationConfigError();
    if (config.format !== undefined && !['json', 'form', 'text'].includes(config.format)) throw notificationConfigError();
    if (secrets.url) {
      try { if (!['https:', 'http:'].includes(new URL(secrets.url).protocol)) throw new Error(); }
      catch (_) { throw notificationConfigError(); }
    }
    if (enabled && !secrets.url) throw notificationConfigError();
  } else if (raw.type === 'smtp') {
    if (config.host) {
      try {
        const host = new URL(`smtp://${config.host}`);
        if (host.hostname.toLowerCase() !== config.host.toLowerCase() || host.username || host.password || host.port || host.pathname || host.search || host.hash) throw new Error();
      } catch (_) { throw notificationConfigError(); }
    }
    if (config.secure !== undefined && !['auto', 'tls', 'starttls'].includes(config.secure)) throw notificationConfigError();
    if (config.port === 25 || ((config.secure ?? 'auto') === 'auto' && config.port !== undefined && ![465, 587].includes(config.port))) throw notificationConfigError();
    if (enabled && (!secrets.password || !config.host || !config.username || !config.to)) throw notificationConfigError();
    for (const field of ['host', 'username', 'from', 'to']) if (/[\r\n]/.test(config[field] ?? '')) throw notificationConfigError();
  } else {
    const secret = secrets[raw.type === 'telegram' ? 'botToken' : 'token'];
    if (enabled) {
      if (!secret?.trim() || (['telegram', 'onebot', 'legacy'].includes(raw.type) && !config.chatId?.trim())) throw notificationConfigError();
      const provider = identifyNotificationProvider(secret);
      if (['telegram', 'legacy'].includes(raw.type)) {
        if (provider !== 'legacy' || (raw.type === 'telegram' && !/^[A-Za-z0-9:_-]+$/.test(secret))) throw notificationConfigError();
      } else {
        if (provider !== raw.type) throw notificationConfigError();
        const prefix = { onebot: 'onebot:', bark: 'bark:', serverchan: 'server:' }[raw.type];
        const endpoint = prefix && secret.startsWith(prefix) ? secret.slice(prefix.length) : secret;
        try { if (!['http:', 'https:'].includes(new URL(endpoint).protocol)) throw new Error(); }
        catch (_) { throw notificationConfigError(); }
      }
    }
  }
  return { id: id(raw.id), name: string(raw.name, 100, true), type: raw.type, enabled, config, secrets, template: string(raw.template, 4000) };
}

function options(type, raw) {
  if (!['offline', 'traffic', 'expiry', 'resource'].includes(type)) throw notificationConfigError();
  const fields = { offline: ['minutes'], traffic: ['threshold'], expiry: ['days', 'hour'], resource: ['metric', 'threshold', 'intervalMinutes', 'mode'] }[type];
  if (!fields) throw notificationConfigError();
  assertNotificationObject(raw, fields);
  if (type === 'offline') return { minutes: number(raw.minutes, 2, 30, true) };
  if (type === 'traffic') return { threshold: number(raw.threshold, 0, 100) };
  // Zero keeps the existing renewal-only behavior while disabling expiry reminders.
  if (type === 'expiry') return { days: number(raw.days, 0, 365, true), hour: number(raw.hour, 0, 23, true) };
  if (!['cpu', 'ram', 'disk', 'netIn', 'netOut'].includes(raw.metric) || !['average', 'continuous'].includes(raw.mode)) throw notificationConfigError();
  return { metric: raw.metric, threshold: number(raw.threshold, Number.MIN_VALUE, raw.metric.startsWith('net') ? 100000 : 100), intervalMinutes: number(raw.intervalMinutes, 5, 10, true), mode: raw.mode };
}

export function validateNotificationConfig(raw, { serverIds = new Set(), previousConfig = null, validateServerReferences = true } = {}) {
  assertNotificationObject(raw, ['schema', 'revision', 'channels', 'rules', 'timezone', 'language']);
  if (raw.schema !== 1) throw notificationConfigError();
  const revision = number(raw.revision, 0, Number.MAX_SAFE_INTEGER - 1, true);
  let json;
  try { json = JSON.stringify(raw); } catch (_) { throw notificationConfigError(); }
  if (new TextEncoder().encode(json).length > NOTIFICATION_CONFIG_MAX_BYTES) throw notificationConfigError();
  const channels = list(raw.channels, 64).map(channel);
  const channelMap = new Map(channels.map(c => [c.id, c]));
  if (channelMap.size !== channels.length) throw notificationConfigError();
  const rules = list(raw.rules, 64).map(r => {
    assertNotificationObject(r, ['id', 'name', 'type', 'enabled', 'scope', 'targetIds', 'options']);
    assertNotificationObject(r.scope, ['mode', 'serverIds']);
    const scopeIds = ids(r.scope.serverIds, 1000);
    const previous = previousConfig?.rules?.find(old => old.id === r.id && old.type === r.type);
    if (!['all', 'selected'].includes(r.scope.mode) || (r.scope.mode === 'all' && scopeIds.length) || (r.scope.mode === 'selected' && !scopeIds.length)) throw notificationConfigError();
    if (validateServerReferences) {
      const historicalIds = previous?.scope?.mode === 'selected' ? previous.scope.serverIds : [];
      const retainedMissing = scopeIds.some(s => !serverIds.has(s));
      // Only this rule's unexpanded historical selection may retain deleted IDs; storage reads never widen it.
      if ((retainedMissing && scopeIds.some(s => !historicalIds.includes(s))) ||
          (r.scope.mode === 'all' && historicalIds.some(s => !serverIds.has(s)))) throw notificationConfigError();
    }
    const targetIds = ids(r.targetIds, 16);
    if (targetIds.some(target => !channelMap.has(target))) throw notificationConfigError();
    const enabled = boolean(r.enabled);
    if (enabled && !targetIds.some(target => channelMap.get(target).enabled) && !(previous?.enabled && targetIds.length)) throw notificationConfigError();
    return { id: id(r.id), name: string(r.name, 100, true), type: r.type, enabled, scope: { mode: r.scope.mode, serverIds: scopeIds }, targetIds, options: options(r.type, r.options) };
  });
  if (new Set(rules.map(r => r.id)).size !== rules.length || rules.filter(r => r.type === 'resource').length > 20) throw notificationConfigError();
  const timezone = raw.timezone === undefined ? 'Asia/Shanghai' : raw.timezone;
  string(timezone, 100, true);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch (_) { throw notificationConfigError(); }
  const language = raw.language === undefined ? 'zh' : raw.language;
  if (!NOTIFICATION_LANGUAGE_CODES.includes(language)) throw notificationConfigError();
  return { schema: 1, revision, channels, rules, timezone, language };
}

export function maskNotificationConfig(config) {
  return { schema: config.schema, revision: config.revision, timezone: config.timezone, language: config.language,
    channels: config.channels.map(({ secrets, ...c }) => ({ ...c, config: { ...c.config }, secretFields: Object.fromEntries(Object.entries(secrets || {}).filter(([, value]) => Boolean(value)).map(([field]) => [field, true])) })),
    rules: config.rules.map(r => ({ ...r, scope: { ...r.scope, serverIds: [...r.scope.serverIds] }, targetIds: [...r.targetIds], options: { ...r.options } })) };
}

function legacyBuiltin(token, chatId) {
  const provider = identifyNotificationProvider(token);
  if (provider === 'smtp') {
    try {
      const url = new URL(token);
      const secure = url.searchParams.get('secure') || 'auto';
      return { type: 'smtp', config: { host: url.hostname, port: Number(url.port || (secure === 'tls' ? 465 : 587)), username: decodeURIComponent(url.username), from: url.searchParams.get('from') || decodeURIComponent(url.username), to: url.searchParams.get('to') || '', secure }, secrets: { password: decodeURIComponent(url.password) } };
    } catch (_) { return { type: 'legacy', config: { chatId }, secrets: { token } }; }
  }
  const type = provider === 'legacy' && /^\d+:[A-Za-z0-9_-]+$/.test(token) && chatId ? 'telegram' : provider;
  return { type, config: ['telegram', 'onebot', 'legacy'].includes(type) ? { chatId } : {}, secrets: { [type === 'telegram' ? 'botToken' : 'token']: token } };
}

export function migrateLegacyNotifications(settings = {}) {
  const template = settings.notification_template ?? DEFAULT_NOTIFICATION_TEMPLATE;
  const webhookActive = ['true', true, '1', 1].includes(settings.notification_webhook_enabled);
  const channels = [];
  if (settings.notification_webhook_url || settings.notification_webhook_headers || webhookActive) {
    channels.push({ id: 'legacy_webhook', name: 'Webhook', type: 'webhook', enabled: webhookActive,
      config: { method: settings.notification_webhook_method || 'POST', format: settings.notification_webhook_format || 'json', body: settings.notification_webhook_body ?? DEFAULT_NOTIFICATION_WEBHOOK_BODY },
      secrets: { url: settings.notification_webhook_url || '', headers: settings.notification_webhook_headers || '' }, template });
  }
  if (settings.tg_bot_token) channels.push({ id: 'legacy_builtin', name: 'Legacy notification', enabled: !webhookActive, ...legacyBuiltin(settings.tg_bot_token, settings.tg_chat_id || ''), template });
  // Invalid legacy values stay editable and server-only, never become an active fake target.
  for (const c of channels) {
    if (c.type === 'legacy') c.enabled = false;
    try { channel(c); }
    catch (_) {
      c.enabled = false;
      try { channel(c); } catch (_) {
        const token = c.type === 'webhook' ? JSON.stringify({ config: c.config, secrets: c.secrets }) : settings.tg_bot_token;
        c.type = 'legacy'; c.config = { chatId: settings.tg_chat_id || '' }; c.secrets = { token };
      }
    }
  }
  const targetIds = channels.filter(c => c.enabled).map(c => c.id);
  const rules = [];
  const add = (id, name, type, options, scope = { mode: 'all', serverIds: [] }) => rules.push({ id, name, type, enabled: targetIds.length > 0, scope, targetIds: [...targetIds], options });
  const minutes = Number(normalizeTgNotify(settings.tg_notify));
  if (minutes) add('offline_default', 'Offline', 'offline', { minutes });
  const days = Number(normalizeExpireReminder(settings.expire_reminder));
  if (days || targetIds.length) add('expiry_default', 'Expiry', 'expiry', { days, hour: Number(normalizeExpireNotificationTime(settings.expire_notification_time)) });
  const threshold = Number(normalizeTrafficAlertThreshold(settings.traffic_alert_threshold));
  if (threshold > 0 || targetIds.length) add('traffic_default', 'Traffic', 'traffic', { threshold });
  const resourceRules = normalizeResourceAlertRules(settings.resource_alert_rules);
  const resourceIds = new Set(resourceRules.map(r => r.id));
  const reservedIds = new Set(['offline_default', 'expiry_default', 'traffic_default']);
  for (const r of resourceRules) {
    // Keep original resource IDs, disambiguating only reserved IDs against the full set (not row order).
    let ruleId = r.id;
    while (reservedIds.has(ruleId) || (ruleId !== r.id && resourceIds.has(ruleId))) ruleId = `r.${ruleId}`;
    add(ruleId, r.name, 'resource', { metric: r.metric, threshold: Number(r.threshold), intervalMinutes: Number(r.intervalMinutes), mode: r.mode }, { mode: r.servers.length ? 'selected' : 'all', serverIds: r.servers });
  }
  return { schema: 1, revision: 0, channels, rules, timezone: normalizeNotificationTimezone(settings.notification_timezone), language: normalizeNotificationLanguage(settings.notification_language) };
}
