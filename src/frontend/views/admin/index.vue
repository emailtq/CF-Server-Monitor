<template>
  <div class="admin-ui">
    <AdminHeader v-if="!isLoggedIn" :site-title="settings.site_title || DEFAULT_SITE_TITLE" :trans="trans" :show-logout="false" />
    <AdminLogin
      v-if="!isLoggedIn"
      :trans="trans"
      :is-multiple-mode="isMultipleMode"
      :api-bases="apiBases"
      :selected-api-index="selectedApiIndex"
      :login-form="loginForm"
      :password-visible="passwordVisible"
      :login-error="loginError"
      :login-loading="loginLoading"
      :turnstile-site-key="turnstileSiteKey"
      :turnstile-login-enabled="turnstileLoginEnabled"
      :turnstile-enabled="turnstileEnabled"
      :turnstile-verified="turnstileVerified"
      @login="handleLogin"
      @toggle-password="togglePassword"
      @api-index-change="handleApiIndexChange"
    />

    <AdminLayout v-else :active-page="activeTab" :site-title="settings.site_title || DEFAULT_SITE_TITLE" :trans="trans" @navigate="activeTab = $event">
      <template #header>
        <AdminHeader :site-title="settings.site_title || DEFAULT_SITE_TITLE" :trans="trans" @logout="logout" />
      </template>
      <div v-if="adminSiteLoading" class="admin-loading-overlay" role="status" aria-live="polite" :aria-label="trans.switchingSite">
        <div class="loading-content"><div class="loading-spinner"></div><div class="loading-text">{{ trans.switchingSite }}</div></div>
      </div>
        <ServerTable
          v-model:new-server-name="newServerName"
          v-model:new-server-group="newServerGroup"
          :trans="trans"
          :servers="servers"
          :selected-servers="selectedServers"
          :groups="groups"
          :active-tab="activeTab"
          :selected-api-index="selectedApiIndex"
          :site-generation="siteGeneration"
          :latest-agent-version="latestAgentVersion"
          :cache-refreshing="cacheRefreshing"
          :copied-server-id="copiedServerId"
          :copied-note-server-id="copiedNoteServerId"
          :copied-spec-key="copiedSpecKey"
          @add-server="showAddModal = true; addError = ''"
          @groups="showGroupModal = true"
          @auto-discovery-cmd="openAutoDiscoveryModal"
          @batch-edit="openBatchEditModal"
          @batch-delete="batchDelete"
          @toggle-select-all="toggleSelectAll"
          @refresh-cache="refreshServersCache"
          @select-all="handleSelectAll"
          @reorder="saveServerOrder"
          @toggle-server="toggleServer"
          @copy-note="copyServerNote"
          @copy-spec="copyServerSpec"
          @copy-cmd="copyCmd"
          @edit="openEditModal"
          @renew="openRenewModal"
          @delete="openDeleteModal"
          @terminal="openTerminal"
          :terminal-statuses="terminalStatuses"
          @terminal-access="terminalServer = $event"
        />

        <SettingsPanel
          :api-bases="apiBases"
          :is-multiple-mode="isMultipleMode"
          :selected-api-index="selectedApiIndex"
          :site-loading="adminSiteLoading"
          @api-index-change="selectedApiIndex = $event; handleAdminApiIndexChange()"
          :key="siteGeneration"
          ref="settingsPanelRef"
          :trans="trans"
          :settings="settings"
          :servers="servers"
          :password-visible="passwordVisible"
          :active-tab="activeTab"
          :selected-api-base="selectedApiBase"
          :current-origin="currentOrigin"
          :saving="saving"
          :change-admin-password="changeAdminPassword"
          :d1-usage-loading="d1UsageLoading"
          @toggle-password="togglePassword"
          @toggle-admin-password-change="toggleAdminPasswordChange"
          @save-settings="saveSettings"
          @upload-bg="uploadBg"
          @upload-bg-mobile="uploadBgMobile"
          @upload-favicon="uploadFavicon"
          @query-d1-usage="queryD1Usage"
          @alert-message="alertMessage = $event"
        />

        <NotificationWorkspace :key="'notifications-' + siteGeneration" :trans="trans" :active-tab="activeTab" :servers="servers" :selected-api-index="selectedApiIndex" :request-owner="requestOwner" @config="notificationConfig = $event" @navigate="activeTab = $event" />

        <DatabasePanel
          :request-owner="requestOwner"
          :key="'data-' + siteGeneration"
          :trans="trans"
          :active-tab="activeTab"
          :db-loading="dbLoading"
          :selected-api-index="selectedApiIndex"
          @open-db-modal="openDbModal"
        />

        <ThemeStorePanel
          :request-owner="requestOwner"
          :key="'theme-' + siteGeneration"
          :trans="trans"
          :active-tab="activeTab"
          :selected-api-index="selectedApiIndex"
          :current-theme-url="settings.theme_url"
          :settings="settings"
          @theme-applied="settings.theme_url = $event"
          @theme-options-applied="handleThemeOptionsApplied"
          @alert-message="alertMessage = $event"
        />

        <DonationPanel
          :trans="trans"
          :active-tab="activeTab"
        />

      <UpdatesPanel :trans="trans" :active-tab="activeTab" :latest-agent-version="latestAgentVersion" @donation="activeTab = 'donation'" />
      <AddServerModal v-model:name="newServerName" v-model:group="newServerGroup" :trans="trans" :show="showAddModal" :saving="adding" :error="addError" :groups="groups" @save="addServer" @close="closeAddModal" />
      <GroupServersModal :trans="trans" :show="showGroupModal" :busy="batchEditing || cacheRefreshing" :servers="servers" :selected="selectedServers" @close="showGroupModal = false" @toggle="toggleServer" @select-all="toggleSelectAll" @batch-edit="showGroupModal = false; openBatchEditModal()" @batch-delete="showGroupModal = false; batchDelete()" @refresh="refreshServersCache" @save="saveGroup" />
      <RenewServerModal v-model:form="editForm" :trans="trans" :server-name="currentServerName" :show="showRenewModal" :saving="editSaving" :error="validationError" @close="closeRenewModal" @save="saveEdit" />
      <p v-if="validationError && validationField" class="danger-box" role="alert">{{ validationError }}</p>

      <EditServerModal
        :trans="trans"
        :show="showEditModal"
        :saving="editSaving"
        v-model:edit-form="editForm"
        :current-server-name="currentServerName"
        :settings="nodeSettings"
        :agent-version="currentServerVersion"
        :selected-api-index="selectedApiIndex"
        @terminal-access="terminalServer = servers.find(server => server.id === editForm.id); showEditModal = false"
        :error="validationError"
        @save="saveEdit"
        @close="closeEditModal"
        @toggle-auto-update="handleAutoUpdateToggle"
      />

      <BatchEditServersModal
        v-model:form="batchEditForm"
        v-model:enabled="batchEditEnabled"
        :trans="trans"
        :show="showBatchEditModal"
        :selected-count="selectedServers.length"
        :settings="settings"
        :is-wss-report-enabled="isWssReportEnabled"
        :saving="batchEditing"
        :error="validationError"
        @save="saveBatchEdit"
        @close="closeBatchEditModal"
      />

      <AdminDialog :open="showAutoUpdateWarning" :title="trans.autoUpdateRiskTitle" @close="cancelAutoUpdateWarning">
        <template #body>
          <div class="danger-box mb-4">
            <div class="flex-center-gap-sm mb-2">

              <span class="danger-label">{{ trans.autoUpdateRiskTitle }}</span>
            </div>
            <p class="text-secondary text-sm line-height-1-6">
              {{ trans.autoUpdateRiskDesc }}
            </p>
          </div>
        </template>
        <template #footer>
          <button @click="cancelAutoUpdateWarning" class="btn">{{ trans.autoUpdateRiskCancel }}</button>
          <button @click="confirmAutoUpdateWarning" class="btn btn-primary">{{ trans.autoUpdateRiskConfirm }}</button>
        </template>
      </AdminDialog>

      <DeleteServerModal
        :trans="trans"
        :show="showDeleteModal"
        :busy="deleting"
        :delete-server-id="deleteServerId"
        :current-server-name="currentServerName"
        :delete-target-os="deleteTargetOs"
        :delete-version="deleteVersion"
        :delete-install-mode="deleteInstallMode"
        :delete-gh-proxy="deleteGhProxy"
        :uninstall-command="getUninstallCommand()"
        :uninstall-copied="uninstallCopied"
        @close="closeDeleteModal"
        @confirm-delete="confirmDelete"
        @copy-uninstall="copyUninstallCmd"
        @update:delete-target-os="deleteTargetOs = $event"
        @update:delete-version="deleteVersion = $event"
        @update:delete-install-mode="deleteInstallMode = $event"
        @update:delete-gh-proxy="deleteGhProxy = $event"
      />

      <CopyCommandModal
        :trans="trans"
        :settings="settings"
        :show="showCopyModal"
        :server-id="copyServerId"
        :api-index="selectedApiIndex"
        :request-owner="requestOwner"
        :current-server-name="currentServerName"
        :target-os="targetOs"
        :install-mode="installMode"
        :install-gh-proxy="installGhProxy"
        :install-version="installVersion"
        :auto-update="autoUpdate"
        :install-command="getCustomInstallCommand()"
        @close="closeCopyModal"
        @copy-cmd="copyCustomCmd"
        @terminal-options="terminalInstallOptions = $event"
        @install-available="installCommandBlocked = !$event"
        @update:auto-update="autoUpdate = $event"
        @update:target-os="targetOs = $event"
        @update:install-mode="installMode = $event"
        @update:install-gh-proxy="installGhProxy = $event"
        @update:install-version="installVersion = $event"
      />

      <AutoDiscoveryCommandModal
        :trans="trans"
        :show="showAutoDiscoveryModal"
        :target-os="autoDiscoveryTargetOs"
        :install-mode="autoDiscoveryInstallMode"
        :name="autoDiscoveryName"
        :version="autoDiscoveryVersion"
        :auto-update="autoDiscoveryAutoUpdate"
        :gh-proxy="autoDiscoveryGhProxy"
        :install-command="getAutoDiscoveryInstallCommand()"
        :copied="autoDiscoveryCopied"
        :command-error="isValidRegistrationName(autoDiscoveryName) ? registrationError : 'invalidServerName'"
        :api-index="selectedApiIndex"
        :request-owner="requestOwner"
        @install-available="autoDiscoveryBlocked = !$event"
        @close="closeAutoDiscoveryModal"
        @copy-cmd="copyAutoDiscoveryCmd"
        @update:target-os="autoDiscoveryTargetOs = $event"
        @update:install-mode="autoDiscoveryInstallMode = $event"
        @update:name="autoDiscoveryName = $event"
        @update:version="autoDiscoveryVersion = $event"
        @update:auto-update="autoDiscoveryAutoUpdate = $event"
        @update:gh-proxy="autoDiscoveryGhProxy = $event"
      />

      <AdminDialog :open="showDbModal" :title="dbOperation === 'clearHistory' ? trans.clearHistory : trans.upgradeDatabase" :busy="dbLoading" @close="closeDbModal">
        <template #body>
          <div v-if="dbOperation === 'clearHistory'" class="mb-4">
            <div class="flex-center-gap-sm mb-3">

              <span class="danger-label">{{ trans.dangerOperation }}</span>
            </div>
            <p class="text-secondary text-sm line-height-1-6">
              {{ trans.clearHistoryWarning }}
            </p>
          </div>

          <div v-if="dbOperation === 'upgrade'" class="mb-4">
            <div class="flex-center-gap-sm mb-3">

              <span style="color: var(--accent-yellow); font-weight: 600;">{{ trans.upgradeDatabase }}</span>
            </div>
            <p class="text-secondary text-sm line-height-1-6">
              {{ trans.upgradeDesc }}
            </p>
          </div>

          <div v-if="dbResult" :class="dbResult.success ? 'warning-box' : 'danger-box'" class="mb-4">
            <div class="flex-center-gap-sm">
              <span :style="{ color: dbResult.success ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: '600' }">
                {{ getMessage(dbResult.message) || (dbResult.success ? trans.operationSuccess : trans.operationFailed) }}
              </span>
            </div>
            <div v-if="dbResult.error" class="text-red mt-2">
              {{ getMessage(dbResult.error) }}
            </div>
          </div>
        </template>
        <template #footer v-if="!(dbResult && dbResult.success)">
          <button @click="closeDbModal" class="btn" :disabled="dbLoading">{{ trans.cancel }}</button>
          <button
              v-if="!dbResult"
              @click="dbOperation === 'clearHistory' ? handleClearHistory() : handleUpgradeDatabase()"
              class="btn btn-red"
              :disabled="dbLoading"
            >
              {{ dbLoading ? (dbOperation === 'clearHistory' ? trans.clearing : trans.upgrading) : (dbOperation === 'clearHistory' ? trans.confirmClear : trans.upgradeDatabase) }}
            </button>
        </template>
      </AdminDialog>

      <AdminDialog :open="!!d1UsageResult" :title="trans.queryD1Quota" size="edit" @close="d1UsageResult = null">
        <template #body>
          <div v-if="d1UsageResult.success" class="mb-4">
            <div class="warning-box mb-4">
              {{ getMessage(d1UsageResult.message) || trans.d1UsageQueried }}
            </div>
            <div class="quota-section">
              <div class="quota-section-title">{{ trans.todayUsage }}</div>
              <div class="quota-progress-list">
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span>{{ trans.d1RowsRead }}：{{ formatNumber(d1UsageResult.usage.today.rowsRead) }} / {{ formatNumber(5000000) }}</span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.today.rowsRead, 5000000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.today.rowsRead, 5000000) + '%' }"></div>
                  </div>
                </div>
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span>{{ trans.d1RowsWritten }}：{{ formatNumber(d1UsageResult.usage.today.rowsWritten) }} / {{ formatNumber(100000) }}</span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.today.rowsWritten, 100000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.today.rowsWritten, 100000) + '%' }"></div>
                  </div>
                </div>
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span>{{ trans.workersRequests }}：{{ formatNumber(d1UsageResult.usage.today.workersRequests) }} / {{ formatNumber(100000) }}</span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.today.workersRequests, 100000) }}%</span>
                  </div>
                  <div v-if="d1UsageResult.usage.today.workersRequests" class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.today.workersRequests, 100000) + '%' }"></div>
                  </div>
                </div>
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span class="quota-label-with-help">
                      <span>{{ trans.durableObjectsRequests }}：{{ formatNumber(d1UsageResult.usage.today.durableObjectsRequests) }} / {{ formatNumber(100000) }}</span>
                      <HelpTooltip>
                        <template #default>
                          <span v-for="row in getDurableObjectsUsageRows(d1UsageResult.usage.today)" :key="row.key" class="quota-help-row">
                            <span class="quota-help-label">{{ row.label }}</span>
                            <span class="quota-help-value">{{ row.value }}</span>
                          </span>
                        </template>
                      </HelpTooltip>
                    </span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.today.durableObjectsRequests, 100000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.today.durableObjectsRequests, 100000) + '%' }"></div>
                  </div>
                </div>
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span class="quota-label-with-help">
                      <span>{{ trans.durableObjectsDuration }}：{{ formatNumber(d1UsageResult.usage.today.durableObjectsDuration, 2) }} / {{ formatNumber(13000) }}</span>
                      <HelpTooltip :text="trans.durableObjectsDurationTip">
                        <template #default>
                          <span class="quota-help-row">{{ trans.durableObjectsDurationTip }}</span>
                        </template>
                      </HelpTooltip>
                    </span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.today.durableObjectsDuration, 13000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.today.durableObjectsDuration, 13000) + '%' }"></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="quota-section mt-4">
              <div class="quota-section-title">{{ trans.yesterdayUsage }}</div>
              <div class="quota-progress-list">
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span>{{ trans.d1RowsRead }}：{{ formatNumber(d1UsageResult.usage.yesterday.rowsRead) }} / {{ formatNumber(5000000) }}</span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.yesterday.rowsRead, 5000000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.yesterday.rowsRead, 5000000) + '%' }"></div>
                  </div>
                </div>
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span>{{ trans.d1RowsWritten }}：{{ formatNumber(d1UsageResult.usage.yesterday.rowsWritten) }} / {{ formatNumber(100000) }}</span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.yesterday.rowsWritten, 100000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.yesterday.rowsWritten, 100000) + '%' }"></div>
                  </div>
                </div>
                <div v-if="d1UsageResult.usage.yesterday.workersRequests" class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span>{{ trans.workersRequests }}：{{ formatNumber(d1UsageResult.usage.yesterday.workersRequests) }} / {{ formatNumber(100000) }}</span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.yesterday.workersRequests, 100000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.yesterday.workersRequests, 100000) + '%' }"></div>
                  </div>
                </div>
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span class="quota-label-with-help">
                      <span>{{ trans.durableObjectsRequests }}：{{ formatNumber(d1UsageResult.usage.yesterday.durableObjectsRequests) }} / {{ formatNumber(100000) }}</span>
                      <HelpTooltip>
                        <template #default>
                          <span v-for="row in getDurableObjectsUsageRows(d1UsageResult.usage.yesterday)" :key="row.key" class="quota-help-row">
                            <span class="quota-help-label">{{ row.label }}</span>
                            <span class="quota-help-value">{{ row.value }}</span>
                          </span>
                        </template>
                      </HelpTooltip>
                    </span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.yesterday.durableObjectsRequests, 100000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.yesterday.durableObjectsRequests, 100000) + '%' }"></div>
                  </div>
                </div>
                <div class="quota-progress-item">
                  <div class="flex-justify-between text-sm mb-1">
                    <span class="quota-label-with-help">
                      <span>{{ trans.durableObjectsDuration }}：{{ formatNumber(d1UsageResult.usage.yesterday.durableObjectsDuration, 2) }} / {{ formatNumber(13000) }}</span>
                      <HelpTooltip :text="trans.durableObjectsDurationTip">
                        <template #default>
                          <span class="quota-help-row">{{ trans.durableObjectsDurationTip }}</span>
                        </template>
                      </HelpTooltip>
                    </span>
                    <span>{{ getUsagePercent(d1UsageResult.usage.yesterday.durableObjectsDuration, 13000) }}%</span>
                  </div>
                  <div class="quota-progress-bar">
                    <div class="quota-progress-fill" :style="{ width: getUsageBarPercent(d1UsageResult.usage.yesterday.durableObjectsDuration, 13000) + '%' }"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="danger-box mb-4">
            {{ getMessage(d1UsageResult.error) }}
          </div>
        </template>
        <template #footer>
          <button @click="d1UsageResult = null" class="btn">{{ trans.close }}</button>
          <div></div>
        </template>
      </AdminDialog>

      <AdminDialog :open="!!validationError && !validationField && !showEditModal && !showRenewModal && !showBatchEditModal" :title="trans.validationError" @close="validationError = null">
        <template #body>
          <div class="danger-box mb-4">
            <div class="flex-center-gap-sm">

              <span class="danger-label">{{ validationError }}</span>
            </div>
          </div>
        </template>
        <template #footer>
          <button @click="validationError = null" class="btn">{{ trans.close }}</button>
          <div></div>
        </template>
      </AdminDialog>

      <AdminDialog :open="!!saveResult" :title="trans.save" @close="saveResult = null">
        <template #body>
          <div v-if="saveResult.success" class="success-box mb-4">
            <div class="flex-center-gap-sm">
              <span style="color: var(--accent-green); font-weight: 600;">
                 {{ saveResult.message || trans.saveSuccess }}
              </span>
            </div>
          </div>

          <div v-else class="danger-box mb-4">
            <div class="flex-center-gap-sm">
              <span class="danger-label"> {{ saveResult.error }}</span>
            </div>
          </div>
        </template>
        <template #footer>
          <button @click="saveResult = null" class="btn">{{ trans.close }}</button>
          <div></div>
        </template>
      </AdminDialog>

      <AdminDialog :open="!!alertMessage" :title="trans.adminPanel" @close="alertMessage = null">
        <template #body>
          <div class="mb-4">
            <p class="text-secondary text-sm">{{ alertMessage }}</p>
          </div>
        </template>
        <template #footer>
          <button @click="alertMessage = null" class="btn">{{ trans.close }}</button>
          <div></div>
        </template>
      </AdminDialog>

      <TerminalAccessModal v-if="terminalServer" :server="terminalServer" :api-index="selectedApiIndex" :trans="trans" @close="terminalServer = null" />

    </AdminLayout>
  </div>
