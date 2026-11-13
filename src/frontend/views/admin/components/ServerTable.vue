<template>
  <div id="tab-servers" class="tab-content" :class="{ active: activeTab === 'servers' }">
    <div class="toolbar">
      <div class="admin-filter-group">
        <label class="admin-search"><input v-model="search" type="search" class="toolbar-input" :placeholder="trans.adminSearchNodes" :aria-label="trans.adminSearchNodes"><AdminIcon name="search" /></label>
        <select v-model="filterGroup" class="toolbar-select" :aria-label="trans.adminFilterGroup"><option value="">{{ trans.adminAllGroups }}</option><option v-for="group in groups" :key="group" :value="group">{{ group }}</option></select>
      </div>
      <button @click="$emit('groups')" class="btn"><AdminIcon name="layers" />{{ trans.group }}</button>
      <button @click="$emit('auto-discovery-cmd')" class="btn"><AdminIcon name="server" />{{ trans.adminBulkAdd }}</button>
      <button @click="$emit('add-server')" class="btn btn-primary"><AdminIcon name="plus" />{{ trans.adminAddNode }}</button>
    </div>
    <div class="table-wrapper" :aria-label="trans.adminNodes" tabindex="0">
      <table class="terminal-table admin-node-table">
        <thead><tr><th class="admin-col-name">{{ trans.adminNodeName }}</th><th class="admin-col-ip">IP</th><th>{{ trans.status }}</th><th>{{ trans.traffic }}</th><th>{{ trans.price }}<span class="admin-expiry-inline"> / {{ trans.adminExpiry }}</span></th><th class="admin-expiry-column">{{ trans.adminExpiry }}</th><th class="admin-col-actions">{{ trans.actions }}</th></tr></thead>
        <tbody ref="body" @lostpointercapture="cancel">
          <tr v-if="filteredServers.length === 0"><td colspan="7" class="empty-state">{{ trans.noServers }}<button v-if="sortingDisabled" class="btn" @click="search = ''; filterGroup = ''">{{ trans.clear }}</button></td></tr>
          <tr v-for="server in filteredServers" :key="server.id" class="server-row" :data-server-id="server.id" :data-reordering="dragging === String(server.id) ? '' : undefined">
            <td><div class="admin-node-name">
              <button type="button" class="drag-handle" :disabled="sortingDisabled" :aria-label="trans.dragSort + ': ' + server.name" :title="trans.dragSort" draggable="false" @pointerdown="handlePointerDown($event, server.id)" @keydown="handleKeyDown($event, server.id)"><AdminIcon name="grip-vertical" /></button>
              <div><div class="server-info"><img :src="getPublicAssetUrl('flags/' + getFlagRegionCode(server.region || 'xx') + '.svg')" :alt="server.region || 'xx'" class="flag-img"><button class="server-name-link" :title="server.name" @click="$emit('edit', server)">{{ server.name }}</button></div><div class="server-secondary admin-node-metadata" :title="server.os || getOSName(server.os)"><OsIcon :os="server.os" /><span>{{ getOSName(server.os) }}<template v-if="server.server_group && server.server_group !== 'Default'"> · {{ server.server_group }}</template></span></div></div>
            </div></td>
            <td><div v-if="getServerIpRows(server).length" class="server-ip-list"><button v-for="ip in getServerIpRows(server)" :key="ip.copyField" class="admin-copy-value" :class="{ 'spec-copied': isSpecCopied(server, ip.copyField) }" :aria-label="trans.copy + ': ' + ip.address" @click="emitCopySpec(server, ip.copyField, ip.address)">{{ ip.address }}</button></div><span v-else>-</span></td>
            <td><div class="admin-status-stack"><span class="admin-node-status" :class="{ 'is-offline': !server.is_online }">{{ server.is_online ? trans.online : trans.offline }}</span><span v-if="isEnabledFlag(server.is_hidden)" class="admin-private-status">{{ trans.adminPrivateNode }}</span><span v-if="!server.is_online && server.timestamp" class="server-secondary">{{ offlineAge(server) }}</span></div></td>
            <td><span class="admin-traffic-used" :class="{ 'admin-near-limit': trafficBytes(server) !== null && server.traffic_limit > 0 && trafficBytes(server) / (server.traffic_limit * 1024 ** 3) >= 0.8 }">{{ formatTraffic(server) }}</span> <small class="server-secondary admin-traffic-limit">/ {{ server.traffic_limit ? server.traffic_limit + ' GB' : '-' }}</small></td>
            <td><button class="admin-copy-value" @click="emitCopySpec(server, 'price', formatServerPrice(server))">{{ formatServerPrice(server) }}</button><small class="server-secondary admin-expiry-inline">{{ server.expire_date || '-' }}</small></td>
            <td class="admin-expiry-column">{{ server.expire_date || '-' }}</td>
            <td><div class="action-btns">
              <span class="terminal-entry" :class="{ 'terminal-unavailable': !terminalReady(server) }" :tabindex="terminalReady(server) ? undefined : 0" :aria-label="terminalReason(server)" @focus="$event.currentTarget.parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })" @click="!terminalReady(server) && $event.currentTarget.focus({ preventScroll: true })"><button @click="$emit('terminal', server)" class="btn btn-icon" :disabled="!terminalReady(server)" :aria-label="trans.terminalOpen" :aria-describedby="'terminal-reason-' + server.id"><AdminIcon name="terminal" /></button><small :id="'terminal-reason-' + server.id" class="terminal-reason">{{ terminalReason(server) }}</small></span>
              <button @click="$emit('copy-cmd', server.id)" class="btn btn-icon" :aria-label="trans.copy" :title="trans.installCommand"><AdminIcon name="download" /></button>
              <button @click="$emit('edit', server)" class="btn btn-icon" :aria-label="trans.edit" :title="trans.edit"><AdminIcon name="pencil" /></button>
              <button @click="$emit('renew', server)" class="btn btn-icon" :aria-label="trans.adminRenew" :title="trans.adminRenew"><AdminIcon name="calendar-clock" /></button>
              <button @click="$emit('delete', server.id)" class="btn btn-icon btn-red" :aria-label="trans.delete" :title="trans.delete"><AdminIcon name="trash-2" /></button>
            </div></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { getFlagRegionCode, formatBytes, getTerminalBase } from '../../../utils/api'
