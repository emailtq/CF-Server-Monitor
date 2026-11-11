<template>
  <div class="settings-grid">
    <div class="settings-section"><h3 class="section-title">{{ trans.adminInterface }}</h3><div class="form-row"><div class="form-group"><label class="form-label" for="current-language">{{ trans.language }}</label><select id="current-language" class="form-select admin-language-select" :value="currentLang" @change="changeLanguage"><option v-for="language in languages" :key="language.code" :value="language.code">{{ language.nativeLabel }}</option></select></div><div class="form-group"><label class="form-label" for="current-theme">{{ trans.theme }}</label><select id="current-theme" class="form-select admin-theme-select" :value="currentTheme" @change="setTheme($event.target.value)"><option value="auto">{{ trans.themeAuto }}</option><option value="light">{{ trans.themeLight }}</option><option value="dark">{{ trans.themeDark }}</option></select></div></div></div>
<div class="settings-section" v-if="canEditSiteSettings">
        <div class="section-title">{{ trans.appearance }}</div>

        <div class="form-row">


          <div class="form-group flex-1">
            <label class="form-label">{{ trans.displayMode }}</label>
            <select :aria-label="trans.displayMode" data-setting-field="display_mode" v-model="settings.display_mode" class="form-select">
              <option value="bar">{{ trans.displayModeBar }}</option>
              <option value="ring">{{ trans.displayModeRing }}</option>
              <option value="table">{{ trans.displayModeTable }}</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">{{ trans.defaultTheme }}</label>
            <select :aria-label="trans.defaultTheme" data-setting-field="preferred_theme" v-model="settings.preferred_theme" class="form-select">
              <option value="auto">{{ trans.themeAuto }}</option>
              <option value="dark">{{ trans.themeDark }}</option>
              <option value="light">{{ trans.themeLight }}</option>
            </select>
          </div>

          <div class="form-group flex-1">
            <label class="form-label">{{ trans.defaultLanguage }}</label>
            <select :aria-label="trans.defaultLanguage" data-setting-field="default_language" v-model="settings.default_language" class="form-select">
              <option value="auto">{{ trans.languageAuto }}</option>
              <option v-for="language in languages" :key="language.code" :value="language.code">{{ language.nativeLabel }}</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group ">
            <label class="form-label">
              {{ trans.bgImage }}
              <HelpTooltip :text="trans.remoteImageTip" />
            </label>
            <div class="flex" style="gap:8px;">
              <input type="text" :aria-label="trans.bgImage" data-setting-field="custom_bg" v-model="settings.custom_bg" class="form-input flex-1" placeholder="https://...">
              <div class="upload-btn-wrapper">
                <button class="btn btn-margin-0"> {{ trans.upload }}</button>
                <input type="file" accept="image/*" @change="$emit('upload-bg', $event)">
              </div>
            </div>
            <img v-if="settings.custom_bg" :src="settings.custom_bg" class="bg-preview">
          </div>

          <div class="form-group">
            <label class="form-label">
              {{ trans.mobileBgImage }}
              <HelpTooltip :text="trans.remoteImageTip" />
            </label>
            <div class="flex" style="gap:8px;">
              <input type="text" :aria-label="trans.mobileBgImage" data-setting-field="custom_bg_mobile" v-model="settings.custom_bg_mobile" class="form-input flex-1" placeholder="https://...">
              <div class="upload-btn-wrapper">
                <button class="btn btn-margin-0"> {{ trans.upload }}</button>
                <input type="file" accept="image/*" @change="$emit('upload-bg-mobile', $event)">
              </div>
            </div>
            <img v-if="settings.custom_bg_mobile" :src="settings.custom_bg_mobile" class="bg-preview">
          </div>

          <div class="form-group">
            <label class="form-label">
              {{ trans.favicon }}
              <HelpTooltip :text="trans.remoteImageTip" />
            </label>
            <div class="flex" style="gap:8px;">
              <input type="text" :aria-label="trans.favicon" data-setting-field="favicon" v-model="settings.favicon" class="form-input flex-1" placeholder="https://...">
              <div class="upload-btn-wrapper">
                <button class="btn btn-margin-0"> {{ trans.upload }}</button>
                <input type="file" accept="image/*,.ico" @change="$emit('upload-favicon', $event)">
              </div>
            </div>
            <img v-if="settings.favicon" :src="settings.favicon" class="bg-preview">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.cspStatic }}
              <HelpTooltip :text="trans.cspStaticTip" />
            </label>
            <input type="text" :aria-label="trans.cspStatic" data-setting-field="csp_static" v-model="settings.csp_static" class="form-input" placeholder="https://unpkg.com,https://cdn.jsdelivr.net" @blur="$emit('validate-csp', 'csp_static')">
            <p v-if="cspErrors.csp_static" class="text-danger text-sm">{{ cspErrors.csp_static }}</p>
          </div>

          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.cspApi }}
              <HelpTooltip :text="trans.cspApiTip" />
            </label>
            <input type="text" :aria-label="trans.cspApi" data-setting-field="csp_api" v-model="settings.csp_api" class="form-input" placeholder="https://api.example.com" @blur="$emit('validate-csp', 'csp_api')">
            <p v-if="cspErrors.csp_api" class="text-danger text-sm">{{ cspErrors.csp_api }}</p>
          </div>
        </div>
      </div>
