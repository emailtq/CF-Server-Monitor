<template>
  <div class="modal-overlay active" @keydown.esc="finish" @keydown.tab="trapFocus">
    <section ref="dialog" class="modal-dialog terminal-access" role="dialog" aria-modal="true" aria-labelledby="terminal-access-title" aria-describedby="terminal-risk">
      <div class="modal-header">
        <h2 id="terminal-access-title" class="modal-title">{{ trans.terminalAccess }} · {{ server.name || server.id }}</h2>
        <button class="modal-close" :aria-label="trans.close" @click="finish">×</button>
      </div>
      <p id="terminal-risk" class="danger-box">{{ trans.terminalRisk }}</p>
      <p class="text-secondary">{{ trans.terminalLocalConsent }}</p>
      <p class="text-secondary">{{ trans.terminalRotationWarning }}</p>
      <p v-if="availability" class="text-secondary">{{ availability.connected ? trans.terminalAgentConnected : trans.terminalAgentOffline }} · {{ availability.supported ? trans.terminalSupported : trans.terminalUnsupported }}</p>
      <p v-if="error" role="alert" class="danger-box">{{ trans[error] || trans.terminalRequestFailed }}</p>

      <template v-if="!token">
        <label class="terminal-consent"><input v-model="consent" type="checkbox"> {{ trans.terminalAcceptRisk }}</label>
        <form @submit.prevent="authorize">
          <label for="terminal-secret" class="form-label">{{ trans.terminalAdminSecret }} <HelpTooltip :text="trans.terminalStepUpHelp" /></label>
          <div class="terminal-secret-row">
            <input id="terminal-secret" ref="secretInput" v-model="secret" :type="getInputType('secret')" class="form-input" autocomplete="current-password" :disabled="busy">
            <button type="button" class="btn" :aria-label="trans.terminalShowSecret" :aria-pressed="visibility.secret" @click="toggle('secret')">{{ trans.terminalShowSecret }}</button>
          </div>
          <div class="terminal-access-actions">
            <button type="button" class="btn" :disabled="busy || !consent || !secret" @click="enableSite">{{ trans.terminalEnableSite }}</button>
            <button type="submit" class="btn btn-primary" :disabled="busy || !consent || !secret">{{ trans.terminalAuthorize }}</button>
            <button type="button" class="btn btn-red" :disabled="busy || !consent" @click="revoke">{{ trans.terminalRevoke }}</button>
          </div>
        </form>
        <p v-if="notice" role="status">{{ notice }}</p>
      </template>
      <template v-else>
        <p class="alert alert-info">{{ trans.terminalTokenOnce }}</p>
        <label for="terminal-node-token" class="form-label">{{ trans.terminalNodeToken }}</label>
        <div class="terminal-secret-row">
          <input id="terminal-node-token" :value="token" :type="getInputType('token')" readonly class="form-input" autocomplete="off" spellcheck="false">
          <button class="btn" :aria-label="trans.terminalShowSecret" :aria-pressed="visibility.token" @click="toggle('token')">{{ trans.terminalShowSecret }}</button>
          <button class="btn" @click="copyToken">{{ copied ? trans.terminalCopied : trans.copy }}</button>
        </div>
        <p>{{ trans.terminalTokenFile }}</p>
        <pre class="terminal-setup-flags">-terminal=1 -terminal-token-file=/absolute/owner-only/terminal-token</pre>
        <p class="text-secondary">{{ trans.terminalSetupFlags }}</p>
      </template>
      <div class="modal-footer"><button class="btn" @click="finish">{{ trans.close }}</button></div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import HelpTooltip from '../../../components/HelpTooltip.vue'
import { adminApi } from '../../../utils/api.js'
import { copyTextToClipboard } from '../../../utils/clipboard.js'
import { usePasswordVisibility } from '../../../composables/usePasswordVisibility.js'

const props = defineProps({ server: { type: Object, required: true }, apiIndex: { type: Number, default: 0 }, trans: { type: Object, required: true } })
const emit = defineEmits(['close'])
const dialog = ref(null)
const secretInput = ref(null)
const secret = ref('')
const token = ref('')
const consent = ref(false)
const busy = ref(false)
const copied = ref(false)
const error = ref('')
const notice = ref('')
const availability = ref(null)
const { visibility, toggle, getInputType, reset } = usePasswordVisibility(['secret', 'token'])
let live = true
let previousFocus = null

const action = async name => {
  if (busy.value || !consent.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await adminApi({ action: name, serverId: props.server.id, password: secret.value }, props.apiIndex)
    if (!live) return
    if (result.error) { error.value = result.error; return }
    if (name === 'terminal_authorize_node') {
      if (!/^[a-f0-9]{64}$/.test(result.data?.token || '')) { error.value = 'terminal_request_failed'; return }
      token.value = result.data.token
    } else notice.value = name === 'terminal_enable_site' ? props.trans.terminalSiteEnabled : props.trans.terminalNodeRevoked
  } catch (_) { if (live) error.value = 'terminal_request_failed' }
  finally { secret.value = ''; busy.value = false; reset() }
}
const enableSite = () => action('terminal_enable_site')
const authorize = () => action('terminal_authorize_node')
const revoke = () => action('terminal_revoke_node')
const copyToken = async () => { copied.value = await copyTextToClipboard(token.value) }
const finish = () => { token.value = ''; secret.value = ''; emit('close') }
const trapFocus = event => {
  const elements = [...dialog.value.querySelectorAll('button:not(:disabled),input:not(:disabled)')]
  const target = event.shiftKey ? elements.at(-1) : elements[0]
  if ((event.shiftKey && document.activeElement === elements[0]) || (!event.shiftKey && document.activeElement === elements.at(-1))) {
    event.preventDefault(); target?.focus()
  }
}
onMounted(async () => {
  previousFocus = document.activeElement
  secretInput.value?.focus()
  const result = await adminApi({ action: 'terminal_status', serverId: props.server.id }, props.apiIndex)
  if (!live) return
  if (result.error) error.value = result.error
  else availability.value = result.data
})
onBeforeUnmount(() => { live = false; token.value = ''; secret.value = ''; reset(); previousFocus?.focus() })
</script>

<style scoped>
.terminal-access { max-width: 720px; }
.terminal-access h2 { font-size: inherit; }
.terminal-consent { display: flex; align-items: flex-start; gap: 8px; margin: 16px 0; }
.terminal-secret-row, .terminal-access-actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
.terminal-secret-row input { flex: 1; min-width: 180px; }
.terminal-setup-flags { background: var(--bg-primary); padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
