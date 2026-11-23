<template>
  <section class="settings-section monitor-theme-manager" :aria-label="trans.monitorThemes">
    <div class="monitor-heading">
      <h3 class="section-title">{{ trans.monitorThemes }}</h3>
      <div class="monitor-actions">
        <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !state?.runtimeStorage" @click="installing = true">{{ trans.monitorThemeInstall }}</button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="load">{{ trans.refresh }}</button>
      </div>
    </div>
    <p v-if="error" class="danger-box" role="alert">{{ error }}</p>
    <p v-if="!state && !error" class="text-secondary" role="status">{{ trans.themeStoreLoading }}</p>
    <template v-if="state">
      <p class="monitor-status">
        {{ trans.currentTheme }}: <strong>{{ themeName(state.effective) }}</strong>
        <span v-if="state.selected === null"> · {{ trans.monitorThemeDeployment }}</span>
      </p>
      <p class="text-secondary monitor-note">{{ state.defaultFrontend ? trans.monitorThemeDefaultHome : state.hostname ? trans.monitorThemeHost.replace('{host}', state.hostname) : trans.monitorThemeHostDisabled }}</p>
      <p v-if="!state.runtimeStorage" class="warning-box">{{ trans.monitorThemeStorageUnavailable }}</p>
      <p v-if="state.previewStatus !== 200" class="warning-box">{{ previewReason }}</p>
      <div class="monitor-theme-list">
        <article v-for="theme in state.themes" :key="theme.short" class="monitor-theme" :class="{ selected: state.effective === theme.short }">
          <div class="monitor-heading">
            <h4>{{ themeName(theme.short) }}</h4>
            <span class="text-secondary">v{{ theme.version }}</span>
          </div>
          <p class="text-secondary monitor-note">{{ theme.builtin ? theme.short === 'default' ? trans.monitorDefaultDescription : trans.monitorServerStatusDescription : theme.description }}</p>
          <div class="monitor-actions">
            <button type="button" class="btn btn-sm" :disabled="busy || state.previewStatus !== 200" @click="preview(theme.short)">{{ trans.preview }}</button>
            <button type="button" class="btn btn-sm btn-primary" :disabled="busy || state.selected === theme.short" @click="select(theme.short)">{{ state.selected === theme.short ? trans.monitorThemeSelected : trans.switchTheme }}</button>
            <button v-if="monitorConfigForm(theme.config).length" type="button" class="btn btn-sm" :disabled="busy" @click="configure(theme)">{{ trans.settings }}</button>
            <button v-if="!theme.builtin && theme.canUpdate" type="button" class="btn btn-sm" :disabled="busy || !state.runtimeStorage" @click="confirming = { action: 'update_monitor_theme', theme: theme.short }">{{ trans.monitorThemeUpdate }}</button>
            <button v-if="!theme.builtin" type="button" class="btn btn-sm" :disabled="busy" @click="confirming = { action: 'delete_monitor_theme', theme: theme.short }">{{ trans.monitorThemeRemove }}</button>
          </div>
        </article>
      </div>
      <button v-if="state.selected !== null" type="button" class="btn btn-sm monitor-follow" :disabled="busy" @click="select(null)">{{ trans.monitorThemeFollowDeployment }}</button>
    </template>
    <AdminDialog :open="!!editing" :title="`${themeName(editing?.short)} · ${trans.settings}`" :busy="busy" @close="editing = null">
      <template #body>
        <form id="monitor-config-form" @submit.prevent="saveConfig(false)">
          <template v-for="(field, index) in form" :key="index">
            <h3 v-if="field.type === 'title'" class="monitor-config-heading">{{ field.label }}</h3>
            <div v-else class="monitor-config-field">
              <label :for="`monitor-config-${index}`" :class="{ 'checkbox-item': field.type === 'boolean' }">
                <input v-if="field.type === 'boolean'" :id="`monitor-config-${index}`" v-model="draft[field.key]" type="checkbox" :disabled="busy">
                {{ field.key === 'show_summary' && editing?.builtin ? trans.monitorShowSummary : field.label || field.key }}
              </label>
              <textarea v-if="field.type === 'text'" :id="`monitor-config-${index}`" v-model="draft[field.key]" rows="4" :disabled="busy" />
              <select v-else-if="field.type === 'select'" :id="`monitor-config-${index}`" v-model="draft[field.key]" :disabled="busy">
                <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label || option.value }}</option>
              </select>
              <input v-else-if="field.type !== 'boolean'" :id="`monitor-config-${index}`" v-model="draft[field.key]" :type="field.type === 'number' ? 'number' : 'text'" :min="field.min" :max="field.max" :step="field.type === 'number' ? 'any' : undefined" :required="field.type === 'number'" :disabled="busy">
              <p v-if="field.help || (field.key === 'show_summary' && editing?.builtin)" class="monitor-note text-secondary monitor-field-help">{{ field.key === 'show_summary' && editing?.builtin ? trans.monitorShowSummaryHelp : field.help }}</p>
            </div>
          </template>
          <p v-if="error" class="danger-box" role="alert">{{ error }}</p>
        </form>
      </template>
      <template #footer>
        <button type="button" class="btn" :disabled="busy" @click="saveConfig(true)">{{ trans.monitorThemeReset }}</button>
        <button type="submit" form="monitor-config-form" class="btn btn-primary" :disabled="busy">{{ busy ? trans.saving : trans.save }}</button>
      </template>
    </AdminDialog>
    <AdminDialog :open="installing" :title="trans.monitorThemeInstall" :busy="busy" @close="installing = false">
      <template #body>
        <form id="monitor-install-form" @submit.prevent="install">
          <p class="warning-box">{{ trans.monitorThemeTrust }}</p>
          <div class="monitor-config-field"><label for="monitor-theme-repository">{{ trans.monitorThemeRepository }}</label><input id="monitor-theme-repository" v-model.trim="repository" type="url" placeholder="https://github.com/owner/theme" :disabled="busy || !!archive"></div>
          <div class="monitor-config-field"><label for="monitor-theme-archive">{{ trans.monitorThemeUpload }}</label><input id="monitor-theme-archive" type="file" accept=".tar.gz,.gz" :disabled="busy" @change="archive = $event.target.files[0] || null"></div>
          <p class="text-secondary monitor-note">{{ trans.monitorThemeInstallHint }}</p>
          <p v-if="error" class="danger-box" role="alert">{{ error }}</p>
        </form>
      </template>
      <template #footer><button type="submit" form="monitor-install-form" class="btn btn-primary" :disabled="busy || (!archive && !repository)">{{ busy ? trans.saving : trans.monitorThemeInstall }}</button></template>
    </AdminDialog>
    <AdminDialog :open="!!confirming" :title="confirming?.action === 'delete_monitor_theme' ? trans.monitorThemeRemove : trans.monitorThemeUpdate" :busy="busy" @close="confirming = null">
      <template #body>
        <p><strong>{{ themeName(confirming?.theme) }}</strong></p>
        <p class="monitor-note">{{ confirming?.action === 'delete_monitor_theme' ? trans.monitorThemeRemoveHint : trans.monitorThemeTrust }}</p>
        <p v-if="error" class="danger-box" role="alert">{{ error }}</p>
      </template>
      <template #footer><button type="button" class="btn btn-primary" :disabled="busy" @click="changePackage">{{ busy ? trans.saving : confirming?.action === 'delete_monitor_theme' ? trans.monitorThemeRemove : trans.monitorThemeUpdate }}</button></template>
    </AdminDialog>
  </section>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { adminApi, uploadMonitorTheme } from '../../../utils/api'
