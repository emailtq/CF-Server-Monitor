import { createApp, h, reactive, computed } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Admin from '../../../src/frontend/views/admin/index.vue'
import CopyCommandModal from '../../../src/frontend/views/admin/components/CopyCommandModal.vue'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage, t } from '../../../src/frontend/utils/i18n.js'
import en from '../../../src/frontend/locales/en.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'

if (new URLSearchParams(location.search).has('controlled')) {
  const meta = document.createElement('meta')
  meta.name = 'apiBase'
  meta.content = `${location.origin},${location.origin}`
  document.head.append(meta)
}
await initConfig()
await setLanguage(new URLSearchParams(location.search).get('locale') || 'en')
if (new URLSearchParams(location.search).has('controlled')) {
  // Boundary harness only: real modal/API, synthetic parent command. Full Admin is used otherwise.
  const state = reactive({ show: true, serverId: 'node-a', apiIndex: 0, generation: 0, targetOs: 'linux', installMode: 'current-user', installGhProxy: '', installVersion: '', autoUpdate: false, options: {}, available: false })
  const trans = computed(() => Object.fromEntries(Object.keys(en).map(key => [key, t(key)])))
  const owner = computed(() => { const generation = state.generation; return () => generation === state.generation })
  window.downloadFixture = { state, setLanguage }
  document.body.classList.add('admin-ui-surface')
  const app = createApp({ render: () => h('div', [h('button', { id: 'outside' }, 'Outside'), h(CopyCommandModal, {
    ...state, trans: trans.value, requestOwner: owner.value, currentServerName: state.serverId,
    settings: { terminal_enabled: true },
    installCommand: state.available && state.options.token && (!state.options.selected || state.options.enabled) ? `fixture-command ${state.options.token} terminal=${Number(state.options.enabled)}` : '',
    onClose: () => { state.show = false },
    'onTerminal-options': value => { state.options = value },
    'onInstall-available': value => { state.available = value },
    'onUpdate:target-os': value => { state.targetOs = value },
    'onUpdate:install-mode': value => { state.installMode = value },
    'onUpdate:install-gh-proxy': value => { state.installGhProxy = value },
    'onUpdate:install-version': value => { state.installVersion = value },
    'onUpdate:auto-update': value => { state.autoUpdate = value }
  })]) })
  app.mount('#app')
  window.downloadFixture.unmount = () => app.unmount()
} else {
  const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/admin', component: Admin }] })
  const app = createApp({ render: () => h(RouterView) })
  app.provide('appConfig', { authorization: true, last_agent_version: 'fixture' })
  app.use(router)
  await router.isReady()
  app.mount('#app')
}
