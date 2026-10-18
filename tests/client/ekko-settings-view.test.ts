// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const fetchEkkoSettingsMock = vi.hoisted(() => vi.fn())
const saveEkkoSettingsMock = vi.hoisted(() => vi.fn())
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const replaceMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/ekko/config', () => ({
  fetchEkkoSettings: fetchEkkoSettingsMock,
  saveEkkoSettings: saveEkkoSettingsMock,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: replaceMock }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NAlert: defineComponent({ emits: ['close'], template: '<div><slot /></div>' }),
  NCheckbox: defineComponent({ props: ['value'], template: '<label><slot /></label>' }),
  NCheckboxGroup: defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<div><slot /></div>',
  }),
  NDynamicTags: defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<div />',
  }),
  NInput: defineComponent({ props: ['value'], template: '<input :value="value" />' }),
  NInputNumber: defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<button class="n-input-number-stub" @click="$emit(\'update:value\', Number(value) + 1)">{{ value }}</button>',
  }),
  NSelect: defineComponent({
    props: ['value', 'options'],
    emits: ['update:value'],
    template: '<div />',
  }),
  NSpin: defineComponent({ template: '<div><slot /></div>' }),
  NSwitch: defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<button class="n-switch-stub" @click="$emit(\'update:value\', !value)">{{ value }}</button>',
  }),
  NTabPane: defineComponent({ props: ['name', 'tab'], template: '<section><slot /></section>' }),
  NTabs: defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<div><slot /></div>',
  }),
  useMessage: () => messageMock,
}))

import SettingsView from '@/views/ekko/SettingsView.vue'

const config = {
  runtime: {
    maxSteps: 80,
    maxModelRetries: 2,
    toolFailureRecoveryThreshold: 3,
    maxConsecutiveToolFailures: 6,
  },
  model: {
    defaultProvider: '',
    defaultModel: '',
    requestTimeoutMs: 120_000,
    temperature: null,
    maxTokens: null,
    reasoningEffort: 'medium',
    reasoningSummary: 'auto',
    authorizationRefreshLeewayMs: 60_000,
  },
  tools: {
    enabled: true,
    executionTimeoutMs: 120_000,
    computerUse: { enabled: true, timeoutMs: 30_000 },
    approvals: { enabled: true, timeoutMs: 30_000, permanentAllow: [] },
    codeExec: {
      enabled: true,
      languages: ['node'],
      timeoutMs: 120_000,
      maxToolCalls: 12,
      maxOutputBytes: 1_000_000,
      maxStderrBytes: 100_000,
      maxSourceBytes: 100_000,
    },
  },
  mcp: { enabled: true },
  delegation: { backgroundEnabled: false, subtaskMaxSteps: 40 },
  compression: {
    enabled: true,
    threshold: 0.5,
    targetRatio: 0.2,
    protectLastN: 20,
    protectFirstN: 3,
  },
  memory: {
    enabled: true,
    recentMessageLimit: 24,
    automaticRecallTokenBudget: 2_000,
    searchResultLimit: 8,
  },
  skills: { enabled: true, reviewEveryToolCalls: 6 },
  logging: { maxBytes: 10_000_000 },
  prompt: { instructions: [] },
} as const

let wrapper: VueWrapper | undefined

describe('Ekko settings auto-save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    const snapshot = {
      schemaVersion: 1,
      configPath: '/tmp/ekko.json',
      config: structuredClone(config),
      providers: [],
    }
    fetchEkkoSettingsMock.mockResolvedValue(snapshot)
    saveEkkoSettingsMock.mockImplementation(async savedConfig => ({
      ...snapshot,
      config: structuredClone(savedConfig),
    }))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  it('debounces numeric changes and saves the updated value', async () => {
    wrapper = mount(SettingsView)
    await flushPromises()

    await wrapper.find('.n-input-number-stub').trigger('click')
    expect(saveEkkoSettingsMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(saveEkkoSettingsMock).toHaveBeenCalledTimes(1)
    expect(saveEkkoSettingsMock.mock.calls[0][0].runtime.maxSteps).toBe(81)
  })

  it('saves switch changes immediately with the updated value', async () => {
    wrapper = mount(SettingsView)
    await flushPromises()

    await wrapper.find('.n-switch-stub').trigger('click')
    await flushPromises()

    expect(saveEkkoSettingsMock).toHaveBeenCalledTimes(1)
    expect(saveEkkoSettingsMock.mock.calls[0][0].delegation.backgroundEnabled).toBe(true)
  })

  it('saves the Computer Use switch while preserving the timeout setting', async () => {
    wrapper = mount(SettingsView)
    await flushPromises()
    await wrapper.get('[data-testid="computer-use-enabled"]').trigger('click')
    await flushPromises()
    expect(saveEkkoSettingsMock.mock.calls[0][0].tools.computerUse).toEqual({ enabled: false, timeoutMs: 30_000 })
  })
})
