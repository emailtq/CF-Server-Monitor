import { createApp, h, watch } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Admin from '../../../src/frontend/views/admin/index.vue'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import { http } from '../../../src/frontend/utils/http.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'
const meta = document.createElement('meta')
meta.name = 'apiBase'
const native = new URLSearchParams(location.search).has('native')
meta.content = `${location.origin}${native ? '' : '/site-a'},${location.origin}/site-b`
document.head.append(meta)
await initConfig()
await setLanguage(new URLSearchParams(location.search).get('locale') || 'en')
const config = await (await fetch(`${native ? '' : '/site-a'}/api/config`)).json()
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/admin', component: Admin }, { path: '/', component: { render: () => h('p', { id: 'outside-admin' }, 'Outside admin') } }] })
const app = createApp({ render: () => h(RouterView) })
app.provide('appConfig', { ...config, authorization: true })
app.use(router)
await router.isReady()
app.mount('#app')
window.adminState = () => {
  let owner = document.querySelector('.admin-ui')?.__vueParentComponent
  while (owner && owner.type?.__name !== 'index') owner = owner.parent
  if (!owner?.setupState?.switchAdminSite) throw new Error('Actual mounted Admin state unavailable')
  return owner.setupState
}
window.latencyState = () => document.querySelector('.latency-page')?.__vueParentComponent?.setupState
window.phase43Http = http
window.observeLatencyAcceptance = () => {
  const state = window.latencyState()
  watch(() => state.tasks, tasks => window.latencyTrace.push({ stage: 'result-accepted', atMs: performance.now(), tasks: tasks?.length }), { flush: 'sync' })
}
