<template>
  <section class="monitor-theme-manager" :aria-label="trans.monitorThemes">
    <p v-if="error && !state" class="danger-box" role="alert">{{ error }}</p>
    <p v-if="!state && !error" class="text-secondary" role="status">{{ trans.themeStoreLoading }}</p>
    <template v-if="state">
      <div class="monitor-install-card">
        <div>
          <div class="monitor-install-heading">
            <h4>{{ trans.monitorThemeInstall }}</h4>
            <MonitorThemeHelp :text="trans.monitorThemeInstallHint" :label="trans.monitorThemeHelp" />
            <a class="monitor-install-button monitor-browse" href="https://monitor-themes.pages.dev" target="_blank" rel="noopener noreferrer"><AdminIcon name="palette" />{{ trans.monitorThemeBrowse }}</a>
          </div>
          <p class="monitor-install-trust">{{ trans.monitorThemeTrust }}</p>
        </div>
        <form id="monitor-install-form" @submit.prevent="install()">
          <input id="monitor-theme-repository" v-model="repository" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" :placeholder="trans.monitorThemeRepository" :aria-label="trans.monitorThemeRepository" :disabled="busy || !state.runtimeStorage">
          <button type="submit" class="monitor-install-button monitor-install-primary" :disabled="busy || !state.runtimeStorage || !repository.trim()"><AdminIcon name="download" />{{ installing === 'github' ? trans.monitorThemeInstalling : trans.monitorThemeFromGitHub }}</button>
          <button type="button" class="monitor-install-button" :disabled="busy || !state.runtimeStorage" @click="picker?.click()"><AdminIcon name="upload" />{{ installing === 'upload' ? trans.monitorThemeInstalling : trans.monitorThemeUpload }}</button>
          <input id="monitor-theme-archive" ref="picker" type="file" accept=".gz,.tgz,application/gzip" hidden :disabled="busy || !state.runtimeStorage" @change="upload">
        </form>
      </div>
      <p v-if="!state.defaultFrontend" class="text-secondary monitor-note">{{ state.hostname ? trans.monitorThemeHost.replace('{host}', state.hostname) : trans.monitorThemeHostDisabled }}</p>
      <p v-if="!state.runtimeStorage" class="warning-box">{{ trans.monitorThemeStorageUnavailable }}</p>
      <p v-if="state.previewStatus !== 200" class="warning-box">{{ previewReason }}</p>
      <div class="monitor-theme-list">
        <article v-for="theme in state.themes" :key="theme.short" class="monitor-theme">
          <button v-if="theme.preview" type="button" class="monitor-thumbnail" :disabled="!images[theme.revision]" :title="trans.monitorThemeThumbnail" @click="zoomed = theme"><img v-if="images[theme.revision]" :src="images[theme.revision]" :alt="`${themeName(theme.short)} ${trans.monitorThemePreviewImage}`"><span v-else class="monitor-thumbnail-placeholder" aria-busy="true" /></button>
          <div class="monitor-theme-heading">
            <div class="monitor-theme-info">
              <div class="monitor-theme-name"><h4>{{ themeName(theme.short) }}</h4><span v-if="state.effective === theme.short" class="monitor-badge">{{ trans.monitorThemeCurrent }}</span><span v-if="theme.builtin" class="monitor-badge monitor-badge-secondary">{{ trans.monitorThemeBuiltin }}</span></div>
              <p class="monitor-theme-description">{{ theme.builtin ? theme.short === 'default' ? trans.monitorDefaultDescription : trans.monitorServerStatusDescription : theme.description }}</p>
            </div>
            <div class="monitor-theme-actions">
              <button type="button" class="monitor-install-button" :class="state.effective === theme.short ? 'monitor-use-current' : 'monitor-install-primary'" :disabled="busy || state.effective === theme.short" @click="select(theme.short)">{{ state.effective === theme.short ? trans.monitorThemeUsing : trans.monitorThemeUse }}</button>
              <button v-if="monitorConfigForm(theme.config).length" type="button" class="monitor-icon-button" :disabled="busy" :title="trans.monitorThemeSettings" :aria-label="trans.monitorThemeSettings" @click="configure(theme)"><AdminIcon name="sliders-horizontal" /></button>
              <button v-if="theme.canUpdate || theme.builtin" type="button" class="monitor-icon-button" :disabled="busy || !state.runtimeStorage" :title="trans.monitorThemeUpdate" :aria-label="trans.monitorThemeUpdate" @click="update(theme)"><AdminIcon name="refresh-cw" :class="{ 'monitor-spin': updating === theme.short }" /></button>
              <button v-if="!theme.builtin" type="button" class="monitor-icon-button" :disabled="busy" :title="trans.monitorThemeRemove" :aria-label="trans.monitorThemeRemove" @click="confirming = theme"><AdminIcon name="trash-2" /></button>
            </div>
          </div>
          <div class="monitor-theme-meta"><span>{{ theme.author }} · {{ theme.version }}<template v-if="safeSource(theme.url)"> · <a :href="safeSource(theme.url)" target="_blank" rel="noopener noreferrer">{{ trans.monitorThemeSource }}</a></template></span><button type="button" class="monitor-preview-link" :disabled="busy || state.previewStatus !== 200" @click="preview(theme.short)">{{ trans.preview }}</button></div>
        </article>
      </div>
      <div class="monitor-cf-actions"><button type="button" class="monitor-install-button monitor-quiet" :disabled="busy" @click="load">{{ trans.refresh }}</button><button v-if="state.selected !== null" type="button" class="monitor-install-button monitor-quiet" :disabled="busy" @click="select(null)">{{ trans.monitorThemeFollowDeployment }}</button><span v-else class="text-secondary">{{ trans.monitorThemeDeployment }}</span></div>
      <form class="monitor-install-card monitor-site-icons" @submit.prevent="saveIcons">
        <h4>{{ trans.monitorSiteIcons }}</h4>
        <p class="text-secondary">{{ trans.monitorSiteIconsHint }}</p>
        <div v-for="key in ['favicon', 'touch_icon']" :key="key" class="monitor-config-field">
          <label :for="`monitor-${key}`">{{ key === 'favicon' ? trans.favicon : trans.monitorTouchIcon }}</label>
          <div class="monitor-cf-actions"><input :id="`monitor-${key}`" type="file" accept="image/*,.ico" :disabled="busy" @change="iconFile(key, $event)"><button type="button" class="monitor-install-button monitor-quiet" :disabled="busy" @click="iconDraft[key] = ''">{{ trans.delete }}</button><img v-if="iconDraft[key]" :src="iconDraft[key]" width="32" height="32" :alt="key"></div>
        </div>
        <div class="monitor-cf-actions"><button type="button" class="monitor-install-button monitor-quiet" :disabled="busy" @click="iconDraft = { ...iconSaved }">{{ trans.cancel }}</button><button type="submit" class="monitor-install-button monitor-install-primary" :disabled="busy">{{ trans.save }}</button></div>
      </form>
    </template>
    <AdminDialog :open="!!editing" :title="`${themeName(editing?.short)} ${trans.settings}`" :size="large ? 'monitor-large' : 'monitor'" :busy="busy" @close="editing = null">
      <template #body>
        <form id="monitor-config-form" class="monitor-config-layout" @submit.prevent="saveConfig">
          <nav v-if="paged" class="monitor-config-nav" :aria-label="trans.settings"><button v-for="(section,index) in sections" :key="index" type="button" :aria-current="currentSection === index" @click="currentSection = index"><span>{{ section.label }}</span><i v-if="section.fields.some(field => draft[field.key] !== field.default)" :title="trans.monitorThemeChanged" /></button></nav>
          <div class="monitor-config-grid" :class="{ large }">
          <template v-for="(field, index) in visibleForm" :key="field.key || index">
            <h3 v-if="field.type === 'title'" class="monitor-config-heading">{{ field.label }}</h3>
            <div v-else class="monitor-config-field" :class="{ 'monitor-boolean': field.type === 'boolean', 'monitor-wide': large && field.type === 'text' }">
              <label v-if="field.type === 'boolean'" :for="`monitor-config-${index}`" class="monitor-switch-row"><span><span class="monitor-switch-title">{{ field.key === 'show_summary' && editing?.builtin ? trans.monitorShowSummary : field.label || field.key }}</span><span v-if="field.help || (field.key === 'show_summary' && editing?.builtin)" class="monitor-switch-help">{{ field.key === 'show_summary' && editing?.builtin ? trans.monitorShowSummaryHelp : field.help }}</span></span><input :id="`monitor-config-${index}`" v-model="draft[field.key]" type="checkbox" role="switch" :disabled="busy" @keydown.enter.prevent="draft[field.key] = !draft[field.key]"></label>
              <label v-else :for="`monitor-config-${index}`">
                {{ field.key === 'show_summary' && editing?.builtin ? trans.monitorShowSummary : field.label || field.key }}
              </label>
              <textarea v-if="field.type === 'text'" :id="`monitor-config-${index}`" v-model="draft[field.key]" rows="4" :disabled="busy" />
              <ToolbarGroupSelect v-else-if="field.type === 'select'" :id="`monitor-config-${index}`" v-model="draft[field.key]" :choices="field.options.map(option => ({value:option.value,label:option.label || option.value}))" :label="field.label || field.key" :disabled="busy" :active="!!editing" />
              <input v-else-if="field.type !== 'boolean'" :id="`monitor-config-${index}`" v-model="draft[field.key]" :type="field.type === 'number' ? 'number' : 'text'" :min="field.min" :max="field.max" :step="field.type === 'number' ? 'any' : undefined" :required="field.type === 'number'" :disabled="busy">
              <p v-if="field.type !== 'boolean' && field.help" class="text-secondary monitor-field-help">{{ field.help }}</p>
            </div>
          </template>
          </div>
        </form>
      </template>
      <template #footer>
        <button type="button" class="monitor-install-button monitor-quiet monitor-reset" :disabled="busy" @click="resetConfig">{{ paged ? trans.monitorThemeResetAll : trans.monitorThemeReset }}</button>
        <button type="button" class="monitor-install-button monitor-quiet" :disabled="busy" @click="editing = null">{{ trans.cancel }}</button>
        <button type="submit" form="monitor-config-form" class="monitor-install-button monitor-install-primary" :disabled="busy">{{ busy ? trans.saving : trans.save }}</button>
      </template>
    </AdminDialog>
    <AdminDialog :open="!!confirming" :title="`${trans.monitorThemeRemove} ${themeName(confirming?.short)}？`" size="monitor-confirm" :busy="busy" @close="confirming = null">
      <template #description>{{ removeHint }}</template>
      <template #footer><button type="button" class="monitor-install-button monitor-quiet" :disabled="busy" @click="confirming = null">{{ trans.cancel }}</button><button type="button" class="monitor-install-button monitor-delete" :disabled="busy" @click="remove">{{ trans.delete }}</button></template>
    </AdminDialog>
    <AdminDialog :open="!!zoomed" :title="`${themeName(zoomed?.short)} ${trans.monitorThemePreviewImage}`" size="monitor-image" @close="zoomed = null"><template #description>{{ zoomed?.author }} · {{ zoomed?.version }}</template><template #body><img v-if="zoomed" class="monitor-full-image" :src="images[zoomed.revision]" :alt="themeName(zoomed.short)"></template></AdminDialog>
    <AdminToast :notice="notice" teleport />
  </section>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { adminApi, monitorThemeApi, uploadMonitorThemeRest } from '../../../utils/api'
