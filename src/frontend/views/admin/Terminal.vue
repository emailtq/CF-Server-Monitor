<template>
  <main class="container terminal-page" :class="{ 'terminal-compact': parseFloat(viewportHeight) < 560 }" :style="{ '--terminal-viewport': viewportHeight }">
    <TerminalHeader :title="trans.terminalTitle" />
    <section class="main-panel terminal-panel">
      <header class="panel-header terminal-topbar">
        <div class="panel-title">{{ serverId }} <HelpTooltip :text="trans.terminalLimits" /></div>
        <nav class="terminal-actions" :aria-label="trans.terminalTitle">
          <button class="btn" @click="back">{{ trans.adminPanel }}</button>
          <button class="btn" @click="showAccess = true">{{ trans.terminalAccess }}</button>
          <button class="btn btn-primary" :disabled="active" @click="open">{{ trans.terminalReopen }}</button>
          <button class="btn btn-red" :disabled="!active" @click="terminal.close">{{ trans.terminalDisconnect }}</button>
        </nav>
      </header>
      <div class="terminal-status" role="status" aria-live="polite">
        <span :class="{ 'terminal-running': status === 'running' }">{{ trans['terminalState_' + status] }}</span>
        <span v-if="availability"> · {{ availability.connected ? trans.terminalAgentConnected : trans.terminalAgentOffline }} · {{ availability.supported ? trans.terminalSupported : trans.terminalUnsupported }}</span>
        <span v-if="sessionId"> · {{ sessionId }}</span>
      </div>
      <p class="terminal-warning">{{ trans.terminalRisk }}</p>
      <p class="terminal-compact-risk">{{ trans.terminalRootWarning }}</p>
      <p v-if="errorCode || uiError" class="danger-box terminal-error" role="alert">{{ trans[errorCode || uiError] || trans.terminalRequestFailed }} <small>{{ errorCode || uiError }}</small></p>
      <div ref="host" class="terminal-screen" :aria-label="trans.terminalTitle">
        <pre v-if="finalOutput" class="terminal-final-output">{{ finalOutput }}</pre>
      </div>
      <footer class="terminal-toolbar" :aria-label="trans.terminalKeys">
        <button class="btn" @click="terminal.copySelection">{{ trans.copy }}</button>
        <button class="btn" :disabled="status !== 'running'" @click="pasteClipboard">{{ trans.terminalPaste }}</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.sendInput('\x1b'); terminal.focus()">Esc</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.sendInput('\t'); terminal.focus()">Tab</button>
        <button class="btn" :aria-pressed="ctrl" :disabled="status !== 'running'" @click="ctrl = !ctrl">Ctrl</button>
        <button class="btn" :aria-pressed="alt" :disabled="status !== 'running'" @click="alt = !alt">Alt</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.focus">{{ trans.terminalKeyboard }}</button>
        <input class="form-input terminal-mobile-input" :aria-label="trans.terminalMobileInput" :placeholder="trans.terminalMobileInput" :disabled="status !== 'running'" autocomplete="off" autocapitalize="off" spellcheck="false" @input="mobileInput" @compositionstart="composing = true" @compositionend="compositionEnd" @keydown.enter.prevent="mobileEnter">
      </footer>
    </section>
    <TerminalAccessModal v-if="showAccess" :server="{ id: serverId }" :api-index="apiIndex" :trans="trans" @close="showAccess = false; refreshStatus()" />
  </main>
</template>

