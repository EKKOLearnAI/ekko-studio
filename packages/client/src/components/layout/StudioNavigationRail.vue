<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NTooltip } from 'naive-ui'
import { isStoredSuperAdmin } from '@/api/client'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import PageSidebarFooter from './PageSidebarFooter.vue'
import { useMobileNavigation } from '@/composables/usePageSidebar'

const route = useRoute()
const { t } = useI18n()
const canManageAgents = computed(() => isStoredSuperAdmin())
const entries = computed(() => [
  { key: 'chat', route: 'hermes.chat', label: 'sidebar.singleChat', path: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { key: 'group', route: 'hermes.groupChat', label: 'sidebar.groupChat', path: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { key: 'workflow', route: 'hermes.workflow', label: 'sidebar.workflow', path: 'M8 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M8 12h3a4 4 0 0 0 4-4V6M8 12h3a4 4 0 0 1 4 4v2' },
  { key: 'history', route: 'hermes.history', label: 'sidebar.history', path: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2' },
  { key: 'connections', route: 'hermes.connections', label: 'sidebar.connections', path: 'M20.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M8.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M20.5 19a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M8.2 10.7l7.6-4.4M8.2 13.3l7.6 4.4' },
  ...(canManageAgents.value ? [{ key: 'agents', route: 'hermes.agentManager', label: 'sidebar.agentManager', path: 'M12 8V4H8M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3M2 14h2M20 14h2M9 13v2M15 13v2' }] : []),
  { key: 'models', route: 'hermes.models', label: 'sidebar.models', path: 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' },
])
const activeKey = computed(() => {
  const name = String(route.name || '')
  if (route.meta.hermesConfig || route.meta.ekkoConfig || route.meta.codingAgentConfig) return 'agents'
  if (['hermes.chat', 'hermes.session', 'hermes.globalAgent', 'hermes.globalAgentSession'].includes(name)) return 'chat'
  if (name.startsWith('hermes.groupChat')) return 'group'
  if (name.startsWith('hermes.history')) return 'history'
  return entries.value.find(entry => entry.route === name)?.key || 'settings'
})
const mobileNavigation = useMobileNavigation()
function handleNavigate(key: string) {
  if (mobileNavigation && ['connections', 'agents', 'models'].includes(key)) {
    mobileNavigation.open.value = false
  }
}
</script>

<template>
  <aside class="studio-navigation-rail">
    <PageSidebarFooter rail collapsed />
    <nav class="studio-navigation-rail__nav">
      <NTooltip v-for="entry in entries" :key="entry.key" placement="right" trigger="hover">
        <template #trigger>
          <RouteLinkItem class="studio-navigation-rail__item" :to="{ name: entry.route }" :active="activeKey === entry.key" :aria-label="t(entry.label)" @click="handleNavigate(entry.key)">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="entry.path" /></svg>
          </RouteLinkItem>
        </template>
        {{ t(entry.label) }}
      </NTooltip>
    </nav>
    <div class="studio-navigation-rail__bottom">
      <NTooltip placement="right" trigger="hover">
        <template #trigger>
          <a class="studio-navigation-rail__item" href="https://apikey.fan/register?aff=LIBAPI" target="_blank" rel="noopener noreferrer" :aria-label="t('sidebar.apiRelay')">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" /></svg>
          </a>
        </template>
        {{ t('sidebar.apiRelay') }}
      </NTooltip>
      <NTooltip placement="right" trigger="hover">
        <template #trigger>
          <RouteLinkItem class="studio-navigation-rail__item" :to="{ name: 'hermes.settings' }" :active="activeKey === 'settings'" :aria-label="t('sidebar.settings')">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </RouteLinkItem>
        </template>
        {{ t('sidebar.settings') }}
      </NTooltip>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.studio-navigation-rail {
  position: relative;
  z-index: 2;
  display: flex;
  flex: 0 0 $navigation-rail-width;
  flex-direction: column;
  align-items: center;
  width: $navigation-rail-width;
  min-height: 0;
  padding: 12px 8px;
  background: $bg-sidebar;

  :deep(.page-sidebar-bottom) { width: 100%; padding: 0 0 16px; }
  :deep(.page-sidebar-account-btn) { height: 44px; padding: 4px; }
}
.studio-navigation-rail__nav {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  overflow-y: auto;
  scrollbar-width: none;
}
.studio-navigation-rail__bottom { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.studio-navigation-rail__item {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  color: $text-muted;
  border-radius: $radius-sm;
  text-decoration: none;
  transition: background-color $transition-fast, color $transition-fast;
  -webkit-app-region: no-drag;

  &:hover { color: $text-primary; background: rgba(var(--accent-primary-rgb), 0.06); }
  &.active { color: $accent-primary; background: rgba(var(--accent-primary-rgb), 0.12); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}
</style>
