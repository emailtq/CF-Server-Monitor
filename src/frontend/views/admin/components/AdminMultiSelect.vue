<template>
  <div ref="root" class="admin-picker" :data-side="side">
    <button ref="trigger" type="button" class="admin-picker-summary" :title="summary" :aria-label="label || t('adminSelectItems')" :aria-expanded="open" :aria-controls="menuId" aria-haspopup="true" @click="toggle" @keydown.down.prevent="show" @keydown.up.prevent="show">
      <span>{{ summary }}</span><AdminIcon name="chevron-down" />
    </button>
    <div v-if="open" :id="menuId" ref="menu" class="admin-picker-menu" :style="menuStyle" @keydown="keydown">
      <div class="admin-picker-search"><input ref="search" v-model="query" type="search" :aria-label="t('adminSearchOptions')" :placeholder="t('adminSearchOptions')" /></div>
      <div class="admin-picker-count" role="status">{{ modelValue.length }} / {{ options.length }} {{ t('adminSelected') }}</div>
      <div ref="list" class="admin-picker-options" :style="{ maxHeight: `${listHeight}px` }">
        <slot name="before-options" />
        <label v-for="option in filtered" :key="option.value" class="admin-picker-option" :class="{ 'is-disabled': unavailable(option) }">
          <input type="checkbox" :value="option.value" :checked="modelValue.includes(option.value)" :disabled="unavailable(option)" :aria-label="option.label" @change="select(option, $event)" />
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
const search = ref(null)
const list = ref(null)
const menu = ref(null)
const menuStyle = ref({})
const open = ref(false)
const query = ref('')
const side = ref('down')
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
const close = (restore = false) => { open.value = false; if (restore) trigger.value?.focus() }
const position = () => {
  if (!open.value || !menu.value) return
  const rect = trigger.value.getBoundingClientRect()
  const container = root.value.closest('.admin-dialog-body')?.getBoundingClientRect()
  const viewport = window.visualViewport
  const top = (viewport?.offsetTop || 0) + 16
  const bottom = top + (viewport?.height || innerHeight) - 32
  if (rect.bottom <= (container?.top ?? top) || rect.top >= (container?.bottom ?? bottom)) { close(); return }
  const chrome = menu.value.offsetHeight - list.value.offsetHeight
  const below = bottom - rect.bottom - 4
  const above = rect.top - top - 4
  side.value = below < chrome + 200 && above > below ? 'up' : 'down'
  const space = Math.max(above, below)
  const rowHeight = window.matchMedia('(pointer: coarse)').matches ? 44 : 38
  listHeight.value = Math.max(rowHeight, Math.min(200, space - chrome))
  const height = chrome + Math.min(list.value.scrollHeight, listHeight.value)
  const left = (viewport?.offsetLeft || 0) + 16
  const width = Math.min(rect.width, (viewport?.width || innerWidth) - 32)
  // Fixed positioning escapes scroll-body clipping; DOM ownership stays in the dialog.
  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.max(left, Math.min(rect.left, left + (viewport?.width || innerWidth) - 32 - width))}px`,
    top: `${Math.max(top, Math.min(side.value === 'up' ? rect.top - 4 - height : rect.bottom + 4, bottom - height))}px`
  }
}
const show = async () => {
  if (open.value) return
  window.dispatchEvent(new CustomEvent('admin-picker-open', { detail: menuId }))
  query.value = ''; open.value = true
  await nextTick(); position(); search.value?.focus()
}
const toggle = () => open.value ? close() : show()
const keydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const options = [...list.value.querySelectorAll('input:not(:disabled)')]
  const index = options.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? Math.min(options.length - 1, index + 1) : index < 0 ? options.length - 1 : Math.max(0, index - 1)
  event.preventDefault(); options[next]?.focus()
}
const otherOpened = event => { if (event.detail !== menuId) close() }
const outside = event => { if (!root.value?.contains(event.target)) close() }
const blur = event => { if (event.relatedTarget && !root.value?.contains(event.relatedTarget)) close() }
const scrolled = event => { if (!menu.value?.contains(event.target)) position() }
let observer
watch(() => [props.modelValue, query.value, props.options], () => nextTick(position))
onMounted(() => {
  window.addEventListener('admin-picker-open', otherOpened)
  window.addEventListener('resize', position)
  document.addEventListener('scroll', scrolled, true)
  window.visualViewport?.addEventListener('resize', position)
  window.visualViewport?.addEventListener('scroll', position)
  document.addEventListener('pointerdown', outside)
  root.value.addEventListener('focusout', blur)
  observer = new ResizeObserver(position)
  observer.observe(trigger.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('admin-picker-open', otherOpened)
  window.removeEventListener('resize', position)
  document.removeEventListener('scroll', scrolled, true)
  window.visualViewport?.removeEventListener('resize', position)
  window.visualViewport?.removeEventListener('scroll', position)
  document.removeEventListener('pointerdown', outside)
  root.value?.removeEventListener('focusout', blur)
  observer?.disconnect()
})
</script>
