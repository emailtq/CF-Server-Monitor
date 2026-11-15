<template>
  <div class="settings-grid collection-settings">
<div class="settings-section"><h3 class="section-title">{{ trans.collectionSettings }}</h3><div class="form-row"><label class="form-group flex-1 checkbox-item">
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
  </div>
</template>

<script setup>
import { computed } from 'vue'
import HelpTooltip from './AdminHelp.vue'
const props = defineProps({ trans: Object, settings: Object, passwordVisible: Object, canEditSiteSettings: Boolean, cspErrors: Object, userAgentInvalid: Boolean, changeAdminPassword: Boolean, d1UsageLoading: Boolean })
defineEmits(['toggle-password', 'toggle-admin-password-change', 'upload-bg', 'upload-bg-mobile', 'upload-favicon', 'query-d1-usage', 'validate-csp'])
import { FRONTEND_WS_TIMEOUT_MINUTES_MAX, HISTORY } from '../../../utils/constants.js'
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

@media (max-width: 639px) {
  .collection-settings .wss-schedule-header > :first-child {
    flex-basis: auto;
  }
}
</style>