<script setup>
import { computed, inject, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TerminalHeader from '../../components/TerminalHeader.vue'
import HelpTooltip from '../../components/HelpTooltip.vue'
import TerminalAccessModal from './components/TerminalAccessModal.vue'
import { useTerminal } from '../../composables/useTerminal.js'
import { adminApi } from '../../utils/api.js'
import { isAdminLoggedIn } from '../../utils/http.js'
import { useTranslation } from '../../utils/i18n.js'

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
const showAccess = ref(false)
const viewportHeight = ref('100dvh')
const uiError = ref('')
const ctrl = ref(false)
const alt = ref(false)
const active = computed(() => ['creating', 'starting', 'running'].includes(status.value))
let composing = false
let live = true

const back = () => router.push({ path: '/admin', query: { apiIndex: String(apiIndex) } })
const refreshStatus = async () => {
  const result = await adminApi({ action: 'terminal_status', serverId }, apiIndex)
  if (!live) return
  if (result.error) uiError.value = result.error
  else { availability.value = result.data; uiError.value = '' }
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
const compositionEnd = event => { composing = false; mobileInput(event) }
const mobileEnter = event => { if (!composing && !event.isComposing) terminal.sendInput('\r') }
// Phone keyboards can shrink visualViewport without changing the layout viewport.
const updateViewport = () => { viewportHeight.value = `${window.visualViewport?.height || window.innerHeight}px` }
watch([() => route.params.id, () => route.query.apiIndex], () => { terminal.dispose(); back() })
onMounted(() => {
  if (!isAdminLoggedIn() && appConfig.authorization !== true) { back(); return }
  updateViewport()
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.addEventListener('resize', updateViewport)
  void refreshStatus()
})
onBeforeUnmount(() => {
  live = false
  terminal.dispose()
  window.visualViewport?.removeEventListener('resize', updateViewport)
  window.removeEventListener('resize', updateViewport)
})
</script>

<style scoped>
.terminal-page { height: var(--terminal-viewport, 100dvh); display: flex; flex-direction: column; padding-top: 12px; padding-bottom: 12px; }
.terminal-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; margin-bottom: 0; overflow: hidden; }
.terminal-topbar { gap: 12px; flex-wrap: wrap; }
.terminal-actions, .terminal-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.terminal-status { color: var(--text-secondary); padding: 8px 16px; overflow-wrap: anywhere; }
.terminal-running { color: var(--accent-green); }
.terminal-warning { margin: 0; padding: 4px 16px 8px; color: var(--text-secondary); font-size: 12px; }
.terminal-compact-risk { display: none; }
.terminal-error { margin: 4px 16px; padding: 8px; }
.terminal-error small { display: block; }
.terminal-screen { flex: 1; min-height: 0; padding: 8px 12px; background: var(--bg-primary); overflow: hidden; }
.terminal-final-output { height: 100%; overflow: auto; white-space: pre-wrap; font-family: var(--terminal-font); }
.terminal-toolbar { padding: 8px 12px; border-top: 1px solid var(--border-color); }
.terminal-toolbar [aria-pressed="true"] { color: var(--accent-green); border-color: var(--accent-green); }
.terminal-mobile-input { flex: 1; min-width: 180px; }
@media (max-width: 767px) {
  .terminal-page { padding: 8px; }
  .terminal-topbar { padding: 8px; }
  .terminal-actions { gap: 4px; }
  .terminal-actions .btn, .terminal-toolbar .btn { padding: 6px 8px; font-size: 12px; min-height: 36px; }
  .terminal-toolbar { gap: 4px; padding: 6px; }
  .terminal-status { padding: 4px 8px; font-size: 11px; }
  .terminal-warning { padding: 2px 8px; font-size: 11px; }
  .terminal-screen { padding: 4px; }
}
@media (max-width: 767px) {
  .terminal-compact :deep(.terminal-header) { display: none; }
  .terminal-compact .terminal-topbar .panel-title, .terminal-compact .terminal-actions .btn:nth-child(-n+2), .terminal-compact .terminal-toolbar .btn:nth-child(7), .terminal-compact .terminal-warning { display: none; }
  .terminal-compact .terminal-topbar { padding: 4px 6px; }
  .terminal-compact .terminal-status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .terminal-compact .terminal-compact-risk { display: block; font-size: 11px; color: var(--text-secondary); padding: 2px 8px; }
  .terminal-compact .terminal-mobile-input { flex-basis: 100%; }
}
</style>
