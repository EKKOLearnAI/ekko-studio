<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TerminalPanel from './TerminalPanel.vue'
import FilesPanel from './FilesPanel.vue'

interface Props {
  show: boolean
  activeTab?: 'terminal' | 'files'
}

interface Emits {
  (e: 'update:show', value: boolean): void
}

const props = withDefaults(defineProps<Props>(), {
  activeTab: 'files'
})

const emit = defineEmits<Emits>()
const { t } = useI18n()

const activeTab = ref<'terminal' | 'files'>(props.activeTab)

watch(() => props.activeTab, (newVal) => {
  if (newVal) activeTab.value = newVal
})

function handleClose() {
  emit('update:show', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="drawer-overlay" @click="handleClose"></div>
    <div :class="['drawer-panel', { show }]">
      <div class="drawer-header">
        <div class="drawer-tabs">
          <button
            :class="['tab-button', { active: activeTab === 'files' }]"
            @click="activeTab = 'files'"
          >
            {{ t('drawer.files') }}
          </button>
          <button
            :class="['tab-button', { active: activeTab === 'terminal' }]"
            @click="activeTab = 'terminal'"
          >
            {{ t('drawer.terminal') }}
          </button>
        </div>
        <button class="close-button" type="button" :aria-label="t('common.close')" @click="handleClose">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="drawer-content">
        <div v-show="activeTab === 'files'" class="drawer-pane">
          <FilesPanel />
        </div>
        <div v-show="activeTab === 'terminal'" class="drawer-pane">
          <TerminalPanel :visible="activeTab === 'terminal' && show" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

.drawer-panel {
  position: fixed;
  top: 0;
  right: calc(0px - var(--studio-drawer-width));
  width: var(--studio-drawer-width);
  height: calc(100 * var(--vh));
  max-height: calc(100 * var(--vh));
  background: $bg-card;
  border-radius: 5px 0 0 5px;
  overflow: hidden;
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  z-index: 1000;
  transition: right 0.3s ease;

  &.show {
    right: 0;
  }

  @media (max-width: $breakpoint-mobile) {
    width: 100%;
    right: -100%;

    &.show {
      right: 0;
    }
  }
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.drawer-tabs {
  display: flex;
  gap: 8px;
}

.tab-button {
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  flex-shrink: 0;
  white-space: nowrap;
  border-radius: $radius-sm;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.05);
  }

  &.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.close-button {
  padding: 8px;
  border: none;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  border-radius: $radius-sm;
  transition: all 0.2s;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover {
    color: $text-primary;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }
}

.drawer-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-height: 0;
}

.drawer-pane {
  height: 100%;
  overflow: auto;
}
</style>