</template>

<script setup>
import AdminDialog from './components/AdminDialog.vue'
import NotificationWorkspace from './components/NotificationWorkspace.vue'
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, inject, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AdminHeader from './components/AdminHeader.vue'
import AdminLayout from './components/AdminLayout.vue'

import HelpTooltip from '../../components/HelpTooltip.vue'
import AdminLogin from './components/AdminLogin.vue'
import ServerTable from './components/ServerTable.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import DatabasePanel from './components/DatabasePanel.vue'
import ThemeStorePanel from './components/ThemeStorePanel.vue'
import DonationPanel from './components/DonationPanel.vue'
import AddServerModal from './components/AddServerModal.vue'
import UpdatesPanel from './components/UpdatesPanel.vue'
import GroupServersModal from './components/GroupServersModal.vue'
import RenewServerModal from './components/RenewServerModal.vue'
import EditServerModal from './components/EditServerModal.vue'
import BatchEditServersModal from './components/BatchEditServersModal.vue'
import DeleteServerModal from './components/DeleteServerModal.vue'
import CopyCommandModal from './components/CopyCommandModal.vue'
import AutoDiscoveryCommandModal from './components/AutoDiscoveryCommandModal.vue'
import { adminApi, login, logout as apiLogout, upgradeDatabase, clearHistory, fetchConfig, getTerminalBase, closeTerminalSessions } from '../../utils/api'
import { hasMultipleApiBases, getApiBases } from '../../utils/config.js'
import { copyTextToClipboard } from '../../utils/clipboard.js'
import { normalizeLanguagePreference, t, useTranslation } from '../../utils/i18n'
import { PING_NODE_FIELDS, validatePingNode } from '../../utils/pingNode.js'
import { AGENT_REPOSITORY, AGENT_INSTALL_REF, AGENT_RELEASE_URL } from '../../../shared/agentSource.js'
import { normalizeDisplayMode, resolveDisplayMode } from '../../utils/displayMode.js'
import { applyMikusThemeOptions } from '../../utils/themeOptions.js'
import { DEFAULT_SITE_TITLE, FRONTEND_WS_TIMEOUT_MINUTES_MAX, HISTORY, STORAGE } from '../../utils/constants.js'
import { usePasswordVisibility } from '../../composables/usePasswordVisibility'
import { useTurnstile } from './composables/useTurnstile'
import { detectBillingCycle, detectCurrencySymbol, normalizeBillingCycle, normalizeCurrency, normalizePrice, renewExpireDateIfNeeded } from '../../utils/server.js'

const translation = useTranslation()
const trans = computed(() => {
  const labels = { ...translation.value }
  for (const key of ['price', 'traffic', 'status', 'actions', 'upload', 'autoAdd', 'batchDelete', 'toggleAll', 'refreshCache', 'agentVersion', 'region', 'use', 'update', 'expired', 'saveConfig', 'cancel', 'save']) {
    const value = labels[key]
    if (typeof value === 'string' && /^[A-Z][A-Z /_-]+$/.test(value)) labels[key] = value[0] + value.slice(1).toLowerCase()
  }
  return labels
})
const TerminalAccessModal = defineAsyncComponent(() => import('./components/TerminalAccessModal.vue'))
const terminalServer = ref(null)
const terminalStatuses = ref({})
const terminalInstallOptions = ref({selected:false, enabled:false, token:''})
const openTerminal = server => {
  const apiIndex = selectedApiIndex.value
  const status = terminalStatuses.value[server.id]
  if (!adminActive || !isLoggedIn.value || adminSiteLoading.value || status?.enabled !== true || status.localEnabled === false || !['ready', 'offline'].includes(status.state)) return
  try {
    const base = getTerminalBase(apiIndex)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(server.id)) throw new Error('terminal_invalid_node')
    // Entry is a synchronous navigation; the terminal page checks live authority.
    window.open(`${base}/admin#/admin/terminal/${server.id}?apiIndex=${apiIndex}`, '_blank', 'noopener,noreferrer')
  } catch (error) { alertMessage.value = trans.value[error.message] || trans.value.terminalRequestFailed }
}
const route = useRoute()
const router = useRouter()
const appConfig = inject('appConfig', {})
let startupConfigConsumed = false
const AGENT_RELEASE_FAILURE_TTL = 30 * 1000

let cachedAgentReleaseVersion = ''
let cachedAgentReleaseFailureAt = 0
let agentReleasePromise = null

const normalizeVersion = (version) => String(version || '').trim()

const fetchLatestAgentReleaseVersion = async () => {
  if (cachedAgentReleaseVersion) return cachedAgentReleaseVersion
  if (cachedAgentReleaseFailureAt && Date.now() - cachedAgentReleaseFailureAt < AGENT_RELEASE_FAILURE_TTL) return ''
  if (agentReleasePromise) return agentReleasePromise

  agentReleasePromise = fetch(AGENT_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' }
  }).then(async (res) => {
    if (!res.ok) throw new Error(`GitHub release request failed: ${res.status}`)
    const release = await res.json()
    const version = normalizeVersion(release?.tag_name)
    if (version) {
      cachedAgentReleaseVersion = version
      cachedAgentReleaseFailureAt = 0
    } else {
      cachedAgentReleaseFailureAt = Date.now()
    }
    return version
  }).catch((e) => {
    cachedAgentReleaseFailureAt = Date.now()
    console.error('[ERROR] Load latest agent release failed:', e)
    return ''
  }).finally(() => {
    agentReleasePromise = null
  })

  return agentReleasePromise
}

const getMessage = (msg) => {
  if (typeof msg === 'string') {
    const translated = t(msg)
    return translated !== msg ? translated : msg
  }
  return ''
}

const normalizeLongHistoryPointsSetting = (value) => {
  const points = Number(value)
  return String(
    HISTORY.LONG_RANGE_POINT_OPTIONS.includes(points)
      ? points
      : HISTORY.DEFAULT_LONG_RANGE_POINTS
  )
}

const normalizeFrontendWsTimeoutMinutesSetting = (value) => {
  const minutes = Number(value)
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= FRONTEND_WS_TIMEOUT_MINUTES_MAX
    ? minutes
    : 0
}

