<template>
  <div class="settings-grid collection-settings">
<div class="settings-section"><h3 class="section-title">{{ trans.adminCollection }}</h3><div class="form-row"><label class="form-group flex-1 checkbox-item">
            <input type="checkbox" id="cfg_wss_report_enabled" :aria-label="trans.wssReportEnabled" data-setting-field="wss_report_enabled" v-model="settings.wss_report_enabled">
            <span><b>{{ trans.wssReportEnabled }}</b></span>
            <HelpTooltip :text="trans.wssReportTip" />
          </label><label class="form-group flex-1 checkbox-item">
            <input type="checkbox" id="cfg_auto_discovery" :aria-label="trans.autoDiscovery" data-setting-field="auto_discovery" v-model="settings.auto_discovery">
            <span><b>{{ trans.autoDiscovery }}</b></span>
            <HelpTooltip :text="trans.autoDiscoveryTip" />
          </label></div><div v-if="settings.wss_report_enabled" class="wss-schedule">
          <div class="wss-schedule-header">
            <div>
              <div class="form-label wss-schedule-title">
                {{ trans.wssReportHours }}
                <HelpTooltip :text="trans.wssReportHoursTip" />
              </div>
              <div class="wss-schedule-meta">
                {{ localTimezoneLabel }} · {{ wssReportHours.length }}/24 {{ trans.hoursSelected }} · {{ trans.agentWssMinVersion }}
              </div>
            </div>
            <div class="wss-schedule-actions">
              <button type="button" class="btn btn-sm" @click="selectAllWssReportHours">{{ trans.selectAll }}</button>
              <button type="button" class="btn btn-sm" @click="clearWssReportHours">{{ trans.clear }}</button>
            </div>
          </div>
          <div class="wss-hour-grid" role="group" :aria-label="trans.wssReportHours">
            <label v-for="hour in 24" :key="hour - 1" class="wss-hour-option" :title="formatWssHourRange(hour - 1)">
              <input
                type="checkbox"
                :checked="isLocalWssReportHourSelected(hour - 1)"
                @change="toggleLocalWssReportHour(hour - 1, $event.target.checked)"
              >
              <span>{{ String(hour - 1).padStart(2, '0') }}</span>
            </label>
          </div>
        </div><div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.frontendWsTimeoutMinutes }}
              <HelpTooltip :text="trans.frontendWsTimeoutMinutesTip" />
            </label>
            <input
              :aria-label="trans.frontendWsTimeoutMinutes" data-setting-field="frontend_ws_timeout_minutes" v-model.number="settings.frontend_ws_timeout_minutes"
              type="number"
              min="0"
              :max="FRONTEND_WS_TIMEOUT_MINUTES_MAX"
              step="1"
              class="form-input"
            >
          </div>

          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.longHistoryPoints }}
              <HelpTooltip :text="trans.longHistoryPointsTip" />
            </label>
            <select :aria-label="trans.longHistoryPoints" data-setting-field="long_history_points" v-model="settings.long_history_points" class="form-select">
              <option v-for="option in longHistoryPointOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </div>
        </div></div>