import { getPublicAssetUrl } from '../../../utils/config'
import { currentLang } from '../../../utils/i18n'
import { detectBillingCycle, detectCurrencySymbol, getBillingCycleOption, getLocalizedOptionField, isEnabledFlag, isFreePrice, normalizeCurrency, normalizePrice } from '../../../utils/server.js'
import { normalizeTimestamp } from '../../../utils/time.js'
import { getTrafficUsageBytes } from '../../../composables/useServerCardData.js'
import OsIcon from '../../../components/OsIcon.vue'
import { getOSName } from '../../../utils/osIcon.js'
import AdminIcon from './AdminIcon.vue'
import { useServerReorder } from '../composables/useServerReorder.js'

const props = defineProps({
  trans: { type: Object, required: true },
  servers: { type: Array, default: () => [] },
  selectedServers: { type: Array, default: () => [] },
  groups: { type: Array, default: () => ['Default'] },
  activeTab: { type: String, default: 'servers' },
  selectedApiIndex: { type: Number, default: 0 },
  siteGeneration: { type: Number, default: 0 },
  terminalStatuses: { type: Object, default: () => ({}) },
  latestAgentVersion: { type: String, default: '' },
  cacheRefreshing: { type: Boolean, default: false },
  copiedServerId: { type: [String, Number], default: null },
  copiedNoteServerId: { type: [String, Number], default: null },
  copiedSpecKey: { type: String, default: null }
})

const newServerName = defineModel('newServerName', { type: String, default: '' })
const newServerGroup = defineModel('newServerGroup', { type: String, default: '' })

const emit = defineEmits([
  'groups', 'add-server', 'auto-discovery-cmd', 'batch-edit', 'batch-delete', 'toggle-select-all', 'refresh-cache', 'select-all',
  'reorder', 'toggle-server', 'copy-note',
  'copy-spec', 'copy-cmd', 'edit', 'delete', 'terminal', 'terminal-access', 'renew'
])

const terminalAvailable = computed(() => {
  try { getTerminalBase(props.selectedApiIndex); return true } catch (_) { return false }
})
const terminalReady = server => {
  const status = props.terminalStatuses[server.id]
  return terminalAvailable.value && status?.enabled === true && status.localEnabled !== false && ['ready', 'offline'].includes(status.state)
}
const terminalReason = server => {
  if (!terminalAvailable.value) return props.trans.terminal_origin_denied
  const state = props.terminalStatuses[server.id]?.state || 'query_failed'
  return state === 'ready' ? props.trans.terminalOpen : props.trans[state.startsWith('terminal_') ? state : 'terminal_' + state] || props.trans.terminal_query_failed
}

