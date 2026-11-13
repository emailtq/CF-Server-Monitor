import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export function useServerReorder(props, sortingDisabled, emit) {
  const body = ref(null)
  const manualOrder = ref([])
  const dragging = ref(null)
  const orderedServers = computed(() => {
    const byId = new Map(props.servers.map(server => [String(server.id), server]))
    const chosen = new Set(manualOrder.value)
    return [...manualOrder.value.map(id => byId.get(id)).filter(Boolean), ...props.servers.filter(server => !chosen.has(String(server.id)))]
  })
  const ids = () => orderedServers.value.map(server => String(server.id))
  let pointer = null, frame = 0, moving = false, slideRevision = 0, alive = true

  const slide = next => {
    const rows = [...(body.value?.rows || [])]
    const before = new Map(rows.map(row => [row, row.getBoundingClientRect().top]))
    rows.forEach(row => row.getAnimations().forEach(animation => { if (animation.id === 'server-slide') animation.cancel() }))
    const revision = ++slideRevision
    manualOrder.value = next
    moving = true
    nextTick(() => {
      if (!alive || revision !== slideRevision) return
      moving = false
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
      for (const [row, top] of before) {
        const dy = top - row.getBoundingClientRect().top
        if (dy && row.isConnected) row.animate({ transform: [`translateY(${dy}px)`, 'none'] }, { id: 'server-slide', duration: 150, easing: 'ease-out' })
      }
    })
  }
  const move = (id, to) => {
    const next = ids(), from = next.indexOf(id)
    if (from < 0 || to < 0 || to >= next.length || from === to) return
    next.splice(to, 0, ...next.splice(from, 1))
    slide(next)
    return next
  }
  const inside = () => {
    if (!pointer || !body.value) return false
    const table = body.value.closest('table').getBoundingClientRect()
    const wrapper = body.value.closest('.table-wrapper').getBoundingClientRect()
    return pointer.x >= Math.max(table.left, wrapper.left, 0) && pointer.x <= Math.min(table.right, wrapper.right, innerWidth) &&
      pointer.y >= Math.max(table.top, wrapper.top, 0) && pointer.y <= Math.min(table.bottom, wrapper.bottom, innerHeight)
  }
  const at = () => {
    if (!pointer?.active || moving || !inside()) return
    const rows = [...body.value.rows]
    if (!rows.length) return
    // Layout offsets ignore the in-flight FLIP transforms, unlike elementFromPoint.
    const y = pointer.y - rows[0].offsetParent.getBoundingClientRect().top
    const from = rows.findIndex(row => row.dataset.serverId === pointer.id)
    const to = rows.findIndex(row => y >= row.offsetTop && y < row.offsetTop + row.offsetHeight)
    if (from < 0 || to < 0 || from === to) return
    const target = rows[to], height = rows[from].offsetHeight
    // A short row only crosses a tall row once it will cover the pointer in its new slot.
    if (to > from ? y < target.offsetTop + target.offsetHeight - height : y >= target.offsetTop + height) return
    move(pointer.id, to)
  }
  const cleanup = () => {
    const previous = pointer
    pointer = null
    dragging.value = null
    cancelAnimationFrame(frame)
    document.documentElement.removeAttribute('data-server-reordering')
    document.removeEventListener('pointermove', onPointer)
    document.removeEventListener('pointerup', onPointer)
    document.removeEventListener('pointercancel', onPointer)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('blur', cancel)
    if (previous && body.value?.hasPointerCapture(previous.pointerId)) {
      body.value.releasePointerCapture(previous.pointerId)
    }
  }
  const cancel = () => {
    const before = pointer?.before, refreshed = pointer?.refreshed
    cleanup()
    if (before) slide(refreshed ? [] : before)
  }
  const finish = () => {
    const before = pointer.before, refreshed = pointer.refreshed, next = ids()
    cleanup()
    if (next.join() !== before.join()) emit('reorder', next)
    else if (refreshed) slide([])
  }
  const onKey = event => { if (event.key === 'Escape') cancel() }
  const onPointer = event => {
    if (!pointer || event.pointerId !== pointer.pointerId) return
    pointer.x = event.clientX
    pointer.y = event.clientY
    if (event.type === 'pointercancel' || (event.type === 'pointermove' && !event.buttons)) { cancel(); return }
    if (event.type === 'pointerup') {
      if (pointer.active && inside()) finish()
      else cancel()
      return
    }
    if (!pointer.active && Math.max(Math.abs(pointer.x - pointer.x0), Math.abs(pointer.y - pointer.y0)) >= 6) {
      pointer.active = true
      dragging.value = pointer.id
      document.documentElement.setAttribute('data-server-reordering', '')
      frame = requestAnimationFrame(scrollStep)
    }
    if (pointer.active) { event.preventDefault(); at() }
  }
  const scrollStep = now => {
    if (!pointer?.active) return
    const scroller = pointer.scroller
    const rect = scroller?.getBoundingClientRect()
    const top = rect ? Math.max(0, rect.top) : 0, bottom = rect ? Math.min(innerHeight, rect.bottom) : innerHeight
    const edge = Math.min(120, (bottom - top) / 4)
    const depth = pointer.y > pointer.y0 ? Math.max(0, pointer.y - bottom + edge) : -Math.max(0, top + edge - pointer.y)
    const elapsed = pointer.last ? Math.min(32, now - pointer.last) : 0
    const distance = Math.max(-1, Math.min(1, depth / edge)) * 900 * elapsed / 1000
    if (distance) {
      if (scroller) scroller.scrollTop += distance
      else window.scrollBy(0, distance)
    }
    pointer.last = now
    at()
    frame = requestAnimationFrame(scrollStep)
  }
  const handlePointerDown = (event, serverId) => {
    if (sortingDisabled.value || pointer || event.isPrimary === false || event.button !== 0) return
    const rows = event.currentTarget.closest('tbody')
    if (!rows) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    body.value = rows
    let scroller = rows.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    // Capture stays on tbody: Vue moves the handle's row, which would release its capture.
    rows.setPointerCapture(event.pointerId)
    const before = ids()
    manualOrder.value = before
    pointer = { pointerId: event.pointerId, id: String(serverId), x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, active: false, before, refreshed: false, scroller, last: 0 }
    document.addEventListener('pointermove', onPointer, { passive: false })
    document.addEventListener('pointerup', onPointer)
    document.addEventListener('pointercancel', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', cancel)
  }
  const handleKeyDown = (event, serverId) => {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (!delta || sortingDisabled.value || pointer) return
    event.preventDefault()
    const handle = event.currentTarget, id = String(serverId)
    body.value = handle.closest('tbody')
    const next = move(id, ids().indexOf(id) + delta)
    if (next) {
      emit('reorder', next)
      nextTick(() => { if (alive) handle.focus({ preventScroll: true }) })
    }
  }
  watch(() => props.servers, () => {
    const currentIds = new Set(props.servers.map(server => String(server.id)))
    if (pointer && currentIds.size === pointer.before.length && pointer.before.every(id => currentIds.has(id))) {
      // Keep the preview until release, then follow refreshed props unless a new order is saved.
      pointer.refreshed = true
      return
    }
    cancel()
    manualOrder.value = []
  })
  watch([() => props.selectedApiIndex, () => props.siteGeneration, () => props.activeTab, sortingDisabled], () => {
    cancel()
    manualOrder.value = []
  }, { flush: 'sync' })
  onBeforeUnmount(() => {
    alive = false
    cleanup()
    body.value?.querySelectorAll('tr').forEach(row => row.getAnimations().forEach(animation => { if (animation.id === 'server-slide') animation.cancel() }))
  })
  return { body, orderedServers, dragging, handlePointerDown, handleKeyDown, cancel }
}
