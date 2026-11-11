<template>
  <AdminDialog :open="show" :title="currentServerName" size="download" @close="$emit('close')">
    <template #body>
      <div class="download-body">
        <section class="download-options">
          <h3>{{ trans.downloadInstallOptions }}</h3>
          <div class="download-option-row">
            <label for="download-os">{{ trans.targetOs }}</label>
            <select id="download-os" data-target-os :value="targetOs" class="form-select" @change="$emit('update:target-os', $event.target.value)">
              <option value="linux">Linux (systemd)</option>
              <option value="unix">OpenWrt/Alpine/Synology DSM/FreeBSD</option>
              <option value="mac">macOS</option>
              <option value="windows">Windows</option>
              <option value="docker">Docker</option>
            </select>
          </div>
          <div class="download-option-row">
            <label for="download-version">Agent {{ trans.version }}<small>{{ targetOs === 'docker' ? trans.dockerVersionTip : trans.installVersionTip }}</small></label>
            <input id="download-version" data-install-version :value="installVersion" class="form-input" placeholder="latest" @input="$emit('update:install-version', $event.target.value)">
          </div>
          <div v-if="targetOs === 'linux'" class="download-option-row">
            <label for="download-mode">{{ trans.installMode }}<small>{{ trans.nonRootInstallTip }}</small></label>
            <select id="download-mode" data-install-mode :value="installMode" class="form-select" @change="$emit('update:install-mode', $event.target.value)">
              <option value="current-user">{{ trans.installModeCurrentUser }}</option>
              <option value="cfsm-user">{{ trans.installModeCfsmUser }}</option>
            </select>
          </div>
          <div v-if="targetOs !== 'docker'" class="download-option-row">
            <label for="download-proxy">{{ trans.ghProxy }}</label>
            <div class="download-option-control">
              <select id="download-proxy" v-model="selectedGhProxy" class="form-select">
                <option v-for="value in ghProxyOptions" :key="value" :value="value">{{ value || trans.ghProxyPlaceholder }}</option>
                <option :value="CUSTOM_GH_PROXY_VALUE">{{ trans.custom || 'Custom' }}</option>
              </select>
              <input v-if="selectedGhProxy === CUSTOM_GH_PROXY_VALUE" :value="installGhProxy" class="form-input" :aria-label="trans.ghProxy" :placeholder="trans.ghProxyPlaceholder" @input="$emit('update:install-gh-proxy', $event.target.value)">
            </div>
          </div>
          <div v-if="targetOs !== 'docker'" class="download-option-row">
            <label for="download-auto-update">{{ trans.autoUpdate }}</label>
            <input id="download-auto-update" data-auto-update class="download-switch" type="checkbox" role="switch" :checked="autoUpdate" @change="$emit('update:auto-update', $event.target.checked)">
          </div>
          <div class="download-option-row">
            <label for="download-terminal" data-terminal-label>{{ trans.terminalInstallEnable }}<small>{{ terminalReason || trans.downloadTerminalHint }}</small></label>
            <input id="download-terminal" v-model="terminalSelected" data-terminal-install class="download-switch" type="checkbox" role="switch" :disabled="!terminalSupported || terminalBusy">
          </div>
          <p v-if="terminalError" data-terminal-error role="alert" class="download-error">{{ trans[terminalError] || trans.terminal_request_failed }}</p>
        </section>
        <section class="download-command">
          <h3>{{ trans.downloadInstallCommand }}</h3>
          <pre class="cmd-output" :class="{'is-placeholder':!installCommand}" :data-install-blocked="!releaseLoading && !release.available ? '' : undefined" :role="!releaseLoading && !release.available ? 'alert' : undefined">{{ installCommand || commandPlaceholder }}</pre>
        </section>
        <div class="download-option-row">
          <div class="download-option-label">{{ trans.downloadReissueTitle }}<small>{{ trans.downloadReissueHint }}</small></div>
          <button class="btn" data-terminal-reissue :disabled="!terminalSupported || terminalBusy || credentialLoading" @click="confirmReissue = true">{{ trans.downloadReissue }}</button>
        </div>
      </div>
    </template>
    <template #footer>
      <button class="btn" @click="$emit('close')">{{ trans.close }}</button>
      <button class="btn" data-edit-install @click="$emit('open-edit-from-copy')">{{ trans.edit }}</button>
      <button class="btn btn-primary" data-copy-command :disabled="!installCommand || releaseLoading || !release.available || terminalBusy" @click="$emit('copy-cmd')">{{ copiedCmd ? trans.copied : trans.downloadCopyCommand }}</button>
    </template>
  </AdminDialog>
  <AdminDialog :open="show && confirmReissue" :title="trans.downloadReissueTitle" size="download-confirm" :busy="terminalBusy" @close="confirmReissue = false">
    <template #body><p class="download-confirm-text">{{ trans.downloadReissueConfirm }}</p></template>
    <template #footer>
      <button class="btn" :disabled="terminalBusy" @click="confirmReissue = false">{{ trans.cancel }}</button>
      <button class="btn btn-primary" data-confirm-reissue :disabled="terminalBusy" @click="reissueTerminal">{{ trans.downloadReissue }}</button>
    </template>
  </AdminDialog>
