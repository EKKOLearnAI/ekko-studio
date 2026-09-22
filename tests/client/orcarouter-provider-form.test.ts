// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const modelsStore = vi.hoisted(() => ({
  providers: [] as any[],
  allProviders: [] as any[],
  fetchProviders: vi.fn(),
  addProvider: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => modelsStore }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      key === 'models.foundModels' ? `Found ${params?.count ?? 0}` : key
    ),
  }),
}))
vi.mock('@/api/hermes/copilot-auth', () => ({
  checkCopilotToken: vi.fn(),
  enableCopilot: vi.fn(),
}))
vi.mock('@/api/hermes/system', () => ({ fetchProviderModels: vi.fn(async () => ({ models: [] })) }))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('@/utils/orcaRouterBrand', () => ({
  ORCA_ROUTER_LOGO_URL: 'https://www.orcarouter.ai/orca-logo-classic.png',
  ORCA_ROUTER_KEY_DASHBOARD_URL: 'https://www.orcarouter.ai/console/token',
  ORCA_ROUTER_AUTHORIZED_APPS_URL: 'https://www.orcarouter.ai/console/authorized-apps',
  ORCA_ROUTER_PROVIDER_IDS: ['orcarouter', 'orcarouter-oauth'],
  isOrcaRouterProviderId: (id: string) => id === 'orcarouter' || id === 'orcarouter-oauth',
}))

vi.mock('naive-ui', () => {
  const NButton = defineComponent({
    name: 'NButton',
    inheritAttrs: false,
    props: { disabled: Boolean, loading: Boolean },
    emits: ['click'],
    setup(props, { attrs, emit, slots }) {
      return () => h('button', {
        ...attrs,
        disabled: props.disabled,
        onClick: () => !props.disabled && emit('click'),
      }, slots.default?.())
    },
  })
  const NInput = defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: { value: [String, Number], type: String, placeholder: String, disabled: Boolean, inputProps: Object },
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
  const NInputNumber = defineComponent({
    name: 'NInputNumber',
    props: { value: Number },
    emits: ['update:value'],
    setup() { return () => h('input', { type: 'number' }) },
  })
  /**
   * The real NSelect is the surface under test: it exposes the exact options
   * the component binds and whether free-text entry (`tag`) is enabled.
   */
  const NSelect = defineComponent({
    name: 'NSelect',
    inheritAttrs: false,
    props: { value: String, options: Array, disabled: Boolean, tag: [Boolean, Object], filterable: Boolean },
    emits: ['update:value'],
    setup(props, { attrs, emit }) {
      return () => h('select', {
        ...attrs,
        class: 'n-select',
        'data-tag': String(!!props.tag),
        'data-filterable': String(!!props.filterable),
        value: props.value,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, (props.options as Array<any> || []).map(option => h('option', { value: option.value }, option.label)))
    },
  })
  const NForm = defineComponent({ setup(_, { slots }) { return () => h('form', slots.default?.()) } })
  const NFormItem = defineComponent({ setup(_, { slots }) { return () => h('div', { class: 'n-form-item' }, slots.default?.()) } })
  const NRadioGroup = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()) } })
  const NRadioButton = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()) } })
  const NModal = defineComponent({
    name: 'NModal',
    props: { show: Boolean, title: String },
    emits: ['update:show'],
    setup(props, { slots }) {
      return () => props.show
        ? h('div', { class: 'modal' }, [slots.default?.(), slots.footer?.()])
        : null
    },
  })
  const passthrough = (name: string) => defineComponent({
    name,
    setup(_, { slots }) { return () => h('div', { class: name }, slots.default?.()) },
  })
  return {
    NModal,
    NForm,
    NFormItem,
    NInput,
    NInputNumber,
    NButton,
    NSelect,
    NRadioGroup,
    NRadioButton,
    useMessage: () => messageMock,
    useDialog: () => ({ warning: vi.fn() }),
    NAlert: passthrough('n-alert'),
    NSpin: passthrough('n-spin'),
    NSwitch: passthrough('n-switch'),
    NTag: passthrough('n-tag'),
  }
})

import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue'

/**
 * Live-catalog fixture: the shape the backend returns for an OrcaRouter group
 * after reading `GET /v1/models?capability=…`. The chat bucket excludes the
 * non-text families and the image bucket holds only models that declare image
 * input.
 */
const ORCAROUTER_GROUP = {
  provider: 'orcarouter',
  label: 'OrcaRouter',
  base_url: 'https://api.orcarouter.ai/v1',
  api_mode: 'chat_completions',
  models: ['openai/gpt-5.5'],
  capability_models: {
    chat: ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash-vision-exp'],
    'chat-image': ['deepseek/deepseek-v4-flash-vision-exp'],
    'chat-audio': [],
    'chat-video': [],
    embedding: ['acme/embed-1'],
    image: ['acme/image-maker'],
    video: ['acme/video-maker'],
    rerank: ['acme/reranker'],
  },
  capability_catalog: { source: 'live', degraded: false },
}

