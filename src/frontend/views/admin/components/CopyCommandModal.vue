<template>
  <AdminDialog :open="show" :title="currentServerName" size="edit" :busy="terminalBusy" @close="$emit('close')">
    <template #body>
      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.targetOs }}</label>
          <select :value="targetOs" class="form-select" :disabled="terminalBusy" @change="$emit('update:target-os', $event.target.value)">
            <option value="linux">Linux (systemd)</option>
            <option value="unix">OpenWrt/Alpine/Synology DSM/FreeBSD</option>
            <option value="mac">macOS</option>
            <option value="windows">Windows</option>
            <option value="docker">Docker</option>
          </select>
        </div>

        <div class="form-group flex-1">
          <label class="form-label">
            Agent {{ trans.version }}
            <HelpTooltip :text="targetOs === 'docker' ? trans.dockerVersionTip : trans.installVersionTip" />
          </label>
          <input
            type="text"
            :value="installVersion"
            class="form-input"
            :placeholder="targetOs === 'docker' ? 'latest' : trans.installVersionPlaceholder"
            :disabled="terminalBusy"
            @input="$emit('update:install-version', $event.target.value)"
          >
        </div>
      </div>

      <div v-if="targetOs !== 'docker'" class="form-row">
        <div v-if="targetOs === 'linux'" class="form-group flex-1">
          <label class="form-label">
            {{ trans.installMode }}
            <HelpTooltip :text="trans.nonRootInstallTip" />
          </label>
          <select :value="installMode" class="form-select" :disabled="terminalBusy" @change="$emit('update:install-mode', $event.target.value)">
            <option value="current-user">{{ trans.installModeCurrentUser }}</option>
            <option value="cfsm-user">{{ trans.installModeCfsmUser }}</option>
          </select>
        </div>

        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.ghProxy }}
            <HelpTooltip :text="trans.ghProxyTip" />
          </label>
          <select v-model="selectedGhProxy" class="form-select" :disabled="terminalBusy">
            <option v-for="option in ghProxyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            <option :value="CUSTOM_GH_PROXY_VALUE">{{ trans.custom || 'Custom' }}</option>
          </select>
          <input
            v-if="showCustomGhProxy"
            type="text"
            :value="installGhProxy"
            class="form-input mt-2"
            :placeholder="trans.ghProxyPlaceholder"
            :disabled="terminalBusy"
            @input="$emit('update:install-gh-proxy', $event.target.value)"
          >
        </div>
      </div>

      <div class="config-list">
        <div class="config-row">
          <span class="config-label">{{ trans.collectInterval }}</span>
          <span class="config-value">{{ formatWithUnit(collectInterval, 's') }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.reportInterval }}</span>
          <span class="config-value">{{ formatWithUnit(reportInterval, 's') }}</span>
        </div>
        <div v-if="connectionMode === 'auto'" class="config-row">
          <span class="config-label">{{ trans.wssReportInterval }}</span>
          <span class="config-value">{{ formatWithUnit(wssReportInterval, 's') }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.connectionMode }}</span>
          <span class="config-value">{{ connectionMode === 'http' ? trans.connectionModeHttp : trans.connectionModeAuto }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.pingMode }}</span>
          <span class="config-value">{{ effectivePingMode === 'icmp' ? 'ICMP (root)' : 'TCP' }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.trafficResetDay }}</span>
          <span class="config-value">{{ isBlank(resetDay) ? '-' : resetDay }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.autoUpdate }}</span>
          <span class="config-value">
            <span :class="['config-badge', autoUpdate ? 'is-enabled' : 'is-disabled']">
              {{ autoUpdate ? trans.enabled : trans.disabled }}
            </span>
          </span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.networkInterface }}</span>
          <span class="config-value">{{ isBlank(networkInterface) ? '-' : networkInterface }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.rxCorrection }} (GB)</span>
          <span class="config-value">{{ formatWithUnit(rxCorrection, 'GB') }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ trans.txCorrection }} (GB)</span>
          <span class="config-value">{{ formatWithUnit(txCorrection, 'GB') }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ settings.custom_ct_name || trans.customCt }}</span>
          <span class="config-value">{{ isBlank(customCt) ? '-' : customCt }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ settings.custom_cu_name || trans.customCu }}</span>
          <span class="config-value">{{ isBlank(customCu) ? '-' : customCu }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ settings.custom_cm_name || trans.customCm }}</span>
          <span class="config-value">{{ isBlank(customCm) ? '-' : customCm }}</span>
        </div>
        <div class="config-row">
          <span class="config-label">{{ settings.custom_bd_name || trans.customBd }}</span>
          <span class="config-value">{{ isBlank(customBd) ? '-' : customBd }}</span>
        </div>
        <div v-for="(node, index) in [node1, node2, node3, node4]" :key="index" class="config-row">
          <span class="config-label">{{ settings[`node_${index + 1}_name`] || `Node ${index + 1}` }}</span><span class="config-value">{{ isBlank(node) ? '-' : node }}</span>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" data-terminal-label><input v-model="terminalSelected" type="checkbox" data-terminal-install :disabled="!terminalSupported || terminalBusy"> {{ trans.terminalInstallEnable }}</label>
        <p v-if="!terminalSupported" class="text-secondary">{{ terminalReason }}</p>
        <p v-if="installBlocked" data-install-blocked role="alert" class="danger-box">{{ trans.terminalInstallOffUnverified }}</p>
        <template v-if="terminalSelected">
          <p class="danger-box">{{ trans.terminalRisk }}</p>
          <p class="text-secondary">{{ trans.terminalInstallSiteConsent }}</p>
          <p class="text-secondary">{{ trans.terminalRotationWarning }}</p>
          <template v-if="!terminalToken">
            <label class="form-label"><input v-model="terminalRisk" type="checkbox" data-terminal-risk :disabled="terminalBusy"> {{ trans.terminalAcceptRisk }}</label>
            <button class="btn btn-primary" data-terminal-prepare :disabled="terminalBusy || !terminalRisk" @click="prepareTerminal">{{ trans.terminalInstallPrepare }}</button>
          </template>
          <template v-else>
            <p>{{ trans.terminalTokenOnce }}</p>
            <label for="terminal-install-token" class="form-label">{{ trans.terminalNodeToken }}</label>
            <div class="form-row">
              <input id="terminal-install-token" :value="terminalToken" :type="getInputType('token')" readonly class="form-input flex-1" autocomplete="off" spellcheck="false">
              <button class="btn" :aria-pressed="visibility.token" @click="toggle('token')">{{ trans.terminalShowSecret }}</button>
              <button class="btn" @click="copyTerminalToken">{{ terminalCopied ? trans.copied : trans.copy }}</button>
            </div>
            <p class="text-secondary">{{ trans.terminalInstallTwoSteps }}</p>
            <p class="text-secondary">{{ installMode === 'cfsm-user' ? trans.terminalInstallDedicatedFile : trans.terminalTokenFile }}</p>
            <p class="text-secondary">{{ trans.terminalInstallClipboard }}</p>
            <label for="terminal-install-path" class="form-label">{{ trans.terminalInstallPath }}</label>
            <input id="terminal-install-path" v-model="terminalPath" data-terminal-path class="form-input" autocomplete="off" spellcheck="false" placeholder="/absolute/owner-only/terminal-token" :aria-invalid="!validTerminalPath">
            <p v-if="!validTerminalPath" class="text-secondary">{{ trans.terminalInstallPathInvalid }}</p>
          </template>
          <p v-if="terminalError" role="alert" class="danger-box">{{ trans[terminalError] || trans.terminalRequestFailed }}</p>
        </template>
      </div>

      <div class="form-group">
        <div class="cmd-output-wrapper" :class="{ copied: copiedCmd }">
          <span class="cmd-prompt">{{ targetOs === 'windows' ? 'PS' : '$' }}</span>
          <pre class="cmd-output">{{ installCommand }}</pre>
        </div>
      </div>
    </template>
    <template #footer>
      <button @click="$emit('close')" class="btn" :disabled="terminalBusy">{{ trans.cancel }}</button>
      <button @click="$emit('open-edit-from-copy')" class="btn" :disabled="terminalBusy">{{ trans.edit }}</button>
      <button @click="$emit('copy-cmd')" data-copy-command class="btn btn-primary" :disabled="terminalBusy || !installCommand">{{ copiedCmd ? trans.copied : trans.copy }}</button>
    </template>
  </AdminDialog>
