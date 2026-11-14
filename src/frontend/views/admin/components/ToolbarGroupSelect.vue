<template>
  <div ref="root" class="admin-toolbar-group" @focusout="blur">
    <button ref="trigger" type="button" class="toolbar-select admin-toolbar-group-trigger" :title="summary" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open ? menuId : undefined" @click="open ? close() : show()" @keydown="triggerKey">
      <span>{{ summary }}</span><AdminIcon name="chevron-down" />
    </button>
    <div v-if="open" :id="menuId" ref="menu" class="admin-toolbar-group-menu" role="listbox" :aria-label="label" :style="menuStyle" @keydown="menuKey">
      <button v-for="(option, index) in options" :key="option.value" type="button" role="option" :aria-selected="modelValue === option.value" tabindex="-1" :data-index="index" @click="select(option.value)" @pointermove="!$event.buttons && $event.currentTarget.focus({ preventScroll: true })">
        <span>{{ option.label }}</span><AdminIcon v-if="modelValue === option.value" name="check" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdminIcon from './AdminIcon.vue'

const props = defineProps({ modelValue: String, groups: Array, allLabel: String, label: String, active: Boolean })
const emit = defineEmits(['update:modelValue'])
const root = ref(null), trigger = ref(null), menu = ref(null), open = ref(false), menuStyle = ref({})
const menuId = `admin-toolbar-group-${crypto.randomUUID()}`
const options = computed(() => [{ value: '', label: props.allLabel }, ...props.groups.map(group => ({ value: group, label: group }))])
const summary = computed(() => options.value.find(option => option.value === props.modelValue)?.label || props.allLabel)
let query = '', typedAt = 0
const close = (restore = false) => {
  open.value = false; query = ''; typedAt = 0
  if (restore) trigger.value?.focus({ preventScroll: true })
}
const position = () => {
  if (!open.value || !menu.value) return
  const rect = trigger.value.getBoundingClientRect(), viewport = window.visualViewport
  const top = (viewport?.offsetTop || 0) + 8, bottom = top + (viewport?.height || innerHeight) - 16
  const left = (viewport?.offsetLeft || 0) + 8, width = Math.min(Math.max(rect.width, 200), (viewport?.width || innerWidth) - 16)
  if (rect.bottom <= top || rect.top >= bottom) { close(); return }
  const below = bottom - rect.bottom - 4, above = rect.top - top - 4
  const up = below < Math.min(menu.value.scrollHeight, 240) && above > below
  const height = Math.max(0, Math.min(240, up ? above : below))
  const drawnHeight = Math.min(menu.value.scrollHeight + 2, height)
  // Like the existing admin picker, fixed positioning escapes the content scrollport.
  menuStyle.value = { width: `${width}px`, maxHeight: `${height}px`, left: `${Math.max(left, Math.min(rect.left, left + (viewport?.width || innerWidth) - 16 - width))}px`, top: `${up ? rect.top - 4 - drawnHeight : rect.bottom + 4}px` }
}
const focus = index => {
  const option = menu.value?.querySelectorAll('[role=option]')[index]
  option?.focus({ preventScroll: true }); option?.scrollIntoView({ block: 'nearest' })
}
const show = async () => {
  if (open.value) return
  window.dispatchEvent(new CustomEvent('admin-picker-open', { detail: menuId }))
  open.value = true
  await nextTick(); position()
  if (open.value) focus(Math.max(0, options.value.findIndex(option => option.value === props.modelValue)))
}
const select = value => { emit('update:modelValue', value); close(true) }
const typeahead = event => {
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.key === ' ' || event.isComposing) return
  const now = performance.now()
  query = now - typedAt > 700 ? event.key : query + event.key; typedAt = now
  const letters = [...query], term = (letters.every(letter => letter === letters[0]) ? letters[0] : query).toLocaleLowerCase()
  const current = Number(document.activeElement?.dataset.index ?? -1)
  const start = term.length === 1 ? current + 1 : Math.max(0, current)
  for (let i = 0; i < options.value.length; i++) {
    const index = (start + i) % options.value.length
    if (options.value[index].label.toLocaleLowerCase().startsWith(term)) { focus(index); break }
  }
  event.preventDefault()
}
const triggerKey = async event => {
  if (event.isComposing) return
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); await show() }
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { await show(); typeahead(event) }
}
const menuKey = event => {
  if (event.isComposing) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
  if (event.key === 'Tab') { close(true); return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const index = Number(document.activeElement?.dataset.index ?? -1), last = options.value.length - 1
    event.preventDefault()
    focus(event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowDown' ? Math.min(last, index + 1) : Math.max(0, index - 1))
  } else typeahead(event)
}
const outside = event => { if (!root.value?.contains(event.target)) close() }
const blur = event => { if (event.relatedTarget && !root.value?.contains(event.relatedTarget)) close() }
const scrolled = event => { if (!menu.value?.contains(event.target)) position() }
const otherOpened = event => { if (event.detail !== menuId) close() }
watch([() => props.groups, () => props.active], () => close())
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('scroll', scrolled, true)
  window.addEventListener('resize', position)
  window.addEventListener('admin-picker-open', otherOpened)
  window.visualViewport?.addEventListener('resize', position)
  window.visualViewport?.addEventListener('scroll', position)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('scroll', scrolled, true)
  window.removeEventListener('resize', position)
  window.removeEventListener('admin-picker-open', otherOpened)
  window.visualViewport?.removeEventListener('resize', position)
  window.visualViewport?.removeEventListener('scroll', position)
})
</script>

<style scoped>
.admin-toolbar-group { width: 128px; flex-shrink: 0; }
.admin-toolbar-group-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
.admin-toolbar-group-trigger span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.admin-toolbar-group-trigger svg { opacity: .5; }
.admin-toolbar-group-menu { position: fixed; z-index: 50; width: 200px; padding: 4px; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--cf-border); border-radius: 6px; background: var(--cf-panel); color: var(--cf-text); box-shadow: 0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a; }
.admin-toolbar-group-menu button { position: relative; display: flex; align-items: center; width: 100%; min-height: 32px; padding: 6px 32px 6px 8px; border: 0; border-radius: 2px; background: transparent; color: inherit; font-size: 14px; line-height: 20px; text-align: left; cursor: default; }
.admin-toolbar-group-menu button:focus { background: var(--cf-soft); outline: none; }
.admin-toolbar-group-menu button span { min-width: 0; overflow-wrap: anywhere; }
.admin-toolbar-group-menu button svg { position: absolute; right: 8px; }
@media (pointer: coarse) { .admin-toolbar-group-menu button { min-height: 44px; } }
</style>