<div class="settings-section">
        <div class="section-title">{{ trans.pingNodes }}</div>

        <div class="ping-node-grid">
          <div v-for="field in visiblePingFields" :key="field" class="ping-node-item" :data-ping-node="field">
            <div class="ping-node-fields">
              <input type="text" :aria-label="settings[`${field}_name`] + ': ' + trans.serverName" :data-setting-field="`${field}_name`" v-model.trim="settings[`${field}_name`]" class="form-input ping-node-name">
              <input type="text" :aria-label="settings[`${field}_name`] + ': ' + trans.pingNodes" :data-setting-field="field" v-model.trim="settings[field]" :class="['form-input', { 'input-invalid': pingNodeErrors[field] }]" placeholder="host[:port] / [IPv6]:port">
              <button type="button" class="admin-icon-button ping-node-remove" data-action="remove-ping-node" :aria-label="trans.delete + ': ' + settings[`${field}_name`]" @click="removePingNode(field)"><AdminIcon name="x" /></button>
            </div>
            <p v-if="pingNodeErrors[field]" class="text-red text-sm mt-1" role="alert">{{ pingNodeErrors[field] }}</p>
          </div>
        <div v-for="node in settings.extra_ping_nodes" :key="node.id" class="ping-node-item" :data-ping-node="node.id">
          <div class="ping-node-fields">
            <input type="text" :aria-label="node.name + ': ' + trans.serverName" :data-setting-field="`${node.id}_name`" v-model.trim="node.name" class="form-input ping-node-name">
            <input type="text" :aria-label="node.name + ': ' + trans.pingNodes" :data-setting-field="node.id" v-model.trim="node.target" :class="['form-input', { 'input-invalid': pingNodeErrors[node.id] }]" placeholder="host[:port] / [IPv6]:port">
            <button type="button" class="admin-icon-button ping-node-remove" data-action="remove-ping-node" :aria-label="trans.delete + ': ' + node.name" @click="removeExtraPingNode(node.id)"><AdminIcon name="x" /></button>
          </div>
          <p v-if="pingNodeErrors[node.id]" class="text-red text-sm mt-1" role="alert">{{ pingNodeErrors[node.id] }}</p>
        </div>
        </div>
        <div class="ping-node-actions">
          <button type="button" class="btn" data-action="add-ping-node" @click="addPingNode"><AdminIcon name="plus" />{{ trans.adminAddPingNode }}</button>
          <span data-ping-capacity class="text-muted text-sm" role="status">{{ pingCount }}</span>
        </div>
        <p v-if="pingCount > 8" data-ping-resource-warning class="text-muted text-sm mt-1" role="status">{{ trans.adminPingResourceWarning }}</p>
        <p v-if="settings.extra_ping_nodes?.length" class="text-muted text-sm mt-1">{{ trans.adminPingSchemaRequired }}</p>
      </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import AdminIcon from './AdminIcon.vue'
import { PING_NODE_FIELDS } from '../../../utils/pingNode.js'
import HelpTooltip from './AdminHelp.vue'
const props = defineProps({ trans: Object, settings: Object, passwordVisible: Object, canEditSiteSettings: Boolean, cspErrors: Object, pingNodeErrors: Object, userAgentInvalid: Boolean, changeAdminPassword: Boolean, d1UsageLoading: Boolean })
defineEmits(['toggle-password', 'toggle-admin-password-change', 'upload-bg', 'upload-bg-mobile', 'upload-favicon', 'query-d1-usage', 'validate-csp'])
import { FRONTEND_WS_TIMEOUT_MINUTES_MAX, HISTORY } from '../../../utils/constants.js'
const visiblePingFields = ref([])
let nextPingNumber = 1
const pingCount = computed(() => visiblePingFields.value.length + (props.settings.extra_ping_nodes?.length || 0))
watch(() => props.settings, () => {
  visiblePingFields.value = PING_NODE_FIELDS.filter(field => props.settings[field] || props.settings[`${field}_name`])
  nextPingNumber = Math.max(pingCount.value, ...visiblePingFields.value.map(field => Number(/^Node (\d+)$/.exec(props.settings[`${field}_name`] || '')?.[1]) || 0), ...(props.settings.extra_ping_nodes || []).map(node => Number(/^Node (\d+)$/.exec(node.name)?.[1]) || 0)) + 1
}, { immediate: true })
const addPingNode = () => {
  const field = PING_NODE_FIELDS.find(field => !visiblePingFields.value.includes(field))
  if (!field) {
    props.settings.extra_ping_nodes ||= []
    props.settings.extra_ping_nodes.push({ id: `p_${crypto.randomUUID()}`, name: `Node ${nextPingNumber++}`, target: '' })
    return
  }
  props.settings[`${field}_name`] = `Node ${nextPingNumber++}`
  visiblePingFields.value.push(field)
}
const removeExtraPingNode = id => { props.settings.extra_ping_nodes = props.settings.extra_ping_nodes.filter(node => node.id !== id) }
const removePingNode = field => {
  props.settings[field] = ''
  props.settings[`${field}_name`] = ''
  visiblePingFields.value = visiblePingFields.value.filter(value => value !== field)
}
const longHistoryPointOptions = computed(() => (
  HISTORY.LONG_RANGE_POINT_OPTIONS.map(points => ({
    value: String(points),
    label: props.trans.historyPointCount
      ? props.trans.historyPointCount.replace('{points}', points)
      : `${points} points`
  }))
))

