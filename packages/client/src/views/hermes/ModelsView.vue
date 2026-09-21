<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpin, NTabPane, NTabs, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AuxiliaryModelsPanel from '@/components/hermes/models/AuxiliaryModelsPanel.vue'
import CombinationModelsPanel from '@/components/hermes/models/CombinationModelsPanel.vue'
import ProvidersPanel from '@/components/hermes/models/ProvidersPanel.vue'
import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue'
import VoiceSettings from '@/components/hermes/settings/VoiceSettings.vue'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { checkCopilotToken } from '@/api/hermes/copilot-auth'

const { t } = useI18n()
const props = defineProps<{ sidebarCollapsed?: boolean }>()
const emit = defineEmits<{ toggleSidebar: [] }>()
const modelsStore = useModelsStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const message = useMessage()
const route = useRoute()
const router = useRouter()
const showModal = ref(false)
type ModelsTab = 'general' | 'auxiliary' | 'combination' | 'stt' | 'tts'

const MODELS_TABS = new Set<ModelsTab>(['general', 'auxiliary', 'combination', 'stt', 'tts'])
const activeTab = ref<ModelsTab>('general')

function normalizeTab(value: unknown): ModelsTab {
  const tab = typeof value === 'string' ? value : ''
  if (tab === 'fallback') return 'auxiliary'
  return MODELS_TABS.has(tab as ModelsTab) ? tab as ModelsTab : 'general'
}

function handleTabUpdate(tab: ModelsTab) {
  activeTab.value = normalizeTab(tab)
  void router.replace({
    query: {
      ...route.query,
      tab: activeTab.value === 'general' ? undefined : activeTab.value,
    },
  })
}

async function loadProvidersForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  // 先 invalidate 后端 copilot 缓存（gh logout / VS Code 退出后下一次 list 立刻反映），
  // 再拉 providers 与 appStore 的模型显示名配置。check-token 失败不阻断。
  try { await checkCopilotToken() } catch { /* ignore */ }
  await modelsStore.fetchProviders()
}

onMounted(async () => {
  await loadProvidersForProfile()
})

let catalogPoll: ReturnType<typeof setInterval> | undefined
let pollingCatalog = false
onMounted(() => {
  catalogPoll = setInterval(async () => {
    const freeProvider = modelsStore.providers.find(group => group.provider === 'opencode-free')
    if (pollingCatalog || !freeProvider || !['loading', 'error'].includes(freeProvider.catalog_status || '')) return
    pollingCatalog = true
    try {
      await modelsStore.fetchProviders({ background: true })
      if (modelsStore.providers.find(group => group.provider === 'opencode-free')?.catalog_status === 'ready') {
        await appStore.reloadModels({ preserveSelection: true })
      }
    } finally {
      pollingCatalog = false
    }
  }, 3000)
})
onUnmounted(() => { if (catalogPoll) clearInterval(catalogPoll) })

function openCreateModal() {
  showModal.value = true
}

watch(() => route.query.addProvider, (addProvider) => {
  if (addProvider !== '1') return
  activeTab.value = 'general'
  showModal.value = true
  const query = { ...route.query }
  delete query.addProvider
  delete query.tab
  void router.replace({ query })
}, { immediate: true })

watch(() => route.query.tab, (tab) => {
  if (route.query.addProvider === '1') return
  activeTab.value = normalizeTab(tab)
  if (tab === 'fallback') {
    void router.replace({
      query: { ...route.query, tab: 'auxiliary' },
    })
  }
}, { immediate: true })

function handleModalClose() {
  showModal.value = false
}

async function handleSaved(globalModelsAlreadyRefreshed = false) {
  if (!globalModelsAlreadyRefreshed) {
    await Promise.all([
      modelsStore.fetchProviders(),
      appStore.reloadModels({ preserveSelection: true }),
    ])
  }
  handleModalClose()
}

async function handleRefreshModelCache() {
  try {
    await modelsStore.refreshModelCache()
    message.success(t('models.refreshModelCacheSuccess'))
  } catch (e: any) {
    message.error(e?.message || t('models.refreshModelCacheFailed'))
  }
}
</script>

<template>
  <div class="models-view">
    <div v-if="modelsStore.refreshingModelCache" class="model-cache-overlay">
      <NSpin size="large" :description="t('models.refreshModelCacheLoading')" />
    </div>

    <header class="page-header">
      <div class="models-header-left">
        <NButton
          class="models-sidebar-toggle"
          quaternary
          size="small"
          circle
          :title="props.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          :aria-label="props.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          @click="emit('toggleSidebar')"
        >
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </template>
        </NButton>
        <h2 class="header-title">{{ t('models.title') }}</h2>
      </div>
      <div v-if="activeTab === 'general'" class="header-actions">
        <NButton
          size="small"
          :loading="modelsStore.refreshingModelCache"
          :disabled="modelsStore.loading"
          :aria-label="t('models.refreshModelCache')"
          :title="t('models.refreshModelCache')"
          @click="handleRefreshModelCache"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7"/><path d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7"/><path d="M21 3v6h-6"/><path d="M3 21v-6h6"/></svg>
          </template>
          <span class="header-action-label">{{ t('models.refreshModelCache') }}</span>
        </NButton>
        <NButton
          type="primary"
          size="small"
          :aria-label="t('models.addProvider')"
          :title="t('models.addProvider')"
          @click="openCreateModal"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          <span class="header-action-label">{{ t('models.addProvider') }}</span>
        </NButton>
      </div>
    </header>

    <div class="models-content">
      <NTabs v-model:value="activeTab" type="line" animated @update:value="handleTabUpdate">
        <NTabPane name="general" :tab="t('models.generalTitle')">
          <NSpin :show="modelsStore.loading && modelsStore.providers.length === 0">
            <ProvidersPanel />
          </NSpin>
        </NTabPane>
        <NTabPane name="auxiliary" :tab="t('models.auxiliaryTitle')">
          <AuxiliaryModelsPanel />
        </NTabPane>
        <NTabPane name="combination" :tab="t('models.combinationTitle')">
          <CombinationModelsPanel />
        </NTabPane>
        <NTabPane name="stt" :tab="t('settings.voice.sttProvidersTitle')">
          <VoiceSettings :key="`stt-${profilesStore.activeProfileName || 'default'}`" kind="stt" />
        </NTabPane>
        <NTabPane name="tts" :tab="t('settings.voice.ttsProvidersTitle')">
          <VoiceSettings :key="`tts-${profilesStore.activeProfileName || 'default'}`" kind="tts" />
        </NTabPane>
      </NTabs>
    </div>

    <ProviderFormModal
      v-if="showModal"
      @close="handleModalClose"
      @saved="handleSaved"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.models-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.models-header-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-cache-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, $bg-primary 78%, transparent);
  backdrop-filter: blur(2px);
}

.models-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .header-actions {
    flex-wrap: nowrap;
  }

  .header-action-label {
    display: none;
  }

  .header-actions :deep(.n-button) {
    width: 32px;
    height: 32px;
    padding: 0;
  }

  .header-actions :deep(.n-button__content),
  .header-actions :deep(.n-button__icon),
  .header-actions :deep(.n-icon-slot) {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .header-actions :deep(.n-button__icon) {
    margin: 0;
  }
}
</style>
