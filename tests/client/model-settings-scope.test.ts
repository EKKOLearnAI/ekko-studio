// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, provide, shallowRef } from 'vue'
import { mount } from '@vue/test-utils'

const requestMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request: requestMock, hasApiKey: () => true }))

import { createModelSettings } from '@/composables/useModelSettings'
import { createSettingsProfileScope, SETTINGS_PROFILE_SCOPE, useSettingsApi } from '@/composables/useSettingsProfile'
import * as configApi from '@/api/hermes/config'
import * as copilotApi from '@/api/hermes/copilot-auth'
import * as ttsApi from '@/api/studio/tts-settings'
import * as sttApi from '@/api/studio/stt-settings'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'

describe('page-local model settings', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('hermes_active_profile_name', 'default')
    setActivePinia(createPinia())
    requestMock.mockReset()
    requestMock.mockImplementation(async (path: string) => {
      if (path.includes('available-models')) {
        const group = { provider: 'research-provider', label: 'Research', models: ['research-model'], base_url: '', api_key: '' }
        return { groups: [group], allProviders: [group], default: 'research-model', default_provider: 'research-provider', model_aliases: { 'research-provider': { 'research-model': 'Research model alias' } } }
      }
      return { success: true }
    })
  })

  it('loads and edits an isolated catalog without updating global Profile or chat model state', async () => {
    const globalApp = useAppStore()
    const globalProfiles = useProfilesStore()
    globalApp.selectedModel = 'chat-model'
    globalApp.selectedProvider = 'chat-provider'
    const reload = vi.spyOn(globalApp, 'reloadModels')
    const settings = createModelSettings('research')
    await settings.models.fetchProviders()
    expect(settings.app.displayModelName('research-model', 'research-provider')).toBe('Research model alias')
    await settings.models.setDefaultModel('another-model', 'research-provider')
    await settings.models.addProvider({ name: 'new', base_url: 'https://example.invalid', api_key: 'test-key', model: 'test-model' })
    await settings.models.removeProvider('old')
    await settings.app.setModelAlias('research-model', 'research-provider', 'New alias')
    await settings.app.setModelVisibility('research-provider', { mode: 'include', models: ['research-model'] })
    for (const [, options] of requestMock.mock.calls) {
      expect(new Headers(options.headers).get('X-Hermes-Profile')).toBe('research')
    }
    expect(globalProfiles.activeProfileName).toBe('default')
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('default')
    expect(globalApp.selectedModel).toBe('chat-model')
    expect(globalApp.selectedProvider).toBe('chat-provider')
    expect(globalApp.modelGroups).toEqual([])
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps delayed operations bound to their original page scope', async () => {
    const scope = shallowRef(createSettingsProfileScope('research'))
    let api!: ReturnType<typeof configApi.createApi>
    const Child = defineComponent({ setup() { api = useSettingsApi(configApi); return () => h('div') } })
    const wrapper = mount(defineComponent({ setup() { provide(SETTINGS_PROFILE_SCOPE, scope); return () => h(Child) } }))
    scope.value = createSettingsProfileScope('another')
    await api.saveAuxiliaryModels({ vision: { model: 'original-draft' } })
    expect(new Headers(requestMock.mock.calls[0][1].headers).get('X-Hermes-Profile')).toBe('research')
    wrapper.unmount()
  })

  it('uses the same explicit scope for OAuth and voice configuration mutations', async () => {
    const scope = createSettingsProfileScope('research')
    await copilotApi.createApi(scope.request).startCopilotLogin()
    await copilotApi.createApi(scope.request).disableCopilot()
    await ttsApi.createApi(scope.request).deleteTtsProvider('openai')
    await sttApi.createApi(scope.request).deleteSttProvider('openai')
    await configApi.createApi(scope.request).saveFallbackProviders([{ provider: 'test', model: 'test' }])
    for (const [, options] of requestMock.mock.calls) {
      expect(new Headers(options.headers).get('X-Hermes-Profile')).toBe('research')
    }
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('default')
  })
})
