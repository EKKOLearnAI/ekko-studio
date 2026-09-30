<script setup lang="ts">
import { NDrawer } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import StudioNavigationRail from './StudioNavigationRail.vue'

defineProps<{ show: boolean; hasSidebar: boolean }>()
const emit = defineEmits<{
  'update:show': [show: boolean]
  target: [element: HTMLElement | null]
}>()
const { t } = useI18n()
</script>

<template>
  <NDrawer
    :show="show"
    :width="hasSidebar ? 'min(360px, calc(100vw - 24px))' : 64"
    placement="left"
    display-directive="show"
    class="studio-mobile-drawer"
    @update:show="emit('update:show', $event)"
  >
    <div class="studio-mobile-navigation">
      <StudioNavigationRail />
      <section v-show="hasSidebar" class="studio-mobile-navigation__panel">
        <button class="studio-mobile-navigation__close" type="button" :aria-label="t('common.close')" @click="emit('update:show', false)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>
        </button>
        <div :ref="element => emit('target', element as HTMLElement | null)" class="studio-mobile-navigation__content" />
      </section>
    </div>
  </NDrawer>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.studio-mobile-navigation {
  display: flex;
  height: 100%;
  min-height: 0;
  background: $bg-sidebar-surface;

  :deep(.studio-navigation-rail) {
    padding-top: max(12px, env(safe-area-inset-top, 0px));
    padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));
  }
}
.studio-mobile-navigation__panel {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  border-inline-start: 1px solid $border-color;
}
.studio-mobile-navigation__close {
  display: grid;
  place-items: center;
  align-self: flex-end;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  margin: 8px 8px 0;
  border: 0;
  border-radius: $radius-sm;
  color: $text-secondary;
  background: transparent;
  cursor: pointer;

  &:hover { background: rgba(var(--accent-primary-rgb), 0.08); }
  &:focus-visible { outline: 2px solid $accent-primary; }
}
.studio-mobile-navigation .studio-mobile-navigation__content {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  // Page-owned sidebars become the second column inside the shared drawer.
  > :deep(*) {
    position: static;
    inset: auto;
    flex: 1;
    width: 100%;
    min-width: 0;
    height: 100%;
    max-height: none;
    margin: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    transform: none;
    transition: none;
    opacity: 1;
    pointer-events: auto;
  }

  :deep(.session-close-btn),
  :deep(.workflow-sidebar-close),
  :deep(.collapse-btn),
  :deep(.hermes-config-collapse),
  :deep(.ekko-config-collapse),
  :deep(.coding-agent-config-collapse) { display: none; }
}
</style>