const normalizeWssReportHoursSetting = (value) => {
  if (value === undefined || value === null || value === '') {
    return Array.from({ length: 24 }, (_, hour) => hour)
  }

  let source = value
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch (_) {
      source = source.split(',').map(item => item.trim()).filter(Boolean)
    }
  }
  if (!Array.isArray(source)) return Array.from({ length: 24 }, (_, hour) => hour)

  return Array.from(new Set(source
    .map(hour => {
      if (typeof hour === 'number') return hour
      if (typeof hour === 'string' && /^\d{1,2}$/.test(hour.trim())) return Number(hour)
      return NaN
    })
    .filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23)))
    .sort((a, b) => a - b)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const normalizePreferredThemeSetting = (value) => {
  const theme = String(value || '').trim().toLowerCase()
  return ['dark', 'light', 'auto'].includes(theme) ? theme : 'auto'
}

const normalizeDefaultLanguageSetting = (value) => normalizeLanguagePreference(value)

const formatThemeOptions = (value) => {
  const normalized = value === undefined || value === null ? {} : value
  try {
    return JSON.stringify(normalized, null, 2)
  } catch (_) {
    return '{}'
  }
}

const parseThemeOptions = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return { valid: true, value: {} }
  try {
    const parsed = JSON.parse(raw)
    if (!isPlainObject(parsed)) {
      return { valid: false }
    }
    return { valid: true, value: parsed }
  } catch (_) {
    return { valid: false }
  }
}

const formatNumber = (value, maximumFractionDigits = 0) => (
  Number(value || 0).toLocaleString(undefined, { maximumFractionDigits })
)
const getDurableObjectsUsageRows = (usage = {}) => ([
  {
    key: 'http',
    label: trans.value.durableObjectsHttpRequests,
    value: `${formatNumber(usage.durableObjectsHttpRequests)} · ${trans.value.billingRatioOneToOne}`
  },
  {
    key: 'hibernation',
    label: trans.value.durableObjectsHibernationWakeups,
    value: `${formatNumber(usage.durableObjectsHibernationWakeups)} · ${trans.value.billingRatioOneToOne}`
  },
  {
    key: 'inbound-ws',
    label: trans.value.durableObjectsInboundWebSocketMessages,
    value: `${formatNumber(usage.durableObjectsInboundWebSocketMessages)} · ${trans.value.billingRatioWebSocketIncoming}`
  },
  {
    key: 'outbound-ws',
    label: trans.value.durableObjectsOutboundWebSocketMessages,
    value: `${formatNumber(usage.durableObjectsOutboundWebSocketMessages)} · ${trans.value.billingRatioNotBilled}`
  }
])
const getUsagePercent = (used, limit) => {
  if (!limit) return 0
  return Number(((Number(used || 0) / Number(limit)) * 100).toFixed(2))
}
const getUsageBarPercent = (used, limit) => {
  return Math.min(100, Math.max(0, getUsagePercent(used, limit)))
}

const isMultipleMode = computed(() => hasMultipleApiBases())
const apiBases = getApiBases()
const normalizeApiIndex = (value) => {
  const index = parseInt(value, 10)
  if (Number.isNaN(index) || index < 0 || index >= apiBases.length) return 0
  return index
}
const selectedApiIndex = ref(normalizeApiIndex(route.query.apiIndex))
const selectedApiBase = computed(() => apiBases[selectedApiIndex.value] || apiBases[0])
const currentOrigin = computed(() => window.location.origin)

const syncApiIndexQuery = () => {
  if (!isMultipleMode.value) return
  if (String(route.query.apiIndex ?? '') === String(selectedApiIndex.value)) return
  router.replace({
    path: '/admin',
    query: {
      ...route.query,
      apiIndex: String(selectedApiIndex.value)
    }
  })
}

const notificationConfig = ref(null)
const nodeSettings = computed(() => {
  const available = notificationConfig.value?.rules.some(rule => rule.type === 'offline' && rule.enabled && (rule.scope.mode === 'all' || rule.scope.serverIds.includes(editForm.value.id)) && rule.targetIds.some(id => notificationConfig.value.channels.some(channel => channel.id === id && channel.enabled)))
  // Compatibility presentation flags only; no credential or legacy notification payload.
  return { ...settings.value, tg_notify: available ? '5' : '0', tg_bot_token: !!available }
})

const siteGeneration = ref(0)
let adminActive = true
const requestOwner = computed(() => {
  const generation = siteGeneration.value
  return () => adminActive && generation === siteGeneration.value
})
const adminApiForSite = (data) => adminApi(data, selectedApiIndex.value, requestOwner.value)
let orderSaving = Promise.resolve(), orderRevision = 0

let terminalStatusTimer = null, terminalStatusRequest = null
let terminalStatusSequence = 0, terminalStatusGeneration = 0, terminalStatusAgain = false
let terminalStatusLoggedOut = false
const terminalStatusActive = () => adminActive && isLoggedIn.value && !terminalStatusLoggedOut && !adminSiteLoading.value && activeTab.value === 'servers' && !document.hidden && servers.value.length > 0
const cancelTerminalStatuses = () => {
  terminalStatusGeneration++; terminalStatusSequence++
  clearTimeout(terminalStatusTimer); terminalStatusTimer = null
  terminalStatusAgain = false
  terminalStatusRequest?.abort()
}
const refreshTerminalStatuses = async () => {
  const sequence = ++terminalStatusSequence
  clearTimeout(terminalStatusTimer); terminalStatusTimer = null
  if (!terminalStatusActive()) return
  if (terminalStatusRequest) { terminalStatusAgain = true; return }
  const generation = terminalStatusGeneration, owner = requestOwner.value
  const ids = [...new Set(servers.value.map(server => server.id))]
  const controller = new AbortController()
  terminalStatusRequest = controller
  const current = () => owner() && generation === terminalStatusGeneration && sequence === terminalStatusSequence && terminalStatusActive()
  try {
    const nodes = {}
    // The API caps each unique batch at 1000; keep larger lists sequential.
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const batch = ids.slice(offset, offset + 1000)
      const result = await adminApi({action:'terminal_status', serverIds:batch}, selectedApiIndex.value, current, controller.signal)
      if (!current()) return
      Object.assign(nodes, result.error ? Object.fromEntries(batch.map(id => [id,{state:/^terminal_[a-z0-9_]+$/.test(result.error) ? result.error : 'query_failed'}])) : result.data?.nodes || {})
    }
    if (current()) terminalStatuses.value = nodes
  } catch (_) {
    if (current()) terminalStatuses.value = Object.fromEntries(ids.map(id => [id,{state:'query_failed'}]))
  } finally {
    if (terminalStatusRequest !== controller) return
    terminalStatusRequest = null
    if (terminalStatusAgain || generation !== terminalStatusGeneration) { terminalStatusAgain = false; void refreshTerminalStatuses() }
    else if (terminalStatusActive()) terminalStatusTimer = setTimeout(refreshTerminalStatuses, 5000)
  }
}
const restartTerminalStatuses = () => { cancelTerminalStatuses(); void refreshTerminalStatuses() }
const terminalStatusLogout = () => { terminalStatusLoggedOut = true; cancelTerminalStatuses(); terminalStatuses.value = {} }
const terminalStatusStorage = event => { if (event.key === STORAGE.JWT_TOKEN && !event.newValue) terminalStatusLogout() }
let terminalStatusChannel

const isLoggedIn = ref(false)
const loginForm = ref({ username: '', password: '' })
const loginError = ref('')
const loginLoading = ref(false)
const adminSiteLoading = ref(false)
const activeTab = ref('servers')
watch(activeTab, () => { showCopyModal.value = false; terminalInstallOptions.value = {selected:false, enabled:false, token:''} })
const servers = ref([])
const selectedServers = ref([])
const stats = ref({ total: '-', online: 0, offline: 0, avg_cpu: 0 })
const groups = ref(['Default'])
const latestAgentVersion = ref('')
const newServerName = ref('')
const newServerGroup = ref('')
const showAddModal = ref(false)
const showGroupModal = ref(false)
const showRenewModal = ref(false)
const currentServerVersion = ref('')
const adding = ref(false)
const addError = ref('')
const closeAddModal = () => { if (adding.value) return; showAddModal.value = false; newServerName.value = ''; newServerGroup.value = ''; addError.value = '' }

const settings = ref({
  site_title: '',
  custom_bg: '',
  custom_bg_mobile: '',
  favicon: '',
  custom_head: '',
  custom_script: '',
  display_mode: 'bar',
  preferred_theme: 'auto',
  default_language: 'auto',
  theme_options: '{}',
  auto_discovery: false,
  is_public: false,
  show_price: true,
  show_expire: true,
  show_tf: true,
  show_three_net_details: true,
  wss_report_enabled: true,
  wss_report_hours: Array.from({ length: 24 }, (_, hour) => hour),
  frontend_ws_timeout_minutes: 0,
  long_history_points: String(HISTORY.DEFAULT_LONG_RANGE_POINTS),
  turnstile_enabled: false,
  turnstile_login_enabled: false,
  turnstile_site_key: '',
  turnstile_secret_key: '',
  cloudflare_account_id: '',
  cloudflare_token: '',
  jwt_secret: '',
  username: '',
  password_configured: false,
  password: '',
  confirm_password: '',
  custom_ct: '',
  custom_cu: '',
  custom_cm: '',
  custom_bd: '',
  custom_ct_name: '电信',
  custom_cu_name: '联通',
  custom_cm_name: '移动',
  custom_bd_name: 'BGP',
  theme_url: '',
  csp_static: '',
  csp_api: '',
  ua: 'cfsm'
})
const defaultSettings = JSON.parse(JSON.stringify(settings.value))
const cacheRefreshing = ref(false)
const savedAutoDiscovery = ref(false)
const changeAdminPassword = ref(false)

const clearAdminPasswordInputs = () => {
  settings.value.password = ''
  settings.value.confirm_password = ''
}

const isAdminUsernameEmpty = () => !String(settings.value.username || '').trim()

const toggleAdminPasswordChange = () => {
  if (isAdminUsernameEmpty()) {
    changeAdminPassword.value = true
    return
  }
  changeAdminPassword.value = !changeAdminPassword.value
  if (!changeAdminPassword.value) {
    clearAdminPasswordInputs()
  }
}

const { visibility: passwordVisible, toggle: togglePassword } = usePasswordVisibility([
  'login', 'tgBotToken', 'tgChatId', 'notificationWebhookUrl', 'smtpPassword', 'turnstileSecret', 'cloudflareToken', 'jwtSecret', 'ua', 'password', 'confirmPassword'
])

const {
  turnstileEnabled, turnstileLoginEnabled, turnstileSiteKey,
  turnstileToken, turnstileVerified,
  hasSharedTurnstileVerified, loadTurnstileConfig: loadTurnstileConfigBase,
  renderTurnstile, removeTurnstile, resetTurnstile, clearTurnstile
} = useTurnstile()

const editSaving = ref(false)
const deleting = ref(false)
const showEditModal = ref(false)
const showBatchEditModal = ref(false)
const batchEditing = ref(false)
const editForm = ref({
  id: '',
  name: '',
  server_group: '',
  region: '',
  tags: '',
  note: '',
  price: '',
  billing_cycle: 'month',
  auto_renewal: false,
  currency: '¥',
  expire_date: '',
  traffic_limit: '',
  traffic_calc_type: 'total',
  traffic_alert_percent: null,
  interface: '',
  reset_day: 1,
  collect_interval: 0,
  report_interval: 60,
  wss_report_interval: 2,
  connection_mode: 'auto',
  ping_mode: 'tcp',
  custom_ct: '',
  custom_cu: '',
  custom_cm: '',
  custom_bd: '',
  node_1: '', node_2: '', node_3: '', node_4: '',
  rx_correction: '',
  tx_correction: '',
  auto_update: false,
  is_hidden: false,
  offline_notify_disabled: false
})

const createBatchEditDefaults = () => ({
  server_group: '',
  region: '',
  tags: '',
  price: '',
  billing_cycle: 'month',
  auto_renewal: false,
  currency: '¥',
  expire_date: '',
  traffic_limit: '',
  traffic_calc_type: 'total',
  traffic_alert_percent: null,
  interface: '',
  reset_day: 1,
  collect_interval: 0,
  report_interval: 60,
  wss_report_interval: 2,
  connection_mode: 'auto',
  ping_mode: 'tcp',
  custom_ct: '',
  custom_cu: '',
  custom_cm: '',
  custom_bd: '',
  node_1: '', node_2: '', node_3: '', node_4: '',
  rx_correction: '',
  tx_correction: '',
  auto_update: false,
  is_hidden: false,
  offline_notify_disabled: false
})

const batchEditForm = ref(createBatchEditDefaults())
const batchEditEnabled = ref(Object.fromEntries(Object.keys(createBatchEditDefaults()).map(field => [field, false])))

const showDeleteModal = ref(false)
const deleteServerId = ref('')

const copiedServerId = ref(null)
const copiedNoteServerId = ref(null)
const copiedSpecKey = ref(null)
const deleteTargetOs = ref('linux')
const deleteVersion = ref('go')
const deleteInstallMode = ref('current-user')
const deleteGhProxy = ref('')
const uninstallCopied = ref(false)
const saving = ref(false)


