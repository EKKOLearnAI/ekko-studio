// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { MAX_CHAT_INPUT_HEIGHT, MIN_CHAT_INPUT_HEIGHT } from '@/utils/chat-input-height'

const mockSettingsStore = vi.hoisted(() => ({
  display: {
    streaming: true,
    compact: false,
    show_reasoning: true,
    show_cost: false,
    inline_diffs: true,
    chat_input_height: 160,
    bell_on_complete: false,
    approval_bell: false,
    notify_on_approval: false,
    notify_on_complete: false,
    busy_input_mode: 'interrupt',
  },
  saveSection: vi.fn(),
}))

const notificationMock = vi.hoisted(() => ({
  requestCompletionNotificationPermission: vi.fn(async () => ({ granted: true })),
  showSystemNotification: vi.fn(async () => true),
  showCompletionNotification: vi.fn(async () => true),
}))

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => notificationMock)

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    brightness: 'system',
    setBrightness: vi.fn(),
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    NInputNumber: defineComponent({
      props: {
        value: { type: Number, required: false, default: null },
        min: { type: Number, required: false, default: 0 },
        max: { type: Number, required: false, default: 1000 },
      },
      emits: ['update:value'],
      setup(props, { emit }) {
        return () => h('input', {
          class: 'n-input-number',
          type: 'number',
          value: props.value ?? '',
          onInput: (event: Event) => {
            const value = (event.target as HTMLInputElement).value
            emit('update:value', value === '' ? null : Number(value))
          },
        })
      },
    }),
    NSelect: defineComponent({
      inheritAttrs: false,
      props: ['value', 'options'],
      emits: ['update:value'],
      setup(props, { attrs, emit }) {
        return () => h('select', {
          ...attrs,
          value: props.value,
          onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
        }, (props.options as Array<{ label: string; value: string }>).map(option => (
          h('option', { value: option.value }, option.label)
        )))
      },
    }),
    NButton: defineComponent({
      emits: ['click'],
      setup(_props, { emit, slots }) {
        return () => h('button', { type: 'button', onClick: () => emit('click') }, slots.default?.())
      },
    }),
    useMessage: () => messageMock,
  }
})

import DisplaySettings from '@/components/hermes/settings/DisplaySettings.vue'

function mountDesktopDisplaySettings() {
  ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true }
  return mount(DisplaySettings, {
    global: {
      stubs: {
        SettingRow: {
          props: ['label', 'hint'],
          template: '<div class="setting-row"><div>{{ label }}</div><div>{{ hint }}</div><slot /></div>',
        },
        NSwitch: true,
      },
    },
  })
}

