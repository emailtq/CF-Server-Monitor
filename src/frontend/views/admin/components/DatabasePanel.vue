<template>
  <div id="tab-database" class="tab-content" :class="{ active: activeTab === 'database' }">
    <div class="settings-section">
      <div class="section-title">{{ trans.dbManagement }}</div>

      <div class="settings-grid">
        <div class="form-group">
          <button @click="$emit('open-db-modal', 'upgrade')" class="btn btn-primary btn-lg" :disabled="dbLoading"> {{ trans.upgradeDatabase }}</button>
          <p class="text-muted text-sm mt-2">{{ trans.upgradeDesc }}</p>
        </div>

        <div class="form-group">
          <button @click="$emit('open-db-modal', 'clearHistory')" class="btn btn-red btn-lg" :disabled="dbLoading"> {{ trans.clearHistory }}</button>
          <p class="text-muted text-sm mt-2">{{ trans.clearHistoryDesc }}</p>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-title">{{ trans.exportServers }} / {{ trans.importServers }}</div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="admin-check-target" for="include-notification-secrets"><input id="include-notification-secrets" v-model="includeNotificationSecrets" type="checkbox" :disabled="exporting || importing"><span>{{ trans.adminIncludeNotificationSecrets }}</span></label>
          <p class="text-muted text-sm">{{ trans.adminBackupWarning }}</p>
          <button @click="requestExport" class="btn btn-primary btn-lg" :disabled="dbLoading || exporting || importing">
            <AdminIcon name="download" />{{ exporting ? trans.exporting : ' ' + trans.exportServers }}
          </button>
          <p v-if="exportNotice" class="text-sm mt-2" :style="{ color: exportNotice.success ? 'var(--accent-green)' : 'var(--accent-red)' }">
            {{ exportNotice.text }}
          </p>
          <p v-if="exportNotice?.warning" class="warning-box" role="status">{{ trans.adminSensitiveBackupWarning }} ({{ exportNotice.warning }})</p>
        </div>

        <div class="form-group">
          <input
            ref="fileInput"
            type="file"
            accept=".json"
            style="display: none"
            @change="handleFileSelect"
          />
          <button @click="$refs.fileInput.click()" class="btn btn-lg" :disabled="dbLoading || importing || exporting">
            <AdminIcon name="upload" />{{ importing ? trans.importing : ' ' + trans.importServers }}
          </button>
        </div>
      </div>

      <div v-if="importResult" class="mt-3">
        <div :class="importResult.success ? 'warning-box' : 'danger-box'" class="mb-2">
          <div class="flex-center-gap-sm">
            <span :style="{ color: importResult.success ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: '600' }">
              {{ trans.importResult }}
            </span>
          </div>
          <div class="mt-2 text-sm">
            <span style="color: var(--accent-green)">{{ trans.importedCount }}: {{ importResult.imported }}</span>
            <span class="ml-3" style="color: var(--accent-yellow)">{{ trans.skippedCount }}: {{ importResult.skipped }}</span>
          </div>
          <div v-if="importResult.skippedIds && importResult.skippedIds.length > 0" class="mt-2 text-sm text-muted">
            {{ trans.skippedIds }}: {{ importResult.skippedIds.join(', ') }}
          </div>
          <p v-if="importResult.error" class="text-red" role="alert">{{ importResult.error }}</p>
          <div v-if="importResult.notification?.unresolvedRuleIds?.length" class="warning-box" role="alert">
            <p>{{ trans.adminUnresolvedRules }}: {{ importResult.notification.unresolvedRuleIds.join(', ') }}</p>
            <p v-for="reference in importResult.notification.unresolvedReferences || []" :key="reference.ruleId">{{ reference.ruleId }}: {{ reference.serverIds.join(', ') }}</p>
            <p>{{ trans.adminRepairReferences }}</p>
          </div>
          <p v-if="importResult.ignoredFields?.length" class="text-muted">{{ trans.adminIgnoredFields }}: {{ importResult.ignoredFields.join(', ') }}</p>
          <button v-if="importResult.reloadNeeded" class="btn btn-primary" @click="acknowledgeReload">{{ trans.adminAcknowledgeReload }}</button>
        </div>
      </div>
    </div>
    <AdminDialog :open="showSensitiveConfirm" :title="trans.adminSensitiveBackupTitle" :busy="exporting" @close="showSensitiveConfirm = false">
      <template #body><p class="danger-box">{{ trans.adminSensitiveBackupWarning }}</p><p>{{ trans.adminBackupWarning }}</p><p v-if="exportNotice && !exportNotice.success" class="text-red" role="alert">{{ exportNotice.text }}</p></template>
      <template #footer><button class="btn" :disabled="exporting" @click="showSensitiveConfirm = false">{{ trans.cancel }}</button><button class="btn btn-primary" :disabled="exporting" @click="handleExport(true)">{{ trans.adminConfirmSensitiveExport }}</button></template>
    </AdminDialog>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import AdminDialog from './AdminDialog.vue'
