// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const apiMocks = vi.hoisted(() => ({
  fetchAuxiliaryModels: vi.fn(),
  fetchDelegationModel: vi.fn(),
  fetchStudioImageProviders: vi.fn(),
  saveAuxiliaryModels: vi.fn(),
  saveDelegationModel: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

const modelsStore = vi.hoisted(() => ({
  providers: [
    { provider: 'openrouter', label: 'OpenRouter', models: ['old-model'] },
    { provider: 'anthropic', label: 'Anthropic', models: ['claude-sonnet'] },
    {
      provider: 'custom:studio-images',
      label: 'Studio Images',
      models: ['seedream-4', 'qwen-image-edit'],
    },
  ],
}))

const profilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
}))

vi.mock('@/api/hermes/config', () => apiMocks)
vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => modelsStore }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesStore }))
vi.mock('@/components/hermes/models/FallbackProvidersPanel.vue', () => ({
  default: { template: '<div data-testid="fallback-providers-panel" />' },
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    NButton: defineComponent({
      name: 'NButton',
      props: { disabled: Boolean, loading: Boolean },
      emits: ['click'],
      setup(props, { attrs, emit, slots }) {
        return () => h('button', {
          ...attrs,
          disabled: props.disabled,
          onClick: () => emit('click'),
        }, slots.default?.())
      },
    }),
    NInput: defineComponent({ name: 'NInput', template: '<input />' }),
    NInputNumber: defineComponent({ name: 'NInputNumber', template: '<input />' }),
    NModal: defineComponent({
      name: 'NModal',
      props: { show: Boolean },
      emits: ['update:show'],
      setup(props, { slots }) {
        return () => props.show
          ? h('div', { class: 'modal-stub' }, [slots.default?.(), slots.footer?.()])
          : null
      },
    }),
    NSelect: defineComponent({
      name: 'NSelect',
      props: {
        value: [String, Number],
        options: Array,
        placeholder: String,
        disabled: Boolean,
        filterable: Boolean,
        clearable: Boolean,
      },
      emits: ['update:value'],
      setup(props, { attrs, emit }) {
        return () => h('select', {
          ...attrs,
          value: props.value,
          disabled: props.disabled,
          onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
        })
      },
    }),
    NSpin: defineComponent({
      name: 'NSpin',
      setup(_props, { slots }) {
        return () => h('div', slots.default?.())
      },
    }),
    useMessage: () => messageMock,
  }
})

import AuxiliaryModelsPanel from '@/components/hermes/models/AuxiliaryModelsPanel.vue'

