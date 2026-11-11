<template>
  <main class="admin-ui terminal-page" :class="{ 'terminal-compact': compact }" :style="{ '--terminal-viewport': viewportHeight }">
    <AdminHeader :trans="trans" :show-logout="false" />
    <section class="terminal-panel">
      <header class="terminal-topbar">
        <div class="terminal-node">
          <div class="terminal-node-identity"><img v-if="node?.region" :src="getPublicAssetUrl('flags/' + getFlagRegionCode(node.region) + '.svg')" :alt="node.region" class="flag-img"><OsIcon v-if="node?.os" :os="node.os" /><span class="terminal-node-name" :title="node?.name || serverId">{{ node?.name || serverId }}</span><HelpTooltip :text="trans.terminalLimits" /></div>
          <div class="terminal-node-secondary"><small class="terminal-node-meta" :title="[node?.region, node?.os].filter(Boolean).join(' · ')">{{ node?.region || '-' }} · {{ node?.os || '-' }}</small><select class="form-select terminal-language" :value="currentLang" :aria-label="trans.language" @change="setLanguage($event.target.value)"><option v-for="language in LANGUAGES" :key="language.code" :value="language.code">{{ language.nativeLabel }}</option></select></div>
        </div>
        <nav class="terminal-actions" :aria-label="trans.terminalTitle">
          <div class="terminal-session-actions">
          <button class="btn" data-terminal-back @click="back">{{ trans.adminPanel }}</button>
          <button class="btn" @click="showAccess = true">{{ trans.terminalRevoke }}</button>
          <button class="btn btn-primary" :disabled="active" @click="open">{{ trans.terminalReopen }}</button>
          </div>
          <button class="btn btn-red" data-terminal-disconnect :disabled="!active" @click="terminal.close">{{ trans.terminalDisconnect }}</button>
        </nav>
      </header>
      <div class="terminal-status" role="status" aria-live="polite">
        <span :class="{ 'terminal-running': status === 'running' }">{{ trans['terminalState_' + status] }}</span>
        <span v-if="availability"> · {{ availability.connected ? trans.terminalAgentConnected : trans.terminalAgentOffline }} · {{ availability.supported ? trans.terminalSupported : trans.terminalUnsupported }}</span>
      </div>
      <details v-if="sessionId" class="terminal-session"><summary>{{ trans.terminalSessionDetails }}</summary><div>{{ sessionId }}</div></details>
      <p class="terminal-risk" :title="trans.terminalRisk">{{ compact ? trans.terminalRootWarning : trans.terminalRisk }}</p>
      <p v-if="errorCode || uiError" class="danger-box terminal-error" role="alert">{{ trans[errorCode || uiError] || trans.terminalRequestFailed }} <small>{{ errorCode || uiError }}</small></p>
      <div ref="host" class="terminal-screen" :aria-label="trans.terminalTitle">
        <pre v-if="finalOutput" class="terminal-final-output">{{ finalOutput }}</pre>
      </div>
      <footer class="terminal-toolbar" :aria-label="trans.terminalKeys">
        <div class="terminal-key-controls">
        <button class="btn" @click="terminal.copySelection">{{ trans.copy }}</button>
        <button class="btn" :disabled="status !== 'running'" @click="pasteClipboard">{{ trans.terminalPaste }}</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.sendInput('\x1b'); terminal.focus()">Esc</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.sendInput('\t'); terminal.focus()">Tab</button>
        <button class="btn" :aria-pressed="ctrl" :disabled="status !== 'running'" @click="ctrl = !ctrl">Ctrl</button>
        <button class="btn" :aria-pressed="alt" :disabled="status !== 'running'" @click="alt = !alt">Alt</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.focus">{{ trans.terminalKeyboard }}</button>
        </div>
        <input class="form-input terminal-mobile-input" :aria-label="trans.terminalMobileInput" :placeholder="trans.terminalMobileInput" :disabled="status !== 'running'" autocomplete="off" autocapitalize="off" spellcheck="false" @input="mobileInput" @compositionstart="compositionStart" @compositionend="compositionEnd" @keydown.enter="mobileEnter">
      </footer>
    </section>
    <TerminalAccessModal v-if="showAccess" :server="node || { id: serverId }" :api-index="apiIndex" :trans="trans" @close="showAccess = false; refreshStatus()" />
  </main>
</template>

