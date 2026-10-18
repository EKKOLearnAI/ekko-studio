// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { GatewayAutoStartConfig } from '@/api/hermes/config'

const mockSettingsStore = vi.hoisted(() => ({
  gatewayAutoStart: { enabled: true, include: ['default'], exclude: [] } as GatewayAutoStartConfig,
  saveSection: vi.fn().mockResolvedValue(undefined),
  fetchSettings: vi.fn().mockResolvedValue(undefined),
  updateLocal: vi.fn((section: string, values: Record<string, any>) => {
    if (section === 'gatewayAutoStart') {
      mockSettingsStore.gatewayAutoStart = { ...mockSettingsStore.gatewayAutoStart, ...values }
    }
  }),
}))

const mockProfilesStore = vi.hoisted(() => ({
  profiles: [{ name: 'default' }, { name: 'reviewer' }, { name: 'scratch' }],
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
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
    NSwitch: {
      props: ['value'],
      emits: ['update:value'],
      template: `<button class="gateway-enabled" :aria-checked="value" @click="$emit('update:value', !value)"></button>`,
    },
    NSelect: {
      props: {
        value: [String, Array],
        multiple: Boolean,
      },
      emits: ['update:value'],
      template: `
        <button
          :class="multiple ? 'gateway-profile-select' : 'gateway-mode'"
          @click="$emit('update:value', multiple ? ['default', 'reviewer', 'default'] : (value === 'include' ? 'all' : 'include'))"
        ></button>
      `,
    },
    useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  }
})

import GatewayAutoStartSettings from '@/components/hermes/settings/GatewayAutoStartSettings.vue'

describe('GatewayAutoStartSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.gatewayAutoStart = { enabled: true, include: ['default'], exclude: [] }
  })

  it('defaults the gateway switch to off and allows explicitly enabling it', async () => {
    mockSettingsStore.gatewayAutoStart = {}
    const wrapper = mount(GatewayAutoStartSettings)
    const toggle = wrapper.get('.gateway-enabled')

    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('gatewayAutoStart', { enabled: true }, { restart: false })
    wrapper.unmount()
  })

  it('saves gateway auto-start enabled and include-list settings through app config section', async () => {
    const wrapper = mount(GatewayAutoStartSettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><span class="setting-row-label">{{ label }}</span><slot /></div>',
          },
        },
      },
    })

    expect(wrapper.text()).toContain('settings.gatewayAutoStart.title')

    await wrapper.find('.gateway-enabled').trigger('click')
    await Promise.resolve()
    expect(mockSettingsStore.updateLocal).toHaveBeenCalledWith('gatewayAutoStart', { enabled: false })
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('gatewayAutoStart', { enabled: false }, { restart: false })

    const profileSelects = wrapper.findAll('.gateway-profile-select')
    expect(profileSelects.length).toBe(1)
    await profileSelects[0].trigger('click')
    await Promise.resolve()
    expect(mockSettingsStore.saveSection).toHaveBeenLastCalledWith(
      'gatewayAutoStart',
      { include: ['default', 'reviewer'], exclude: null },
      { restart: false },
    )

    await wrapper.find('.gateway-mode').trigger('click')
    await Promise.resolve()
    expect(mockSettingsStore.saveSection).toHaveBeenLastCalledWith(
      'gatewayAutoStart',
      { include: null },
      { restart: false },
    )
  })
})
