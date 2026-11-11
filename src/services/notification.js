import { getLatestTimestampsForAllServers } from '../database/schema.js';
import { clearServersListCache, getAllServers } from '../utils/cache.js';
import {
  DEFAULT_NOTIFICATION_TEMPLATE,
  getExpireReminderDays,
  getResourceAlertConfig,
  getResourceAlertRuleThresholds,
  loadSiteSettings,
  normalizeExpireNotificationTime,
  normalizeBooleanSetting,
  normalizeNotificationTemplate,
  normalizeNotificationTimezone,
  normalizeNotificationWebhookBody,
  normalizeNotificationWebhookFormat,
  normalizeNotificationWebhookHeaders,
  normalizeNotificationWebhookMethod,
  debug
} from '../utils/settings.js';
import {
  GB,
  getTrafficUsageBytes,
  normalizePct,
  normalizePctOrNull,
  normalizeTrafficLimitGb
} from '../utils/traffic.js';
import { detectBillingCycle, isEnabledFlag, normalizeBillingCycle, renewExpireDateIfNeeded } from '../utils/serverBilling.js';
import {
  NOTIFICATION_MAX_RETRIES,
  NOTIFICATION_RETRY_DELAY_MS,
  RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE,
  RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE,
  RESOURCE_ALERT_COMPACT_RESULT_FORMAT,
  RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT
} from '../utils/config.js';
import { getNotificationMessages } from './notificationMessages.js';
import { identifyNotificationProvider, migrateLegacyNotifications } from '../shared/notificationConfig.js';
import { loadNotificationConfig, notificationChannelSettings } from '../database/notifications.js';
import { dispatchNotificationEvents, notificationDeliveryKey } from './notificationRouting.js';
import { notificationRuleSignature as ruleSignature, createNotificationRuleIdentity, matchesNotificationRuleIdentity } from './notificationState.js';

function inRuleScope(rule, serverId) {
  return rule.scope.mode === 'all' || rule.scope.serverIds.includes(String(serverId));
}

function notificationSettings(config) {
  return { notification_timezone: config.timezone, notification_language: config.language };
}

async function dispatch(config, events, send) {
  return dispatchNotificationEvents(config, events, { send: send || ((channel, msg, context) => sendNotification(notificationChannelSettings(channel, config), msg, context)) });
}

const RESOURCE_ALERT_STATE_ACTIVE = 'active';
const RESOURCE_ALERT_STATE_RECOVERED = 'recovered';
const RESOURCE_ALERT_STATE_KEY = 'resource_alert_state';
const DAY_MS = 24 * 60 * 60 * 1000;

// 记录本 isolate 是否已确认资源告警状态为空，避免每分钟重复执行一次 DELETE
let resourceAlertStateKnownEmpty = false;

