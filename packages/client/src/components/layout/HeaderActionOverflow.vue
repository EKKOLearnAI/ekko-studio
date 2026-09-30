<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NButton, NPopover } from 'naive-ui'

const props = defineProps<{
  label: string
  breakpoint: number
  active?: boolean
  placement?: 'bottom-start' | 'bottom-end'
}>()
const root = ref<HTMLElement | null>(null)
const compact = ref(false)
const open = ref(false)
let observer: ResizeObserver | undefined

onMounted(() => {
  const header = root.value?.closest('header')
  if (!header || typeof ResizeObserver === 'undefined') return
  const update = () => {
    compact.value = Boolean(header.closest('.studio-page-header')) && header.clientWidth < props.breakpoint
    if (!compact.value) open.value = false
  }
  observer = new ResizeObserver(update)
  observer.observe(header)
  update()
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="header-action-overflow">
    <NPopover v-if="compact" v-model:show="open" trigger="click" :placement="placement || 'bottom-end'">
      <template #trigger>
        <NButton size="small" :type="active ? 'primary' : 'default'" :title="label" :aria-label="label" :aria-expanded="open" class="header-overflow-trigger">
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
            </svg>
          </template>
        </NButton>
      </template>
      <div class="header-overflow-menu"><slot /></div>
    </NPopover>
    <slot v-else />
  </div>
</template>

<style scoped lang="scss">
.header-action-overflow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: inherit;
  flex-shrink: 0;
  min-width: 0;
  max-width: 100%;
}

.header-overflow-trigger {
  width: 30px;
  padding: 0;
  :deep(.n-button__icon) { margin: 0; }
}

.header-overflow-menu {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: min(320px, calc(100vw - 48px));
  -webkit-app-region: no-drag;
}
</style>
