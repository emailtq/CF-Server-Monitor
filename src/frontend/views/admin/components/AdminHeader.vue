<template>
  <header class="admin-header"><div class="admin-header-inner">
    <a class="admin-site-name" href="/#/" :title="siteTitle">{{ siteTitle }}</a><span class="admin-header-label">{{ trans.adminHeaderLabel }}</span>
    <div class="admin-header-actions">
      <a class="btn admin-public-link admin-quiet" href="/#/" :aria-label="trans.adminPublicLabel"><AdminIcon name="external-link" />{{ trans.adminPublicLabel }}</a>
      <button class="admin-icon-button admin-theme-button" :aria-label="trans.theme" @click="toggleDisplayedTheme"><AdminIcon name="moon" /></button>
      <button v-if="showLogout" class="admin-icon-button" :aria-label="trans.logout" @click="$emit('logout')"><AdminIcon name="log-out" /></button>
    </div>
  </div></header>
</template>
<script setup>
import AdminIcon from './AdminIcon.vue'
import { useTheme } from '../../../composables/useTheme.js'
import { DEFAULT_SITE_TITLE } from '../../../utils/constants.js'
defineProps({ siteTitle: { type: String, default: DEFAULT_SITE_TITLE }, trans: { type: Object, required: true }, showLogout: { type: Boolean, default: true } })
defineEmits(['logout'])
const { setTheme } = useTheme()
const toggleDisplayedTheme = () => setTheme(document.body.classList.contains('light') ? 'dark' : 'light')
</script>
