<template>
  <div ref="root" class="admin-group-combobox" :data-open="shown ? '' : undefined" @focusout="!root.contains($event.relatedTarget) && (open = false)">
    <input :id="id" :name="inputName" ref="input" v-model="name" class="form-input" :disabled="disabled" :role="counts.size ? 'combobox' : undefined" :aria-expanded="counts.size ? shown : undefined" :aria-controls="shown ? listId : undefined" :aria-activedescendant="shown && items[active] !== undefined ? `${listId}-${active}` : undefined" :aria-autocomplete="counts.size ? 'list' : undefined" :placeholder="trans.adminUngrouped" autocomplete="off" @click="show" @input="typed = true; active = -1; open = true" @keydown="key">
    <button v-if="counts.size" type="button" tabindex="-1" :disabled="disabled" :aria-label="trans.adminChooseGroup" @pointerdown.prevent="shown ? open = false : (input.focus({ preventScroll: true }), show())"><AdminIcon name="chevron-down" :class="{ 'is-open': shown }" /></button>
    <Transition name="admin-group-popover">
      <div v-if="shown" ref="menu" class="admin-group-options" :style="menuStyle" @mousedown.prevent>
        <div :id="listId" role="listbox" :aria-label="trans.adminExistingGroups">
          <div v-for="(group, index) in items" :key="group">
            <div v-if="!group" class="admin-group-option-divider" />
            <div :id="`${listId}-${index}`" role="option" :aria-selected="group === name.trim()" :class="['admin-group-option', { 'is-active': index === active }]" @pointermove="$event.pointerType === 'mouse' && (active = index)" @click="pick(group)">
              <span :class="{ 'text-muted': !group }">{{ group || trans.adminUngrouped }}</span><small v-if="group">{{ counts.get(group) }} {{ trans.adminGroupNodeUnit }}</small><AdminIcon v-if="group === name.trim()" name="check" />
            </div>
          </div>
          <p v-if="fresh" class="admin-group-fresh">{{ trans.adminNewGroupHint.replace('{name}', name.trim()) }}</p>
        </div>
      </div>
    </Transition>
  </div>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdminIcon from './AdminIcon.vue'
import '../../../styles/admin-group.css'
const props = defineProps({ id: String, inputName: String, servers: { type: Array, default: () => [] }, trans: Object, disabled: Boolean })
const name = defineModel({ type: String, default: '' })
const root = ref(null), input = ref(null), menu = ref(null), open = ref(false), typed = ref(false), active = ref(0), menuStyle = ref({})
const listId = `admin-group-names-${crypto.randomUUID()}`
const counts = computed(() => { const groups = new Map(); for (const server of props.servers) if (server.server_group) groups.set(server.server_group, (groups.get(server.server_group) || 0) + 1); return groups })
const query = computed(() => typed.value ? name.value.trim().toLowerCase() : '')
const matches = computed(() => [...counts.value.keys()].filter(group => group.toLowerCase().includes(query.value)))
const items = computed(() => query.value ? matches.value : [...matches.value, ''])
const fresh = computed(() => typed.value && !!name.value.trim() && !counts.value.has(name.value.trim()))
const shown = computed(() => !props.disabled && open.value && counts.value.size > 0 && (matches.value.length > 0 || fresh.value))
const show = () => { typed.value = false; active.value = Math.max(0, [...counts.value.keys(), ''].indexOf(name.value.trim())); open.value = true }
const pick = group => { name.value = group; typed.value = false; open.value = false }
const position = () => {
  if (!shown.value || !menu.value) return
  const rect = input.value.getBoundingClientRect(), viewport = window.visualViewport
  const top = (viewport?.offsetTop || 0) + 8, bottom = top + (viewport?.height || innerHeight) - 16
  const below = bottom - rect.bottom - 4
  const height = Math.max(0, Math.min(menu.value.scrollHeight + 2, 250, below))
  menuStyle.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px`, width: `${rect.width}px`, maxHeight: `${height}px`, transformOrigin: 'top', visibility: below >= 10 ? undefined : 'hidden' }
}
const key = event => {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && shown.value) { event.preventDefault(); event.stopPropagation(); open.value = false }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!shown.value) return show()
    if (!items.value.length) return
    const down = event.key === 'ArrowDown'
    active.value = active.value < 0 ? down ? 0 : items.value.length - 1 : (active.value + (down ? 1 : -1) + items.value.length) % items.value.length
  } else if (event.key === 'Enter' && shown.value) {
    event.preventDefault()
    if (items.value[active.value] !== undefined) pick(items.value[active.value])
    else open.value = false
  }
}
const outside = event => { if (!root.value?.contains(event.target)) open.value = false }
const viewportChanged = () => requestAnimationFrame(position)
let observer
watch([shown, active, items], async () => { await nextTick(); position(); if (shown.value) document.getElementById(`${listId}-${active.value}`)?.scrollIntoView({ block: 'nearest' }) })
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  window.addEventListener('resize', position)
  window.addEventListener('scroll', position, true)
  window.visualViewport?.addEventListener('resize', viewportChanged)
  window.visualViewport?.addEventListener('scroll', viewportChanged)
  observer = new ResizeObserver(position)
  observer.observe(root.value.closest('.admin-dialog'))
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside)
  window.removeEventListener('resize', position)
  window.removeEventListener('scroll', position, true)
  window.visualViewport?.removeEventListener('resize', viewportChanged)
  window.visualViewport?.removeEventListener('scroll', viewportChanged)
  observer?.disconnect()
})
</script>
