<template>
  <div v-show="active" class="admin-notification-workspace">
    <p v-if="busy && !config" role="status">{{ trans.loading }}</p>
    <template v-if="config"><AdminNotifications v-show="activeTab === 'notifications'" :trans="trans" :config="config" :busy="busy || locked" @add="openChannel()" @edit="openChannel" @toggle="toggleChannel" @test="testChannel" @remove="removeChannel" @save="save()" @navigate="$emit('navigate', $event)" /><AdminAlerts v-show="activeTab === 'alerts'" :trans="trans" :config="config" :servers="servers" :busy="busy || locked" @add="openRule()" @edit="openRule" @toggle="toggleRule" @remove="removal = { kind: 'rule', value: $event }" @navigate="$emit('navigate', $event)" /></template>
    <template v-if="!channel && !rule"><p v-if="error" class="admin-notification-error" role="alert" :data-error="error">{{ trans[errorKeys[error]] }}</p><button v-if="error" class="btn" data-action="recover" :disabled="busy" @click="load">{{ trans.adminRefreshNotification }}</button><p v-if="result" role="status">{{ trans.operationSuccess }}</p></template>
    <NotificationDialog :locked="locked" v-if="channel" :draft="channel" :trans="trans" :busy="busy" :error="error" :result="result" @save="saveChannel" @test="testChannel" @close="closeDraft" @recover="load" />
    <AlertDialog :locked="locked" v-if="rule" :draft="rule" :previous="config.rules.find(r => r.id === rule.id)" :trans="trans" :channels="config.channels" :servers="servers" :busy="busy" :error="error" @save="saveRule" @close="closeDraft" @recover="load" />
    <AdminDialog :open="!!removal" :title="trans.delete" :busy="busy" @close="removal = null"><template #body><p>{{ removal?.value.name }}</p><div v-if="blockedRules.length" data-blocked-rules><p>{{ trans.adminNotificationReferenced }}</p><ul><li v-for="r in blockedRules" :key="r.id">{{ r.name }}</li></ul></div><p v-if="error" class="admin-notification-error" role="alert">{{ trans[errorKeys[error]] }}</p></template><template #footer><button class="btn" data-action="cancel" :disabled="busy" @click="removal = null">{{ trans.cancel }}</button><button v-if="!blockedRules.length" class="btn btn-primary" :disabled="busy || locked" @click="confirmRemove">{{ trans.delete }}</button></template></AdminDialog>
  </div>
</template>
<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import AdminNotifications from './AdminNotifications.vue'
import AdminAlerts from './AdminAlerts.vue'
import NotificationDialog from './NotificationDialog.vue'
import AlertDialog from './AlertDialog.vue'
import AdminDialog from './AdminDialog.vue'
import { useNotificationConfig } from '../composables/useNotificationConfig.js'
import { newChannel, channelDraft, channelPayload, ruleOptions, ruleReady } from '../composables/notificationPresentation.js'
const props = defineProps({ trans: Object, activeTab: String, servers: Array, selectedApiIndex: Number, requestOwner: Function })
const emit = defineEmits(['navigate', 'config'])
const { config, busy, locked, error, result, load, save, test } = useNotificationConfig(props)
const active = computed(() => ['notifications', 'alerts'].includes(props.activeTab))
const channel = ref(null), rule = ref(null), removal = ref(null)
const discardDraft = () => { if (channel.value) channel.value.secrets = {}; channel.value = null; rule.value = null; removal.value = null }
onBeforeUnmount(discardDraft)
const errorKeys = { conflict: 'adminNotificationConflict', referenced: 'adminNotificationReferenced', invalid: 'adminNotificationInvalid', delivery: 'adminNotificationDeliveryFailed', unavailable: 'adminNotificationUnavailable' }
watch(config, value => { if (!props.requestOwner || props.requestOwner()) emit('config', value) })
load()
const resetFeedback = () => { if (!locked.value) error.value = ''; result.value = '' }
const openChannel = c => { resetFeedback(); channel.value = c ? channelDraft(c) : newChannel() }
const openRule = r => { resetFeedback(); rule.value = r ? JSON.parse(JSON.stringify(r)) : { id: `rule_${crypto.randomUUID()}`, name: '', type: 'offline', enabled: true, scope: { mode: 'all', serverIds: [] }, targetIds: [], options: ruleOptions('offline') } }
const closeDraft = () => { if (!busy.value) { discardDraft(); resetFeedback() } }
const saveChannel = async draft => {
  const channels = draft.id ? config.value.channels.map(c => c.id === draft.id ? draft : c) : [...config.value.channels, draft]
  if (await save(channels)) { discardDraft(); result.value = '' }
}
const testChannel = c => test(channelPayload(c.secrets ? c : channelDraft(c)))
const saveRule = async draft => { const rules = config.value.rules.some(r => r.id === draft.id) ? config.value.rules.map(r => r.id === draft.id ? draft : r) : [...config.value.rules, draft]; if (await save(config.value.channels, rules)) rule.value = null }
const toggleChannel = c => { resetFeedback(); save(config.value.channels.map(channel => channel.id === c.id ? { ...channel, enabled: !channel.enabled } : channel)) }
const toggleRule = r => { resetFeedback(); const draft = { ...r, enabled: !r.enabled }; if (!ruleReady(draft, config.value.channels, props.servers, null)) { openRule(r); error.value = 'invalid'; return } saveRule(draft) }
const removeChannel = c => { resetFeedback(); removal.value = { kind: 'channel', value: c } }
const blockedRules = computed(() => removal.value?.kind === 'channel' ? config.value.rules.filter(r => r.targetIds.includes(removal.value.value.id)) : [])
const confirmRemove = async () => { const item = removal.value; if (!item || blockedRules.value.length) return; if (await save(item.kind === 'channel' ? config.value.channels.filter(c => c.id !== item.value.id) : config.value.channels, item.kind === 'rule' ? config.value.rules.filter(r => r.id !== item.value.id) : config.value.rules)) removal.value = null }
</script>
