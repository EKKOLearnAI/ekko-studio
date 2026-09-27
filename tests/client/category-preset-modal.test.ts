// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CategoryPresetModal from '@/components/hermes/chat/CategoryPresetModal.vue'
import { AGENT_OPTIONS } from '@/utils/agent-options'

const apiMock = vi.hoisted(() => ({
  createSessionCategoryWithPreset: vi.fn(),
  updateSessionCategoryPreset: vi.fn(),
}))
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
const stores = vi.hoisted(() => ({ app: null as any, profiles: null as any }))

vi.mock('@/api/studio/sessions', () => apiMock)
vi.mock('@/components/coding-agents/dsh/session-preset-catalog', () => ({ loadDshSessionPresetChoices: vi.fn(async () => []) }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => stores.app }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => stores.profiles }))
vi.mock('@/components/hermes/chat/FolderPicker.vue', () => ({
  default: defineComponent({
    name: 'FolderPicker',
    props: { modelValue: String },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return () => h('input', {
        class: 'folder-path-input',
        value: props.modelValue ?? '',
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value || null),
      })
    },
  }),
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params?.value ? `${key}:${params.value}` : key),
  }),
}))
vi.mock('naive-ui', () => {
  const NButton = defineComponent({
    name: 'NButton',
    inheritAttrs: false,
    props: { disabled: Boolean, loading: Boolean },
    emits: ['click'],
    setup(props, { attrs, emit, slots }) {
      return () => h('button', { ...attrs, type: 'button', disabled: props.disabled, onClick: () => !props.disabled && emit('click') }, slots.default?.())
    },
  })
  const NInput = defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: { value: String, disabled: Boolean, inputProps: Object },
    emits: ['update:value'],
    setup(props, { attrs, emit }) {
      return () => h('input', {
        ...attrs,
        value: props.value ?? '',
        disabled: props.disabled,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  })
  const NSelect = defineComponent({
    name: 'NSelect',
    inheritAttrs: false,
    props: { value: String, options: Array, disabled: Boolean },
    emits: ['update:value'],
    setup(props, { attrs, emit }) {
      return () => h('select', {
        ...attrs,
        value: props.value,
        disabled: props.disabled,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, ((props.options as any[]) || []).map(option => h('option', { value: option.value }, option.label)))
    },
  })
  const NModal = defineComponent({
    name: 'NModal',
    props: { show: Boolean },
    setup(props, { slots }) {
      return () => (props.show ? h('div', { class: 'modal' }, [slots.default?.(), h('footer', slots.footer?.())]) : null)
    },
  })
  const Passthrough = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()) } })
  return {
    NAlert: Passthrough,
    NButton,
    NInput,
    NModal,
    NRadioButton: Passthrough,
    NRadioGroup: Passthrough,
    NSelect,
    useMessage: () => messageMock,
  }
})

