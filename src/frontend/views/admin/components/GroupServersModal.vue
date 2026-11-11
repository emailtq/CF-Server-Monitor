<template>
  <AdminDialog :open="show" :title="trans.group" :busy="busy" @close="$emit('close')">
    <template #body>
      <p class="text-muted text-sm">{{ trans.adminSelected }} {{ selected.length }}/{{ servers.length }}</p>
      <div class="admin-node-picker"><label v-for="server in servers" :key="server.id" class="admin-check-target"><input class="server-checkbox" type="checkbox" :value="server.id" :checked="selected.includes(server.id)" @change="$emit('toggle', server.id)"><span>{{ server.name }}</span></label></div>
      <div class="admin-group-field"><div class="form-group"><label for="group-name" class="form-label">{{ trans.group }}</label><input id="group-name" v-model="group" class="form-input"></div></div>
      <details class="admin-details"><summary>{{ trans.batchEdit }}</summary><div class="admin-form-actions"><button class="btn" @click="$emit('select-all')">{{ trans.toggleAll }}</button><button class="btn" :disabled="!selected.length" @click="$emit('batch-edit')">{{ trans.batchEdit }}</button><button class="btn btn-red" :disabled="!selected.length" @click="$emit('batch-delete')">{{ trans.batchDelete }}</button><button class="btn" :disabled="busy" @click="$emit('refresh')">{{ trans.refreshCache }}</button></div></details>
    </template>
    <template #footer><button class="btn admin-quiet" :disabled="busy" @click="$emit('close')">{{ trans.cancel }}</button><button class="btn btn-primary" :disabled="busy || !selected.length" @click="$emit('save', group)">{{ trans.save }}</button></template>
  </AdminDialog>
</template>
<script setup>
import { ref, watch } from 'vue'
import AdminDialog from './AdminDialog.vue'
const props = defineProps({ trans: Object, show: Boolean, busy: Boolean, servers: Array, selected: Array })
defineEmits(['close','toggle','select-all','batch-edit','batch-delete','refresh','save'])
const group = ref('')
watch(() => props.show, show => { if(show) group.value = '' })
</script>