<script setup>
import { computed, inject, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AdminHeader from './components/AdminHeader.vue'
import OsIcon from '../../components/OsIcon.vue'
import HelpTooltip from '../../components/HelpTooltip.vue'
import TerminalAccessModal from './components/TerminalAccessModal.vue'
import { useTerminal } from '../../composables/useTerminal.js'
import { adminApi, getTerminalBase, getFlagRegionCode } from '../../utils/api.js'
import { getPublicAssetUrl } from '../../utils/config.js'
import { isAdminLoggedIn } from '../../utils/http.js'
import { useTranslation, currentLang, LANGUAGES, setLanguage } from '../../utils/i18n.js'
import '../../styles/admin.css'

const route = useRoute()
const router = useRouter()
const appConfig = inject('appConfig', {})
const trans = useTranslation()
const serverId = String(route.params.id || '')
const apiIndex = route.query.apiIndex === undefined ? 0 : /^\d+$/.test(String(route.query.apiIndex)) ? Number(route.query.apiIndex) : NaN
const terminal = useTerminal({ serverId, apiIndex })
const { status, errorCode, sessionId, finalOutput } = terminal
const host = ref(null)
const availability = ref(null)
const node = ref(null)
const showAccess = ref(false)
const viewportHeight = ref('100dvh')
const uiError = ref('')
const ctrl = ref(false)
const alt = ref(false)
const active = computed(() => ['creating', 'starting', 'running'].includes(status.value))
const compact = computed(() => parseFloat(viewportHeight.value) < 560)
let composing = false
let compositionOwner = ''
let live = true
let themeObserver

const back = () => router.push({ path: '/admin', query: { apiIndex: String(apiIndex) } })
const refreshStatus = async () => {
  const result = await adminApi({ action: 'terminal_status', serverId }, apiIndex)
  if (!live) return
  if (result.error) uiError.value = result.error
  else { availability.value = result.data; uiError.value = '' }
}
const loadMetadata = async () => {
  try {
    getTerminalBase(apiIndex)
    const result = await adminApi({ action: 'list' }, apiIndex)
    if (live && !result.error) node.value = result.data?.servers?.find(server => String(server.id) === serverId) || null
  } catch (_) {} // Metadata failure must not block authoritative open or disconnect.
}
const open = async () => { uiError.value = ''; ctrl.value = alt.value = false; await terminal.open(host.value); await refreshStatus() }
const pasteClipboard = async () => {
  const owner = terminal.sessionId.value
  if (!owner || terminal.status.value !== 'running') return
  const isCurrent = () => terminal.sessionId.value === owner && terminal.status.value === 'running'
  try {
    const text = await navigator.clipboard.readText()
    if (isCurrent() && terminal.paste(text)) terminal.focus()
  } catch (_) {
    if (isCurrent()) uiError.value = 'terminal_clipboard_denied'
  }
}
const mobileInput = event => {
  if (composing || event.isComposing) return
  let text = event.target.value
  if (!text) return
  if (ctrl.value) {
    if (!/^[a-z@\[\\\]\^_]$/i.test(text)) { uiError.value = 'terminal_ctrl_letter'; return }
    text = String.fromCharCode(text.toUpperCase().charCodeAt(0) & 31)
  }
  if (alt.value) text = '\x1b' + text
  if (terminal.sendInput(text)) { event.target.value = ''; ctrl.value = alt.value = false }
}
const compositionStart = () => { composing = true; compositionOwner = sessionId.value }
const compositionEnd = event => {
  composing = false
  if (!compositionOwner || compositionOwner !== sessionId.value || status.value !== 'running') { event.target.value = ''; return }
  mobileInput(event)
  compositionOwner = ''
}
const mobileEnter = event => {
  if (composing || event.isComposing) return
  event.preventDefault()
  terminal.sendInput('\r')
}
// Phone keyboards can shrink visualViewport without changing the layout viewport.
const updateViewport = () => { viewportHeight.value = `${window.visualViewport?.height || window.innerHeight}px` }
watch([() => route.params.id, () => route.query.apiIndex], () => { terminal.dispose(); back() })
watch(sessionId, () => { ctrl.value = alt.value = false })
onMounted(() => {
  if (!isAdminLoggedIn() && appConfig.authorization !== true) { back(); return }
  updateViewport()
  document.body.classList.add('admin-ui-surface')
  themeObserver = new MutationObserver(() => terminal.refreshTheme())
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.addEventListener('resize', updateViewport)
  void loadMetadata()
  void open()
})
onBeforeUnmount(() => {
  live = false
  terminal.dispose()
  themeObserver?.disconnect()
  document.body.classList.remove('admin-ui-surface')
  window.visualViewport?.removeEventListener('resize', updateViewport)
  window.removeEventListener('resize', updateViewport)
})
</script>

<style scoped>
.terminal-page { height: var(--terminal-viewport, 100dvh); display: flex; flex-direction: column; overflow: hidden; }
.terminal-panel { width: 100%; max-width: 1280px; margin: 0 auto; padding: 16px; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.terminal-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; flex-shrink: 0; }
.terminal-node { min-width: 0; max-width: 100%; flex: 1; }
.terminal-node-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
.terminal-node-name { min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.terminal-node-identity :deep(.help-tooltip) { flex-shrink: 0; }
.terminal-node-meta { min-width: 0; display: block; color: var(--cf-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.terminal-node-secondary { display: flex; align-items: center; gap: 8px; }
.terminal-page.terminal-page.terminal-page .terminal-language { flex-shrink: 0; width: 120px; max-width: 120px; height: 32px; min-height: 32px; padding: 4px; font-size: 12px; }
.flag-img { width: 18px; height: 12px; flex-shrink: 0; }
.terminal-node-identity :deep(.os-icon-img) { width: 16px; height: 16px; }
.terminal-actions, .terminal-session-actions, .terminal-key-controls { display: flex; gap: 8px; align-items: center; }
.terminal-actions { max-width: 100%; min-width: 0; }
.terminal-session-actions { min-width: 0; overflow-x: auto; }
.terminal-actions .btn, .terminal-key-controls .btn { flex-shrink: 0; white-space: nowrap; font-size: 12px; }
.terminal-status { color: var(--cf-muted); padding: 8px 0 4px; font-size: 12px; flex-shrink: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.terminal-running { color: var(--cf-text); }
.terminal-session { position: relative; flex-shrink: 0; font-size: 12px; color: var(--cf-muted); }
.terminal-session summary { cursor: pointer; width: fit-content; }
.terminal-session div { position: absolute; z-index: 2; top: 100%; padding: 8px; max-width: 100%; border: 1px solid var(--cf-border); border-radius: 6px; background: var(--cf-panel); overflow-wrap: anywhere; }
.terminal-risk { margin: 0; padding: 4px 0 8px; color: var(--cf-muted); font-size: 12px; flex-shrink: 0; }
.terminal-error { margin: 0 0 8px; padding: 8px; font-size: 12px; flex-shrink: 0; max-height: 80px; overflow: auto; }
.terminal-error small { display: block; }
.terminal-screen { --terminal-font: ui-monospace, monospace; flex: 1; min-height: 0; padding: 8px; border: 1px solid var(--cf-border); border-radius: 8px; background: var(--cf-panel); color: var(--cf-text); overflow: hidden; }
.terminal-final-output { margin: 0; height: 100%; overflow: auto; white-space: pre-wrap; font-family: var(--terminal-font); }
.terminal-toolbar { display: flex; align-items: center; gap: 8px; padding-top: 8px; flex-shrink: 0; min-width: 0; }
.terminal-key-controls { min-width: 0; overflow-x: auto; }
.terminal-key-controls [aria-pressed="true"] { background: var(--cf-soft); border-color: var(--cf-muted); }
.terminal-mobile-input { flex: 1; width: 100%; min-width: 100px !important; }
.terminal-compact :deep(.admin-header) { display: none; }
.terminal-compact .terminal-panel { padding: 8px; }
.terminal-compact .terminal-node, .terminal-compact .terminal-session { display: none; }
.terminal-compact .terminal-status { padding: 2px 0; font-size: 11px; }
.terminal-compact .terminal-risk { padding: 2px 0 4px; font-size: 11px; }
.terminal-compact .terminal-error { max-height: 24px; margin-bottom: 4px; padding: 2px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.terminal-compact .terminal-error small { display: inline; }
.terminal-compact .terminal-actions { flex: 1; }
@media (max-width: 767px) {
  .terminal-topbar { flex-direction: column; align-items: stretch; gap: 8px; }
  .terminal-toolbar { flex-direction: column; align-items: stretch; }
  .terminal-key-controls { flex-shrink: 0; }
  .terminal-panel { padding: 12px 16px; }
}
@media (pointer: coarse) {
  .terminal-page.terminal-page.terminal-page .terminal-language { height: 44px; min-height: 44px; }
  .terminal-page :deep(.help-tooltip-trigger) { width: 44px; min-width: 44px; height: 44px; min-height: 44px; }
  .terminal-page .btn, .terminal-page .terminal-mobile-input { min-height: 44px !important; height: 44px !important; }
  .terminal-page :deep(.admin-icon-button) { width: 44px; height: 44px; }
  .terminal-session summary { min-height: 44px; display: flex; align-items: center; }
}
</style>
