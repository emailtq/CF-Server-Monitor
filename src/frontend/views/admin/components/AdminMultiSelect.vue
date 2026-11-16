<template>
  <div ref="root" class="admin-picker" :data-open="open ? '' : undefined" @keydown="keydown">
    <input ref="trigger" v-model="query" type="search" autocomplete="off" class="admin-picker-summary" :title="summary" :placeholder="summary" :aria-label="(label || t('adminSelectItems')) + ' · ' + t('adminSearchOptions')" role="combobox" :aria-expanded="open" :aria-controls="open ? menuId : undefined" :aria-activedescendant="open && activeId ? activeId : undefined" aria-autocomplete="list" aria-haspopup="listbox" @click="show" @input="activeId = ''; show()" />
    <button type="button" class="admin-picker-arrow" tabindex="-1" :aria-label="label || t('adminSelectItems')" :aria-expanded="open" @mousedown.prevent @click="toggle"><AdminIcon name="chevron-down" /></button>
    <div v-if="open" ref="menu" class="admin-picker-menu" :style="menuStyle" @mousedown.prevent>
      <div class="admin-picker-count" role="status">{{ modelValue.length }} / {{ options.length }} {{ t('adminSelected') }}</div>
      <div :id="menuId" ref="list" class="admin-picker-options" role="listbox" :aria-label="label || t('adminSelectItems')" aria-multiselectable="true" :style="{ maxHeight: `${listHeight}px` }">
        <slot name="before-options" :option-id="`${menuId}-scope`" :active="activeId === `${menuId}-scope`" />
        <label v-for="(option, index) in filtered" :id="`${menuId}-${index}`" :key="option.value" class="admin-picker-option" role="option" :aria-selected="modelValue.includes(option.value)" :aria-disabled="unavailable(option)" :class="{ 'is-disabled': unavailable(option), 'is-active': activeId === `${menuId}-${index}` }">
          <input type="checkbox" tabindex="-1" :value="option.value" :checked="modelValue.includes(option.value)" :disabled="unavailable(option)" :aria-label="option.label" @change="select(option, $event)" />
          <span>{{ option.label }}<small v-if="option.description">{{ option.description }}</small></span>
        </label>
        <p v-if="!filtered.length" class="admin-picker-empty">{{ t('adminNoOptions') }}</p>
      </div>
    </div>
    <div v-if="chosen.length" class="admin-picker-tags"><span v-for="option in chosen.slice(0, 2)" :key="option.value" :title="option.label">{{ option.label }}</span><span v-if="modelValue.length > 2">+{{ modelValue.length - 2 }}</span></div>
  </div>
</template>