describe('DisplaySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
    mockSettingsStore.display.chat_input_height = 160
    mockSettingsStore.display.notify_on_approval = false
    mockSettingsStore.saveSection.mockResolvedValue(undefined)
    notificationMock.requestCompletionNotificationPermission.mockResolvedValue({ granted: true })
    notificationMock.showSystemNotification.mockResolvedValue(true)
  })

  it('exposes and saves an approval sound toggle separately from completion sound', async () => {
    const wrapper = mount(DisplaySettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div>{{ label }}</div><div>{{ hint }}</div><slot /></div>',
          },
          NSwitch: defineComponent({
            props: ['value'], emits: ['update:value'],
            template: '<button class="setting-switch" @click="$emit(\'update:value\', !value)"><slot /></button>',
          }),
        },
      },
    })

    expect(wrapper.text()).toContain('settings.display.approvalBell')
    const approvalRow = wrapper.findAll('.setting-row').find(row => row.text().includes('settings.display.approvalBell'))
    expect(approvalRow).toBeTruthy()
    await approvalRow!.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { approval_bell: true })
    expect(mockSettingsStore.saveSection).not.toHaveBeenCalledWith('display', expect.objectContaining({ bell_on_complete: true }))
  })

  it('requests permission before enabling approval notifications and does not save on denial', async () => {
    notificationMock.requestCompletionNotificationPermission.mockResolvedValueOnce({ granted: false, reason: 'denied' })
    const wrapper = mount(DisplaySettings, {
      global: { stubs: {
        SettingRow: { props: ['label', 'hint'], template: '<div class="setting-row"><div>{{ label }}</div><div>{{ hint }}</div><slot /></div>' },
        NSwitch: defineComponent({ props: ['value'], emits: ['update:value'], template: '<button role="switch" @click="$emit(\'update:value\', !value)" />' }),
      } },
    })
    const row = wrapper.findAll('.setting-row').find(item => item.text().includes('settings.display.notifyOnApproval'))
    expect(row).toBeTruthy()
    await row!.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(notificationMock.requestCompletionNotificationPermission).toHaveBeenCalledTimes(1)
    expect(mockSettingsStore.saveSection).not.toHaveBeenCalledWith('display', expect.objectContaining({ notify_on_approval: true }))
  })

  it('saves approval notification independently and exposes a test button', async () => {
    const wrapper = mount(DisplaySettings, {
      global: { stubs: {
        SettingRow: { props: ['label', 'hint'], template: '<div class="setting-row"><div>{{ label }}</div><div>{{ hint }}</div><slot /></div>' },
        NSwitch: defineComponent({ props: ['value'], emits: ['update:value'], template: '<button role="switch" @click="$emit(\'update:value\', !value)" />' }),
      } },
    })
    const row = wrapper.findAll('.setting-row').find(item => item.text().includes('settings.display.notifyOnApproval'))
    await row!.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { notify_on_approval: true })
    expect(mockSettingsStore.saveSection).not.toHaveBeenCalledWith('display', expect.objectContaining({ notify_on_complete: true }))

    const testButton = row!.findAll('button').find(button => button.text() === 'settings.display.notifyOnApprovalTestButton')
    expect(testButton).toBeTruthy()
    notificationMock.showSystemNotification.mockClear()
    await testButton!.trigger('click')
    await flushPromises()
    expect(notificationMock.showSystemNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Hermes',
      body: 'settings.display.notifyOnApprovalTest',
    }), { requireBackground: false, deduplicate: false })
  })

  it('does not enable approval notifications when the initial delivery check fails', async () => {
    notificationMock.showSystemNotification.mockResolvedValueOnce(false)
    const wrapper = mount(DisplaySettings, {
      global: { stubs: {
        SettingRow: { props: ['label', 'hint'], template: '<div class="setting-row"><div>{{ label }}</div><div>{{ hint }}</div><slot /></div>' },
        NSwitch: defineComponent({ props: ['value'], emits: ['update:value'], template: '<button role="switch" @click="$emit(\'update:value\', !value)" />' }),
      } },
    })
    const row = wrapper.findAll('.setting-row').find(item => item.text().includes('settings.display.notifyOnApproval'))
    await row!.get('[role="switch"]').trigger('click')
    await flushPromises()

    expect(notificationMock.showSystemNotification).toHaveBeenCalledTimes(1)
    expect(mockSettingsStore.saveSection).not.toHaveBeenCalledWith('display', { notify_on_approval: true })
  })

  it('exposes the busy input mode now that sending honours it', () => {
    const wrapper = mount(DisplaySettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><div class="setting-row-hint">{{ hint }}</div><slot /></div>',
          },
          NSelect: true,
          NSwitch: true,
        },
      },
    })

    // This row was deliberately kept out while display.busy_input_mode was
    // carried in the config type but never read; sending now honours it.
    expect(wrapper.text()).toContain('settings.display.busyInputMode')
    expect(wrapper.text()).toContain('settings.display.busyInputModeHint')
  })

  it('saves the chosen busy input mode', async () => {
    const wrapper = mount(DisplaySettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><div class="setting-row-hint">{{ hint }}</div><slot /></div>',
          },
          NSwitch: true,
        },
      },
    })

    await wrapper.findAll('select')[0].setValue('steer')
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { busy_input_mode: 'steer' })
  })

  it('shows and persists the desktop link-opening target', async () => {
    const wrapper = mountDesktopDisplaySettings()

    expect(wrapper.text()).toContain('settings.display.linkOpenTarget')
    expect(wrapper.text()).toContain('settings.display.linkOpenTargetHint')
    const select = wrapper.get('[data-testid="link-open-target-select"]')
    expect((select.element as HTMLSelectElement).value).toBe('hermes-studio')

    await select.setValue('default-browser')

    expect(window.localStorage.getItem('hermes_link_open_target')).toBe('default-browser')
  })

  it('keeps the previous link-opening target when local storage is unavailable', async () => {
    const originalStorage = window.localStorage
    const blockedStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('storage blocked')
      }),
    }
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: blockedStorage,
    })
    const wrapper = mountDesktopDisplaySettings()
    const select = wrapper.get('[data-testid="link-open-target-select"]')

    try {
      await select.setValue('default-browser')

      expect(window.localStorage.getItem('hermes_link_open_target')).toBeNull()
      expect(messageMock.success).not.toHaveBeenCalled()
      expect(messageMock.error).toHaveBeenCalledWith('settings.saveFailed')
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalStorage,
      })
    }
  })

  it('saves a clamped chat input height and can reset back to automatic height', async () => {
    const wrapper = mount(DisplaySettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><div class="setting-row-hint">{{ hint }}</div><slot /></div>',
          },
          NSelect: true,
          NSwitch: true,
        },
      },
    })

    expect(wrapper.text()).toContain('settings.display.chatInputHeight')

    const input = wrapper.get('.n-input-number')
    await input.setValue(String(MAX_CHAT_INPUT_HEIGHT + 100))
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { chat_input_height: MAX_CHAT_INPUT_HEIGHT })

    await input.setValue(String(MIN_CHAT_INPUT_HEIGHT - 100))
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { chat_input_height: MIN_CHAT_INPUT_HEIGHT })

    const resetButton = wrapper.findAll('button').find(button => button.text() === 'common.reset')
    expect(resetButton).toBeTruthy()
    await resetButton!.trigger('click')
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { chat_input_height: null })
  })
})
