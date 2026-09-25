<script setup lang="ts">
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import { useSessionSearch } from '@/composables/useSessionSearch'
import DesktopUpdateDownloadTab from './DesktopUpdateDownloadTab.vue'

type ActiveSection = 'chat' | 'history' | 'connections' | 'agents' | 'models' | 'group' | 'global' | 'workflow'

const props = defineProps<{
  active: ActiveSection
  primaryLabel?: string
}>()

const emit = defineEmits<{
  primary: []
}>()

const { t } = useI18n()
const router = useRouter()
const { openSessionSearch } = useSessionSearch()
const canManageAgents = computed(() => isStoredSuperAdmin())

const primaryText = computed(() => props.primaryLabel || t('chat.newChat'))

function openChat() {
  if (props.active === 'chat') return
  void router.push({ name: 'hermes.chat' })
}

function openHistory() {
  if (props.active === 'history') return
  void router.push({ name: 'hermes.history' })
}

function openConnections() {
  if (props.active === 'connections') return
  void router.push({ name: 'hermes.connections' })
}

function openAgentManager() {
  if (props.active === 'agents') return
  void router.push({ name: 'hermes.agentManager' })
}

function openModels() {
  if (props.active === 'models') return
  void router.push({ name: 'hermes.models' })
}

function openGroupChat() {
  if (props.active === 'group') return
  void router.push({ name: 'hermes.groupChat' })
}

function openWorkflow() {
  if (props.active === 'workflow') return
  void router.push({ name: 'hermes.workflow' })
}

function openApiRelay() {
  if (typeof window === 'undefined') return
  window.open('https://apikey.fan/register?aff=LIBAPI', '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <div class="page-sidebar-nav">
    <DesktopUpdateDownloadTab />
    <div class="page-sidebar-tabs" role="tablist" aria-label="Chat actions">
      <button
        class="page-sidebar-tab"
        type="button"
        @click="emit('primary')"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>{{ primaryText }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openSessionSearch">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>{{ t('sidebar.search') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'connections' }"
        type="button"
        :aria-current="active === 'connections' ? 'page' : undefined"
        @click="openConnections"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="18" cy="5" r="2.5" />
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="18" cy="19" r="2.5" />
          <path d="m8.2 10.7 7.6-4.4M8.2 13.3l7.6 4.4" />
        </svg>
        <span>{{ t('sidebar.connections') }}</span>
      </button>
      <button
        v-if="canManageAgents"
        class="page-sidebar-tab"
        :class="{ active: active === 'agents' }"
        type="button"
        :aria-current="active === 'agents' ? 'page' : undefined"
        @click="openAgentManager"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 8V4H8" />
          <rect x="4" y="8" width="16" height="12" rx="3" />
          <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
        </svg>
        <span>{{ t('sidebar.agentManager') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'models' }"
        type="button"
        :aria-current="active === 'models' ? 'page' : undefined"
        @click="openModels"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
        </svg>
        <span>{{ t('sidebar.models') }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openApiRelay">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        <span>{{ t('sidebar.apiRelay') }}</span>
      </button>
    </div>
    <div class="conversation-switch conversation-switch--four" role="tablist" aria-label="Conversation type">
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'chat' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.singleChat')"
            :aria-selected="active === 'chat'"
            @click="openChat"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.singleChat') }}
      </NTooltip>
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'group' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.groupChat')"
            :aria-selected="active === 'group'"
            @click="openGroupChat"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.groupChat') }}
      </NTooltip>
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'workflow' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.workflow')"
            :aria-selected="active === 'workflow'"
            @click="openWorkflow"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="5" cy="12" r="3" />
              <circle cx="19" cy="6" r="3" />
              <circle cx="19" cy="18" r="3" />
              <path d="M8 12h3a4 4 0 0 0 4-4V6" />
              <path d="M8 12h3a4 4 0 0 1 4 4v2" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.workflow') }}
      </NTooltip>
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'history' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.history')"
            :aria-selected="active === 'history'"
            @click="openHistory"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.history') }}
      </NTooltip>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-sidebar-tab {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }

  &:hover,
  &.active {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.conversation-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.conversation-switch--four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.conversation-switch-tab {
  width: 100%;
  min-width: 0;
  height: 30px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex: 0 0 auto;
  }

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
}

:global(.dark .conversation-switch--four .conversation-switch-tab.active) {
  background: $bg-card-hover;
  color: $accent-primary;
  box-shadow:
    inset 0 0 0 1px $border-color,
    0 2px 5px rgba(0, 0, 0, 0.22);
}
</style>
