<template>
  <div ref="root" class="admin-toolbar-group" @focusout="blur">
    <button ref="trigger" type="button" role="combobox" aria-autocomplete="none" class="toolbar-select admin-toolbar-group-trigger" :title="summary" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open ? menuId : undefined" @pointerdown="triggerPointer" @click="triggerClick" @keydown="triggerKey">
      <span>{{ summary }}</span><AdminIcon name="chevron-down" />
    </button>
    <Transition name="admin-select" @after-leave="finishClose"><div v-if="open" :id="menuId" ref="menu" class="admin-toolbar-group-menu" :data-side="side" role="listbox" tabindex="-1" :aria-label="label" :style="menuStyle" @contextmenu.prevent @focusin="recordFocus" @keydown="menuKey">
      <div v-show="canUp" class="admin-toolbar-group-scroll is-up" aria-hidden="true" @pointerdown.prevent="startScroll(-1)" @pointermove="scrollMove(-1)" @pointerleave="stopScroll"><AdminIcon name="chevron-down" /></div>
      <div ref="viewport" class="admin-toolbar-group-viewport" @scroll="scrolledOptions">
        <button v-for="(option, index) in options" :key="option.value" type="button" role="option" :aria-selected="modelValue === option.value" tabindex="-1" :data-index="index" @click="select(option.value)" @pointerup="$event.pointerType === 'mouse' && select(option.value)" @pointermove="$event.pointerType === 'mouse' && $event.currentTarget.focus({ preventScroll: true })" @pointerleave="optionLeave">
          <span>{{ option.label }}</span><span v-if="modelValue === option.value" class="admin-toolbar-group-indicator"><AdminIcon name="check" /></span>
        </button>
      </div>
      <div v-show="canDown" class="admin-toolbar-group-scroll" aria-hidden="true" @pointerdown.prevent="startScroll(1)" @pointermove="scrollMove(1)" @pointerleave="stopScroll"><AdminIcon name="chevron-down" /></div>
    </div></Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdminIcon from './AdminIcon.vue'

