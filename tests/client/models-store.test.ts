// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  fetchAvailableModels: vi.fn(),
  fetchAvailableModelsForProfile: vi.fn(),
  updateDefaultModel: vi.fn(),
  addCustomProvider: vi.fn(),
  removeCustomProvider: vi.fn(),
  fetchProviderEditor: vi.fn(),
  patchProviderEditor: vi.fn(),
  patchProviderEditorContexts: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => mockSystemApi)
vi.mock('@/api/client', () => ({ hasApiKey: () => true, getModelsPageProfile: () => null }))

import { useAppStore } from '@/stores/hermes/app'
import { useModelsStore } from '@/stores/hermes/models'

describe('Models Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('keeps the virtual MoA provider out of credential-backed model settings', async () => {
    const groups = [
      { provider: 'deepseek', label: 'DeepSeek', base_url: '', api_key: '', models: ['deepseek-chat'] },
      { provider: 'moa', label: 'Mixture of Agents', base_url: 'moa://local', api_key: 'moa-virtual-provider', models: ['research'] },
    ]
    mockSystemApi.fetchAvailableModelsForProfile.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups,
      allProviders: groups,
    })

    const modelsStore = useModelsStore()
    await modelsStore.fetchProviders()

    expect(modelsStore.providers.map(group => group.provider)).toEqual(['deepseek'])
  })

  it('keeps the sidebar model picker in sync after provider model visibility changes', async () => {
    const visibleGroups = [
      {
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        available_models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        model_meta: {
          'deepseek-v4-pro': { preview: true },
        },
      },
    ]
    const availableModelsResponse = {
      default: 'deepseek-v4-flash',
      default_provider: 'deepseek',
      groups: visibleGroups,
      allProviders: visibleGroups,
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
      },
      profiles: [
        {
          profile: 'default',
          default: 'deepseek-v4-flash',
          default_provider: 'deepseek',
          groups: visibleGroups,
        },
      ],
    }
    mockSystemApi.fetchAvailableModelsForProfile.mockResolvedValue(availableModelsResponse)
    mockSystemApi.fetchAvailableModels.mockResolvedValue(availableModelsResponse)
    mockSystemApi.addCustomProvider.mockResolvedValue(undefined)

    const appStore = useAppStore()
    appStore.modelGroups = [
      {
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test',
        models: ['deepseek-v4-flash'],
        available_models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      },
    ]

    const modelsStore = useModelsStore()
    await modelsStore.addProvider({
      name: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-test',
      model: 'deepseek-v4-flash',
    })

    expect(mockSystemApi.fetchAvailableModelsForProfile).toHaveBeenCalledWith('default')
    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalled()
    expect(modelsStore.providers[0].models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(appStore.modelGroups[0].models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(appStore.modelGroups[0].available_models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(appStore.modelGroups[0].model_meta).toEqual({
      'deepseek-v4-pro': { preview: true },
    })
    expect(appStore.modelVisibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
    })
    expect(appStore.selectedModel).toBe('deepseek-v4-flash')
    expect(appStore.selectedProvider).toBe('deepseek')
  })

  it('sets the default provider to the first visible model when the current default is not available there', async () => {
    const deepseekGroup = {
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-test',
      models: ['deepseek-chat'],
    }
    const openaiGroup = {
      provider: 'openai',
      label: 'OpenAI',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-openai',
      models: ['gpt-4.1', 'gpt-4.1-mini'],
    }
    const availableModelsResponse = {
      default: 'gpt-4.1',
      default_provider: 'openai',
      groups: [deepseekGroup, openaiGroup],
      allProviders: [deepseekGroup, openaiGroup],
    }

    mockSystemApi.fetchAvailableModels.mockResolvedValue(availableModelsResponse)
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)

    const modelsStore = useModelsStore()
    modelsStore.providers = [deepseekGroup, openaiGroup]
    modelsStore.defaultModel = 'deepseek-chat'
    modelsStore.defaultProvider = 'deepseek'

    await modelsStore.setDefaultProvider('openai')

    expect(mockSystemApi.updateDefaultModel).toHaveBeenCalledWith({
      default: 'gpt-4.1',
      provider: 'openai',
    })
    expect(modelsStore.defaultModel).toBe('gpt-4.1')
    expect(modelsStore.defaultProvider).toBe('openai')
  })

  it('keeps the current default model when another provider exposes the same model id', async () => {
    const providerA = {
      provider: 'provider-a',
      label: 'Provider A',
      base_url: 'https://provider-a.example/v1',
      api_key: 'sk-a',
      models: ['shared-model'],
    }
    const providerB = {
      provider: 'provider-b',
      label: 'Provider B',
      base_url: 'https://provider-b.example/v1',
      api_key: 'sk-b',
      models: ['shared-model', 'provider-b-only'],
    }
    const availableModelsResponse = {
      default: 'shared-model',
      default_provider: 'provider-b',
      groups: [providerA, providerB],
      allProviders: [providerA, providerB],
    }

    mockSystemApi.fetchAvailableModels.mockResolvedValue(availableModelsResponse)
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)

    const modelsStore = useModelsStore()
    modelsStore.providers = [providerA, providerB]
    modelsStore.defaultModel = 'shared-model'
    modelsStore.defaultProvider = 'provider-a'

    await modelsStore.setDefaultProvider('provider-b')

    expect(mockSystemApi.updateDefaultModel).toHaveBeenCalledWith({
      default: 'shared-model',
      provider: 'provider-b',
    })
    expect(modelsStore.defaultModel).toBe('shared-model')
    expect(modelsStore.defaultProvider).toBe('provider-b')
  })

  it('chains revision-checked provider and context updates before reloading model stores', async () => {
    const group = {
      provider: 'custom:example',
      label: 'Example',
      base_url: 'https://example.invalid/v1',
      api_key: '',
      models: ['model-a'],
    }
    const response = {
      default: 'model-a',
      default_provider: 'custom:example',
      groups: [group],
      allProviders: [group],
    }
    const baseDetail = {
      id: 'custom:example',
      label: 'Example',
      builtin: false,
      source: 'custom_providers',
      base_url: 'https://example.invalid/v1',
      preferred_model: 'model-a',
      credential_configured: true,
      editable: true,
      editable_fields: ['label', 'context_lengths'],
      context_lengths: {},
      connection_test_supported: true,
      revision: 'revision-2',
    }
    mockSystemApi.patchProviderEditor.mockResolvedValue({ success: true, provider: baseDetail })
    mockSystemApi.patchProviderEditorContexts.mockResolvedValue({
      success: true,
      provider: { ...baseDetail, context_lengths: { 'model-a': 128000 }, revision: 'revision-3' },
    })
    mockSystemApi.fetchAvailableModelsForProfile.mockResolvedValue(response)
    mockSystemApi.fetchAvailableModels.mockResolvedValue(response)

    const modelsStore = useModelsStore()
    const saved = await modelsStore.saveProviderEditor(
      'custom:example',
      'revision-1',
      { label: 'Example' },
      { 'model-a': 128000 },
    )

    expect(mockSystemApi.patchProviderEditor).toHaveBeenCalledWith(
      'custom:example',
      'revision-1',
      { label: 'Example' },
    )
    expect(mockSystemApi.patchProviderEditorContexts).toHaveBeenCalledWith(
      'custom:example',
      'revision-2',
      { 'model-a': 128000 },
    )
    expect(saved.revision).toBe('revision-3')
    expect(mockSystemApi.fetchAvailableModelsForProfile).toHaveBeenCalledWith('default')
    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalled()
  })
})
