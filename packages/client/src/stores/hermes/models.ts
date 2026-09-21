import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as systemApi from '@/api/hermes/system'
import type { AvailableModelGroup, CustomProvider, ProviderEditorPatch, ProviderEditorDetail } from '@/api/hermes/system'
import { hasApiKey } from '@/api/client'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'

export const useModelsStore = defineStore('models', () => {
  const providers = ref<AvailableModelGroup[]>([])
  const allProviders = ref<AvailableModelGroup[]>([])
  const defaultModel = ref('')
  const defaultProvider = ref('')
  const loading = ref(false)
  const refreshingModelCache = ref(false)

  const customProviders = computed(() =>
    providers.value.filter(g => g.provider.startsWith('custom:')),
  )

  const builtinProviders = computed(() =>
    providers.value.filter(g => !g.provider.startsWith('custom:')),
  )

  const allModels = computed(() =>
    providers.value.flatMap(g =>
      g.models.map(m => ({
        id: m,
        provider: g.provider,
        label: g.label,
        base_url: g.base_url,
        isDefault: m === defaultModel.value && g.provider === defaultProvider.value,
      })),
    ),
  )

  async function fetchProviders(options: { background?: boolean } = {}) {
    if (!hasApiKey()) return
    if (!options.background) loading.value = true
    try {
      const profile = useProfilesStore().activeProfileName || 'default'
      const res = await systemApi.fetchAvailableModelsForProfile(profile)
      if (profile !== (useProfilesStore().activeProfileName || 'default')) return
      // MoA is a virtual Hermes runtime provider used by chat model pickers,
      // not a credential-backed provider that belongs in model settings or
      // auxiliary-model configuration.
      providers.value = res.groups.filter(group => group.provider !== 'moa')
      allProviders.value = res.allProviders
      defaultModel.value = res.default
      defaultProvider.value = res.default_provider || ''
    } catch (err) {
      console.error('Failed to fetch providers:', err)
    } finally {
      if (!options.background) loading.value = false
    }
  }

  async function refreshModelCache() {
    if (!hasApiKey()) return
    refreshingModelCache.value = true
    try {
      await systemApi.refreshProviderModelCache()
      await fetchProviders()
      await useAppStore().reloadModels()
    } finally {
      refreshingModelCache.value = false
    }
  }

  async function setDefaultModel(modelId: string, provider: string) {
    await systemApi.updateDefaultModel({ default: modelId, provider })
    defaultModel.value = modelId
    defaultProvider.value = provider
    const appStore = useAppStore()
    await appStore.reloadModels()
  }

  async function setDefaultProvider(providerId: string) {
    const group = providers.value.find(entry => entry.provider === providerId)
    if (!group || group.models.length === 0) {
      throw new Error('Provider has no available models')
    }

    const nextModel = group.models.includes(defaultModel.value)
      ? defaultModel.value
      : group.models[0]

    await setDefaultModel(nextModel, providerId)
  }

  async function addProvider(data: CustomProvider) {
    await systemApi.addCustomProvider(data)
    await fetchProviders()
    await useAppStore().reloadModels({ preserveSelection: true })
  }

  async function removeProvider(name: string, options: { source?: 'custom_providers' | 'providers'; providerKey?: string } = {}) {
    await systemApi.removeCustomProvider(name, options)
    await fetchProviders()
    await useAppStore().reloadModels()
  }

  async function fetchProviderEditor(providerId: string): Promise<ProviderEditorDetail> {
    return systemApi.fetchProviderEditor(providerId)
  }

  async function saveProviderEditor(
    providerId: string,
    revision: string,
    patch: ProviderEditorPatch,
    contextLengths: Record<string, number | null> = {},
  ): Promise<ProviderEditorDetail> {
    const updated = await systemApi.patchProviderEditor(providerId, revision, patch)
    let detail = updated.provider
    if (Object.keys(contextLengths).length > 0) {
      const contextUpdate = await systemApi.patchProviderEditorContexts(providerId, detail.revision, contextLengths)
      detail = contextUpdate.provider
    }
    await fetchProviders()
    await useAppStore().reloadModels()
    return detail
  }

  async function refreshProviderModels(providerId: string, options: { confirm?: boolean } = {}) {
    const result = await systemApi.refreshProviderModels(providerId, options)
    if (result.applied) {
      await fetchProviders()
      await useAppStore().reloadModels()
    }
    return result
  }

  async function restoreProviderModels(providerId: string) {
    const result = await systemApi.restoreProviderModels(providerId)
    if (result.applied) {
      await fetchProviders()
      await useAppStore().reloadModels()
    }
    return result
  }

  return {
    providers,
    allProviders,
    defaultModel,
    defaultProvider,
    loading,
    refreshingModelCache,
    customProviders,
    builtinProviders,
    allModels,
    fetchProviders,
    refreshModelCache,
    setDefaultModel,
    setDefaultProvider,
    addProvider,
    removeProvider,
    fetchProviderEditor,
    saveProviderEditor,
    refreshProviderModels,
    restoreProviderModels,
  }
})
