<template>
  <AdminDialog :open="true" :title="draft.id ? trans.adminEditNotification : trans.adminAddNotification" :busy="busy" @close="$emit('close')">
    <template #body>
      <fieldset :disabled="busy || locked" class="settings-fieldset">
          <div class="admin-field admin-notification-provider"><span>{{ trans.adminNotificationType }}</span><ToolbarGroupSelect :model-value="draft.type" :choices="providerChoices" :label="trans.adminNotificationType" :disabled="!!draft.id || busy || locked || error === 'conflict'" @update:model-value="choose" /></div>
          <label class="admin-field admin-notification-name">{{ trans.adminNotificationName }}<input name="name" v-model="draft.name" class="form-input" maxlength="100"></label>
          <h4 class="admin-form-group-heading">{{ trans.adminConnectionInfo }}</h4>
          <div class="admin-form-grid">
            <div v-for="field in channelFields(draft.type)" :key="field" class="admin-field" :data-field="field" :class="{ 'admin-field-full': ['headers', 'body'].includes(field) }">
              <label :for="'notification-field-' + field">{{ field === 'body' && draft.config.method === 'GET' ? trans.webhookParams : fieldLabel(field, trans) }}</label>
              <template v-if="secretFields(draft.type).includes(field)">
                <div class="password-input-wrapper admin-secret-field">
                  <textarea v-if="field === 'headers' && visible[field]" :id="'notification-field-' + field" :data-secret="field" v-model="draft.secrets[field]" class="form-input" maxlength="4000" rows="4" :disabled="draft.clearSecrets.includes(field)" autocomplete="off" />
                  <input v-else-if="field === 'headers'" :id="'notification-field-' + field" :data-secret="field" :type="passwordType" class="form-input" readonly :placeholder="trans.adminShowSecret" :disabled="draft.clearSecrets.includes(field)">
                  <input v-else :id="'notification-field-' + field" :data-secret="field" v-model="draft.secrets[field]" :type="visible[field] ? 'text' : passwordType" class="form-input" maxlength="8000" autocomplete="off" :disabled="draft.clearSecrets.includes(field)">
                  <button type="button" class="admin-secret-eye" :aria-label="(visible[field] ? trans.adminHideSecret : trans.adminShowSecret) + ': ' + fieldLabel(field, trans)" :aria-pressed="!!visible[field]" @mousedown.prevent @click="visible[field] = !visible[field]"><AdminIcon :name="visible[field] ? 'eye-off' : 'eye'" /></button>
                </div>
                <small>{{ draft.secretFields?.[field] ? trans.adminSecretPreserve : trans.adminSecretMissing }}</small><label v-if="draft.secretFields?.[field]" class="admin-enable-label"><input type="checkbox" :checked="draft.clearSecrets.includes(field)" :data-clear-secret="field" @change="clearSecret(field, $event.target.checked)">{{ trans.adminClearSecret }}</label>
              </template>
              <select v-else-if="['secure', 'method', 'format'].includes(field)" :id="'notification-field-' + field" v-model="draft.config[field]" :name="field" class="form-select"><option v-for="option in choices[field]" :key="option" :value="option">{{ option }}</option></select>
              <textarea v-else-if="field === 'body'" :id="'notification-field-' + field" name="body" v-model="draft.config.body" class="form-input" maxlength="8000" rows="4" />
              <input v-else-if="field === 'port'" :id="'notification-field-' + field" name="port" v-model.number="draft.config.port" class="form-input" type="number" min="1" max="65535">
              <input v-else :id="'notification-field-' + field" :name="field" v-model="draft.config[field]" class="form-input" maxlength="4000">
            </div>
          </div><label class="admin-enabled-setting"><span>{{ trans.adminEnableNotification }}</span><input type="checkbox" name="enabled" v-model="draft.enabled"></label>
          <label class="admin-field admin-notification-template">{{ trans.adminMessageTemplate }}<textarea name="template" v-model="draft.template" class="form-input" maxlength="4000" rows="5" /></label><p class="server-secondary admin-placeholder-hint">{{ trans.adminTemplateVariables }}: {{ variables }}</p><h4 class="admin-form-group-heading">{{ trans.adminMessagePreview }}</h4><pre class="admin-message-preview">{{ previewMessage(draft.template, trans) }}</pre><p class="server-secondary">{{ trans.adminLocalPreview }}</p><p class="server-secondary">{{ trans.adminIndependentTemplate }}</p>
      </fieldset>
      <p v-if="localError || error" class="admin-notification-error" role="alert" :data-error="error">{{ localError || trans[errorKeys[error]] }}</p><button v-if="error === 'conflict'" class="btn" data-action="recover" :disabled="busy" @click="$emit('recover')">{{ trans.adminRefreshNotification }}</button><p v-if="result" data-result="success" role="status">{{ trans.adminTestSent }}</p>
    </template>
    <template #footer><div class="admin-notification-actions"><button class="btn" data-action="cancel" :disabled="busy" @click="$emit('close')">{{ trans.cancel }}</button><button class="btn" data-action="test" :disabled="busy || locked || error === 'conflict'" @click="submit('test')">{{ trans.adminTestNotification }}</button><button class="btn btn-primary" data-action="save-channel" :disabled="busy || locked || error === 'conflict'" @click="submit('save')">{{ trans.adminSaveNotification }}</button></div></template>
  </AdminDialog>
</template>
<script setup>
import { computed, ref } from 'vue'
import AdminDialog from './AdminDialog.vue'
import AdminIcon from './AdminIcon.vue'
import ToolbarGroupSelect from './ToolbarGroupSelect.vue'
import { providers, providerNames, channelFields, secretFields, fieldLabel, newChannel, channelPayload, previewMessage, templateFields } from '../composables/notificationPresentation.js'
const props = defineProps({ draft: Object, trans: Object, busy: Boolean, locked: Boolean, error: String, result: String })
const emit = defineEmits(['save', 'test', 'close', 'recover'])
const visible = ref({}), localError = ref('')
const providerChoices = computed(() => providers.map(value => ({ value, label: providerNames[value] || props.trans.adminLegacyChannel })))
const passwordType = 'pass' + 'word'
const variables = templateFields.map(field => '{{' + field + '}}').join(', ')
const choices = { secure: ['auto', 'tls', 'starttls'], method: ['GET', 'POST'], format: ['json', 'form', 'text'] }
const errorKeys = { conflict: 'adminNotificationConflict', referenced: 'adminNotificationReferenced', invalid: 'adminNotificationInvalid', delivery: 'adminNotificationDeliveryFailed', unavailable: 'adminNotificationUnavailable' }
const choose = type => {
  if (props.draft.id || props.busy || props.locked || props.error === 'conflict') return
  if (props.draft.type !== type) {
    const { name, enabled, template } = props.draft
    Object.assign(props.draft, newChannel(type), { name, enabled, template })
    visible.value = {}
    localError.value = ''
  }
}
const clearSecret = (field, clear) => { props.draft.clearSecrets = clear ? [...props.draft.clearSecrets, field] : props.draft.clearSecrets.filter(key => key !== field); if (clear) props.draft.secrets[field] = '' }
const submit = action => {
  localError.value = ''
  if (!props.draft.name.trim()) { localError.value = props.trans.adminNotificationInvalid; return }
  emit(action, channelPayload(props.draft))
}
</script>
