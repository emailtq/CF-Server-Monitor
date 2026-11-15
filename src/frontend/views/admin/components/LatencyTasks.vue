<template>
  <div class="latency-page">
    <div class="latency-toolbar"><div role="group" :aria-label="trans.latencyView" class="latency-views"><button v-for="mode in ['task', 'node']" :key="mode" type="button" :aria-pressed="view === mode" @click="view = mode">{{ mode === 'task' ? trans.latencyByTask : trans.latencyByNode }}</button></div><div class="latency-toolbar-actions"><button class="btn" :disabled="busy || loading" @click="load">{{ trans.refresh }}</button><button class="btn btn-primary" :disabled="busy" @click="editTask()"><AdminIcon name="plus" />{{ trans.latencyAdd }}</button></div></div>
      <div v-if="view === 'node'" class="latency-node-toolbar"><label class="admin-search"><AdminIcon name="search" /><input v-model="nodeQuery" class="toolbar-input" :placeholder="trans.adminSearchNodes" :aria-label="trans.adminSearchNodes"></label><ToolbarGroupSelect v-model="nodeGroup" :groups="groups" :all-label="trans.adminAllGroups" :label="trans.adminFilterGroup" :active="true" /></div>
      <div class="table-wrapper" tabindex="0"><table class="terminal-table latency-table" :aria-busy="loading">
        <thead><tr v-if="view === 'task'"><th>{{ trans.latencyName }}</th><th>{{ trans.latencyTarget }}</th><th>{{ trans.latencyInterval }}</th><th>{{ trans.adminNodes }}</th><th>{{ trans.actions }}</th></tr><tr v-else><th>{{ trans.adminNodes }}</th><th>{{ trans.latencyMonitors }}</th><th>{{ trans.actions }}</th></tr></thead>
        <tbody v-if="loading || error" class="latency-status"><tr><td :colspan="view === 'task' ? 5 : 3"><span :role="error ? 'alert' : 'status'" :class="{ 'admin-notification-error': error }">{{ error || (tasks === null ? trans.latencyLoading : trans.latencyRefreshing) }}</span></td></tr></tbody>
        <tbody v-if="view === 'task' && tasks !== null" ref="body" @lostpointercapture="cancel"><tr v-for="task in orderedServers" :key="task.id" :data-server-id="task.id" :data-lifted="lifted === task.id ? '' : undefined" :data-reordering="dragging === task.id ? '' : undefined"><td><div class="latency-task-name"><button class="drag-handle" :disabled="busy || loading" :aria-label="trans.dragSort + ': ' + task.name" @pointerdown="handlePointerDown($event, task.id)" @keydown="handleKeyDown($event, task.id)"><AdminIcon name="grip-vertical" /></button>{{ task.name }}</div></td><td class="latency-target">{{ task.target }}</td><td>{{ task.interval }}s</td><td class="latency-node-count">{{ task.nodes.length === servers.length && servers.length ? trans.adminAllServersLabel : task.nodes.length }}<span v-if="task.auto_join" class="latency-badge">{{ trans.latencyAutoJoinBadge }}</span></td><td><div class="action-btns"><button class="btn btn-icon" :disabled="busy" :aria-label="trans.latencyEdit + ': ' + task.name" @click="editTask(task)"><AdminIcon name="pencil" /></button><button class="btn btn-icon btn-red" :disabled="busy" :aria-label="trans.latencyDelete + ': ' + task.name" @click="deleting = task"><AdminIcon name="trash-2" /></button></div></td></tr><tr v-if="!tasks.length && !error"><td colspan="5" class="empty-state">{{ trans.latencyEmpty }}</td></tr></tbody>
        <tbody v-else-if="view === 'node' && tasks !== null"><tr v-for="node in visibleNodes" :key="node.id"><td><b>{{ node.name }}</b><div class="server-secondary">{{ node.server_group }}</div></td><td class="latency-owned" :title="owned(node.id).map(task => task.name).join(' · ')"><span>{{ owned(node.id).length }} · {{ owned(node.id).map(task => task.name).join(' · ') || trans.latencyUnassigned }}</span></td><td><button class="btn btn-icon" :disabled="busy" :aria-label="trans.latencySelect + ': ' + node.name" @click="editNode(node)"><AdminIcon name="pencil" /></button></td></tr><tr v-if="!visibleNodes.length && !error"><td colspan="3" class="empty-state">{{ trans.noServers }}</td></tr></tbody>
      </table></div>
      <p v-if="tasks?.length > 8" class="server-secondary" data-ping-resource-warning role="status">{{ trans.adminPingResourceWarning }}</p>
      <p class="server-secondary">{{ trans.latencyUpgrade }}</p>
    <AdminDialog v-if="draft" :open="true" :title="nodeDraft ? nodeDraft.name + ' · ' + trans.latencyMonitors : draft.id ? trans.latencyEdit : trans.latencyAdd" size="edit" :busy="busy" @close="closeEditor">
      <template #body><form :id="formId" novalidate @submit.prevent="save"><fieldset class="settings-fieldset" :disabled="busy">
        <section v-if="!nodeDraft" class="latency-task-fields"><label class="admin-field latency-name">{{ trans.latencyName }}<input ref="nameInput" v-model="draft.name" class="form-input" :aria-label="trans.latencyName" placeholder="Cloudflare"></label><label class="admin-field">{{ trans.latencyTarget }}<input v-model="draft.target" class="form-input" :aria-label="trans.latencyTarget" placeholder="1.1.1.1:443"><small>{{ trans.latencyTargetHint }}</small></label><label class="admin-field">{{ trans.latencyInterval }}<input v-model="every" class="form-input" :aria-label="trans.latencyInterval" type="number" min="5" max="3600"><small>5–3600</small></label></section>
        <section class="latency-picker-section" :class="{ 'is-node-picker': nodeDraft }"><header><h3>{{ nodeDraft ? trans.latencyMonitors : trans.latencyRunNodes }}</h3><span role="status">{{ selectedCount }} / {{ pickerItems.length }} {{ trans.adminSelected }}</span></header>
          <div class="latency-picker"><div class="latency-picker-toolbar"><label class="admin-search"><AdminIcon name="search" /><input v-model="query" class="toolbar-input" :aria-label="nodeDraft ? trans.latencySearch : trans.adminSearchNodes" :placeholder="nodeDraft ? trans.latencySearch : trans.adminSearchNodes"></label><ToolbarGroupSelect v-if="!nodeDraft" v-model="group" :groups="groups" :all-label="trans.adminAllGroups" :label="trans.adminFilterGroup" :active="true" :disabled="busy" /><div class="latency-picker-actions"><button type="button" class="btn admin-quiet"  :disabled="visibleSelected === visibleItems.length" @click="pickVisible(true)">{{ trans.selectAll }}</button><button type="button" class="btn admin-quiet"  :disabled="visibleSelected === 0" @click="pickVisible(false)">{{ trans.latencyNone }}</button></div></div>
          <div ref="pickerList" class="latency-picker-list" :style="pickerHeight ? { minHeight: `min(${pickerHeight}px, 256px, 40dvh)` } : undefined" :class="{ 'is-tasks': nodeDraft }"><label v-for="item in visibleItems" :key="item.id" :title="item.name + ' · ' + (item.target || item.server_group || '')" :class="{ 'is-offline': !nodeDraft && !item.is_online }"><input type="checkbox" :checked="chosen.includes(item.id)" :aria-label="item.name" @change="pick([item.id], $event.target.checked)"><span>{{ item.name }}</span><template v-if="nodeDraft"><small>{{ item.target }}</small><small>{{ item.interval }}s</small></template><small v-else>{{ item.region }}</small></label><p v-if="!visibleItems.length">{{ pickerItems.length ? (nodeDraft ? trans.latencyNoMatchingTasks : trans.latencyNoMatchingNodes) : nodeDraft ? trans.latencyEmpty : trans.noServers }}</p></div></div>
          <label v-if="!nodeDraft" class="admin-enabled-setting"><span :id="formId + '-auto'">{{ trans.latencyAutoJoin }}<small>{{ trans.latencyAutoJoinHint }}</small></span><input type="checkbox" role="switch" :aria-labelledby="formId + '-auto'" v-model="draft.auto_join" @keydown.enter.prevent="draft.auto_join = !draft.auto_join"></label>
        </section>
      </fieldset></form></template>
      <template #footer><button class="btn admin-quiet" :disabled="busy" @click="closeEditor">{{ trans.cancel }}</button><button class="btn btn-primary" :form="formId" type="submit" :disabled="busy">{{ busy ? trans.saving : trans.save }}</button></template>
    </AdminDialog>
    <AdminDialog v-if="deleting" :open="true" :title="trans.latencyDelete + ' · ' + deleting.name" :busy="busy" @close="deleting = null"><template #body><p>{{ trans.latencyDeleteHint }}</p></template><template #footer><button class="btn admin-quiet" :disabled="busy" @click="deleting = null">{{ trans.cancel }}</button><button class="btn btn-red" :disabled="busy" @click="remove">{{ trans.delete }}</button></template></AdminDialog>
    <LatencyNotice ref="notice" :in-dialog="!!draft || !!deleting" />
  </div>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AdminDialog from './AdminDialog.vue'