import AdminDialog from './AdminDialog.vue'
import { monitorConfigForm, monitorConfigValues, monitorConfigOverrides } from '../../../../shared/monitorThemes.js'

const props = defineProps({ trans: { type: Object, required: true }, activeTab: String, selectedApiIndex: Number, requestOwner: Function })
const emit = defineEmits(['alert-message', 'frontend-mode'])
const state = ref(null)
const busy = ref(false)
const error = ref('')
const editing = ref(null)
const draft = ref({})
const installing = ref(false)
const confirming = ref(null)
const repository = ref('')
const archive = ref(null)
const form = computed(() => monitorConfigForm(editing.value?.config))
let active = true
let generation = 0
onBeforeUnmount(() => { active = false; generation++ })
const themeName = short => {
  const theme = state.value?.themes.find(theme => theme.short === short)
  return theme?.builtin && short === 'default' ? props.trans.monitorDefaultName : theme?.name || short || ''
}
const previewReason = computed(() => props.trans[state.value?.previewStatus === 401 ? 'monitorPreviewPrivate' : state.value?.previewStatus === 403 ? 'monitorPreviewTurnstile' : 'monitorThemeUnavailable'])

const request = async (data, execute) => {
  if (busy.value) return null
  const at = generation
  const owner = () => active && at === generation && (!props.requestOwner || props.requestOwner())
  busy.value = true
  error.value = ''
  try {
    const result = await (execute ? execute(owner) : adminApi(data, props.selectedApiIndex, owner))
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
  if (result) { state.value = result; emit('frontend-mode', result.defaultFrontend === true) }
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
  error.value = ''
  draft.value = monitorConfigValues(monitorConfigForm(theme.config), state.value.configs[theme.short] || {})
}
const saveConfig = async reset => {
  const config = reset ? {} : monitorConfigOverrides(form.value, state.value.configs[editing.value.short] || {}, draft.value)
  const result = await request({ action: 'save_monitor_theme_config', theme: editing.value.short, config })
  if (result) { state.value = result; editing.value = null; emit('alert-message', props.trans.monitorThemeSaved) }
}
const install = async () => {
  if (archive.value?.size > 32 * 1024 * 1024) { error.value = props.trans.monitorThemeArchiveTooLarge; return }
  const result = archive.value ? await request(null, async owner => {
    const uploaded = await uploadMonitorTheme(archive.value, props.selectedApiIndex, owner)
    return uploaded.error || !owner() ? uploaded : adminApi({ action: 'get_monitor_themes' }, props.selectedApiIndex, owner)
  }) : await request({ action: 'install_monitor_theme', repository: repository.value })
  if (result) { state.value = result; installing.value = false; archive.value = null; repository.value = ''; emit('alert-message', props.trans.monitorThemeInstalled) }
}
const changePackage = async () => {
  const result = await request(confirming.value)
  if (result) { state.value = result; confirming.value = null; emit('alert-message', props.trans.monitorThemeSaved) }
}
watch(() => props.selectedApiIndex, () => {
  generation++
  state.value = null
  editing.value = null
  installing.value = false
  confirming.value = null
  archive.value = null
  repository.value = ''
  error.value = ''
  busy.value = false
  if (props.activeTab === 'themeStore') load()
})
watch(() => props.activeTab, tab => { if (tab === 'themeStore' && !state.value) load() }, { immediate: true })
</script>

<style scoped>
.monitor-theme-manager { margin-bottom: 28px; }
.monitor-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.monitor-heading .btn { flex-shrink: 0; min-width: max-content; }
.monitor-heading h3, .monitor-heading h4 { margin: 0; }
.monitor-heading h4 { font-size: 16px; }
.monitor-heading h4 { overflow-wrap: anywhere; }
.monitor-status { margin: 14px 0 6px; }
.monitor-note { font-size: 14px; line-height: 1.6; margin: 6px 0 14px; overflow-wrap: anywhere; }
.monitor-theme-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.monitor-theme { padding: 16px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-card); }
.monitor-theme.selected { border-color: var(--accent-green); }
.monitor-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.monitor-actions .btn { flex: 1 1 auto; min-width: max-content; white-space: nowrap; }
.monitor-follow { margin-top: 12px; }
.monitor-field { align-items: flex-start; }
.monitor-field-help { display: block; margin: 6px 0 0; }
.monitor-config-heading { margin: 24px 0 12px; font-size: 16px; }
.monitor-config-field { margin: 14px 0; }
.monitor-config-field > label { display: block; margin-bottom: 8px; }
.monitor-config-field input:not([type=checkbox]), .monitor-config-field textarea, .monitor-config-field select { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; color: var(--text-primary); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; }
.monitor-config-field textarea { resize: vertical; }
@media (max-width: 640px) { .monitor-theme-list { grid-template-columns: 1fr; } .monitor-theme-manager > .monitor-heading { flex-wrap: wrap; } }
</style>