import AdminDialog from './AdminDialog.vue'
import AdminIcon from './AdminIcon.vue'
import MonitorThemeHelp from './MonitorThemeHelp.vue'
import AdminToast from './AdminToast.vue'
import ToolbarGroupSelect from './ToolbarGroupSelect.vue'
import { monitorConfigForm, monitorConfigValues, monitorConfigOverrides, monitorFieldFits } from '../../../../shared/monitorThemes.js'

const props = defineProps({ trans: { type: Object, required: true }, activeTab: String, selectedApiIndex: Number, requestOwner: Function })
const emit = defineEmits(['frontend-mode'])
const state = ref(null)
const busy = ref(false)
const error = ref('')
const editing = ref(null)
const draft = ref({})
const configBase = ref({})
const currentSection = ref(0)
const notice = ref(null)
const images = ref({})
const zoomed = ref(null)
const updating = ref('')
const installing = ref('')
const confirming = ref(null)
const repository = ref('')
const picker = ref(null)
const iconSaved = ref({ favicon: '', touch_icon: '' })
const iconDraft = ref({ favicon: '', touch_icon: '' })
const form = computed(() => monitorConfigForm(editing.value?.config))
const fields = computed(() => form.value.filter(field => field.type !== 'title'))
const large = computed(() => fields.value.length > 6)
const sections = computed(() => {
  const result = []
  for (const entry of form.value) {
    if (entry.type === 'title') result.push({ label: entry.label, fields: [] })
    else {
      if (!result.length) result.push({ label: props.trans.monitorThemeGeneral, fields: [] })
      result.at(-1).fields.push(entry)
    }
  }
  return result
})
const paged = computed(() => large.value && sections.value.length > 1)
const visibleForm = computed(() => paged.value ? sections.value[currentSection.value]?.fields || [] : form.value)
const notify = (text, type = 'success') => { notice.value = { text, type } }
const safeSource = address => { try { const url = new URL(address); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
let active = true
let generation = 0
const clearImages = () => { images.value = {} }
onBeforeUnmount(() => { active = false; generation++; clearImages() })
const themeName = short => {
  const theme = state.value?.themes.find(theme => theme.short === short)
  return theme?.builtin && short === 'default' ? props.trans.monitorDefaultName : theme?.name || short || ''
}
const previewReason = computed(() => props.trans[state.value?.previewStatus === 401 ? 'monitorPreviewPrivate' : state.value?.previewStatus === 403 ? 'monitorPreviewTurnstile' : 'monitorThemeUnavailable'])
const removeHint = computed(() => {
  const theme = confirming.value
  const key = theme?.short === 'default' || theme?.short === 'serverstatus' ? 'monitorThemeRemoveBuiltin' : state.value?.effective === theme?.short ? 'monitorThemeRemoveCurrent' : 'monitorThemeRemoveOther'
  return props.trans[key]
})
const feedback = (key, theme, version = theme?.version) => props.trans[key].replace('{theme}', themeName(theme?.short)).replace('{version}', version || '')
const rest = (method, path, body, owner, options) => monitorThemeApi(method, path, body, props.selectedApiIndex, owner, options)

const request = async (data, execute, theme) => {
  if (busy.value) return null
  const at = generation
  const owner = () => active && at === generation && (!props.requestOwner || props.requestOwner())
  busy.value = true
  error.value = ''
  try {
    const result = await (execute ? execute(owner) : adminApi(data, props.selectedApiIndex, owner))
    if (!active || at !== generation || result.stale || (props.requestOwner && !props.requestOwner())) return null
    if (result.error) {
      const message = props.trans[result.error] || result.error
      error.value = theme ? `${themeName(theme.short)} ${theme.version}: ${message}` : message
      notify(error.value, 'error')
      return null
    }
    return result.status === 204 ? {} : result.data
  } catch (failure) {
    if (active && at === generation) { error.value = failure.message || props.trans.monitorThemeUnavailable; notify(error.value, 'error') }
    return null
  } finally {
    if (active && at === generation) busy.value = false
  }
}
const load = async () => {
  const hasIconDraft = ['favicon', 'touch_icon'].some(key => iconDraft.value[key] !== iconSaved.value[key])
  const result = await request(null, async owner => {
    const context = await adminApi({ action: 'get_monitor_themes' }, props.selectedApiIndex, owner)
    if (context.error) return context
    const list = await rest('GET', '/themes', null, owner)
    return list.error ? list : { ...list, data: { ...context.data, themes: list.data.themes } }
  })
  if (result) {
    state.value = result; emit('frontend-mode', result.defaultFrontend === true)
    const settings = await request(null, owner => rest('GET', '/settings', null, owner))
    if (settings) {
      iconSaved.value = { favicon: settings.favicon, touch_icon: settings.touch_icon }
      if (!hasIconDraft) iconDraft.value = { ...iconSaved.value }
    }
  }
}
const select = async theme => {
  const result = theme === null ? await request({ action: 'select_monitor_theme', theme }) : await request(null, owner => rest('PUT', '/settings', { theme }, owner))
  if (result) { notify(theme === null ? props.trans.monitorThemeFollowDeployment : feedback('monitorThemeSwitched', state.value.themes.find(item => item.short === theme))); await load() }
}
const preview = async theme => {
  const result = await request({ action: 'start_monitor_theme_preview', theme })
  if (result?.preview_url) window.open(result.preview_url, '_blank', 'noopener,noreferrer')
}
const configure = async theme => {
  const saved = await request(null, owner => rest('GET', `/themes/${encodeURIComponent(theme.short)}/config`, null, owner), theme)
  if (!saved) return
  editing.value = theme
  error.value = ''
  currentSection.value = 0
  configBase.value = saved
  draft.value = monitorConfigValues(monitorConfigForm(theme.config), saved)
}
const resetConfig = () => { configBase.value = {}; draft.value = monitorConfigValues(form.value, {}) }
const saveConfig = async () => {
  const values = Object.fromEntries(fields.value.map(field => [field.key, field.type === 'number' ? draft.value[field.key] === '' ? NaN : Number(draft.value[field.key]) : draft.value[field.key]]))
  const invalid = fields.value.find(field => !monitorFieldFits(field, values[field.key]))
  if (invalid) {
    currentSection.value = Math.max(0, sections.value.findIndex(section => section.fields.includes(invalid)))
    notify(props.trans.monitorThemeInvalidField.replace('{field}', invalid.label || invalid.key), 'error')
    return
  }
  const config = monitorConfigOverrides(form.value, configBase.value, values)
  const theme = editing.value
  const result = await request(null, owner => rest('PUT', `/themes/${encodeURIComponent(theme.short)}/config`, config, owner), theme)
  if (result) { editing.value = null; notify(feedback('monitorThemeSaved', theme)) }
}
const install = async (file = null) => {
  if (busy.value || !state.value?.runtimeStorage || (!file && !repository.value.trim())) return
  if (file?.size > 32 * 1024 * 1024) { error.value = props.trans.monitorThemeArchiveTooLarge; notify(error.value,'error'); return }
  const at = generation
  installing.value = file ? 'upload' : 'github'
  const result = file ? await request(null, owner => uploadMonitorThemeRest(file, props.selectedApiIndex, owner)) : await request(null, owner => rest('POST', '/theme-install', { url: repository.value.trim() }, owner))
  if (active && at === generation) installing.value = ''
  if (result) { if (!file) repository.value = ''; notify(props.trans.monitorThemeInstalled.replace('{theme}', result.theme.name).replace('{version}', result.theme.version)); await load() }
}
const upload = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) install(file)
}
const update = async theme => {
  if (busy.value) return
  const at = generation
  updating.value = theme.short
  const result = await request(null, owner => rest('POST', `/themes/${encodeURIComponent(theme.short)}/update`, {}, owner), theme)
  if (active && at === generation) updating.value = ''
  if (result) { notify(feedback(result.updated ? 'monitorThemeUpdated' : 'monitorThemeLatest', theme, result.version)); if (result.updated) await load() }
}
const remove = async () => {
  const theme = confirming.value
  const result = await request(null, owner => rest('DELETE', `/themes/${encodeURIComponent(theme.short)}`, null, owner), theme)
  if (result) { confirming.value = null; notify(feedback('monitorThemeDeleted', theme)); await load() }
}
const iconFile = async (key, event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const at = generation
  try {
    const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file) })
    const img = new Image()
    img.src = source
    await img.decode()
    const bytes = value => atob(value.slice(value.indexOf(',') + 1)).length
    const draw = (type, quality) => {
      const canvas = document.createElement('canvas')
      const side = key === 'touch_icon' ? 180 : 64
      canvas.width = canvas.height = side
      const ctx = canvas.getContext('2d')
      if (key === 'touch_icon') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, side, side) }
      const width = img.naturalWidth || side, height = img.naturalHeight || side
      const scale = side / Math.max(width, height)
      ctx.drawImage(img, (side - width * scale) / 2, (side - height * scale) / 2, width * scale, height * scale)
      return canvas.toDataURL(type, quality)
    }
    let value = key === 'favicon' && file.type === 'image/svg+xml' && bytes(source) <= 20480 ? source : draw('image/png')
    for (let quality = .9; bytes(value) > 20480 && quality > .3; quality -= .15) value = draw('image/jpeg', quality)
    if (bytes(value) > 20480) throw new Error('icon too large')
    if (active && at === generation) iconDraft.value[key] = value
  } catch {
    if (active && at === generation) notify(props.trans.monitorSiteIconInvalid, 'error')
  }
}
const saveIcons = async () => {
  const values = { ...iconDraft.value }
  const result = await request(null, owner => rest('PUT', '/settings', values, owner))
  if (result) { iconSaved.value = values; notify(props.trans.monitorSiteIconsSaved) }
}
watch(() => state.value?.themes, async themes => {
  const at = generation
  const owner = () => active && at === generation && (!props.requestOwner || props.requestOwner())
  for (const revision of Object.keys(images.value)) if (!themes?.some(theme => theme.revision === revision)) delete images.value[revision]
  for (const theme of themes || []) {
    if (!theme.preview || images.value[theme.revision] || !owner()) continue
    const themeOwner = () => owner() && state.value?.themes.some(current => current.revision === theme.revision)
    const result = await rest('GET', `/themes/${encodeURIComponent(theme.short)}/preview`, null, themeOwner, { responseType: 'blob' })
    if (!themeOwner()) continue
    if (result.data instanceof Blob && result.data.type === 'image/png') {
      // CF's existing image CSP permits data:, not blob:; keep that policy unchanged.
      const image = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(result.data) })
      if (image && themeOwner()) images.value[theme.revision] = image
    }
  }
})
watch(() => props.selectedApiIndex, () => {
  generation++
  state.value = null
  editing.value = null
  zoomed.value = null
  notice.value = null
  updating.value = ''
  clearImages()
  installing.value = ''
  confirming.value = null
  repository.value = ''
  error.value = ''
  busy.value = false
  iconSaved.value = { favicon: '', touch_icon: '' }
  iconDraft.value = { ...iconSaved.value }
  if (props.activeTab === 'themeStore') load()
})
watch(() => props.activeTab, tab => { if (tab === 'themeStore' && !state.value) load() }, { immediate: true })
</script>