import LatencyNotice from './LatencyNotice.vue'
import AdminIcon from './AdminIcon.vue'
import ToolbarGroupSelect from './ToolbarGroupSelect.vue'
import { adminApi } from '../../../utils/api.js'
import { validatePingNode } from '../../../utils/pingNode.js'
import { useServerReorder } from '../composables/useServerReorder.js'
const props = defineProps({ trans: Object, servers: Array, selectedApiIndex: Number, siteGeneration: Number })
const emit = defineEmits(['activated'])
const tasks = ref(null), busy = ref(false), error = ref(''), formError = ref(''), view = ref('task'), draft = ref(null), nodeDraft = ref(null), deleting = ref(null), every = ref('60'), chosen = ref([]), query = ref(''), group = ref(''), nodeQuery = ref(''), nodeGroup = ref(''), nameInput = ref(null), pickerList = ref(null), pickerHeight = ref(0)
const loading = ref(false)
const formId = `latency-form-${crypto.randomUUID()}`
const notice = ref(null)
let alive = true, base = [], seen = new Set(), openedAutoJoin = false, loadRevision = 0, loadRequest = null, loadAgain = false
const owner = () => alive
onBeforeUnmount(() => { alive = false; loadRequest?.abort() })
const request = async (action, data = {}, current = owner, signal) => {
  const index = props.selectedApiIndex, generation = props.siteGeneration
  const ownsRequest = () => current() && index === props.selectedApiIndex && generation === props.siteGeneration
  const result = await adminApi({ action, ...data }, index, ownsRequest, signal)
  if (!ownsRequest() || result.stale) return null
  if (result.error) throw new Error(props.trans[result.error] || (result.status === 409 ? props.trans.latencyConflict : result.status === 404 ? props.trans.latencyMissing : result.status === 400 ? props.trans.latencyInvalid : result.error))
  if (!Array.isArray(result.data?.tasks) || !Number.isSafeInteger(result.data.revision)) throw new Error(props.trans.latencyUnavailable)
  return result.data
}
const load = async () => {
  if (busy.value || loadRequest) { loadAgain = true; return }
  const revision = ++loadRevision
  const controller = new AbortController()
  loadRequest = controller; loading.value = true; error.value = ''
  const current = () => owner() && revision === loadRevision
  try { const result = await request('latency_list', {}, current, controller.signal); if (result) { tasks.value = result.tasks; emit('activated') } }
  catch (e) { if (current()) error.value = e.message }
  finally {
    if (loadRequest === controller) loadRequest = null
    if (current()) loading.value = false
    if (owner() && loadAgain && !busy.value) { loadAgain = false; void load() }
  }
}
const groups = computed(() => [...new Set(props.servers.map(node => node.server_group).filter(Boolean))])
watch(groups, values => { if (!values.includes(group.value)) group.value = ''; if (!values.includes(nodeGroup.value)) nodeGroup.value = '' })
const matches = (node, needle, selectedGroup) => (!selectedGroup || node.server_group === selectedGroup) && `${node.name} ${node.target || ''} ${node.server_group || ''} ${node.region || ''} ${node.ip_v4 || ''} ${node.ip_v6 || ''}`.toLowerCase().includes(needle.trim().toLowerCase())
const visibleNodes = computed(() => props.servers.filter(node => matches(node, nodeQuery.value, nodeGroup.value)))
const owned = id => (tasks.value || []).filter(task => task.nodes.includes(id))
const pickerItems = computed(() => nodeDraft.value ? tasks.value || [] : props.servers)
watch(() => pickerItems.value.length, async () => {
  if (!draft.value || query.value || group.value) return
  await nextTick()
  pickerHeight.value = Math.max(pickerHeight.value, pickerList.value?.offsetHeight || 0)
})
const visibleItems = computed(() => pickerItems.value.filter(item => matches(item, query.value, nodeDraft.value ? '' : group.value)))
const visibleSelected = computed(() => visibleItems.value.filter(item => chosen.value.includes(item.id)).length)
const selectedCount = computed(() => pickerItems.value.filter(item => chosen.value.includes(item.id)).length)
const pick = (ids, on) => { chosen.value = on ? [...new Set([...chosen.value, ...ids])] : chosen.value.filter(id => !ids.includes(id)) }
const pickVisible = on => pick(visibleItems.value.map(item => item.id), on)
const closeEditor = () => { notice.value?.clear(); draft.value = null; nodeDraft.value = null; formError.value = '' }
const editTask = async task => {
  notice.value?.clear()
  draft.value = task ? { ...task, nodes: [...task.nodes] } : { name: '', target: '', interval: 60, nodes: props.servers.map(node => node.id), auto_join: true }
  nodeDraft.value = null; chosen.value = [...draft.value.nodes]; base = [...chosen.value]; seen = new Set(props.servers.map(node => node.id)); openedAutoJoin = draft.value.auto_join
  every.value = String(draft.value.interval); query.value = ''; group.value = ''; formError.value = ''; pickerHeight.value = 0
  await nextTick(); pickerHeight.value = pickerList.value?.offsetHeight || 0
  if (!task) { await nextTick(); nameInput.value?.focus() }
}
const editNode = async node => { notice.value?.clear(); nodeDraft.value = node; draft.value = {}; chosen.value = owned(node.id).map(task => task.id); base = [...chosen.value]; query.value = ''; formError.value = ''; pickerHeight.value = 0; await nextTick(); pickerHeight.value = pickerList.value?.offsetHeight || 0 }
watch(deleting, value => { notice.value?.clear(); if (value) formError.value = '' })
const runMutation = async (action, data) => {
  if (busy.value) return false
  ++loadRevision
  loadRequest?.abort(); loading.value = false
  busy.value = true; formError.value = ''
  try { const result = await request(action, data); if (!result) return false; tasks.value = result.tasks; error.value = ''; emit('activated'); return true }
  catch (e) { if (owner()) { formError.value = e.message; notice.value?.show(e.message, true) } return false }
  finally { if (owner()) { busy.value = false; if (loadAgain) { loadAgain = false; void load() } } }
}
const save = async () => {
  if (nodeDraft.value) { if (await runMutation('latency_node', { node: nodeDraft.value.id, tasks: chosen.value.filter(id => tasks.value.some(task => task.id === id)), base })) { closeEditor(); await nextTick(); notice.value?.show(props.trans.latencySaved) } return }
  const interval = Number(every.value)
  if (!draft.value.name?.trim() || new TextEncoder().encode(draft.value.name).length > 128 || !draft.value.target?.trim() || !validatePingNode(draft.value.target).valid || !Number.isInteger(interval) || interval < 5 || interval > 3600) { formError.value = props.trans.latencyInvalid; notice.value?.show(formError.value, true); return }
  if (await runMutation('latency_save', { task: { ...draft.value, interval, nodes: chosen.value.filter(id => props.servers.some(node => node.id === id)), ...(draft.value.id ? { base } : {}) } })) { closeEditor(); await nextTick(); notice.value?.show(props.trans.latencySaved) }
}
const remove = async () => { if (await runMutation('latency_delete', { id: deleting.value.id })) { deleting.value = null; await nextTick(); notice.value?.show(props.trans.latencyDeleted) } }
const reorderProps = { get servers() { return tasks.value || [] }, get selectedApiIndex() { return props.selectedApiIndex }, get siteGeneration() { return props.siteGeneration }, get activeTab() { return view.value } }
const { body, orderedServers, lifted, dragging, handlePointerDown, handleKeyDown, cancel } = useServerReorder(reorderProps, computed(() => busy.value || loading.value), async (_, ids) => { if (!await runMutation('latency_order', { ids })) { error.value = formError.value; await load() } })
watch(() => [props.selectedApiIndex, props.siteGeneration], () => {
  ++loadRevision; loadRequest?.abort(); loadRequest = null; loadAgain = false
  tasks.value = null; error.value = ''; loading.value = false; closeEditor(); deleting.value = null
  void load()
}, { flush: 'sync' })
watch(() => props.servers.map(node => node.id).join(), () => {
  if (draft.value && !nodeDraft.value) {
    const fresh = props.servers.filter(node => !seen.has(node.id)).map(node => node.id)
    fresh.forEach(id => seen.add(id))
    if (openedAutoJoin) { base = [...base, ...fresh]; chosen.value = [...new Set([...chosen.value, ...fresh])] }
  }
  load()
}, { immediate: true })
</script>
<style scoped>
.latency-page { display: grid; gap: 16px; }
.latency-toolbar-actions { display: flex; align-items: center; gap: 8px; }
.latency-status { color: var(--cf-muted); }
.latency-toolbar, .latency-picker-section header, .latency-node-toolbar, .latency-picker-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.latency-views { display: flex; padding: 2px; border-radius: 8px; background: var(--cf-soft); }
.latency-views button { border: 0; border-radius: 6px; padding: 4px 12px; font: inherit; font-size: 14px; color: var(--cf-muted); background: transparent; cursor: pointer; }
.latency-views [aria-pressed="true"] { background: var(--cf-panel); color: var(--cf-text); font-weight: 500; box-shadow: 0 1px 2px #0000000d; }
.latency-task-name { display: flex; align-items: center; gap: 8px; }
.latency-task-name .drag-handle { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 24px; height: 24px; padding: 4px; border: 0; border-radius: 4px; background: transparent; color: var(--cf-muted); letter-spacing: normal; }
.latency-task-name .drag-handle:hover { color: var(--cf-text); background: var(--cf-soft); }
.latency-table { table-layout: auto; width: 100%; }
.latency-page.latency-page.latency-page .latency-table :is(th, td) { padding: 8px; font-size: 14px; }
.latency-table tr { position: relative; z-index: 1; background: var(--cf-panel); transition: opacity 150ms; }
.latency-table tr[data-lifted] { opacity: .4; z-index: 0; transform: none !important; }
.latency-table th:nth-child(1) { width: 22%; }.latency-table th:nth-child(2) { width: 34%; }.latency-table th:nth-child(3) { width: 10%; }.latency-table th:nth-child(4) { width: 22%; }.latency-table th:last-child { width: auto; }
.latency-target { white-space: nowrap; font-variant-numeric: tabular-nums; }
.latency-owned span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.latency-owned { max-width: 0; }
.latency-node-count { color: var(--cf-muted); }
.latency-badge { display: inline-block; margin-left: 8px; padding: 1px 8px; border: 1px solid var(--cf-border); border-radius: 6px; font-size: 12px; white-space: nowrap; }
.latency-task-fields { display: grid; grid-template-columns: 1fr 1.4fr 96px; gap: 16px; }
.latency-task-fields > label { min-width: 0; }.latency-page .latency-task-fields .form-input { height: 36px; min-height: 36px; }.latency-task-fields small, .admin-enabled-setting small { display: block; color: var(--cf-muted); font-size: 12px; line-height: 1.625; }
.latency-picker-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--cf-border); display: grid; gap: 12px; min-width: 0; }.latency-picker-section h3 { font-size: 14px; font-weight: 500; margin: 0; }.latency-picker-section header span { font-size: 12px; color: var(--cf-muted); }
.latency-picker-section.is-node-picker { margin-top: 0; padding-top: 0; border: 0; }
.latency-picker-section .admin-enabled-setting { margin-top: 0; border: 1px solid var(--cf-border); border-radius: 8px; background: color-mix(in oklch, var(--cf-soft) 30%, transparent); padding: 10px 12px; font-size: 14px; font-weight: 500; }
.latency-picker-section .admin-enabled-setting small { margin-top: 2px; font-weight: 400; }
:global(.admin-ui .admin-dialog-edit:has(.latency-picker-list.is-tasks)) { max-width: 576px; }
.latency-picker-toolbar .admin-search { flex: 1 1 160px; width: auto; min-width: 0; }.latency-node-toolbar .admin-search { flex: 1; min-width: 0; }.latency-picker-toolbar :deep(.toolbar-select), .latency-node-toolbar :deep(.toolbar-select) { width: 128px; }
.latency-picker { border: 1px solid var(--cf-border); border-radius: 8px; overflow: visible; }.latency-picker-toolbar { padding: 8px; border-bottom: 1px solid var(--cf-border); flex-wrap: wrap; gap: 4px; }.latency-picker-actions { display: flex; gap: 4px; }.latency-picker-list { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 2px; padding: 6px; max-height: min(256px,40dvh); overflow-y: auto; align-content: start; }.latency-picker-list.is-tasks { grid-template-columns: 1fr; }
.latency-picker-list label { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 8px; border-radius: 6px; font-size: 14px; line-height: 20px; cursor: pointer; }.latency-picker-list label:hover { background: var(--cf-soft); }.latency-picker-list span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.latency-picker-list small { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--cf-muted); }.latency-picker-list .is-offline span { color: var(--cf-muted); }
@media(max-width:639px) { .latency-toolbar { flex-wrap: wrap; }.latency-task-fields { grid-template-columns: minmax(0,1fr) 96px; }.latency-name { grid-column: 1/-1; }.latency-picker-list { grid-template-columns: 1fr; } }
@media(min-width:480px) and (max-width:639px) { .latency-picker-list:not(.is-tasks) { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media(pointer:coarse) { .latency-task-name .drag-handle { width: 32px; height: 32px; padding: 8px; } }
</style>
