// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockUsageStore = vi.hoisted(() => ({
  isLoading: false,
  hasData: true,
  loadSessions: vi.fn(),
}))

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [{ name: 'default' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/stores/hermes/usage', () => ({
  useUsageStore: () => mockUsageStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NSpin: { template: '<div><slot /><slot name="icon" /></div>' },
  NButton: defineComponent({
    name: 'NButton',
    props: {
      loading: Boolean,
      type: String,
      secondary: Boolean,
      quaternary: Boolean,
      size: String,
      ariaPressed: [Boolean, String],
    },
    emits: ['click'],
    template: '<button class="n-button-stub" :data-type="type" :aria-pressed="ariaPressed" @click="$emit(\'click\')"><slot /></button>',
  }),
}))

vi.mock('@/components/hermes/usage/StatCards.vue', () => ({
  default: defineComponent({ name: 'StatCards', template: '<section class="stat-cards-stub" />' }),
}))

vi.mock('@/components/hermes/usage/ModelBreakdown.vue', () => ({
  default: defineComponent({ name: 'ModelBreakdown', template: '<section class="model-breakdown-stub" />' }),
}))

vi.mock('@/components/hermes/usage/AgentBreakdown.vue', () => ({
  default: defineComponent({ name: 'AgentBreakdown', template: '<section class="agent-breakdown-stub" />' }),
}))

vi.mock('@/components/hermes/usage/DailyTrend.vue', () => ({
  default: defineComponent({ name: 'DailyTrend', template: '<section class="daily-trend-stub" />' }),
}))

vi.mock('@/components/hermes/usage/UsagePricing.vue', () => ({
  default: defineComponent({ name: 'UsagePricing', template: '<span />' }),
}))

import UsageView from '@/views/hermes/UsageView.vue'

describe('UsageView period selector', () => {
  beforeEach(() => {
    mockUsageStore.isLoading = false
    mockUsageStore.hasData = true
    mockUsageStore.loadSessions.mockReset()
    mockProfilesStore.activeProfileName = 'default'
    mockProfilesStore.profiles = [{ name: 'default' }]
    mockProfilesStore.fetchProfiles.mockReset()
  })

  it('loads the default 30-day period on mount', async () => {
    mount(UsageView)
    await flushPromises()

    expect(mockUsageStore.loadSessions).toHaveBeenCalledWith(30)
  })

  it('lets users switch usage statistics between common dashboard periods', async () => {
    const wrapper = mount(UsageView)

    const periodButtons = wrapper.findAll('.period-option')
    expect(periodButtons.map(button => button.text())).toEqual(['7d', '30d', '90d', '365d'])
    expect(wrapper.find('.period-selector').attributes('role')).toBe('group')

    await periodButtons[0].trigger('click')
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(7)
    expect(periodButtons[0].attributes('data-type')).toBe('primary')
    expect(periodButtons[0].attributes('aria-pressed')).toBe('true')

    await wrapper.find('.refresh-button').trigger('click')
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(7)
  })
})
