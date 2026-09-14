// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProviderEditorModal from '@/components/hermes/models/ProviderEditorModal.vue'
import type { AvailableModelGroup, ProviderEditorDetail } from '@/api/hermes/system'

const apiMock = vi.hoisted(() => ({
  testProviderEditor: vi.fn(),
}))

const storeMock = vi.hoisted(() => ({
  fetchProviderEditor: vi.fn(),
  saveProviderEditor: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}))

const dialogMock = vi.hoisted(() => ({
  warning: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => apiMock)
vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => storeMock }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'common.save') return 'Save'
      if (key === 'common.cancel') return 'Cancel'
      if (key === 'common.edit') return 'Edit'
      if (key === 'models.testConnection') return 'Test connection'
      if (key === 'models.clearProviderCredentials') return 'Clear credentials'
      if (key === 'models.credentialConfigured') return 'Configured'
      if (key === 'models.credentialNotConfigured') return 'Not configured'
      if (key === 'models.providerTestSuccess') return `Found ${params?.count || 0}`
      if (key === 'models.providerTestNoCatalog') return 'No model catalog'
      return key
    },
  }),
}))

vi.mock('naive-ui', () => {
  const NButton = defineComponent({
    name: 'NButton',
    inheritAttrs: false,
    props: { disabled: Boolean, loading: Boolean, title: String },
    emits: ['click'],
    setup(props, { attrs, emit, slots }) {
      return () => h('button', {
        ...attrs,
        disabled: props.disabled,
        title: props.title,
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
      return () => h(props.type === 'textarea' ? 'textarea' : 'input', {
        ...attrs,
        ...(props.inputProps || {}),
        value: props.value ?? '',
        type: props.type === 'password' ? 'password' : 'text',
        placeholder: props.placeholder,
        disabled: props.disabled,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  })
  const NInputNumber = defineComponent({
    name: 'NInputNumber',
    props: { value: Number, placeholder: String },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('input', {
        class: 'number-input',
        type: 'number',
        value: props.value ?? '',
        placeholder: props.placeholder,
        onInput: (event: Event) => {
          const value = (event.target as HTMLInputElement).value
          emit('update:value', value ? Number(value) : null)
        },
      })
    },
  })
  const NSelect = defineComponent({
    name: 'NSelect',
    props: { value: String, options: Array, disabled: Boolean },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('select', {
        value: props.value,
        disabled: props.disabled,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, (props.options as Array<any> || []).map(option => h('option', { value: option.value }, option.label)))
    },
  })
  const NCheckbox = defineComponent({
    name: 'NCheckbox',
    props: { checked: Boolean },
    emits: ['update:checked'],
    setup(props, { emit, slots }) {
      return () => h('label', [
        h('input', {
          class: 'checkbox-input',
          type: 'checkbox',
          checked: props.checked,
          onChange: (event: Event) => emit('update:checked', (event.target as HTMLInputElement).checked),
        }),
        slots.default?.(),
      ])
    },
  })
  const NModal = defineComponent({
    name: 'NModal',
    props: { show: Boolean, title: String },
    emits: ['update:show'],
    setup(props, { slots }) {
      return () => props.show ? h('div', { class: 'modal' }, [
        h('h2', props.title),
        slots.default?.(),
        h('footer', slots.footer?.()),
      ]) : null
    },
  })
  const Passthrough = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()) } })
  const NTag = defineComponent({ setup(_, { slots }) { return () => h('span', slots.default?.()) } })
  return {
    NButton,
    NCheckbox,
    NInput,
    NInputNumber,
    NModal,
    NSelect,
    NSpin: Passthrough,
    NTag,
    useMessage: () => messageMock,
    useDialog: () => dialogMock,
  }
})

function detail(overrides: Partial<ProviderEditorDetail> = {}): ProviderEditorDetail {
  return {
    id: 'custom:example',
    label: 'Example',
    builtin: false,
    source: 'custom_providers',
    base_url: 'https://api.example.com/v1',
    api_mode: 'chat_completions',
    preferred_model: 'model-a',
    credential_configured: true,
    editable: true,
    editable_fields: [
      'label', 'base_url', 'api_key', 'api_mode', 'preferred_model', 'context_lengths',
      'discover_models', 'rate_limit_delay', 'request_timeout_seconds', 'stale_timeout_seconds', 'extra_body',
      'extra_headers', 'preserve_client_identity', 'proxy_url',
    ],
    context_lengths: {},
    connection_test_supported: true,
    revision: 'revision-1',
    ...overrides,
  }
}

