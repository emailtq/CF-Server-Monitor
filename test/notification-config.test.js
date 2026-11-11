import test from 'node:test';
import assert from 'node:assert/strict';

const feature = await import('../src/shared/notificationConfig.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const { validateNotificationConfig: validate, maskNotificationConfig: mask, migrateLegacyNotifications: migrate } = feature;
const channel = (id = 'one') => ({ id, name: 'Ops', type: 'telegram', enabled: true, config: { chatId: '42' }, secrets: { botToken: `${id}-secret` }, template: '{{message}}' });
const base = () => ({ schema: 1, revision: 0, channels: [channel()], rules: [] });
const rule = () => ({ id: 'offline', name: 'Offline', type: 'offline', enabled: true, scope: { mode: 'all', serverIds: [] }, targetIds: ['one'], options: { minutes: 5 } });
const check = raw => {
  assert.equal(typeof validate, 'function', 'notification schema validation is not implemented');
  return validate(raw, { serverIds: new Set(['node-a', 'node-b']) });
};
const invalid = raw => assert.throws(() => check(raw), error => error.code === 'notification_config_invalid');

test('two same-type instances preserve independent templates without credential DTO leakage', () => {
  const raw = base();
  raw.channels.push({ ...channel('two'), template: '{{event}}' });
  const safe = mask(check(raw));
  assert.equal(safe.channels[1].template, '{{event}}');
  assert.deepEqual(safe.channels[0].secretFields, { botToken: true });
  assert.equal('secrets' in safe.channels[0], false);
  for (const secret of ['one-secret', 'two-secret']) assert.equal(JSON.stringify(safe).includes(secret), false);
});

test('strict schema rejects coercion, duplicate IDs, unsafe IDs, unknown and prototype keys', () => {
  for (const mutate of [
    raw => raw.schema = 2, raw => raw.revision = '0', raw => raw.channels[0].enabled = 'true',
    raw => raw.channels.push(channel()), raw => raw.channels[0].id = 'bad id',
    raw => raw.channels[0].config.extra = 'x', raw => raw.channels[0].secrets.extra = 'x',
    raw => raw.extra = 1, raw => raw.channels[0].config = JSON.parse('{"__proto__":{}}'),
    raw => raw.channels[0].secrets.botToken = '********',
    raw => raw.channels[0].secretFields = { botToken: 'yes' },
    raw => raw.channels[0].config = Object.create({ chatId: '42' })
  ]) { const raw = base(); mutate(raw); invalid(raw); }
});

test('every object/array/string bound rejects rather than truncates and counts UTF8 bytes', () => {
  for (const mutate of [
    raw => raw.channels = Array.from({ length: 65 }, (_, i) => channel(`c${i}`)),
    raw => raw.channels[0].id = 'a'.repeat(65), raw => raw.channels[0].name = 'a'.repeat(101),
    raw => raw.channels[0].template = 'a'.repeat(4001),
    raw => raw.rules = Array.from({ length: 65 }, (_, i) => ({ ...rule(), id: `r${i}` })),
    raw => raw.rules = [{ ...rule(), targetIds: Array.from({ length: 17 }, (_, i) => `c${i}`) }],
    raw => raw.rules = [{ ...rule(), scope: { mode: 'selected', serverIds: Array(1001).fill('node-a') } }],
    raw => raw.channels = Array.from({ length: 64 }, (_, i) => ({ ...channel(`c${i}`), template: '\u4e2d'.repeat(4000) })),
    raw => raw.channels = [{ id: 'w', name: 'Hook', type: 'webhook', enabled: false, config: { method: 'POST', format: 'text', body: 'a'.repeat(8001) }, secrets: {}, template: '' }],
    raw => raw.channels = [{ id: 'w', name: 'Hook', type: 'webhook', enabled: false, config: { method: 'POST', format: 'text', body: '' }, secrets: { headers: 'a'.repeat(4001) }, template: '' }]
  ]) { const raw = base(); mutate(raw); invalid(raw); }
  const raw = base(); raw.channels[0].name = 'a'.repeat(100); raw.channels[0].template = 'a'.repeat(4000);
  assert.equal(check(raw).channels[0].template.length, 4000);
});

test('rules reject bad references, foreign nodes, duplicates and invalid options', () => {
  for (const changed of [
    { targetIds: ['missing'] }, { targetIds: ['one', 'one'] },
    { scope: { mode: 'all', serverIds: ['node-a'] } },
    { scope: { mode: 'selected', serverIds: ['foreign'] } },
    { scope: { mode: 'selected', serverIds: [] } },
    { scope: { mode: 'selected', serverIds: ['node-a', 'node-a'] } },
    { options: { minutes: '5' } }, { options: { minutes: 31 } }, { options: { minutes: 5, extra: 0 } },
    { type: 'constructor' }, { type: 'future' }
  ]) { const raw = base(); raw.rules = [{ ...rule(), ...changed }]; invalid(raw); }
  const raw = base(); raw.rules = [rule(), rule()]; invalid(raw);
  raw.rules = [{ ...rule(), scope: { mode: 'selected', serverIds: ['node-b'] } }];
  assert.deepEqual(check(raw).rules[0].scope.serverIds, ['node-b']);
});

test('resource limits and thresholds retain original percent/Mbps/window/mode constraints', () => {
  const resource = { ...rule(), type: 'resource', options: { metric: 'cpu', threshold: 80, intervalMinutes: 5, mode: 'average' } };
  for (const options of [
    { ...resource.options, threshold: 101 }, { ...resource.options, intervalMinutes: 4 },
    { ...resource.options, mode: 'unknown' }, { ...resource.options, metric: 'other' },
    { ...resource.options, metric: 'netIn', threshold: 100001 }
  ]) { const raw = base(); raw.rules = [{ ...resource, options }]; invalid(raw); }
  const raw = base(); raw.rules = Array.from({ length: 21 }, (_, i) => ({ ...resource, id: `r${i}` })); invalid(raw);
});

test('URL authentication, sensitive headers, SMTP passwords and unknown targets stay entirely server-only', () => {
  const settings = { tg_bot_token: 'https://unknown.example/key/private-token', tg_chat_id: '42', notification_webhook_enabled: 'true', notification_webhook_url: 'https://user:password@example.test/private-path?unknown=secret-query', notification_webhook_headers: '{"X-Unknown-Credential":"header-secret"}', notification_template: '{{event}}', notification_timezone: 'Asia/Shanghai', notification_language: 'es', tg_notify: '5', expire_reminder: '7', traffic_alert_threshold: '80' };
  assert.equal(typeof migrate, 'function', 'read-only legacy migration is not implemented');
  const migrated = migrate(settings);
  assert.deepEqual(migrated, migrate(settings));
  assert.equal(migrated.channels[0].type, 'webhook');
  assert.equal(migrated.channels[0].enabled, true);
  assert.equal(migrated.channels[1].type, 'legacy');
  assert.equal(migrated.channels[1].enabled, false);
  assert.equal(migrated.channels[1].secrets.token, settings.tg_bot_token);
  assert.equal(migrated.rules[0].id, 'offline_default');
  assert.equal(migrated.channels[0].template, '{{event}}');
  assert.equal(migrated.timezone, 'Asia/Shanghai');
  assert.equal(migrated.language, 'es');
  const dto = mask(check(migrated));
  for (const value of ['password', 'private-path', 'secret-query', 'header-secret', 'private-token']) assert.equal(JSON.stringify(dto).includes(value), false);
  const smtp = migrate({ tg_bot_token: 'smtp://user%40example.test:smtp-secret@mail.example.test:587?to=ops%40example.test' });
  assert.equal(smtp.channels[0].type, 'smtp');
  assert.equal(smtp.channels[0].secrets.password, 'smtp-secret');
  assert.equal(JSON.stringify(mask(check(smtp))).includes('smtp-secret'), false);
});

test('legacy provider identification preserves the original sender target and inactive filled channels', () => {
  const cases = [
    ['123:abc', 'telegram'], ['onebot:http://127.0.0.1/send_group_msg?access_token=x', 'onebot'],
    ['https://open.feishu.cn/open-apis/bot/v2/hook/x', 'feishu'], ['https://oapi.dingtalk.com/robot/send?access_token=x', 'dingtalk'],
    ['bark:https://api.day.app/x', 'bark'], ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'wecom'],
    ['server:https://sctapi.ftqq.com/x.send', 'serverchan'], ['https://wxpusher.zjiecode.com/api/send/message/SPT_x', 'wxpusher'],
    ['https://gotify.example/message?token=x', 'gotify'], ['https://pushplus.example/send?token=x', 'legacy']
  ];
  assert.equal(typeof migrate, 'function');
  for (const [token, type] of cases) {
    const raw = migrate({ tg_bot_token: token, tg_chat_id: '42', notification_webhook_enabled: 'false', notification_webhook_url: 'https://example.test/unused' });
    assert.equal(raw.channels.find(c => c.id === 'legacy_builtin').type, type);
    assert.equal(raw.channels.find(c => c.id === 'legacy_webhook').enabled, false);
    assert.equal(raw.rules.some(r => ['offline', 'resource'].includes(r.type) && r.enabled), false);
  }
  assert.equal(migrate({ tg_notify: '5', expire_reminder: '7' }).rules.some(r => r.enabled), false);
});

