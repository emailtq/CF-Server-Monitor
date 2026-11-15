<template>
  <Teleport :to="inDialog ? '.admin-dialog-body' : 'body'">
    <section :key="generation" class="admin-ui download-credential-feedback" aria-label="Notifications alt+T" tabindex="-1" aria-live="polite" aria-relevant="additions text" aria-atomic="false">
      <ol ref="list" class="download-credential-toaster" dir="ltr" tabindex="-1" @focusin="recordFocus" @focusout="restoreFocus">
        <Transition name="download-notice" :duration="{ enter: 400, leave: 200 }">
          <li v-if="message" ref="notice" class="download-credential-notice" :class="{ 'is-swiping': pointer, 'is-swipe-out': swipeOut }" :style="{ '--download-swipe': `${swipe}px` }" tabindex="0" :role="error ? 'alert' : 'status'" :data-latency-success="error ? undefined : ''" :data-latency-error="error ? '' : undefined" @mouseenter="expand" @mousemove="expand" @mouseleave="!pointer && collapse()" @pointerdown="startSwipe" @pointermove="moveSwipe" @pointerup="endSwipe" @pointercancel="endSwipe">
            <div data-icon><svg viewBox="0 0 20 20" fill="currentColor" height="20" width="20" aria-hidden="true"><path v-if="!error" fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /><path v-else fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg></div>
            <div data-content><div data-title>{{ message }}</div></div>
          </li>
        </Transition>
      </ol>
    </section>
  </Teleport>
</template>
<script setup>
// Reuse the accepted credential notice's Sonner surface and local lifetime/swipe behavior.
import { ref, watch, onBeforeUnmount } from 'vue'
import '../../../styles/admin-download.css'
const props = defineProps({ inDialog: Boolean })
const message = ref(''), error = ref(false), generation = ref(0), list = ref(null), notice = ref(null), pointer = ref(null), swipe = ref(0), swipeOut = ref(false)
let timer, remaining = 4000, started = 0, expanded = false, previousFocus = null
const recordFocus = event => { if (!event.currentTarget.contains(event.relatedTarget)) previousFocus = event.relatedTarget }
const restoreFocus = event => { if (!event.currentTarget.contains(event.relatedTarget) && previousFocus?.isConnected) { previousFocus.focus({ preventScroll: true }); previousFocus = null } }
const clear = () => {
  clearTimeout(timer); timer = null
  if (list.value?.contains(document.activeElement) && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null; expanded = false; message.value = ''
}
const pause = () => { if (timer) remaining -= Date.now() - started; clearTimeout(timer); timer = null }
const resume = () => { if (!message.value || document.hidden || expanded || pointer.value || timer) return; started = Date.now(); timer = setTimeout(clear, remaining) }
const expand = () => { expanded = true; pause() }
const collapse = () => { expanded = false; resume() }
const visibility = () => document.hidden ? pause() : resume()
const hotkey = event => {
  if (!list.value || !message.value) return
  if (event.altKey && event.code === 'KeyT') { expand(); list.value.focus({ preventScroll: true }) }
  if (event.code === 'Escape' && list.value.contains(document.activeElement)) { event.preventDefault(); event.stopImmediatePropagation(); collapse() }
}
const startSwipe = event => { if (event.button === 2) return; event.currentTarget.setPointerCapture(event.pointerId); pointer.value = { x: event.clientX, y: event.clientY, time: Date.now(), axis: '' }; pause() }
const moveSwipe = event => {
  const start = pointer.value
  if (!start || window.getSelection()?.toString()) return
  const x = event.clientX - start.x, y = event.clientY - start.y
  if (!start.axis && (Math.abs(x) > 1 || Math.abs(y) > 1)) start.axis = Math.abs(x) > Math.abs(y) ? 'x' : 'y'
  swipe.value = start.axis === 'y' ? y < 0 ? y : y / (1.5 + Math.abs(y) / 20) : 0
}
const endSwipe = () => {
  const start = pointer.value; pointer.value = null
  if (start?.axis === 'y' && swipe.value < 0 && (-swipe.value >= 45 || -swipe.value / (Date.now() - start.time) > .11)) { swipeOut.value = true; clear() }
  else { swipe.value = 0; resume() }
}
const show = (text, failed = false) => { clear(); generation.value++; remaining = 4000; pointer.value = null; swipe.value = 0; swipeOut.value = false; error.value = failed; message.value = text; resume() }
watch(message, visible => {
  if (visible) { document.addEventListener('visibilitychange', visibility); window.addEventListener('keydown', hotkey, true) }
  else { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('keydown', hotkey, true) }
}, { flush: 'sync' })
onBeforeUnmount(() => { clear(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('keydown', hotkey, true) })
defineExpose({ show, clear })
</script>