const showDbModal = ref(false)
const dbOperation = ref('')
const dbLoading = ref(false)
const dbResult = ref(null)
const d1UsageLoading = ref(false)
const d1UsageResult = ref(null)
const validationError = ref(null)
const validationField = ref('')
const invalidSettingsField = (message, page, field) => {
  validationError.value = message
  validationField.value = field
  activeTab.value = page
  nextTick(() => document.querySelector(`[data-setting-field="${field}"]`)?.focus())
}
const alertMessage = ref(null)
const showAutoUpdateWarning = ref(false)
const autoUpdatePendingEnable = ref(false)


const saveResult = ref(null)

const settingsPanelRef = ref(null)

const showCopyModal = ref(false)
const copyServerId = ref('')
const currentServerName = ref('')
const targetOs = ref('linux')
const installMode = ref('current-user')
const installGhProxy = ref('')
const installVersion = ref('')
const installCommandBlocked = ref(true)
const collectInterval = ref(0)
const reportInterval = ref(60)
const wssReportInterval = ref(2)
const connectionMode = ref('auto')
const pingMode = ref('tcp')
const customCt = ref('')
const customCu = ref('')
const customCm = ref('')
const customBd = ref('')
const node1 = ref('')
const node2 = ref('')
const node3 = ref('')
const node4 = ref('')
const explicitEmptyNodes = ref({})
const networkInterface = ref('')
const resetDay = ref(1)
const rxCorrection = ref('')
const txCorrection = ref('')
const autoUpdate = ref(false)
const showAutoDiscoveryModal = ref(false)
const autoDiscoveryTargetOs = ref('linux')
const autoDiscoveryInstallMode = ref('current-user')
const autoDiscoveryName = ref('')
const autoDiscoveryVersion = ref('')
const autoDiscoveryAutoUpdate = ref(false)
const autoDiscoveryGhProxy = ref('')
const autoDiscoveryCopied = ref(false)
const autoDiscoveryBlocked = ref(true)
const registrationKey = ref('')
const registrationExpiresAt = ref(0)
const registrationError = ref('')
let registrationSequence = 0, registrationExpiryTimer = null
const clearRegistrationKey = () => {
  registrationSequence++
  clearTimeout(registrationExpiryTimer)
  registrationExpiryTimer = null
  registrationKey.value = registrationError.value = ''
  registrationExpiresAt.value = 0
  autoDiscoveryCopied.value = false
}
const prepareRegistrationKey = async () => {
  clearRegistrationKey()
  const sequence = registrationSequence, owner = requestOwner.value
  const current = () => sequence === registrationSequence && showAutoDiscoveryModal.value && owner() && savedAutoDiscovery.value
  try {
    const result = await adminApi({action:'node_prepare_registration'},selectedApiIndex.value,current)
    if (!current()) return
    if (result.error) throw new Error(result.error)
    const data = result.data
    if (!/^[a-f0-9]{64}$/.test(data?.key) || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 15 * 60 * 1000) throw new Error('node_registration_failed')
    registrationKey.value = data.key
    registrationExpiresAt.value = data.expiresAt
    registrationExpiryTimer = setTimeout(() => {
      if (!current()) return
      clearRegistrationKey()
      registrationError.value = 'node_registration_expired'
    },data.expiresAt - Date.now())
  } catch (error) { if (current()) registrationError.value = error.message }
}
watch([showAutoDiscoveryModal,savedAutoDiscovery], ([show,enabled]) => {
  if (!show || !enabled) { clearRegistrationKey(); showAutoDiscoveryModal.value = false }
}, {flush:'sync'})
onBeforeUnmount(clearRegistrationKey)

const isWssReportEnabled = computed(() => settings.value.wss_report_enabled === true)
const getEffectiveConnectionMode = (value) => {
  const connectionMode = value === 'http' ? 'http' : 'auto'
  return isWssReportEnabled.value ? connectionMode : 'http'
}

const getEffectivePingMode = (value) => value === 'icmp' ? 'icmp' : 'tcp'

watch(isWssReportEnabled, (enabled) => {
  if (!enabled) {
    editForm.value.connection_mode = 'http'
    connectionMode.value = 'http'
  }
})

const getPingNodeLabel = (field) => ({
  custom_ct: settings.value.custom_ct_name || trans.value.customCt,
  custom_cu: settings.value.custom_cu_name || trans.value.customCu,
  custom_cm: settings.value.custom_cm_name || trans.value.customCm,
  custom_bd: settings.value.custom_bd_name || trans.value.customBd
  ,node_1: settings.value.node_1_name || 'Node 1', node_2: settings.value.node_2_name || 'Node 2', node_3: settings.value.node_3_name || 'Node 3', node_4: settings.value.node_4_name || 'Node 4'
})[field] || field

const getPingNodeValidation = (source) => {
  const values = {}
  for (const field of PING_NODE_FIELDS) {
    const result = validatePingNode(source[field])
    if (!result.valid) {
      return { valid: false, field }
    }
    values[field] = result.value
  }
  return { valid: true, values }
}

const buildPingNodeError = (field) => `${getPingNodeLabel(field)}: ${trans.value.invalidPingNodeFormat}`

const copyServerNote = async (server) => {
  const note = String(server?.note || '')
  if (!note.trim()) return

  try {
    const copied = await copyTextToClipboard(note)
    if (!copied) {
      alertMessage.value = trans.value.httpsRequired
      return
    }
    copiedNoteServerId.value = server.id
    setTimeout(() => {
      if (copiedNoteServerId.value === server.id) {
        copiedNoteServerId.value = null
      }
    }, 1500)
  } catch (e) {
    console.error('[ERROR] Copy note failed:', e)
  }
}

const copyServerSpec = async ({ key, text } = {}) => {
  const value = String(text || '').trim()
  if (!key || !value || value === '-') return

  try {
    const copied = await copyTextToClipboard(value)
    if (!copied) {
      alertMessage.value = trans.value.httpsRequired
      return
    }
    copiedSpecKey.value = key
    setTimeout(() => {
      if (copiedSpecKey.value === key) {
        copiedSpecKey.value = null
      }
    }, 1500)
  } catch (e) {
    console.error('[ERROR] Copy spec failed:', e)
  }
}

const handleLogin = async () => {
  const generation = siteGeneration.value
  loginError.value = ''
  loginLoading.value = true

  if (turnstileLoginEnabled.value && !turnstileToken.value) {
    loginError.value = 'Please complete the verification'
    loginLoading.value = false
    return
  }

  if (turnstileEnabled.value && !turnstileVerified.value && !turnstileToken.value) {
    loginError.value = 'Please complete the verification'
    loginLoading.value = false
    return
  }

  const result = await login(loginForm.value.username, loginForm.value.password, turnstileToken.value, selectedApiIndex.value, requestOwner.value)
    if (generation !== siteGeneration.value) return
  if (!result.error) {
    isLoggedIn.value = true
    syncApiIndexQuery()
    clearTurnstile()
    turnstileVerified.value = hasSharedTurnstileVerified()
    await Promise.all([
      loadSettings(),
      loadServers(),
      loadLatestAgentVersion()
    ])
  } else {
    loginError.value = result.status === 403 ? 'Please complete the verification' : trans.value.errorInvalidUsername
    loginForm.value.password = ''
    clearTurnstile()
    resetTurnstile('#admin-turnstile-container')
  }
  loginLoading.value = false
}

const logout = async () => {
  terminalStatusLogout()
  siteGeneration.value++
  const generation = siteGeneration.value
  terminalServer.value = null
  closeTerminalSessions()
  try {
    await adminApiForSite({ action: 'logout' })
    if (generation !== siteGeneration.value) return
  } catch (_) {
    if (generation !== siteGeneration.value) return
  }
  apiLogout()
  isLoggedIn.value = false
  latestAgentVersion.value = ''
  clearTurnstile()
  await loadTurnstileConfig()
  window.location.href = '/'
}

const checkLoginStatus = () => {
  const token = localStorage.getItem(STORAGE.JWT_TOKEN)
  return !!token || appConfig?.authorization === true
}

const initAdmin = async () => {
  const hasCreds = checkLoginStatus()
  if (hasCreds) {
    isLoggedIn.value = true
    syncApiIndexQuery()
    const savedTurnstileToken = localStorage.getItem(STORAGE.TURNSTILE_TOKEN)
    if (savedTurnstileToken) {
      turnstileToken.value = savedTurnstileToken
    }
    await Promise.all([
      loadSettings(),
      loadServers(),
      loadLatestAgentVersion()
    ])
  } else {
    await loadTurnstileConfig()
  }
}

const loadTurnstileConfig = async () => {
  const owner = requestOwner.value
  await loadTurnstileConfigBase(selectedApiIndex.value, isMultipleMode.value, loginError, owner)
  if (!owner()) return
  if (turnstileSiteKey.value && (turnstileLoginEnabled.value || (turnstileEnabled.value && !turnstileVerified.value))) {
    await nextTick()
    if (!owner()) return
    renderTurnstile('#admin-turnstile-container', turnstileSiteKey.value, { requestOwner: owner })
  }
}

const handleApiIndexChange = async (newIndex) => {
  siteGeneration.value++
  loginLoading.value = false
  selectedApiIndex.value = newIndex
  syncApiIndexQuery()
  await nextTick()
  await loadTurnstileConfig()
}

const resetAdminContext = () => {
  notificationConfig.value = null
  terminalServer.value = null
  terminalStatuses.value = {}
  terminalInstallOptions.value = {selected:false, enabled:false, token:''}
  selectedServers.value = []
  showEditModal.value = false
  showDeleteModal.value = false
  showCopyModal.value = false
  showDbModal.value = false
  validationError.value = null
  validationField.value = ''
  settings.value = structuredClone(defaultSettings)
  servers.value = []
  stats.value = { total: '-', online: 0, offline: 0, avg_cpu: 0 }
  groups.value = []
  latestAgentVersion.value = ''
  changeAdminPassword.value = false
  newServerName.value = ''
  newServerGroup.value = ''
  showAddModal.value = false
  showGroupModal.value = showRenewModal.value = false
  showBatchEditModal.value = false
  showAutoDiscoveryModal.value = false
  showAutoUpdateWarning.value = false
  autoUpdatePendingEnable.value = false
  editForm.value = {}
  batchEditForm.value = createBatchEditDefaults()
  batchEditEnabled.value = Object.fromEntries(Object.keys(createBatchEditDefaults()).map(field => [field, false]))
  saveResult.value = null
  alertMessage.value = null
  d1UsageResult.value = null
  dbResult.value = null
  saving.value = adding.value = editSaving.value = deleting.value = batchEditing.value = cacheRefreshing.value = dbLoading.value = d1UsageLoading.value = false
  savedAutoDiscovery.value = false
  loginForm.value = { username: '', password: '' }
  copiedServerId.value = copiedNoteServerId.value = copiedSpecKey.value = null
  copyServerId.value = currentServerName.value = deleteServerId.value = ''
  targetOs.value = deleteTargetOs.value = autoDiscoveryTargetOs.value = 'linux'
  installMode.value = deleteInstallMode.value = autoDiscoveryInstallMode.value = 'current-user'
  installGhProxy.value = deleteGhProxy.value = autoDiscoveryGhProxy.value = ''
  installVersion.value = autoDiscoveryVersion.value = autoDiscoveryName.value = ''
  customCt.value = customCu.value = customCm.value = customBd.value = ''
  node1.value = node2.value = node3.value = node4.value = ''
  networkInterface.value = rxCorrection.value = txCorrection.value = ''
  explicitEmptyNodes.value = {}
  collectInterval.value = 0
  reportInterval.value = 60
  wssReportInterval.value = 2
  resetDay.value = 1
  connectionMode.value = 'auto'
  pingMode.value = 'tcp'
  autoUpdate.value = autoDiscoveryAutoUpdate.value = autoDiscoveryCopied.value = uninstallCopied.value = false
  orderRevision++
  orderSaving = Promise.resolve()
}

const switchAdminSite = async () => {
  const generation = ++siteGeneration.value
  resetAdminContext()
  adminSiteLoading.value = true
  try {
    await Promise.all([
      loadSettings(),
      loadServers(),
      loadLatestAgentVersion()
    ])
  } finally {
    if (generation === siteGeneration.value) adminSiteLoading.value = false
  }
}

const handleAdminApiIndexChange = async () => {
  syncApiIndexQuery()
  await switchAdminSite()
}

const getStartupConfigForCurrentSite = () => {
  if (startupConfigConsumed) return null
  if (selectedApiIndex.value !== 0) return null
  if (!appConfig || typeof appConfig !== 'object' || Object.keys(appConfig).length === 0) return null
  startupConfigConsumed = true
  return appConfig
}

const loadLatestAgentVersion = async () => {
  const generation = siteGeneration.value
  try {
    const startupConfig = getStartupConfigForCurrentSite()
    const owner = requestOwner.value
    const config = startupConfig || await fetchConfig(selectedApiIndex.value, owner)
    if (!owner()) return
    const configVersion = normalizeVersion(config?.last_agent_version)
    const version = configVersion || await fetchLatestAgentReleaseVersion()
    if (generation === siteGeneration.value) latestAgentVersion.value = version
  } catch (e) {
    console.error('[ERROR] Load latest agent version failed:', e)
    const version = await fetchLatestAgentReleaseVersion()
    if (generation === siteGeneration.value) latestAgentVersion.value = version
  }
}

