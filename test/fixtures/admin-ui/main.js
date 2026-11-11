import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Fixture from './Fixture.vue'
import Admin from '../../../src/frontend/views/admin/index.vue'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'
const query = new URLSearchParams(location.search)
if (query.has('sites')) {
  const meta = document.createElement('meta')
  meta.name = 'apiBase'
  meta.content = `${location.origin}/site-a,${location.origin}/site-b`
  document.head.append(meta)
}
await initConfig()
await setLanguage(query.get('locale') || 'en')
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/admin', component: Admin }, { path: '/:pathMatch(.*)*', component: Fixture }] })
const app = createApp(query.get('mode') === 'admin' || query.get('mode') === 'login' ? { render: () => h(RouterView) } : Fixture)
app.provide('appConfig', { authorization: query.get('mode') !== 'login', last_agent_version: '2.8.6' })
app.use(router)
await router.isReady()
app.mount('#app')
