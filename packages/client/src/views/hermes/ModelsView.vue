<script setup lang="ts">
import { computed, provide, ref, shallowRef, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSelect, NSpin, NTabPane, NTabs, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AuxiliaryModelsPanel from '@/components/hermes/models/AuxiliaryModelsPanel.vue'
import CombinationModelsPanel from '@/components/hermes/models/CombinationModelsPanel.vue'
import ProvidersPanel from '@/components/hermes/models/ProvidersPanel.vue'
import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue'
import VoiceSettings from '@/components/hermes/settings/VoiceSettings.vue'
import { createModelSettings, MODEL_SETTINGS } from '@/composables/useModelSettings'
import { SETTINGS_PROFILE_SCOPE } from '@/composables/useSettingsProfile'
import { fetchProfiles, type HermesProfile } from '@/api/hermes/profiles'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { createApi as createCopilotApi } from '@/api/hermes/copilot-auth'

const { t } = useI18n()
const props = defineProps<{ sidebarCollapsed?: boolean }>()
const emit = defineEmits<{ toggleSidebar: [] }>()
const profilesStore = useProfilesStore()
const message = useMessage()
const route = useRoute()
const router = useRouter()
const selectedProfile = ref(typeof route.query.profile === 'string' ? route.query.profile : profilesStore.activeProfileName || '')
const profiles = ref<HermesProfile[]>([])
const settings = shallowRef(createModelSettings(selectedProfile.value || 'default'))
provide(MODEL_SETTINGS, settings)
provide(SETTINGS_PROFILE_SCOPE, settings)
const modelsStore = computed(() => settings.value.models)
const showModal = ref(false)
const profileLoading = ref(true)
const profileOptions = computed(() => profiles.value.map(profile => ({
  label: profile.name,
  value: profile.name,
})))
const profileBusy = computed(() => profileLoading.value)
let profileLoadId = 0
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
  const loadId = ++profileLoadId
  const current = settings.value
  profileLoading.value = true
  try {
    if (!selectedProfile.value) return
    try { await createCopilotApi(current.request).checkCopilotToken() } catch { /* ignore */ }
    if (loadId !== profileLoadId) return
    await current.models.fetchProviders()
  } finally {
    if (loadId === profileLoadId) profileLoading.value = false
  }
}

watch(selectedProfile, () => {
  showModal.value = false
  if (!selectedProfile.value) return
  settings.value = createModelSettings(selectedProfile.value)
  void loadProvidersForProfile()
})

function handleProfileUpdate(name: string) {
  if (profileBusy.value || name === selectedProfile.value) return
  if (profileOptions.value.some(option => option.value === name)) selectedProfile.value = name
}

onMounted(async () => {
  try {
    // Load accessible choices without changing the global Profile store.
    profiles.value = await fetchProfiles()
    const selected = profiles.value.find(profile => profile.name === selectedProfile.value)?.name || profiles.value[0]?.name || ''
    if (selected !== selectedProfile.value) {
      selectedProfile.value = selected
      if (selected) return // The watcher loads the new scope.
    }
    await loadProvidersForProfile()
  } catch (err: any) {
    profileLoading.value = false
    message.error(err?.message || t('models.profileSwitchFailed'))
  }
})

let catalogPoll: ReturnType<typeof setInterval> | undefined
let pollingCatalog = false
onMounted(() => {
  catalogPoll = setInterval(async () => {
    const freeProvider = modelsStore.value.providers.find(group => group.provider === 'opencode-free')
    if (profileBusy.value || pollingCatalog || !freeProvider || !['loading', 'error'].includes(freeProvider.catalog_status || '')) return
    pollingCatalog = true
    try {
      await modelsStore.value.fetchProviders({ background: true })
    } finally {
      pollingCatalog = false
    }
  }, 3000)
})
onUnmounted(() => {
  profileLoadId++
  if (catalogPoll) clearInterval(catalogPoll)
})

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
    await modelsStore.value.fetchProviders()
  }
  handleModalClose()
}

async function handleRefreshModelCache() {
  try {
    await modelsStore.value.refreshModelCache()
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
      <div class="header-actions">
        <div class="models-profile-picker">
          <span class="models-profile-label">{{ t('models.profileLabel') }}</span>
          <NSelect
            data-testid="models-profile-select"
            class="models-profile-select"
            size="small"
            :value="selectedProfile"
            :options="profileOptions"
            :loading="profileBusy"
            :disabled="profileBusy || modelsStore.refreshingModelCache"
            :aria-label="t('models.profileLabel')"
            :placeholder="t('models.profileLabel')"
            filterable
            @update:value="handleProfileUpdate"
          />
        </div>
        <NButton
          v-if="activeTab === 'general'"
          size="small"
          :loading="modelsStore.refreshingModelCache"
          :disabled="modelsStore.loading || profileBusy || !selectedProfile"
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
          v-if="activeTab === 'general'"
          type="primary"
          size="small"
          :aria-label="t('models.addProvider')"
          :title="t('models.addProvider')"
          :disabled="profileBusy || !selectedProfile"
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
      <NSpin v-if="profileBusy" class="models-profile-loading" />
      <NTabs v-else-if="selectedProfile" :key="selectedProfile" v-model:value="activeTab" type="line" animated @update:value="handleTabUpdate">
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
          <VoiceSettings :key="`stt-${selectedProfile || 'default'}`" kind="stt" />
        </NTabPane>
        <NTabPane name="tts" :tab="t('settings.voice.ttsProvidersTitle')">
          <VoiceSettings :key="`tts-${selectedProfile || 'default'}`" kind="tts" />
        </NTabPane>
      </NTabs>
    </div>

    <ProviderFormModal
      v-if="showModal && !profileBusy && selectedProfile"
      :key="selectedProfile"
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

.models-profile-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.models-profile-label {
  font-size: 12px;
  color: $text-secondary;
  white-space: nowrap;
}

.models-profile-select {
  width: 180px;
}

.models-profile-loading {
  display: flex;
  justify-content: center;
  padding: 32px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .page-header {
    flex-wrap: wrap;
    gap: 12px;
  }

  .header-actions {
    flex: 1;
  }

  .models-profile-select {
    width: 130px;
  }

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
