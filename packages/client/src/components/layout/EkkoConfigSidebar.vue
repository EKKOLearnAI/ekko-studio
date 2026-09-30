<script setup lang="ts">
import PageSidebar from "./PageSidebar.vue"
import { usePageSidebarState } from "@/composables/usePageSidebar"
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import { useAppStore } from '@/stores/hermes/app'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const { expanded, isMobile } = usePageSidebarState()
watch(expanded, value => appStore.setPageSidebarExpanded(value), { immediate: true })

const activeRoute = computed(() => route.name as string)

function setExpanded(value: boolean) {
  expanded.value = value
  appStore.setPageSidebarExpanded(value)
}

function handleNavClick(event: MouseEvent) {
  if (!isMobile.value) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.route-link-item')) setExpanded(false)
}

</script>

<template>
  <PageSidebar>
  <aside class="ekko-config-sidebar" :class="{ open: expanded, collapsed: !isMobile && appStore.sidebarCollapsed }">
    <nav class="ekko-config-nav" @click="handleNavClick">
      <RouteLinkItem class="ekko-config-nav-item" :to="{ name: 'ekko.memory' }" :active="activeRoute === 'ekko.memory'">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z" />
        </svg>
        <span>{{ t('sidebar.memory') }}</span>
      </RouteLinkItem>
      <RouteLinkItem class="ekko-config-nav-item" :to="{ name: 'ekko.skills' }" :active="activeRoute === 'ekko.skills'">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
        </svg>
        <span>{{ t('sidebar.skills') }}</span>
      </RouteLinkItem>
      <RouteLinkItem class="ekko-config-nav-item" :to="{ name: 'ekko.mcp' }" :active="activeRoute === 'ekko.mcp'">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="10" rx="2" />
          <path d="M8 19h8M12 15v4M8 10h.01M12 10h4" />
        </svg>
        <span>{{ t('sidebar.mcp') }}</span>
      </RouteLinkItem>
      <RouteLinkItem class="ekko-config-nav-item" :to="{ name: 'ekko.settings' }" :active="activeRoute === 'ekko.settings'">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>{{ t('sidebar.settings') }}</span>
      </RouteLinkItem>
    </nav>
    <footer class="ekko-config-footer" @click="handleNavClick">
      <RouteLinkItem class="ekko-config-nav-item ekko-config-return" :to="{ name: 'hermes.agentManager' }">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6" />
          <path d="M9 12h11" />
        </svg>
        <span>{{ t('ekkoConfig.back') }}</span>
      </RouteLinkItem>
      <button class="ekko-config-collapse" type="button" :title="appStore.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')" @click="appStore.toggleSidebarCollapsed()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline v-if="appStore.sidebarCollapsed" points="9 18 15 12 9 6" />
          <polyline v-else points="15 18 9 12 15 6" />
        </svg>
      </button>
    </footer>
  </aside>
  </PageSidebar>
</template>

<style scoped lang="scss">
@use "@/styles/agent-config-sidebar" as agent-config-sidebar;

@include agent-config-sidebar.layout("ekko");
</style>