const loadSettings = async () => {
  const generation = siteGeneration.value
  try {
    const result = await adminApiForSite({ action: 'get_settings' })
    if (generation !== siteGeneration.value) return
    if (!result.error) {
      const data = result.data
      const settingsData = data.settings || {}
      settings.value = {
        site_title: settingsData.site_title || '',
        custom_bg: settingsData.custom_bg || '',
        custom_bg_mobile: settingsData.custom_bg_mobile || '',
        favicon: settingsData.favicon || '',
        custom_head: settingsData.custom_head || '',
        custom_script: settingsData.custom_script || '',
        display_mode: resolveDisplayMode(settingsData),
        preferred_theme: normalizePreferredThemeSetting(settingsData.preferred_theme),
        default_language: normalizeDefaultLanguageSetting(settingsData.default_language),
        theme_options: formatThemeOptions(settingsData.theme_options),
        auto_discovery: settingsData.auto_discovery === 'true' || settingsData.auto_discovery === true,
        is_public: settingsData.is_public === 'true',
        show_price: settingsData.show_price === 'true',
        show_expire: settingsData.show_expire === 'true',
        show_tf: settingsData.show_tf === 'true',
        show_three_net_details: settingsData.show_three_net_details === 'true' || settingsData.show_three_net_details === true,
        wss_report_enabled: settingsData.wss_report_enabled === 'true' || settingsData.wss_report_enabled === true,
        wss_report_hours: normalizeWssReportHoursSetting(settingsData.wss_report_hours),
        frontend_ws_timeout_minutes: normalizeFrontendWsTimeoutMinutesSetting(settingsData.frontend_ws_timeout_minutes),
        long_history_points: normalizeLongHistoryPointsSetting(settingsData.long_history_points),
        turnstile_enabled: settingsData.turnstile_enabled === 'true',
        turnstile_login_enabled: settingsData.turnstile_login_enabled === 'true',
        turnstile_site_key: settingsData.turnstile_site_key || '',
        turnstile_secret_key: settingsData.turnstile_secret_key || '',
        cloudflare_account_id: settingsData.cloudflare_account_id || '',
        cloudflare_token: settingsData.cloudflare_token || '',
        jwt_secret: '',
        username: settingsData.username || '',
        password_configured: settingsData.password_configured === true,
        password: '',
        confirm_password: '',
        custom_ct: settingsData.custom_ct || '',
        custom_cu: settingsData.custom_cu || '',
        custom_cm: settingsData.custom_cm || '',
        custom_bd: settingsData.custom_bd || '',
        node_1: settingsData.node_1 || '', node_2: settingsData.node_2 || '', node_3: settingsData.node_3 || '', node_4: settingsData.node_4 || '',
        custom_ct_name: settingsData.custom_ct_name || '电信',
        custom_cu_name: settingsData.custom_cu_name || '联通',
        custom_cm_name: settingsData.custom_cm_name || '移动',
        custom_bd_name: settingsData.custom_bd_name || 'BGP',
        node_1_name: settingsData.node_1_name || 'Node 1', node_2_name: settingsData.node_2_name || 'Node 2', node_3_name: settingsData.node_3_name || 'Node 3', node_4_name: settingsData.node_4_name || 'Node 4',
        theme_url: settingsData.theme_url || '',
        terminal_enabled: settingsData.terminal_enabled === true || settingsData.terminal_enabled === 'true',
        csp_static: settingsData.csp_static || '',
        csp_api: settingsData.csp_api || '',
        ua: settingsData.ua || 'cfsm'
      }
      applyMikusThemeOptions(settingsData.theme_options)
      changeAdminPassword.value = !settings.value.password_configured || !String(settings.value.username || '').trim()
      // 只有已保存到服务端的自动发现开关才提供复制安装命令，避免复制出当前并未生效的命令
      savedAutoDiscovery.value = settings.value.auto_discovery
    }
  } catch (e) {
    if (generation !== siteGeneration.value) return
    console.error('[ERROR] Load settings failed:', e)
  }
}

const handleThemeOptionsApplied = (themeOptions) => {
  settings.value.theme_options = formatThemeOptions(themeOptions)
  applyMikusThemeOptions(themeOptions)
}

watch(
  () => settings.value.username,
  () => {
    if (isAdminUsernameEmpty()) {
      changeAdminPassword.value = true
    }
  }
)

const saveSettings = async () => {
  const generation = siteGeneration.value
  if (saving.value) return

  validationError.value = null
  validationField.value = ''

  if (settingsPanelRef.value?.userAgentInvalid) {
    invalidSettingsField(trans.value.invalidUserAgent, 'security', 'ua')
    return
  }

  const jwtSecret = settings.value.jwt_secret
  if (jwtSecret && jwtSecret.length > 0 && jwtSecret.length < 32) {
    invalidSettingsField(trans.value.jwtSecretMinLength, 'security', 'jwt_secret')
    return
  }

  if (jwtSecret && /\s/.test(jwtSecret)) {
    invalidSettingsField(trans.value.jwtSecretNoWhitespace, 'security', 'jwt_secret')
    return
  }

  if (!settings.value.username || settings.value.username.trim().length === 0) {
    invalidSettingsField(trans.value.usernameRequired, 'security', 'username')
    return
  }

  const frontendWsTimeoutMinutes = Number(settings.value.frontend_ws_timeout_minutes)
  if (!Number.isInteger(frontendWsTimeoutMinutes) || frontendWsTimeoutMinutes < 0 || frontendWsTimeoutMinutes > FRONTEND_WS_TIMEOUT_MINUTES_MAX) {
    invalidSettingsField(trans.value.invalidFrontendWsTimeoutMinutes, 'collection', 'frontend_ws_timeout_minutes')
    return
  }

  const shouldChangePassword = changeAdminPassword.value && (
    settings.value.password.length > 0 ||
    settings.value.confirm_password.length > 0
  )

  if (!settings.value.password_configured && !shouldChangePassword) {
    changeAdminPassword.value = true
    invalidSettingsField(trans.value.passwordRequired, 'security', 'password')
    return
  }

  if (shouldChangePassword) {
    if (settings.value.password !== settings.value.confirm_password) {
      invalidSettingsField(trans.value.passwordMismatch, 'security', 'confirm_password')
      return
    }
  }

  if (settings.value.turnstile_enabled || settings.value.turnstile_login_enabled) {
    if (!settings.value.turnstile_site_key || settings.value.turnstile_site_key.trim().length === 0) {
      invalidSettingsField(trans.value.turnstileSiteKeyRequired, 'security', 'turnstile_site_key')
      return
    }
    if (!settings.value.turnstile_secret_key || settings.value.turnstile_secret_key.trim().length === 0) {
      invalidSettingsField(trans.value.turnstileSecretKeyRequired, 'security', 'turnstile_secret_key')
      return
    }
  }

  const pingNodeValidation = getPingNodeValidation(settings.value)
  if (!pingNodeValidation.valid) {
    invalidSettingsField(buildPingNodeError(pingNodeValidation.field), 'collection', pingNodeValidation.field)
    return
  }

  const themeOptionsResult = parseThemeOptions(settings.value.theme_options)
  if (!themeOptionsResult.valid) {
    invalidSettingsField(trans.value.invalidThemeOptionsFormat, 'themeStore', 'theme_options')
    return
  }

  if (settingsPanelRef.value) {
    const cspStaticValid = settingsPanelRef.value.validateCspField('csp_static')
    const cspApiValid = settingsPanelRef.value.validateCspField('csp_api')
    if (!cspStaticValid || !cspApiValid) {
      invalidSettingsField(trans.value.cspInvalidDomain, 'themeStore', !cspStaticValid ? 'csp_static' : 'csp_api')
      return
    }
  }

  saving.value = true
  saveResult.value = null

  const data = {
    action: 'save_settings',
    settings: {
      site_title: settings.value.site_title,
      custom_bg: settings.value.custom_bg,
      custom_bg_mobile: settings.value.custom_bg_mobile,
      favicon: settings.value.favicon,
      custom_head: settings.value.custom_head,
      custom_script: settings.value.custom_script,
      display_mode: normalizeDisplayMode(settings.value.display_mode),
      preferred_theme: normalizePreferredThemeSetting(settings.value.preferred_theme),
      default_language: normalizeDefaultLanguageSetting(settings.value.default_language),
      appearance_options: {
        theme_options: themeOptionsResult.value
      },
      auto_discovery: settings.value.auto_discovery ? 'true' : 'false',
      is_public: settings.value.is_public ? 'true' : 'false',
      show_price: settings.value.show_price ? 'true' : 'false',
      show_expire: settings.value.show_expire ? 'true' : 'false',
      show_tf: settings.value.show_tf ? 'true' : 'false',
      show_three_net_details: settings.value.show_three_net_details ? 'true' : 'false',
      wss_report_enabled: settings.value.wss_report_enabled ? 'true' : 'false',
      wss_report_hours: normalizeWssReportHoursSetting(settings.value.wss_report_hours),
      frontend_ws_timeout_minutes: String(frontendWsTimeoutMinutes),
      long_history_points: normalizeLongHistoryPointsSetting(settings.value.long_history_points),
      turnstile_enabled: settings.value.turnstile_enabled ? 'true' : 'false',
      turnstile_login_enabled: settings.value.turnstile_login_enabled ? 'true' : 'false',
      turnstile_site_key: settings.value.turnstile_site_key,
      turnstile_secret_key: settings.value.turnstile_secret_key,
      cloudflare_account_id: settings.value.cloudflare_account_id,
      cloudflare_token: settings.value.cloudflare_token,
      username: settings.value.username,
      custom_ct: pingNodeValidation.values.custom_ct,
      custom_cu: pingNodeValidation.values.custom_cu,
      custom_cm: pingNodeValidation.values.custom_cm,
      custom_bd: pingNodeValidation.values.custom_bd,
      node_1: pingNodeValidation.values.node_1, node_2: pingNodeValidation.values.node_2, node_3: pingNodeValidation.values.node_3, node_4: pingNodeValidation.values.node_4,
      custom_ct_name: settings.value.custom_ct_name.trim(),
      custom_cu_name: settings.value.custom_cu_name.trim(),
      custom_cm_name: settings.value.custom_cm_name.trim(),
      custom_bd_name: settings.value.custom_bd_name.trim(),
      node_1_name: settings.value.node_1_name.trim(), node_2_name: settings.value.node_2_name.trim(), node_3_name: settings.value.node_3_name.trim(), node_4_name: settings.value.node_4_name.trim(),
      csp_static: settings.value.csp_static || '',
      csp_api: settings.value.csp_api || '',
      ua: String(settings.value.ua ?? '').trim()
    }
  }

  if (shouldChangePassword && settings.value.password.length > 0) {
    data.settings.password = settings.value.password
  }

  if (jwtSecret && jwtSecret.length > 0) {
    data.settings.jwt_secret = jwtSecret
  }

  try {
    const result = await adminApiForSite(data)
    if (generation !== siteGeneration.value) return
    if (!result.error) {
      saveResult.value = { success: true }
      applyMikusThemeOptions(themeOptionsResult.value)
      clearAdminPasswordInputs()
      changeAdminPassword.value = false
      settings.value.jwt_secret = ''
      loadSettings()
    } else {
      saveResult.value = { success: false, error: getMessage(result.error) || 'fail' }
    }
  } catch (e) {
    if (generation !== siteGeneration.value) return
    saveResult.value = { success: false, error: e.message }
  } finally {
    if (generation === siteGeneration.value) {
    saving.value = false
      }
  }
}


const loadServers = async (options = {}) => {
  const generation = siteGeneration.value
  const revision = options.orderRevision ?? orderRevision
  try {
    const result = await adminApiForSite(options.refresh ? { action: 'list', refresh: true } : { action: 'list' })
    if (generation !== siteGeneration.value || revision !== orderRevision) return
    if (!result.error) {
      const data = result.data
      servers.value = data.servers || []
      const currentIds = new Set(servers.value.map(server => server.id))
      selectedServers.value = selectedServers.value.filter(id => currentIds.has(id))
      stats.value = data.stats || { total: servers.value.length, online: 0, offline: servers.value.length, avg_cpu: 0 }

      const serverGroups = [...new Set(servers.value.map(s => s.server_group || trans.value.default))]
      groups.value = serverGroups
      await refreshTerminalStatuses()
    }
    return result
  } catch (e) {
    if (generation !== siteGeneration.value) return
    console.error('[ERROR] Load servers failed:', e)
    return { error: e.message }
  }
}

// 清除 Workers 端服务器列表缓存并就地重新拉取（list 带 refresh 时服务端先清缓存再读 D1）
const refreshServersCache = async () => {
  const generation = siteGeneration.value
  if (cacheRefreshing.value) return
  cacheRefreshing.value = true
  try {
    const result = await loadServers({ refresh: true })
    if (generation !== siteGeneration.value) return
    if (result?.error) {
      alertMessage.value = getMessage(result.error) || result.error || trans.value.operationFailed
      return
    }
    alertMessage.value = trans.value.cacheCleared
  } finally {
    if (generation === siteGeneration.value) {
    cacheRefreshing.value = false
      }
  }
}

const refreshServers = async () => {
  await Promise.all([
    loadServers(),
    loadLatestAgentVersion()
  ])
}

