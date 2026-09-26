<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import PluginIcon from '@/components/common/PluginIcon.vue'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import { useAppStore } from '@/stores/hermes/app'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const isMobile = ref(typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches)
const expanded = ref(!isMobile.value)
let mobileQuery: MediaQueryList | null = null

const agentId = computed(() => String(route.params.agentId || ''))
const activeSection = computed(() => String(route.params.section || 'settings'))

const items = computed(() => agentId.value === 'cursor'
  ? [
    { section: 'mcp', label: t('sidebar.mcp'), icon: 'mcp' },
    { section: 'settings', label: t('sidebar.settings'), icon: 'settings' },
  ]
  : [
    ...(agentId.value === 'dsh' ? [{ section: 'plugins', label: t('sidebar.plugins'), icon: 'plugins' }, { section: 'presets', label: t('dshPresets.title'), icon: 'presets' }] : []),
    { section: 'skills', label: t('sidebar.skills'), icon: 'skills' },
    { section: 'mcp', label: t('sidebar.mcp'), icon: 'mcp' },
    { section: 'settings', label: t('sidebar.settings'), icon: 'settings' },
  ])

function setExpanded(value: boolean) {
  expanded.value = value
  appStore.setPageSidebarExpanded(value)
}

function handleMobileChange(event: MediaQueryList | MediaQueryListEvent) {
  isMobile.value = event.matches
  setExpanded(!event.matches)
}

function handleNavClick(event: MouseEvent) {
  if (!isMobile.value) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.route-link-item')) setExpanded(false)
}

function openSidebar() {
  setExpanded(true)
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  window.addEventListener('hermes:open-page-sidebar', openSidebar)
})

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', handleMobileChange)
  window.removeEventListener('hermes:open-page-sidebar', openSidebar)
})
</script>

<template>
  <div class="coding-agent-config-backdrop" :class="{ active: isMobile && expanded }" @click="setExpanded(false)" />
  <aside class="coding-agent-config-sidebar" :class="{ open: expanded, collapsed: appStore.sidebarCollapsed }">
    <nav class="coding-agent-config-nav" @click="handleNavClick">
      <RouteLinkItem
        v-for="item in items"
        :key="item.section"
        class="coding-agent-config-nav-item"
        :data-testid="`coding-agent-config-${item.section}`"
        :to="{ name: 'codingAgent.config', params: { agentId, section: item.section } }"
        :active="activeSection === item.section"
      >
        <PluginIcon v-if="item.icon === 'plugins'" />
        <svg v-else-if="item.icon === 'presets'" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="7" width="16" height="14" rx="3" /><path d="M12 3v4M9 17h6M8 12h.01M16 12h.01" />
        </svg>
        <svg v-else-if="item.icon === 'skills'" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
        </svg>
        <svg v-else-if="item.icon === 'mcp'" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="10" rx="2" />
          <path d="M8 19h8M12 15v4M8 10h.01M12 10h4" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06-.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>{{ item.label }}</span>
      </RouteLinkItem>
    </nav>
    <footer class="coding-agent-config-footer">
      <RouteLinkItem class="coding-agent-config-nav-item coding-agent-config-return" :to="{ name: 'hermes.agentManager' }">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6" />
          <path d="M9 12h11" />
        </svg>
        <span>{{ t('ekkoConfig.back') }}</span>
      </RouteLinkItem>
      <button class="coding-agent-config-collapse" type="button" :title="appStore.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')" @click="appStore.toggleSidebarCollapsed()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline v-if="appStore.sidebarCollapsed" points="9 18 15 12 9 6" />
          <polyline v-else points="15 18 9 12 15 6" />
        </svg>
      </button>
    </footer>
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/agent-config-sidebar" as agent-config-sidebar;

@include agent-config-sidebar.layout("coding-agent");
</style>
