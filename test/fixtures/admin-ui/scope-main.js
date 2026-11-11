import { createApp } from 'vue'
import ScopeFixture from './ScopeFixture.vue'
import { initConfig } from '../../../src/frontend/utils/config.js'
import { setLanguage } from '../../../src/frontend/utils/i18n.js'
import '../../../src/frontend/styles/main.css'
import '../../../src/frontend/styles/light.css'
await initConfig()
await setLanguage('en')
document.body.classList.add('admin-ui-surface', 'light')
createApp(ScopeFixture).mount('#app')