import AdminIcon from './AdminIcon.vue'
import { adminApi } from '../../../utils/api'
import { parseServerBackup } from '../../../utils/backup'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: 'database' },
  dbLoading: { type: Boolean, default: false },
  selectedApiIndex: { type: Number, default: 0 },
  requestOwner: Function
})

defineEmits(['open-db-modal'])

const fileInput = ref(null)
const exporting = ref(false)
const importing = ref(false)
const importResult = ref(null)
const exportNotice = ref(null)
const includeNotificationSecrets = ref(false)
const showSensitiveConfirm = ref(false)
let generation = 0
const reset = () => { generation++; exporting.value = importing.value = includeNotificationSecrets.value = showSensitiveConfirm.value = false; importResult.value = exportNotice.value = null }
watch(() => props.selectedApiIndex, reset)
onBeforeUnmount(reset)
const requestExport = () => { if (includeNotificationSecrets.value) showSensitiveConfirm.value = true; else handleExport(false) }
const acknowledgeReload = () => { if (importResult.value?.reloadNeeded) window.location.reload() }

const emptyResult = () => ({ success: false, imported: 0, skipped: 0, skippedIds: [] })

const handleExport = async (sensitive = false) => {
  if (exporting.value || importing.value) return
  const requestGeneration = generation
  exporting.value = true
  importResult.value = null
  exportNotice.value = null
  try {
    const result = await adminApi({ action: 'export_servers', ...(sensitive ? { includeNotificationSecrets: true } : {}) }, props.selectedApiIndex, props.requestOwner)
    if (requestGeneration !== generation) return
    if (result.error || !result.data || !Array.isArray(result.data.servers)) {
      // 后端返回的是错误码，能翻译就翻译，不能就用通用失败文案
      exportNotice.value = {
        success: false,
        text: props.trans[result.error] || props.trans.serversExportFailed
      }
      return
    }

    const payload = {
      ...result.data,
      format: 'cfsm-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      servers: result.data.servers,
      settings: result.data.settings || null
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cfsm-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    exportNotice.value = { success: true, text: props.trans.serversExported, warning: result.data.notificationBackup?.warning }
    showSensitiveConfirm.value = false
  } catch (e) {
    if (requestGeneration !== generation) return
    exportNotice.value = { success: false, text: props.trans.serversExportFailed }
  } finally {
    if (requestGeneration === generation) exporting.value = false
  }
}

const handleFileSelect = async (event) => {
  const file = event.target.files[0]
  if (!file) return
  if (importing.value || exporting.value) return
  const requestGeneration = generation

  importing.value = true
  importResult.value = null

  try {
    const text = await file.text()
    if (requestGeneration !== generation) return
    // 旧版纯服务器数组与新备份 { servers, settings } 都支持
    const { servers, settings } = parseServerBackup(text)

    if (servers.length === 0 && !settings) {
      importResult.value = emptyResult()
      return
    }

    const result = await adminApi({ action: 'import_servers', servers, settings }, props.selectedApiIndex, props.requestOwner)
    if (requestGeneration !== generation) return
    if (!result.error && result.data) {
      importResult.value = {
        success: result.data.success,
        imported: result.data.imported || 0,
        skipped: result.data.skipped || 0,
        skippedIds: result.data.skippedIds || [],
        notification: result.data.settings?.notification,
        ignoredFields: result.data.settings?.ignoredFields || [],
        reloadNeeded: result.data.imported > 0 || result.data.settings?.imported
      }
    } else {
      importResult.value = { ...emptyResult(), error: props.trans[result.error] || props.trans.adminImportFailed }
    }
  } catch (e) {
    if (requestGeneration !== generation) return
    importResult.value = { ...emptyResult(), error: props.trans.adminImportFailed }
  } finally {
    if (requestGeneration === generation) importing.value = false
    if (requestGeneration === generation && fileInput.value) {
      fileInput.value.value = ''
    }
  }
}
</script>
