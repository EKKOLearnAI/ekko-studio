<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { InstalledPlugin } from '@/api/studio/plugins'
import { pluginPages, pluginPageLocation } from '@/plugins/navigation'
import { usePageSidebarState } from '@/composables/usePageSidebar'
import { useAppStore } from '@/stores/hermes/app'
import PageSidebar from './PageSidebar.vue'
import SidebarResizeHandle from './SidebarResizeHandle.vue'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import PluginIcon from '@/components/plugins/PluginIcon.vue'
import PluginFrame from '@/components/plugins/PluginFrame.vue'

const props = defineProps<{ plugin: InstalledPlugin; profile: string }>()
const views = computed(() => pluginPages(props.plugin).filter(view => view.slot === 'workspace'))
const route = useRoute(), { t } = useI18n(), appStore = useAppStore()
const { expanded, isMobile } = usePageSidebarState()
watch(expanded, value => appStore.setPageSidebarExpanded(value), { immediate: true })
function navigated() { if (isMobile.value) expanded.value = false }
window.addEventListener('studio.plugin.navigate', navigated)
onBeforeUnmount(() => window.removeEventListener('studio.plugin.navigate', navigated))
</script>

<template>
  <PageSidebar>
    <aside class="plugin-config-sidebar" :class="{ open: expanded, collapsed: !isMobile && appStore.sidebarCollapsed }" :aria-label="plugin.manifest.name">
      <SidebarResizeHandle />
      <nav class="plugin-config-nav">
        <RouteLinkItem v-for="view in views" :key="view.id" class="plugin-config-nav-item" :to="pluginPageLocation(plugin, view.id)" :active="route.params.viewId === view.id || !route.params.viewId && view.id === views[0]?.id" :title="view.title" @click="navigated">
          <PluginIcon :plugin="plugin" :icon="view.icon" :title="view.title" compact /><span class="plugin-view-title">{{ view.title }}</span>
        </RouteLinkItem>
        <PluginFrame v-if="plugin.manifest.workspace?.sidebar" v-show="isMobile || !appStore.sidebarCollapsed" :plugin="plugin" :profile="profile" :view="plugin.manifest.workspace.sidebar" slot="workspace-sidebar" sidebar />
      </nav>
      <footer class="plugin-config-footer">
        <RouteLinkItem class="plugin-config-nav-item plugin-config-return" :to="{ name: 'studio.plugins' }" :title="t('studioPlugins.backToCenter')" @click="navigated"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg><span>{{ t('studioPlugins.backToCenter') }}</span></RouteLinkItem>
        <button class="plugin-config-collapse" :title="t(appStore.sidebarCollapsed ? 'sidebar.expand' : 'sidebar.collapse')" @click="appStore.toggleSidebarCollapsed()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path :d="appStore.sidebarCollapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'" /></svg></button>
      </footer>
    </aside>
  </PageSidebar>
</template>

<style scoped lang="scss">
@use '@/styles/agent-config-sidebar' as sidebar;
@include sidebar.layout('plugin');
.plugin-config-sidebar.collapsed .plugin-config-nav-item :deep(.plugin-icon) { display: inline-grid; }
.plugin-view-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
</style>
