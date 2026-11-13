import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import { Terminal as Xterm } from '@xterm/xterm'
import Terminal from '../../../src/frontend/views/admin/Terminal.vue'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'

// Observe the real renderer only at its public mounting boundary, never its private core.
const originalOpen = Xterm.prototype.open
Xterm.prototype.open = function (...args) { window.fixtureScreen = this; return originalOpen.apply(this, args) }
await setLanguage('en')
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/admin', component: { render: () => h('p', 'Admin fixture') } }, { path: '/admin/terminal/:id', component: Terminal }] })
const app = createApp({ render: () => h(RouterView) })
app.provide('appConfig', { authorization: true })
app.use(router)
await router.isReady()
app.mount('#app')
window.fixtureRouter = router
