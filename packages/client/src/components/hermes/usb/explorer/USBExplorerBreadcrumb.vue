<script setup lang="ts">
import { computed } from 'vue'
import { NBreadcrumb, NBreadcrumbItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  currentPath: string
}>()

const emit = defineEmits<{
  navigate: [path: string]
}>()

const { t } = useI18n()

const segments = computed(() => {
  const parts = props.currentPath.split('/').filter(Boolean)
  return parts.map((segment, index) => ({
    label: segment,
    path: `/${parts.slice(0, index + 1).join('/')}`,
  }))
})
</script>

<template>
  <NBreadcrumb class="usb-explorer-breadcrumb">
    <NBreadcrumbItem @click="emit('navigate', '/')">
      <span class="root-chip">{{ t('usb.explorer.breadcrumb.root') }}</span>
    </NBreadcrumbItem>
    <NBreadcrumbItem
      v-for="segment in segments"
      :key="segment.path"
      @click="emit('navigate', segment.path)"
    >
      {{ segment.label }}
    </NBreadcrumbItem>
  </NBreadcrumb>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-explorer-breadcrumb {
  padding: 6px 4px 8px;
}

.root-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid $border-light;
  border-radius: 999px;
  color: $text-secondary;
  font-size: 11.5px;
}
</style>