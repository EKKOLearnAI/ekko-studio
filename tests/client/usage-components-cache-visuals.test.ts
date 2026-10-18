// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockUsageStore = vi.hoisted(() => ({
  dailyUsage: [
    {
      date: '2026-05-12',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 75,
      cache_write_tokens: 10,
      sessions: 2,
      errors: 0,
      cost: 0.02,
      visualTokens: 225,
      inputPercent: 44.444,
      outputPercent: 22.222,
      cachePercent: 33.333,
    },
  ],
  modelUsage: [
    {
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheTokens: 75,
      cacheWriteTokens: 10,
      totalTokens: 150,
      visualTokens: 225,
      sessions: 2,
      color: '#4fd1c5',
      inputPercent: 44.444,
      outputPercent: 22.222,
      cachePercent: 33.333,
    },
  ],
  agentUsage: [
    {
      agent: 'hermes',
      inputTokens: 100,
      outputTokens: 50,
      cacheTokens: 75,
      cacheWriteTokens: 10,
      totalTokens: 150,
      visualTokens: 225,
      sessions: 2,
      color: '#63b3ed',
      inputPercent: 44.444,
      outputPercent: 22.222,
      cachePercent: 33.333,
    },
  ],
}))

vi.mock('@/stores/hermes/usage', () => ({
  useUsageStore: () => mockUsageStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

import DailyTrend from '@/components/hermes/usage/DailyTrend.vue'
import ModelBreakdown from '@/components/hermes/usage/ModelBreakdown.vue'
import AgentBreakdown from '@/components/hermes/usage/AgentBreakdown.vue'

describe('usage cache visualizations', () => {
  it('separates cache reads from input/output and switches trend metrics', async () => {
    const wrapper = mount(DailyTrend)
    expect(wrapper.find('.bar-segment.cache').exists()).toBe(false)
    expect(wrapper.find('.bar-segment.input').attributes('style')).toContain('66.666')
    await wrapper.find('[data-metric="cache"]').trigger('click')
    const cacheSegment = wrapper.find('.bar-segment.cache')
    expect(cacheSegment.exists()).toBe(true)
    expect(cacheSegment.attributes('style')).toContain('height: 100%')
    expect(wrapper.find('.bar-segment.input').exists()).toBe(false)
    expect(wrapper.text()).toContain('usage.cacheRead')
    await wrapper.find('[data-metric="cost"]').trigger('click')
    expect(wrapper.find('.bar-segment.cost').exists()).toBe(true)
  })

  it('renders model breakdown as input/output/cache stacked segments', () => {
    const wrapper = mount(ModelBreakdown)

    expect(wrapper.find('.model-swatch').attributes('style')).toContain('background: rgb(79, 209, 197)')
    expect(wrapper.find('.model-bar-segment.input').exists()).toBe(true)
    expect(wrapper.find('.model-bar-segment.output').exists()).toBe(true)
    const cacheSegment = wrapper.find('.model-bar-segment.cache')
    expect(cacheSegment.exists()).toBe(true)
    expect(cacheSegment.attributes('style')).toContain('width: 33.333%')
  })

  it('renders agent breakdown as input/output/cache stacked segments', () => {
    const wrapper = mount(AgentBreakdown)

    expect(wrapper.text()).toContain('usage.agents.hermes')
    expect(wrapper.find('.agent-swatch').attributes('style')).toContain('background: rgb(99, 179, 237)')
    expect(wrapper.find('.agent-bar-segment.input').exists()).toBe(true)
    expect(wrapper.find('.agent-bar-segment.output').exists()).toBe(true)
    expect(wrapper.find('.agent-bar-segment.cache').attributes('style')).toContain('width: 33.333%')
  })
})
