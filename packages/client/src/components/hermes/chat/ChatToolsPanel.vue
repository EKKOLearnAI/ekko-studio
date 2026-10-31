<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BrowserAnnotationSubmission } from '@/utils/browser-annotation-submit'

const FilesPanel = defineAsyncComponent(() => import('./FilesPanel.vue'))
const TerminalPanel = defineAsyncComponent(() => import('./TerminalPanel.vue'))
const DesktopBrowserPanel = defineAsyncComponent(() => import('./DesktopBrowserPanel.vue'))
defineProps<{
  workspaceSessionId?: string | null
  workspace?: string | null
  visible: boolean
  browserVisible: boolean
  browserAvailable: boolean
  submit: (submission: BrowserAnnotationSubmission) => boolean | void | Promise<boolean | void>
}>()
const activePanel = defineModel<'files' | 'terminal' | 'browser'>('activePanel', { default: 'files' })
const emit = defineEmits<{ attach: [file: File] }>()
const { t } = useI18n()
</script>

<template>
  <div class="chat-tools-panel">
    <div class="chat-tool-tabs" role="tablist">
      <button
        class="chat-tool-tab"
        :class="{ active: activePanel === 'files' }"
        type="button"
        role="tab"
        :title="t('drawer.files')"
        :aria-label="t('drawer.files')"
        :aria-selected="activePanel === 'files'"
        @click="activePanel = 'files'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
        </svg>
      </button>
      <button
        class="chat-tool-tab"
        :class="{ active: activePanel === 'terminal' }"
        type="button"
        role="tab"
        :title="t('drawer.terminal')"
        :aria-label="t('drawer.terminal')"
        :aria-selected="activePanel === 'terminal'"
        @click="activePanel = 'terminal'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h4" />
        </svg>
      </button>
      <button
        v-if="browserAvailable"
        class="chat-tool-tab"
        :class="{ active: activePanel === 'browser' }"
        type="button"
        role="tab"
        :title="t('browser.title')"
        :aria-label="t('browser.title')"
        :aria-selected="activePanel === 'browser'"
        @click="activePanel = 'browser'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
          <circle cx="6.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
          <circle cx="9.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
    <div class="chat-tool-content">
      <FilesPanel
        v-show="activePanel === 'files'"
        :workspace-session-id="workspaceSessionId"
        :workspace="workspace"
        @attach="file => emit('attach', file)"
      />
      <TerminalPanel
        v-show="activePanel === 'terminal'"
        :visible="visible && activePanel === 'terminal'"
      />
      <DesktopBrowserPanel
        v-if="browserAvailable && activePanel === 'browser'"
        :visible="browserVisible"
        :submit="submit"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.chat-tools-panel {
  display: flex;
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-tool-tabs {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  order: 2;
  width: 48px;
  height: 100%;
  gap: calc(4px * var(--spacing-scale, 1));
  padding: calc(8px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  border-inline-start: var(--border-width, 1px) solid $border-color;
  background: var(--theme-sidebar-bg, $bg-sidebar-surface);
  box-sizing: border-box;
}

.chat-tool-tab {
  position: relative;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: all $transition-fast;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);

    &::after {
      content: "";
      position: absolute;
      right: -6px;
      top: 9px;
      bottom: 9px;
      width: 2px;
      border-radius: 2px 0 0 2px;
      background: var(--accent-primary);
    }
  }
}

.chat-tool-content {
  order: 1;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--theme-content-bg, $bg-main-surface);
}

.chat-tool-content > * {
  height: 100%;
  min-height: 0;
}

</style>
