<template>
  <div class="settings-grid">
<div class="settings-section">
        <div class="section-title">{{ trans.securitySettings }}</div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="checkbox-item">
              <input type="checkbox" id="cfg_turnstile_enabled" :aria-label="trans.enableTurnstile" data-setting-field="turnstile_enabled" v-model="settings.turnstile_enabled">
              <span><b>{{ trans.enableTurnstile }}</b></span>
            </label>
            </div>
          <div class="form-group flex-1">
            <label class="checkbox-item">
              <input type="checkbox" id="cfg_turnstile_login_enabled" :aria-label="trans.enableTurnstileLogin" data-setting-field="turnstile_login_enabled" v-model="settings.turnstile_login_enabled">
              <span>{{ trans.enableTurnstileLogin }}</span>
              <HelpTooltip :text="trans.turnstileLoginTip" />
            </label>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.turnstileSiteKey }}
              <HelpTooltip :text="trans.turnstileTip" />
            </label>
            <input type="text" name="turnstile_site_key" autocomplete="off" :aria-label="trans.turnstileSiteKey" data-setting-field="turnstile_site_key" v-model="settings.turnstile_site_key" class="form-input" :placeholder="trans.turnstileSiteKeyPlaceholder">
          </div>

          <div class="form-group flex-1">
            <label class="form-label">{{ trans.turnstileSecretKey }}</label>
            <div class="password-input-wrapper">
              <input type="text" name="turnstile_secret_key" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" :aria-label="trans.turnstileSecretKey" data-setting-field="turnstile_secret_key" v-model="settings.turnstile_secret_key" :class="['form-input', { 'secret-input-masked': !passwordVisible.turnstileSecret }]" :placeholder="trans.turnstileSecretKeyPlaceholder">
              <button type="button" class="password-toggle btn admin-quiet" :aria-pressed="!!passwordVisible.turnstileSecret" :aria-label="(passwordVisible.turnstileSecret ? trans.adminHideSecret : trans.adminShowSecret) + ': ' + trans.turnstileSecretKey" @click="$emit('toggle-password', 'turnstileSecret')">{{ passwordVisible.turnstileSecret ? trans.adminHideSecret : trans.adminShowSecret }}</button>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.jwtSecret }}
              <HelpTooltip :text="trans.jwtSecretTip" />
            </label>
            <div class="password-input-wrapper">
              <input type="text" name="jwt_secret" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" :aria-label="trans.jwtSecret" data-setting-field="jwt_secret" v-model="settings.jwt_secret" :class="['form-input', { 'secret-input-masked': !passwordVisible.jwtSecret }]" placeholder="••••••••••••••••••••••••••••••••">
              <button type="button" class="password-toggle btn admin-quiet" :aria-pressed="!!passwordVisible.jwtSecret" :aria-label="(passwordVisible.jwtSecret ? trans.adminHideSecret : trans.adminShowSecret) + ': ' + trans.jwtSecret" @click="$emit('toggle-password', 'jwtSecret')">{{ passwordVisible.jwtSecret ? trans.adminHideSecret : trans.adminShowSecret }}</button>
            </div>
          </div>

          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.customUserAgent }}
              <HelpTooltip :text="trans.customUserAgentTip" />
            </label>
            <div class="password-input-wrapper">
              <input
                :aria-label="trans.customUserAgent" data-setting-field="ua" v-model.trim="settings.ua"
                type="text"
                name="ua"
                autocomplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                data-form-type="other"
                maxlength="100"
                :class="['form-input', { 'secret-input-masked': !passwordVisible.ua, 'input-invalid': userAgentInvalid }]"
                :placeholder="trans.customUserAgentPlaceholder"
              >
              <button type="button" class="password-toggle btn admin-quiet" :aria-pressed="!!passwordVisible.ua" :aria-label="(passwordVisible.ua ? trans.adminHideSecret : trans.adminShowSecret) + ': ' + trans.customUserAgent" @click="$emit('toggle-password', 'ua')">{{ passwordVisible.ua ? trans.adminHideSecret : trans.adminShowSecret }}</button>
            </div>
            <p v-if="userAgentInvalid" class="text-red text-sm mt-1">{{ trans.customUserAgentInvalid }}</p>
          </div>
        </div>

      </div>
<div class="settings-section">
        <div class="section-title">{{ trans.adminLoginSettings }}</div>

        <div class="form-group">
          <label class="form-label">{{ trans.username }}</label>
          <input
            type="text"
            name="settings_admin_user"
            autocomplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            :aria-label="trans.username" data-setting-field="username" v-model="settings.username"
            class="form-input"
            :placeholder="trans.usernamePlaceholder"
          >
        </div>

        <div class="inline-help-action mb-3">
          <button type="button" class="btn btn-sm" @click="$emit('toggle-admin-password-change')">
            {{ changeAdminPassword ? trans.cancelPasswordChange : trans.changePassword }}
          </button>
          <HelpTooltip :text="trans.apiSecretTip" />
        </div>

        <div v-if="changeAdminPassword" class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">{{ trans.password }}</label>
            <div class="password-input-wrapper">
              <input
                :type="passwordVisible.password ? 'text' : 'password'"
                name="settings_admin_passphrase"
                autocomplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                data-form-type="other"
                :aria-label="trans.password" data-setting-field="password" v-model="settings.password"
                class="form-input"
                :placeholder="settings.password_configured ? '••••••••' : ''"
              >
              <button type="button" class="password-toggle btn admin-quiet" :aria-pressed="!!passwordVisible.password" :aria-label="(passwordVisible.password ? trans.adminHideSecret : trans.adminShowSecret) + ': ' + trans.password" @click="$emit('toggle-password', 'password')">{{ passwordVisible.password ? trans.adminHideSecret : trans.adminShowSecret }}</button>
            </div>
          </div>

          <div class="form-group flex-1">
            <label class="form-label">{{ trans.confirmPassword }}</label>
            <div class="password-input-wrapper">
              <input
                :type="passwordVisible.confirmPassword ? 'text' : 'password'"
                name="settings_admin_passphrase_confirm"
                autocomplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                data-form-type="other"
                :aria-label="trans.confirmPassword" data-setting-field="confirm_password" v-model="settings.confirm_password"
                class="form-input"
                :placeholder="settings.password_configured ? '••••••••' : ''"
              >
              <button type="button" class="password-toggle btn admin-quiet" :aria-pressed="!!passwordVisible.confirmPassword" :aria-label="(passwordVisible.confirmPassword ? trans.adminHideSecret : trans.adminShowSecret) + ': ' + trans.confirmPassword" @click="$emit('toggle-password', 'confirmPassword')">{{ passwordVisible.confirmPassword ? trans.adminHideSecret : trans.adminShowSecret }}</button>
            </div>
          </div>
        </div>

      </div>
<div class="settings-section"><label class="form-group flex-1 checkbox-item">
            <input type="checkbox" id="cfg_is_public" :aria-label="trans.publicAccess" data-setting-field="is_public" v-model="settings.is_public">
            <span><b>{{ trans.publicAccess }}</b></span>
          </label></div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import HelpTooltip from './AdminHelp.vue'
const props = defineProps({ trans: Object, settings: Object, passwordVisible: Object, canEditSiteSettings: Boolean, cspErrors: Object, pingNodeErrors: Object, userAgentInvalid: Boolean, changeAdminPassword: Boolean, d1UsageLoading: Boolean })
defineEmits(['toggle-password', 'toggle-admin-password-change', 'upload-bg', 'upload-bg-mobile', 'upload-favicon', 'query-d1-usage', 'validate-csp'])
</script>