function getZonedDateParts(timestamp = Date.now(), timezone = 'UTC') {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const timeZone = normalizeNotificationTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(part => [part.type, part.value])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function formatNotificationTime(timestamp = Date.now(), settings = {}) {
  const parts = getZonedDateParts(timestamp, settings?.notification_timezone);
  if (!parts) return getNotificationMessages(settings).invalidTime;
  const pad = value => String(value).padStart(2, '0');
  return `${Number(parts.year)}/${Number(parts.month)}/${Number(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function formatLastReportTime(timestamp, settings = {}) {
  if (!timestamp) return getNotificationMessages(settings).noReport;

  return formatNotificationTime(timestamp, settings);
}

function isExpireNotificationTimeDue(settings = {}, timestamp = Date.now()) {
  const parts = getZonedDateParts(timestamp, settings.notification_timezone);
  if (!parts) return false;
  return Number(parts.hour) === Number(normalizeExpireNotificationTime(settings.expire_notification_time));
}

function getZonedDateSerial(timestamp, timezone) {
  const parts = getZonedDateParts(timestamp, timezone);
  if (!parts) return NaN;
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS);
}

function parseDateSerial(dateString) {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return NaN;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function formatMegabitsPerSecond(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0 Mbps';
  const mbps = number * 8 / 1000 / 1000;
  return `${mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)} Mbps`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0%';
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

function getResourceMetricLabel(metric, messages) {
  const metricLabels = {
    cpu: 'CPU',
    ram: 'RAM',
    disk: 'DISK',
    ...messages.metrics
  };
  return metricLabels[metric?.metric] || metric?.metric || '';
}

function formatResourceMetricValue(metric, value) {
  if (metric?.metric === 'cpu' || metric?.metric === 'ram' || metric?.metric === 'disk') {
    return formatPercent(value);
  }
  return formatMegabitsPerSecond(value);
}

function parseResourceAlertState(row) {
  if (!row || !row.value) return { signature: '', servers: {} };
  try {
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
      return {
        signature: String(parsed.signature || ''),
        servers: parsed.servers
      };
    }
  } catch (_) {}
  return { signature: '', servers: {} };
}

function hasResourceAlertStateEntries(alertState) {
  return alertState && typeof alertState === 'object' && Object.keys(alertState).length > 0;
}

function getD1Changes(result) {
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
  return Number.isFinite(changes) && changes > 0 ? changes : 0;
}

export async function clearResourceAlertState(db) {
  if (!db) return false;
  const result = await db.prepare(
    `DELETE FROM settings WHERE key = ?`
  ).bind(RESOURCE_ALERT_STATE_KEY).run();
  resourceAlertStateKnownEmpty = true;
  return getD1Changes(result) > 0;
}

async function saveResourceAlertState(db, configSignature, alertState, hadStoredState) {
  if (hasResourceAlertStateEntries(alertState)) {
    await db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(RESOURCE_ALERT_STATE_KEY, JSON.stringify({ signature: configSignature, servers: alertState })).run();
    resourceAlertStateKnownEmpty = false;
    return;
  }

  if (hadStoredState) {
    await clearResourceAlertState(db);
  }
}

function getResourceAlertStateStatus(state) {
  if (!state || typeof state !== 'object') return RESOURCE_ALERT_STATE_ACTIVE;
  return state.status === RESOURCE_ALERT_STATE_RECOVERED
    ? RESOURCE_ALERT_STATE_RECOVERED
    : RESOURCE_ALERT_STATE_ACTIVE;
}

function getResourceAlertStateTimestamp(state, key) {
  if (!state || typeof state !== 'object') return 0;
  const timestamp = Number(state[key] || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function getStoredResourceAlertMetrics(alert) {
  return (alert?.metrics || []).map(m => ({
    metric: m.metric,
    mode: m.mode,
    threshold: m.threshold,
    triggerValue: m.triggerValue ?? m.current
  }));
}

function canRecoverResourceAlert(evaluation) {
  const metrics = Array.isArray(evaluation?.metrics) ? evaluation.metrics : [];
  return metrics.length > 0 && metrics.every(metric => {
    const current = Number(metric?.current);
    const threshold = Number(metric?.threshold);
    return Number.isFinite(current) && Number.isFinite(threshold) && current < threshold;
  });
}

// compact-v1 的正常节点仅携带数值摘要；只在需要判断恢复时还原完整指标。
function expandResourceAlertEvaluation(evaluation) {
  if (!evaluation?.metricDefinitions) return evaluation;
  const definitions = evaluation.metricDefinitions;
  const values = evaluation.metrics;
  if (!Array.isArray(definitions) || !Array.isArray(values) || definitions.length !== values.length) return null;
  const metrics = [];
  for (let index = 0; index < definitions.length; index++) {
    const summary = values[index];
    // 顺序：triggerValue, current, min, max, avg。异常响应不能被当成恢复。
    if (!Array.isArray(summary) || summary.length !== 5 || !summary.every(Number.isFinite)) return null;
    metrics.push({
      ...definitions[index],
      triggerValue: summary[0],
      triggered: false,
      current: summary[1],
      min: summary[2],
      max: summary[3],
      avg: summary[4]
    });
  }
  return { serverId: evaluation.serverId, metrics };
}

function getResourceAlertRuleIntervalMs(rule) {
  const minutes = Number(rule?.intervalMinutes);
  const normalizedMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  return Math.max(5, normalizedMinutes) * 60 * 1000;
}

function formatCurrentTime(settings = {}) {
  return formatNotificationTime(Date.now(), settings);
}

function getResourceAlertRuleStateKey(rule, serverId) {
  return `${rule.id}:${serverId}`;
}

function getResourceAlertRuleServerIds(rule, servers) {
  const allServerIds = servers.map(server => String(server.id)).filter(Boolean);
  if (rule.scope) {
    const selected = new Set(rule.scope.serverIds);
    return rule.scope.mode === 'all' ? allServerIds : allServerIds.filter(id => selected.has(id));
  }
  if (!Array.isArray(rule.servers) || rule.servers.length === 0) {
    return allServerIds;
  }

  const allowed = new Set(allServerIds);
  const seen = new Set();
  const ids = [];
  for (const serverId of rule.servers) {
    const id = String(serverId || '').trim();
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function formatConciseResourceMetric(metric, valueKey, messages) {
  const label = getResourceMetricLabel(metric, messages);
  const value = metric?.[valueKey] ?? metric?.current;
  return `${label} ${formatResourceMetricValue(metric, value)}`;
}

function buildGroupedResourceAlertEntries(nodes, valueKey, messages) {
  const groups = new Map();

  for (const item of Array.isArray(nodes) ? nodes : []) {
    const serverName = String(item?.server?.name || '').trim();
    if (!serverName) continue;

    const sourceMetrics = item.alert?.metrics || item.metrics || [];
    if (!Array.isArray(sourceMetrics) || sourceMetrics.length === 0) continue;

    let group = groups.get(serverName);
    if (!group) {
      group = { serverName, metrics: [], seen: new Set() };
      groups.set(serverName, group);
    }

    for (const metric of sourceMetrics) {
      const text = formatConciseResourceMetric(metric, valueKey, messages);
      if (!text || group.seen.has(text)) continue;
      group.seen.add(text);
      group.metrics.push(text);
    }
  }

  return Array.from(groups.values())
    .filter(group => group.metrics.length > 0)
    .map(group => ({
      serverName: group.serverName,
      text: `${group.serverName}  ${group.metrics.join('  ')}`
    }));
}

function appendResourceAlertNotificationChunks(payloads, entries, options) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  let chunkEntries = [];
  let chunkClients = [];
  const flush = () => {
    if (chunkEntries.length === 0) return;

    const nodeList = chunkEntries.map(entry => entry.text).join('\n');
    payloads.push({
      msg: nodeList,
      context: {
        event: options.event,
        emoji: options.emoji,
        clients: chunkClients,
        count: new Set(chunkClients).size || chunkEntries.length,
        message: nodeList
      }
    });
    chunkEntries = [];
    chunkClients = [];
  };

  for (const entry of entries) {
    const candidateEntries = [...chunkEntries, entry];
    const candidateNodeList = candidateEntries.map(item => item.text).join('\n');
    const candidate = candidateNodeList;
    if (chunkEntries.length > 0 && candidate.length > RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT) {
      flush();
    }
    chunkEntries.push(entry);
    if (entry.serverName) chunkClients.push(entry.serverName);
  }

  flush();
}

export function buildResourceAlertNotificationPayloads(alertNodes, recoveredNodes, settings = {}) {
  const messages = getNotificationMessages(settings);
  const payloads = [];
  appendResourceAlertNotificationChunks(
    payloads,
    buildGroupedResourceAlertEntries(alertNodes, 'triggerValue', messages),
    {
      event: messages.events.resourceAlert,
      emoji: '❌'
    }
  );
  appendResourceAlertNotificationChunks(
    payloads,
    buildGroupedResourceAlertEntries(recoveredNodes, 'current', messages),
    {
      event: messages.events.resourceRecovered,
      emoji: '✅'
    }
  );
  return payloads;
}

async function evaluateResourceAlertRules(stub, ruleRequests) {
  const resultMap = new Map();
  const requests = [];

  for (const item of Array.isArray(ruleRequests) ? ruleRequests : []) {
    const serverIds = Array.isArray(item?.serverIds) ? item.serverIds : [];
    for (let offset = 0; offset < serverIds.length; offset += RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE) {
      requests.push({
        rule: item.rule,
        serverIds: serverIds.slice(offset, offset + RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE)
      });
    }
  }

  for (let offset = 0; offset < requests.length; offset += RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE) {
    const batch = requests.slice(offset, offset + RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE);
    if (batch.length === 0) continue;

    try {
      const response = await stub.fetch('http://internal/evaluate-resource-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resultFormat: RESOURCE_ALERT_COMPACT_RESULT_FORMAT,
          rules: batch.map(({ rule, serverIds }) => ({
            ruleId: rule.id,
            serverIds,
            mode: rule.mode,
            windowMinutes: Number(rule.intervalMinutes),
            thresholds: getResourceAlertRuleThresholds(rule)
          }))
        })
      });

      if (!response.ok) {
        console.warn('[ResourceAlert] DO evaluate failed:', response.status);
        continue;
      }

      const result = await response.json();
      for (const item of Array.isArray(result?.results) ? result.results : []) {
        const ruleId = String(item?.ruleId || '').trim();
        if (!ruleId) continue;
        const existing = resultMap.get(ruleId) || {
          alerts: [],
          evaluatedServerIds: [],
          evaluations: []
        };
        const alerts = Array.isArray(item.alerts) ? item.alerts : [];
        const evaluations = Array.isArray(item.evaluations)
          ? item.evaluations.filter(evaluation => evaluation && evaluation.serverId)
          : [];
        existing.alerts.push(...alerts);
        if (item.format === RESOURCE_ALERT_COMPACT_RESULT_FORMAT) {
          // 紧凑响应的 alerts / evaluations 覆盖全部成功评估节点，失败节点仍不参与状态迁移。
          existing.evaluatedServerIds.push(...alerts.map(alert => String(alert.serverId)));
          for (const evaluation of evaluations) {
            evaluation.metricDefinitions = item.metricDefinitions;
            existing.evaluatedServerIds.push(String(evaluation.serverId));
          }
        } else {
          // 滚动部署时仍接受旧 DO 的完整响应。
          existing.evaluatedServerIds.push(...(
            Array.isArray(item.evaluatedServerIds)
              ? item.evaluatedServerIds.map(id => String(id)).filter(Boolean)
              : []
          ));
        }
        existing.evaluations.push(...evaluations);
        resultMap.set(ruleId, existing);
      }
    } catch (e) {
      console.warn('[ResourceAlert] DO evaluate failed:', e?.message || e);
    }
  }

  return resultMap;
}

async function fetchWithRetry(url, options, retries = NOTIFICATION_MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, NOTIFICATION_RETRY_DELAY_MS));
      }
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, NOTIFICATION_RETRY_DELAY_MS));
      } else {
        throw e;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/^[\s✅⚠️⏰💌•-]+/u, '')
    .trim();
}

function inferNotificationEvent(msg, fallback) {
  const firstLine = String(msg || '').split('\n').find(line => line.trim());
  return stripMarkdown(firstLine || fallback) || fallback;
}

function escapeJsonStringFragment(value) {
  return JSON.stringify(String(value ?? '')).slice(1, -1);
}

function renderTemplate(template, data, options = {}) {
  const source = String(template || '');
  return source.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = data[key] ?? '';
    return options.jsonString ? escapeJsonStringFragment(value) : String(value);
  });
}

function normalizeNotificationClients(context = {}) {
  const source = Array.isArray(context.clients)
    ? context.clients
    : (context.client ? String(context.client).split(',') : []);
  const clients = source
    .map(client => String(client || '').trim())
    .filter(Boolean);
  if (clients.length > 0) return Array.from(new Set(clients));
  return ['CF Server Monitor'];
}

function inferNotificationEmoji(event) {
  const normalizedEvent = String(event || '');
  if (/恢复|测试|成功/.test(normalizedEvent)) return '✅';
  if (/到期|提醒/.test(normalizedEvent)) return '⚠️';
  if (/离线|告警|失败|异常/.test(normalizedEvent)) return '❌';
  return 'ℹ️';
}

function buildNotificationContext(settings, msg, context = {}) {
  const now = formatCurrentTime(settings);
  const clients = normalizeNotificationClients(context);
  const count = Number.isFinite(Number(context.count)) && Number(context.count) > 0
    ? Number(context.count)
    : clients.length;
  const event = context.event || inferNotificationEvent(msg, getNotificationMessages(settings).events.notification);
  return {
    title: '💌 Cloudflare Server Monitor',
    event,
    emoji: context.emoji || inferNotificationEmoji(event),
    client: context.client || clients.join(', '),
    clients: clients.join(', '),
    count: String(count),
    message: context.message || String(msg || ''),
    time: context.time || now
  };
}

function formatNotificationMessage(settings, msg, context) {
  const template = normalizeNotificationTemplate(settings?.notification_template || DEFAULT_NOTIFICATION_TEMPLATE);
  return renderTemplate(template, context) || String(msg || '');
}

function parseWebhookHeaders(rawHeaders, context) {
  const raw = renderTemplate(normalizeNotificationWebhookHeaders(rawHeaders), context).trim();
  const headers = {};
  if (!raw) return headers;

  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('headers must be an object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey || /^(host|content-length)$/i.test(normalizedKey)) continue;
      headers[normalizedKey] = String(value ?? '');
    }
    return headers;
  }

  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!key || /^(host|content-length)$/i.test(key)) continue;
    headers[key] = line.slice(index + 1).trim();
  }
  return headers;
}

function buildWebhookQueryParams(settings, context) {
  const rawBody = normalizeNotificationWebhookBody(settings.notification_webhook_body);
  try {
    const body = renderTemplate(rawBody, context, { jsonString: true });
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]);
    }
  } catch (_) {}

  const params = new URLSearchParams(renderTemplate(rawBody, context));
  return Array.from(params.entries());
}

function buildWebhookUrl(settings, context, method) {
  const rawUrl = settings.notification_webhook_url;
  const renderedUrl = renderTemplate(String(rawUrl || '').trim(), context);
  if (!renderedUrl) throw new Error('missing webhook url');

  const url = new URL(renderedUrl);
  if (method === 'GET') {
    for (const [key, value] of buildWebhookQueryParams(settings, context)) {
      if (!key) continue;
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildWebhookBody(settings, context, format) {
  const rawBody = normalizeNotificationWebhookBody(settings.notification_webhook_body);
  if (format === 'json') {
    const body = renderTemplate(rawBody, context, { jsonString: true });
    return JSON.stringify(JSON.parse(body));
  }
  if (format === 'form') {
    try {
      const body = renderTemplate(rawBody, context, { jsonString: true });
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed)) {
          params.set(key, String(value ?? ''));
        }
        return params.toString();
      }
    } catch (_) {}
  }
  return renderTemplate(rawBody, context);
}

async function sendCustomWebhookNotification(settings, context) {
  const method = normalizeNotificationWebhookMethod(settings.notification_webhook_method);
  const format = normalizeNotificationWebhookFormat(settings.notification_webhook_format);
  const endpoint = buildWebhookUrl(settings, context, method);
  const headers = parseWebhookHeaders(settings.notification_webhook_headers, context);
  const options = { method, headers };

  if (method !== 'GET') {
    const contentTypeHeader = Object.keys(headers).find(key => key.toLowerCase() === 'content-type');
    if (!contentTypeHeader) {
      headers['Content-Type'] = format === 'json'
        ? 'application/json'
        : (format === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain; charset=utf-8');
    }
    options.body = buildWebhookBody(settings, context, format);
  }

  await fetchWithRetry(endpoint, options);
}

// SMTP 通知复用 tg_bot_token 字段，配置以 "smtp:" 前缀协议存储（方案 A）。
// 格式: smtp://<user>:<password>@<host>:<port>?from=<from>&to=<to1,to2>&secure=<auto|tls|starttls>
export function isSmtpNotificationTarget(token) {
  // 与前端保持一致：协议头大小写不敏感（SMTP:// 同样识别）
  return identifyNotificationProvider(token) === 'smtp';
}

// Report-triggered traffic state keeps the original rollover marker and per-rule audiences.
const TRAFFIC_ALERT_RESET_FACTOR = 0.5;

function parseTrafficAlertState(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && Number.isFinite(o.u) && o.u > 0) {
      return { u: Math.round(o.u), th: normalizePct(o.th), lim: normalizeTrafficLimitGb(o.lim) };
    }
  } catch (_) {}
  return null;
}

// hooks.patchCache?.(serverId, valueOrNull) —— 缓存实现由调用方注入，本函数不 import 任何 cache 模块
export async function evaluateTrafficAlert(env, server, metrics, hooks = {}) {
  try {
    if (!env?.DB || !server || !metrics) return;
    const limit = normalizeTrafficLimitGb(server.traffic_limit);
    if (limit <= 0) return;
    const settings = await loadSiteSettings(env.DB);
    const config = await loadNotificationConfig(env.DB, settings);
    const rules = config.rules.filter(r => r.type === 'traffic' && r.enabled && inRuleScope(r, server.id));
    if (!rules.length) return;
    const identities = new Map(await Promise.all(rules.map(async r => [r.id, await createNotificationRuleIdentity(r)])));
    const override = normalizePctOrNull(server.traffic_alert_percent);
    if (override === 0) return;
    const used = Math.round(getTrafficUsageBytes(metrics.net_rx_monthly, metrics.net_tx_monthly, server.traffic_calc_type));
    const row = await env.DB.prepare('SELECT traffic_alert_state FROM servers WHERE id = ?').bind(server.id).first();
    if (!row) return;
    const oldStr = row.traffic_alert_state == null ? '' : String(row.traffic_alert_state);
    let raw = null;
    try { raw = oldStr ? JSON.parse(oldStr) : null; } catch (_) {}
    const legacy = parseTrafficAlertState(oldStr);
    const state = raw?.schema === 2 && raw.rules && typeof raw.rules === 'object' && !Array.isArray(raw.rules)
      ? raw : { schema: 2, rules: {} };
    if (state.claim && state.claim.until > Date.now()) return;
    if (legacy && used < legacy.u * TRAFFIC_ALERT_RESET_FACTOR) {
      const result = await env.DB.prepare("UPDATE servers SET traffic_alert_state = NULL WHERE id = ? AND COALESCE(traffic_alert_state,'') = ?").bind(server.id, oldStr).run();
      if (getD1Changes(result)) hooks.patchCache?.(server.id, null);
      return;
    }
    const before = JSON.stringify(state);
    delete state.claim;
    const ruleIds = new Set(config.rules.filter(r => r.type === 'traffic').map(r => r.id));
    for (const id of Object.keys(state.rules)) if (!ruleIds.has(id)) delete state.rules[id];
    const events = [];
    const activeTargets = new Set(config.channels.filter(c => c.enabled).map(c => c.id));
    const messages = getNotificationMessages(notificationSettings(config));
    let promotedLegacyDefault = false;
    for (const rule of rules) {
      const threshold = override === null ? rule.options.threshold : override;
      if (threshold <= 0) continue;
      const percent = used / (limit * GB) * 100;
      const identity = identities.get(rule.id);
      const signature = identity.signature;
      let entry = state.rules[rule.id];
      const baseline = entry?.baseline;
      if (baseline && percent < threshold) { delete state.rules[rule.id]; continue; }
      if (!entry && raw?.schema !== 2 && rule.id === 'traffic_default' && legacy?.th === threshold && legacy?.lim === limit) {
        const targets = rule.targetIds.filter(id => activeTargets.has(id));
        entry = { u: legacy.u, th: threshold, lim: limit, signature, targets, success: [...targets] };
        state.rules[rule.id] = entry;
        state.u = Math.max(legacy.u, Number(state.u) || 0);
        promotedLegacyDefault = true;
      }
      if (percent < threshold) continue;
      if (baseline || !entry || entry.th !== threshold || entry.lim !== limit || !matchesNotificationRuleIdentity(entry.signature, identity)) {
        entry = { u: used, th: threshold, lim: limit, signature, targets: baseline ? [] : rule.targetIds.filter(id => activeTargets.has(id)), success: [] };
        state.rules[rule.id] = entry;
      }
      entry.signature = signature;
      // Targets are the event's original audience, not today's expanded audience.
      const targetIds = entry.targets.filter(id => rule.targetIds.includes(id) && activeTargets.has(id) && !entry.success.includes(id));
      state.u = Math.max(entry.u, Number(state.u) || 0); state.th = threshold; state.lim = limit;
      if (!targetIds.length) continue;
      const name = server.name || server.id;
      const msg = name + '  ' + messages.trafficUsed({ usedGb: (used / GB).toFixed(1), limitGb: limit, percent: (used / (limit * GB) * 100).toFixed(1), threshold });
      events.push({ ruleId: rule.id, serverId: server.id, eventKey: 'trafficAlert', targetIds, msg,
        context: { event: messages.events.trafficAlert, emoji: '📈', clients: [name] } });
    }
    if (!events.length && (JSON.stringify(state) === before || (promotedLegacyDefault && Object.keys(state.rules).length === 1))) return;
    if (events.length) state.claim = { id: crypto.randomUUID(), until: Date.now() + 5 * 60000 };
    const claimed = JSON.stringify(state);
    const update = value => env.DB.prepare("UPDATE servers SET traffic_alert_state = ? WHERE id = ? AND COALESCE(traffic_alert_state,'') = ?").bind(value, server.id, oldStr).run();
    const claim = await update(claimed);
    if (!getD1Changes(claim)) return;
    hooks.patchCache?.(server.id, claimed);
    if (!events.length) return;
    const results = await dispatch(config, events, hooks.send);
    for (const event of events) {
      const entry = state.rules[event.ruleId];
      for (const id of event.targetIds) if (results.some(r => r.deliveryKey === notificationDeliveryKey(id, server.id, event.eventKey) && r.success) && !entry.success.includes(id)) entry.success.push(id);
    }
    delete state.claim;
    const value = JSON.stringify(state);
    const result = await env.DB.prepare("UPDATE servers SET traffic_alert_state = ? WHERE id = ? AND COALESCE(traffic_alert_state,'') = ?").bind(value, server.id, claimed).run();
    if (getD1Changes(result)) hooks.patchCache?.(server.id, value);
  } catch (_) { console.error('[Notification] traffic evaluation failed'); }
}

const SMTP_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 信封地址防注入：剥离 CR/LF 并校验邮箱格式（subject/body 已有 sanitize，信封同样需要）
function normalizeSmtpAddress(value) {
  return String(value || '').replace(/[\r\n]/g, '').trim();
}

function parseSmtpNotificationConfig(rawToken) {
  const url = new URL(String(rawToken).trim());
  const host = url.hostname;
  if (!host) throw new Error('缺少 SMTP 主机');

  const secureParam = (url.searchParams.get('secure') || 'auto').toLowerCase();
  // 不提供 'off'（明文传输），避免凭据被静默降级为明文发送
  const allowedSecure = ['auto', 'tls', 'starttls'];
  const secureTransport = allowedSecure.includes(secureParam) ? secureParam : 'auto';
  const port = url.port ? Number(url.port) : (secureTransport === 'tls' ? 465 : 587);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('SMTP 端口无效');
  }
  // Cloudflare Workers 永久封禁 25 端口出站
  if (port === 25) {
    throw new Error('Cloudflare Workers 不支持 25 端口，请使用 465(implicit TLS) 或 587(STARTTLS)');
  }
  // auto 模式下非 465/587 端口会被库推导为明文连接，必须显式指定加密方式
  if (secureTransport === 'auto' && port !== 465 && port !== 587) {
    throw new Error('非 465/587 端口必须显式指定加密方式 (secure=tls 或 secure=starttls)');
  }

  const decode = value => {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  };
  const username = decode(url.username || '');
  const password = decode(url.password || '');
  if (!username) throw new Error('缺少 SMTP 用户名');
  if (!password) throw new Error('缺少 SMTP 密码');

  const from = normalizeSmtpAddress(url.searchParams.get('from') || username);
  if (!SMTP_EMAIL_PATTERN.test(from)) throw new Error('SMTP 发件人地址无效');
  const to = (url.searchParams.get('to') || '')
    .split(',')
    .map(normalizeSmtpAddress)
    .filter(Boolean);
  if (to.length === 0) throw new Error('缺少收件人 (to)');
  if (to.some(address => !SMTP_EMAIL_PATTERN.test(address))) {
    throw new Error('SMTP 收件人地址无效');
  }

  return { host, port, username, password, from, to, secureTransport };
}

// 仅对临时性失败重试：连接类异常与 4xx（如 421/450 限流、暂时不可用）；
// 5xx 为永久性拒绝（550 收件人拒绝等），454 为认证失败（部分邮箱如 QQ 使用 4xx 码），
// 两者重试无意义且易触发邮箱风控
function isSmtpRetryableError(error) {
  const match = String(error?.message || error).match(/SMTP error (\d{3})/);
  if (!match) return true;
  const code = Number(match[1]);
  return code >= 400 && code < 500 && code !== 454;
}

async function withSmtpRetry(task, retries = NOTIFICATION_MAX_RETRIES) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      await task();
      return;
    } catch (e) {
      lastError = e;
      if (!isSmtpRetryableError(e)) break;
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, NOTIFICATION_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

async function sendSmtpNotification(settings, context, formattedMsg) {
  let config;
  try {
    config = parseSmtpNotificationConfig(settings.tg_bot_token);
  } catch (e) {
    return `SMTP 通知配置错误: ${e.message}`;
  }
  try {
    // 动态导入：cloudflare-smtp 依赖 cloudflare:sockets，仅在运行时（Workers）加载
    const { sendMail } = await import('cloudflare-smtp');
    const subject = `${context.emoji || ''} ${context.event || getNotificationMessages(settings).events.notification}`.trim();
    const text = String(formattedMsg || '').replace(/\*/g, '');
    await withSmtpRetry(() => sendMail(
      {
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        from: config.from,
        to: config.to,
        secureTransport: config.secureTransport
      },
      { subject, text }
    ));
    return;
  } catch (e) {
    return `SMTP 邮件通知发送失败: ${e.message}`;
  }
}

export function validateNotificationTransport(settings) {
  if (normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true') {
    const context = buildNotificationContext(settings, 'test');
    context.notification = 'test';
    const method = normalizeNotificationWebhookMethod(settings.notification_webhook_method);
    buildWebhookUrl(settings, context, method);
    new Headers(parseWebhookHeaders(settings.notification_webhook_headers, context));
    if (method !== 'GET') buildWebhookBody(settings, context, normalizeNotificationWebhookFormat(settings.notification_webhook_format));
  } else if (isSmtpNotificationTarget(settings?.tg_bot_token)) {
    parseSmtpNotificationConfig(settings.tg_bot_token);
  }
}

export async function sendNotification(settings, msg, notificationContext = {}) {
  const context = buildNotificationContext(settings || {}, msg, notificationContext);
  const formattedMsg = formatNotificationMessage(settings || {}, msg, context);
  context.notification = formattedMsg;
  const title = context.title;

  if (normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true') {
    if (!String(settings?.notification_webhook_url || '').trim()) return "自定义 Webhook 通知失败: 缺少 URL";
    try {
      await sendCustomWebhookNotification(settings, context);
      return;
    } catch (e) {
      return "自定义 Webhook 通知发送失败: " + e.message;
    }
  }

  if(!settings.tg_bot_token) return;
  const provider = identifyNotificationProvider(settings.tg_bot_token);
  if (provider === 'smtp') {
    // SMTP 邮件通知（前缀协议: smtp://...），置于内置渠道分发链最前
    return await sendSmtpNotification(settings, context, formattedMsg);
  }
  if(provider === 'onebot') {
    // OneBot 协议 (QQ 等)，私聊格式: onebot:http://127.0.0.1:3000/send_private_msg?access_token=xxx
    // 群聊格式: onebot:http://127.0.0.1:3000/send_group_msg?access_token=xxx
    let onebotUrl = settings.tg_bot_token.replace("onebot:", "");
    const targetId = settings.tg_chat_id || '';
    const isGroup = onebotUrl.indexOf("send_group_msg") != -1;
    if (!targetId) {
      return "OneBot 通知失败: 缺少 tg_chat_id（私人: QQ号，群: group:群号）";
    }
    try {
      const endpoint = onebotUrl.trim();
      const body = {
        [isGroup ? 'group_id' : 'user_id']: targetId,
        message: [
          {
            type: 'text',
            data: {
              text: `${title}\n${String(formattedMsg || '').replace(/\*/g, '')}\n`
            }
          }
        ]
      };
      await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return "OneBot 通知发送失败: " + e.message;
    }
  }else if(provider === 'feishu') {
    // 飞书机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          msg_type: "interactive",
          card: {
            schema: "2.0",
            header: { template: "blue", title: { content: title, tag: "plain_text" } },
            body: { elements: [{ tag: "markdown", content: formattedMsg }] }
          }
        })
      });
    } catch (e) {
      return "飞书通知发送失败: " + e.message;
    }
  }else if(provider === 'dingtalk') {
    // 钉钉机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { title: title, text: formattedMsg }
        })
      });
    } catch (e) {
      return "钉钉通知发送失败: " + e.message;
    }
  }else if(provider === 'bark') {
    let barkUrl = settings.tg_bot_token;
    if(barkUrl.indexOf("bark:") == 0) {
      barkUrl = barkUrl.replace("bark:", "");
    }
    try {
      await fetchWithRetry(barkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          markdown: formattedMsg,
          group: "Cloudflare Server Monitor"
        })
      });
    } catch (e) {
      return "Bark通知发送失败: " + e.message;
    }
  }else if(provider === 'wecom'){
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "text",
          text: {
            content: formattedMsg.replace(/\*/g, '')
          }
        })
      });
    } catch (e) {
      return "企业微信通知发送失败: " + e.message;
    }
  // Server 酱（使用 sendkey）
  }else if(provider === 'serverchan') {
    let serverUrl = settings.tg_bot_token;
    if(serverUrl.indexOf("server:") == 0) {
      serverUrl = serverUrl.replace("server:", "");
    }
    try {
      await fetchWithRetry(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          desp: formattedMsg
        })
      });
    } catch (e) {
      return "Server酱通知发送失败: " + e.message;
    }
  }else if(provider === 'wxpusher') {
    const match = settings.tg_bot_token.match(/\/message\/([^/]+)/);
    const spt = match ? match[1] : null;
    if (!spt) return "WxPusher 通知失败: 无法提取 SPT";
    try {
      await fetchWithRetry("https://wxpusher.zjiecode.com/api/send/message/simple-push", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          "content": formattedMsg,
          "summary": title,
          "contentType":3,
          "spt": spt,
        })
      });
    } catch (e) {
      return "WxPusher通知发送失败: " + e.message;
    }
  }else if(provider === 'gotify') {
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          message: formattedMsg,
          priority: 5,
          extras: {
            "client::display": { "contentType": "text/markdown" }
          }
        })
      });
    } catch (e) {
      return "Gotify通知发送失败: " + e.message;
    }
  }else if(settings.tg_chat_id) {
    // Telegram Bot (最后 fallback，通过 chat_id 判断)
    try {
      await fetchWithRetry(`https://api.telegram.org/bot${settings.tg_bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.tg_chat_id,
          text: formattedMsg
        })
      });
    } catch (e) {
      return "Telegram 通知发送失败: " + e.message;
    }
  }else {
    return "未知的通知方式";
  }
}