const wssReportHours = computed(() => {
  const source = Array.isArray(props.settings.wss_report_hours)
    ? props.settings.wss_report_hours
    : Array.from({ length: 24 }, (_, hour) => hour)
  return source
    .map(hour => Number(hour))
    .filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .filter((hour, index, hours) => hours.indexOf(hour) === index)
    .sort((a, b) => a - b)
})

const localHourToUtcHour = hour => new Date(2000, 0, 1, hour, 0, 0, 0).getUTCHours()

const localTimezoneLabel = computed(() => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const localTime = props.trans.localTime || 'Local time'
  return timezone ? `${localTime} · ${timezone}` : localTime
})

const isLocalWssReportHourSelected = hour => wssReportHours.value.includes(localHourToUtcHour(hour))

const toggleLocalWssReportHour = (hour, checked) => {
  const utcHour = localHourToUtcHour(hour)
  const selected = new Set(wssReportHours.value)
  if (checked) selected.add(utcHour)
  else selected.delete(utcHour)
  props.settings.wss_report_hours = Array.from(selected).sort((a, b) => a - b)
}

const selectAllWssReportHours = () => {
  props.settings.wss_report_hours = Array.from({ length: 24 }, (_, hour) => hour)
}

const clearWssReportHours = () => {
  props.settings.wss_report_hours = []
}

const formatWssHourRange = hour => {
  const utcHour = localHourToUtcHour(hour)
  const localHourText = String(hour).padStart(2, '0')
  const utcHourText = String(utcHour).padStart(2, '0')
  return `${localHourText}:00-${localHourText}:59 ${props.trans.localTime} (${utcHourText}:00-${utcHourText}:59 UTC)`
}

</script>

<style scoped>
.collection-settings .checkbox-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}

.collection-settings .checkbox-item > span {
  grid-column: 1;
  grid-row: 1;
}

.collection-settings .checkbox-item > input {
  grid-column: 2;
  grid-row: 1;
}

.collection-settings .checkbox-item > .admin-field-hint {
  grid-column: 1 / -1;
}

.collection-settings .form-label {
  display: block;
}

.collection-settings .form-input,
.collection-settings .form-select,
.collection-settings .wss-hour-option input,
.collection-settings .checkbox-item {
  scroll-margin-block: 80px;
}

.collection-settings .wss-schedule-header {
  flex-wrap: wrap;
}

.collection-settings .wss-schedule-header > :first-child {
  flex: 1 1 280px;
  min-width: 0;
}

.collection-settings .wss-schedule-meta {
  overflow-wrap: anywhere;
}

.collection-settings .wss-schedule-actions {
  flex-wrap: wrap;
}

.collection-settings .ping-node-grid {
  grid-template-columns: 1fr;
}

.collection-settings .ping-node-fields .ping-node-name {
  width: 140px;
  flex: 0 0 140px;
}

.collection-settings .ping-node-fields .form-input:not(.ping-node-name) {
  width: 0;
  flex: 1;
}

.collection-settings .ping-node-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
.collection-settings .ping-node-item { position: relative; }
.collection-settings [data-action="add-ping-node"] { scroll-margin-block: 80px; }
.collection-settings .ping-node-remove { flex: none; }

@media (max-width: 639px) {
  .collection-settings .ping-node-item { padding-right: 40px; }
  .collection-settings .ping-node-remove { position: absolute; top: 0; right: 0; }
  .collection-settings .ping-node-fields {
    flex-direction: column;
    align-items: stretch;
  }

  .collection-settings .ping-node-fields .ping-node-name,
  .collection-settings .ping-node-fields .form-input:not(.ping-node-name) {
    width: 100%;
    flex: none;
  }

  .collection-settings .wss-schedule-header > :first-child {
    flex-basis: auto;
  }
}
</style>
