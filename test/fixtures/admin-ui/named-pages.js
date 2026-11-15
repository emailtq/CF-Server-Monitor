import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Admin from '../../../src/frontend/views/admin/index.vue'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import { fetchConfig, VERSION, LAST_WORKERS_VERSION, LAST_AGENT_VERSION } from '../../../src/frontend/utils/api.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'
const meta = document.createElement('meta')
meta.name = 'apiBase'
meta.content = `${location.origin}/site-a,${location.origin}/site-b`
document.head.append(meta)
await initConfig()
await setLanguage(new URLSearchParams(location.search).get('locale') || 'en')
const config = await fetchConfig(0)
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/admin', component: Admin }] })
const app = createApp({ render: () => h(RouterView) })
app.provide('appConfig', { ...config, authorization: true })
app.use(router)
await router.isReady()
app.mount('#app')
window.adminState = () => {
  let owner = document.querySelector('.admin-ui')?.__vueParentComponent
  while (owner && owner.type?.__name !== 'index') owner = owner.parent
  if (!owner?.setupState?.switchAdminSite) throw new Error('Actual mounted Admin unavailable')
  return owner.setupState
}
window.namedConfig = fetchConfig
window.namedVersions = () => ({ worker: VERSION.value, latestWorker: LAST_WORKERS_VERSION.value, agent: LAST_AGENT_VERSION.value })
