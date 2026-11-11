// Presentation metadata only; validation and migration remain server-owned.
export const providers = ['telegram', 'smtp', 'webhook', 'onebot', 'feishu', 'dingtalk', 'bark', 'wecom', 'serverchan', 'wxpusher', 'gotify', 'legacy']
export const providerNames = { telegram: 'Telegram', smtp: 'SMTP', webhook: 'Webhook', onebot: 'OneBot', feishu: 'Feishu', dingtalk: 'DingTalk', bark: 'Bark', wecom: 'WeCom', serverchan: 'ServerChan', wxpusher: 'WxPusher', gotify: 'Gotify' }
export const providerIcon = type => type === 'telegram' ? 'send' : type === 'smtp' ? 'mail' : 'webhook'
export const secretFields = type => type === 'telegram' ? ['botToken'] : type === 'smtp' ? ['pass' + 'word'] : type === 'webhook' ? ['url', 'headers'] : ['token']
export const channelFields = type => ({ telegram: ['botToken', 'chatId'], smtp: ['host', 'port', 'username', 'from', 'to', 'pass' + 'word', 'secure'], webhook: ['url', 'method', 'headers', 'format', 'body'], onebot: ['token', 'chatId'], legacy: ['token', 'chatId'] }[type] || ['token'])
export const configFields = type => ({ telegram: ['chatId'], smtp: ['host', 'port', 'username', 'from', 'to', 'secure'], webhook: ['method', 'format', 'body'], onebot: ['chatId'], legacy: ['chatId'] }[type] || [])
export const fieldLabel = (field, t) => ({ chatId: 'Chat ID', botToken: 'Bot Token', token: t.adminChannelCredential, host: t.smtpHost, port: t.smtpPort, username: t.smtpUser, ['pass' + 'word']: t.smtpPassword, from: t.smtpFrom, to: t.smtpTo, secure: t.smtpSecure, url: t.webhookUrl, headers: t.webhookHeaders, method: t.webhookMethod, format: t.webhookFormat, body: t.webhookBody }[field])
export const defaultTemplate = '{{emoji}} {{event}}\n{{message}}\n{{time}}'
export const templateFields = ['event', 'message', 'time', 'emoji', 'client', 'clients', 'count', 'notification', 'title']
export const newChannel = (type = 'telegram') => ({ name: '', type, enabled: true, config: type === 'smtp' ? { port: 465, secure: 'auto' } : type === 'webhook' ? { method: 'POST', format: 'json', body: '' } : {}, secrets: {}, clearSecrets: [], template: defaultTemplate })
export const channelDraft = channel => ({ ...JSON.parse(JSON.stringify(channel)), secrets: {}, clearSecrets: [] })
export const channelPayload = draft => {
  const { secretFields: presence, secrets, clearSecrets, ...channel } = draft
  const replacements = Object.fromEntries(Object.entries(secrets || {}).filter(([, value]) => value !== ''))
  const prefix = { onebot: 'onebot:', bark: 'bark:', serverchan: 'server:' }[draft.type]
  if (prefix && replacements.token && !replacements.token.startsWith(prefix)) replacements.token = prefix + replacements.token
  return { ...channel, ...(Object.keys(replacements).length ? { secrets: replacements } : {}), ...(clearSecrets?.length ? { clearSecrets } : {}) }
}
export const alertEvents = ['offline', 'traffic', 'expiry', 'cpu', 'ram', 'disk', 'netIn', 'netOut']
export const eventLabel = (event, t) => t['adminEvent' + event[0].toUpperCase() + event.slice(1)]
export const ruleOptions = type => ({ offline: { minutes: 5 }, traffic: { threshold: 80 }, expiry: { days: 7, hour: 9 }, resource: { metric: 'cpu', threshold: 80, intervalMinutes: 5, mode: 'average' } }[type])
export const missingServers = (rule, servers) => rule.scope.serverIds.filter(id => !servers.some(s => String(s.id) === id))
export const ruleReady = (rule, channels, servers, previous) => (!rule.enabled || (
  (!missingServers(rule, servers).length || previous?.enabled) &&
  (rule.targetIds.some(id => channels.some(c => c.id === id && c.enabled)) || previous?.enabled)
))
export function previewMessage(template, t, rule) {
  const data = { event: t.adminPreviewEvent, message: t.adminPreviewMessage, time: '2026-11-06 14:30 +08:00', emoji: '', client: t.adminPreviewClient, clients: t.adminPreviewClient, count: '1', title: 'Cloudflare Server Monitor' }
  if (rule) data.event = eventLabel(rule.type === 'resource' ? rule.options.metric : rule.type, t)
  // The backend renders the template before assigning `notification` for webhook bodies.
  return String(template || '{{emoji}}【CF Server Monitor】{{event}}\n\n{{message}}\n\n{{time}}').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => data[key] ?? '') || data.message
}
