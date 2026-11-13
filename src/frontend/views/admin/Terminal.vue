<template>
  <main class="admin-ui terminal-page" :style="{ '--terminal-viewport': viewportHeight }">
    <section class="terminal-panel">
      <header class="terminal-topbar">
        <span class="terminal-node-name" :title="node?.name || serverId">{{ node?.name || serverId }}</span>
        <button class="admin-icon-button" data-terminal-menu :aria-label="trans.terminalMenu" :aria-expanded="showMenu" aria-haspopup="dialog" @click="showMenu = true"><AdminIcon name="settings" /></button>
      </header>
      <div class="terminal-workspace">
        <div ref="host" class="terminal-screen" :aria-label="trans.terminalTitle"><pre v-if="finalOutput" class="terminal-final-output">{{ finalOutput }}</pre></div>
        <button v-if="readingHistory" class="btn terminal-bottom" data-terminal-bottom @click="terminal.scrollToBottom"><AdminIcon name="chevron-down" />{{ trans.terminalScrollBottom }}</button>
      </div>
      <footer class="terminal-toolbar" :class="{ 'terminal-readonly': connected && !active }" :aria-label="trans.terminalKeys">
        <div v-if="notice && notice !== dismissedNotice" class="terminal-notice" role="status" aria-live="polite">
          <div><span :class="{ 'terminal-error': noticeCode }">{{ noticeText }}</span><details v-if="noticeCode"><summary>{{ trans.terminalErrorDetails }}</summary><p>{{ noticeText }}</p><code>{{ noticeCode }}</code></details></div>
          <button class="admin-icon-button" data-terminal-notice-close :aria-label="trans.close" @click="dismissedNotice = notice"><AdminIcon name="x" /></button>
        </div>
        <div v-if="pasteOwner" class="terminal-paste-draft">
          <label for="terminal-paste-draft">{{ trans.terminalPasteDraft }}</label>
          <textarea id="terminal-paste-draft" ref="pasteInput" v-model="pasteDraft" data-terminal-paste-draft class="form-input" :aria-label="trans.terminalPasteDraft" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div><button class="btn btn-primary" data-terminal-paste-send :disabled="!pasteDraft || status !== 'running'" @click="sendPasteDraft">{{ trans.terminalPasteSend }}</button><button class="btn" data-terminal-paste-cancel @click="cancelPasteDraft">{{ trans.cancel }}</button></div>
        </div>
        <div v-if="showKeys" class="terminal-key-controls">
        <button class="btn" @click="copySelection">{{ trans.copy }}</button>
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
    <AdminDialog :open="showMenu" :title="trans.terminalMenu" size="terminal" :viewport-height="viewportHeight" @close="showMenu = false" @after-leave="menuReleased">
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
const connected = ref(false)
const mobile = ref(null)
const availability = ref(null)
const node = ref(null)
const showAccess = ref(false)
const showMenu = ref(false)
const showKeys = ref(false)
const viewportHeight = ref('100dvh')
const uiError = ref('')
const dismissedNotice = ref('')
const pasteInput = ref(null)
const pasteOwner = ref('')
const pasteDraft = ref('')
const noticeCode = computed(() => connected.value ? uiError.value || errorCode.value : '')
const notice = computed(() => noticeCode.value || (connected.value && ['disconnected', 'exited'].includes(status.value) ? status.value : ''))
const noticeText = computed(() => noticeCode.value ? trans.value[noticeCode.value] || trans.value.terminalRequestFailed : trans.value['terminalState_' + status.value])
const ctrl = ref(false)
const alt = ref(false)
const active = computed(() => ['creating', 'starting', 'running'].includes(status.value))
let composing = false
let compositionOwner = ''
let live = true
let themeObserver
let pendingAccess = false
let connection = null
const updateConnection = () => {
  if (connected.value || !host.value) return
  if (!connection) {
    connection = document.createElement('pre')
    connection.className = 'terminal-connection'
    connection.setAttribute('role', 'status')
    connection.setAttribute('aria-live', 'polite')
    host.value.prepend(connection)
  }
  connection.textContent = trans.value['terminalState_' + status.value]
  if (errorCode.value) {
    const message = document.createElement('span')
    message.className = 'terminal-error'
    message.textContent = '\n' + (trans.value[errorCode.value] || trans.value.terminalRequestFailed)
    connection.append(message)
  }
}

