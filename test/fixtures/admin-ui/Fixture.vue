<template>
  <div v-if="publicPage" class="container" id="public-control">
    <TerminalHeader title="Public control" /><div class="main-panel"><button class="btn">Public button</button><input class="form-input" placeholder="Public input"></div>
  </div>
  <component :is="Layout" v-else-if="Layout" :active-page="lastPage" site-title="CF Monitor" :trans="trans" @navigate="lastPage = $event">
    <template #header><component :is="Header" v-if="Header" site-title="CF Monitor" :trans="trans" /></template>
    <p id="last-page">{{ lastPage }}</p>
    <button id="open-dialog" class="btn" @click="open = true">Open dialog</button>
    <button id="open-busy" class="btn" @click="busy = true; open = true">Open busy dialog</button>
    <button id="open-terminal-access" class="btn" @click="terminalAccess = true">Fixture terminal access</button>
    <div class="fixture-pickers">
      <component :is="MultiSelect" v-if="MultiSelect" v-model="selected" :options="options" :min-selected="1" label="Select servers" />
      <component :is="MultiSelect" v-if="MultiSelect" v-model="targets" :options="options" label="Select channels" />
    </div>
    <output id="selected">{{ JSON.stringify(selected) }}</output>
    <component :is="Dialog" v-if="Dialog" :open="open" title="Fixture dialog" :busy="busy" :size="size" @close="open = false">
      <template #body><input id="dialog-first" aria-label="First field"><div v-if="lowViewport" id="before-picker" style="height: 200px"></div><p v-for="n in lowViewport ? 0 : 80" :key="n">Long dialog body {{ n }}</p><component :is="MultiSelect" v-if="MultiSelect" v-model="targets" :options="options" label="Dialog channels" /><div v-if="lowViewport" id="after-picker" style="height: 1600px"></div><button id="body-last">Body end</button></template>
      <template #footer><button class="btn" :disabled="busy" @click="open = false">Cancel</button><button id="dialog-last" class="btn btn-primary" @click="busy = false">Save</button></template>
    </component>
    <TerminalAccessModal v-if="terminalAccess" :server="{ id: 'fixture-node', name: 'Fixture terminal' }" :trans="trans" @close="terminalAccess = false" />
  </component>
  <div v-else>
    <button id="open-dialog" @click="open = true">Open dialog</button>
    <EditServerModal :show="open" :trans="trans" v-model:edit-form="edit" :settings="{}" current-server-name="Fixture dialog" @close="open = false" />
  </div>
</template>
<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import EditServerModal from '../../../src/frontend/views/admin/components/EditServerModal.vue'
import TerminalAccessModal from '../../../src/frontend/views/admin/components/TerminalAccessModal.vue'
import TerminalHeader from '../../../src/frontend/components/TerminalHeader.vue'
import { useTranslation } from '../../../src/frontend/utils/i18n.js'
const components = import.meta.glob('../../../src/frontend/views/admin/components/Admin*.vue', { eager: true, import: 'default' })
const find = name => Object.entries(components).find(([path]) => path.endsWith(`/${name}.vue`))?.[1]
const Layout = find('AdminLayout')
const Header = find('AdminHeader')
const Dialog = find('AdminDialog')
const MultiSelect = find('AdminMultiSelect')
const trans = useTranslation()
const route = useRoute()
const publicPage = computed(() => new URLSearchParams(location.search).get('mode') === 'public' || route.path !== '/admin')
onMounted(() => { if (!publicPage.value && Layout) document.body.classList.add('admin-ui-surface') })
onBeforeUnmount(() => { if (!publicPage.value && Layout) document.body.classList.remove('admin-ui-surface') })
const open = ref(false)
const lowViewport = new URLSearchParams(location.search).has('lowViewport')
const busy = ref(false)
const terminalAccess = ref(false)
const size = new URLSearchParams(location.search).get('size') || 'default'
const edit = ref({ id: 'fixture', name: 'Fixture dialog', billing_cycle: 'month', currency: '$', connection_mode: 'http' })
const selected = ref(['node-0', 'node-1'])
const targets = ref(lowViewport ? ['node-0'] : [])
const lastPage = ref('servers')
const options = computed(() => Array.from({ length: 120 }, (_, n) => ({ value: `node-${n}`, label: n === 119 ? 'Long option label '.repeat(12) : `node-${n}`, description: n === 119 ? 'Long description '.repeat(12) : !lowViewport && n % 2 ? `Group ${n % 3}` : undefined, disabled: n === 3 })))
</script>
