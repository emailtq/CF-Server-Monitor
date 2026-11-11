<template>
  <AdminDialog :open="show" :title="trans.adminRenew" :busy="saving" @close="$emit('close')">
    <template #body><p class="admin-dialog-subtitle">{{ serverName }}</p><div class="form-row"><div class="form-group"><label class="form-label" for="renew-price">{{ trans.price }}</label><input id="renew-price" name="renew_price" v-model="form.price" class="form-input"></div><div class="form-group"><label class="form-label" for="renew-expiry">{{ trans.expirationDate }}</label><input id="renew-expiry" name="renew_expire_date" v-model="form.expire_date" type="date" class="form-input"></div></div><label class="admin-check-target"><input type="checkbox" v-model="form.auto_renewal"><span>{{ trans.autoRenewal }}</span></label><p v-if="error" class="text-red" role="alert">{{ error }}</p></template>
    <template #footer><button class="btn admin-quiet" :disabled="saving" @click="$emit('close')">{{ trans.cancel }}</button><button class="btn btn-primary" :disabled="saving" @click="$emit('save')">{{ trans.save }}</button></template>
  </AdminDialog>
</template>
<script setup>
import AdminDialog from './AdminDialog.vue'
defineProps({ trans: Object, serverName: String, show: Boolean, saving: Boolean, error: String })
const form = defineModel('form', { type: Object, required: true })
defineEmits(['close','save'])
</script>