</template>

<script setup>
import AdminDialog from './AdminDialog.vue'
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import HelpTooltip from './AdminHelp.vue'
import { adminApi, getTerminalBase } from '../../../utils/api.js'
import { copyTextToClipboard } from '../../../utils/clipboard.js'
import { usePasswordVisibility } from '../../../composables/usePasswordVisibility.js'

const props = defineProps({
  trans: { type: Object, required: true },
  settings: { type: Object, default: () => ({}) },
  show: { type: Boolean, default: false },
  serverId: { type: String, default: '' },
  apiIndex: { type: Number, default: 0 },
  requestOwner: { type: Function, default: undefined },
  currentServerName: { type: String, default: '' },
  targetOs: { type: String, default: 'linux' },
  installMode: { type: String, default: 'current-user' },
  installGhProxy: { type: String, default: '' },
  installVersion: { type: String, default: '' },
  installBlocked: { type: Boolean, default: false },
  collectInterval: { type: [Number, String], default: 0 },
  reportInterval: { type: [Number, String], default: 60 },
  wssReportInterval: { type: [Number, String], default: 2 },
  connectionMode: { type: String, default: 'auto' },
  pingMode: { type: String, default: 'tcp' },
  customCt: { type: String, default: '' },
  customCu: { type: String, default: '' },
  customCm: { type: String, default: '' },
  customBd: { type: String, default: '' },
  node1: { type: String, default: '' }, node2: { type: String, default: '' }, node3: { type: String, default: '' }, node4: { type: String, default: '' },
  networkInterface: { type: String, default: '' },
  resetDay: { type: [Number, String], default: 1 },
  rxCorrection: { type: [Number, String], default: '' },
  txCorrection: { type: [Number, String], default: '' },
  autoUpdate: { type: Boolean, default: false },
  installCommand: { type: String, default: '' },
  copiedCmd: { type: Boolean, default: false }
})

