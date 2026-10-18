// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useUsageStore } from '@/stores/hermes/usage'
import UsageOverviewInsights from '@/components/hermes/usage/UsageOverviewInsights.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('A usage overview insights', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('ranks by input plus output and keeps shares relative to all models', () => {
    const store = useUsageStore()
    store.stats = {
      total_input_tokens: 1000, total_output_tokens: 0, total_cache_read_tokens: 10_000,
      total_cache_write_tokens: 0, total_reasoning_tokens: 0, total_sessions: 6, total_cost: 0,
      model_usage: [600, 200, 100, 50, 30, 20].map((input, index) => ({
        model: `model-${index}`, input_tokens: input, output_tokens: 0,
        cache_read_tokens: index === 5 ? 10_000 : 0, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1,
      })), daily_usage: [],
    }
    const wrapper = mount(UsageOverviewInsights)
    expect(wrapper.findAll('.rank-name').map(row => row.text())).toEqual(['model-0', 'model-1', 'model-2', 'model-3', 'model-4'])
    expect(wrapper.findAll('.rank-share').map(row => row.text())).toEqual(['60.0%', '20.0%', '10.0%', '5.0%', '3.0%'])
    expect(wrapper.find('.rank-track i').attributes('style')).toContain('background:')
    expect(wrapper.find('.cache-ring').attributes('style')).toContain('#f6ad55')
    expect(wrapper.find('[data-dimension]').exists()).toBe(false)
  })

  it('shows an undefined hit rate when usage has output but no input or cache', () => {
    const store = useUsageStore()
    store.stats = { total_input_tokens: 0, total_output_tokens: 20, total_cache_read_tokens: 0,
      total_cache_write_tokens: 0, total_reasoning_tokens: 0, total_sessions: 1, total_cost: 0, model_usage: [], daily_usage: [] }
    const wrapper = mount(UsageOverviewInsights)
    expect(wrapper.find('.cache-ring strong').text()).toBe('—')
  })
})