function provider(credential: string): AvailableModelGroup {
  return {
    provider: 'custom:example',
    label: 'Example',
    base_url: 'https://api.example.com/v1',
    api_key: credential,
    api_mode: 'chat_completions',
    models: ['model-a', 'model-b'],
    available_models: ['model-a', 'model-b'],
    provider_editable: true,
  }
}

async function mountEditor(options: {
  detail?: ProviderEditorDetail
  providerCredential?: string
} = {}) {
  const current = options.detail || detail()
  storeMock.fetchProviderEditor.mockResolvedValue(structuredClone(current))
  storeMock.saveProviderEditor.mockResolvedValue({ ...structuredClone(current), revision: 'revision-2' })
  apiMock.testProviderEditor.mockResolvedValue({ success: true, models: ['model-a'], model_count: 1 })
  const wrapper = mount(ProviderEditorModal, {
    props: {
      show: true,
      provider: provider(options.providerCredential || ['frontend', 'credential'].join('-')),
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  dialogMock.warning.mockImplementation((options: any) => options.onPositiveClick?.())
})

describe('ProviderEditorModal', () => {
  it('provides network setting labels in every locale', () => {
    const locales = import.meta.glob<{ models: Record<string, unknown> }>(
      '../../packages/client/src/i18n/locales/*.ts', { eager: true, import: 'default' },
    )
    for (const [locale, messages] of Object.entries(locales)) {
      for (const key of ['preserveClientIdentity', 'providerProxyUrl', 'providerExtraHeaders', 'extraHeadersInvalid']) {
        expect(messages.models[key], `${locale}: models.${key}`).toEqual(expect.any(String))
      }
    }
  })

  it('leaves network settings opt-in and omits unchanged values from the patch', async () => {
    const wrapper = await mountEditor()
    const identity = wrapper.findAll('label').find(label => label.text() === 'models.preserveClientIdentity')!
    expect(identity.find('input').element.checked).toBe(false)
    expect(wrapper.find('input[name="provider-proxy-url"]').element.value).toBe('')
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()
    const patch = storeMock.saveProviderEditor.mock.calls[0][2]
    expect(patch).not.toHaveProperty('extra_headers')
    expect(patch).not.toHaveProperty('preserve_client_identity')
    expect(patch).not.toHaveProperty('proxy_url')
  })

  it('tests and saves the same draft network options without changing the API key', async () => {
    const wrapper = await mountEditor()
    const identity = wrapper.findAll('label').find(label => label.text() === 'models.preserveClientIdentity')!
    await identity.find('input').setValue(true)
    await wrapper.find('input[name="provider-proxy-url"]').setValue('http://user:proxy-password@localhost:8080')
    await wrapper.find('textarea[name="provider-extra-headers"]').setValue('{"User-Agent":"custom-client","X-Route":"a"}')
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()
    const patch = storeMock.saveProviderEditor.mock.calls[0][2]
    expect(patch).toMatchObject({
      preserve_client_identity: true,
      proxy_url: 'http://user:proxy-password@localhost:8080',
      extra_headers: { 'User-Agent': 'custom-client', 'X-Route': 'a' },
      credential_action: 'keep',
    })
    expect(apiMock.testProviderEditor).toHaveBeenCalledWith('custom:example', patch)
    expect(patch).not.toHaveProperty('api_key')
  })

  it('clears saved network settings and resets drafts on reopening', async () => {
    const current = detail({
      preserve_client_identity: true, proxy_url: 'http://localhost:8080',
      extra_headers: { 'x-route': 'saved' },
    })
    const wrapper = await mountEditor({ detail: current })
    const identity = () => wrapper.findAll('label').find(label => label.text() === 'models.preserveClientIdentity')!.find('input')
    await identity().setValue(false)
    await wrapper.find('input[name="provider-proxy-url"]').setValue('')
    await wrapper.find('textarea[name="provider-extra-headers"]').setValue('')
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()
    expect(storeMock.saveProviderEditor.mock.calls[0][2]).toMatchObject({
      preserve_client_identity: false, proxy_url: null, extra_headers: null,
    })
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true })
    await flushPromises()
    expect(identity().element.checked).toBe(true)
    expect(wrapper.find('input[name="provider-proxy-url"]').element.value).toBe(current.proxy_url)
    expect(JSON.parse(wrapper.find('textarea[name="provider-extra-headers"]').element.value)).toEqual(current.extra_headers)
  })

  it.each(['[]', '{"x-route": 123}', '{broken'])('blocks malformed extra headers before testing or saving (%s)', async text => {
    const wrapper = await mountEditor()
    await wrapper.find('textarea[name="provider-extra-headers"]').setValue(text)
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()
    expect(messageMock.error).toHaveBeenCalledWith('models.extraHeadersInvalid')
    expect(apiMock.testProviderEditor).not.toHaveBeenCalled()
    expect(storeMock.saveProviderEditor).not.toHaveBeenCalled()
  })

  it('never renders the plaintext credential already present in the model list response', async () => {
    const credential = ['do', 'not', 'render'].join('-')
    const wrapper = await mountEditor({ providerCredential: credential })

    expect(wrapper.text()).toContain('Configured')
    expect(wrapper.html()).not.toContain(credential)
    const passwordInput = wrapper.find('input[type="password"]')
    expect(passwordInput.element.getAttribute('value') || '').toBe('')
    expect(passwordInput.attributes('autocomplete')).toBe('new-password')
    expect(passwordInput.attributes('name')).toBe('provider-api-key-replacement')
    expect(passwordInput.attributes('data-1p-ignore')).toBe('true')
  })

  it('keeps the existing credential when the password field is blank', async () => {
    const wrapper = await mountEditor()
    const saveButton = wrapper.findAll('button').find(button => button.text() === 'Save')!
    await saveButton.trigger('click')
    await flushPromises()

    expect(apiMock.testProviderEditor).toHaveBeenCalledOnce()
    expect(storeMock.saveProviderEditor).toHaveBeenCalledOnce()
    const [, revision, patch] = storeMock.saveProviderEditor.mock.calls[0]
    expect(revision).toBe('revision-1')
    expect(patch).toMatchObject({ credential_action: 'keep' })
    expect(patch).not.toHaveProperty('api_key')
  })

  it('warns but still saves when the provider has no model catalog', async () => {
    const wrapper = await mountEditor()
    apiMock.testProviderEditor.mockResolvedValueOnce({
      success: true,
      models: [],
      model_count: 0,
      catalog_unavailable: true,
    })

    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()

    expect(messageMock.warning).toHaveBeenCalledWith('No model catalog')
    expect(dialogMock.warning).not.toHaveBeenCalled()
    expect(storeMock.saveProviderEditor).toHaveBeenCalledOnce()
  })

  it('sends a replacement only after the user enters a new credential', async () => {
    const replacement = ['new', 'credential'].join('-')
    const wrapper = await mountEditor()
    await wrapper.find('input[type="password"]').setValue(replacement)
    await wrapper.findAll('button').find(button => button.text() === 'Save')!.trigger('click')
    await flushPromises()

    const patch = storeMock.saveProviderEditor.mock.calls[0][2]
    expect(patch).toMatchObject({ credential_action: 'replace', api_key: replacement })
  })

  it('uses a separate destructive action to clear a credential', async () => {
    const wrapper = await mountEditor()
    await wrapper.findAll('button').find(button => button.text() === 'Clear credentials')!.trigger('click')
    await flushPromises()

    expect(dialogMock.warning).toHaveBeenCalledOnce()
    expect(storeMock.saveProviderEditor).toHaveBeenCalledWith(
      'custom:example',
      'revision-1',
      { credential_action: 'clear' },
    )
  })

  it('disables draft testing when the server reports an unsupported API mode', async () => {
    const wrapper = await mountEditor({
      detail: detail({
        api_mode: 'bedrock_converse',
        connection_test_supported: false,
        connection_test_reason: 'Unsupported protocol',
      }),
    })
    const testButton = wrapper.findAll('button').find(button => button.text() === 'Test connection')!

    expect(testButton.attributes('disabled')).toBeDefined()
    expect(testButton.attributes('title')).toBe('Unsupported protocol')
  })
})
