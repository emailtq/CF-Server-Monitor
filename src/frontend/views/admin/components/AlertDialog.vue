<template>
  <AdminDialog :open="true" :title="previous ? trans.adminEditAlert : trans.adminAddAlert" size="edit" :busy="busy" @close="$emit('close')">
    <template #body><fieldset class="settings-fieldset" :disabled="busy || locked">
      <div class="admin-form-grid"><label class="admin-field">{{ trans.adminRuleName }}<input name="name" v-model="draft.name" class="form-input" maxlength="100"></label><label class="admin-field">{{ trans.adminAlertEvent }}<select name="event" v-model="event" class="form-select"><option v-for="value in alertEvents" :key="value" :value="value">{{ eventLabel(value, trans) }}</option></select></label>
        <label v-if="draft.type === 'offline'" class="admin-field">{{ trans.adminOfflineMinutes }}<input name="minutes" v-model.number="draft.options.minutes" class="form-input" type="number" min="2" max="30" step="1"></label>
        <label v-if="draft.type === 'traffic'" class="admin-field">{{ trans.trafficAlertThreshold }}<input name="threshold" v-model.number="draft.options.threshold" class="form-input" type="number" min="0" max="100"><small>{{ trans.trafficAlertThresholdTip }}</small></label>
        <template v-if="draft.type === 'expiry'"><label class="admin-field">{{ trans.adminExpiryDays }}<input name="days" v-model.number="draft.options.days" class="form-input" type="number" min="0" max="365" step="1"><small>{{ trans.adminRenewalOnly }}</small></label><label class="admin-field">{{ trans.expireNotificationTime }}<input name="hour" v-model.number="draft.options.hour" class="form-input" type="number" min="0" max="23" step="1"><small>{{ trans.expireNotificationTimeTip }}</small></label></template>
        <template v-if="draft.type === 'resource'"><label class="admin-field">{{ trans.resourceAlertThreshold }} ({{ draft.options.metric.startsWith('net') ? 'Mbps' : '%' }})<input name="threshold" v-model.number="draft.options.threshold" class="form-input" type="number" :min="Number.MIN_VALUE" step="any" :max="draft.options.metric.startsWith('net') ? 100000 : 100"></label><label class="admin-field">{{ trans.resourceAlertWindow }}<select name="intervalMinutes" v-model="draft.options.intervalMinutes" class="form-select"><option v-for="n in [5, 6, 7, 8, 9, 10]" :key="n" :value="n">{{ n }}</option></select></label><label class="admin-field">{{ trans.resourceAlertMode }}<select name="mode" v-model="draft.options.mode" class="form-select"><option value="average">{{ trans.resourceAlertModeAverage }}</option><option value="continuous">{{ trans.resourceAlertModeContinuous }}</option></select></label></template>
      </div>
      <div class="admin-rule-scope"><div class="admin-form-grid"><div class="admin-field"><span>{{ trans.resourceAlertServers }}</span><AdminMultiSelect v-model="serverSelection" :options="serverOptions" :min-selected="1" :label="trans.resourceAlertServers" :summary="draft.scope.mode === 'all' ? trans.adminAllServers + ' (' + servers.length + ')' : undefined">
        <template #before-options><label class="admin-picker-option" :class="{ 'is-disabled': allScopeDisabled }"><input type="checkbox" data-scope-all :checked="draft.scope.mode === 'all'" :disabled="allScopeDisabled" :aria-label="trans.adminAllServers" @change="changeAllScope($event.target.checked)"><span>{{ trans.adminAllServers }} ({{ servers.length }})</span></label></template>
      </AdminMultiSelect></div><div class="admin-field"><span>{{ trans.adminNotifications }}</span><AdminMultiSelect v-model="draft.targetIds" :options="channelOptions" :label="trans.adminNotifications" /></div></div><p class="server-secondary">{{ trans.adminIndependentTemplate }}</p></div>
      <p v-if="missing.length" class="admin-notification-error">{{ trans.adminMissingScope }}: {{ missing.join(', ') }}</p><p v-if="draft.targetIds.some(id => !channels.find(c => c.id === id)?.enabled)" class="server-secondary">{{ trans.adminDisabledRecipients }}</p>
      <details class="admin-routing-preview"><summary>{{ trans.adminMessagePreview }}</summary><label class="admin-field">{{ trans.adminNotifications }}<select v-model="previewId" class="form-select"><option v-for="channel in channels.filter(c => draft.targetIds.includes(c.id))" :key="channel.id" :value="channel.id">{{ channel.name }}</option></select></label><pre class="admin-message-preview">{{ previewMessage(channels.find(c => c.id === previewId)?.template, trans, draft) }}</pre><p>{{ trans.adminLocalPreview }}</p></details>
      <label class="admin-enabled-setting"><input type="checkbox" name="enabled" v-model="draft.enabled" :disabled="!draft.enabled && !readyToEnable">{{ trans.adminEnableRule }}</label>
    </fieldset><p v-if="localError || error" class="admin-notification-error" role="alert" :data-error="error">{{ localError || trans[errorKeys[error]] }}</p><button v-if="error === 'conflict'" class="btn" data-action="recover" :disabled="busy" @click="$emit('recover')">{{ trans.adminRefreshNotification }}</button></template>
    <template #footer><button class="btn" data-action="cancel" :disabled="busy" @click="$emit('close')">{{ trans.cancel }}</button><button class="btn btn-primary" data-action="save-rule" :disabled="busy || locked || error === 'conflict'" @click="save">{{ trans.adminSaveAlert }}</button></template>
  </AdminDialog>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import AdminDialog from './AdminDialog.vue'
