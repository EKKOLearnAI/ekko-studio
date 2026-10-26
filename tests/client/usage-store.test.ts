// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const usageApiMock = vi.hoisted(() => ({
  fetchUsageStats: vi.fn(),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchUsageStats: usageApiMock.fetchUsageStats,
}))

function emptyStats(totalSessions = 0, periodDays = 30) {
  return {
    total_input_tokens: totalSessions,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_reasoning_tokens: 0,
    total_cost: 0,
    total_sessions: totalSessions,
    period_days: periodDays,
    model_usage: [],
    agent_usage: [],
    daily_usage: [],
  }
}

describe('usage store analytics adapter', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    usageApiMock.fetchUsageStats.mockReset()
  })

  it('loads 30-day usage stats and derives chart metrics from the native-style payload', async () => {
    usageApiMock.fetchUsageStats.mockResolvedValue({
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cache_read_tokens: 25,
      total_cache_write_tokens: 5,
      total_reasoning_tokens: 10,
      total_cost: 0.0123,
      total_sessions: 2,
      period_days: 30,
      model_usage: [
        { model: 'gpt-5', input_tokens: 80, output_tokens: 40, cache_read_tokens: 20, cache_write_tokens: 3, reasoning_tokens: 7, sessions: 1 },
        { model: '', input_tokens: 20, output_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 2, reasoning_tokens: 3, sessions: 1 },
      ],
      agent_usage: [
        { agent: 'hermes', input_tokens: 90, output_tokens: 45, cache_read_tokens: 20, cache_write_tokens: 3, reasoning_tokens: 7, sessions: 1 },
        { agent: 'codex', input_tokens: 10, output_tokens: 5, cache_read_tokens: 5, cache_write_tokens: 2, reasoning_tokens: 3, sessions: 1 },
      ],
      daily_usage: [
        { date: '2026-04-29', input_tokens: 80, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 4, sessions: 1, errors: 0, cost: 0.01 },
        { date: '2026-04-30', input_tokens: 30, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 1, sessions: 1, errors: 0, cost: 0.0023 },
      ],
    })

    const { useUsageStore } = await import('@/stores/hermes/usage')
    const store = useUsageStore()
    await store.loadSessions()

    expect(usageApiMock.fetchUsageStats).toHaveBeenCalledWith(30)
    expect(store.totalTokens).toBe(150)
    expect(store.cacheHitRate).toBeCloseTo(25 / 125 * 100)
    expect(store.hasData).toBe(true)
    expect(store.modelUsage).toHaveLength(2)
    expect(store.modelUsage[0]).toMatchObject({
      model: 'gpt-5',
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      cacheTokens: 20,
      cacheWriteTokens: 3,
      visualTokens: 140,
      sessions: 1,
    })
    expect(store.modelUsage[0].color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(store.modelUsage[0].inputPercent).toBeCloseTo(80 / 140 * 100)
    expect(store.modelUsage[0].outputPercent).toBeCloseTo(40 / 140 * 100)
    expect(store.modelUsage[0].cachePercent).toBeCloseTo(20 / 140 * 100)
    expect(store.modelUsage[1]).toMatchObject({
      model: 'unknown',
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      cacheTokens: 5,
      cacheWriteTokens: 2,
      visualTokens: 35,
      sessions: 1,
    })
    expect(store.modelUsage[1].color).toBe(store.getModelColor('unknown'))
    expect(store.modelLegend.map(m => m.model)).toEqual(['gpt-5', 'unknown'])
    expect(store.agentUsage).toHaveLength(2)
    expect(store.agentUsage[0]).toMatchObject({
      agent: 'hermes',
      inputTokens: 90,
      outputTokens: 45,
      cacheTokens: 20,
      cacheWriteTokens: 3,
      totalTokens: 135,
      visualTokens: 155,
      sessions: 1,
    })
    expect(store.dailyUsage).toHaveLength(2)
    expect(store.dailyUsage[0]).toMatchObject({
      date: '2026-04-29',
      input_tokens: 80,
      output_tokens: 20,
      cache_read_tokens: 40,
      cache_write_tokens: 4,
      visualTokens: 140,
      sessions: 1,
      cost: 0.01,
    })
    expect(store.dailyUsage[0].inputPercent).toBeCloseTo(80 / 140 * 100)
    expect(store.dailyUsage[0].outputPercent).toBeCloseTo(20 / 140 * 100)
    expect(store.dailyUsage[0].cachePercent).toBeCloseTo(40 / 140 * 100)
  })

  it('allows callers to request a different period', async () => {
    usageApiMock.fetchUsageStats.mockResolvedValue(emptyStats())

    const { useUsageStore } = await import('@/stores/hermes/usage')
    const store = useUsageStore()
    await store.loadSessions(7)

    expect(usageApiMock.fetchUsageStats).toHaveBeenCalledWith(7)
    expect(store.hasData).toBe(false)
  })

  it('keeps loading true when an older overlapping request resolves first', async () => {
    let resolve30: (value: ReturnType<typeof emptyStats>) => void = () => {}
    let resolve7: (value: ReturnType<typeof emptyStats>) => void = () => {}
    usageApiMock.fetchUsageStats.mockImplementation((days: number) => new Promise(resolve => {
      if (days === 30) resolve30 = resolve
      if (days === 7) resolve7 = resolve
    }))

    const { useUsageStore } = await import('@/stores/hermes/usage')
    const store = useUsageStore()
    const firstLoad = store.loadSessions(30)
    const secondLoad = store.loadSessions(7)

    expect(store.isLoading).toBe(true)
    resolve30(emptyStats(30, 30))
    await firstLoad

    expect(store.isLoading).toBe(true)
    expect(store.stats).toBeNull()

    resolve7(emptyStats(7, 7))
    await secondLoad

    expect(store.isLoading).toBe(false)
    expect(store.stats?.period_days).toBe(7)
    expect(store.totalSessions).toBe(7)
  })

  it('ignores stale overlapping responses that resolve after the selected period', async () => {
    let resolve30: (value: ReturnType<typeof emptyStats>) => void = () => {}
    let resolve7: (value: ReturnType<typeof emptyStats>) => void = () => {}
    usageApiMock.fetchUsageStats.mockImplementation((days: number) => new Promise(resolve => {
      if (days === 30) resolve30 = resolve
      if (days === 7) resolve7 = resolve
    }))

    const { useUsageStore } = await import('@/stores/hermes/usage')
    const store = useUsageStore()
    const firstLoad = store.loadSessions(30)
    const secondLoad = store.loadSessions(7)

    resolve7(emptyStats(7, 7))
    await secondLoad

    expect(store.isLoading).toBe(false)
    expect(store.stats?.period_days).toBe(7)

    resolve30(emptyStats(30, 30))
    await firstLoad

    expect(store.stats?.period_days).toBe(7)
    expect(store.totalSessions).toBe(7)
  })

  it('forwards combined filters and clears stale statistics on a failed selection', async () => {
    usageApiMock.fetchUsageStats.mockResolvedValueOnce(emptyStats(5, 30))
    const { useUsageStore } = await import('@/stores/hermes/usage')
    const store = useUsageStore()
    await store.loadSessions(30)
    expect(store.totalSessions).toBe(5)
    usageApiMock.fetchUsageStats.mockRejectedValueOnce(new Error('offline'))
    await store.loadSessions(7, { model: 'gpt-5', agent: 'codex', account: 'unassigned' })
    expect(usageApiMock.fetchUsageStats).toHaveBeenLastCalledWith(7, { model: 'gpt-5', agent: 'codex', account: 'unassigned' })
    expect(store.stats).toBeNull()
    expect(store.loadError).toBe(true)
    expect(store.isLoading).toBe(false)
  })
})
