import { validateNotificationConfig } from '../shared/notificationConfig.js';
import { notificationChannelSettings } from '../database/notifications.js';
import { RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT } from '../utils/config.js';

export function notificationDeliveryKey(channelId, serverId, eventKey) {
  return JSON.stringify([channelId, String(serverId), eventKey]);
}

export function routeNotificationEvents(config, events) {
  try {
    config = validateNotificationConfig(config, { previousConfig: config, validateServerReferences: false });
  } catch (_) { return []; }
  const channels = new Map();
  for (const channel of config.channels) {
    if (!channel.enabled) continue;
    try { notificationChannelSettings(channel, config); channels.set(channel.id, channel); } catch (_) {}
  }
  const rules = new Map(config.rules.filter(r => r.enabled).map(r => [r.id, r]));
  const selectedScopes = new Map([...rules].filter(([, r]) => r.scope.mode === 'selected').map(([id, r]) => [id, new Set(r.scope.serverIds)]));
  const deliveries = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const rule = rules.get(event?.ruleId);
    if (!rule || !event.serverId || typeof event.eventKey !== 'string' || !event.eventKey || typeof event.msg !== 'string') continue;
    if (rule.scope.mode === 'selected' && !selectedScopes.get(rule.id).has(String(event.serverId))) continue;
    for (const channelId of rule.targetIds) {
      if (!channels.has(channelId) || (event.targetIds && !event.targetIds.includes(channelId))) continue;
      const key = notificationDeliveryKey(channelId, event.serverId, event.eventKey);
      const existing = deliveries.get(key);
      if (existing) {
        if (!existing.event.ruleIds.includes(rule.id)) existing.event.ruleIds.push(rule.id);
        if (!existing.messages.includes(event.msg)) existing.messages.push(event.msg);
      } else deliveries.set(key, { key, channelId, event: { ...event, ruleIds: [rule.id] }, messages: [event.msg] });
    }
  }
  const batches = [];
  const groups = new Map();
  for (const delivery of deliveries.values()) {
    const msg = delivery.messages.join('\n');
    const groupKey = JSON.stringify([delivery.channelId, delivery.event.eventKey]);
    let batch = groups.get(groupKey);
    if (!batch || (batch.msg.length + msg.length + 1 > RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT)) {
      batch = { channelId: delivery.channelId, channel: channels.get(delivery.channelId), events: [], deliveryKeys: [], msg: '', context: {} };
      batches.push(batch);
      groups.set(groupKey, batch);
    }
    batch.events.push(delivery.event);
    batch.deliveryKeys.push(delivery.key);
    batch.msg = batch.msg ? `${batch.msg}\n${msg}` : msg;
    const clients = [...new Set(batch.events.flatMap(e => e.context?.clients || (e.context?.client ? [e.context.client] : [])))];
    batch.context = { ...batch.events[0].context, message: batch.msg, clients, count: new Set(batch.events.map(e => String(e.serverId))).size };
  }
  return batches;
}

export async function dispatchNotificationEvents(config, events, { send, concurrency = 3 } = {}) {
  const batches = routeNotificationEvents(config, events);
  const results = new Array(batches.length);
  let cursor = 0;
  const workers = Math.min(3, Math.max(1, Math.floor(Number(concurrency) || 3)), batches.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < batches.length) {
      const index = cursor++;
      const batch = batches[index];
      let success = false;
      try { success = !(await send(batch.channel, batch.msg, batch.context)); } catch (_) {}
      results[index] = batch.deliveryKeys.map(deliveryKey => ({ deliveryKey, channelId: batch.channelId, success, ...(success ? {} : { error: 'notification_delivery_failed' }) }));
    }
  }));
  return results.flat();
}
