<template>
  <span ref="root" class="monitor-help" @mouseenter="schedule" @mouseleave="hide" @keydown.esc.prevent.stop="open = false">
    <button ref="trigger" type="button" :aria-label="label" :aria-describedby="open ? id : undefined" @pointerdown.prevent @click="show" @focus="schedule" @blur="hide"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg></button>
    <Teleport to="body"><div v-if="open" :id="id" ref="panel" role="tooltip" class="admin-ui monitor-help-panel" :style="position" @mouseenter="show" @mouseleave="hide">{{ text }}<i :style="{left:arrow}"/></div></Teleport>
  </span>
</template>
<script setup>
import {ref,nextTick,onBeforeUnmount} from 'vue'
defineProps({text:String,label:String})
const root=ref(null),trigger=ref(null),panel=ref(null),open=ref(false),position=ref({}),arrow=ref('50%')
const id=`monitor-help-${crypto.randomUUID()}`
let timer
const place=async()=>{
  await nextTick()
  if(!open.value || !panel.value)return
  const r=trigger.value.getBoundingClientRect(),p=panel.value.getBoundingClientRect()
  const left=Math.max(8,Math.min(r.left+r.width/2-p.width/2,innerWidth-p.width-8))
  const above=r.top>=p.height+10
  position.value={left:`${left}px`,top:`${above?r.top-p.height-6:r.bottom+6}px`}
  arrow.value=`${r.left+r.width/2-left}px`
  panel.value.dataset.side=above?'top':'bottom'
}
const show=()=>{clearTimeout(timer);open.value=true;place()}
const schedule=()=>{clearTimeout(timer);timer=setTimeout(show,300)}
const hide=()=>{clearTimeout(timer);timer=setTimeout(()=>{open.value=false},100)}
const outside=e=>{if(!root.value?.contains(e.target)&&!panel.value?.contains(e.target))open.value=false}
document.addEventListener('pointerdown',outside)
window.addEventListener('scroll',place,true)
window.addEventListener('resize',place)
onBeforeUnmount(()=>{clearTimeout(timer);document.removeEventListener('pointerdown',outside);window.removeEventListener('scroll',place,true);window.removeEventListener('resize',place)})
</script>
<style>
.monitor-help {display:inline-flex;align-items:center;}
.monitor-help button {display:flex;border:0;background:none;color:var(--text-secondary);padding:0;cursor:pointer;}
.monitor-help button:hover {color:var(--text-primary);}
.admin-ui.monitor-help-panel {position:fixed;z-index:10000;max-width:min(256px,calc(100vw - 16px));width:max-content;padding:6px 12px;border-radius:6px;background:var(--cf-text);color:var(--cf-panel);font-size:12px;line-height:16px;white-space:normal;animation:monitor-help-in 150ms;}
.monitor-help-panel i {position:absolute;bottom:-4px;width:8px;height:8px;background:inherit;transform:translateX(-50%) rotate(45deg);border-radius:2px;}
.monitor-help-panel[data-side=bottom] i {top:-4px;bottom:auto;}
@media(min-width:480px){.admin-ui.monitor-help-panel{max-width:448px;}}
@keyframes monitor-help-in {from{opacity:0;scale:.95;}to{opacity:1;scale:1;}}
@media(prefers-reduced-motion:reduce){.admin-ui.monitor-help-panel{animation:none;}}
</style>