<script setup>
import AdminIcon from './AdminIcon.vue'
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../../../utils/i18n.js'
import '../../../styles/admin.css'
const props = defineProps({ modelValue: { type: Array, required: true }, options: { type: Array, required: true }, minSelected: { type: Number, default: 0 }, label: { type: String, default: '' }, summary: { type: String, default: undefined } })
const emit = defineEmits(['update:modelValue'])
const root = ref(null)
const trigger = ref(null)
const list = ref(null)
const menu = ref(null)
const menuStyle = ref({})
const open = ref(false)
const query = ref('')
const activeId = ref('')
const listHeight = ref(200)
const menuId = `admin-picker-${crypto.randomUUID()}`
const chosen = computed(() => props.modelValue.map(value => props.options.find(o => o.value === value) || { value, label: value }))
const summary = computed(() => props.summary ?? (props.modelValue.length === 1 ? chosen.value[0].label : `${props.modelValue.length} / ${props.options.length} ${t('adminSelected')}`))
const filtered = computed(() => props.options.filter(o => `${o.label} ${o.description || ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const unavailable = option => option.disabled || (props.modelValue.includes(option.value) && props.modelValue.length <= props.minSelected)
const select = (option, event) => {
  if (unavailable(option)) { event.target.checked = props.modelValue.includes(option.value); return }
  emit('update:modelValue', event.target.checked ? [...props.modelValue, option.value] : props.modelValue.filter(value => value !== option.value))
}
const close = (restore = false) => { open.value = false; query.value = ''; activeId.value = ''; if (restore && document.activeElement !== trigger.value) trigger.value?.focus({ preventScroll: true }) }
const position = (closeOffscreen = false) => {
  if (!open.value || !menu.value) return
  const rect = trigger.value.getBoundingClientRect()
  const body = root.value.closest('.admin-dialog-body')
  const scrollport = body?.closest('.admin-dialog-scroll') || body
  const container = scrollport?.getBoundingClientRect()
  const viewport = window.visualViewport
  const top = (viewport?.offsetTop || 0) + 16
  const bottom = top + (viewport?.height || innerHeight) - 32
  const visibleTop = Math.max(top, container ? container.top + scrollport.clientTop : top)
  const visibleBottom = Math.min(bottom, container ? container.top + scrollport.clientTop + scrollport.clientHeight : bottom)
  // Keyboard panning must not dismiss the input's active search.
  if (closeOffscreen === true && document.activeElement !== trigger.value && (rect.bottom <= visibleTop || rect.top >= visibleBottom)) { close(); return }
  const chrome = menu.value.querySelector('.admin-picker-count').offsetHeight + menu.value.clientTop * 2
  const below = bottom - rect.bottom - 4
  // CF menus always open below; keyboard space shrinks the list, never moves focus or flips it.
  listHeight.value = Math.max(0, Math.min(200, below - chrome))
  const left = (viewport?.offsetLeft || 0) + 16
  const width = Math.min(rect.width, (viewport?.width || innerWidth) - 32)
  // Fixed positioning escapes scroll-body clipping; DOM ownership stays in the dialog.
  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.max(left, Math.min(rect.left, left + (viewport?.width || innerWidth) - 32 - width))}px`,
    top: `${rect.bottom + 4}px`,
    maxHeight: `${Math.max(0, below)}px`,
    visibility: below > 0 ? undefined : 'hidden'
  }
}
const show = async () => {
  if (open.value) return
  window.dispatchEvent(new CustomEvent('admin-picker-open', { detail: menuId }))
  open.value = true
  await nextTick(); position()
}
const toggle = () => { if (open.value) close(); else { trigger.value?.focus({ preventScroll: true }); show() } }
const keydown = async event => {
  if (event.isComposing || event.keyCode === 229) return
  if (!open.value) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); await show() }
    return
  }
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
  const options = [...list.value.querySelectorAll('input:not(:disabled)')]
  const index = options.findIndex(option => option.closest('label').id === activeId.value)
  if (['Enter', ' '].includes(event.key) && index >= 0) { event.preventDefault(); options[index].click(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  if (['Home', 'End'].includes(event.key) && index < 0) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? Math.min(options.length - 1, index + 1) : index < 0 ? options.length - 1 : Math.max(0, index - 1)
  event.preventDefault()
  const row = options[next]?.closest('label')
  if (!row) return
  row.id ||= `${menuId}-slot-${next}`
  activeId.value = row.id
  const top = row.offsetTop - list.value.offsetTop
  if (top < list.value.scrollTop) list.value.scrollTop = top
  else if (top + row.offsetHeight > list.value.scrollTop + list.value.clientHeight) list.value.scrollTop = top + row.offsetHeight - list.value.clientHeight
}
const otherOpened = event => { if (event.detail !== menuId) close() }
const outside = event => { if (!root.value?.contains(event.target)) close() }
const blur = event => { if (event.relatedTarget && !root.value?.contains(event.relatedTarget)) close() }
const scrolled = event => { if (!menu.value?.contains(event.target)) position(true) }
const viewportChanged = () => requestAnimationFrame(position)
let observer
watch(() => [props.modelValue, query.value, props.options], () => nextTick(position))
onMounted(() => {
  window.addEventListener('admin-picker-open', otherOpened)
  window.addEventListener('resize', position)
  document.addEventListener('scroll', scrolled, true)
  window.visualViewport?.addEventListener('resize', viewportChanged)
  window.visualViewport?.addEventListener('scroll', viewportChanged)
  document.addEventListener('pointerdown', outside)
  root.value.addEventListener('focusout', blur)
  observer = new ResizeObserver(position)
  observer.observe(trigger.value)
  const dialog = root.value.closest('.admin-dialog')
  if (dialog) observer.observe(dialog)
})
onBeforeUnmount(() => {
  window.removeEventListener('admin-picker-open', otherOpened)
  window.removeEventListener('resize', position)
  document.removeEventListener('scroll', scrolled, true)
  window.visualViewport?.removeEventListener('resize', viewportChanged)
  window.visualViewport?.removeEventListener('scroll', viewportChanged)
  document.removeEventListener('pointerdown', outside)
  root.value?.removeEventListener('focusout', blur)
  observer?.disconnect()
})
</script>
