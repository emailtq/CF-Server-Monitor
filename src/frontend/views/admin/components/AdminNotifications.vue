<template>
  <section>
    <div class="admin-page-heading"><div><h2>{{ trans.adminNotifications }}</h2><p>{{ trans.adminNotificationsHint }}</p></div><button class="btn btn-primary" data-action="add-channel" :disabled="busy || config.channels.length >= 64" @click="$emit('add')"><AdminIcon name="plus" />{{ trans.adminAddNotification }}</button></div>
    <div class="admin-quiet-summary"><span>{{ config.channels.length }} {{ trans.adminChannelsCount }}</span><span>{{ config.channels.filter(c => c.enabled).length }} {{ trans.adminEnabledCount }}</span><button class="admin-inline-link" @click="$emit('navigate', 'alerts')">{{ trans.adminManageAlerts }}<AdminIcon name="arrow-up-right" /></button></div>
    <section v-for="type in providers.filter(type => config.channels.some(c => c.type === type))" :key="type" class="admin-channel-group" :data-channel-group="type">
      <div class="admin-group-heading"><h3>{{ type === 'smtp' ? trans.adminSmtpLabel : providerNames[type] || trans.adminLegacyChannel }}</h3><span>{{ config.channels.filter(c => c.type === type).length }}</span></div>
      <article v-for="channel in config.channels.filter(c => c.type === type)" :key="channel.id" class="admin-channel-row" :data-channel-row="channel.id">
        <div class="admin-channel-identity"><span class="admin-channel-icon"><AdminIcon :name="providerIcon(type)" /></span><div><button class="server-name-link" :data-channel-edit="channel.id" :disabled="busy" @click="$emit('edit', channel)">{{ channel.name }}</button><div class="server-secondary">{{ (channel.config.chatId ? 'Chat ID ' + channel.config.chatId : '') || channel.config.to || (Object.values(channel.secretFields || {}).some(Boolean) ? trans.adminSecretConfigured : trans.adminSecretMissing) }}</div></div></div>
        <div class="admin-channel-meta"><span>{{ config.rules.filter(r => r.targetIds.includes(channel.id)).length }} {{ trans.adminLinkedRules }}</span><span>{{ trans.adminIndependentTemplateLabel }}</span></div>
        <div class="admin-channel-actions"><label class="admin-enable-label"><input type="checkbox" :checked="channel.enabled" :disabled="busy" :aria-label="trans.adminEnable + ': ' + channel.name" @change="$emit('toggle', channel)"><span>{{ channel.enabled ? trans.adminEnable : trans.adminDisable }}</span></label><button class="admin-icon-button" :data-channel-test="channel.id" :disabled="busy" :aria-label="trans.adminTestNotification + ': ' + channel.name" @click="$emit('test', channel)"><AdminIcon name="send" /></button><button class="admin-icon-button" :data-channel-edit="channel.id" :disabled="busy" :aria-label="trans.edit + ': ' + channel.name" @click="$emit('edit', channel)"><AdminIcon name="pencil" /></button><button class="admin-icon-button" :data-channel-remove="channel.id" :disabled="busy" :aria-label="trans.delete + ': ' + channel.name" @click="$emit('remove', channel)"><AdminIcon name="trash-2" /></button></div>
      </article>
    </section>
    <div class="settings-section"><div class="admin-form-grid"><label class="admin-field">{{ trans.notificationLanguage }}<select v-model="config.language" class="form-select" :disabled="busy"><option v-for="language in languages" :key="language.code" :value="language.code">{{ language.nativeLabel }}</option></select></label><label class="admin-field">{{ trans.notificationTimezone }}<input v-model="config.timezone" class="form-input" maxlength="100" :disabled="busy"><small>{{ trans.notificationTimezoneTip }}</small></label></div><p class="server-secondary">{{ trans.adminNotificationPreferencesHint }}</p><button class="btn btn-primary" :disabled="busy" data-action="save-notification-preferences" @click="$emit('save')">{{ trans.saveConfig }}</button></div>
  </section>
</template>
<script setup>
import AdminIcon from './AdminIcon.vue'
import { providers, providerNames, providerIcon } from '../composables/notificationPresentation.js'
import { SUPPORTED_LANGUAGES as languages } from '../../../../shared/languages.js'
defineProps({ trans: Object, config: Object, busy: Boolean })
defineEmits(['add', 'edit', 'toggle', 'test', 'remove', 'navigate', 'save'])
</script>
