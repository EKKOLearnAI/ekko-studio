import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the db index module so we can test usage-store in isolation
const { mockEnsureTable, mockJsonSet, mockJsonGet, mockJsonGetAll, mockJsonDelete } = vi.hoisted(() => ({
  mockEnsureTable: vi.fn(),
  mockJsonSet: vi.fn(),
  mockJsonGet: vi.fn(),
  mockJsonGetAll: vi.fn(),
  mockJsonDelete: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  isSqliteAvailable: () => false, // Force JSON fallback path
  ensureTable: mockEnsureTable,
  getDb: () => null,
  jsonSet: mockJsonSet,
  jsonGet: mockJsonGet,
  jsonGetAll: mockJsonGetAll,
  jsonDelete: mockJsonDelete,
}))

import {
  updateUsage,
  fillMissingUsageCost,
  getUsage,
  getUsageBatch,
  deleteUsage,
  getRecordedUsageSessionIds,
} from '../../packages/server/src/modules/studio/repositories/usage-store'

describe('Usage Store (JSON fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updateUsage writes via jsonSet', () => {
    updateUsage('session-1', { inputTokens: 100, outputTokens: 50 })
    expect(mockJsonSet).toHaveBeenCalledWith(
      'session_usage',
      'session-1',
      expect.objectContaining({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        model: '',
        profile: 'default',
        created_at: expect.any(Number),
      }),
    )
  })

  it('getUsage reads via jsonGet', () => {
    mockJsonGet.mockReturnValue({ input_tokens: 200, output_tokens: 80 })
    const result = getUsage('session-1')
    expect(result).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      model: '',
      profile: 'default',
      created_at: 0,
    })
    expect(mockJsonGet).toHaveBeenCalledWith('session_usage', 'session-1')
  })

  it('fills JSON costs only for the same unpriced row, preserving newer usage and known zero costs', () => {
    const ref = updateUsage('session-1', { inputTokens: 100, outputTokens: 50 })!
    const saved = mockJsonSet.mock.calls[0][2]
    mockJsonGet.mockReturnValue(saved)
    const cost = { costUsd: 0.25, costSource: 'estimated' as const }
    fillMissingUsageCost(ref, cost)
    expect(mockJsonSet).toHaveBeenLastCalledWith('session_usage', 'session-1', { ...saved, cost_usd: 0.25, cost_source: 'estimated', cost_pricing: null })
    mockJsonSet.mockClear()
    for (const newer of [undefined, { ...saved, id: 'another-row' }, { ...saved, cost_usd: 0 }]) {
      mockJsonGet.mockReturnValue(newer)
      fillMissingUsageCost(ref, cost)
    }
    expect(mockJsonSet).not.toHaveBeenCalled()
  })

  it('getUsage returns undefined when jsonGet returns nothing', () => {
    mockJsonGet.mockReturnValue(undefined)
    const result = getUsage('nonexistent')
    expect(result).toBeUndefined()
  })

  it('filters native command metadata by the requested usage source', () => {
    mockJsonGet.mockReturnValue({ source: 'hermes', input_tokens: 200, output_tokens: 80, model: 'hermes-model' })
    expect(getUsage('session-1', 'coding_agent')).toBeUndefined()
    mockJsonGet.mockReturnValue({ source: 'coding_agent', input_tokens: 0, output_tokens: 0, model: 'native-model' })
    expect(getUsage('session-1', 'coding_agent')).toMatchObject({ input_tokens: 0, output_tokens: 0, model: 'native-model' })
  })

  it('getUsageBatch returns empty map for empty input', () => {
    const result = getUsageBatch([])
    expect(result).toEqual({})
    expect(mockJsonGetAll).not.toHaveBeenCalled()
  })

  it('getUsageBatch returns matching records', () => {
    mockJsonGetAll.mockReturnValue({
      'session-1': { input_tokens: 100, output_tokens: 50 },
      'session-2': { input_tokens: 200, output_tokens: 80 },
      'session-3': { input_tokens: 300, output_tokens: 120 },
    })
    const result = getUsageBatch(['session-1', 'session-3', 'session-missing'])
    expect(result).toEqual({
      'session-1': {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        model: '',
        profile: 'default',
        created_at: 0,
      },
      'session-3': {
        input_tokens: 300,
        output_tokens: 120,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        model: '',
        profile: 'default',
        created_at: 0,
      },
    })
  })

  it('deleteUsage calls jsonDelete', () => {
    deleteUsage('session-1')
    expect(mockJsonDelete).toHaveBeenCalledWith('session_usage', 'session-1')
  })

  it('lists JSON usage session ids for the requested profile', () => {
    mockJsonGetAll.mockReturnValue({
      'default-1': { profile: 'default' },
      'default-legacy': {},
      'research-1': { profile: 'research' },
    })
    expect(getRecordedUsageSessionIds('default')).toEqual(['default-1', 'default-legacy'])
    expect(getRecordedUsageSessionIds('research')).toEqual(['research-1'])
  })
})