<style scoped>
.monitor-theme-manager { margin-bottom: 28px; }
.monitor-install-card { display: flex; flex-direction: column; gap: 16px; padding: 20px; border: 1px solid var(--border-color); border-radius: 14px; background: light-dark(oklch(1 0 0), oklch(.208 .042 265.755)); box-shadow: 0 1px 3px #0000001a, 0 1px 2px #0000001a; }
.monitor-install-heading { display: flex; align-items: center; gap: 6px; }
.monitor-install-heading h4 { margin: 0; font-size: 14px; font-weight: 500; }
.monitor-install-trust { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 16px; }
#monitor-install-form { display: flex; flex-wrap: wrap; gap: 8px; }
#monitor-theme-repository { flex: 1 1 240px; min-width: 0; width: 100%; height: 32px; padding: 4px 12px; border: 1px solid light-dark(var(--border-color), oklch(1 0 0 / 15%)); border-radius: 6px; background: light-dark(transparent, oklch(1 0 0 / 4.5%)); color: var(--text-primary); font-size: 16px; box-shadow: 0 1px 2px #0000000d; transition: color .15s, box-shadow .15s; }
#monitor-theme-repository::placeholder { color: var(--text-secondary); }
.monitor-install-button { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 10px; border: 1px solid var(--border-color); border-radius: 6px; background: light-dark(oklch(1 0 0), oklch(1 0 0 / 4.5%)); color: var(--text-primary); font: inherit; font-size: 14px; font-weight: 500; white-space: nowrap; text-decoration: none; transition: background .15s; }
.monitor-install-button:hover:not(:disabled) { background: var(--bg-hover); }
.monitor-install-primary { background: var(--cf-brand-fill); color: var(--cf-on-brand); border-color: transparent; }
.monitor-install-primary:hover:not(:disabled) { background: color-mix(in oklab, var(--cf-brand-fill) 90%, transparent); }
.monitor-browse { margin: -4px -10px -4px auto; height: 28px; border: 0; background: none; }
#monitor-theme-repository:disabled { opacity: .5; }
@media (min-width: 768px) { #monitor-theme-repository { font-size: 14px; } }
.monitor-note { font-size: 14px; line-height: 1.6; margin: 6px 0 14px; overflow-wrap: anywhere; }
.monitor-theme-list { display: grid; align-items:start; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top:16px; }
.monitor-theme { display:flex;flex-direction:column;gap:16px;padding:20px;border:1px solid var(--border-color);border-radius:14px;background:light-dark(oklch(1 0 0),oklch(.208 .042 265.755));box-shadow:0 1px 3px #0000001a,0 1px 2px #0000001a; }
.monitor-theme-heading {display:flex;align-items:flex-start;gap:12px;}
.monitor-theme-info {min-width:0;flex:1;}
.monitor-theme-name {display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.monitor-theme-name h4 {font-size:16px;line-height:24px;font-weight:500;margin:0;overflow-wrap:anywhere;}
.monitor-badge {display:inline-flex;align-items:center;padding:2px 8px;border:1px solid transparent;border-radius:6px;font-size:12px;line-height:16px;font-weight:500;background:var(--cf-brand-fill);color:var(--cf-on-brand);white-space:nowrap;}
.monitor-badge-secondary,.monitor-use-current {background:var(--cf-soft);color:var(--cf-text);border-color:transparent;}
.monitor-badge-secondary {font-weight:400;}
.monitor-theme-description {margin:4px 0 0;color:var(--text-secondary);font-size:14px;line-height:20px;overflow-wrap:anywhere;}
.monitor-theme-actions {display:flex;flex-shrink:0;gap:4px;align-items:center;}
.monitor-icon-button {display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:6px;background:none;color:var(--text-primary);}
.monitor-icon-button:hover:not(:disabled) {background:var(--bg-hover);}
.monitor-theme-meta {display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:16px;color:var(--text-secondary);}
.monitor-theme-meta a {color:inherit;text-decoration:none;}
.monitor-theme-meta a:hover {text-decoration:underline;}
.monitor-preview-link {flex-shrink:0;border:0;background:none;color:inherit;font:inherit;padding:0;}
.monitor-preview-link:hover {text-decoration:underline;}
.monitor-thumbnail {padding:0;border:0;background:none;cursor:zoom-in;}
.monitor-thumbnail img {display:block;width:100%;aspect-ratio:16/9;object-fit:cover;object-position:top;border:1px solid var(--border-color);border-radius:6px;}
.monitor-thumbnail-placeholder {display:block;width:100%;aspect-ratio:16/9;border:1px solid var(--border-color);border-radius:6px;}
.monitor-full-image {display:block;max-height:80vh;width:100%;object-fit:contain;border:1px solid var(--border-color);border-radius:6px;}
.monitor-cf-actions {display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:16px;font-size:12px;}
.monitor-quiet {border:0;background:none;box-shadow:none;}
.monitor-delete {background:var(--cf-red);border-color:transparent;color:white;}
.monitor-delete:hover:not(:disabled) {background:color-mix(in oklab,var(--cf-red) 90%,transparent);}
.monitor-spin {animation:monitor-spin 1s linear infinite;}
@keyframes monitor-spin {to{transform:rotate(360deg);}}
.monitor-config-heading { margin: 0; padding-top:8px; font-size:14px; font-weight:600; }
.monitor-config-layout {display:flex;min-height:0;flex:1;gap:16px;width:100%;}
.monitor-config-grid {display:grid;align-items:start;align-content:start;gap:16px;min-width:0;flex:1;}
.monitor-config-grid.large {overflow-y:auto;padding-right:4px;}
.monitor-config-nav {display:flex;flex-direction:column;flex-shrink:0;gap:4px;width:192px;overflow-y:auto;}
.monitor-config-nav button {display:flex;align-items:center;gap:8px;padding:6px 12px;background:none;color:var(--text-secondary);border:0;border-radius:6px;text-align:left;}
.monitor-config-nav button[aria-current=true] {background:var(--cf-soft);color:var(--cf-text);font-weight:500;}
.monitor-config-nav button:hover {background:var(--cf-soft);}
.monitor-config-nav i {margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--cf-brand-fill);flex-shrink:0;}
.monitor-config-field {min-width:0;}
.monitor-config-field > label { display: block; margin-bottom: 8px; font-weight:500; }
.monitor-config-field .monitor-field-help {margin:8px 0 0;font-size:12px;line-height:1.625;}
.monitor-config-field :deep(.admin-toolbar-group) {width:100%;}
.monitor-config-field input:not([type=checkbox]), .monitor-config-field textarea, .monitor-config-field select { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; color: var(--text-primary); background: light-dark(transparent, oklch(1 0 0 / 4.5%)); border: 1px solid light-dark(var(--border-color), oklch(1 0 0 / 15%)); border-radius: 6px; box-shadow:0 1px 2px #0000000d; }
.monitor-config-field input:not([type=checkbox]) {height:36px;padding:4px 12px;}
.monitor-config-field textarea { resize: vertical; }
.monitor-config-field.monitor-boolean {border:1px solid var(--border-color);border-radius:8px;padding:10px 12px;background:color-mix(in oklab,var(--cf-soft) 30%,transparent);position:relative;}
.monitor-boolean > label {display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0;font-weight:500;}
.monitor-switch-title {display:block;}
.monitor-switch-help {display:block;margin-top:2px;color:var(--text-secondary);font-size:12px;line-height:16px;font-weight:400;}
.monitor-boolean input[role=switch] {appearance:none;width:32px;height:18px;flex-shrink:0;border:1px solid transparent;border-radius:999px;background:var(--cf-soft);position:relative;cursor:pointer;}
.monitor-boolean input[role=switch]:checked {background:var(--cf-brand-fill);}
.monitor-boolean input[role=switch]::after {content:'';position:absolute;top:0;left:0;width:16px;height:16px;border-radius:50%;background:light-dark(white,oklch(.984 .003 247.858));transition:transform 150ms;}
.monitor-boolean input[role=switch]:checked::after {transform:translateX(14px);background:var(--cf-on-brand);}
.monitor-reset {margin-right:auto;}
@media(min-width:640px){.monitor-config-grid.large{grid-template-columns:repeat(2,minmax(0,1fr));}.monitor-wide,.monitor-config-heading{grid-column:1/-1;}}
@media (max-width: 639px) { .monitor-theme-list { grid-template-columns: 1fr; } .monitor-config-layout {flex-direction:column;} .monitor-config-nav {flex-direction:row;width:auto;overflow-x:auto;margin:0 -4px;padding:0 4px 4px;overflow-y:hidden;} .monitor-config-nav button{white-space:nowrap;} }
</style>
