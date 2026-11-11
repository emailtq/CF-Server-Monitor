<template>
  <div class="settings-grid">
<div v-if="canEditSiteSettings" class="settings-section"><h3 class="section-title">{{ trans.settings }}</h3><div class="form-group flex-1">
            <label class="form-label">{{ trans.siteTitle }}</label>
            <input type="text" :aria-label="trans.siteTitle" data-setting-field="site_title" v-model="settings.site_title" class="form-input" :placeholder="'Cloudflare Server Monitor'">
          </div></div>
<div class="settings-section">
        <div class="section-title">{{ trans.cloudflareSettings }}</div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">{{ trans.cloudflareAccountId }}</label>
            <input type="text" name="cloudflare_account_id" autocomplete="off" :aria-label="trans.cloudflareAccountId" data-setting-field="cloudflare_account_id" v-model="settings.cloudflare_account_id" class="form-input" :placeholder="trans.cloudflareAccountIdPlaceholder">
          </div>

          <div class="form-group flex-1">
            <label class="form-label">
              Cloudflare API Token
              <HelpTooltip :text="trans.cloudflareTokenTip" />
            </label>
            <div class="password-input-wrapper">
              <input type="text" name="cloudflare_token" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" :aria-label="trans.cloudflareToken" data-setting-field="cloudflare_token" v-model="settings.cloudflare_token" :class="['form-input', { 'secret-input-masked': !passwordVisible.cloudflareToken }]" :placeholder="trans.cloudflareTokenPlaceholder">
              <button type="button" class="password-toggle btn admin-quiet" :aria-pressed="!!passwordVisible.cloudflareToken" :aria-label="(passwordVisible.cloudflareToken ? trans.adminHideSecret : trans.adminShowSecret) + ': Cloudflare API Token'" @click="$emit('toggle-password', 'cloudflareToken')">{{ passwordVisible.cloudflareToken ? trans.adminHideSecret : trans.adminShowSecret }}</button>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group  flex-1">
            <button type="button" @click="$emit('query-d1-usage')" class="btn btn-primary btn-lg" :disabled="d1UsageLoading">{{ trans.queryD1Quota }}</button>
          </div>
        </div>

      </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import HelpTooltip from './AdminHelp.vue'
const props = defineProps({ trans: Object, settings: Object, passwordVisible: Object, canEditSiteSettings: Boolean, cspErrors: Object, pingNodeErrors: Object, userAgentInvalid: Boolean, changeAdminPassword: Boolean, d1UsageLoading: Boolean })
defineEmits(['toggle-password', 'toggle-admin-password-change', 'upload-bg', 'upload-bg-mobile', 'upload-favicon', 'query-d1-usage', 'validate-csp'])
</script>