</template>

<script setup>
import AdminDialog from './AdminDialog.vue'
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { adminApi, getTerminalBase } from '../../../utils/api.js'
import { checkAgentInstallRelease } from '../../../utils/agentInstallRelease.js'
import '../../../styles/admin-download.css'

const props = defineProps({
  trans: {type:Object, required:true},
  settings: {type:Object, default:() => ({})},
  show: {type:Boolean, default:false},
  serverId: {type:String, default:''},
  apiIndex: {type:Number, default:0},
  requestOwner: {type:Function, default:undefined},
  currentServerName: {type:String, default:''},
  targetOs: {type:String, default:'linux'},
  installMode: {type:String, default:'current-user'},
  installGhProxy: {type:String, default:''},
  installVersion: {type:String, default:''},
  autoUpdate: {type:Boolean, default:false},
  installCommand: {type:String, default:''},
  copiedCmd: {type:Boolean, default:false}
})
const emit = defineEmits(['close','copy-cmd','open-edit-from-copy','update:target-os','update:install-mode','update:install-gh-proxy','update:install-version','update:auto-update','terminal-options','install-available'])
const terminalSelected = ref(false)
const terminalToken = ref('')
const terminalError = ref('')
const needsRotation = ref(false)
const credentialLoading = ref(false)
const terminalBusy = ref(false)
const confirmReissue = ref(false)
const siteEnabled = ref(false)
const releaseLoading = ref(false)
const release = ref({available:false, terminal:false})
let epoch = 0, credentialSequence = 0
const terminalReason = computed(() => {
  try { getTerminalBase(props.apiIndex) } catch (error) { return props.trans[error.message] || props.trans.terminal_request_failed }
  if (props.settings.theme_url) return props.trans.terminal_custom_frontend
  if (props.targetOs !== 'linux') return props.trans.terminalInstallPlatformUnsupported
  if (releaseLoading.value) return props.trans.downloadCheckingRelease
  if (!release.value.terminal) return props.trans.downloadTerminalUnavailable
  return ''
})
const terminalSupported = computed(() => !terminalReason.value)
const commandPlaceholder = computed(() => releaseLoading.value ? props.trans.downloadCheckingRelease : !release.value.available ? props.trans.downloadReleaseUnavailable : terminalError.value ? (props.trans[terminalError.value] || props.trans.terminal_request_failed) : props.trans.downloadReadingToken)
const currentRequest = () => {
  const captured = epoch, owner = props.requestOwner
  return () => captured === epoch && props.show && (!owner || owner())
}
const applyCredential = data => {
  if (!data || (data.token && !/^[a-f0-9]{64}$/.test(data.token))) throw new Error('terminal_request_failed')
  terminalToken.value = data.token || ''
  needsRotation.value = !!data.needsRotation
}
const readCredential = async () => {
  const current = currentRequest(), sequence = ++credentialSequence
  credentialLoading.value = true
  try {
    const result = await adminApi({action:'terminal_read_install',serverId:props.serverId}, props.apiIndex, current)
    if (!current() || sequence !== credentialSequence) return
    if (result.error) throw new Error(result.error)
    applyCredential(result.data)
    terminalError.value = needsRotation.value && terminalSelected.value ? 'terminal_install_reissue_required' : ''
  } catch (error) {
    if (current() && sequence === credentialSequence) { terminalToken.value = ''; terminalError.value = error.message }
  } finally { if (current() && sequence === credentialSequence) credentialLoading.value = false }
}
const changeCredential = async reissue => {
  if (terminalBusy.value || !terminalSupported.value) return
  const current = currentRequest()
  ++credentialSequence
  credentialLoading.value = false
  terminalBusy.value = true
  terminalError.value = ''
  if (reissue) terminalToken.value = ''
  try {
    const result = await adminApi({action:reissue ? 'terminal_prepare_install' : 'terminal_enable_install',serverId:props.serverId,terminal:true,acceptRisk:true}, props.apiIndex, current)
    if (!current()) return
    if (result.error) throw new Error(result.error)
    applyCredential(result.data)
    siteEnabled.value = true
  } catch (error) {
    if (current()) {
      // Rotation may have succeeded with its reply lost; never retain a retired command.
      await readCredential()
      if (current() && !terminalToken.value) terminalError.value = error.message
    }
  } finally { if (current()) { terminalBusy.value = false; confirmReissue.value = false } }
}
const reissueTerminal = () => changeCredential(true)
const clearTerminal = () => {
  epoch++; credentialSequence++
  terminalSelected.value = terminalBusy.value = credentialLoading.value = confirmReissue.value = needsRotation.value = false
  terminalToken.value = terminalError.value = ''
  siteEnabled.value = [true,1,'1','true'].includes(props.settings.terminal_enabled)
}
watch([() => props.show, () => props.serverId, () => props.apiIndex, () => props.trans, () => props.settings.theme_url, () => props.requestOwner], () => {
  clearTerminal()
  if (props.show && props.serverId) void readCredential()
}, {flush:'sync', immediate:true})
watch([() => props.targetOs, () => props.installVersion], () => { terminalSelected.value = false; confirmReissue.value = false }, {flush:'sync'})
watch(terminalSelected, selected => {
  terminalError.value = ''
  if (!selected) return
  if (needsRotation.value) { terminalError.value = 'terminal_install_reissue_required'; return }
  if (!terminalToken.value || !siteEnabled.value) void changeCredential(false)
}, {flush:'sync'})
watch([terminalSelected, terminalToken, terminalBusy, credentialLoading, needsRotation], () => emit('terminal-options', {selected:terminalSelected.value,enabled:terminalSelected.value && !!terminalToken.value && !terminalBusy.value && !credentialLoading.value && !needsRotation.value,token:terminalToken.value}), {flush:'sync', immediate:true})
watch([() => props.show, () => props.targetOs, () => props.installVersion, () => props.serverId, () => props.apiIndex, () => props.trans, () => props.settings.theme_url, () => props.requestOwner], async (_, __, onCleanup) => {
  const controller = new AbortController(), current = currentRequest()
  onCleanup(() => controller.abort())
  release.value = {available:false,terminal:false}
  releaseLoading.value = props.show
  emit('install-available',false)
  if (!props.show) return
  try {
    const value = await checkAgentInstallRelease(props.targetOs,props.installVersion,controller.signal,fetch,async tag => {
      const result = await adminApi({action:'agent_install_image',tag},props.apiIndex,current)
      return result.data
    })
    if (controller.signal.aborted || !current()) return
    release.value = value
    emit('install-available',value.available)
  } catch (_) { /* Closing or changing options cancels public metadata lookup. */ }
  finally { if (!controller.signal.aborted && current()) releaseLoading.value = false }
}, {flush:'sync', immediate:true})
onBeforeUnmount(clearTerminal)

const CUSTOM_GH_PROXY_VALUE = '__custom__'
const ghProxyOptions = ['', 'https://ghfast.top/','https://ghproxy.net/','https://gh.llkk.cc/','https://gh-proxy.com/']
const manualCustomGhProxy = ref(false)
const selectedGhProxy = computed({
  get: () => manualCustomGhProxy.value || !ghProxyOptions.includes(props.installGhProxy) ? CUSTOM_GH_PROXY_VALUE : props.installGhProxy,
  set: value => {
    manualCustomGhProxy.value = value === CUSTOM_GH_PROXY_VALUE
    emit('update:install-gh-proxy',manualCustomGhProxy.value ? '' : value)
  }
})
watch(() => props.show, () => { manualCustomGhProxy.value = false })
</script>
