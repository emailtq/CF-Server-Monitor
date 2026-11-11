import test from 'node:test';
import assert from 'node:assert/strict';
import { sendNotification } from '../src/services/notification.js';
import { notificationChannelSettings } from '../src/database/notifications.js';

const routing = await import('../src/services/notificationRouting.js').catch(() => ({}));
const channel = (id, overrides = {}) => ({ id, name: id, type: 'telegram', enabled: true, config: { chatId: id }, secrets: { botToken: `fixture-${id}` }, template: `${id}:{{message}}`, ...overrides });
const rule = (id, ids, targets, overrides = {}) => ({ id, name: id, type: 'offline', enabled: true, scope: { mode: 'selected', serverIds: ids }, targetIds: targets, options: { minutes: 5 }, ...overrides });
const config = (channels, rules) => ({ schema: 1, revision: 1, timezone: 'UTC', language: 'en', channels, rules });
const event = (ruleId, serverId, msg = serverId, eventKey = 'offline') => ({ ruleId, serverId, eventKey, msg, context: { event: 'Offline', clients: [serverId] } });

test('disjoint scopes reject forged node events before combining channel messages', () => {
  assert.equal(typeof routing.routeNotificationEvents, 'function');
  const batches = routing.routeNotificationEvents(config([channel('a'), channel('b')], [rule('ra', ['A'], ['a']), rule('rb', ['B'], ['b'])]), [event('ra', 'A'), event('rb', 'B'), event('ra', 'B', 'LEAK')]);
  assert.deepEqual(batches.map(b => [b.channelId, b.events.map(e => e.serverId), b.msg]), [['a', ['A'], 'A'], ['b', ['B'], 'B']]);
});

test('overlapping rules dedupe only identical channel/server/event; recovery remains separate', () => {
  assert.equal(typeof routing.routeNotificationEvents, 'function');
  const batches = routing.routeNotificationEvents(config([channel('a'), channel('b')], [rule('ra', ['A'], ['a', 'b']), rule('rb', ['A'], ['a'])]), [event('ra', 'A'), event('rb', 'A'), event('ra', 'A', 'Recovery', 'recovered')]);
  assert.deepEqual(batches.map(b => [b.channelId, b.events.length]), [['a', 1], ['b', 1], ['a', 1], ['b', 1]]);
  assert.equal(new Set(batches.flatMap(b => b.deliveryKeys)).size, 4);
});

test('two same-type instances deliver their own actual template payloads', async t => {
  assert.equal(typeof routing.dispatchNotificationEvents, 'function');
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { payloads.push([String(url), JSON.parse(options.body)]); return Response.json({ ok: true }); });
  const c = config([channel('a'), channel('b', { template: 'second {{event}} {{message}}', config: { chatId: 'a' } })], [rule('ra', ['A'], ['a', 'b'])]);
  const results = await routing.dispatchNotificationEvents(c, [event('ra', 'A', 'body')], { send: (ch, msg, context) => sendNotification(notificationChannelSettings(ch, c), msg, context) });
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0][1].text, 'a:body');
  assert.equal(payloads[1][1].text, 'second Offline body');
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.success));
  assert.equal(JSON.stringify(results).includes('fixture-'), false);
});

test('a failing target cannot abort another target and errors contain no transport secrets', async () => {
  assert.equal(typeof routing.dispatchNotificationEvents, 'function');
  const c = config([channel('a'), channel('b')], [rule('ra', ['A'], ['a', 'b'])]);
  const results = await routing.dispatchNotificationEvents(c, [event('ra', 'A')], { send: async ch => { if (ch.id === 'a') throw Error('https://secret-token@host/ SMTP credential'); return ''; } });
  assert.deepEqual(results.map(r => [r.channelId, r.success]), [['a', false], ['b', true]]);
  assert.equal(/secret|host|SMTP/.test(JSON.stringify(results)), false);
});

test('dispatch caps simultaneous transports at three even when requested above the cap', async () => {
  assert.equal(typeof routing.dispatchNotificationEvents, 'function');
  const channels = Array.from({ length: 8 }, (_, i) => channel(`c${i}`));
  let active = 0, peak = 0, sent = 0;
  await routing.dispatchNotificationEvents(config(channels, [rule('ra', ['A'], channels.map(c => c.id))]), [event('ra', 'A')], { concurrency: 99, send: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; sent++; return ''; } });
  assert.equal(sent, 8);
  assert.equal(peak, 3);
});

test('disabled rules/channels, legal empty, invalid channels and future schema never send', async () => {
  assert.equal(typeof routing.dispatchNotificationEvents, 'function');
  let sends = 0;
  for (const c of [config([], []), config([channel('a', { enabled: false })], [rule('ra', ['A'], ['a'])]), config([channel('a')], [rule('ra', ['A'], ['a'], { enabled: false })]), { ...config([channel('a')], [rule('ra', ['A'], ['a'])]), schema: 2 }, config([channel('a', { secrets: {} })], [rule('ra', ['A'], ['a'])])]) {
    assert.deepEqual(await routing.dispatchNotificationEvents(c, [event('ra', 'A')], { send: async () => { sends++; } }), []);
  }
  assert.equal(sends, 0);
});
