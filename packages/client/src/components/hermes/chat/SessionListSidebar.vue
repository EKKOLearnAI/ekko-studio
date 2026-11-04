<script setup lang="ts">
import PageSidebar from '@/components/layout/PageSidebar.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'
import SidebarResizeHandle from '@/components/layout/SidebarResizeHandle.vue'

defineOptions({ inheritAttrs: false })
defineProps<{ expanded: boolean; navigation?: boolean }>()
</script>

<template>
  <PageSidebar>
    <aside v-bind="$attrs" class="session-list" :class="{ collapsed: !expanded, 'session-list--navigation': navigation }">
      <SidebarResizeHandle />
      <div v-if="expanded" class="page-sidebar-top"><slot name="header" /></div>
      <div v-if="expanded && !navigation" class="session-items"><slot /></div>
      <PageSidebarFooter v-if="expanded" />
    </aside>
  </PageSidebar>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.session-list {
  position: relative;
  width: $sidebar-width;
  min-height: 0;
  align-self: stretch;
  margin: 0;
  background: var(--theme-sidebar-bg, $bg-sidebar-surface);
  border-inline-end: var(--border-width, 1px) solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width $transition-normal, opacity $transition-normal;
  overflow: hidden;

  &--navigation .page-sidebar-top { flex: 1; overflow-y: auto; }

  &.collapsed {
    width: 0;
    margin-inline: 0;
    border: none;
    box-shadow: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    height: auto;
    margin: 0;
    z-index: 120;
    width: $sidebar-width;

    &.collapsed { transform: translateX(-100%); opacity: 0; }
  }
}

.page-sidebar-top {
  flex-shrink: 0;
  padding: calc(12px * var(--spacing-scale, 1));
}

.session-items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 calc(6px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
}

.page-sidebar-top :deep(.session-close-btn) {
  display: inline-flex;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: calc(4px * var(--spacing-scale, 1));
  border-radius: $radius-sm;
  height: 22px;
  min-height: 22px;
  align-items: center;
  justify-content: center;

  &:hover { background: rgba($accent-primary, 0.06); }
}
</style>
