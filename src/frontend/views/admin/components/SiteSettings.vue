<template>
  <section class="settings-section cloudflare-settings" data-section="cloudflare">
        <h3 class="section-title">{{ trans.adminCloudflareUsage }}</h3>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label" for="cfg_cloudflare_account_id">{{ trans.cloudflareAccountId }}</label>
            <input id="cfg_cloudflare_account_id" type="text" name="cloudflare_account_id" autocomplete="off" :aria-label="trans.cloudflareAccountId" data-setting-field="cloudflare_account_id" v-model="settings.cloudflare_account_id" class="form-input" :placeholder="trans.cloudflareAccountIdPlaceholder">
          </div>

          <div class="form-group flex-1">
            <label class="form-label" for="cfg_cloudflare_token">
              Cloudflare API Token
              <HelpTooltip :text="trans.cloudflareTokenTip" />
            </label>
            <div class="password-input-wrapper admin-secret-field">
              <input id="cfg_cloudflare_token" type="text" name="cloudflare_token" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" :aria-label="trans.cloudflareToken" data-setting-field="cloudflare_token" v-model="settings.cloudflare_token" :class="['form-input', { 'secret-input-masked': !passwordVisible.cloudflareToken }]" :placeholder="trans.cloudflareTokenPlaceholder">
              <button type="button" class="admin-secret-eye" :aria-pressed="!!passwordVisible.cloudflareToken" :aria-label="(passwordVisible.cloudflareToken ? trans.adminHideSecret : trans.adminShowSecret) + ': Cloudflare API Token'" @mousedown.prevent @click="$emit('toggle-password', 'cloudflareToken')"><AdminIcon :name="passwordVisible.cloudflareToken ? 'eye-off' : 'eye'" /></button>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group  flex-1">
            <button type="button" @click="$emit('query-d1-usage')" class="btn btn-primary btn-lg" :disabled="d1UsageLoading">{{ trans.queryD1Quota }}</button>
          </div>
        </div>

  </section>
</template>

<script setup>
import HelpTooltip from './AdminHelp.vue'
import AdminIcon from './AdminIcon.vue'
defineProps({ trans: Object, settings: Object, passwordVisible: Object, d1UsageLoading: Boolean })
defineEmits(['toggle-password', 'query-d1-usage'])
</script>
