<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NTooltip } from 'naive-ui'
import { isStoredSuperAdmin } from '@/api/client'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import PageSidebarFooter from './PageSidebarFooter.vue'
import NavigationEntryIcon from './NavigationEntryIcon.vue'
import { useMobileNavigation } from '@/composables/usePageSidebar'
import { pluginPages, pluginNavigation, usePluginCatalog } from '@/composables/usePluginCatalog'
import { navigationCatalog, selectedNavigationEntries, type NavigationEntry } from '@/utils/navigation-entries'
import { useNavigationStore } from '@/stores/navigation'

const route = useRoute(), { t } = useI18n()
const { snapshot } = usePluginCatalog()
const navigation = useNavigationStore()
onMounted(() => { void navigation.load() })
const catalog = computed(() => navigationCatalog(snapshot.value.plugins, isStoredSuperAdmin()))
const entries = computed(() => selectedNavigationEntries(catalog.value, navigation.items))
const title = (entry: NavigationEntry) => entry.label ? t(entry.label) : entry.title || entry.id
const activeKey = computed(() => {
  const name = String(route.name || '')
  if (route.meta.hermesConfig || route.meta.ekkoConfig || route.meta.codingAgentConfig || route.name === 'studio.pluginAgentSettings') return 'agents'
  if (['hermes.chat', 'hermes.session', 'hermes.globalAgent', 'hermes.globalAgentSession'].includes(name)) return 'chat'
  if (name.startsWith('hermes.groupChat')) return 'group'
  if (name.startsWith('hermes.history')) return 'history'
  return catalog.value.find(entry => !entry.plugin && typeof entry.to === 'object' && 'name' in entry.to && entry.to.name === name)?.id || 'settings'
})
function active(entry: NavigationEntry) {
  if (!entry.plugin) return activeKey.value === entry.id
  if (route.params.pluginId !== entry.plugin.manifest.id) return false
  const current = pluginPages(entry.plugin).find(view => view.id === (route.params.viewId || pluginNavigation(entry.plugin!)[0]?.id))
  const selectedView = pluginPages(entry.plugin).find(view => view.id === entry.viewId)
  const workspaceEntries = pluginNavigation(entry.plugin).filter(view => view.slot === 'workspace')
  return current?.slot === 'workspace' && workspaceEntries.length === 1 ? selectedView?.slot === 'workspace' : current?.id === entry.viewId
}
const mobileNavigation = useMobileNavigation()
function handleNavigate(entry: NavigationEntry) {
  if (mobileNavigation && (entry.plugin || ['studioPlugins', 'connections', 'agents', 'models', 'usage', 'apiRelay'].includes(entry.id))) mobileNavigation.open.value = false
}
</script>

<template>
  <aside class="studio-navigation-rail">
    <PageSidebarFooter rail collapsed />
    <nav class="studio-navigation-rail__nav">
      <NTooltip v-for="entry in entries" :key="entry.id" placement="right" trigger="hover">
        <template #trigger>
          <RouteLinkItem class="studio-navigation-rail__item" :class="{ 'studio-navigation-rail__plugin': entry.plugin }" :data-navigation-id="entry.id" :to="entry.to" :active="active(entry)" :aria-label="title(entry)" @click="handleNavigate(entry)">
            <NavigationEntryIcon :entry="entry" />
          </RouteLinkItem>
        </template>
        {{ title(entry) }}
      </NTooltip>
    </nav>
    <div class="studio-navigation-rail__bottom">
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
  padding: calc(12px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  background: transparent;

  :deep(.page-sidebar-bottom) { width: 100%; padding: 0 0 calc(16px * var(--spacing-scale, 1)); }
  :deep(.page-sidebar-account-btn) { height: 44px; padding: calc(4px * var(--spacing-scale, 1)); }
}
.studio-navigation-rail__nav {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  overflow-y: auto;
  scrollbar-width: none;
}
.studio-navigation-rail__bottom { display: flex; flex-direction: column; gap: calc(8px * var(--spacing-scale, 1)); padding-top: 12px; }
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
