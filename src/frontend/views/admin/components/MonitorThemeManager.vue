<template>
  <section class="settings-section monitor-theme-manager" :aria-label="trans.monitorThemes">
    <div class="monitor-heading">
      <h3 class="section-title">{{ trans.monitorThemes }}</h3>
      <button type="button" class="btn btn-sm" :disabled="busy" @click="load">{{ trans.refresh }}</button>
    </div>
    <p v-if="error" class="danger-box" role="alert">{{ error }}</p>
    <p v-if="!state && !error" class="text-secondary" role="status">{{ trans.themeStoreLoading }}</p>
    <template v-if="state">
      <p class="monitor-status">
        {{ trans.currentTheme }}: <strong>{{ themeName(state.effective) }}</strong>
        <span v-if="state.selected === null"> · {{ trans.monitorThemeDeployment }}</span>
      </p>
      <p class="text-secondary monitor-note">{{ state.hostname ? trans.monitorThemeHost.replace('{host}', state.hostname) : trans.monitorThemeHostDisabled }}</p>
      <p v-if="state.previewStatus !== 200" class="warning-box">{{ previewReason }}</p>
      <div class="monitor-theme-list">
        <article v-for="theme in state.themes" :key="theme.short" class="monitor-theme" :class="{ selected: state.effective === theme.short }">
          <div class="monitor-heading">
            <h4>{{ themeName(theme.short) }}</h4>
            <span class="text-secondary">v{{ theme.version }}</span>
          </div>
          <p class="text-secondary monitor-note">{{ theme.short === 'default' ? trans.monitorDefaultDescription : trans.monitorServerStatusDescription }}</p>
          <div class="monitor-actions">
            <button type="button" class="btn btn-sm" :disabled="busy || state.previewStatus !== 200" @click="preview(theme.short)">{{ trans.preview }}</button>
            <button type="button" class="btn btn-sm btn-primary" :disabled="busy || state.selected === theme.short" @click="select(theme.short)">{{ state.selected === theme.short ? trans.monitorThemeSelected : trans.switchTheme }}</button>
            <button v-if="theme.config?.length" type="button" class="btn btn-sm" :disabled="busy" @click="configure(theme)">{{ trans.settings }}</button>
          </div>
        </article>
      </div>
      <button v-if="state.selected !== null" type="button" class="btn btn-sm monitor-follow" :disabled="busy" @click="select(null)">{{ trans.monitorThemeFollowDeployment }}</button>
    </template>
    <AdminDialog :open="!!editing" :title="`${themeName(editing?.short)} · ${trans.settings}`" :busy="busy" @close="editing = null">
      <template #body>
        <label v-for="field in editing?.config || []" :key="field.key" class="checkbox-item monitor-field">
          <input v-model="draft[field.key]" type="checkbox">
          <span><b>{{ field.key === 'show_summary' ? trans.monitorShowSummary : field.label }}</b><span class="monitor-note text-secondary monitor-field-help">{{ field.key === 'show_summary' ? trans.monitorShowSummaryHelp : field.help }}</span></span>
        </label>
      </template>
      <template #footer>
        <button type="button" class="btn" :disabled="busy" @click="saveConfig({})">{{ trans.monitorThemeReset }}</button>
        <button type="button" class="btn btn-primary" :disabled="busy" @click="saveConfig(draft)">{{ busy ? trans.saving : trans.save }}</button>
      </template>
    </AdminDialog>
  </section>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { adminApi } from '../../../utils/api'
import AdminDialog from './AdminDialog.vue'

const props = defineProps({ trans: { type: Object, required: true }, activeTab: String, selectedApiIndex: Number, requestOwner: Function })
const emit = defineEmits(['alert-message'])
const state = ref(null)
const busy = ref(false)
const error = ref('')
const editing = ref(null)
const draft = ref({})
let active = true
let generation = 0
onBeforeUnmount(() => { active = false; generation++ })
const themeName = short => short === 'default' ? props.trans.monitorDefaultName : short === 'serverstatus' ? 'ServerStatus' : ''
const previewReason = computed(() => props.trans[state.value?.previewStatus === 401 ? 'monitorPreviewPrivate' : state.value?.previewStatus === 403 ? 'monitorPreviewTurnstile' : 'monitorThemeUnavailable'])

const request = async data => {
  if (busy.value) return null
  const at = generation
  busy.value = true
  error.value = ''
  try {
    const result = await adminApi(data, props.selectedApiIndex, props.requestOwner)
    if (!active || at !== generation || result.stale || (props.requestOwner && !props.requestOwner())) return null
    if (result.error) {
      error.value = props.trans[result.error] || props.trans.monitorThemeUnavailable
      return null
    }
    return result.data
  } catch {
    if (active && at === generation) error.value = props.trans.monitorThemeUnavailable
    return null
  } finally {
    if (active && at === generation) busy.value = false
  }
}
const load = async () => {
  const result = await request({ action: 'get_monitor_themes' })
  if (result) state.value = result
}
const select = async theme => {
  const result = await request({ action: 'select_monitor_theme', theme })
  if (result) { state.value = result; emit('alert-message', props.trans.monitorThemeSaved) }
}
const preview = async theme => {
  const result = await request({ action: 'start_monitor_theme_preview', theme })
  if (result?.preview_url) window.open(result.preview_url, '_blank', 'noopener,noreferrer')
}
const configure = theme => {
  editing.value = theme
  draft.value = Object.fromEntries(theme.config.map(field => [field.key, state.value.configs[theme.short][field.key] ?? field.default]))
}
const saveConfig = async config => {
  const result = await request({ action: 'save_monitor_theme_config', theme: editing.value.short, config: { ...config } })
  if (result) { state.value = result; editing.value = null; emit('alert-message', props.trans.monitorThemeSaved) }
}
watch(() => props.selectedApiIndex, () => {
  generation++
  state.value = null
  editing.value = null
  error.value = ''
  busy.value = false
  if (props.activeTab === 'themeStore') load()
})
watch(() => props.activeTab, tab => { if (tab === 'themeStore' && !state.value) load() }, { immediate: true })
</script>

<style scoped>
.monitor-theme-manager { margin-bottom: 28px; }
.monitor-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.monitor-heading h3, .monitor-heading h4 { margin: 0; }
.monitor-heading h4 { font-size: 16px; }
.monitor-status { margin: 14px 0 6px; }
.monitor-note { font-size: 14px; line-height: 1.6; margin: 6px 0 14px; overflow-wrap: anywhere; }
.monitor-theme-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.monitor-theme { padding: 16px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-card); }
.monitor-theme.selected { border-color: var(--accent-green); }
.monitor-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.monitor-actions .btn { flex: 1; white-space: nowrap; }
.monitor-follow { margin-top: 12px; }
.monitor-field { align-items: flex-start; }
.monitor-field-help { display: block; margin: 6px 0 0; }
@media (max-width: 640px) { .monitor-theme-list { grid-template-columns: 1fr; } }
</style>
