<template>
  <Teleport to="body">
    <Transition :name="size === 'terminal' ? 'terminal-menu' : size === 'group' ? 'admin-group-dialog' : undefined" :css="size === 'terminal' || size === 'group'" @before-leave="retainLeavingDialog" @after-leave="finishLeave">
    <div v-if="open" class="admin-ui admin-dialog-overlay" @click.self="requestClose">
      <section ref="dialog" class="admin-dialog" :class="`admin-dialog-${size}`" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId || ($slots.description ? `${titleId}-description` : undefined)" :aria-busy="busy" tabindex="-1">
        <button type="button" class="admin-dialog-close" :disabled="busy" :aria-label="t('close')" @click="requestClose"><AdminIcon name="x" /></button>
        <div class="admin-dialog-scroll">
        <header class="admin-dialog-head">
          <h2 :id="titleId">{{ title }}</h2>
          <p v-if="$slots.description" :id="`${titleId}-description`" class="admin-group-description"><slot name="description" /></p>
        </header>
        <div class="admin-dialog-body"><slot name="body"><slot /></slot></div>
        <footer v-if="$slots.footer" class="admin-dialog-footer"><slot name="footer" /></footer>
        </div>
      </section>
    </div>
    </Transition>
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
const props = defineProps({ open: { type: Boolean, default: false }, title: { type: String, required: true }, size: { type: String, default: 'default', validator: value => ['default', 'add', 'group', 'edit', 'download', 'download-confirm', 'terminal'].includes(value) }, busy: { type: Boolean, default: false }, descriptionId: { type: String, default: '' } })
const emit = defineEmits(['close', 'after-leave'])
const dialog = ref(null)
const titleId = `admin-dialog-${++nextId}`
let previousFocus = null
let registered = false
let headerObserver
let layoutWidth = 0, layoutHeight = 0
// Vue clears the section ref before an animated leave removes its DOM.
let leavingDialog = null
const retainLeavingDialog = element => { if (['terminal', 'group'].includes(props.size)) leavingDialog = element.querySelector('.admin-dialog') }
const dialogElement = () => dialog.value || leavingDialog
const updateTrackStart = () => {
  const section = dialogElement(), title = section?.querySelector('h2'), close = section?.querySelector('.admin-dialog-close')
  if (!title || !close) return
  // Native track margins separate the scrollbar from the title and the full X hit area.
  const hitInset = matchMedia('(pointer:coarse)').matches ? 6 : 0
  section.style.setProperty('--admin-dialog-track-start', `${Math.max(title.offsetTop + title.offsetHeight, close.offsetTop + close.offsetHeight + hitInset) + 12}px`)
}
watch(dialog, section => {
  headerObserver?.disconnect()
  if (!section) return
  headerObserver = new ResizeObserver(updateTrackStart)
  headerObserver.observe(section.querySelector('h2'))
  headerObserver.observe(section.querySelector('.admin-dialog-close'))
  updateTrackStart()
})
// Match minimal: CSS owns the layout viewport; the browser owns soft-keyboard panning.
const revealOnLayoutResize = () => {
  if (layoutWidth === window.innerWidth && layoutHeight === window.innerHeight) return
  layoutWidth = window.innerWidth; layoutHeight = window.innerHeight
  const section = dialogElement(), active = document.activeElement
  if (!topmost() || !section?.contains(active) || !active.matches('input,textarea')) return
  const field = active.getBoundingClientRect(), port = section.getBoundingClientRect()
  // Keep CF's focused-field reachability on a real window resize, never on visual-only IME panning.
  if (field.top < port.top + 4 || field.bottom > port.bottom - 4) active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
const topmost = () => dialogs.at(-1) === titleId
const focusable = () => [...(dialogElement()?.querySelectorAll('button,input,select,textarea,a[href],[tabindex]') || [])].filter(e => !e.matches(':disabled') && e.tabIndex >= 0 && e.getClientRects().length)
const focusFirst = () => (focusable()[0] || dialogElement())?.focus()
const requestClose = () => { if (!props.busy && topmost()) emit('close') }
const keydown = event => {
  if (!topmost()) return
  if (event.key === 'Escape' && !event.target.closest('.admin-picker-menu, .admin-group-combobox[data-open], .admin-toolbar-group-menu')) { event.preventDefault(); event.stopImmediatePropagation(); requestClose() }
  if (event.key !== 'Tab') return
  const elements = focusable()
  const first = elements[0]
  const last = elements.at(-1)
  if (!first || !dialogElement()?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus()
    if (!first) dialogElement()?.focus()
  }
}
const focusin = event => { if (topmost() && !dialogElement()?.contains(event.target)) focusFirst() }
const release = () => {
  if (!registered) return
  const wasTop = topmost()
  dialogs.splice(dialogs.indexOf(titleId), 1)
  registered = false
  headerObserver?.disconnect()
  leavingDialog = null
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('focusin', focusin)
  window.removeEventListener('resize', revealOnLayoutResize)
  if (!dialogs.length) document.body.classList.remove('admin-dialog-open')
  if (wasTop && previousFocus?.isConnected) previousFocus.focus()
}
const finishLeave = () => { if (!props.open) { release(); emit('after-leave') } }
watch(() => props.open, async open => {
  if (!open) { if (!['terminal', 'group'].includes(props.size)) release(); return }
  if (registered) {
    await nextTick() // A reversed leave remounts the section without replacing its stack owner.
    if (registered && props.open && topmost() && props.size !== 'group') focusFirst()
    return
  }
  previousFocus = document.activeElement
  dialogs.push(titleId); registered = true
  document.body.classList.add('admin-dialog-open')
  layoutWidth = window.innerWidth; layoutHeight = window.innerHeight
  window.addEventListener('resize', revealOnLayoutResize)
  await nextTick()
  if (!registered) return
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('focusin', focusin)
  if (props.size !== 'group') focusFirst()
}, { immediate: true, flush: 'post' })
onBeforeUnmount(release)
</script>
