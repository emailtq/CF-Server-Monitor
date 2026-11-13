<template>
  <main class="admin-ui terminal-page" :style="{ '--terminal-viewport': viewportHeight }">
    <section class="terminal-panel">
      <header class="terminal-topbar">
        <span class="terminal-node-name" :title="node?.name || serverId">{{ node?.name || serverId }}</span>
        <button class="admin-icon-button" data-terminal-menu :aria-label="trans.terminalMenu" :aria-expanded="showMenu" aria-haspopup="dialog" @click="showMenu = true"><AdminIcon name="settings" /></button>
      </header>
      <div class="terminal-workspace">
        <div ref="host" class="terminal-screen" :aria-label="trans.terminalTitle"><pre v-if="finalOutput" class="terminal-final-output">{{ finalOutput }}</pre></div>
        <div class="terminal-feedback" :class="{ 'terminal-feedback-visible': status !== 'running' || errorCode || uiError }" role="status" aria-live="polite">
          <span class="terminal-status">{{ trans['terminalState_' + status] }}</span>
          <p v-if="errorCode || uiError" class="terminal-error" role="alert">{{ trans[errorCode || uiError] || trans.terminalRequestFailed }} <small>{{ errorCode || uiError }}</small></p>
        </div>
        <button v-if="readingHistory" class="btn terminal-bottom" data-terminal-bottom @click="terminal.scrollToBottom"><AdminIcon name="chevron-down" />{{ trans.terminalScrollBottom }}</button>
      </div>
      <footer class="terminal-toolbar" :aria-label="trans.terminalKeys">
        <div v-if="showKeys" class="terminal-key-controls">
        <button class="btn" @click="terminal.copySelection">{{ trans.copy }}</button>
        <button class="btn" :disabled="status !== 'running'" @click="pasteClipboard">{{ trans.terminalPaste }}</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.sendInput('\x1b'); terminal.focus()">Esc</button>
        <button class="btn" :disabled="status !== 'running'" @click="terminal.sendInput('\t'); terminal.focus()">Tab</button>
        <button class="btn" :aria-pressed="ctrl" :disabled="status !== 'running'" @click="ctrl = !ctrl">Ctrl</button>
        <button class="btn" :aria-pressed="alt" :disabled="status !== 'running'" @click="alt = !alt">Alt</button>
        </div>
        <div class="terminal-input-row">
          <button class="btn" data-terminal-keys :aria-label="trans.terminalKeys" :aria-expanded="showKeys" @click="showKeys = !showKeys"><AdminIcon name="terminal" /></button>
          <input ref="mobile" class="form-input terminal-mobile-input" :aria-label="trans.terminalMobileInput" :placeholder="trans.terminalMobileInput" :disabled="status !== 'running'" autocomplete="off" autocapitalize="off" spellcheck="false" @input="mobileInput" @compositionstart="compositionStart" @compositionend="compositionEnd" @keydown.enter="mobileEnter">
          <button class="btn" :disabled="status !== 'running'" @click="mobile?.focus()">{{ trans.terminalKeyboard }}</button>
        </div>
      </footer>
    </section>
    <AdminDialog :open="showMenu" :title="trans.terminalMenu" size="terminal" :viewport-height="viewportHeight" @close="showMenu = false">
      <div class="terminal-menu-panel">
        <nav class="terminal-actions" :aria-label="trans.terminalTitle">
          <button class="btn" data-terminal-back @click="showMenu = false; back()">{{ trans.adminPanel }}</button>
          <button class="btn btn-primary" :disabled="active" @click="showMenu = false; open()">{{ trans.terminalReopen }}</button>
          <button class="btn btn-red" data-terminal-disconnect :disabled="!active" @click="showMenu = false; terminal.close()">{{ trans.terminalDisconnect }}</button>
          <button class="btn" data-terminal-revoke @click="openAccess">{{ trans.terminalRevoke }}</button>
        </nav>
        <label>{{ trans.language }}<select class="form-select terminal-language" :value="currentLang" @change="setLanguage($event.target.value)"><option v-for="language in LANGUAGES" :key="language.code" :value="language.code">{{ language.nativeLabel }}</option></select></label>
        <label>{{ trans.theme }}<select class="form-select terminal-theme" :value="currentTheme" @change="setTheme($event.target.value)"><option value="auto">{{ trans.themeAuto }}</option><option value="light">{{ trans.themeLight }}</option><option value="dark">{{ trans.themeDark }}</option></select></label>
        <details class="terminal-session"><summary tabindex="0">{{ trans.terminalSessionDetails }}</summary><div>{{ trans['terminalState_' + status] }}</div><div v-if="sessionId">{{ sessionId }}</div><div>{{ node?.region || '-' }} / {{ node?.os || '-' }}</div><div v-if="availability">{{ availability.connected ? trans.terminalAgentConnected : trans.terminalAgentOffline }} / {{ availability.supported ? trans.terminalSupported : trans.terminalUnsupported }}</div></details>
        <p class="terminal-risk">{{ trans.terminalRisk }}</p><p class="terminal-risk">{{ trans.terminalLimits }}</p>
      </div>
    </AdminDialog>
    <TerminalAccessModal v-if="showAccess" :server="node || { id: serverId }" :api-index="apiIndex" :trans="trans" @close="showAccess = false; refreshStatus()" />
  </main>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AdminDialog from './components/AdminDialog.vue'
