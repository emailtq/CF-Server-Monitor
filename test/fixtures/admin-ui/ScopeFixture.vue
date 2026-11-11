<template>
  <div class="admin-ui">
    <template v-if="mode === 'picker'">
      <button id="open" class="btn" @click="open = true">Open fixture</button>
      <AdminDialog :open="open" title="Picker interface fixture" @close="open = false">
        <template #body>
          <AdminMultiSelect v-model="selected" :options="options" :summary="override" label="Extended picker">
            <template #before-options><label class="admin-picker-option"><input id="slot-option" type="checkbox" v-model="slotChecked"><span>{{ unsafe }}</span></label></template>
          </AdminMultiSelect>
          <AdminMultiSelect v-model="defaultSelected" :options="options" :min-selected="1" label="Default picker" />
          <button id="clear-override" class="btn" @click="override = undefined">Use default summary</button>
          <button id="empty-override" class="btn" @click="override = ''">Empty summary</button>
          <output id="selected">{{ JSON.stringify(selected) }}</output><output id="default-selected">{{ JSON.stringify(defaultSelected) }}</output>
        </template>
        <template #footer><button class="btn" @click="open = false">Cancel</button></template>
      </AdminDialog>
    </template>
    <template v-else>
      <button id="open-alert" class="btn" :disabled="!config" @click="edit()">New alert</button>
      <button id="edit-imported" class="btn" :disabled="!config" @click="edit(config.rules.find(r => r.id === 'imported'))">Edit imported</button>
      <button id="edit-last" class="btn" :disabled="!config?.rules.length" @click="edit(config.rules.at(-1))">Edit last</button>
      <AlertDialog v-if="draft" :key="dialogId" :draft="draft" :previous="previous" :channels="config.channels" :servers="servers" :trans="trans" :busy="busy" :error="error" @save="save" @close="draft = null" />
      <output id="draft-scope">{{ JSON.stringify(draft?.scope) }}</output><output id="saved-scope">{{ JSON.stringify(savedScope) }}</output><output id="save-count">{{ saveCount }}</output><output id="fixture-error" :role="error ? 'alert' : undefined">{{ error }}</output><output id="ready">{{ !!config }}</output>
    </template>
  </div>
</template>
<script setup>
import { ref, onBeforeUnmount } from 'vue'
import AdminDialog from '../../../src/frontend/views/admin/components/AdminDialog.vue'
import AdminMultiSelect from '../../../src/frontend/views/admin/components/AdminMultiSelect.vue'
import AlertDialog from '../../../src/frontend/views/admin/components/AlertDialog.vue'
import { adminApi } from '../../../src/frontend/utils/api.js'
import { useTranslation } from '../../../src/frontend/utils/i18n.js'
const mode = new URLSearchParams(location.search).get('mode')
const trans = useTranslation()
const unsafe = '<img src=x onerror=alert(1)> & "fixture"'
const override = ref(unsafe), open = ref(false), slotChecked = ref(false)
const selected = ref(['node-0', 'node-1']), defaultSelected = ref(['node-0'])
const options = Array.from({ length: 120 }, (_, n) => ({ value: `node-${n}`, label: n === 119 ? unsafe : `Node ${n}`, disabled: n === 3 }))
const config = ref(null), servers = ref([]), draft = ref(null), previous = ref(null), dialogId = ref(0), savedScope = ref(null), busy = ref(false), error = ref(''), saveCount = ref(0)
let active = true
onBeforeUnmount(() => { active = false })
const owner = () => active
const load = async () => {
  try {
    const result = await adminApi({ action: 'get_notification_config' }, 0, owner)
    if (!active || result.stale) return
    if (result.error || !Array.isArray(result.data?.channels) || !Array.isArray(result.data?.rules)) throw new Error('Notification fixture load failed')
    const nodes = await adminApi({ action: 'list' }, 0, owner)
    if (!active || nodes.stale) return
    if (nodes.error || !Array.isArray(nodes.data?.servers)) throw new Error('Server fixture load failed')
    servers.value = nodes.data.servers; config.value = result.data
  } catch (failure) {
    if (active) error.value = failure.message
  }
}
if (mode !== 'picker') load()
const edit = rule => {
  previous.value = rule || null
  draft.value = rule ? JSON.parse(JSON.stringify(rule)) : { id: 'rule_' + crypto.randomUUID(), name: 'Fixture rule', type: 'offline', enabled: true, options: { minutes: 5 }, scope: { mode: 'all', serverIds: [] }, targetIds: [config.value.channels[0].id] }
  dialogId.value++; error.value = ''
}
const save = async rule => {
  busy.value = true
  const rules = config.value.rules.some(r => r.id === rule.id) ? config.value.rules.map(r => r.id === rule.id ? rule : r) : [...config.value.rules, rule]
  const result = await adminApi({ action: 'save_notification_config', expectedRevision: config.value.revision, channels: config.value.channels, rules, timezone: config.value.timezone, language: config.value.language }, 0, owner)
  if (!active) return
  busy.value = false
  if (result.error) { error.value = 'invalid'; return }
  saveCount.value++; savedScope.value = result.data.rules.find(r => r.id === rule.id).scope; config.value = result.data; draft.value = null
}
</script>