<div class="settings-section" v-if="canEditSiteSettings">
        <div class="section-title">{{ trans.appearance }}</div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.customHead }}
              <HelpTooltip :text="trans.cspWarning" />
            </label>
            <textarea :aria-label="trans.customHead" data-setting-field="custom_head" v-model="settings.custom_head" class="form-textarea" rows="3" placeholder="<link rel='stylesheet' href='...'">
            </textarea>
          </div>

          <div class="form-group flex-1">
            <label class="form-label">{{ trans.customScript }}</label>
            <textarea :aria-label="trans.customScript" data-setting-field="custom_script" v-model="settings.custom_script" class="form-textarea" rows="3" placeholder="console.log('Hello');">
            </textarea>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">
              {{ trans.themeOptions }}
              <HelpTooltip :text="trans.themeOptionsTip" />
            </label>
            <textarea :aria-label="trans.themeOptions" data-setting-field="theme_options" v-model="settings.theme_options" class="form-textarea" rows="5" placeholder='{"mikus":1}'></textarea>
          </div>
        </div>

      </div>
<div class="settings-section">
        <div class="section-title">{{ trans.displayOptions }}</div>

        <div class="form-row">


          <label class="form-group flex-1 checkbox-item">
            <input type="checkbox" id="cfg_show_price" :aria-label="trans.showPrice" data-setting-field="show_price" v-model="settings.show_price">
            <span>{{ trans.showPrice }}</span>
          </label>

          <label class="form-group flex-1 checkbox-item">
            <input type="checkbox" id="cfg_show_expire" :aria-label="trans.showExpire" data-setting-field="show_expire" v-model="settings.show_expire">
            <span>{{ trans.showExpire }}</span>
          </label>
        </div>

        <div class="form-row">

          <label class="form-group flex-1 checkbox-item">
            <input type="checkbox" id="cfg_show_tf" :aria-label="trans.showTf" data-setting-field="show_tf" v-model="settings.show_tf">
            <span>{{ trans.showTf }}</span>
          </label>
          <label class="form-group flex-1 checkbox-item">
            <input type="checkbox" id="cfg_show_three_net_details" :aria-label="trans.showThreeNetDetails" data-setting-field="show_three_net_details" v-model="settings.show_three_net_details">
            <span>{{ trans.showThreeNetDetails }}</span>
          </label>
        </div>

        <div class="form-row">

        </div>




      </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useTheme } from '../../../composables/useTheme.js'
import { getLanguage, setLanguage } from '../../../utils/i18n.js'
const { currentTheme, setTheme } = useTheme()
const currentLang = ref(getLanguage())
const changeLanguage = async event => { await setLanguage(event.target.value) }
const changed = event => { currentLang.value = event.detail.lang }
onMounted(() => window.addEventListener('languageChanged', changed))
onBeforeUnmount(() => window.removeEventListener('languageChanged', changed))
import HelpTooltip from './AdminHelp.vue'
const props = defineProps({ trans: Object, settings: Object, passwordVisible: Object, canEditSiteSettings: Boolean, cspErrors: Object, pingNodeErrors: Object, userAgentInvalid: Boolean, changeAdminPassword: Boolean, d1UsageLoading: Boolean })
defineEmits(['toggle-password', 'toggle-admin-password-change', 'upload-bg', 'upload-bg-mobile', 'upload-favicon', 'query-d1-usage', 'validate-csp'])
import { LANGUAGES } from '../../../locales'
const languages = LANGUAGES
</script>
