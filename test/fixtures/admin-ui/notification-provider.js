import { createApp, h, ref } from 'vue'
import NotificationDialog from '../../../src/frontend/views/admin/components/NotificationDialog.vue'
import { newChannel } from '../../../src/frontend/views/admin/composables/notificationPresentation.js'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import en from '../../../src/frontend/locales/en.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'

await setLanguage('en')
const draft = ref(newChannel())
if (new URLSearchParams(location.search).has('empty')) Object.assign(draft.value, { name: '', enabled: false, template: '' })
const events = ref([])
createApp({
  render: () => h('main', [
    h(NotificationDialog, { draft: draft.value, trans: en, busy: false, locked: false, onSave: () => events.value.push('save'), onTest: () => events.value.push('test'), onClose: () => events.value.push('close') }),
    h('output', { id: 'model' }, JSON.stringify({ name: draft.value.name, enabled: draft.value.enabled, template: draft.value.template, type: draft.value.type, config: draft.value.config, secretKeys: Object.keys(draft.value.secrets), clearSecrets: draft.value.clearSecrets })),
    h('output', { id: 'events' }, JSON.stringify(events.value))
  ])
}).mount('#app')