const emit = defineEmits([
  'close',
  'copy-cmd',
  'open-edit-from-copy',
  'update:target-os',
  'update:install-mode',
  'update:install-gh-proxy',
  'update:install-version',
  'terminal-options'
])

const terminalSelected = ref(false)
const terminalRisk = ref(false)
const terminalToken = ref('')
const terminalPath = ref('')
const terminalBusy = ref(false)
const terminalError = ref('')
const terminalCopied = ref(false)
const { visibility, toggle, getInputType, reset } = usePasswordVisibility(['token'])
let terminalEpoch = 0
const terminalReason = computed(() => {
  try { getTerminalBase(props.apiIndex) } catch (error) { return props.trans[error.message] || props.trans.terminalRequestFailed }
  if (props.settings.theme_url) return props.trans.terminal_custom_frontend
  if (props.targetOs !== 'linux') return props.trans.terminalInstallPlatformUnsupported
  if (props.installVersion.trim() && props.installVersion.trim() !== 'latest') return props.trans.terminalInstallVersionUnverified
  return ''
})
const terminalSupported = computed(() => !terminalReason.value)
const validTerminalPath = computed(() => /^\/(?!\/)(?:[A-Za-z0-9_. -]+\/)*[A-Za-z0-9_. -]+$/.test(terminalPath.value) && !terminalPath.value.split('/').some(part => part === '.' || part === '..'))
const clearTerminal = () => {
  terminalEpoch++
  terminalSelected.value = terminalRisk.value = terminalBusy.value = terminalCopied.value = false
  terminalToken.value = terminalPath.value = terminalError.value = ''
  reset()
}
watch([() => props.show, () => props.serverId, () => props.apiIndex, () => props.trans, () => props.targetOs, () => props.installMode, () => props.installVersion, () => props.installGhProxy, () => props.settings.theme_url, () => props.requestOwner], clearTerminal, {flush:'sync'})
watch(terminalSelected, value => { if (!value) { terminalEpoch++; terminalToken.value = terminalPath.value = terminalError.value = ''; terminalRisk.value = terminalCopied.value = false; reset() } }, {flush:'sync'})
watch([terminalSelected, terminalToken, terminalPath], () => emit('terminal-options', {selected:terminalSelected.value, enabled:terminalSelected.value && !!terminalToken.value && validTerminalPath.value, tokenFile:terminalPath.value}), {flush:'sync'})
const prepareTerminal = async () => {
  if (terminalBusy.value || terminalToken.value || !terminalSelected.value || !terminalRisk.value || !terminalSupported.value) return
  const epoch = terminalEpoch, owner = props.requestOwner
  const current = () => epoch === terminalEpoch && props.show && (!owner || owner())
  terminalBusy.value = true
  terminalError.value = ''
  try {
    const result = await adminApi({action:'terminal_prepare_install',serverId:props.serverId,terminal:true,acceptRisk:true}, props.apiIndex, current)
    if (!current()) return
    if (result.error) { terminalError.value = result.error; return }
    if (!/^[a-f0-9]{64}$/.test(result.data?.token || '')) { terminalError.value = 'terminal_request_failed'; return }
    terminalToken.value = result.data.token
  } catch (_) { if (current()) terminalError.value = 'terminal_request_failed' }
  finally { if (current()) { terminalBusy.value = false; reset() } }
}
const copyTerminalToken = async () => {
  const epoch = terminalEpoch
  const copied = await copyTextToClipboard(terminalToken.value)
  if (epoch === terminalEpoch) terminalCopied.value = copied
}
onBeforeUnmount(clearTerminal)

