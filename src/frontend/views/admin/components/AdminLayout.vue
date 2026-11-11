<template>
  <div class="admin-ui">
    <slot name="header" />
    <main class="admin-main" :aria-label="siteTitle">
      <div class="admin-workspace">
        <nav class="admin-nav" :aria-label="trans.adminPanel">
          <button v-for="page in pages" :key="page.value" :data-page="page.value" class="admin-nav-item" :class="{ 'is-active': activePage === page.value }" :aria-current="activePage === page.value ? 'page' : undefined" @click="$emit('navigate', page.value)"><AdminIcon :name="page.iconName" />{{ page.label }}</button>
        </nav>
        <div class="admin-content"><slot /></div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import AdminIcon from './AdminIcon.vue'
import { DEFAULT_SITE_TITLE } from '../../../utils/constants.js'
import '../../../styles/admin.css'
const props = defineProps({ activePage: { type: String, required: true }, siteTitle: { type: String, default: DEFAULT_SITE_TITLE }, trans: { type: Object, required: true } })
defineEmits(['navigate'])
// Only mounted, working panels are reachable; later stages extend this list.
const pages = computed(() => [
  { value: 'servers', label: props.trans.adminNodes, iconName: 'server' },
  { value: 'collection', label: props.trans.adminCollection, iconName: 'radio' },
  { value: 'notifications', label: props.trans.adminNotificationsNav, iconName: 'bell' },
  { value: 'alerts', label: props.trans.adminAlertsNav, iconName: 'list-filter' },
  { value: 'database', label: props.trans.adminData, iconName: 'database' },
  { value: 'themeStore', label: props.trans.theme, iconName: 'palette' },
  { value: 'security', label: props.trans.adminSecurity, iconName: 'shield' },
  { value: 'settings', label: props.trans.settings, iconName: 'settings' },
  { value: 'updates', label: props.trans.adminUpdates, iconName: 'circle-arrow-up' }
])
</script>