const props = defineProps({ modelValue: String, groups: Array, allLabel: String, label: String, active: Boolean })
const emit = defineEmits(['update:modelValue'])
const root = ref(null), trigger = ref(null), menu = ref(null), viewport = ref(null), open = ref(false), menuStyle = ref({}), side = ref('bottom'), canUp = ref(false), canDown = ref(false)
const menuId = `admin-toolbar-group-${crypto.randomUUID()}`
const options = computed(() => [{ value: '', label: props.allLabel }, ...props.groups.map(group => ({ value: group, label: group }))])
const summary = computed(() => options.value.find(option => option.value === props.modelValue)?.label || props.allLabel)
let query = '', typedAt = 0, pointerType = 'touch', scrollTimer, scrollDirection = 0
let modalActive = false, previousPointerEvents = '', restoreFocus = false, lastFocused = null
let hiddenSiblings = []
const hideOutside = () => {
  if (!modalActive || !menu.value) return
  const targets = new Set([menu.value, ...document.querySelectorAll('[aria-live]')]), keep = new Set()
  for (const target of targets) for (let node = target; node; node = node.parentElement) keep.add(node)
  const walk = parent => {
    for (const child of parent.children) {
      if (targets.has(child)) continue
      if (keep.has(child)) walk(child)
      else if (child.getAttribute('aria-hidden') !== 'true') {
        hiddenSiblings.push([child, child.getAttribute('aria-hidden')]); child.setAttribute('aria-hidden', 'true')
      }
    }
  }
  walk(document.body)
}
const releaseModal = () => {
  if (!modalActive) return
  if (document.body.style.pointerEvents === 'none') document.body.style.pointerEvents = previousPointerEvents
  for (const [element, previous] of hiddenSiblings) {
    if (element.getAttribute('aria-hidden') === 'true') {
      if (previous === null) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', previous)
    }
  }
  hiddenSiblings = []
  modalActive = false
}
const finishClose = () => {
  if (open.value) return
  releaseModal()
  if (restoreFocus && trigger.value?.isConnected && !document.activeElement?.closest('[role=dialog]')) trigger.value.focus({ preventScroll: true })
  restoreFocus = false
}
const recordFocus = event => { lastFocused = event.target }
const optionLeave = event => {
  if (event.pointerType === 'mouse' && event.currentTarget === document.activeElement) menu.value?.focus({ preventScroll: true })
}
const blockScroll = event => {
  if (modalActive && !event.ctrlKey && !(event.touches?.length > 1) && !viewport.value?.contains(event.target)) event.preventDefault()
}
const stopScroll = () => { clearInterval(scrollTimer); scrollTimer = undefined }
const scrolledOptions = () => {
  const el = viewport.value
  canUp.value = !!el && el.scrollTop > 0
  canDown.value = !!el && Math.ceil(el.scrollTop) < el.scrollHeight - el.clientHeight
  if ((scrollDirection < 0 && !canUp.value) || (scrollDirection > 0 && !canDown.value)) stopScroll()
}
const startScroll = direction => {
  if (scrollTimer) return
  scrollDirection = direction
  const step = () => {
    const el = viewport.value, option = el?.querySelector('[aria-selected=true]') || el?.querySelector('[role=option]')
    if (el && option) el.scrollTop += direction * option.offsetHeight
  }
  scrollTimer = setInterval(step, 50)
}
const scrollMove = direction => { menu.value?.focus({ preventScroll: true }); startScroll(direction) }
const close = (restore = false) => {
  open.value = false; query = ''; typedAt = 0
  stopScroll()
  restoreFocus = restore
}
const position = () => {
  if (!open.value || !menu.value) return
  const rect = trigger.value.getBoundingClientRect(), visual = window.visualViewport
  const top = (visual?.offsetTop || 0) + 10, bottom = top + (visual?.height || innerHeight) - 20
  const left = (visual?.offsetLeft || 0) + 10, availableWidth = (visual?.width || innerWidth) - 20
  menuStyle.value = { minWidth: `${Math.min(Math.max(128, rect.width) + 2, availableWidth)}px`, maxWidth: `${availableWidth}px` }
  const width = menu.value.offsetWidth
  if (rect.bottom <= top || rect.top >= bottom) { close(); return }
  const below = bottom - rect.bottom, above = rect.top - top, wanted = (viewport.value?.scrollHeight || 0) + 2
  const up = below < wanted && above > below
  const height = Math.max(0, Math.min(wanted, up ? above : below))
  side.value = up ? 'top' : 'bottom'
  const menuLeft = Math.max(left, Math.min(rect.left + rect.width / 2 - width / 2, left + availableWidth - width))
  // CF's explicit long-label safety exception clamps Radix's intrinsic width to the viewport.
  menuStyle.value = { ...menuStyle.value, maxHeight: `${height}px`, left: `${menuLeft}px`, top: `${up ? rect.top - 4 - height : rect.bottom + 4}px`, transformOrigin: `${rect.left + rect.width / 2 - menuLeft}px ${up ? 'bottom' : 'top'}` }
  nextTick(scrolledOptions)
}
const focus = index => {
  const option = menu.value?.querySelectorAll('[role=option]')[index]
  option?.focus({ preventScroll: true }); option?.scrollIntoView({ block: 'nearest' })
  if (index === 0 && viewport.value) viewport.value.scrollTop = 0
  if (index === options.value.length - 1 && viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
  nextTick(scrolledOptions)
}
const show = async () => {
  if (open.value) return
  window.dispatchEvent(new CustomEvent('admin-picker-open', { detail: menuId }))
  query = ''; typedAt = 0
  if (!modalActive) {
    previousPointerEvents = document.body.style.pointerEvents
    document.body.style.pointerEvents = 'none'
    modalActive = true
  }
  restoreFocus = false
  open.value = true
  await nextTick(); position(); await nextTick(); position()
  if (open.value) { focus(Math.max(0, options.value.findIndex(option => option.value === props.modelValue))); hideOutside() }
}
const triggerPointer = event => {
  pointerType = event.pointerType
  if (event.button === 0 && !event.ctrlKey && pointerType === 'mouse') { event.preventDefault(); open.value ? close(true) : show() }
}
const triggerClick = event => {
  if (pointerType !== 'mouse' || event.detail === 0) { event.currentTarget.focus(); open.value ? close(true) : show() }
}
const select = value => { if (open.value) { emit('update:modelValue', value); close(true) } }
const typeahead = event => {
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
  const now = performance.now()
  query = now - typedAt > 1000 ? event.key : query + event.key; typedAt = now
  const letters = [...query], term = (letters.every(letter => letter === letters[0]) ? letters[0] : query).toLocaleLowerCase()
  const current = open.value ? Number(document.activeElement?.dataset.index ?? -1) : options.value.findIndex(option => option.value === props.modelValue)
  const start = Math.max(0, current)
  for (let i = 0; i < options.value.length; i++) {
    const index = (start + i) % options.value.length
    if (term.length === 1 && index === current) continue
    if (options.value[index].label.toLocaleLowerCase().startsWith(term)) {
      if (open.value) focus(index)
      else emit('update:modelValue', options.value[index].value)
      break
    }
  }
  event.preventDefault()
}
const triggerKey = async event => {
  if (event.isComposing) return
  if (event.key === ' ' && query && performance.now() - typedAt <= 1000) { typeahead(event); return }
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); await show() }
  else typeahead(event)
}
const menuKey = event => {
  if (event.isComposing) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
  if (event.key === 'Tab') { event.preventDefault(); return }
  if (event.key === 'Enter' || (event.key === ' ' && (!query || performance.now() - typedAt > 1000))) {
    event.preventDefault()
    const option = options.value[Number(document.activeElement?.dataset.index)]
    if (option) select(option.value)
    return
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const index = Number(document.activeElement?.dataset.index ?? -1), last = options.value.length - 1
    event.preventDefault()
    focus(event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowDown' ? Math.min(last, index + 1) : index < 0 ? last : Math.max(0, index - 1))
  } else typeahead(event)
}
const outside = event => { if (open.value && !root.value?.contains(event.target)) close(true) }
const blur = event => {
  if (!open.value || !event.relatedTarget || root.value?.contains(event.relatedTarget)) return
  // An existing CF dialog owns its own trap; release the select rather than competing.
  if (event.relatedTarget.closest('[role=dialog]')) { close(); releaseModal() }
  else lastFocused?.focus({ preventScroll: true })
}
const scrolled = event => { if (!menu.value?.contains(event.target)) position() }
const otherOpened = event => { if (event.detail !== menuId) { close(); releaseModal() } }
const windowClosed = () => { if (open.value) close(true) }
watch([() => props.groups, () => props.active], () => { close(); releaseModal() })
watch([canUp, canDown], () => {
  const focused = document.activeElement
  if (open.value && focused?.matches('[role=option]') && menu.value?.contains(focused)) focused.scrollIntoView({ block: 'nearest' })
}, { flush: 'post' })
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('scroll', scrolled, true)
  document.addEventListener('wheel', blockScroll, { passive: false })
  document.addEventListener('touchmove', blockScroll, { passive: false })
  window.addEventListener('resize', windowClosed)
  window.addEventListener('blur', windowClosed)
  window.addEventListener('admin-picker-open', otherOpened)
  window.visualViewport?.addEventListener('resize', position)
  window.visualViewport?.addEventListener('scroll', position)
})
onBeforeUnmount(() => {
  stopScroll()
  releaseModal()
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('scroll', scrolled, true)
  document.removeEventListener('wheel', blockScroll)
  document.removeEventListener('touchmove', blockScroll)
  window.removeEventListener('resize', windowClosed)
  window.removeEventListener('blur', windowClosed)
  window.removeEventListener('admin-picker-open', otherOpened)
  window.visualViewport?.removeEventListener('resize', position)
  window.visualViewport?.removeEventListener('scroll', position)
})
</script>

