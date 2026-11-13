import { createApp, h, reactive, computed, nextTick } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import Admin from '../../../src/frontend/views/admin/index.vue'
import Terminal from '../../../src/frontend/views/admin/Terminal.vue'
import DatabasePanel from '../../../src/frontend/views/admin/components/DatabasePanel.vue'
import NotificationWorkspace from '../../../src/frontend/views/admin/components/NotificationWorkspace.vue'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage, t } from '../../../src/frontend/utils/i18n.js'
import { newChannel, ruleOptions } from '../../../src/frontend/views/admin/composables/notificationPresentation.js'
import en from '../../../src/frontend/locales/en.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'

const components = import.meta.glob('../../../src/frontend/views/admin/components/*Modal.vue', { eager: true, import: 'default' })
const dialogs = import.meta.glob('../../../src/frontend/views/admin/components/*Dialog.vue', { eager: true, import: 'default' })
const find = name => Object.entries({ ...components, ...dialogs }).find(([file]) => file.endsWith(`/${name}.vue`))[1]
const query = new URLSearchParams(location.search)
await initConfig()
await setLanguage(query.get('locale') || 'en')
document.body.classList.add('admin-ui-surface', 'light')
const trans = computed(() => Object.fromEntries(Object.keys(en).map(key => [key, t(key)])))
const long = 'Long fixture node / group with descriptive information '.repeat(3)
const form = () => ({ id: 'node-a', name: long, server_group: long, note: long, currency: '$', price: '4.5', billing_cycle: 'month', expire_date: '2027-01-01', connection_mode: 'auto', ping_mode: 'tcp', auto_update: false })
const servers = Array.from({ length: 30 }, (_, i) => ({ id: `node-${i}`, name: `${i} ${long}`, server_group: long }))
const channel = { ...newChannel('smtp'), id: 'channel-a', name: long, enabled: true, config: { host: 'smtp.fixture.invalid', port: 465, secure: 'auto' } }
const rule = { id: 'rule-a', name: long, enabled: true, type: 'resource', options: ruleOptions('resource'), scope: { mode: 'all', serverIds: [] }, targetIds: ['channel-a'] }
const state = reactive({ kind: '', open: false, busy: false, props: {}, events: [] })
let component
const capture = vm => { component = vm }
const event = name => (...args) => { state.events.push({ name, args }); if (name === 'close') state.open = false }
const directNames = { add: 'AddServerModal', group: 'GroupServersModal', delete: 'DeleteServerModal', edit: 'EditServerModal', batch: 'BatchEditServersModal', renew: 'RenewServerModal', download: 'CopyCommandModal', downloadConfirm: 'CopyCommandModal', autoDiscovery: 'AutoDiscoveryCommandModal', revoke: 'TerminalAccessModal', notificationCreate: 'NotificationDialog', notificationSmtp: 'NotificationDialog', notificationWebhook: 'NotificationDialog', notificationTemplate: 'NotificationDialog', alert: 'AlertDialog' }
const mountKind = name => directNames[name] ? find(directNames[name]) : name === 'terminal' ? Terminal : name === 'database' ? DatabasePanel : name === 'notificationRemoval' ? NotificationWorkspace : Admin
const fixture = window.dialogFixture = {
  state, setLanguage,
  async open(kind, stress = false) {
    state.open = false
    await nextTick()
    state.kind = kind
    state.busy = false
    state.events = []
    const enabled = Object.fromEntries(['name', 'server_group', 'traffic_limit', 'traffic_calc_type', 'reset_day', 'traffic_alert_percent', 'price', 'currency', 'billing_cycle', 'expire_date', 'ping_node', 'ping_node2', 'ping_node3'].map(key => [key, true]))
    state.props = { show: true, trans: trans.value, settings: { wss_report_enabled: true, terminal_enabled: true }, currentServerName: 'Fixture node with a long descriptive name', serverName: long, serverId: 'node-a', server: { id: 'node-a', name: long }, groups: [long], servers, selected: ['node-0'], selectedCount: 3, name: long, group: long, form: form(), editForm: form(), enabled, deleteServerId: 'node-a', uninstallCommand: 'fixture-uninstall ' + 'path-'.repeat(120), deleteInstallMode: 'cfsm-user', deleteGhProxy: 'https://fixture.invalid/', targetOs: 'linux', ghProxy: 'https://fixture.invalid/', installCommand: 'fixture-install ' + 'path-'.repeat(120), channels: [channel], draft: kind === 'alert' ? structuredClone(rule) : { ...newChannel(kind === 'notificationWebhook' ? 'webhook' : 'smtp'), ...(kind !== 'notificationCreate' ? { id: 'channel-a' } : {}), name: long, template: '{{message}}\n' + long.repeat(4), secrets: {}, secretFields: {}, clearSecrets: [] } }
    if (stress) {
      // Extend real translated form labels, not dialog titles/action names, to stress wrapping.
      state.props.trans = { ...trans.value }
      for (const key of ['serverName', 'group', 'hostnameLabel', 'groupName', 'price', 'expirationDate', 'targetOs', 'ghProxy', 'adminNotificationName', 'adminRuleName', 'adminNotifications', 'theme', 'language']) state.props.trans[key] += ' / extended descriptive localized field label'
    }
    state.open = true
    await nextTick()
    await nextTick()
    if (kind === 'notificationTemplate') component.$.setupState.step = 2
    if (kind === 'downloadConfirm') component.$.setupState.confirmReissue = true
    if (kind === 'terminal') component.$.setupState.showMenu = true
    if (kind === 'database') component.$.setupState.showSensitiveConfirm = true
    if (kind === 'notificationRemoval') { component.$.setupState.config = { schema: 1, revision: 1, channels: [channel], rules: [] }; component.$.setupState.removal = { kind: 'channel', value: channel } }
    const s = component.$.setupState
    if (kind === 'autoUpdateWarning') s.showAutoUpdateWarning = true
    if (kind === 'databaseClear' || kind === 'databaseUpgrade') { s.dbOperation = kind === 'databaseClear' ? 'clearHistory' : 'upgrade'; s.showDbModal = true }
    if (kind === 'd1Usage') s.d1UsageResult = { success: true, usage: { today: { rowsRead: 70000, rowsWritten: 12000, workersRequests: 500, durableObjectsRequests: 500, durableObjectsDuration: 3 }, yesterday: { rowsRead: 50000, rowsWritten: 500, workersRequests: 800 } } }
    if (kind === 'validation') s.validationError = long.repeat(5)
    if (kind === 'saveResult') s.saveResult = { success: false, error: long.repeat(5) }
    if (kind === 'message') s.alertMessage = long.repeat(5)
    await nextTick()
  },
  async busy(value) { state.busy = value; await nextTick() },
  async stack() { component.$.setupState.confirmReissue = true; await nextTick() }
}
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/admin', component: Admin }, { path: '/admin/terminal/:id', component: Terminal }] })
const app = createApp({ render: () => h('div', [h('button', { id: 'outside', onClick: () => fixture.open('add') }, 'Outside trigger'), state.open ? h(mountKind(state.kind), {
  ref: capture, key: state.kind, ...state.props, busy: state.busy, saving: state.busy,
  onClose: event('close'), onSave: event('save'), onToggle: event('toggle'), onTest: event('test'),
  'onUpdate:form': value => { state.props.form = value }, 'onUpdate:editForm': value => { state.props.editForm = value },
  'onUpdate:name': value => { state.props.name = value }, 'onUpdate:group': value => { state.props.group = value },
  'onUpdate:target-os': value => { state.props.targetOs = value },
  'onUpdate:autoUpdate': value => { state.props.autoUpdate = value }
}) : null]) })
app.provide('appConfig', { authorization: true, last_agent_version: 'fixture' })
app.use(router)
await router.isReady()
app.mount('#app')
