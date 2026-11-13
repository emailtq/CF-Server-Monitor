<template>
  <Teleport to="body">
    <div v-if="open" class="admin-ui admin-dialog-overlay" :class="{ 'admin-dialog-short': shortViewport }" :style="viewportStyle" @click.self="requestClose">
      <section ref="dialog" class="admin-dialog" :class="`admin-dialog-${size}`" :style="size === 'terminal' ? { height: viewportHeight } : undefined" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId || undefined" :aria-busy="busy" tabindex="-1">
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
const props = defineProps({ open: { type: Boolean, default: false }, title: { type: String, required: true }, size: { type: String, default: 'default', validator: value => ['default', 'add', 'edit', 'download', 'download-confirm', 'terminal'].includes(value) }, viewportHeight: { type: String, default: '100dvh' }, busy: { type: Boolean, default: false }, descriptionId: { type: String, default: '' } })
const emit = defineEmits(['close'])
const dialog = ref(null)
const viewportStyle = ref({})
const shortViewport = ref(false)
const titleId = `admin-dialog-${++nextId}`
let previousFocus = null
let registered = false
let observedViewport = null
const updateViewport = () => {
  const height = window.visualViewport?.height || window.innerHeight
  viewportStyle.value = { top: `${window.visualViewport?.offsetTop || 0}px`, height: `${height}px`, '--admin-dialog-viewport': `${height}px` }
  shortViewport.value = height <= 480
}
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
  observedViewport?.removeEventListener('resize', updateViewport)
  observedViewport?.removeEventListener('scroll', updateViewport)
  window.removeEventListener('resize', updateViewport)
  observedViewport = null
  if (!dialogs.length) document.body.classList.remove('admin-dialog-open')
  if (wasTop && previousFocus?.isConnected) previousFocus.focus()
}
watch(() => props.open, async open => {
  if (!open) { release(); return }
  previousFocus = document.activeElement
  dialogs.push(titleId); registered = true
  document.body.classList.add('admin-dialog-open')
  updateViewport()
  observedViewport = window.visualViewport
  observedViewport?.addEventListener('resize', updateViewport)
  observedViewport?.addEventListener('scroll', updateViewport)
  window.addEventListener('resize', updateViewport)
  await nextTick()
  if (!registered) return
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('focusin', focusin)
  focusFirst()
}, { immediate: true, flush: 'post' })
onBeforeUnmount(release)
</script>
