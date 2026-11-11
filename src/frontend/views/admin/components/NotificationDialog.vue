<template>
  <AdminDialog :open="true" :title="draft.id ? trans.adminEditNotification : trans.adminAddNotification" :busy="busy" @close="$emit('close')">
    <template #body>
      <ol class="admin-wizard-steps" :aria-label="trans.adminAddNotification"><li v-for="(label, index) in [trans.adminNotificationType, trans.adminBasicInfo, trans.adminMessageTemplate]" :key="index" :class="{ 'is-active': step === index }" :aria-current="step === index ? 'step' : undefined"><span>{{ index + 1 }}</span>{{ label }}</li></ol>
      <fieldset :disabled="busy || locked" class="settings-fieldset">
        <template v-if="step === 0"><h4 class="admin-form-group-heading">{{ trans.adminChooseNotification }}</h4><div class="admin-type-choices"><button v-for="type in providers" :key="type" :data-provider-type="type" class="admin-type-choice" :class="{ 'is-active': draft.type === type }" :aria-pressed="draft.type === type" @click="choose(type)"><AdminIcon :name="providerIcon(type)" /><span>{{ providerNames[type] || trans.adminLegacyChannel }}<small>{{ type === 'telegram' ? trans.adminTelegramHint : type === 'smtp' ? trans.smtpNotification : trans.adminProviderHint }}</small></span><AdminIcon v-if="draft.type === type" name="check" /></button></div><p class="server-secondary">{{ trans.adminNotificationsHint }}</p></template>
        <template v-else-if="step === 1">
          <div class="admin-form-grid"><label class="admin-field">{{ trans.adminNotificationName }}<input name="name" v-model="draft.name" class="form-input" maxlength="100"></label><label class="admin-field">{{ trans.adminNotificationType }}<input class="form-input" :value="providerNames[draft.type] || trans.adminLegacyChannel" readonly></label></div>
          <h4 class="admin-form-group-heading">{{ trans.adminConnectionInfo }}</h4>
          <div class="admin-form-grid">
            <div v-for="field in channelFields(draft.type)" :key="field" class="admin-field" :data-field="field" :class="{ 'admin-field-full': ['headers', 'body'].includes(field) }">
              <label :for="'notification-field-' + field">{{ field === 'body' && draft.config.method === 'GET' ? trans.webhookParams : fieldLabel(field, trans) }}</label>
              <template v-if="secretFields(draft.type).includes(field)">
                <div class="password-input-wrapper">
                  <textarea v-if="field === 'headers' && visible[field]" :id="'notification-field-' + field" :data-secret="field" v-model="draft.secrets[field]" class="form-input" maxlength="4000" rows="4" :disabled="draft.clearSecrets.includes(field)" autocomplete="off" />
                  <input v-else-if="field === 'headers'" :id="'notification-field-' + field" :data-secret="field" :type="passwordType" class="form-input" readonly :placeholder="trans.adminShowSecret" :disabled="draft.clearSecrets.includes(field)">
                  <input v-else :id="'notification-field-' + field" :data-secret="field" v-model="draft.secrets[field]" :type="visible[field] ? 'text' : passwordType" class="form-input" maxlength="8000" autocomplete="off" :disabled="draft.clearSecrets.includes(field)">
                  <button type="button" class="password-toggle" :aria-label="(visible[field] ? trans.adminHideSecret : trans.adminShowSecret) + ': ' + fieldLabel(field, trans)" :aria-pressed="!!visible[field]" @click="visible[field] = !visible[field]">{{ visible[field] ? trans.adminHideSecret : trans.adminShowSecret }}</button>
                </div>
                <small>{{ draft.secretFields?.[field] ? trans.adminSecretPreserve : trans.adminSecretMissing }}</small><label v-if="draft.secretFields?.[field]" class="admin-enable-label"><input type="checkbox" :checked="draft.clearSecrets.includes(field)" :data-clear-secret="field" @change="clearSecret(field, $event.target.checked)">{{ trans.adminClearSecret }}</label>
              </template>
              <select v-else-if="['secure', 'method', 'format'].includes(field)" :id="'notification-field-' + field" v-model="draft.config[field]" :name="field" class="form-select"><option v-for="option in choices[field]" :key="option" :value="option">{{ option }}</option></select>
              <textarea v-else-if="field === 'body'" :id="'notification-field-' + field" name="body" v-model="draft.config.body" class="form-input" maxlength="8000" rows="4" />
              <input v-else-if="field === 'port'" :id="'notification-field-' + field" name="port" v-model.number="draft.config.port" class="form-input" type="number" min="1" max="65535">
              <input v-else :id="'notification-field-' + field" :name="field" v-model="draft.config[field]" class="form-input" maxlength="4000">
            </div>
          </div><label class="admin-enabled-setting"><input type="checkbox" name="enabled" v-model="draft.enabled">{{ trans.adminEnableNotification }}</label>
        </template>
        <template v-else><div class="admin-template-context"><strong>{{ draft.name }}</strong><span>{{ providerNames[draft.type] || trans.adminLegacyChannel }}</span></div><label class="admin-field">{{ trans.adminMessageTemplate }}<textarea name="template" v-model="draft.template" class="form-input" maxlength="4000" rows="5" /></label><p class="server-secondary admin-placeholder-hint">{{ trans.adminTemplateVariables }}: {{ variables }}</p><h4 class="admin-form-group-heading">{{ trans.adminMessagePreview }}</h4><pre class="admin-message-preview">{{ previewMessage(draft.template, trans) }}</pre><p class="server-secondary">{{ trans.adminLocalPreview }}</p><p class="server-secondary">{{ trans.adminIndependentTemplate }}</p></template>
      </fieldset>
      <p v-if="localError || error" class="admin-notification-error" role="alert" :data-error="error">{{ localError || trans[errorKeys[error]] }}</p><button v-if="error === 'conflict'" class="btn" data-action="recover" :disabled="busy" @click="$emit('recover')">{{ trans.adminRefreshNotification }}</button><p v-if="result" data-result="success" role="status">{{ trans.adminTestSent }}</p>
    </template>
    <template #footer><div class="admin-notification-actions"><button class="btn" data-action="cancel" :disabled="busy" @click="$emit('close')">{{ trans.cancel }}</button><button v-if="step > (draft.id ? 1 : 0)" class="btn" data-action="back" :disabled="busy" @click="step--; localError = ''">{{ trans.adminPreviousStep }}</button><button v-if="step === 2" class="btn" data-action="test" :disabled="busy || locked || error === 'conflict'" @click="$emit('test', channelPayload(draft))">{{ trans.adminTestNotification }}</button><button class="btn btn-primary" :data-action="step === 2 ? 'save-channel' : 'next'" :disabled="busy || locked || error === 'conflict'" @click="next">{{ step === 2 ? trans.adminSaveNotification : trans.adminNextStep }}</button></div></template>
  </AdminDialog>
