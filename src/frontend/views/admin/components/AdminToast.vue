<template>
  <Teleport :disabled="!teleport" :to="target || 'body'">
      <section :key="noticeGeneration" class="admin-ui download-credential-feedback" aria-label="Notifications alt+T" tabindex="-1" aria-live="polite" aria-relevant="additions text" aria-atomic="false">
        <ol ref="noticeList" class="download-credential-toaster" dir="ltr" tabindex="-1" @focusin="noticeFocus" @focusout="noticeBlur">
          <Transition name="download-notice" :duration="{enter:400,leave:200}">
            <li v-if="credentialNotice" ref="noticeElement" data-credential-notice class="download-credential-notice" :class="{'is-swiping':noticePointer,'is-swipe-out':noticeSwipeOut}" :style="{'--download-swipe':`${noticeSwipe}px`}" tabindex="0" :role="displayNotice.type === 'error' ? 'alert' : 'status'" @mouseenter="expandCredentialNotice" @mousemove="expandCredentialNotice" @mouseleave="!noticePointer && collapseCredentialNotice()" @pointerdown="startNoticeSwipe" @pointermove="moveNoticeSwipe" @pointerup="endNoticeSwipe" @pointercancel="endNoticeSwipe">
              <div data-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" height="20" width="20" aria-hidden="true"><path fill-rule="evenodd" :d="displayNotice.type === 'error' ? 'M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z' : 'M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z'" clip-rule="evenodd" /></svg></div>
              <div data-content><div data-title data-credential-notice-text>{{ displayNotice.text }}</div></div>
            </li>
          </Transition>
        </ol>
      </section>
  </Teleport>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import '../../../styles/admin-toast.css'
const props = defineProps({ notice: {type:Object, default:null}, teleport: {type:Boolean, default:false} })
const displayNotice = ref({text:'',type:'success'})
const credentialNotice = ref(false), noticeGeneration = ref(0), noticeElement = ref(null), noticeList = ref(null)
const noticePointer = ref(null), noticeSwipe = ref(0), noticeSwipeOut = ref(false), target = ref(null)
let noticeTimer = null, noticeRemaining = 4000, noticeStarted = 0, noticeExpanded = false, noticePreviousFocus = null, previousFocus = null
const noticeFocus = event => {
  if (!event.currentTarget.contains(event.relatedTarget)) noticePreviousFocus = event.relatedTarget
}
const noticeBlur = event => {
  if (event.currentTarget.contains(event.relatedTarget)) return
  const previous = noticePreviousFocus
  noticePreviousFocus = null
  const dialog = event.currentTarget.closest('.admin-dialog')
  if (previous?.isConnected && (!dialog || dialog.contains(previous))) previous.focus({preventScroll:true})
}
const clearCredentialNotice = () => {
  clearTimeout(noticeTimer)
  noticeTimer = null
  if (noticeElement.value === document.activeElement || noticeList.value === document.activeElement) previousFocus?.isConnected && previousFocus.focus({preventScroll:true})
  noticePreviousFocus = null
  noticeExpanded = false
  credentialNotice.value = false
}
const pauseCredentialNotice = () => {
  if (noticeTimer) noticeRemaining -= Date.now() - noticeStarted
  clearTimeout(noticeTimer)
  noticeTimer = null
}
const resumeCredentialNotice = () => {
  if (!credentialNotice.value || document.hidden || noticeExpanded || noticePointer.value || noticeTimer) return
  noticeStarted = Date.now()
  noticeTimer = setTimeout(clearCredentialNotice, noticeRemaining)
}
const expandCredentialNotice = () => { noticeExpanded = true; pauseCredentialNotice() }
const collapseCredentialNotice = () => { noticeExpanded = false; resumeCredentialNotice() }
const noticeVisibility = () => document.hidden ? pauseCredentialNotice() : resumeCredentialNotice()
const noticeHotkey = event => {
  const list = noticeList.value
  const top = [...document.querySelectorAll('.admin-dialog')].at(-1)
  if (!list || (top && (top !== list.closest('.admin-dialog') || !top.contains(document.activeElement)))) return
  if (event.altKey && event.code === 'KeyT') { expandCredentialNotice(); list.focus({preventScroll:true}) }
  if (event.code === 'Escape' && list.contains(document.activeElement)) {
    // Handle the top-layer toast before the owning dialog's document capture handler.
    event.preventDefault(); event.stopImmediatePropagation(); collapseCredentialNotice()
  }
}
watch(credentialNotice, visible => {
  if (visible) { document.addEventListener('visibilitychange', noticeVisibility); window.addEventListener('keydown', noticeHotkey, true) }
  else { document.removeEventListener('visibilitychange', noticeVisibility); window.removeEventListener('keydown', noticeHotkey, true) }
}, {flush:'sync'})
const startNoticeSwipe = event => {
  if (event.button === 2) return
  event.currentTarget.setPointerCapture(event.pointerId)
  noticePointer.value = {x:event.clientX,y:event.clientY,time:Date.now(),axis:''}
  pauseCredentialNotice()
}
const moveNoticeSwipe = event => {
  const start = noticePointer.value
  if (!start || window.getSelection()?.toString()) return
  const x = event.clientX - start.x, y = event.clientY - start.y
  if (!start.axis && (Math.abs(x) > 1 || Math.abs(y) > 1)) start.axis = Math.abs(x) > Math.abs(y) ? 'x' : 'y'
  noticeSwipe.value = start.axis === 'y' ? y < 0 ? y : y / (1.5 + Math.abs(y) / 20) : 0
}
const endNoticeSwipe = () => {
  const start = noticePointer.value
  noticePointer.value = null
  if (start?.axis === 'y' && noticeSwipe.value < 0 && (-noticeSwipe.value >= 45 || -noticeSwipe.value / (Date.now() - start.time) > .11)) {
    noticeSwipeOut.value = true
    clearCredentialNotice()
  } else { noticeSwipe.value = 0; resumeCredentialNotice() }
}

watch(() => props.notice, notice => {
  clearCredentialNotice()
  if (!notice) { noticeGeneration.value++; return }
  displayNotice.value = notice
  previousFocus = document.activeElement
  target.value = [...document.querySelectorAll('.admin-dialog')].at(-1) || document.body
  noticeRemaining = 4000
  noticePointer.value = null; noticeSwipe.value = 0; noticeSwipeOut.value = false
  credentialNotice.value = true
  resumeCredentialNotice()
}, {flush:'post', immediate:true})
onBeforeUnmount(clearCredentialNotice)
</script>
