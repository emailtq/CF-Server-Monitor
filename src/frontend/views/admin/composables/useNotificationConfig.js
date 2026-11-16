import { ref, onBeforeUnmount } from 'vue'
import { adminApi } from '../../../utils/api.js'
export function useNotificationConfig(props) {
  const config = ref(null), busy = ref(false), error = ref(''), result = ref(''), locked = ref(false)
  const eventStatus = ref(null)
  let alive = true, eventRevision = 0
  const owner = () => alive && (!props.requestOwner || props.requestOwner())
  onBeforeUnmount(() => { alive = false; config.value = null })
  const classify = response => response.status === 409 && response.error !== 'notification_channel_referenced' ? 'conflict' : response.error === 'notification_channel_referenced' ? 'referenced' : response.status === 502 ? 'delivery' : response.status === 400 ? 'invalid' : 'unavailable'
  const refreshEvents = async () => {
    const revision = ++eventRevision
    try {
      const response = await adminApi({ action: 'get_login_event_status' }, props.selectedApiIndex, owner)
      if (owner() && revision === eventRevision && !response.stale) eventStatus.value = !response.error && Array.isArray(response.data?.sources) && Array.isArray(response.data?.deliveries) ? response.data : { ...eventStatus.value, error: true }
    } catch (_) { if (owner() && revision === eventRevision) eventStatus.value = { ...eventStatus.value, error: true } }
  }
  const run = async (action, data = {}) => {
    if (busy.value || !owner() || (locked.value && action !== 'get_notification_config')) return false
    busy.value = true; error.value = ''; result.value = ''
    try {
      const response = await adminApi({ action, ...data }, props.selectedApiIndex, owner)
      if (!owner() || response.stale) return false
      if (response.error) { if (action === 'get_notification_config') locked.value = true; error.value = classify(response); return false }
      if (action !== 'test_notification_channel') {
        const dto = response.data
        if (dto?.schema !== 1 || !Number.isSafeInteger(dto.revision) || !Array.isArray(dto.channels) || !Array.isArray(dto.rules)) { locked.value = true; error.value = 'invalid'; return false }
        config.value = dto
        if (dto.rules.some(rule => ['sshLogin','panelLogin','terminalConnected'].includes(rule.type))) void refreshEvents()
        locked.value = false
      }
      result.value = action === 'get_notification_config' ? '' : 'success'
      return true
    } catch (_) { if (owner()) { if (action === 'get_notification_config') locked.value = true; error.value = 'unavailable' } return false }
    finally { if (owner()) busy.value = false }
  }
  const load = () => run('get_notification_config')
  const save = (channels = config.value.channels, rules = config.value.rules) => run('save_notification_config', { expectedRevision: config.value.revision, channels, rules, timezone: config.value.timezone, language: config.value.language })
  const test = channel => run('test_notification_channel', { channel })
  return { config, busy, locked, error, result, load, save, test, eventStatus }
}
