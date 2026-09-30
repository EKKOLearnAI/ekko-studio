<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, ref, watch } from 'vue'
import { NTabPane, NTabs } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AppConnectionsPanel from '@/components/hermes/connections/AppConnectionsPanel.vue'
import McuDevicesPanel from '@/components/hermes/connections/McuDevicesPanel.vue'
import DevicesView from '@/views/hermes/DevicesView.vue'
import { isStoredSuperAdmin } from '@/api/client'

type ConnectionTab = 'app' | 'mcu' | 'devices'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const isSuperAdmin = computed(() => isStoredSuperAdmin())

function normalizeTab(value: unknown): ConnectionTab {
  if (value === 'mcu') return value
  if (value === 'devices' && isSuperAdmin.value) return value
  return 'app'
}

const activeTab = ref<ConnectionTab>(normalizeTab(route.query.tab))

watch(
  () => route.query.tab,
  value => {
    activeTab.value = normalizeTab(value)
  },
)

function updateTab(value: string | number) {
  const tab = normalizeTab(value)
  activeTab.value = tab
  void router.replace({
    query: {
      ...route.query,
      tab: tab === 'app' ? undefined : tab,
    },
  })
}
</script>

<template>
  <div class="connections-panel">
    <PageHeader>
    <header class="page-header">
      <div class="connections-header-left">
        <h2 class="header-title">{{ t('connections.title') }}</h2>
      </div>
    </header>
    </PageHeader>

    <NTabs
      :value="activeTab"
      class="connections-tabs"
      type="line"
      animated
      pane-class="connections-tab-pane"
      @update:value="updateTab"
    >
      <NTabPane name="app" :tab="t('connections.tabs.app')" display-directive="if">
        <AppConnectionsPanel />
      </NTabPane>
      <NTabPane name="mcu" :tab="t('connections.tabs.mcu')" display-directive="if">
        <McuDevicesPanel />
      </NTabPane>
      <NTabPane v-if="isSuperAdmin" name="devices" :tab="t('connections.tabs.devices')" display-directive="if">
        <DevicesView embedded />
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.connections-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: $bg-main-surface;
}

.connections-header-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.connections-tabs {
  flex: 1 1 auto;
  min-height: 0;

  :deep(.n-tabs-nav) {
    flex: 0 0 auto;
    padding: 0 20px;
    border-bottom: 1px solid var(--n-tab-border-color);
    background: $bg-main-surface;
  }

  :deep(.n-tabs-nav-scroll-content) {
    width: 100%;
    border-bottom: 0 !important;
  }

  :deep(.n-tabs-pane-wrapper),
  :deep(.n-tab-pane) {
    height: 100%;
    min-height: 0;
  }
}

@media (max-width: $breakpoint-mobile) {
  .connections-tabs :deep(.n-tabs-nav) {
    padding: 0 12px;
  }
}
</style>