import AdminIcon from './components/AdminIcon.vue'
import TerminalAccessModal from './components/TerminalAccessModal.vue'
import { useTerminal } from '../../composables/useTerminal.js'
import { adminApi, getTerminalBase } from '../../utils/api.js'
import { useTheme } from '../../composables/useTheme.js'
import { isAdminLoggedIn } from '../../utils/http.js'
import { useTranslation, currentLang, LANGUAGES, setLanguage } from '../../utils/i18n.js'
import '../../styles/admin.css'

const route = useRoute()
const router = useRouter()
const appConfig = inject('appConfig', {})
const trans = useTranslation()
const { currentTheme, setTheme } = useTheme()
const serverId = String(route.params.id || '')
const apiIndex = route.query.apiIndex === undefined ? 0 : /^\d+$/.test(String(route.query.apiIndex)) ? Number(route.query.apiIndex) : NaN
const terminal = useTerminal({ serverId, apiIndex })
const { status, errorCode, sessionId, finalOutput, readingHistory } = terminal
const host = ref(null)
const mobile = ref(null)
const availability = ref(null)
const node = ref(null)
const showAccess = ref(false)
const showMenu = ref(false)
const showKeys = ref(false)
const viewportHeight = ref('100dvh')
const uiError = ref('')
const ctrl = ref(false)
const alt = ref(false)
const active = computed(() => ['creating', 'starting', 'running'].includes(status.value))
let composing = false
let compositionOwner = ''
let live = true
let themeObserver

const back = () => router.push({ path: '/admin', query: { apiIndex: String(apiIndex) } })
const openAccess = async () => {
  showMenu.value = false
  await nextTick() // Let the menu restore its persistent trigger before the next dialog captures focus.
  if (live) showAccess.value = true
}
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
.terminal-panel { width: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.terminal-topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px 0 12px; min-height: 44px; flex-shrink: 0; border-bottom: 1px solid var(--cf-border); }
.terminal-node-name { min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.terminal-topbar .admin-icon-button { width: 44px; height: 44px; flex-shrink: 0; }
.terminal-workspace { position: relative; flex: 1; min-height: 0; display: flex; }
.terminal-screen { --terminal-font: ui-monospace, monospace; flex: 1; min-width: 0; padding: 4px; background: var(--cf-panel); color: var(--cf-text); overflow: hidden; }
.terminal-final-output { margin: 0; height: 100%; overflow: auto; white-space: pre-wrap; font-family: var(--terminal-font); }
.terminal-feedback { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); pointer-events: none; }
.terminal-feedback-visible { top: 8px; left: 8px; right: 8px; width: auto; height: auto; max-height: calc(100% - 16px); overflow: auto; clip-path: none; padding: 8px 12px; border: 1px solid var(--cf-border); border-left: 3px solid var(--cf-muted); background: var(--cf-panel); color: var(--cf-muted); font: 13px/1.5 var(--cf-font); pointer-events: auto; }
.terminal-error { margin: 4px 0 0; color: var(--cf-red); overflow-wrap: anywhere; }
.terminal-error small { display: block; }
.terminal-bottom { position: absolute; right: 8px; bottom: 8px; gap: 4px; }
.terminal-toolbar { display: flex; flex-direction: column; gap: 4px; padding: 4px; flex-shrink: 0; min-width: 0; border-top: 1px solid var(--cf-border); }
.terminal-input-row, .terminal-key-controls { display: flex; gap: 4px; align-items: center; min-width: 0; }
.terminal-key-controls { overflow-x: auto; }
.terminal-key-controls .btn { flex-shrink: 0; }
.terminal-key-controls [aria-pressed="true"] { background: var(--cf-soft); border-color: var(--cf-muted); }
.terminal-page .btn { min-width: 44px; min-height: 44px !important; height: 44px !important; white-space: nowrap; }
.terminal-page .terminal-mobile-input { flex: 1; min-width: 0 !important; width: 100%; min-height: 44px !important; height: 44px !important; font-size: 16px; }
</style>

<style>
.admin-ui .admin-dialog-terminal { position: fixed; top: 0; right: 0; margin: 0; width: min(340px, 100vw); max-width: 100vw; max-height: 100dvh; padding: 16px; border-radius: 0; }
.admin-ui .admin-dialog-terminal .admin-dialog-head { text-align: left; min-height: 44px; display: flex; align-items: center; }
.admin-ui .admin-dialog-terminal .admin-dialog-close { min-width: 44px; min-height: 44px; }
.terminal-menu-panel { display: flex; flex-direction: column; gap: 16px; }
.terminal-menu-panel .terminal-actions { display: flex; flex-direction: column; gap: 8px; }
.terminal-menu-panel .btn, .terminal-menu-panel .form-select { min-height: 44px !important; height: auto !important; white-space: normal; }
.terminal-menu-panel label { display: flex; flex-direction: column; gap: 6px; }
.terminal-menu-panel .terminal-session { color: var(--cf-muted); font-size: 13px; overflow-wrap: anywhere; }
.terminal-menu-panel summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
.terminal-menu-panel .terminal-risk { margin: 0; font-size: 13px; line-height: 1.6; color: var(--cf-muted); }
</style>
