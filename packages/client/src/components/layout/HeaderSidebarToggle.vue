<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { usePageHeaderTarget } from '@/composables/usePageHeader'

defineOptions({ inheritAttrs: false })
defineProps<{ expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()
const target = usePageHeaderTarget()
</script>

<template>
  <div
    class="header-sidebar-control"
    :class="{ 'header-sidebar-control--outer': target, 'header-sidebar-control--collapsed': !expanded }"
  >
    <NButton
      v-bind="$attrs"
      style="padding-inline: 0"
      quaternary
      size="small"
      circle
      :title="expanded ? t('sidebar.collapse') : t('sidebar.expand')"
      :aria-label="expanded ? t('sidebar.collapse') : t('sidebar.expand')"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <template #icon>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
          <path class="header-sidebar-chevron" d="m17 9-3 3 3 3" />
        </svg>
      </template>
    </NButton>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.header-sidebar-control {
  display: contents;

  &--outer {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    flex: 0 0 $sidebar-width;
    height: var(--studio-header-height, 40px);
    padding-inline-start: 8px;
    margin-inline-end: 8px;
    border-inline-end: 1px solid $border-color;
    transition: flex-basis $transition-normal, border-color $transition-fast;

    &.header-sidebar-control--collapsed {
      flex-basis: 44px;
      border-inline-end-color: transparent;
    }
  }

  &--collapsed .header-sidebar-chevron {
    transform: rotate(180deg);
  }

  @media (max-width: $breakpoint-mobile) {
    display: none;
  }
}

.header-sidebar-chevron {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform $transition-normal;
}

@media (prefers-reduced-motion: reduce) {
  .header-sidebar-control--outer,
  .header-sidebar-chevron {
    transition: none;
  }
}
</style>
