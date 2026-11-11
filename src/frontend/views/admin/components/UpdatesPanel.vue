<template>
  <section v-show="activeTab === 'updates'" class="settings-section">
    <h2 class="section-title">{{ trans.adminUpdates }}</h2>
    <dl class="admin-node-detail"><dt>Worker</dt><dd>{{ VERSION || '-' }}</dd><dt>{{ trans.adminLatestWorker }}</dt><dd>{{ LAST_WORKERS_VERSION || '-' }}</dd><dt>{{ trans.agentVersion }}</dt><dd>{{ latestAgentVersion || '-' }}</dd></dl>
    <p class="text-muted text-sm">{{ trans.adminExistingVersionInfo }}</p>
    <a class="btn" href="https://github.com/huilang-me/CF-Server-Monitor/releases" target="_blank" rel="noopener noreferrer">{{ trans.view }}</a>
    <button class="btn" @click="$emit('donation')">{{ trans.donation }}</button>
  </section>
</template>
<script setup>
import { VERSION, LAST_WORKERS_VERSION } from '../../../utils/api'
defineProps({ trans: Object, activeTab: String, latestAgentVersion: String })
defineEmits(['donation'])
</script>