const CUSTOM_GH_PROXY_VALUE = '__custom__'
const ghProxyOptions = [
  { value: '', label: props.trans.ghProxyPlaceholder || 'Direct' },
  { value: 'https://ghfast.top/', label: 'https://ghfast.top/' },
  { value: 'https://ghproxy.net/', label: 'https://ghproxy.net/' },
  { value: 'https://gh.llkk.cc/', label: 'https://gh.llkk.cc/' },
  { value: 'https://gh-proxy.com/', label: 'https://gh-proxy.com/' }
]

const manualCustomGhProxy = ref(false)
const isKnownGhProxy = (value) => ghProxyOptions.some(option => option.value === String(value || '').trim())

const selectedGhProxy = computed({
  get: () => {
    const currentProxy = String(props.installGhProxy || '').trim()
    if (manualCustomGhProxy.value || (!isKnownGhProxy(currentProxy) && currentProxy)) {
      return CUSTOM_GH_PROXY_VALUE
    }
    return currentProxy
  },
  set: (value) => {
    if (value === CUSTOM_GH_PROXY_VALUE) {
      manualCustomGhProxy.value = true
      if (isKnownGhProxy(props.installGhProxy)) {
        emit('update:install-gh-proxy', '')
      }
      return
    }
    manualCustomGhProxy.value = false
    emit('update:install-gh-proxy', value)
  }
})

const showCustomGhProxy = computed(() => selectedGhProxy.value === CUSTOM_GH_PROXY_VALUE)
const effectivePingMode = computed(() => (
  props.targetOs === 'linux' && props.installMode === 'cfsm-user'
    ? 'tcp'
    : (props.pingMode === 'icmp' ? 'icmp' : 'tcp')
))

watch(
  () => props.show,
  (show) => {
    if (show && isKnownGhProxy(props.installGhProxy)) {
      manualCustomGhProxy.value = false
    }
  }
)

const isBlank = (value) => value === '' || value === null || value === undefined
const formatWithUnit = (value, unit) => (isBlank(value) ? '-' : `${value} ${unit}`)
</script>