describe('AuxiliaryModelsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.fetchAuxiliaryModels.mockResolvedValue({ tasks: [], auxiliary: {} })
    apiMocks.fetchDelegationModel.mockResolvedValue({
      delegation: { provider: 'openrouter', model: 'old-model', reasoning_effort: 'low' },
    })
    apiMocks.fetchStudioImageProviders.mockResolvedValue({ ok: true, profile: 'default', providers: [] })
    apiMocks.saveDelegationModel
      .mockResolvedValueOnce({
        success: true,
        delegation: { provider: 'anthropic', model: 'claude-sonnet', reasoning_effort: 'high' },
      })
      .mockResolvedValueOnce({ success: true, delegation: {} })
  })

  it('loads, saves, and resets the Profile delegation route from server responses', async () => {
    const wrapper = mount(AuxiliaryModelsPanel)
    await flushPromises()

    expect(apiMocks.fetchAuxiliaryModels).toHaveBeenCalledOnce()
    expect(apiMocks.fetchDelegationModel).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('openrouter / old-model')
    expect(wrapper.find('[data-testid="fallback-providers-panel"]').exists()).toBe(true)

    await wrapper.get('[data-testid="delegation-edit"]').trigger('click')
    const selects = wrapper.findAllComponents({ name: 'NSelect' })
    expect(selects).toHaveLength(3)
    selects[0].vm.$emit('update:value', 'anthropic')
    await wrapper.vm.$nextTick()
    selects[1].vm.$emit('update:value', 'claude-sonnet')
    selects[2].vm.$emit('update:value', 'high')
    await wrapper.get('[data-testid="delegation-save"]').trigger('click')
    await flushPromises()

    expect(apiMocks.saveDelegationModel).toHaveBeenNthCalledWith(1, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      reasoning_effort: 'high',
    })
    expect(wrapper.text()).toContain('anthropic / claude-sonnet')

    await wrapper.get('[data-testid="delegation-reset"]').trigger('click')
    await flushPromises()

    expect(apiMocks.saveDelegationModel).toHaveBeenNthCalledWith(2, {})
    expect(wrapper.text()).toContain('models.delegationInheritMain')
    expect(messageMock.success).toHaveBeenCalledTimes(2)
  })

  it('maps Studio image routes to configured custom provider options', async () => {
    apiMocks.fetchAuxiliaryModels.mockResolvedValueOnce({
      tasks: [{ key: 'image_edit', label: 'Image edit', default_timeout: 600 }],
      auxiliary: {
        image_edit: { provider: 'Studio Images', model: 'qwen-image-edit', timeout: 600 },
      },
    })
    apiMocks.saveAuxiliaryModels.mockResolvedValueOnce({
      success: true,
      auxiliary: {
        image_edit: {
          provider: 'custom:studio-images',
          model: 'qwen-image-edit',
          timeout: 600,
        },
      },
    })

    const wrapper = mount(AuxiliaryModelsPanel)
    await flushPromises()

    const rows = wrapper.findAll('.auxiliary-row')
    await rows[1].get('button').trigger('click')

    const providerSelect = wrapper.getComponent('[data-testid="auxiliary-provider"]')
    expect(providerSelect.props('value')).toBe('custom:studio-images')
    expect(providerSelect.props('options')).toEqual([
      { label: 'models.auxiliaryProviderStudioDefault', value: 'auto' },
      { label: 'Studio Images', value: 'custom:studio-images' },
    ])

    await wrapper.get('[data-testid="auxiliary-save"]').trigger('click')
    await flushPromises()

    expect(apiMocks.saveAuxiliaryModels).toHaveBeenCalledWith({
      image_edit: {
        provider: 'custom:studio-images',
        model: 'qwen-image-edit',
        timeout: 600,
      },
    })
  })

  it('normalizes the unsupported main provider to auto for Studio image routes', async () => {
    apiMocks.fetchAuxiliaryModels.mockResolvedValueOnce({
      tasks: [{ key: 'image_generation', label: 'Image generation', default_timeout: 600 }],
      auxiliary: {
        image_generation: { provider: 'main', model: 'old-model', timeout: 600 },
      },
    })

    const wrapper = mount(AuxiliaryModelsPanel)
    await flushPromises()

    await wrapper.findAll('.auxiliary-row')[1].get('button').trigger('click')

    expect(wrapper.getComponent('[data-testid="auxiliary-provider"]').props('value')).toBe('auto')
  })

  it('uses Hermes native image providers and filters them by task capability', async () => {
    apiMocks.fetchAuxiliaryModels.mockResolvedValueOnce({
      tasks: [
        { key: 'image_generation', label: 'Image generation', default_timeout: 600 },
        { key: 'image_edit', label: 'Image edit', default_timeout: 600 },
      ],
      auxiliary: {},
    })
    apiMocks.fetchStudioImageProviders.mockResolvedValueOnce({
      ok: true,
      profile: 'default',
      providers: [
        {
          name: 'openai', display_name: 'OpenAI Images', available: true, active: true,
          default_model: 'gpt-image-2', models: [{ id: 'gpt-image-2' }],
          capabilities: { modalities: ['text', 'image'] },
        },
        {
          name: 'deepinfra', display_name: 'DeepInfra', available: false, active: false,
          default_model: 'flux', models: [{ id: 'flux' }], capabilities: { modalities: ['text'] },
        },
      ],
    })

    const wrapper = mount(AuxiliaryModelsPanel)
    await flushPromises()
    await wrapper.findAll('.auxiliary-row')[1].get('button').trigger('click')

    const generationOptions = wrapper.getComponent('[data-testid="auxiliary-provider"]').props('options')
    expect(generationOptions).toContainEqual({ label: 'OpenAI Images', value: 'image:openai', disabled: false })
    expect(generationOptions).toContainEqual({ label: 'DeepInfra', value: 'image:deepinfra', disabled: true })
    wrapper.getComponent('[data-testid="auxiliary-provider"]').vm.$emit('update:value', 'image:openai')
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent('[data-testid="auxiliary-model"]').props('value')).toBe('gpt-image-2')

    wrapper.getComponent('[data-testid="auxiliary-provider"]').vm.$emit('update:value', 'auto')
    await wrapper.vm.$nextTick()
    await wrapper.get('.modal-stub button').trigger('click')
    await wrapper.findAll('.auxiliary-row')[2].get('button').trigger('click')
    const editOptions = wrapper.getComponent('[data-testid="auxiliary-provider"]').props('options')
    expect(editOptions).toContainEqual({ label: 'OpenAI Images', value: 'image:openai', disabled: false })
    expect(editOptions).not.toContainEqual(expect.objectContaining({ value: 'image:deepinfra' }))
  })

  it('labels an unconfigured Studio image route as the Studio default', async () => {
    apiMocks.fetchAuxiliaryModels.mockResolvedValueOnce({
      tasks: [{ key: 'image_generation', label: 'Image generation', default_timeout: 600 }],
      auxiliary: {},
    })

    const wrapper = mount(AuxiliaryModelsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('models.auxiliaryProviderStudioDefault')
  })
})