test('legacy expiry-off retains renewal-only notifications, original time zone and zero reminder threshold', () => {
  const raw = migrate({ tg_bot_token: '123:abc', tg_chat_id: '42', expire_reminder: '0', notification_timezone: 'UTC', expire_notification_time: '18' });
  const expiry = raw.rules.find(r => r.id === 'expiry_default');
  assert.ok(expiry, 'renewal notifications must not disappear just because expiry reminders are off');
  assert.equal(expiry.enabled, true);
  assert.deepEqual(expiry.options, { days: 0, hour: 18 });
  check(raw);
  const unknown = migrate({ tg_bot_token: 'unidentified-without-chat-id', tg_notify: '5' });
  assert.equal(unknown.channels[0].enabled, false);
  assert.equal(unknown.rules.some(r => r.enabled), false);
});

test('long legacy resource IDs remain distinct and stable without silent ID truncation', () => {
  const common = 'a'.repeat(63);
  const settings = { resource_alert_rules: [
    { id: `${common}x`, name: 'CPU', metric: 'cpu', threshold: 80 },
    { id: `${common}y`, name: 'RAM', metric: 'ram', threshold: 90 }
  ] };
  const raw = migrate(settings);
  assert.equal(new Set(raw.rules.map(r => r.id)).size, 2);
  const reordered = migrate({ resource_alert_rules: [...settings.resource_alert_rules].reverse() });
  assert.equal(raw.rules.find(r => r.name === 'CPU').id, reordered.rules.find(r => r.name === 'CPU').id);
  check(raw);
});

