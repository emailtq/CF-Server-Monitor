<template>
  <AdminDialog :open="show" :title="currentServerName" size="download" @close="$emit('close')">
    <template #body>
      <div class="download-body">
        <section class="download-options">
          <h3>{{ trans.downloadInstallOptions }}</h3>
          <div class="download-option-row">
            <label for="download-os">{{ trans.targetOs }}<small id="download-os-hint" data-os-hint>Unix: OpenWrt / Alpine / Synology DSM / FreeBSD</small></label>
            <select id="download-os" data-target-os aria-describedby="download-os-hint" :value="targetOs" class="form-select" @change="$emit('update:target-os', $event.target.value)">
              <option value="linux">Linux (systemd)</option>
              <option value="unix">Unix</option>
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
              <select id="download-proxy" v-model="selectedGhProxy" class="form-select" :aria-describedby="installGhProxy ? 'download-proxy-hint' : undefined">
                <option v-for="value in ghProxyOptions" :key="value" :value="value">{{ value || trans.ghProxyPlaceholder }}</option>
                <option :value="CUSTOM_GH_PROXY_VALUE">{{ trans.custom || 'Custom' }}</option>
              </select>
              <input v-if="selectedGhProxy === CUSTOM_GH_PROXY_VALUE" :value="installGhProxy" class="form-input" aria-describedby="download-proxy-hint" :aria-label="trans.ghProxy" :placeholder="trans.ghProxyPlaceholder" @input="$emit('update:install-gh-proxy', $event.target.value)">
              <small v-if="installGhProxy" id="download-proxy-hint" data-proxy-hint>{{ installGhProxy }}</small>
            </div>
          </div>
          <div v-if="targetOs !== 'docker'" class="download-option-row download-switch-row">
            <label for="download-auto-update">{{ trans.autoUpdate }}</label>
            <input id="download-auto-update" data-auto-update class="download-switch" type="checkbox" role="switch" :checked="autoUpdate" @change="$emit('update:auto-update', $event.target.checked)">
          </div>
          <div class="download-option-row download-switch-row">
            <label for="download-terminal" data-terminal-label>{{ trans.terminalInstallEnable }}<small>{{ terminalReason || trans.downloadTerminalHint }}</small></label>
            <input id="download-terminal" v-model="terminalSelected" data-terminal-install class="download-switch" type="checkbox" role="switch" :disabled="!terminalSupported || terminalBusy || credentialLoading || mutationPending">
          </div>
          <p v-if="terminalError" data-terminal-error role="alert" class="download-error">{{ trans[terminalError] || trans.terminal_request_failed }}</p>
        </section>
        <section class="download-command">
          <h3>{{ trans.downloadInstallCommand }}</h3>
          <pre class="cmd-output" :class="{'is-placeholder':!installCommand}" :data-install-blocked="!releaseLoading && !release.available ? '' : undefined" :role="!releaseLoading && !release.available ? 'alert' : undefined">{{ installCommand || commandPlaceholder }}</pre>
        </section>
        <div class="download-option-row">
          <div class="download-option-label">{{ trans.downloadReissueTitle }}<small>{{ trans.downloadReissueHint }}</small></div>
          <button ref="reissueButton" class="btn" data-terminal-reissue :disabled="!credentialAllowed || terminalBusy || credentialLoading || mutationPending" @click="confirmReissue = true">{{ reissueStatus === 'pending' ? trans.downloadReissuing : trans.downloadReissue }}</button>
        </div>
        <p v-if="reissueError" data-credential-error role="alert" class="download-error">{{ trans.downloadReissueFailed }}: {{ trans[reissueError] || reissueError }}</p>
        <p v-else-if="reissueStatus === 'pending'" data-credential-status role="status" class="download-status">{{ trans.downloadReissuing }}</p>
      </div>
      <section :key="noticeGeneration" class="download-credential-feedback" aria-label="Notifications alt+T" tabindex="-1" aria-live="polite" aria-relevant="additions text" aria-atomic="false">
        <ol ref="noticeList" class="download-credential-toaster" dir="ltr" tabindex="-1" @focusin="noticeFocus" @focusout="noticeBlur">
          <Transition name="download-notice" :duration="{enter:400,leave:200}">
            <li v-if="credentialNotice" ref="noticeElement" data-credential-notice class="download-credential-notice" :class="{'is-swiping':noticePointer,'is-swipe-out':noticeSwipeOut}" :style="{'--download-swipe':`${noticeSwipe}px`}" tabindex="0" role="status" @mouseenter="expandCredentialNotice" @mousemove="expandCredentialNotice" @mouseleave="!noticePointer && collapseCredentialNotice()" @pointerdown="startNoticeSwipe" @pointermove="moveNoticeSwipe" @pointerup="endNoticeSwipe" @pointercancel="endNoticeSwipe">
              <div data-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" height="20" width="20" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg></div>
              <div data-content><div data-title data-credential-notice-text>{{ trans.downloadReissued }}</div></div>
            </li>
          </Transition>
        </ol>
      </section>
    </template>
    <template #footer>
      <button class="btn" @click="$emit('close')">{{ trans.close }}</button>
      <button class="btn btn-primary" data-copy-command :disabled="!installCommand || releaseLoading || !release.available || terminalBusy || credentialLoading" @click="$emit('copy-cmd')">{{ trans.copy }}</button>
    </template>
  </AdminDialog>
  <AdminDialog :open="show && confirmReissue" :title="`${currentServerName || serverId}: ${trans.downloadReissueTitle}`" description-id="download-reissue-description" size="download-confirm" :busy="terminalBusy" @close="confirmReissue = false">
    <template #body><p id="download-reissue-description" class="download-confirm-text">{{ trans.downloadReissueConfirm }}</p></template>
    <template #footer>
      <button class="btn" :disabled="terminalBusy" @click="confirmReissue = false">{{ trans.cancel }}</button>
      <button class="btn btn-danger" data-confirm-reissue :disabled="terminalBusy" @click="reissueTerminal">{{ terminalBusy ? trans.downloadReissuing : trans.downloadReissue }}</button>
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
  installCommand: {type:String, default:''}
})
const emit = defineEmits(['close','copy-cmd','update:target-os','update:install-mode','update:install-gh-proxy','update:install-version','update:auto-update','terminal-options','install-available'])
const terminalSelected = ref(false)
const terminalToken = ref('')
const permissionEnabled = ref(false)
const terminalError = ref('')
const needsRotation = ref(false)
const credentialLoading = ref(false)
const terminalBusy = ref(false)
const confirmReissue = ref(false)
const reissueError = ref('')
const reissueStatus = ref('')
const credentialNotice = ref(false)
const noticeGeneration = ref(0)
const reissueButton = ref(null)
const noticeElement = ref(null)
const noticeList = ref(null)
const noticePointer = ref(null)
const noticeSwipe = ref(0)
const noticeSwipeOut = ref(false)
const mutationPending = ref(false)
const siteEnabled = ref(false)
const releaseLoading = ref(false)
const release = ref({available:false, terminal:false})
let epoch = 0, credentialSequence = 0
let mutation = null
let noticeTimer = null
let noticeRemaining = 4000, noticeStarted = 0, noticeExpanded = false, noticePreviousFocus = null
const noticeFocus = event => {
  if (!event.currentTarget.contains(event.relatedTarget)) noticePreviousFocus = event.relatedTarget
}
const noticeBlur = event => {
  if (event.currentTarget.contains(event.relatedTarget)) return
  const previous = noticePreviousFocus
  noticePreviousFocus = null
  if (previous?.isConnected && event.currentTarget.closest('.admin-dialog')?.contains(previous)) previous.focus({preventScroll:true})
}
const clearCredentialNotice = () => {
  clearTimeout(noticeTimer)
  noticeTimer = null
  if (noticeElement.value === document.activeElement || noticeList.value === document.activeElement) reissueButton.value?.focus()
  noticePreviousFocus = null
  noticeExpanded = false
  credentialNotice.value = false
}
const pauseCredentialNotice = () => {
  if (noticeTimer) noticeRemaining -= Date.now() - noticeStarted
  clearTimeout(noticeTimer)
  noticeTimer = null
}
const resumeCredentialNotice = () => {
  if (!credentialNotice.value || document.hidden || noticeExpanded || noticePointer.value || noticeTimer) return
  noticeStarted = Date.now()
  noticeTimer = setTimeout(clearCredentialNotice, noticeRemaining)
}
const expandCredentialNotice = () => { noticeExpanded = true; pauseCredentialNotice() }
const collapseCredentialNotice = () => { noticeExpanded = false; resumeCredentialNotice() }
const noticeVisibility = () => document.hidden ? pauseCredentialNotice() : resumeCredentialNotice()
const noticeHotkey = event => {
  const list = noticeList.value
  if (!list || confirmReissue.value || !list.closest('.admin-dialog')?.contains(document.activeElement)) return
  if (event.altKey && event.code === 'KeyT') { expandCredentialNotice(); list.focus({preventScroll:true}) }
  if (event.code === 'Escape' && list.contains(document.activeElement)) {
    // Handle the top-layer toast before the owning dialog's document capture handler.
    event.preventDefault(); event.stopImmediatePropagation(); collapseCredentialNotice()
  }
}
watch(credentialNotice, visible => {
  if (visible) { document.addEventListener('visibilitychange', noticeVisibility); window.addEventListener('keydown', noticeHotkey, true) }
  else { document.removeEventListener('visibilitychange', noticeVisibility); window.removeEventListener('keydown', noticeHotkey, true) }
}, {flush:'sync'})
const startNoticeSwipe = event => {
  if (event.button === 2) return
  event.currentTarget.setPointerCapture(event.pointerId)
  noticePointer.value = {x:event.clientX,y:event.clientY,time:Date.now(),axis:''}
  pauseCredentialNotice()
}
const moveNoticeSwipe = event => {
  const start = noticePointer.value
  if (!start || window.getSelection()?.toString()) return
  const x = event.clientX - start.x, y = event.clientY - start.y
  if (!start.axis && (Math.abs(x) > 1 || Math.abs(y) > 1)) start.axis = Math.abs(x) > Math.abs(y) ? 'x' : 'y'
  noticeSwipe.value = start.axis === 'y' ? y < 0 ? y : y / (1.5 + Math.abs(y) / 20) : 0
}
const endNoticeSwipe = () => {
  const start = noticePointer.value
  noticePointer.value = null
  if (start?.axis === 'y' && noticeSwipe.value < 0 && (-noticeSwipe.value >= 45 || -noticeSwipe.value / (Date.now() - start.time) > .11)) {
    noticeSwipeOut.value = true
    clearCredentialNotice()
  } else { noticeSwipe.value = 0; resumeCredentialNotice() }
}
const terminalReason = computed(() => {
  try { getTerminalBase(props.apiIndex) } catch (error) { return props.trans[error.message] || props.trans.terminal_request_failed }
  if (props.targetOs !== 'linux') return props.trans.terminalInstallPlatformUnsupported
  if (releaseLoading.value) return props.trans.downloadCheckingRelease
  if (!release.value.terminal) return props.trans.downloadTerminalUnavailable
  return ''
})
const terminalSupported = computed(() => !terminalReason.value)
const credentialAllowed = computed(() => {
  try { getTerminalBase(props.apiIndex); return true } catch (_) { return false }
})
const commandPlaceholder = computed(() => reissueStatus.value === 'pending' ? props.trans.downloadReissuing : releaseLoading.value ? props.trans.downloadCheckingRelease : !release.value.available ? props.trans.downloadReleaseUnavailable : terminalError.value ? (props.trans[terminalError.value] || props.trans.terminal_request_failed) : props.trans.downloadReadingToken)
const currentRequest = () => {
  const captured = epoch, owner = props.requestOwner, serverId = props.serverId, apiIndex = props.apiIndex
  return () => captured === epoch && props.show && serverId === props.serverId && apiIndex === props.apiIndex && owner === props.requestOwner && (!owner || owner())
}
const applyCredential = data => {
  if (!data || !/^[a-f0-9]{64}$/.test(data.token) || data.needsRotation) throw new Error('node_token_reset_required')
  terminalToken.value = data.token
  permissionEnabled.value = data.enabled === true
  needsRotation.value = !!data.needsRotation
}
const readCredential = async (waitForMutation = true) => {
  const current = currentRequest(), sequence = ++credentialSequence
  credentialLoading.value = true
  try {
    // Valid credential API indices share one origin, including duplicate site entries.
    if (waitForMutation && credentialAllowed.value && mutation?.serverId === props.serverId) await mutation.done
    if (!current() || sequence !== credentialSequence) return
    const result = await adminApi({action:'node_read_install',serverId:props.serverId}, props.apiIndex, current)
    if (!current() || sequence !== credentialSequence) return
    if (result.error) throw new Error(result.error)
    applyCredential(result.data)
    terminalError.value = ''
  } catch (error) {
    if (current() && sequence === credentialSequence) { terminalToken.value = ''; terminalError.value = error.message; needsRotation.value = error.message === 'node_token_reset_required' }
  } finally { if (current() && sequence === credentialSequence) credentialLoading.value = false }
}
const changeCredential = async reissue => {
  if (terminalBusy.value || mutation || credentialLoading.value || (reissue ? !credentialAllowed.value : !terminalSupported.value)) return
  const current = currentRequest()
  const previousToken = terminalToken.value
  let finish
  mutation = {serverId:props.serverId, done:new Promise(resolve => { finish = resolve })}
  mutationPending.value = true
  ++credentialSequence
  credentialLoading.value = false
  terminalBusy.value = true
  terminalError.value = ''
  if (reissue) { clearCredentialNotice(); noticeGeneration.value++; terminalToken.value = ''; reissueError.value = ''; reissueStatus.value = 'pending' }
  try {
    const result = await adminApi(reissue ? {action:'node_reset_token',serverId:props.serverId} : {action:'terminal_enable_install',serverId:props.serverId,terminal:true,acceptRisk:true}, props.apiIndex, current)
    if (!current()) return
    if (result.error) throw new Error(result.error)
    if (reissue && result.data?.token === previousToken) throw new Error('node_token_reset_required')
    applyCredential(result.data)
    if (!reissue) siteEnabled.value = true
    else {
      reissueStatus.value = ''
      noticeRemaining = 4000
      noticeExpanded = false
      noticePointer.value = null
      noticeSwipe.value = 0
      noticeSwipeOut.value = false
      credentialNotice.value = true
      resumeCredentialNotice()
    }
  } catch (error) {
    if (current()) {
      // Rotation may have succeeded with its reply lost; never retain a retired command.
      if (reissue) { reissueError.value = error.message; reissueStatus.value = '' }
      await readCredential(false)
      if (current() && (!terminalToken.value || (!reissue && (!permissionEnabled.value || !siteEnabled.value)))) terminalError.value = error.message
    }
  } finally {
    mutation = null
    mutationPending.value = false
    finish()
    if (current()) { terminalBusy.value = false; confirmReissue.value = false }
  }
}
const reissueTerminal = () => changeCredential(true)
const clearTerminal = () => {
  epoch++; credentialSequence++
  clearCredentialNotice()
  noticeGeneration.value++
  noticePointer.value = null
  document.removeEventListener('visibilitychange', noticeVisibility)
  window.removeEventListener('keydown', noticeHotkey, true)
  terminalSelected.value = terminalBusy.value = credentialLoading.value = confirmReissue.value = needsRotation.value = false
  permissionEnabled.value = false
  terminalToken.value = terminalError.value = ''
  reissueError.value = reissueStatus.value = ''
  siteEnabled.value = [true,1,'1','true'].includes(props.settings.terminal_enabled)
}
const identity = [() => props.show, () => props.serverId, () => props.apiIndex, () => props.requestOwner]
watch(identity, clearTerminal, {flush:'sync', immediate:true})
watch(identity, () => {
  if (props.show && props.serverId) void readCredential()
}, {immediate:true})
watch([() => props.targetOs, () => props.installVersion], () => { terminalSelected.value = false; confirmReissue.value = false }, {flush:'sync'})
watch(terminalSelected, selected => {
  terminalError.value = ''
  if (!selected) return
  if (needsRotation.value) { terminalError.value = 'node_token_reset_required'; return }
  if (!terminalToken.value || !siteEnabled.value || !permissionEnabled.value) void changeCredential(false)
}, {flush:'sync'})
watch([terminalSelected, terminalToken, terminalBusy, credentialLoading, needsRotation, permissionEnabled, siteEnabled], () => emit('terminal-options', {selected:terminalSelected.value,enabled:terminalSelected.value && siteEnabled.value && permissionEnabled.value && !terminalBusy.value,token:!terminalBusy.value && !credentialLoading.value && !needsRotation.value ? terminalToken.value : ''}), {immediate:true})
watch([() => props.show, () => props.targetOs, () => props.installVersion, () => props.serverId, () => props.apiIndex, () => props.requestOwner], async (_, __, onCleanup) => {
  const controller = new AbortController(), current = currentRequest()
  onCleanup(() => controller.abort())
  release.value = {available:false,terminal:false}
  releaseLoading.value = props.show
  emit('install-available',false)
  if (!props.show) return
  try {
    const value = await checkAgentInstallRelease(props.targetOs,props.installVersion,controller.signal)
    if (controller.signal.aborted || !current()) return
    release.value = value
    emit('install-available',value.available)
  } catch (_) { /* Closing or changing options cancels public metadata lookup. */ }
  finally { if (!controller.signal.aborted && current()) releaseLoading.value = false }
}, {immediate:true})
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
