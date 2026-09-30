<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NTabPane, NTabs } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentSettings from '@/components/hermes/settings/AgentSettings.vue'
import GatewayAutoStartSettings from '@/components/hermes/settings/GatewayAutoStartSettings.vue'
import MemorySettings from '@/components/hermes/settings/MemorySettings.vue'
import SessionSettings from '@/components/hermes/settings/SessionSettings.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

type HermesSettingsTab = 'agent' | 'memory' | 'session'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const activeTab = ref<HermesSettingsTab>('agent')

function normalizeTab(value: unknown): HermesSettingsTab {
  return value === 'memory' || value === 'session' ? value : 'agent'
}

function handleTabUpdate(tab: HermesSettingsTab) {
  activeTab.value = normalizeTab(tab)
  void router.replace({
    query: {
      ...route.query,
      tab: activeTab.value === 'agent' ? undefined : activeTab.value,
    },
  })
}

watch(() => route.query.tab, tab => {
  activeTab.value = normalizeTab(tab)
}, { immediate: true })

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  await settingsStore.fetchSettings()
}

const initializing = ref(true)

onMounted(() => {
  void loadSettingsForProfile().finally(() => { initializing.value = false })
})
</script>

<template>
  <PageLoading :show="initializing || settingsStore.loading" class="hermes-settings-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('settings.title') }}</h2>
    </header>
    </PageHeader>

    <div class="hermes-settings-content">
      <div>
        <NTabs v-model:value="activeTab" type="line" animated @update:value="handleTabUpdate">
          <NTabPane name="agent" :tab="t('settings.tabs.agent')">
            <AgentSettings />
            <GatewayAutoStartSettings />
          </NTabPane>
          <NTabPane name="memory" :tab="t('settings.tabs.memory')">
            <MemorySettings />
          </NTabPane>
          <NTabPane name="session" :tab="t('settings.tabs.session')">
            <SessionSettings />
          </NTabPane>
        </NTabs>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
.hermes-settings-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.hermes-settings-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: 20px;
  overflow-y: auto;
}
</style>