<style scoped>
.admin-toolbar-group { width: 128px; flex-shrink: 0; }
.admin-toolbar-group-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
.admin-toolbar-group-trigger span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.admin-toolbar-group-trigger svg { opacity: .5; color: var(--cf-muted); }
.admin-toolbar-group-menu { position: fixed; z-index: 50; display: flex; flex-direction: column; width: max-content; overflow: hidden; border: 1px solid var(--cf-border); border-radius: 8px; background: var(--toolbar-popover); color: var(--cf-text); font-family: var(--toolbar-font); font-size: 16px; line-height: 24px; box-shadow: var(--toolbar-empty-shadow), var(--toolbar-empty-shadow), var(--toolbar-empty-shadow), var(--toolbar-empty-shadow), 0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .1); transform-origin: top center; pointer-events: auto; }
.admin-toolbar-group-menu[data-side=top] { transform-origin: bottom center; }
/* Stable siblings keep Vue from moving the focused viewport when a scroll arrow changes. */
.admin-toolbar-group-viewport { min-height: 0; padding: 4px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
.admin-toolbar-group-viewport::-webkit-scrollbar { display: none; }
.admin-toolbar-group-scroll { display: flex; flex-shrink: 0; justify-content: center; padding: 4px 0; cursor: default; }
.admin-toolbar-group-scroll.is-up svg { transform: rotate(180deg); }
.admin-toolbar-group-menu button { position: relative; display: flex; align-items: center; width: 100%; min-height: 32px; padding: 6px 32px 6px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font-size: 14px; line-height: 20px; text-align: left; cursor: default; }
.admin-toolbar-group-menu button:focus { background: var(--cf-soft); outline: none; }
.admin-toolbar-group-menu button span { min-width: 0; overflow-wrap: anywhere; }
.admin-toolbar-group-indicator { position: absolute; right: 8px; display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; }
.admin-select-enter-active { animation: admin-select-in 150ms; }
.admin-select-leave-active { animation: admin-select-out 150ms; pointer-events: none; }
@keyframes admin-select-in { from { opacity: 0; transform: translateY(-8px) scale(.95); } to { opacity: 1; transform: none; } }
@keyframes admin-select-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(.95); } }
.admin-select-enter-active[data-side=top] { animation-name: admin-select-in-up; }
@keyframes admin-select-in-up { from { opacity: 0; transform: translateY(8px) scale(.95); } to { opacity: 1; transform: none; } }
</style>
