// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

enableAutoUnmount(afterEach)

const routerReplace = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({
  query: {} as Record<string, string>,
}))
const modelsStoreState = vi.hoisted(() => ({
  loading: false,
  refreshingModelCache: false,
  providers: [] as unknown[],
  fetchProviders: vi.fn(async () => {}),
  refreshModelCache: vi.fn(async () => {}),
}))
const modelsStore = reactive(modelsStoreState)
const appStore = vi.hoisted(() => ({
  reloadModels: vi.fn(async () => {}),
}))
const profilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [{ name: 'default' }] as unknown[],
  fetchProfiles: vi.fn(async () => {}),
}))
const settingsStore = vi.hoisted(() => ({
  loading: false,
  saving: false,
  fetchSettings: vi.fn(async () => {}),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ replace: routerReplace }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h, ref } = await import('vue')
  return {
    NButton: defineComponent({
      name: 'NButton',
      emits: ['click'],
      setup(_props, { emit, slots }) {
        return () => h('button', { onClick: () => emit('click') }, slots.default?.())
      },
    }),
    NSelect: defineComponent({ name: 'NSelect', props: ['value', 'options'], emits: ['update:value'], setup: () => () => h('select') }),
    NModal: defineComponent({
      name: 'NModal', props: ['show', 'title', 'negativeText'], emits: ['update:show', 'negative-click'],
      setup: (props, { slots, emit }) => () => props.show ? h('div', { role: 'dialog' }, [slots.default?.(), slots.footer?.(), props.negativeText && h('button', { onClick: () => emit('negative-click') }, props.negativeText)]) : null,
    }),
    NSpin: defineComponent({
      name: 'NSpin',
      setup(_props, { slots }) {
        return () => h('div', slots.default?.())
      },
    }),
    NTabPane: defineComponent({
      name: 'NTabPane',
      props: { name: String, tab: String },
      setup(props, { slots }) {
        return () => h('section', { 'data-tab': props.name }, slots.default?.())
      },
    }),
    NTabs: defineComponent({
      name: 'NTabs',
      props: { value: String },
      emits: ['update:value'],
      setup(props, { slots }) {
        return () => h('div', { class: 'n-tabs-stub', 'data-value': props.value }, slots.default?.())
      },
    }),
    useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
    useDialogReactiveList: () => ref([]),
  }
})

vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => modelsStore }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => appStore }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesStore }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => settingsStore }))
vi.mock('@/api/hermes/copilot-auth', () => ({ checkCopilotToken: vi.fn(async () => {}) }))
vi.mock('@/api/hermes/profiles', () => ({ fetchProfiles: vi.fn(async () => [{ name: 'default' }, { name: 'work' }, { name: 'research' }]) }))
vi.mock('@/api/client', () => ({ isStoredSuperAdmin: () => false }))

vi.mock('@/components/common/PageLoading.vue', () => ({ default: { template: '<div><slot /></div>' } }))

vi.mock('@/components/hermes/models/AuxiliaryModelsPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/CombinationModelsPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/ModelApiPanel.vue', () => ({ default: { props: ['profile'], template: '<div class="model-api-stub" :data-profile="profile" />' } }))
vi.mock('@/components/hermes/models/JevSettingsPanel.vue', () => ({ default: { props: ['profile'], template: '<div class="jev-settings-stub" :data-profile="profile" />' } }))
vi.mock('@/components/hermes/models/ProvidersPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/ProviderVisibilityModal.vue', () => ({
  default: { name: 'ProviderVisibilityModal', props: ['provider'], emits: ['close'], template: '<div class="visibility-editor-stub" />' },
}))
vi.mock('@/components/hermes/models/ProviderFormModal.vue', () => ({
  default: {
    name: 'ProviderFormModal',
    emits: ['close', 'saved'],
    template: '<div />',
  },
}))
vi.mock('@/components/hermes/settings/VoiceSettings.vue', () => ({
  default: {
    props: ['kind'],
    template: '<div class="voice-settings-stub" :data-kind="kind" />',
  },
}))

vi.mock('@/components/hermes/settings/AccountSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/AgentSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/CompressionSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/DisplaySettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/GatewayAutoStartSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/MemorySettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/ModelSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/PrivacySettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/ProxySettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/SessionSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/settings/UserManagementSettings.vue', () => ({ default: { template: '<div />' } }))

import ModelsView from '@/views/hermes/ModelsView.vue'
import SettingsView from '@/views/hermes/SettingsView.vue'

