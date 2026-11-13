<script setup lang="ts">
import { NButton, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'

defineProps<{
  expanded: boolean
  controls: string
  disabled?: boolean
  tooltip?: string
}>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()
</script>

<template>
  <NTooltip trigger="hover">
    <template #trigger>
      <NButton class="header-tool-toggle" :class="{ active: expanded }" quaternary circle size="small"
        :disabled="disabled" :aria-label="t('chat.sidePanel')" :aria-expanded="expanded" :aria-controls="controls"
        @click="emit('toggle')">
        <template #icon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </template>
      </NButton>
    </template>
    {{ tooltip || t('chat.sidePanel') }}
  </NTooltip>
</template>

<style scoped lang="scss">
.header-tool-toggle.active {
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.1);
}
</style>