const addServer = async () => {
  const generation = siteGeneration.value
  if (adding.value) return
  addError.value = ''
  const name = newServerName.value.trim()
  if (!name) {
    addError.value = trans.value.enterServerName
    return
  }

  try {
    adding.value = true
    const result = await adminApiForSite({ action: 'add', name, server_group: newServerGroup.value })
    if (generation !== siteGeneration.value) return
    if (!result.error) {
      saveResult.value = { success: true, message: getMessage(result.data.message) || trans.value.serverAdded }
      showAddModal.value = false
      newServerName.value = ''
      newServerGroup.value = ''
      loadServers()
    } else {
      addError.value = getMessage(result.error) || trans.value.operationFailed
    }
  } catch (e) {
    if (generation !== siteGeneration.value) return
    addError.value = e.message
  } finally {
    if (generation === siteGeneration.value) {
    adding.value = false
      }
  }
}

const resolveServerPingNode = (server, field) => {
  const value = server?.[field]
  const explicitEmpty = value === 0 || value === '0'
  return {
    value: explicitEmpty ? '' : (value || settings.value[field] || ''),
    explicitEmpty
  }
}

const getUninstallCommand = () => {
  const HOST = selectedApiBase.value
  const isGo = deleteVersion.value === 'go'
  const proxy = isGo ? deleteGhProxy.value.trim() : ''
  if (isGo) {
    if (deleteTargetOs.value === 'windows') {
      const ghUrl = buildGhRawUrl(proxy, `/${AGENT_REPOSITORY}/${AGENT_INSTALL_REF}/install.ps1`)
      const proxyParam = proxy ? ` --install-ghproxy=${quotePowerShellArg(proxy)}` : ''
      return `$script = "$env:TEMP\\install-cf-probe.ps1"; Invoke-WebRequest -Uri ${quotePowerShellArg(ghUrl)} -OutFile $script -UseBasicParsing; PowerShell -ExecutionPolicy Bypass -File $script uninstall${proxyParam}`
    }
    const sudoPrefix = deleteTargetOs.value === 'mac' ? 'sudo ' : ''
    const ghUrl = buildGhRawUrl(proxy, `/${AGENT_REPOSITORY}/${AGENT_INSTALL_REF}/install.sh`)
    const proxyParam = proxy ? ` --install-ghproxy=${quotePosixShellArg(proxy)}` : ''
    const uninstallCommand = `curl -fsSL ${quotePosixShellArg(ghUrl)} | ${sudoPrefix}sh -s -- uninstall${proxyParam}`
    if (deleteTargetOs.value === 'linux' && deleteInstallMode.value === 'cfsm-user') {
      return buildUninstallAsCfsmCommand(uninstallCommand)
    }
    return uninstallCommand
  }
  if (deleteTargetOs.value === 'windows') {
    return `$script = Join-Path (Get-Location) 'uninstall-cf-probe.ps1'; Invoke-WebRequest -Uri '${HOST}/uninstall.ps1' -OutFile $script -UseBasicParsing; PowerShell -ExecutionPolicy Bypass -File $script`
  }
  return `curl -fsSL '${HOST}/uninstall.sh' | sh -s`
}

const copyCmd = (serverId) => {
  const server = servers.value.find(s => s.id === serverId)
  copyServerId.value = serverId
  currentServerName.value = server?.name || ''
  targetOs.value = 'linux'
  installMode.value = 'current-user'
  installGhProxy.value = ''
  installVersion.value = ''
  collectInterval.value = server?.collect_interval ?? 0
  reportInterval.value = server?.report_interval || 60
  wssReportInterval.value = server?.wss_report_interval || 2
  connectionMode.value = getEffectiveConnectionMode(server?.connection_mode)
  pingMode.value = getEffectivePingMode(server?.ping_mode)
  const customCtNode = resolveServerPingNode(server, 'custom_ct')
  const customCuNode = resolveServerPingNode(server, 'custom_cu')
  const customCmNode = resolveServerPingNode(server, 'custom_cm')
  const customBdNode = resolveServerPingNode(server, 'custom_bd')
  const node1Value = resolveServerPingNode(server, 'node_1')
  const node2Value = resolveServerPingNode(server, 'node_2')
  const node3Value = resolveServerPingNode(server, 'node_3')
  const node4Value = resolveServerPingNode(server, 'node_4')
  explicitEmptyNodes.value = {
    custom_ct: customCtNode.explicitEmpty, custom_cu: customCuNode.explicitEmpty,
    custom_cm: customCmNode.explicitEmpty, custom_bd: customBdNode.explicitEmpty,
    node_1: node1Value.explicitEmpty, node_2: node2Value.explicitEmpty,
    node_3: node3Value.explicitEmpty, node_4: node4Value.explicitEmpty
  }
  customCt.value = customCtNode.value
  customCu.value = customCuNode.value
  customCm.value = customCmNode.value
  customBd.value = customBdNode.value
  node1.value = node1Value.value
  node2.value = node2Value.value
  node3.value = node3Value.value
  node4.value = node4Value.value
  networkInterface.value = server?.interface || ''
  resetDay.value = server?.reset_day ?? 1
  rxCorrection.value = server?.rx_correction ?? ''
  txCorrection.value = server?.tx_correction ?? ''
  autoUpdate.value = server?.auto_update === '1' || server?.auto_update === 1 || server?.auto_update === true
  installCommandBlocked.value = true
  showCopyModal.value = true
}

const buildGhRawUrl = (proxy, path) => {
  const base = 'https://raw.githubusercontent.com'
  if (!proxy) return `${base}${path}`
  const cleanProxy = proxy.replace(/\/$/, '')
  return `${cleanProxy}/${base}${path}`
}

const quotePosixShellArg = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`

const quotePowerShellArg = (value) => `'${String(value).replaceAll("'", "''")}'`

const quotePosixDoubleShellArg = (value) => `"${String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll('"', '\\"')
  .replaceAll('$', '\\$')
  .replaceAll('`', '\\`')}"`

const buildUninstallAsCfsmCommand = (command) => {
  const runuserCommand = `runuser -u cfsm -- env HOME="\${CFSM_HOME}" XDG_RUNTIME_DIR="/run/user/\${CFSM_UID}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/\${CFSM_UID}/bus" sh -c ${quotePosixDoubleShellArg(command)}`
  return [
    '(',
    'set -e',
    `if ! command -v runuser >/dev/null 2>&1; then echo ${quotePosixDoubleShellArg(trans.value.dedicatedUserUninstallUnsupported)} >&2; exit 1; fi`,
    `id cfsm >/dev/null 2>&1 || { echo ${quotePosixDoubleShellArg(trans.value.nonRootUninstallUserMissing)} >&2; exit 1; }`,
    'CFSM_UID=$(id -u cfsm)',
    'CFSM_HOME=$(getent passwd cfsm | cut -d: -f6); [ -n "${CFSM_HOME}" ] || CFSM_HOME=/home/cfsm',
    'if [ "$(id -u)" -eq 0 ]; then',
    `  ${runuserCommand}`,
    'elif command -v sudo >/dev/null 2>&1; then',
    `  sudo ${runuserCommand}`,
    'else',
    `  echo ${quotePosixDoubleShellArg(trans.value.nonRootInstallSudoRequired)} >&2; exit 1`,
    'fi',
    ')'
  ].join('\n')
}

const buildInstallAsCfsmCommand = (command, runStep) => {
  const lines = [
    '(',
    'set -e',
    `if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1 || ! command -v loginctl >/dev/null 2>&1 || ! command -v useradd >/dev/null 2>&1 || ! command -v runuser >/dev/null 2>&1; then echo ${quotePosixDoubleShellArg(trans.value.dedicatedUserSystemdRequired)} >&2; exit 1; fi`,
    'if [ "$(id -u)" -eq 0 ]; then',
    '  as_root() { "$@"; }',
    'elif command -v sudo >/dev/null 2>&1; then',
    '  as_root() { sudo "$@"; }',
    'else',
    `  echo ${quotePosixDoubleShellArg(trans.value.nonRootInstallSudoRequired)} >&2; exit 1`,
    'fi'
  ]

  lines.push(
    'id cfsm >/dev/null 2>&1 || as_root useradd -m -s /bin/sh cfsm',
    'as_root loginctl enable-linger cfsm'
  )

  lines.push(
    'CFSM_UID=$(id -u cfsm)',
    'as_root systemctl start user@${CFSM_UID}.service',
    'if command -v getent >/dev/null 2>&1; then CFSM_HOME=$(getent passwd cfsm | cut -d: -f6); else CFSM_HOME=/home/cfsm; fi; [ -n "${CFSM_HOME}" ] || CFSM_HOME=/home/cfsm',
    '',
    `# ${runStep}`,
    `as_root runuser -u cfsm -- env HOME="\${CFSM_HOME}" XDG_RUNTIME_DIR="/run/user/\${CFSM_UID}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/\${CFSM_UID}/bus" sh -c ${quotePosixDoubleShellArg(command)}`,
    ')'
  )
  return lines.join('\n')
}

// 站点 UA 不是默认值时，安装命令必须带上：否则首次上报就会被 /update 的防火墙规则拦截，
// 连自动发现都无法完成。
const installUserAgent = () => {
  const ua = String(settings.value.ua ?? '').trim()
  return ua && ua !== 'cfsm' ? ua : ''
}

const getCustomInstallCommand = () => {
  if (installCommandBlocked.value || !/^[a-f0-9]{64}$/.test(terminalInstallOptions.value.token)) return ''
  const terminalOptions = terminalInstallOptions.value
  if (terminalOptions.selected && !terminalOptions.enabled) return ''
  const HOST = selectedApiBase.value
  const autoUpdateFlag = autoUpdate.value ? 1 : 0
  const proxy = installGhProxy.value.trim()
  const version = installVersion.value.trim()
  const isDedicatedUserInstall = targetOs.value === 'linux' && installMode.value === 'cfsm-user'
  // 安装命令只保留必须写入本地的参数：id / node token / url / auto_update，
  // 以及站点 UA 非默认值时的 -ua（否则首次上报就会被 /update 的防火墙规则拦下）。
  // collect_interval、interval、connection_mode、ping_mode、reset_day、ct/cu/cm/bd、node_1..4、interface、rx/tx_correction
  // 等属于后端 /api 动态下发的配置（见 agentConfig.buildAgentConfig），Agent 启动后会自动拉取，无需写进安装命令。
  if (targetOs.value === 'windows') {
    const params = [
      'install'
    ]
    if (proxy) params.push(`--install-ghproxy=${quotePowerShellArg(proxy)}`)
    if (version) params.push(`--install-version=${quotePowerShellArg(version)}`)
    params.push(
      `-id=${quotePowerShellArg(copyServerId.value)}`,
      `--install-node-token=${quotePowerShellArg(terminalOptions.token)}`,
      `-url=${quotePowerShellArg(`${HOST}/update`)}`,
      `-auto_update='${autoUpdateFlag}'`
    )
    params.push('-terminal=0')
    const ua = installUserAgent()
    if (ua) params.push(`-ua=${quotePowerShellArg(ua)}`)
    const ghUrl = buildGhRawUrl(proxy, `/${AGENT_REPOSITORY}/${AGENT_INSTALL_REF}/install.ps1`)
    return `$script = "$env:TEMP\\install-cf-probe.ps1"; Invoke-WebRequest -Uri ${quotePowerShellArg(ghUrl)} -OutFile $script -UseBasicParsing; PowerShell -ExecutionPolicy Bypass -File $script ${params.join(' ')}`
  }
  if (targetOs.value === 'docker') {
    const safeTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version) ? version : 'latest'
    const image = `ghcr.io/${AGENT_REPOSITORY}:${safeTag}`
    const ua = installUserAgent()
    const uaEnv = (ua ? ` -e UA=${quotePosixShellArg(ua)}` : '') + ' -e TERMINAL_ENABLED=0'
    return [
      'docker run -d --name cf-probe --restart=unless-stopped --network=host \\',
      '  -v cf-probe-data:/data \\',
      `  -e SERVER_ID=${quotePosixShellArg(copyServerId.value)} -e NODE_TOKEN=${quotePosixShellArg(terminalOptions.token)} -e WORKER_URL=${quotePosixShellArg(`${HOST}/update`)}${uaEnv} \\`,
      `  ${image}`
    ].join('\n')
  }
  const params = ['install']
  if (proxy) params.push(`--install-ghproxy=${quotePosixShellArg(proxy)}`)
  if (version) params.push(`--install-version=${quotePosixShellArg(version)}`)
  params.push(
    `-id=${quotePosixShellArg(copyServerId.value)}`,
    `--install-node-token=${quotePosixShellArg(terminalOptions.token)}`,
    `-url=${quotePosixShellArg(`${HOST}/update`)}`,
    `-auto_update=${autoUpdateFlag}`
  )
  params.push(`-terminal=${terminalOptions.enabled ? 1 : 0}`)
  const ua = installUserAgent()
  if (ua) params.push(`-ua=${quotePosixShellArg(ua)}`)
  const ghUrl = buildGhRawUrl(proxy, `/${AGENT_REPOSITORY}/${AGENT_INSTALL_REF}/install.sh`)
  const installCommand = `curl -fsSL ${quotePosixShellArg(ghUrl)} | sh -s -- ${params.join(' ')}`
  if (targetOs.value === 'mac' && version && version !== 'latest') return `test "$(uname -s)" = Darwin && ${installCommand}`
  if (!isDedicatedUserInstall) return installCommand

  return buildInstallAsCfsmCommand(installCommand, trans.value.nonRootInstallRunStep)
}

