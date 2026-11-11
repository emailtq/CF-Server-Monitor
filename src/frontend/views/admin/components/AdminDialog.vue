<template>
  <Teleport to="body">
    <div v-if="open" class="admin-ui admin-dialog-overlay" @click.self="requestClose">
      <section ref="dialog" class="admin-dialog" :class="`admin-dialog-${size}`" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId || undefined" :aria-busy="busy" tabindex="-1">
        <header class="admin-dialog-head">
          <h2 :id="titleId">{{ title }}</h2>
          <button type="button" class="admin-dialog-close" :disabled="busy" :aria-label="t('close')" @click="requestClose"><AdminIcon name="x" /></button>
        </header>
        <div class="admin-dialog-body"><slot name="body"><slot /></slot></div>
        <footer v-if="$slots.footer" class="admin-dialog-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<script>
let nextId = 0
const dialogs = []
</script>
<script setup>
import AdminIcon from './AdminIcon.vue'
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { t } from '../../../utils/i18n.js'
import '../../../styles/admin.css'
const props = defineProps({ open: { type: Boolean, default: false }, title: { type: String, required: true }, size: { type: String, default: 'default', validator: value => ['default', 'add', 'edit'].includes(value) }, busy: { type: Boolean, default: false }, descriptionId: { type: String, default: '' } })
const emit = defineEmits(['close'])
const dialog = ref(null)
const titleId = `admin-dialog-${++nextId}`
let previousFocus = null
let registered = false
const topmost = () => dialogs.at(-1) === titleId
const focusable = () => [...(dialog.value?.querySelectorAll('button,input,select,textarea,a[href],[tabindex]') || [])].filter(e => !e.disabled && e.tabIndex >= 0 && e.getClientRects().length)
const focusFirst = () => (focusable()[0] || dialog.value)?.focus()
const requestClose = () => { if (!props.busy && topmost()) emit('close') }
const keydown = event => {
  if (!topmost()) return
  if (event.key === 'Escape' && !event.target.closest('.admin-picker-menu')) { event.preventDefault(); event.stopImmediatePropagation(); requestClose() }
  if (event.key !== 'Tab') return
  const elements = focusable()
  const first = elements[0]
  const last = elements.at(-1)
  if (!first || !dialog.value?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus()
    if (!first) dialog.value?.focus()
  }
}
const focusin = event => { if (topmost() && !dialog.value?.contains(event.target)) focusFirst() }
const release = () => {
  if (!registered) return
  const wasTop = topmost()
  dialogs.splice(dialogs.indexOf(titleId), 1)
  registered = false
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('focusin', focusin)
  if (!dialogs.length) document.body.classList.remove('admin-dialog-open')
  if (wasTop && previousFocus?.isConnected) previousFocus.focus()
}
watch(() => props.open, async open => {
  if (!open) { release(); return }
  previousFocus = document.activeElement
  dialogs.push(titleId); registered = true
  document.body.classList.add('admin-dialog-open')
  await nextTick()
  if (!registered) return
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('focusin', focusin)
  focusFirst()
}, { immediate: true, flush: 'post' })
onBeforeUnmount(release)
</script>