test('optional schema fields accept omission but never coerce explicit null', () => {
  for (const mutate of [raw => raw.timezone = null, raw => raw.language = null, raw => raw.channels[0].secrets = null]) {
    const raw = base(); mutate(raw); invalid(raw);
  }
});

test('global-zero legacy traffic preserves an enabled default route only for per-node overrides', () => {
  const raw = migrate({ tg_bot_token: '123:abc', tg_chat_id: '42', traffic_alert_threshold: '0' });
  assert.deepEqual(raw.rules.find(r => r.id === 'traffic_default'), {
    id: 'traffic_default', name: 'Traffic', type: 'traffic', enabled: true,
    scope: { mode: 'all', serverIds: [] }, targetIds: ['legacy_builtin'], options: { threshold: 0 }
  });
  const off = migrate({ traffic_alert_threshold: '0' });
  assert.equal(off.rules.some(r => r.enabled), false);
  check(raw);
});

test('explicit providers reject mismatched targets and retain supported self-hosted/prefixed forms', () => {
  const cases = [
    ['onebot', 'onebot:http://127.0.0.1:3000/send_group_msg?access_token=fixture', { chatId: '42' }],
    ['feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture', {}],
    ['dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=fixture', {}],
    ['bark', 'bark:https://self-hosted.example.test/custom/key', {}],
    ['serverchan', 'server:https://self-hosted.example.test/custom.send', {}],
    ['wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture', {}],
    ['wxpusher', 'https://wxpusher.zjiecode.com/api/send/message/SPT_fixture', {}],
    ['gotify', 'https://self-hosted.example.test/message?token=fixture', {}],
    ['legacy', 'opaque-fixture-token', { chatId: '42' }]
  ];
  for (const [type, token, config] of cases) {
    const raw = base(); raw.channels = [{ ...channel(), type, config, secrets: { token } }];
    assert.equal(check(raw).channels[0].type, type);
  }
  for (const [type, token, config] of [
    ['feishu', cases[0][1], {}], ['dingtalk', cases[3][1], {}], ['onebot', cases[1][1], { chatId: '42' }],
    ['feishu', cases[5][1], {}], ['dingtalk', cases[1][1], {}],
    ['onebot', 'onebot:file:///tmp/target', { chatId: '42' }], ['legacy', 'opaque-fixture-token', {}],
    ['telegram', cases[1][1], { chatId: '42' }]
  ]) {
    const raw = base(); raw.channels = [{ ...channel(), type, config, secrets: { [type === 'telegram' ? 'botToken' : 'token']: token } }];
    invalid(raw);
  }
  const unknown = migrate({ tg_bot_token: 'https://unknown.example.test/fixture', tg_chat_id: '42', tg_notify: '5' });
  assert.equal(unknown.channels[0].type, 'legacy');
  assert.equal(unknown.channels[0].enabled, false);
  assert.equal(unknown.rules.some(r => r.enabled), false);
});
