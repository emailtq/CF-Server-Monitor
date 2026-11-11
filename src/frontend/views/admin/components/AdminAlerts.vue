<template>
  <section><div class="admin-page-heading"><div><h2>{{ trans.adminAlerts }}</h2><p>{{ trans.adminAlertsHint }}</p></div><button class="btn btn-primary" data-action="add-rule" :disabled="busy || config.rules.length >= 64" @click="$emit('add')"><AdminIcon name="plus" />{{ trans.adminAddAlert }}</button></div><div class="admin-quiet-summary"><span>{{ config.rules.length }} {{ trans.adminRulesCount }}</span><span>{{ config.rules.filter(r => r.enabled).length }} {{ trans.adminEnabledCount }}</span><button class="admin-inline-link" @click="$emit('navigate', 'notifications')">{{ trans.adminManageNotifications }}<AdminIcon name="arrow-up-right" /></button></div>
    <div class="admin-rule-list"><article v-for="rule in config.rules" :key="rule.id" class="admin-rule-row" :data-rule-row="rule.id"><div class="admin-rule-title"><button class="server-name-link" :disabled="busy" :data-rule-edit="rule.id" @click="$emit('edit', rule)">{{ rule.name }}</button><span class="admin-rule-condition">{{ condition(rule) }}</span></div><div class="admin-rule-detail"><span>{{ rule.scope.mode === 'all' ? trans.adminAllServersLabel : rule.scope.serverIds.length + ' ' + trans.adminServerCount }}</span><span>{{ trans.adminSendTo }}: {{ rule.targetIds.length === 1 ? config.channels.find(c => c.id === rule.targetIds[0])?.name || rule.targetIds[0] : rule.targetIds.length + ' ' + trans.adminNotificationsCount }}</span><span v-if="missingServers(rule, servers).length" class="text-red">{{ trans.adminMissingScope }}: {{ missingServers(rule, servers).join(', ') }}</span><span v-if="rule.targetIds.some(id => !config.channels.find(c => c.id === id)?.enabled)">{{ rule.targetIds.some(id => config.channels.find(c => c.id === id)?.enabled) ? trans.adminDisabledRecipients : trans.adminStoppedDelivery }}</span></div><div class="admin-channel-actions"><label class="admin-enable-label"><input type="checkbox" :checked="rule.enabled" :disabled="busy" :aria-label="trans.adminEnable + ': ' + rule.name" @change="$emit('toggle', rule)">{{ rule.enabled ? trans.adminEnable : trans.adminDisable }}</label><button class="admin-icon-button" :data-rule-edit="rule.id" :disabled="busy" :aria-label="trans.edit + ': ' + rule.name" @click="$emit('edit', rule)"><AdminIcon name="pencil" /></button><button class="admin-icon-button" :data-rule-remove="rule.id" :disabled="busy" :aria-label="trans.delete + ': ' + rule.name" @click="$emit('remove', rule)"><AdminIcon name="trash-2" /></button></div></article></div>
  </section>
</template>
<script setup>
import AdminIcon from './AdminIcon.vue'
import { missingServers, eventLabel } from '../composables/notificationPresentation.js'
const props = defineProps({ trans: Object, config: Object, servers: Array, busy: Boolean })
defineEmits(['add', 'edit', 'toggle', 'remove', 'navigate'])
const condition = r => {
  const event = r.type === 'resource' ? r.options.metric : r.type
  const value = r.type === 'offline' ? r.options.minutes : r.type === 'expiry' ? r.options.days : r.options.threshold
  const unit = r.type === 'offline' ? props.trans.adminMinutesUnit : r.type === 'expiry' ? props.trans.days : event.startsWith('net') ? 'Mbps' : '%'
  return eventLabel(event, props.trans) + ' · ' + value + unit
}
</script>
