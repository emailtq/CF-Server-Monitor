<template>
  <AdminDialog :open="show" :title="trans.adminSetGroup" size="group" :busy="busy" @close="$emit('close')">
    <template #description>{{ trans.adminGroupDescription }}</template>
    <template #body>
      <form id="admin-group-form" class="admin-group-layout" @submit.prevent="!busy && chosen.length && $emit('save', group.trim())">
        <fieldset :disabled="busy">
          <div class="admin-group-name-field"><label for="group-name">{{ trans.adminGroupName }}</label><GroupNameInput id="group-name" v-model="group" :servers="servers" :trans="trans" :disabled="busy" /><p>{{ trans.adminGroupNameHint }}</p></div>
          <div class="admin-group-picker">
            <div class="admin-group-picker-toolbar">
              <label class="admin-group-picker-search"><AdminIcon name="search" /><input v-model="search" class="form-input" :placeholder="trans.adminGroupSearchNodes" :aria-label="trans.adminSearchNodes" @keydown.enter.prevent></label>
              <ToolbarGroupSelect v-if="groups.length" v-model="filter" :groups="groups" :choices="groupChoices" :all-label="trans.adminAllGroups" :label="trans.adminFilterGroup" :active="show && !busy" />
              <button type="button" class="btn admin-group-ghost" data-action="pick-visible" :disabled="!visible.length || visible.every(server => selected.includes(server.id))" @click="pick(true)">{{ trans.selectAll }}</button>
              <button type="button" class="btn admin-group-ghost" data-action="clear-visible" :disabled="!visible.some(server => selected.includes(server.id))" @click="pick(false)">{{ trans.adminSelectNone }}</button>
            </div>
            <div ref="list" class="admin-group-picker-list" :style="listHeight ? { minHeight: `min(${listHeight}px, 16rem, 40dvh)` } : undefined">
              <label v-for="server in visible" :key="server.id" :title="server.name + (server.server_group ? ' · ' + server.server_group : '')"><input class="server-checkbox" type="checkbox" :value="server.id" :checked="selected.includes(server.id)" @change="$emit('toggle', server.id)"><span :class="{ 'text-muted': !server.is_online }">{{ server.name }}</span><small v-if="country(server)">{{ country(server) }}</small></label>
              <p v-if="!visible.length">{{ servers.length ? trans.adminNoMatchingNodes : trans.adminAddNode }}</p>
            </div>
          </div>
        </fieldset>
        <details class="admin-details"><summary>{{ trans.batchEdit }}</summary><div class="admin-form-actions"><button type="button" class="btn" :disabled="busy || !chosen.length" @click="$emit('batch-edit')">{{ trans.batchEdit }}</button><button type="button" class="btn btn-red" :disabled="busy || !chosen.length" @click="$emit('batch-delete')">{{ trans.batchDelete }}</button><button type="button" class="btn" :disabled="busy" @click="$emit('refresh')">{{ trans.refreshCache }}</button></div></details>
      </form>
    </template>
    <template #footer><button class="btn admin-group-ghost" :disabled="busy" @click="$emit('close')">{{ trans.cancel }}</button><button type="submit" form="admin-group-form" class="btn btn-primary" :disabled="busy || !chosen.length"><span>{{ group.trim() ? trans.adminAssignGroup.replace('{name}', group.trim()) : trans.adminRemoveGroup }}</span><span v-if="chosen.length">（{{ chosen.length }} {{ trans.adminGroupNodeUnit }}）</span></button></template>
  </AdminDialog>
</template>
<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import AdminDialog from './AdminDialog.vue'
import AdminIcon from './AdminIcon.vue'
import GroupNameInput from './GroupNameInput.vue'
import ToolbarGroupSelect from './ToolbarGroupSelect.vue'
import { getAdminCountryCode } from './serverMetadata.js'
import '../../../styles/admin-group.css'
const props = defineProps({ trans: Object, show: Boolean, busy: Boolean, servers: Array, selected: Array })
const emit = defineEmits(['close','toggle','select-all','batch-edit','batch-delete','refresh','save'])
const group = ref(''), search = ref(''), filter = ref(''), list = ref(null), listHeight = ref(0)
const groups = computed(() => [...new Set(props.servers.map(server => server.server_group).filter(Boolean))])
const groupChoices = computed(() => [{ value: '', label: props.trans.adminAllGroups }, ...groups.value.map(group => ({ value: `=${group}`, label: group })), { value: 'none', label: props.trans.adminUngrouped }])
const chosen = computed(() => props.servers.filter(server => props.selected.includes(server.id)))
const visible = computed(() => props.servers.filter(server => (!filter.value || (filter.value === 'none' ? !server.server_group : server.server_group === filter.value.slice(1))) && [server.name, server.ip_v4, server.ip_v6, server.region, server.server_group].some(value => String(value || '').toLowerCase().includes(search.value.trim().toLowerCase()))))
const pick = on => { for (const server of visible.value) if (props.selected.includes(server.id) !== on) emit('toggle', server.id) }
const country = server => getAdminCountryCode(server.region)
watch(groups, () => { if (filter.value && !groupChoices.value.some(choice => choice.value === filter.value)) filter.value = '' })
watch(() => props.show, async show => { if (show) { window.dispatchEvent(new CustomEvent('admin-picker-open', { detail: 'group-dialog' })); group.value = search.value = filter.value = ''; listHeight.value = 0; await nextTick(); listHeight.value = list.value?.offsetHeight || 0 } })
</script>
