<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps<{ path: string; progressPath: string }>()
const track = ref<SVGPathElement>()
const probe = ref<SVGPathElement>()
const offset = ref(1)
let revision = 0
watch(() => [props.path, props.progressPath], async () => {
  const current = ++revision
  await nextTick()
  if (current !== revision || !track.value || !probe.value) return
  const total = track.value.getTotalLength()
  offset.value = total ? 1 - Math.min(1, probe.value.getTotalLength() / total) : 1
}, { immediate: true })
onBeforeUnmount(() => { revision++ })
</script>
<template>
  <g>
    <path ref="track" class="activity-track" :d="path" />
    <path ref="probe" :d="progressPath" visibility="hidden" />
    <path class="activity-progress" :d="path" pathLength="1" stroke-dasharray="1" :stroke-dashoffset="offset" />
  </g>
</template>
<style scoped lang="scss">
@use '@/styles/variables' as *;
path { fill:none; stroke-width:2; stroke-linecap:round; }
.activity-track { stroke:$border-color; stroke-dasharray:2 6; }
.activity-progress { stroke:$accent-primary; opacity:.55; transition:stroke-dashoffset 900ms cubic-bezier(.22,.61,.36,1); }
@media(prefers-reduced-motion:reduce) { .activity-progress { transition:none; } }
</style>