import AdminMultiSelect from './AdminMultiSelect.vue'
import { ruleOptions, alertEvents, eventLabel, missingServers, ruleReady, previewMessage, providerNames } from '../composables/notificationPresentation.js'
const props = defineProps({ trans: Object, draft: Object, previous: Object, channels: Array, servers: Array, busy: Boolean, locked: Boolean, error: String })
const event = computed({
  get: () => props.draft.type === 'resource' ? props.draft.options.metric : props.draft.type,
  set: value => {
    const type = ['cpu', 'ram', 'disk', 'netIn', 'netOut'].includes(value) ? 'resource' : value
    if (type !== props.draft.type) props.draft.options = ruleOptions(type)
    props.draft.type = type
    if (type === 'resource') props.draft.options.metric = value
  }
})
const emit = defineEmits(['save', 'close', 'recover'])
const localError = ref(''), previewId = ref(props.draft.targetIds[0] || '')
// Historical choices remain available for undo until this draft is saved.
const historicalIds = [...props.draft.scope.serverIds]
const currentServerIds = computed(() => props.servers.map(s => String(s.id)))
const serverSelection = computed({
  get: () => props.draft.scope.mode === 'all' ? currentServerIds.value : props.draft.scope.serverIds,
  set: ids => { if (ids.length) props.draft.scope = { mode: 'selected', serverIds: ids } }
})
// Save the exact historical repair before converting it to a future-inclusive scope.
const allScopeDisabled = computed(() => historicalIds.some(id => !currentServerIds.value.includes(id)) || (props.draft.scope.mode === 'all' && !currentServerIds.value.length))
const changeAllScope = all => {
  if (allScopeDisabled.value) return
  if (all) props.draft.scope = { mode: 'all', serverIds: [] }
  else serverSelection.value = currentServerIds.value
}
const missing = computed(() => missingServers(props.draft, props.servers))
const serverOptions = computed(() => [...props.servers.map(s => ({ value: String(s.id), label: s.name || String(s.id), description: s.server_group })), ...historicalIds.filter(id => !props.servers.some(s => String(s.id) === id)).map(id => ({ value: id, label: id, description: props.trans.adminMissingScope }))])
const channelOptions = computed(() => props.channels.map(c => ({ value: c.id, label: c.name, description: (providerNames[c.type] || props.trans.adminLegacyChannel) + (c.enabled ? '' : ' / ' + props.trans.adminDisable), disabled: !c.enabled && !props.draft.targetIds.includes(c.id) })))
const readyToEnable = computed(() => !missing.value.length && props.draft.targetIds.some(id => props.channels.some(c => c.id === id && c.enabled)))
const errorKeys = { conflict: 'adminNotificationConflict', invalid: 'adminNotificationInvalid', referenced: 'adminNotificationReferenced', unavailable: 'adminNotificationUnavailable' }
watch(() => props.draft.targetIds, ids => { if (!ids.includes(previewId.value)) previewId.value = ids[0] || '' })
const save = () => {
  localError.value = ''
  if (!props.draft.name.trim() || (props.draft.scope.mode === 'selected' && !props.draft.scope.serverIds.length) || props.draft.targetIds.length > 16 || !ruleReady(props.draft, props.channels, props.servers, props.previous)) { localError.value = props.trans.adminNotificationInvalid; return }
  emit('save', JSON.parse(JSON.stringify(props.draft)))
}
</script>