const ORCAROUTER_OAUTH_GROUP = {
  provider: 'orcarouter-oauth',
  label: 'OrcaRouter - Auth',
  base_url: 'https://api.orcarouter.ai/v1',
  api_mode: 'chat_completions',
  models: ['openai/gpt-5.5'],
  capability_models: {
    chat: ['openai/gpt-5.5', 'orcarouter/auto'],
    'chat-image': [],
    embedding: [],
    image: [],
    video: [],
    rerank: [],
  },
  capability_catalog: { source: 'seed', degraded: true, reason: 'live catalog unavailable' },
}

const OTHER_GROUP = {
  provider: 'openrouter',
  label: 'OpenRouter',
  base_url: 'https://openrouter.ai/api/v1',
  models: ['anthropic/claude-opus-4.8'],
}

function mountForm() {
  return mount(ProviderFormModal, { attachTo: document.body })
}

/** The model NSelect is the one carrying our test id. */
function modelSelect(wrapper: ReturnType<typeof mountForm>) {
  return wrapper.find('[data-testid="orca-router-model-select"]')
}

async function chooseProvider(wrapper: ReturnType<typeof mountForm>, provider: string) {
  const select = wrapper.find('select')
  await select.setValue(provider)
  await flushPromises()
}

beforeEach(() => {
  for (const fn of Object.values(messageMock)) fn.mockReset()
  modelsStore.fetchProviders.mockReset()
  modelsStore.addProvider.mockReset()
  modelsStore.providers = [ORCAROUTER_GROUP, ORCAROUTER_OAUTH_GROUP, OTHER_GROUP]
  modelsStore.allProviders = [ORCAROUTER_GROUP, ORCAROUTER_OAUTH_GROUP, OTHER_GROUP]
})

describe('ProviderFormModal OrcaRouter model selector', () => {
  it('binds the API-derived chat list and disables free-text entry', async () => {
    const wrapper = mountForm()
    await flushPromises()
    await chooseProvider(wrapper, 'orcarouter')

    const select = modelSelect(wrapper)
    expect(select.exists()).toBe(true)
    expect(select.attributes('data-tag')).toBe('false')
    const options = select.findAll('option').map(option => option.attributes('value'))
    expect(options).toEqual(['openai/gpt-5.5', 'deepseek/deepseek-v4-flash-vision-exp'])
    // No non-text model may appear in the text selector.
    for (const nonText of ['acme/image-maker', 'acme/video-maker', 'acme/reranker', 'acme/embed-1']) {
      expect(options).not.toContain(nonText)
    }
    wrapper.unmount()
  })

  it('keeps other providers on their existing free-text-capable selector', async () => {
    const wrapper = mountForm()
    await flushPromises()
    await chooseProvider(wrapper, 'openrouter')

    const select = wrapper.find('[data-testid="provider-model-select"]')
    expect(select.attributes('data-tag')).toBe('true')
    expect(select.findAll('option').map(option => option.attributes('value')))
      .toEqual(['anthropic/claude-opus-4.8'])
    wrapper.unmount()
  })

  it('shows the degraded notice for a seed catalog and hides it for a live one', async () => {
    const wrapper = mountForm()
    await flushPromises()

    await chooseProvider(wrapper, 'orcarouter')
    expect(wrapper.find('[data-testid="orca-router-provider-catalog-degraded"]').exists()).toBe(false)

    await chooseProvider(wrapper, 'orcarouter-oauth')
    expect(wrapper.find('[data-testid="orca-router-provider-catalog-degraded"]').exists()).toBe(true)

    // A degraded catalog still offers only its verified seed entries.
    expect(modelSelect(wrapper).findAll('option').map(option => option.attributes('value')))
      .toEqual(['openai/gpt-5.5', 'orcarouter/auto'])
    wrapper.unmount()
  })

  it('presents both authentication entries: an API-key field and a Connect control', async () => {
    const wrapper = mountForm()
    await flushPromises()

    await chooseProvider(wrapper, 'orcarouter')
    expect(wrapper.find('[data-testid="orca-router-api-key-field"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="orca-router-connect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="orca-router-provider-hint"]').exists()).toBe(true)

    // The Auth entry point hides the paste field and drives the PKCE modal.
    await chooseProvider(wrapper, 'orcarouter-oauth')
    expect(wrapper.find('[data-testid="orca-router-api-key-field"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
