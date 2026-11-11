<template>
  <AdminDialog :open="true" :title="`${trans.terminalRevoke} · ${server.name || server.id}`" size="edit" :busy="busy" description-id="terminal-risk" @close="finish">
    <template #body>
      <div class="terminal-access">
        <p id="terminal-risk" class="danger-box">{{ trans.terminalRisk }}</p>
        <p class="text-secondary">{{ trans.terminalRotationWarning }}</p>
        <p class="text-secondary">{{ trans.terminalInstallRecovery }}</p>
        <p v-if="error" role="alert" class="danger-box">{{ trans[error] || trans.terminalRequestFailed }}</p>
        <label class="terminal-consent"><input v-model="consent" type="checkbox" :disabled="busy"> {{ trans.terminalAcceptRisk }}</label>
        <button class="btn btn-red" :disabled="busy || !consent" @click="revoke">{{ trans.terminalRevoke }}</button>
        <p v-if="notice" role="status" :data-disable-result="localConfirmed ? 'confirmed' : 'unconfirmed'">{{ notice }}</p>
      </div>
    </template>
    <template #footer><button class="btn" :disabled="busy" @click="finish">{{ trans.close }}</button></template>
  </AdminDialog>
</template>

<script setup>
import { ref, onBeforeUnmount } from 'vue'
import AdminDialog from './AdminDialog.vue'
import { adminApi } from '../../../utils/api.js'

const props = defineProps({ server: { type: Object, required: true }, apiIndex: { type: Number, default: 0 }, trans: { type: Object, required: true } })
const emit = defineEmits(['close'])
const consent = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const localConfirmed = ref(false)
let live = true
const revoke = async () => {
  if (busy.value || !consent.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await adminApi({action:'terminal_revoke_node',serverId:props.server.id}, props.apiIndex, () => live)
    if (!live) return
    const outcome = result.data || result
    if (outcome.serverRevoked === true) {
      localConfirmed.value = outcome.localConfirmed === true
      notice.value = props.trans[localConfirmed.value ? 'terminalLocalConfirmed' : 'terminalLocalUnconfirmed']
    } else error.value = result.error || 'terminal_request_failed'
  } catch (_) { if (live) error.value = 'terminal_request_failed' }
  finally { if (live) busy.value = false }
}
const finish = () => { if (!busy.value) emit('close') }
onBeforeUnmount(() => { live = false })
</script>

<style scoped>
.terminal-consent { display: flex; align-items: flex-start; gap: 8px; margin: 16px 0; }
</style>
