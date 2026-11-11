<template>
  <AdminDialog :open="show" :title="trans.adminAddNode" size="add" :busy="saving" @close="$emit('close')">
    <template #body>
      <form id="admin-add-server" @submit.prevent="$emit('save')">
        <div class="form-group"><label for="add-server-name" class="form-label">{{ trans.serverName }}</label><input id="add-server-name" v-model="name" class="form-input" required autocomplete="off"></div>
        <div class="form-group"><label for="add-server-group" class="form-label">{{ trans.group }}</label><input id="add-server-group" v-model="group" class="form-input" list="add-server-groups" :placeholder="trans.default"><datalist id="add-server-groups"><option v-for="value in groups" :key="value" :value="value" /></datalist></div>
        <p v-if="error" class="text-red" role="alert">{{ error }}</p>
      </form>
    </template>
    <template #footer><button class="btn" :disabled="saving" @click="$emit('close')">{{ trans.cancel }}</button><button class="btn btn-primary" type="submit" form="admin-add-server" :disabled="saving">{{ saving ? trans.saving : trans.adminAddNode }}</button></template>
  </AdminDialog>
</template>
<script setup>
import AdminDialog from './AdminDialog.vue'
defineProps({ trans: Object, show: Boolean, saving: Boolean, error: String, groups: Array })
const name = defineModel('name', { type: String, default: '' })
const group = defineModel('group', { type: String, default: '' })
defineEmits(['close', 'save'])
</script>
