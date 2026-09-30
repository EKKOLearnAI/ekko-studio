<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, readonly, ref, shallowRef, watch, type Ref } from 'vue'
import { pageLoadingKey, pageLoadingTaskKey } from '@/composables/usePageLoading'
import StudioLoading from './StudioLoading.vue'

const props = defineProps<{ show: boolean; initialOnly?: boolean }>()
const parentTask = inject(pageLoadingTaskKey, undefined)
const parentVisible = inject(pageLoadingKey, undefined)
const visible = ref(props.show)
const initialLoadComplete = ref(false)
const tasks = shallowRef(new Map<symbol, Readonly<Ref<boolean>>>())
const pending = computed(() => (!props.initialOnly || !initialLoadComplete.value)
  && (props.show || [...tasks.value.values()].some(task => task.value)))
// Embedded pages contribute to the enclosing surface instead of drawing a second logo.
const releaseParentTask = parentTask?.(pending)
provide(pageLoadingKey, parentVisible ?? readonly(visible))
provide(pageLoadingTaskKey, task => {
  const key = Symbol()
  tasks.value = new Map(tasks.value).set(key, task)
  return () => {
    const remaining = new Map(tasks.value)
    remaining.delete(key)
    tasks.value = remaining
  }
})
let sequence = 0
let frame: number | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let shownAt = performance.now()

onMounted(() => { if (visible.value) shownAt = performance.now() })
watch(visible, show => { if (show) shownAt = performance.now() }, { flush: 'post' })

function cancelHide() {
  if (frame !== undefined) cancelAnimationFrame(frame)
  if (timer !== undefined) clearTimeout(timer)
  frame = undefined
  timer = undefined
}

watch(pending, async show => {
  if (parentTask) return
  const current = ++sequence
  cancelHide()
  if (show) {
    if (!visible.value) shownAt = performance.now()
    visible.value = true
    return
  }
  // Keep the surface mounted and measurable while its final data renders.
  await nextTick()
  if (current !== sequence) return
  const hideAfterPaint = () => {
    if (current !== sequence) return
    frame = requestAnimationFrame(() => {
      if (current === sequence && !pending.value) {
        visible.value = false
        // Later session requests keep the surface visible after its first reveal.
        if (props.initialOnly) initialLoadComplete.value = true
      }
      frame = undefined
    })
  }
  const remaining = 1000 - (performance.now() - shownAt)
  if (remaining > 0) timer = setTimeout(hideAfterPaint, remaining)
  else hideAfterPaint()
}, { flush: 'sync' })

onBeforeUnmount(() => {
  sequence++
  cancelHide()
  releaseParentTask?.()
})
</script>

<template>
  <div class="page-loading" :aria-busy="parentVisible ?? visible">
    <div class="page-loading-content" :class="{ 'page-loading-content--hidden': !parentTask && visible }" :inert="(!parentTask && visible) || undefined" :aria-hidden="(!parentTask && visible) || undefined">
      <slot />
    </div>
    <div v-if="!parentTask && visible" class="page-loading-overlay">
      <StudioLoading size="large" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

:where(.page-loading) {
  display: flex;
  height: 100%;
}

.page-loading {
  position: relative;
  min-width: 0;
  min-height: 0;
}

.page-loading-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: inherit;

  &--hidden {
    opacity: 0;
    pointer-events: none;
  }
}

.page-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: $bg-main-surface;
}
</style>