const back = () => router.push({ path: '/admin', query: { apiIndex: String(apiIndex) } })
const openAccess = () => {
  pendingAccess = true
  showMenu.value = false
}
const menuReleased = () => { if (live && pendingAccess) { pendingAccess = false; showAccess.value = true } }
const refreshStatus = async () => {
  const owner = sessionId.value
  const result = await adminApi({ action: 'terminal_status', serverId }, apiIndex)
  if (!live || owner !== sessionId.value) return
  if (result.error) { if (connected.value) uiError.value = result.error }
  else { availability.value = result.data; uiError.value = '' }
}
const loadMetadata = async () => {
  try {
    getTerminalBase(apiIndex)
    const result = await adminApi({ action: 'list' }, apiIndex)
    if (live && !result.error) node.value = result.data?.servers?.find(server => String(server.id) === serverId) || null
  } catch (_) {} // Metadata failure must not block authoritative open or disconnect.
}
const clearUiError = () => { uiError.value = ''; dismissedNotice.value = ''; if (status.value === 'running') errorCode.value = '' }
const clearPasteDraft = () => { pasteOwner.value = pasteDraft.value = '' }
const cancelPasteDraft = () => { clearPasteDraft(); clearUiError(); terminal.focus() }
const sendPasteDraft = () => {
  if (!pasteOwner.value || pasteOwner.value !== sessionId.value || status.value !== 'running') { clearPasteDraft(); return }
  clearUiError()
  if (terminal.paste(pasteDraft.value)) { clearPasteDraft(); terminal.focus() }
}
const copySelection = async () => {
  const owner = sessionId.value
  try { if (await terminal.copySelection()) { if (live && owner === sessionId.value) clearUiError() } }
  catch (_) { if (live && owner === sessionId.value) uiError.value = 'terminal_clipboard_denied' }
}
const open = async () => { clearPasteDraft(); clearUiError(); connected.value = false; ctrl.value = alt.value = false; await nextTick(); await terminal.open(host.value); await refreshStatus() }
const pasteClipboard = async () => {
  const owner = terminal.sessionId.value
  if (!owner || terminal.status.value !== 'running') return
  const isCurrent = () => terminal.sessionId.value === owner && terminal.status.value === 'running'
  try {
    const text = await navigator.clipboard.readText()
    if (isCurrent()) { clearUiError(); if (terminal.paste(text)) { clearPasteDraft(); terminal.focus() } }
  } catch (_) {
    if (isCurrent()) {
      uiError.value = 'terminal_clipboard_denied'
      dismissedNotice.value = ''
      pasteOwner.value = owner
      pasteDraft.value = ''
      await nextTick()
      if (isCurrent() && pasteOwner.value === owner) pasteInput.value?.focus()
    }
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
  if (terminal.sendInput(text)) { event.target.value = ''; ctrl.value = alt.value = false; clearUiError() }
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
watch(showMenu, open => { if (open) pendingAccess = false }, { flush: 'sync' })
watch(sessionId, () => { ctrl.value = alt.value = false; clearPasteDraft() }, { flush: 'sync' })
watch([status, errorCode, trans], ([state]) => {
  if (state === 'running') {
    // This leaf is locally owned like xterm, not Vue-patched or part of remote scrollback/ACK.
    connection?.remove()
    connection = null
    connected.value = true
  } else { clearPasteDraft(); updateConnection() }
  dismissedNotice.value = ''
}, { flush: 'sync' })
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
.terminal-topbar .admin-icon-button { width: 44px; height: 44px; flex-shrink: 0; background: transparent; }
.terminal-topbar .admin-icon-button:hover, .terminal-topbar .admin-icon-button:active { background: transparent; }
.terminal-workspace { position: relative; flex: 1; min-height: 0; display: flex; }
.terminal-screen { --terminal-font: ui-monospace, monospace; flex: 1; min-width: 0; padding: 4px; background: var(--cf-panel); color: var(--cf-text); overflow: hidden; }
.terminal-final-output { margin: 0; height: 100%; overflow: auto; white-space: pre-wrap; font-family: var(--terminal-font); }
.terminal-screen :deep(.terminal-connection) { margin: 0; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.5 var(--terminal-font); color: var(--cf-muted); }
.terminal-screen :deep(.terminal-error) { color: var(--cf-red); }
.terminal-error { color: var(--cf-red); }
.terminal-notice { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-height: 44px; flex-shrink: 0; font-size: 12px; line-height: 1.4; color: var(--cf-muted); }
.terminal-notice > div { min-width: 0; overflow-wrap: anywhere; }
.terminal-notice > div > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.terminal-notice .admin-icon-button { width: 44px; height: 44px; }
.terminal-notice details { margin-top: 2px; }
.terminal-notice details p { margin: 4px 0; }
.terminal-paste-draft { display: flex; flex-direction: column; flex-shrink: 0; gap: 4px; min-height: 0; font-size: 13px; }
.terminal-paste-draft textarea { width: 100%; min-height: 44px; height: 72px; max-height: 20dvh; resize: none; font: 14px/1.4 var(--terminal-font, monospace); }
.terminal-paste-draft > div { display: flex; gap: 4px; }
.terminal-toolbar { max-height: 65%; overflow-y: auto; }
.terminal-bottom { position: absolute; right: 8px; bottom: 8px; gap: 4px; }
.terminal-toolbar { display: flex; flex-direction: column; gap: 4px; padding: 4px; flex-shrink: 0; min-width: 0; border-top: 1px solid var(--cf-border); }
.terminal-input-row, .terminal-key-controls { display: flex; flex-shrink: 0; gap: 4px; align-items: center; min-width: 0; }
.terminal-readonly { display: grid; grid-template-columns: 44px minmax(0, 1fr); }
.terminal-readonly .terminal-input-row { display: contents; }
.terminal-readonly .terminal-mobile-input, .terminal-readonly .terminal-input-row > .btn:last-child { display: none; }
.terminal-readonly [data-terminal-keys] { grid-column: 1; grid-row: 1; }
.terminal-readonly .terminal-notice { grid-column: 2; grid-row: 1; }
.terminal-readonly .terminal-key-controls { grid-column: 1 / -1; grid-row: 2; }
.terminal-key-controls { overflow-x: auto; }
.terminal-key-controls .btn { flex-shrink: 0; }
.terminal-key-controls [aria-pressed="true"] { background: var(--cf-soft); border-color: var(--cf-muted); }
.terminal-page .btn { min-width: 44px; min-height: 44px !important; height: 44px !important; white-space: nowrap; }
.terminal-page .terminal-mobile-input { flex: 1; min-width: 0 !important; width: 100%; min-height: 44px !important; height: 44px !important; font-size: 16px; }
</style>

<style>
.terminal-menu-enter-active, .terminal-menu-leave-active { transition: background-color 180ms ease-out; }
.terminal-menu-enter-active .admin-dialog-terminal, .terminal-menu-leave-active .admin-dialog-terminal { transition: transform 180ms ease-out; }
.terminal-menu-enter-from, .terminal-menu-leave-to { background-color: transparent !important; }
.terminal-menu-enter-from .admin-dialog-terminal, .terminal-menu-leave-to .admin-dialog-terminal { transform: translateX(100%); }
@media (prefers-reduced-motion: reduce) { .terminal-menu-enter-active, .terminal-menu-leave-active, .terminal-menu-enter-active .admin-dialog-terminal, .terminal-menu-leave-active .admin-dialog-terminal { transition: none; } }
.terminal-page .terminal-screen .xterm .scrollbar.vertical .slider { box-sizing: border-box; border-left: 4px solid transparent; border-right: 4px solid transparent; background-clip: padding-box; touch-action: none; }
.terminal-page ::-webkit-scrollbar { width: 8px; height: 8px; }
.terminal-page ::-webkit-scrollbar-thumb { border: 1px solid var(--cf-panel); background: color-mix(in srgb, var(--cf-muted) 60%, var(--cf-panel)); background-clip: padding-box; }
.terminal-page ::-webkit-scrollbar-thumb:hover { background-color: var(--cf-muted); }
@supports not selector(::-webkit-scrollbar) { .terminal-page * { scrollbar-width: thin; scrollbar-color: var(--cf-muted) var(--cf-panel); } }
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
