<template>
  <div id="tab-settings" class="tab-content" :class="{ active: settingsPages.includes(activeTab) }">
    <p class="settings-save-hint">{{ trans.adminWholeConfigHint }}</p>
    <div v-if="activeTab === 'settings' && isMultipleMode" class="settings-section"><label class="form-label" for="admin-site">{{ trans.apiEndpoint }}</label><select id="admin-site" class="form-select" :value="selectedApiIndex" :disabled="siteLoading" @change="$emit('api-index-change', Number($event.target.value))"><option v-for="(base, index) in apiBases" :key="index" :value="index">{{ base }}</option></select></div>
    <fieldset class="settings-fieldset" :disabled="saving">
    <AppearanceSettings v-show="activeTab === 'themeStore'" v-bind="panelProps" @validate-csp="validateCspField" @upload-bg="$emit('upload-bg', $event)" @upload-bg-mobile="$emit('upload-bg-mobile', $event)" @upload-favicon="$emit('upload-favicon', $event)" />
    <CollectionSettings v-show="activeTab === 'collection'" v-bind="panelProps" />
    <SecuritySettings v-show="activeTab === 'security'" v-bind="panelProps" @toggle-password="$emit('toggle-password', $event)" @toggle-admin-password-change="$emit('toggle-admin-password-change')" />
    <SiteSettings v-show="activeTab === 'settings'" v-bind="panelProps" @toggle-password="$emit('toggle-password', $event)" @query-d1-usage="$emit('query-d1-usage')" />
    </fieldset>
    <div class="settings-save-bar"><button @click="$emit('save-settings')" class="btn btn-primary" :disabled="saving">{{ saving ? trans.saving : trans.saveConfig }}</button></div>
  </div>
</template>
<script setup>
import { computed, reactive } from 'vue'
import { PING_NODE_FIELDS, validatePingNode } from '../../../utils/pingNode.js'
import AppearanceSettings from './AppearanceSettings.vue'
import CollectionSettings from './CollectionSettings.vue'
import SecuritySettings from './SecuritySettings.vue'
import SiteSettings from './SiteSettings.vue'
const props = defineProps({
  trans: { type: Object, required: true },
  settings: { type: Object, required: true },
  servers: { type: Array, default: () => [] },
  passwordVisible: { type: Object, required: true },
  activeTab: { type: String, default: 'settings' },
  selectedApiBase: { type: String, default: '' },
  currentOrigin: { type: String, default: '' },
  saving: { type: Boolean, default: false },
  changeAdminPassword: { type: Boolean, default: false },
  d1UsageLoading: { type: Boolean, default: false }
  ,apiBases: Array, isMultipleMode: Boolean, selectedApiIndex: Number, siteLoading: Boolean
})

const emit = defineEmits([
  'toggle-password', 'toggle-admin-password-change',
  'save-settings', 'upload-bg', 'upload-bg-mobile', 'upload-favicon',
  'query-d1-usage',
  'alert-message', 'api-index-change'
])

const isLocalHostname = (value) => {
  try {
    const raw = String(value || '').trim()
    if (!raw) return false
    const hostname = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase()
    return hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]'
  } catch (_) {
    return false
  }
}

// 站点级设置只允许在当前 API 对应的站点编辑；本地开发时也放行，便于连远端 API 调试。
const canEditSiteSettings = computed(() =>
  props.currentOrigin === props.selectedApiBase ||
  isLocalHostname(props.currentOrigin) ||
  isLocalHostname(props.selectedApiBase)
)

const settingsPages = ['collection', 'themeStore', 'security', 'settings']
const cspErrors = reactive({ csp_static: '', csp_api: '' })
const panelProps = computed(() => ({ ...props, canEditSiteSettings: canEditSiteSettings.value, cspErrors, pingNodeErrors: pingNodeErrors.value, userAgentInvalid: userAgentInvalid.value }))
const pingNodeErrorMessage = computed(() => (
  props.trans.invalidPingNodeFormat || 'Use domain, IPv4, or host:port. Port must be 1-65535.'
))

const pingNodeErrors = computed(() => Object.fromEntries(
  PING_NODE_FIELDS.map(field => [
    field,
    validatePingNode(props.settings[field]).valid ? '' : pingNodeErrorMessage.value
  ])
))

const hasPingNodeErrors = computed(() => Object.values(pingNodeErrors.value).some(Boolean))

// 与服务端 settings.js / agent config.go 保持一致：只允许在请求头、config.conf、
// 安装命令引号下都安全的字符；留空由服务端回退默认 cfsm。
const USER_AGENT_ALLOWED_RE = /^[A-Za-z0-9 _.\-/,:;()+=@#*?~]*$/
const userAgentInvalid = computed(() => {
  const value = String(props.settings.ua ?? '').trim()
  return value.length > 100 || !USER_AGENT_ALLOWED_RE.test(value)
})

const validatePingNodes = () => !hasPingNodeErrors.value

const isValidCspOrigin = (value) => {
  const raw = String(value || '').trim()
  if (!raw || /[\s;"']/.test(raw)) return false
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    if (url.username || url.password || url.search || url.hash) return false
    if (url.pathname && url.pathname !== '/') return false
    return true
  } catch (_) {
    return false
  }
}

const validateCspField = (field) => {
  const value = props.settings[field] || ''
  if (!value) {
    cspErrors[field] = ''
    return true
  }
  const domains = value.split(',').map(s => s.trim()).filter(Boolean)
  for (const domain of domains) {
    if (!isValidCspOrigin(domain)) {
      cspErrors[field] = props.trans.cspInvalidDomain || 'Each domain must start with https://'
      return false
    }
  }
  cspErrors[field] = ''
  return true
}

defineExpose({ validateCspField, cspErrors, validatePingNodes, pingNodeErrors, userAgentInvalid })
</script>
