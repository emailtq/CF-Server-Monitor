import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Admin from '../../../src/frontend/views/admin/index.vue'
import Terminal from '../../../src/frontend/views/admin/Terminal.vue'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'
await initConfig()
await setLanguage(new URLSearchParams(location.search).get('locale') || 'en')
const router = createRouter({history:createWebHashHistory(), routes:[{path:'/admin', component:Admin},{path:'/admin/terminal/:id',component:Terminal}]})
const app = createApp({render:()=>h(RouterView)})
app.provide('appConfig',{authorization:true,last_agent_version:'fixture'})
app.use(router)
await router.isReady()
app.mount('#app')