const search = ref('')
const filterGroup = ref('')
const sortingDisabled = computed(() => !!search.value.trim() || !!filterGroup.value)
const { body, orderedServers, dragging, handlePointerDown, handleKeyDown, cancel } = useServerReorder(props, sortingDisabled, emit)
const filteredServers = computed(() => {
  const term = search.value.trim().toLocaleLowerCase()
  return orderedServers.value.filter(server => (!filterGroup.value || (server.server_group || props.trans.default) === filterGroup.value) && (!term || [server.name, server.ip_v4, server.ip_v6, server.region, server.server_group, server.os].some(value => String(value || '').toLocaleLowerCase().includes(term))))
})
watch(() => props.selectedApiIndex, () => { search.value = ''; filterGroup.value = '' })

const getSpecCopyKey = (server, field) => `${server.id}:${field}`
const isSpecCopied = (server, field) => props.copiedSpecKey === getSpecCopyKey(server, field)
const emitCopySpec = (server, field, value) => {
  const text = String(value || '').trim()
  if (!text || text === '-') return
  emit('copy-spec', {
    key: getSpecCopyKey(server, field),
    text
  })
}

const normalizePublicIpValue = (value) => String(value ?? '').trim()
const isPublicIpAvailable = (value) => {
  const normalized = normalizePublicIpValue(value)
  return normalized !== '' && normalized !== '0' && normalized.toLowerCase() !== 'false'
}
const getPublicIpAddress = (value) => {
  const normalized = normalizePublicIpValue(value)
  if (!isPublicIpAvailable(normalized) || normalized === '1') return ''
  return normalized
}
const getServerIpRows = (server) => [
  { copyField: 'ip_v4', address: getPublicIpAddress(server.ip_v4) },
  { copyField: 'ip_v6', address: getPublicIpAddress(server.ip_v6) }
].filter(item => item.address)
const trimDisplayPrice = (price) => String(price || '').replace(/\.00$/, '')
const formatServerPrice = (server) => {
  const price = normalizePrice(server.price)
  if (!price) return '-'
  if (isFreePrice(price)) return props.trans.free
  const currency = normalizeCurrency(server.currency || detectCurrencySymbol(server.price))
  const option = getBillingCycleOption(detectBillingCycle(server.price) || server.billing_cycle)
  const cycleLabel = getLocalizedOptionField(option, 'shortLabel', currentLang.value)
  return `${currency} ${trimDisplayPrice(price)} / ${cycleLabel}`
}
const offlineAge = (server) => {
  const timestamp = normalizeTimestamp(server.timestamp)
  if (!timestamp) return '-'
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  return minutes >= 60 ? Math.floor(minutes / 60) + ' ' + props.trans.adminHours : minutes + ' ' + props.trans.adminMinutes
}
const trafficBytes = (server) => {
  const rx = server.net_rx_monthly, tx = server.net_tx_monthly
  const required = server.traffic_calc_type === 'ul' ? [tx] : server.traffic_calc_type === 'dl' ? [rx] : [rx, tx]
  if (required.some(value => !['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0)) return null
  return getTrafficUsageBytes(server)
}
const formatTraffic = server => trafficBytes(server) === null ? '-' : formatBytes(trafficBytes(server))
</script>

<style scoped>
.terminal-entry { position: relative; display: inline-flex; }
.terminal-reason { display: none; position: absolute; left: 0; top: 100%; z-index: 5; width: 180px; padding: 8px; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-color); white-space: normal; }
.terminal-entry:focus-visible { outline: 2px solid var(--text-secondary); outline-offset: 2px; }
.terminal-unavailable button { pointer-events: none; }
.terminal-unavailable:focus .terminal-reason, .terminal-unavailable:focus-within .terminal-reason { display: block; }
.server-row:has(.terminal-unavailable:focus-within) { z-index: 2; }
@media (hover: hover) and (pointer: fine) {
  .terminal-unavailable:hover .terminal-reason { display: block; }
  .server-row:has(.terminal-unavailable:hover) { z-index: 2; }
}
</style>