const group = (provider: string, models: string[], extra: Record<string, unknown> = {}) => ({
  provider, label: provider, base_url: '', api_key: '', models, ...extra,
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function category(preset: Record<string, unknown> | null) {
  return { id: 1, name: 'Work', preset, created_at: 1, updated_at: 1 }
}

beforeEach(() => {
  apiMock.createSessionCategoryWithPreset.mockReset()
  apiMock.updateSessionCategoryPreset.mockReset().mockImplementation(async (id: number, preset: unknown) => ({ ...category(preset as any), id }))
  messageMock.success.mockReset()
  messageMock.error.mockReset()
  stores.profiles = reactive({
    profiles: [{ name: 'default', active: true }],
    activeProfileName: 'default',
    loading: false,
    fetchProfiles: vi.fn(async () => {}),
  })
  stores.app = reactive({
    modelGroups: [{}],
    profileModelGroups: [{
      profile: 'default',
      groups: [
        group('gateway', ['gw-model']),
        group('anthropic', ['claude-opus-5-5'], { base_url: 'https://api.anthropic.test' }),
        group('openai-codex', ['gpt-5.5'], { auth_type: 'oauth' }),
      ],
    }],
    loadModels: vi.fn(async () => {}),
    displayModelName: (model: string) => model,
  })
})

describe('CategoryPresetModal', () => {
  it('ignores Enter (form submit) while the form is still loading, and while a save is in flight', async () => {
    const profilesLoaded = deferred()
    stores.profiles.profiles = []
    stores.profiles.fetchProfiles = vi.fn(() => profilesLoaded.promise)
    const wrapper = mount(CategoryPresetModal, {
      props: { mode: 'edit', category: category({ model: 'gw-model', provider: 'gateway' }), existingNames: ['Work'], canEditPreset: true, show: true },
    })
    await flushPromises()

    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(apiMock.updateSessionCategoryPreset).not.toHaveBeenCalled()

    stores.profiles.profiles = [{ name: 'default', active: true }]
    profilesLoaded.resolve()
    await flushPromises()

    const saved = deferred<any>()
    apiMock.updateSessionCategoryPreset.mockImplementationOnce(() => saved.promise)
    await wrapper.find('form').trigger('submit')
    await wrapper.find('form').trigger('submit')
    await wrapper.find('[data-testid="category-preset-save"]').trigger('click')
    expect(apiMock.updateSessionCategoryPreset).toHaveBeenCalledTimes(1)
    saved.resolve(category({ provider: 'gateway', model: 'gw-model' }))
    await flushPromises()
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('refuses a Base URL with credentials with a translated message and never sends it', async () => {
    const wrapper = mount(CategoryPresetModal, {
      props: {
        mode: 'edit',
        category: category({ agent: 'claude-code', agentMode: 'scoped', provider: 'gateway', model: 'gw-model', baseUrl: 'https://gw.test/v1' }),
        existingNames: ['Work'],
        canEditPreset: true,
        show: true,
      },
    })
    await flushPromises()
    const baseUrl = wrapper.find('[data-testid="category-preset-base-url"]')
    await baseUrl.setValue('https://user:secret@gw.test/v1')
    await wrapper.find('[data-testid="category-preset-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="category-preset-base-url-error"]').text()).toBe('chat.categoryPresetBaseUrlCredentials')
    expect(apiMock.updateSessionCategoryPreset).not.toHaveBeenCalled()

    await baseUrl.setValue('https://gw.test/v1?api_key=sk-1')
    await wrapper.find('[data-testid="category-preset-save"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateSessionCategoryPreset).not.toHaveBeenCalled()

    await baseUrl.setValue('https://gw.test/v1')
    expect(wrapper.find('[data-testid="category-preset-base-url-error"]').exists()).toBe(false)
    await wrapper.find('[data-testid="category-preset-save"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateSessionCategoryPreset).toHaveBeenCalledWith(1, expect.objectContaining({ baseUrl: 'https://gw.test/v1' }))
  })

  it('keeps relative workspaces as entered (no absolute-path error)', async () => {
    const wrapper = mount(CategoryPresetModal, {
      props: { mode: 'edit', category: category(null), existingNames: ['Work'], canEditPreset: true, show: true },
    })
    await flushPromises()
    await wrapper.find('.folder-path-input').setValue('projects/app')
    await wrapper.find('[data-testid="category-preset-save"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateSessionCategoryPreset).toHaveBeenCalledWith(1, { workspace: 'projects/app' })
  })

  it('warns about a stored Base URL once the provider has its own base_url', async () => {
    const wrapper = mount(CategoryPresetModal, {
      props: {
        mode: 'edit',
        category: category({ agent: 'claude-code', agentMode: 'scoped', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: 'https://proxy.test/v1' }),
        existingNames: ['Work'],
        canEditPreset: true,
        show: true,
      },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="category-preset-base-url"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="category-preset-base-url-warning"]').text())
      .toBe('chat.presetWarningBaseUrl:https://proxy.test/v1')
  })

  it('treats Agent "Default" as unknown: no agent-specific provider warning in the form', async () => {
    // OAuth provider that a scoped external agent cannot use.
    const withDefault = mount(CategoryPresetModal, {
      props: { mode: 'edit', category: category({ provider: 'openai-codex', model: 'gpt-5.5' }), existingNames: ['Work'], canEditPreset: true, show: true },
    })
    await flushPromises()
    expect(withDefault.text()).not.toContain('chat.presetWarningProvider')
    expect(withDefault.text()).not.toContain('chat.presetWarningModel')

    // With an explicit scoped Codex the same provider is flagged, like the New Chat panel does.
    const withCodex = mount(CategoryPresetModal, {
      props: {
        mode: 'edit',
        category: category({ agent: 'codex', agentMode: 'scoped', provider: 'openai-codex', model: 'gpt-5.5' }),
        existingNames: ['Work'],
        canEditPreset: true,
        show: true,
      },
    })
    await flushPromises()
    expect(withCodex.text()).toContain('chat.presetWarningProvider:openai-codex')
  })

  it('lists agents in the New Chat panel order, Cursor included, after "Default"', async () => {
    const wrapper = mount(CategoryPresetModal, {
      props: { mode: 'edit', category: category(null), existingNames: ['Work'], canEditPreset: true, show: true },
    })
    await flushPromises()
    const values = wrapper.find('[data-testid="category-preset-agent"]').findAll('option').map(option => option.attributes('value'))
    expect(values).toEqual(['', ...AGENT_OPTIONS.map(option => option.value)])
    expect(values).toContain('cursor')
  })

  it('handles Cursor like the New Chat panel: no launch mode, provider, model, API mode or Base URL', async () => {
    const wrapper = mount(CategoryPresetModal, {
      props: {
        mode: 'edit',
        category: category({ agent: 'claude-code', agentMode: 'scoped', provider: 'gateway', model: 'gw-model', apiMode: 'chat_completions', baseUrl: 'https://gw.test/v1', workspace: '/p/app' }),
        existingNames: ['Work'],
        canEditPreset: true,
        show: true,
      },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('codingAgents.launchModeScope')
    expect(wrapper.find('[data-testid="category-preset-provider"]').exists()).toBe(true)

    await wrapper.find('[data-testid="category-preset-agent"]').setValue('cursor')
    await flushPromises()
    expect(wrapper.text()).not.toContain('codingAgents.launchModeScope')
    expect(wrapper.text()).not.toContain('codingAgents.protocolScope')
    expect(wrapper.find('[data-testid="category-preset-provider"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="category-preset-model"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="category-preset-base-url"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="category-preset-profile"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('chat.presetWarning')

    await wrapper.find('[data-testid="category-preset-save"]').trigger('click')
    await flushPromises()
    // Hidden fields are not stored, exactly like a global coding agent.
    expect(apiMock.updateSessionCategoryPreset).toHaveBeenCalledWith(1, { agent: 'cursor', workspace: '/p/app' })
  })

  it('does not store a launch mode for a stored Cursor preset that carries one', async () => {
    const wrapper = mount(CategoryPresetModal, {
      props: { mode: 'edit', category: category({ agent: 'cursor', agentMode: 'scoped' }), existingNames: ['Work'], canEditPreset: true, show: true },
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('codingAgents.launchModeScope')
    await wrapper.find('[data-testid="category-preset-save"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateSessionCategoryPreset).toHaveBeenCalledWith(1, { agent: 'cursor' })
  })
})