// 自动发现命令先用短期 key 注册新节点，再用返回的独立 token 上报。
// name 留空时服务端回退到请求来源 IP；安装用户、代理、版本、名称与自动更新仅影响本次生成的命令。
const isValidRegistrationName = name => typeof name === 'string' && name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(name)
const buildAutoDiscoveryCommand = ({ targetOs: os = 'linux', installMode: mode = 'current-user', ghProxy = '', name = '', version = '', autoUpdate = false } = {}) => {
  if (!isValidRegistrationName(name)) return ''
  const HOST = selectedApiBase.value
  const proxy = String(ghProxy || '').trim()
  const agentVersion = String(version || '').trim()
  const autoUpdateFlag = autoUpdate ? 1 : 0
  const serverName = name.trim()

  if (os === 'windows') {
    const params = ['install']
    if (proxy) params.push(`--install-ghproxy=${quotePowerShellArg(proxy)}`)
    if (agentVersion) params.push(`--install-version=${quotePowerShellArg(agentVersion)}`)
    params.push(
      `-register-key=${quotePowerShellArg(registrationKey.value)}`,
      `-url=${quotePowerShellArg(`${HOST}/update`)}`,
      `-auto_update='${autoUpdateFlag}'`
    )
    params.push('-terminal=0')
    if (serverName) params.push(`-name=${quotePowerShellArg(serverName)}`)
    const ua = installUserAgent()
    if (ua) params.push(`-ua=${quotePowerShellArg(ua)}`)
    const ghUrl = buildGhRawUrl(proxy, `/${AGENT_REPOSITORY}/${AGENT_INSTALL_REF}/install.ps1`)
    return `$script = "$env:TEMP\\install-cf-probe.ps1"; Invoke-WebRequest -Uri ${quotePowerShellArg(ghUrl)} -OutFile $script -UseBasicParsing; PowerShell -ExecutionPolicy Bypass -File $script ${params.join(' ')}`
  }

  const params = ['install']
  if (proxy) params.push(`--install-ghproxy=${quotePosixShellArg(proxy)}`)
  if (agentVersion) params.push(`--install-version=${quotePosixShellArg(agentVersion)}`)
  params.push(
    `-register-key=${quotePosixShellArg(registrationKey.value)}`,
    `-url=${quotePosixShellArg(`${HOST}/update`)}`,
    `-auto_update=${autoUpdateFlag}`
  )
  params.push('-terminal=0')
  if (serverName) params.push(`-name=${quotePosixShellArg(serverName)}`)
  const ua = installUserAgent()
  if (ua) params.push(`-ua=${quotePosixShellArg(ua)}`)
  const ghUrl = buildGhRawUrl(proxy, `/${AGENT_REPOSITORY}/${AGENT_INSTALL_REF}/install.sh`)
  const installCommand = `curl -fsSL ${quotePosixShellArg(ghUrl)} | sh -s -- ${params.join(' ')}`
  if (os !== 'linux' || mode !== 'cfsm-user') return installCommand

  return buildInstallAsCfsmCommand(installCommand, trans.value.nonRootInstallRunStep)
}

const getAutoDiscoveryInstallCommand = () => !registrationKey.value || registrationExpiresAt.value <= Date.now() || autoDiscoveryBlocked.value ? '' : buildAutoDiscoveryCommand({
  targetOs: autoDiscoveryTargetOs.value,
  installMode: autoDiscoveryInstallMode.value,
  ghProxy: autoDiscoveryGhProxy.value,
  name: autoDiscoveryName.value,
  version: autoDiscoveryVersion.value,
  autoUpdate: autoDiscoveryAutoUpdate.value
})

const openAutoDiscoveryModal = () => {
  if (!savedAutoDiscovery.value) {
    alertMessage.value = trans.value.autoAddDisabledTip
    return
  }

  autoDiscoveryCopied.value = false
  showAutoDiscoveryModal.value = true
  void prepareRegistrationKey()
}

const closeAutoDiscoveryModal = () => {
  showAutoDiscoveryModal.value = false
}

const copyAutoDiscoveryCmd = async () => {
  const command = getAutoDiscoveryInstallCommand()
  if (!command) return
  const sequence = registrationSequence, owner = requestOwner.value
  const copied = await copyTextToClipboard(command)
  if (sequence !== registrationSequence || !showAutoDiscoveryModal.value || !owner()) return
  if (!copied) {
    alertMessage.value = trans.value.httpsRequired
    return
  }

  autoDiscoveryCopied.value = true
  setTimeout(() => {
    autoDiscoveryCopied.value = false
  }, 1500)
}

const copyCustomCmd = async () => {
  const cmd = getCustomInstallCommand()
  if (!cmd) return
  const owner = requestOwner.value, serverId = copyServerId.value
  const copied = await copyTextToClipboard(cmd)
  if (!owner() || !showCopyModal.value || serverId !== copyServerId.value) return
  if (!copied) {
    alertMessage.value = trans.value.httpsRequired
    return
  }
}

const closeCopyModal = () => {
  showCopyModal.value = false
  terminalInstallOptions.value = {selected:false, enabled:false, token:''}
  void refreshTerminalStatuses()
}

const copyUninstallCmd = async () => {
  const cmd = getUninstallCommand()
  const copied = await copyTextToClipboard(cmd)
  if (!copied) {
    alertMessage.value = trans.value.httpsRequired
    return
  }

  uninstallCopied.value = true
  setTimeout(() => {
    uninstallCopied.value = false
  }, 1500)
}

// 逐台月流量告警阈值：空/未设置 → null（跟随全局）；否则夹取 0..100 整数（0 = 该服务器显式关闭）
const normalizeTrafficAlertPercentField = (value) => {
  if (value === '' || value === null || value === undefined) return null
  const n = parseInt(value, 10)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}

const createEditFormFromServer = (server) => ({
    id: server.id,
    name: server.name || '',
    server_group: server.server_group || '',
    region: server.region_override ?? (server.region || ''),
    tags: server.tags || '',
    note: server.note || '',
    price: normalizePrice(server.price),
    billing_cycle: normalizeBillingCycle(detectBillingCycle(server.price) || server.billing_cycle),
    auto_renewal: server.auto_renewal === '1' || server.auto_renewal === 1 || server.auto_renewal === true,
    currency: normalizeCurrency(server.currency || detectCurrencySymbol(server.price) || '¥'),
    expire_date: server.expire_date || '',
    traffic_limit: server.traffic_limit || '',
    traffic_calc_type: server.traffic_calc_type || 'total',
    traffic_alert_percent: server.traffic_alert_percent ?? '',
    interface: server.interface || '',
    reset_day: server.reset_day ?? 1,
    collect_interval: server.collect_interval ?? 0,
    report_interval: server.report_interval || 60,
    wss_report_interval: server.wss_report_interval || 2,
    connection_mode: getEffectiveConnectionMode(server.connection_mode),
    ping_mode: server.ping_mode === 'icmp' ? 'icmp' : 'tcp',
    custom_ct: server.custom_ct ?? '',
    custom_cu: server.custom_cu ?? '',
    custom_cm: server.custom_cm ?? '',
    custom_bd: server.custom_bd ?? '',
    node_1: server.node_1 ?? '', node_2: server.node_2 ?? '', node_3: server.node_3 ?? '', node_4: server.node_4 ?? '',
    rx_correction: server.rx_correction ?? '',
    tx_correction: server.tx_correction ?? '',
    auto_update: server.auto_update === '1' || server.auto_update === 1 || server.auto_update === true,
    is_hidden: server.is_hidden === '1',
    offline_notify_disabled: server.offline_notify_disabled === '1'
})

const openEditModal = (server) => {
  validationError.value = null
  validationField.value = ''
  currentServerVersion.value = server.agent_version || ''
  editForm.value = createEditFormFromServer(server)
  currentServerName.value = server.name || ''
  showEditModal.value = true
}

const openRenewModal = (server) => {
  validationError.value = null
  validationField.value = ''
  currentServerName.value = server.name
  editForm.value = createEditFormFromServer(server)
  showRenewModal.value = true
}

const closeEditModal = () => {
  validationError.value = null
  validationField.value = ''
  cancelAutoUpdateWarning()
  showEditModal.value = false
}

const closeRenewModal = () => {
  validationError.value = null
  validationField.value = ''
  showRenewModal.value = false
}

const handleAutoUpdateToggle = (nextValue) => {
  if (!nextValue) {
    editForm.value.auto_update = false
    cancelAutoUpdateWarning()
    return
  }
  autoUpdatePendingEnable.value = true
  showAutoUpdateWarning.value = true
}

const confirmAutoUpdateWarning = () => {
  if (autoUpdatePendingEnable.value) {
    editForm.value.auto_update = true
  }
  autoUpdatePendingEnable.value = false
  showAutoUpdateWarning.value = false
}

const cancelAutoUpdateWarning = () => {
  autoUpdatePendingEnable.value = false
  showAutoUpdateWarning.value = false
}

const buildEditPayloadFromForm = (form) => {
  const pingNodeValidation = getPingNodeValidation(form)
  if (!pingNodeValidation.valid) {
    return { error: buildPingNodeError(pingNodeValidation.field) }
  }

  const normalizedBillingCycle = normalizeBillingCycle(form.billing_cycle)
  const normalizedAutoRenewal = form.auto_renewal ? '1' : '0'
  const normalizedPrice = normalizePrice(form.price)
  const normalizedCurrency = normalizeCurrency(form.currency || detectCurrencySymbol(form.price) || '¥')
  const normalizedExpireDate = renewExpireDateIfNeeded(
    form.expire_date,
    normalizedBillingCycle,
    normalizedAutoRenewal
  ).expire_date

  return {
    payload: {
      action: 'edit',
      id: form.id,
      name: form.name,
      server_group: form.server_group,
      region: form.region,
      tags: form.tags,
      note: form.note,
      price: normalizedPrice,
      billing_cycle: normalizedBillingCycle,
      auto_renewal: normalizedAutoRenewal,
      currency: normalizedCurrency,
      expire_date: normalizedExpireDate,
      traffic_limit: form.traffic_limit,
      traffic_calc_type: form.traffic_calc_type,
      traffic_alert_percent: normalizeTrafficAlertPercentField(form.traffic_alert_percent),
      interface: form.interface,
      reset_day: form.reset_day,
      collect_interval: form.collect_interval,
      report_interval: form.report_interval,
      wss_report_interval: form.wss_report_interval,
      connection_mode: getEffectiveConnectionMode(form.connection_mode),
      ping_mode: form.ping_mode === 'icmp' ? 'icmp' : 'tcp',
      custom_ct: pingNodeValidation.values.custom_ct,
      custom_cu: pingNodeValidation.values.custom_cu,
      custom_cm: pingNodeValidation.values.custom_cm,
      custom_bd: pingNodeValidation.values.custom_bd,
      node_1: pingNodeValidation.values.node_1, node_2: pingNodeValidation.values.node_2, node_3: pingNodeValidation.values.node_3, node_4: pingNodeValidation.values.node_4,
      rx_correction: form.rx_correction,
      tx_correction: form.tx_correction,
      auto_update: form.auto_update ? '1' : '0',
      is_hidden: form.is_hidden ? '1' : '0',
      offline_notify_disabled: form.offline_notify_disabled ? '1' : '0'
    },
    normalized: {
      price: normalizedPrice,
      currency: normalizedCurrency,
      billing_cycle: normalizedBillingCycle,
      expire_date: normalizedExpireDate
    }
  }
}

const saveEdit = async () => {
  const generation = siteGeneration.value
  if (editSaving.value) return
  validationError.value = null
  validationField.value = ''

  const pingNodeValidation = getPingNodeValidation(editForm.value)
  if (!pingNodeValidation.valid) {
    validationError.value = buildPingNodeError(pingNodeValidation.field)
    return
  }

  const normalizedBillingCycle = normalizeBillingCycle(editForm.value.billing_cycle)
  const normalizedAutoRenewal = editForm.value.auto_renewal ? '1' : '0'
  const normalizedPrice = normalizePrice(editForm.value.price)
  const normalizedCurrency = normalizeCurrency(editForm.value.currency || detectCurrencySymbol(editForm.value.price) || '¥')
  const normalizedExpireDate = renewExpireDateIfNeeded(
    editForm.value.expire_date,
    normalizedBillingCycle,
    normalizedAutoRenewal
  ).expire_date

  editForm.value.price = normalizedPrice
  editForm.value.currency = normalizedCurrency
  editForm.value.billing_cycle = normalizedBillingCycle
  editForm.value.expire_date = normalizedExpireDate

  const data = {
    action: 'edit',
    id: editForm.value.id,
    name: editForm.value.name,
    server_group: editForm.value.server_group,
    region: editForm.value.region,
    tags: editForm.value.tags,
    note: editForm.value.note,
    price: normalizedPrice,
    billing_cycle: normalizedBillingCycle,
    auto_renewal: normalizedAutoRenewal,
    currency: normalizedCurrency,
    expire_date: normalizedExpireDate,
    traffic_limit: editForm.value.traffic_limit,
    traffic_calc_type: editForm.value.traffic_calc_type,
    traffic_alert_percent: normalizeTrafficAlertPercentField(editForm.value.traffic_alert_percent),
    interface: editForm.value.interface,
    reset_day: editForm.value.reset_day,
    collect_interval: editForm.value.collect_interval,
    report_interval: editForm.value.report_interval,
    wss_report_interval: editForm.value.wss_report_interval,
    connection_mode: getEffectiveConnectionMode(editForm.value.connection_mode),
    ping_mode: editForm.value.ping_mode === 'icmp' ? 'icmp' : 'tcp',
    custom_ct: pingNodeValidation.values.custom_ct,
    custom_cu: pingNodeValidation.values.custom_cu,
    custom_cm: pingNodeValidation.values.custom_cm,
    custom_bd: pingNodeValidation.values.custom_bd,
    node_1: pingNodeValidation.values.node_1, node_2: pingNodeValidation.values.node_2, node_3: pingNodeValidation.values.node_3, node_4: pingNodeValidation.values.node_4,
    rx_correction: editForm.value.rx_correction,
    tx_correction: editForm.value.tx_correction,
    auto_update: editForm.value.auto_update ? '1' : '0',
    is_hidden: editForm.value.is_hidden ? '1' : '0',
    offline_notify_disabled: editForm.value.offline_notify_disabled ? '1' : '0'
  }

  editSaving.value = true
  try {
    const result = await adminApiForSite(data)
    if (generation !== siteGeneration.value) return
    if (!result.error) {
      saveResult.value = { success: true, message: getMessage(result.data.message) || trans.value.serverEdited }
      cancelAutoUpdateWarning()
      showEditModal.value = false
      showRenewModal.value = false
      loadServers()
    } else {
      saveResult.value = { success: false, error: getMessage(result.error) || 'Fail' }
    }
  } catch (e) {
    if (generation !== siteGeneration.value) return
    saveResult.value = { success: false, error: e.message }
  } finally {
    if (generation === siteGeneration.value) { editSaving.value = false     }
  }
}

