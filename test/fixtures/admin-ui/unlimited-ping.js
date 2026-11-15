import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Admin from '../../../src/frontend/views/admin/index.vue'
import Dashboard from '../../../src/frontend/views/Dashboard.vue'
import ServerDetail from '../../../src/frontend/views/ServerDetail.vue'
import Chart from 'chart.js/auto'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'
await initConfig()
await setLanguage(new URLSearchParams(location.search).get('locale') || 'en')
const config = await (await fetch('/api/config')).json()
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/admin', component: Admin }, { path: '/', component: Dashboard }, { path: '/server/:id', component: ServerDetail }] })
const app = createApp({ render: () => h(RouterView) })
app.provide('appConfig', { ...config, authorization: true })
app.use(router)
await router.isReady()
app.mount('#app')
window.pingCharts = () => [...document.querySelectorAll('canvas')].map(canvas => Chart.getChart(canvas)).filter(Boolean).map(chart => ({ datasets: chart.data.datasets.map(dataset => ({ label: dataset.label, field: dataset.probeField, hidden: dataset.hidden === true, data: dataset.data })) }))
