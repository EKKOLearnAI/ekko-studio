// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue'

const modelsStoreMock = vi.hoisted(() => ({
  providers: [],
  allProviders: [],
  fetchProviders: vi.fn(),
  addProvider: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => modelsStoreMock }))
vi.mock('@/api/hermes/copilot-auth', () => ({
  checkCopilotToken: vi.fn(),
  enableCopilot: vi.fn(),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

vi.mock('naive-ui', () => {
  const NButton = defineComponent({
    name: 'NButton',
    emits: ['click'],
    setup(_, { emit, slots }) {
      return () => h('button', { onClick: () => emit('click') }, slots.default?.())
    },
  })
  const NInput = defineComponent({
    name: 'NInput',
    props: { value: String },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('input', {
        value: props.value || '',
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  })
  const NSelect = defineComponent({
    name: 'NSelect',
    props: { value: String, options: Array },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('select', {
        value: props.value || '',
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, (props.options as Array<{ label: string; value: string }> || [])
        .map(option => h('option', { value: option.value }, option.label)))
    },
  })
  const Passthrough = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()) } })
  const NModal = defineComponent({
    name: 'NModal',
    props: { show: Boolean },
    setup(props, { slots }) {
      return () => props.show ? h('div', [slots.default?.(), slots.footer?.()]) : null
    },
  })
  return {
    NButton,
    NInput,
    NSelect,
    NInputNumber: Passthrough,
    NForm: Passthrough,
    NFormItem: Passthrough,
    NRadioGroup: Passthrough,
    NRadioButton: Passthrough,
    NModal,
    useMessage: () => messageMock,
    useDialog: () => ({ success: vi.fn() }),
  }
})

vi.mock('@/components/hermes/models/CodexLoginModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/NousLoginModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/CopilotLoginModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/XaiOAuthLoginModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/AnthropicLoginModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/models/MiniMaxOAuthLoginModal.vue', () => ({ default: { template: '<div />' } }))

beforeEach(() => {
  vi.clearAllMocks()
  modelsStoreMock.addProvider.mockResolvedValue(undefined)
})

describe('ProviderFormModal', () => {
  it('defaults custom providers to auto-detect and omits api_mode when saving', async () => {
    const wrapper = mount(ProviderFormModal)

    await wrapper.findAll('button').find(button => button.text() === 'models.custom')!.trigger('click')
    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Research Proxy')
    await inputs[1].setValue('https://research.invalid/v1')
    await inputs[2].setValue('research-key')

    const selectComponents = wrapper.findAllComponents({ name: 'NSelect' })
    selectComponents[0].vm.$emit('update:value', 'research-model')
    await wrapper.vm.$nextTick()
    const apiModeSelect = wrapper.findAll('select')[1]

    expect(apiModeSelect.findAll('option').map(option => option.text())[0]).toBe('Auto-detect (recommended)')
    expect((apiModeSelect.element as HTMLSelectElement).value).toBe('')

    await wrapper.findAll('button').find(button => button.text() === 'common.add')!.trigger('click')
    await flushPromises()

    expect(modelsStoreMock.addProvider).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Research Proxy',
      base_url: 'https://research.invalid/v1',
      model: 'research-model',
      api_mode: undefined,
    }))
  })
})