const openDeleteModal = (id) => {
  deleteServerId.value = id
  const server = servers.value.find(s => s.id === id)
  currentServerName.value = server?.name || ''
  deleteTargetOs.value = 'linux'
  deleteVersion.value = 'go'
  deleteInstallMode.value = 'current-user'
  deleteGhProxy.value = ''
  uninstallCopied.value = false
  showDeleteModal.value = true
}

const closeDeleteModal = () => {
  showDeleteModal.value = false
}

const confirmDelete = async () => {
  const generation = siteGeneration.value
  if (deleting.value) return
  deleting.value = true
  try {
    const result = await adminApiForSite({ action: 'delete', id: deleteServerId.value })
    if (generation !== siteGeneration.value) return
    if (!result.error) {
      saveResult.value = { success: true, message: getMessage(result.data.message) || trans.value.serverDeleted }
      showDeleteModal.value = false
      loadServers()
    } else {
      saveResult.value = { success: false, error: getMessage(result.error) || 'Fail' }
    }
  } catch (e) {
    if (generation !== siteGeneration.value) return
    saveResult.value = { success: false, error: e.message }
  } finally {
    if (generation === siteGeneration.value) { deleting.value = false     }
  }
}

const batchDelete = async () => {
  const generation = siteGeneration.value
  if (selectedServers.value.length === 0) {
    alertMessage.value = trans.value.selectServers
    return
  }
  if (!confirm(trans.value.confirmDeleteServers + selectedServers.value.length + trans.value.irreversible)) return

  try {
    const result = await adminApiForSite({ action: 'batch_delete', ids: selectedServers.value })
    if (generation !== siteGeneration.value) return
    if (!result.error) {
      saveResult.value = { success: true, message: getMessage(result.data.message) || trans.value.serversDeleted }
      selectedServers.value = []
      loadServers()
    } else {
      saveResult.value = { success: false, error: getMessage(result.error) || 'Fail' }
    }
  } catch (e) {
    if (generation !== siteGeneration.value) return
    saveResult.value = { success: false, error: e.message }
  }
}

const getSelectedServerRows = () => {
  const selected = new Set(selectedServers.value.map(id => String(id)))
  return servers.value.filter(server => selected.has(String(server.id)))
}

const getCommonBatchValue = (forms, field, fallback) => {
  if (forms.length === 0) return fallback
  const first = forms[0][field]
  return forms.every(form => form[field] === first) ? first : fallback
}

const openBatchEditModal = () => {
  validationError.value = null
  validationField.value = ''
  const selected = getSelectedServerRows()
  if (selected.length === 0) {
    alertMessage.value = trans.value.selectServersToEdit || trans.value.selectServers
    return
  }

  const defaults = createBatchEditDefaults()
  const forms = selected.map(createEditFormFromServer)
  batchEditForm.value = Object.fromEntries(
    Object.keys(defaults).map(field => [field, getCommonBatchValue(forms, field, defaults[field])])
  )
  batchEditEnabled.value = Object.fromEntries(Object.keys(defaults).map(field => [field, false]))
  showBatchEditModal.value = true
}

const closeBatchEditModal = () => {
  if (batchEditing.value) return
  validationError.value = null
  validationField.value = ''
  showBatchEditModal.value = false
}

const saveBatchEdit = async () => {
  validationField.value = ''
  const generation = siteGeneration.value
  if (batchEditing.value) return

  const enabledFields = Object.keys(batchEditEnabled.value).filter(field => batchEditEnabled.value[field])
  if (enabledFields.length === 0) {
    alertMessage.value = trans.value.noBatchEditFields || 'Please select fields to update'
    return
  }

  const selected = getSelectedServerRows()
  if (selected.length === 0) {
    alertMessage.value = trans.value.selectServersToEdit || trans.value.selectServers
    return
  }

  if (batchEditEnabled.value.auto_update && batchEditForm.value.auto_update) {
    const ok = confirm(trans.value.autoUpdateRiskDesc || trans.value.autoUpdateRiskTitle || 'Enable auto-update?')
    if (!ok) return
  }

  validationError.value = null
  batchEditing.value = true

  try {
    let updated = 0
    for (const server of selected) {
      const form = createEditFormFromServer(server)
      for (const field of enabledFields) {
        form[field] = batchEditForm.value[field]
      }
      const built = buildEditPayloadFromForm(form)
      if (built.error) {
        validationError.value = built.error
        return
      }
      const result = await adminApiForSite(built.payload)
    if (generation !== siteGeneration.value) return
      if (result.error) {
        saveResult.value = { success: false, error: getMessage(result.error) || 'Fail' }
        return
      }
      updated += 1
    }

    saveResult.value = {
      success: true,
      message: (trans.value.batchEditSuccess || 'Batch edit completed').replace('{count}', updated)
    }
    selectedServers.value = []
    showBatchEditModal.value = false
    await loadServers()
  } catch (e) {
    if (generation !== siteGeneration.value) return
    saveResult.value = { success: false, error: e.message }
  } finally {
    if (generation === siteGeneration.value) {
    batchEditing.value = false
      }
  }
}

const handleSelectAll = (e) => {
  const checked = e.target.checked
  selectedServers.value = checked ? servers.value.map(s => s.id) : []
}

const saveGroup = async (group) => {
  batchEditForm.value = createBatchEditDefaults()
  batchEditForm.value.server_group = group
  batchEditEnabled.value = Object.fromEntries(Object.keys(createBatchEditDefaults()).map(field => [field, field === 'server_group']))
  await saveBatchEdit()
  if (!saveResult.value?.success) return
  showGroupModal.value = false
}

const toggleSelectAll = () => {
  if (selectedServers.value.length === servers.value.length) {
    selectedServers.value = []
  } else {
    selectedServers.value = servers.value.map(s => s.id)
  }
}

const toggleServer = (id) => {
  const index = selectedServers.value.indexOf(id)
  if (index === -1) {
    selectedServers.value.push(id)
  } else {
    selectedServers.value.splice(index, 1)
  }
}

const saveServerOrder = (orders) => {
  const byId = new Map(servers.value.map(server => [String(server.id), server]))
  if (orders.length !== byId.size || new Set(orders).size !== byId.size || orders.some(id => !byId.has(id))) return
  const owner = requestOwner.value, apiIndex = selectedApiIndex.value
  const revision = ++orderRevision
  servers.value = orders.map(id => byId.get(id))
  // Capture site ownership now, not when a queued save eventually starts.
  orderSaving = orderSaving.then(async () => {
    if (!owner()) return
    try {
      const result = await adminApi({ action: 'save_order', orders }, apiIndex, owner)
      if (!owner()) return
      if (result.error) throw new Error(getMessage(result.error) || trans.value.operationFailed)
    } catch (error) {
      if (!owner()) return
      saveResult.value = { success: false, error: error.message }
    }
    // Earlier replies must not overwrite a newer preview; the last queued save reconciles both.
    if (!owner() || revision !== orderRevision) return
    const result = await loadServers({ refresh: true, orderRevision: revision })
    if (owner() && revision === orderRevision && result?.error) {
      saveResult.value = { success: false, error: getMessage(result.error) || trans.value.operationFailed }
    }
  })
}

const uploadImageSetting = (e, field) => {
  const generation = siteGeneration.value
  const file = e.target.files[0]
  if (!file) return
  if (file.size > 800 * 1024) {
    alertMessage.value = trans.value.imageSizeWarning
    return
  }
  const reader = new FileReader()
  reader.onload = function(event) {
    if (generation !== siteGeneration.value) return
    settings.value[field] = event.target.result
  }
  reader.readAsDataURL(file)
}

const uploadBg = (e) => uploadImageSetting(e, 'custom_bg')

const uploadBgMobile = (e) => uploadImageSetting(e, 'custom_bg_mobile')

const uploadFavicon = (e) => uploadImageSetting(e, 'favicon')

const handleUpgradeDatabase = async () => {
  const generation = siteGeneration.value
  dbOperation.value = 'upgrade'
  dbLoading.value = true
  dbResult.value = null

  try {
    const result = await upgradeDatabase(selectedApiIndex.value, requestOwner.value)
    if (generation !== siteGeneration.value) return
    dbResult.value = result
  } catch (e) {
    if (generation !== siteGeneration.value) return
    dbResult.value = { success: false, error: e.message }
  } finally {
    if (generation === siteGeneration.value) {
    dbLoading.value = false
      }
  }
}

const handleClearHistory = async () => {
  const generation = siteGeneration.value
  dbOperation.value = 'clearHistory'
  dbLoading.value = true
  dbResult.value = null

  try {
    const result = await clearHistory(selectedApiIndex.value, requestOwner.value)
    if (generation !== siteGeneration.value) return
    dbResult.value = result
  } catch (e) {
    if (generation !== siteGeneration.value) return
    dbResult.value = { success: false, error: e.message }
  } finally {
    if (generation === siteGeneration.value) {
    dbLoading.value = false
      }
  }
}

const openDbModal = (operation) => {
  dbOperation.value = operation
  dbResult.value = null
  showDbModal.value = true
}

const closeDbModal = () => {
  if (!dbLoading.value) {
    showDbModal.value = false
  }
}

const queryD1Usage = async () => {
  const generation = siteGeneration.value
  if (d1UsageLoading.value) return
  d1UsageLoading.value = true
  d1UsageResult.value = null
  alertMessage.value = null

  try {
    const result = await adminApiForSite({
      action: 'd1_usage',
      cloudflare_account_id: settings.value.cloudflare_account_id,
      cloudflare_token: settings.value.cloudflare_token
    })
    if (generation !== siteGeneration.value) return
    if (!result.error) {
      d1UsageResult.value = result.data
    } else {
      alertMessage.value = getMessage(result.error) || result.error || trans.value.operationFailed
    }
  } catch (e) {
    if (generation !== siteGeneration.value) return
    alertMessage.value = getMessage(e.message) || e.message || trans.value.operationFailed
  } finally {
    if (generation === siteGeneration.value) {
    d1UsageLoading.value = false
      }
  }
}

watch(() => route.query.apiIndex, async (value) => {
  const nextIndex = normalizeApiIndex(value)
  if (nextIndex === selectedApiIndex.value) return

  selectedApiIndex.value = nextIndex

  if (isLoggedIn.value) {
    await switchAdminSite()
  } else {
    siteGeneration.value++
    loginLoading.value = false
    await loadTurnstileConfig()
  }
})

watch(isLoggedIn, loggedIn => { if (loggedIn) terminalStatusLoggedOut = false; restartTerminalStatuses() }, {flush:'sync'})
watch([activeTab, selectedApiIndex, siteGeneration, adminSiteLoading], restartTerminalStatuses, {flush:'sync'})
onBeforeUnmount(() => {
  adminActive = false; siteGeneration.value++; cancelTerminalStatuses()
  document.removeEventListener('visibilitychange', restartTerminalStatuses)
  window.removeEventListener('terminal-logout', terminalStatusLogout)
  window.removeEventListener('storage', terminalStatusStorage)
  terminalStatusChannel?.close()
  removeTurnstile('#admin-turnstile-container'); document.body.classList.remove('admin-ui-surface')
})
onMounted(() => {
  document.addEventListener('visibilitychange', restartTerminalStatuses)
  window.addEventListener('terminal-logout', terminalStatusLogout)
  window.addEventListener('storage', terminalStatusStorage)
  if (typeof BroadcastChannel !== 'undefined') {
    terminalStatusChannel = new BroadcastChannel('cfsm-terminal-logout')
    terminalStatusChannel.onmessage = event => { if (event.data?.type === 'logout') terminalStatusLogout() }
  }
  document.body.classList.add('admin-ui-surface')
  initAdmin()
})
</script>