// Test with SQLite available (mocked)
describe('Usage Store (SQLite path)', () => {
  let runMock: ReturnType<typeof vi.fn>
  let getMock: ReturnType<typeof vi.fn>
  let allMock: ReturnType<typeof vi.fn>
  let deleteMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    runMock = vi.fn()
    getMock = vi.fn()
    allMock = vi.fn()
    deleteMock = vi.fn()

    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      isSqliteAvailable: () => true,
      ensureTable: vi.fn(),
      getDb: () => ({
        prepare: vi.fn((sql: string) => {
          if (sql.includes('INSERT') || sql.includes('UPDATE')) return { run: runMock }
          if (sql.includes('SELECT') && sql.includes('WHERE session_id = ?')) return { get: getMock }
          if (sql.includes('SELECT') && sql.includes(' IN (')) return { all: allMock }
          if (sql.includes('DELETE')) return { run: deleteMock }
          return { run: runMock, get: getMock, all: allMock }
        }),
      }),
      jsonSet: vi.fn(),
      jsonGet: vi.fn(),
      jsonGetAll: vi.fn(),
      jsonDelete: vi.fn(),
    }))
  })

  it('updateUsage inserts a usage record with normalized metadata defaults', async () => {
    const { updateUsage } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    updateUsage('s1', { inputTokens: 500, outputTokens: 200 })
    expect(runMock).toHaveBeenCalledWith(
      's1',
      '', // runId
      '', // parentRunId
      null, // apiDuration
      '', // source
      '', // agent
      'run', // usageScope
      '', // purpose
      0, // apiCalls
      500,
      200,
      0, // cacheReadTokens
      0, // cacheWriteTokens
      0, // reasoningTokens
      '', // model
      '', // provider
      'default', // profile
      0, // isEstimated
      expect.any(Number), // created_at
      null, // costUsd
      'unknown', // costSource
      null, // costPricing
    )
  })

  it('updateUsage writes updated_at when a legacy SQLite table has the column', async () => {
    allMock.mockReturnValueOnce([
      { name: 'id' },
      { name: 'session_id' },
      { name: 'created_at' },
      { name: 'updated_at' },
    ])
    const { updateUsage } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    updateUsage('s1', { inputTokens: 500, outputTokens: 200 })
    expect(runMock).toHaveBeenCalledWith(
      's1',
      '', // runId
      '', // parentRunId
      null, // apiDuration
      '', // source
      '', // agent
      'run', // usageScope
      '', // purpose
      0, // apiCalls
      500,
      200,
      0, // cacheReadTokens
      0, // cacheWriteTokens
      0, // reasoningTokens
      '', // model
      '', // provider
      'default', // profile
      0, // isEstimated
      expect.any(Number), // created_at
      null, // costUsd
      'unknown', // costSource
      null, // costPricing
      expect.any(Number), // updated_at
    )
  })

  it('getUsage queries by session_id', async () => {
    getMock.mockReturnValue({
      input_tokens: 999,
      output_tokens: 111,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      model: '',
      profile: 'default',
      created_at: 0,
    })
    const { getUsage } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    const result = getUsage('s1')
    expect(getMock).toHaveBeenCalledWith('s1')
    expect(result).toEqual({
      input_tokens: 999,
      output_tokens: 111,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      model: '',
      profile: 'default',
      created_at: 0,
    })
  })

  it('getUsageBatch queries with IN clause', async () => {
    allMock.mockReturnValue([
      { session_id: 'a', input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
      { session_id: 'b', input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
    ])
    const { getUsageBatch } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    const result = getUsageBatch(['a', 'b', 'c'])
    expect(allMock).toHaveBeenCalledWith('a', 'b', 'c')
    expect(result).toEqual({
      a: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
      b: { input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model: '', profile: 'default', created_at: 0 },
    })
  })

  it('deleteUsage runs DELETE query', async () => {
    const { deleteUsage } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    deleteUsage('s1')
    expect(deleteMock).toHaveBeenCalledWith('s1')
  })

  it('aggregates local ledger usage and lists recorded session ids', async () => {
    getMock.mockReturnValue({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 30,
      cache_write_tokens: 5,
      reasoning_tokens: 8,
      total_api_calls: 3,
      sessions: 2,
    })
    allMock
      .mockReturnValueOnce([
        { model: 'gpt-test', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 5, reasoning_tokens: 8, sessions: 2 },
      ])
      .mockReturnValueOnce([
        { agent: 'coding_agent', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 5, reasoning_tokens: 8, sessions: 2 },
      ])
      .mockReturnValueOnce([
        { date: '2026-07-11', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 5, sessions: 2 },
      ])
      .mockReturnValueOnce([
        { session_id: 'session-1' },
        { session_id: 'session-2' },
      ])

    const { getLocalUsageStats, getRecordedUsageSessionIds } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    expect(getLocalUsageStats('default', 7)).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 30,
      cache_write_tokens: 5,
      reasoning_tokens: 8,
      sessions: 2,
      by_model: [
        { model: 'gpt-test', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 5, reasoning_tokens: 8, sessions: 2 },
      ],
      by_agent: [
        { agent: 'coding_agent', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 5, reasoning_tokens: 8, sessions: 2 },
      ],
      by_day: [
        { date: '2026-07-11', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 5, sessions: 2, errors: 0, cost: 0, cost_coverage: { reported: 0, estimated: 0, unknown: 0 } },
      ],
      cost: 0,
      cost_coverage: { reported: 0, estimated: 0, unknown: 0 },
      total_api_calls: 3,
    })
    expect(getRecordedUsageSessionIds('default')).toEqual(['session-1', 'session-2'])
  })
})
