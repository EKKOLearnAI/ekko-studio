// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockUsageStore = vi.hoisted(() => ({
  isLoading: false,
  hasData: true,
  stats: { filter_options: { accounts: [{ id: '1', username: 'ekko' }, { id: '2', username: 'alice' }] } },
  loadSessions: vi.fn(),
}))

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [{ name: 'default' }, { name: 'research' }],
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
    t: (key: string, params?: { days: number }) => key === 'usage.dashboard.periodLabel' ? `${params?.days}d` : key === 'usage.dashboard.today' ? 'Today' : key,
  }),
}))

vi.mock('naive-ui', () => ({
  NSelect: defineComponent({
    props: ['value', 'options'], emits: ['update:value'],
    template: '<select :value="value" @change="$emit(\'update:value\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
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

vi.mock('@/components/hermes/usage/UsageOverviewInsights.vue', () => ({
  default: defineComponent({ name: 'UsageOverviewInsights', template: '<section />' }),
}))

import UsageView from '@/views/hermes/UsageView.vue'

describe('UsageView period selector', () => {
  beforeEach(() => {
    mockUsageStore.isLoading = false
    mockUsageStore.hasData = true
    mockUsageStore.loadSessions.mockReset()
    mockProfilesStore.activeProfileName = 'default'
    mockProfilesStore.profiles = [{ name: 'default' }, { name: 'research' }]
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
    expect(periodButtons.map(button => button.text())).toEqual(['Today', '7d', '30d', '90d', '365d'])
    expect(wrapper.find('.period-selector').attributes('role')).toBe('group')

    await periodButtons[0].trigger('click')
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1)
    expect(periodButtons[0].attributes('data-type')).toBe('primary')
    expect(periodButtons[0].attributes('aria-pressed')).toBe('true')

    await wrapper.find('.refresh-button').trigger('click')
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1)
    expect(wrapper.find('.overview-heading').text()).toContain('usage.dashboard.todaySummary')
  })

  it('preserves account filters across periods and refresh, and clears them', async () => {
    const wrapper = mount(UsageView)
    await flushPromises()
    await wrapper.find('.account-filter').setValue('unassigned')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(30, { account: 'unassigned' })
    await wrapper.findAll('.period-option')[0].trigger('click')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { account: 'unassigned' })
    await wrapper.find('.refresh-button').trigger('click')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { account: 'unassigned' })
    await wrapper.find('.account-filter').setValue('')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1)
  })

  it('places period, account, Profile and pricing below the header', async () => {
    const wrapper = mount(UsageView)
    await flushPromises()
    expect(wrapper.find('.page-header .period-selector').exists()).toBe(false)
    const controls = wrapper.find('.overview-controls')
    expect(controls.element.children[0].classList.contains('period-selector')).toBe(true)
    expect(controls.element.children[1].classList.contains('account-filter')).toBe(true)
    expect(controls.element.children[2].classList.contains('profile-filter')).toBe(true)
    expect(controls.element.children.length).toBe(4)
    expect(wrapper.find('.model-filter').exists()).toBe(false)
    expect(wrapper.find('.agent-filter').exists()).toBe(false)
  })

  it('defaults to all Profiles and preserves the Profile/account intersection through period changes and refresh', async () => {
    const wrapper = mount(UsageView)
    await flushPromises()
    expect((wrapper.find('.profile-filter').element as HTMLSelectElement).value).toBe('')
    expect(wrapper.find('.overview-heading').text()).toContain('usage.dashboard.allProfiles')
    await wrapper.find('.profile-filter').setValue('research')
    await wrapper.find('.account-filter').setValue('unassigned')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(30, { profile: 'research', account: 'unassigned' })
    await wrapper.findAll('.period-option')[0].trigger('click')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { profile: 'research', account: 'unassigned' })
    await wrapper.find('.refresh-button').trigger('click')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { profile: 'research', account: 'unassigned' })
    expect(mockProfilesStore.activeProfileName).toBe('default')
    await wrapper.find('.profile-filter').setValue('')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { account: 'unassigned', profile: undefined })
    await wrapper.find('.account-filter').setValue('')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1)
  })

  it('shows actual Studio accounts and preserves the selected user through Profile, period and refresh', async () => {
    const wrapper = mount(UsageView)
    await flushPromises()
    expect(wrapper.find('.account-filter').text()).toContain('ekko · #1')
    expect(wrapper.find('.account-filter').text()).toContain('alice · #2')
    await wrapper.find('.account-filter').setValue('1')
    await wrapper.find('.profile-filter').setValue('research')
    await wrapper.findAll('.period-option')[0].trigger('click')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { account: '1', profile: 'research' })
    await wrapper.find('.refresh-button').trigger('click')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { account: '1', profile: 'research' })
    await wrapper.find('.account-filter').setValue('')
    await flushPromises()
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(1, { account: undefined, profile: 'research' })
  })
})