export async function checkOfflineNodes(db, options = {}) {
  try {
    const config = options.notificationConfig ?? await loadNotificationConfig(db, options.siteSettings);
    const rules = config.rules.filter(r => r.type === 'offline' && r.enabled);
    if (!rules.length) return;
    const servers = (await getAllServers(db)).filter(s => s.offline_notify_disabled !== '1' && rules.some(r => inRuleScope(r, s.id)));
    if (!servers.length) return;
    const latest = await getLatestTimestampsForAllServers(db, { servers });
    if (!latest) return;
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'alert_state'").first();
    let stored = {};
    try { stored = row ? JSON.parse(row.value) : {}; } catch (_) {}
    const state = stored.schema === 2 ? stored : { schema: 2, legacy: stored, rules: {} };
    const before = JSON.stringify(state);
    const configuredIds = new Set(config.rules.filter(r => r.type === 'offline').map(r => r.id));
    for (const id of Object.keys(state.rules)) if (!configuredIds.has(id)) delete state.rules[id];
    const settings = notificationSettings(config);
    const messages = getNotificationMessages(settings);
    const events = [];
    for (const rule of rules) {
      const signature = ruleSignature(rule);
      let entry = state.rules[rule.id];
      if (!entry || entry.signature !== signature) {
        entry = { signature, ...(entry?.baseline ? { baseline: true } : {}), servers: !entry && rule.id === 'offline_default' ? { ...state.legacy } : {} };
      }
      for (const server of servers) {
        if (!inRuleScope(rule, server.id)) continue;
        const last = latest.get(server.id);
        const offline = !latest.has(server.id) || Date.now() - last > rule.options.minutes * 60000;
        const wasOffline = Boolean(entry.servers[server.id]);
        if (offline === wasOffline) continue;
        if (offline) entry.servers[server.id] = true;
        else delete entry.servers[server.id];
        if (entry.baseline) continue;
        const msg = offline ? server.name + '  ' + messages.lastReport(formatLastReportTime(last, settings)) : server.name;
        events.push({ ruleId: rule.id, serverId: server.id, eventKey: offline ? 'offline' : 'recovered', msg,
          context: { event: offline ? messages.events.offline : messages.events.recovered, emoji: offline ? '❌' : '✅', clients: [server.name] } });
      }
      // Preserve disabled/deleted-node legacy entries without resetting the whole site's state.
      state.rules[rule.id] = entry;
      delete entry.baseline;
    }
    if (events.length || (stored.schema === 2 && JSON.stringify(state) !== before)) {
      await db.prepare('INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(JSON.stringify(state)).run();
    }
    await dispatch(config, events, options.send);
  } catch (_) { console.error('[Notification] offline evaluation failed'); }
}

export async function checkResourceAlerts(env, options = {}) {
  if (!env?.DB || !env?.METRICS_BROADCASTER) return;

  const db = env.DB;
  const minute = Number.isFinite(options?.minute) ? options.minute : new Date().getUTCMinutes();
  // 每 2 分钟强制刷新一次设置，其余分钟复用缓存（TTL 120s），降低每分钟的 CPU 开销
  const forceRefresh = minute % 2 === 0;
  const siteSettings = options.siteSettings ?? await loadSiteSettings(db, { forceRefresh });

  try {
    const config = options.notificationConfig ?? await loadNotificationConfig(db, siteSettings);
    const rules = await Promise.all(config.rules.filter(r => r.type === 'resource' && r.enabled).map(async r => ({ ...r, ...r.options, servers: r.scope.serverIds, identity: await createNotificationRuleIdentity(r) })));
    if (!rules.length) return;
    const settings = notificationSettings(config);
    const allServers = await getAllServers(db);
    if (!allServers.length) return;

    const serverMap = new Map(allServers.map(server => [String(server.id), server]));
    const scopedIds = new Map(config.rules.filter(r => r.type === 'resource').map(r => [r.id, getResourceAlertRuleServerIds(r, allServers)]));
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const activeMap = new Map();
    const evaluationMap = new Map();
    const configuredRules = [];
    const configuredRuleServers = [];
    const evaluatedRuleServers = [];

    const configSignature = JSON.stringify({
      rules: rules.map(rule => ({
        id: rule.id,
        metric: rule.metric,
        threshold: rule.threshold,
        servers: rule.servers,
        intervalMinutes: rule.intervalMinutes,
        mode: rule.mode
      }))
    });

    for (const rule of rules) {
      const serverIds = scopedIds.get(rule.id);
      if (serverIds.length === 0) continue;

      const ruleServers = [];
      for (const serverId of serverIds) {
        const server = serverMap.get(String(serverId));
        if (!server) continue;
        ruleServers.push({
          key: getResourceAlertRuleStateKey(rule, serverId),
          rule,
          server,
          serverId: String(serverId)
        });
      }
      if (ruleServers.length === 0) continue;
      configuredRuleServers.push(...ruleServers);
      configuredRules.push({ rule, serverIds, ruleServers });
    }

    if (!configuredRuleServers.length) return;

    const evaluationResults = await evaluateResourceAlertRules(stub, configuredRules);
    for (const { rule, ruleServers } of configuredRules) {
      const result = evaluationResults.get(String(rule.id));
      if (!result) continue;
      const evaluatedServerIdSet = new Set(result.evaluatedServerIds);
      evaluatedRuleServers.push(...ruleServers.filter(item => evaluatedServerIdSet.has(item.serverId)));
      for (const alert of result.alerts) {
        activeMap.set(getResourceAlertRuleStateKey(rule, alert.serverId), { rule, alert });
      }
      for (const evaluation of result.evaluations || []) {
        evaluationMap.set(getResourceAlertRuleStateKey(rule, evaluation.serverId), evaluation);
      }
    }

    const stateRow = await db.prepare(
      `SELECT value FROM settings WHERE key = ?`
    ).bind(RESOURCE_ALERT_STATE_KEY).first();
    const hadStoredState = !!stateRow;
    const parsedState = parseResourceAlertState(stateRow);
    let alertState = parsedState.servers || {};

    const now = Date.now();
    const alertNodes = [];
    const recoveredNodes = [];
    const validStateKeys = new Set([...scopedIds].flatMap(([ruleId, ids]) => ids.map(id => `${ruleId}:${id}`)));
    let stateChanged = hadStoredState && parsedState.signature !== configSignature;

    const legacyRules = getResourceAlertConfig(siteSettings).rules;
    const migratedRules = migrateLegacyNotifications(siteSettings).rules.filter(r => r.type === 'resource');
    for (let index = 0; index < migratedRules.length; index++) {
      const migrated = migratedRules[index];
      const legacy = legacyRules[index];
      if (!legacy || legacy.id === migrated.id || !rules.some(r => r.id === migrated.id && r.identity.legacySignature === ruleSignature(migrated))) continue;
      for (const serverId of serverMap.keys()) {
        const oldKey = getResourceAlertRuleStateKey(legacy, serverId);
        const key = getResourceAlertRuleStateKey(migrated, serverId);
        if (alertState[oldKey] && !alertState[key]) {
          alertState[key] = alertState[oldKey];
          delete alertState[oldKey];
          stateChanged = true;
        }
      }
    }

    for (const key of Object.keys(alertState)) {
      if (!validStateKeys.has(key)) {
        delete alertState[key];
        stateChanged = true;
      }
    }

    for (const { key, rule, server } of evaluatedRuleServers) {
      const active = activeMap.get(key);
      const alert = active?.alert;
      const signature = rule.identity.signature;
      let currentState = alertState[key];
      if (!currentState?.pending && currentState?.signature && !matchesNotificationRuleIdentity(currentState.signature, rule.identity)) {
        delete alertState[key];
        currentState = null;
        stateChanged = true;
      }
      if (currentState && !currentState.pending && currentState.signature !== signature) {
        currentState.signature = signature;
        stateChanged = true;
      }
      const currentStatus = currentState
        ? getResourceAlertStateStatus(currentState)
        : '';
      const ruleIntervalMs = getResourceAlertRuleIntervalMs(rule);

      if (currentState?.pending) {
        if (alert) {
          alertState[key] = { signature, status: RESOURCE_ALERT_STATE_ACTIVE, alertAt: now, lastTriggeredAt: now, metrics: getStoredResourceAlertMetrics(alert) };
          stateChanged = true;
        } else if (canRecoverResourceAlert(expandResourceAlertEvaluation(evaluationMap.get(key)))) {
          delete alertState[key];
          stateChanged = true;
        }
        continue;
      }

      if (alert) {
        const isActiveAlert = currentStatus === RESOURCE_ALERT_STATE_ACTIVE;
        const recoveredAt = currentStatus === RESOURCE_ALERT_STATE_RECOVERED
          ? getResourceAlertStateTimestamp(currentState, 'recoveredAt')
          : 0;
        if (recoveredAt > 0 && now - recoveredAt < ruleIntervalMs) {
          continue;
        }

        if (!isActiveAlert) {
          alertNodes.push({ rule, server, alert });
          alertState[key] = {
            signature,
            status: RESOURCE_ALERT_STATE_ACTIVE,
            alertAt: now,
            lastTriggeredAt: now,
            metrics: getStoredResourceAlertMetrics(alert)
          };
          stateChanged = true;
        } else {
          const lastTriggeredAt = getResourceAlertStateTimestamp(currentState, 'lastTriggeredAt');
          if (lastTriggeredAt === 0 || now - lastTriggeredAt >= ruleIntervalMs) {
            alertState[key] = {
              ...currentState,
              signature,
              status: RESOURCE_ALERT_STATE_ACTIVE,
              alertAt: getResourceAlertStateTimestamp(currentState, 'alertAt') || now,
              lastTriggeredAt: now,
              metrics: getStoredResourceAlertMetrics(alert)
            };
            stateChanged = true;
          }
        }
      } else if (currentState) {
        if (currentStatus === RESOURCE_ALERT_STATE_ACTIVE) {
          const evaluation = expandResourceAlertEvaluation(evaluationMap.get(key));
          if (!canRecoverResourceAlert(evaluation)) {
            continue;
          }

          recoveredNodes.push({ rule, server, metrics: evaluation?.metrics || [] });
          alertState[key] = {
            ...currentState,
            signature,
            status: RESOURCE_ALERT_STATE_RECOVERED,
            recoveredAt: now,
            metrics: evaluation?.metrics || currentState.metrics
          };
          stateChanged = true;
        } else {
          const recoveredAt = getResourceAlertStateTimestamp(currentState, 'recoveredAt');
          if (recoveredAt === 0 || now - recoveredAt >= ruleIntervalMs) {
            delete alertState[key];
            stateChanged = true;
          }
        }
      }
    }

    if (stateChanged) {
      await saveResourceAlertState(db, configSignature, alertState, hadStoredState);
    }

    const events = [];
    for (const [nodes, eventKey] of [[alertNodes, 'resourceAlert'], [recoveredNodes, 'resourceRecovered']]) {
      for (const item of nodes) {
        const payloads = buildResourceAlertNotificationPayloads(eventKey === 'resourceAlert' ? [item] : [], eventKey === 'resourceRecovered' ? [item] : [], settings);
        for (const payload of payloads) events.push({ ruleId: item.rule.id, serverId: item.server.id, eventKey, ...payload });
      }
    }
    await dispatch(config, events, options.send);
  } catch (_) {
    console.error('[Notification] resource evaluation failed');
  }
}

export async function checkExpiringServers(db, options = {}) {
  try {
    const siteSettings = options.siteSettings ?? await loadSiteSettings(db);
    let config = null;
    try { config = options.notificationConfig ?? await loadNotificationConfig(db, siteSettings); }
    catch (_) { console.error('[Notification] expiry delivery configuration unavailable'); }
    const now = Number(options.now || Date.now());
    const expiryRules = config?.rules.filter(r => r.type === 'expiry') || [];
    const rules = expiryRules.filter(r => r.enabled);
    const identities = new Map(await Promise.all(rules.map(async r => [r.id, await createNotificationRuleIdentity(r)])));
    const scopeSets = new Map(expiryRules.map(r => [r.id, new Set(r.scope.serverIds)]));
    const applies = (rule, id) => rule.scope.mode === 'all' || scopeSets.get(rule.id).has(String(id));
    const timezone = config?.timezone ?? siteSettings.notification_timezone;
    const dueRules = rules.filter(r => !options.scheduled || Number(getZonedDateParts(now, timezone)?.hour) === r.options.hour);
    if (options.scheduled && !dueRules.length && !isExpireNotificationTimeDue(siteSettings, now)) return false;
    const servers = await getAllServers(db);
    const settings = config ? notificationSettings(config) : siteSettings;
    const currentDate = getZonedDateSerial(now, timezone);
    const messages = getNotificationMessages(settings);
    const row = config ? await db.prepare("SELECT value FROM settings WHERE key = 'expiry_notification_state'").first() : null;
    let state = {};
    try { state = row ? JSON.parse(row.value) : {}; } catch (_) {}
    const before = JSON.stringify(state);
    const events = [];
    let renewed = false;
    const validRules = new Set(expiryRules.map(r => r.id));
    for (const id of Object.keys(state)) if (!validRules.has(id)) delete state[id];
    for (const server of servers) {
      const observedRules = rules.filter(r => applies(r, server.id));
      const baselines = new Set();
      for (const rule of observedRules) {
        if (state[rule.id]?.[server.id]?.baseline) {
          baselines.add(rule.id);
          delete state[rule.id][server.id];
        }
      }
      if (!server.expire_date) continue;
      const billingCycle = normalizeBillingCycle(detectBillingCycle(server.price) || server.billing_cycle);
      const applicable = observedRules.filter(r => dueRules.includes(r));
      const days = expiryRules.length ? Math.max(0, ...expiryRules.filter(r => applies(r, server.id)).map(r => r.options.days)) : getExpireReminderDays(siteSettings.expire_reminder);
      const original = server.expire_date;
      const renewal = renewExpireDateIfNeeded(original, billingCycle, server.auto_renewal, now, Math.min(days, 5));
      let eventKey = '';
      let msg = '';
      if (renewal.renewed) {
        const result = await db.prepare('UPDATE servers SET expire_date = ?, billing_cycle = ? WHERE id = ? AND expire_date = ?').bind(renewal.expire_date, billingCycle, server.id, original).run();
        if (getD1Changes(result)) {
          server.expire_date = renewal.expire_date; server.billing_cycle = billingCycle; renewed = true;
          eventKey = 'renewed'; msg = server.name + '  ' + messages.renewedUntil(server.expire_date);
        }
      }
      const left = parseDateSerial(server.expire_date) - currentDate;
      for (const rule of eventKey === 'renewed' ? observedRules : applicable) {
        let key = eventKey;
        let body = msg;
        if (!key && !isEnabledFlag(server.auto_renewal) && left > 0 && left <= rule.options.days) {
          key = 'expiring'; body = server.name + '  ' + messages.daysLeft(left) + '  ' + server.expire_date;
        }
        if (!key) continue;
        const predicate = identities.get(rule.id);
        const identity = JSON.stringify([key, currentDate, server.expire_date, predicate.signature]);
        const entry = state[rule.id] || (state[rule.id] = {});
        const baseline = baselines.has(rule.id);
        if (entry[server.id] === identity) continue;
        let previous;
        if (typeof entry[server.id] === 'string') {
          try { previous = JSON.parse(entry[server.id]); } catch (_) {}
        }
        if (previous?.[0] === key && previous[1] === currentDate && previous[2] === server.expire_date && matchesNotificationRuleIdentity(previous[3], predicate)) {
          entry[server.id] = identity;
          continue;
        }
        entry[server.id] = identity;
        if (baseline && key !== 'renewed') continue;
        events.push({ ruleId: rule.id, serverId: server.id, eventKey: key, msg: body,
          context: { event: messages.events[key], emoji: key === 'renewed' ? '✅' : '⚠️', clients: [server.name] } });
      }
    }
    if (renewed) clearServersListCache();
    const currentIds = new Set(servers.map(s => String(s.id)));
    for (const entry of Object.values(state)) for (const id of Object.keys(entry)) if (!currentIds.has(id)) delete entry[id];
    if (JSON.stringify(state) !== before) await db.prepare("INSERT INTO settings(key,value) VALUES('expiry_notification_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(state)).run();
    if (config) await dispatch(config, events, options.send);
    return true;
  } catch (_) { console.error('[Notification] expiry evaluation failed'); return false; }
}
