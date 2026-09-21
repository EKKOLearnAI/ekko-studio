import { computed, hasInjectionContext, inject, reactive, type InjectionKey, type Ref } from 'vue'
import * as modelApi from '@/api/hermes/system'
import { createModelsState, useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { createSettingsProfileScope } from './useSettingsProfile'

export function createModelSettings(profile: string) {
  const scope = createSettingsProfileScope(profile)
  const api = modelApi.createApi(scope.request)
  const metadata = reactive({
    customModels: {} as Record<string, string[]>,
    modelAliases: {} as Record<string, Record<string, string>>,
    modelVisibility: {} as modelApi.ModelVisibility,
  })
  const models = reactive(createModelsState({
    api,
    profile: () => profile,
    onChanged: async () => { await models.fetchProviders() },
    onLoaded: response => {
      metadata.customModels = response.custom_models || {}
      metadata.modelAliases = response.model_aliases || {}
      metadata.modelVisibility = response.model_visibility || {}
    },
  }))
  function getModelAlias(model: string, provider?: string): string {
    if (provider) return metadata.modelAliases[provider]?.[model] || ''
    return Object.values(metadata.modelAliases).find(aliases => aliases[model])?.[model] || ''
  }
  const app = reactive({
    customModels: computed(() => metadata.customModels),
    modelGroups: computed(() => models.providers),
    selectedModel: computed(() => models.defaultModel),
    getModelAlias,
    displayModelName: (model: string, provider?: string) => getModelAlias(model, provider) || model,
    getProviderVisibility: (provider: string): modelApi.ModelVisibilityRule => metadata.modelVisibility[provider] || { mode: 'all', models: [] },
    reloadModels: async (_options?: { preserveSelection?: boolean }) => { await models.fetchProviders() },
    switchModel: (model: string, provider = '') => models.setDefaultModel(model, provider),
    async setModelAlias(model: string, provider: string, alias: string) {
      await api.updateModelAlias({ model, provider, alias: alias.trim() })
      await models.fetchProviders()
    },
    async setModelVisibility(provider: string, rule: modelApi.ModelVisibilityRule) {
      await api.updateModelVisibility({ provider, ...rule })
      await models.fetchProviders()
    },
    async removeCustomModel(model: string, provider: string) {
      await api.removeCustomModel({ model, provider })
      await models.fetchProviders()
    },
  })
  return { ...scope, models, app }
}

export type ModelSettings = ReturnType<typeof createModelSettings>
export const MODEL_SETTINGS: InjectionKey<Ref<ModelSettings | null>> = Symbol('model-settings')

function currentSettings() {
  return hasInjectionContext() ? inject(MODEL_SETTINGS, null)?.value : null
}

export function useModelSettingsModels() {
  return currentSettings()?.models ?? useModelsStore()
}

export function useModelSettingsApp() {
  return currentSettings()?.app ?? useAppStore()
}

export function useModelSettingsProfile() {
  const settings = currentSettings()
  return settings ? { activeProfileName: settings.profile } : useProfilesStore()
}