describe('Models voice settings tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.query = {}
    modelsStore.providers = []
    modelsStore.fetchProviders.mockImplementation(async () => {})
  })

  it('opens STT/TTS from the route query and keeps tab changes linkable', async () => {
    routeState.query = { tab: 'stt', profile: 'work' }
    const wrapper = mount(ModelsView)
    await flushPromises()

    const tabs = wrapper.findComponent({ name: 'NTabs' })
    expect(tabs.props('value')).toBe('stt')
    expect(wrapper.find('[data-kind="stt"]').exists()).toBe(true)
    expect(wrapper.find('[data-kind="tts"]').exists()).toBe(true)

    tabs.vm.$emit('update:value', 'tts')
    await flushPromises()
    expect(routerReplace).toHaveBeenCalledWith({
      query: { tab: 'tts', profile: 'work' },
    })
  })

  it('keeps the add-provider deep link on the general tab', async () => {
    routeState.query = { addProvider: '1', tab: 'tts' }
    const wrapper = mount(ModelsView)
    await flushPromises()

    expect(wrapper.findComponent({ name: 'NTabs' }).props('value')).toBe('general')
    expect(routerReplace).toHaveBeenCalledWith({ query: {} })
  })

  it('refreshes the global model picker after an OAuth provider is saved', async () => {
    routeState.query = { addProvider: '1' }
    const wrapper = mount(ModelsView)
    await flushPromises()
    vi.clearAllMocks()

    wrapper.getComponent({ name: 'ProviderFormModal' }).vm.$emit('saved')
    await flushPromises()

    expect(modelsStore.fetchProviders).toHaveBeenCalledOnce()
    expect(appStore.reloadModels).toHaveBeenCalledWith({ preserveSelection: true })
  })

  it('keeps fallback settings in Auxiliary Models and redirects the old tab link', async () => {
    routeState.query = { tab: 'fallback', profile: 'work' }
    const wrapper = mount(ModelsView)
    await flushPromises()

    expect(wrapper.findComponent({ name: 'NTabs' }).props('value')).toBe('auxiliary')
    expect(wrapper.find('[data-tab="fallback"]').exists()).toBe(false)
    expect(routerReplace).toHaveBeenCalledWith({
      query: { tab: 'auxiliary', profile: 'work' },
    })
  })

  it('redirects the legacy Settings voice link to Models TTS', async () => {
    routeState.query = { tab: 'voice', profile: 'work' }
    mount(SettingsView)
    await flushPromises()

    expect(routerReplace).toHaveBeenCalledWith({
      name: 'hermes.models',
      query: { tab: 'tts', profile: 'work' },
    })
  })

  it('warns only for more than 100 visible models and opens the selected provider editor', async () => {
    const group = (provider: string, visible: number, total = visible) => ({
      provider, label: provider, models: Array.from({ length: visible }, (_, i) => `model-${i}`),
      available_models: Array.from({ length: total }, (_, i) => `model-${i}`),
    })
    modelsStore.fetchProviders.mockImplementation(async () => {
      modelsStore.providers = [group('large', 101), group('boundary', 100), group('filtered', 2, 3000)]
    })
    const wrapper = mount(ModelsView)
    await flushPromises()

    const notice = wrapper.get('[data-testid="large-model-catalog-notice"]')
    expect(notice.findAll('li')).toHaveLength(1)
    await notice.get('button').trigger('click')
    expect(wrapper.find('[data-testid="large-model-catalog-notice"]').exists()).toBe(false)
    expect(wrapper.getComponent({ name: 'ProviderVisibilityModal' }).props('provider').provider).toBe('large')
  })

  it('does not warn from a stale catalog when provider loading fails', async () => {
    modelsStore.providers = [{ provider: 'stale', models: Array.from({ length: 101 }, (_, i) => `model-${i}`) }]
    const wrapper = mount(ModelsView)
    await flushPromises()
    expect(wrapper.find('[data-testid="large-model-catalog-notice"]').exists()).toBe(false)
  })

  it('defers the notice until the add-provider form is closed', async () => {
    routeState.query = { addProvider: '1' }
    modelsStore.fetchProviders.mockImplementation(async () => {
      modelsStore.providers = [{ provider: 'large', label: 'large', models: Array.from({ length: 101 }, (_, i) => `model-${i}`) }]
    })
    const wrapper = mount(ModelsView)
    await flushPromises()
    expect(wrapper.find('[data-testid="large-model-catalog-notice"]').exists()).toBe(false)
    wrapper.getComponent({ name: 'ProviderFormModal' }).vm.$emit('close')
    await flushPromises()
    expect(wrapper.find('[data-testid="large-model-catalog-notice"]').exists()).toBe(true)
  })

  it('rechecks a changed catalog after an add-provider save without opening over the form', async () => {
    routeState.query = { addProvider: '1' }
    modelsStore.fetchProviders.mockImplementation(async () => { modelsStore.providers = [] })
    const wrapper = mount(ModelsView)
    await flushPromises()
    modelsStore.providers = [{ provider: 'added', label: 'Added', models: Array(101).fill('model') }]
    await flushPromises()
    expect(wrapper.find('[data-testid="large-model-catalog-notice"]').exists()).toBe(false)
    wrapper.getComponent({ name: 'ProviderFormModal' }).vm.$emit('saved', true)
    await flushPromises()
    expect(wrapper.find('[data-testid="large-model-catalog-notice"]').exists()).toBe(true)
  })

  it('recovers detection after a failed initial catalog load is refreshed successfully', async () => {
    const wrapper = mount(ModelsView)
    await flushPromises()
    modelsStore.providers = [{ provider: 'recovered', label: 'Recovered', models: Array(101).fill('model') }]
    await flushPromises()
    expect(wrapper.find('[data-testid="large-model-catalog-notice"]').exists()).toBe(true)
  })
})