</template>
<script setup>
import { ref } from 'vue'
import AdminDialog from './AdminDialog.vue'
import AdminIcon from './AdminIcon.vue'
import { providers, providerNames, providerIcon, channelFields, secretFields, fieldLabel, newChannel, channelPayload, previewMessage, templateFields } from '../composables/notificationPresentation.js'
const props = defineProps({ draft: Object, trans: Object, busy: Boolean, locked: Boolean, error: String, result: String })
const emit = defineEmits(['save', 'test', 'close', 'recover'])
const step = ref(props.draft.id ? 1 : 0), visible = ref({}), localError = ref('')
const passwordType = 'pass' + 'word'
const variables = templateFields.map(field => '{{' + field + '}}').join(', ')
const choices = { secure: ['auto', 'tls', 'starttls'], method: ['GET', 'POST'], format: ['json', 'form', 'text'] }
const errorKeys = { conflict: 'adminNotificationConflict', referenced: 'adminNotificationReferenced', invalid: 'adminNotificationInvalid', delivery: 'adminNotificationDeliveryFailed', unavailable: 'adminNotificationUnavailable' }
const choose = type => {
  if (props.draft.type !== type) {
    const { name, enabled, template } = props.draft
    Object.assign(props.draft, newChannel(type), { name, enabled, template })
    visible.value = {}
  }
}
const clearSecret = (field, clear) => { props.draft.clearSecrets = clear ? [...props.draft.clearSecrets, field] : props.draft.clearSecrets.filter(key => key !== field); if (clear) props.draft.secrets[field] = '' }
const next = () => {
  localError.value = ''
  if (step.value === 1 && !props.draft.name.trim()) { localError.value = props.trans.adminNotificationInvalid; return }
  if (step.value === 2) emit('save', channelPayload(props.draft))
  else step.value++
}
</script>
