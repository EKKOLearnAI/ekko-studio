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
  getUsage,
  getUsageBatch,
  deleteUsage,
  getRecordedUsageSessionIds,
  getRecordedUsageByRun,
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

  it('getUsage returns undefined when jsonGet returns nothing', () => {
    mockJsonGet.mockReturnValue(undefined)
    const result = getUsage('nonexistent')
    expect(result).toBeUndefined()
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
        { date: '2026-07-11', input_tokens: 100, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 5, sessions: 2, errors: 0, cost: 0 },
      ],
      cost: 0,
      total_api_calls: 3,
    })
    expect(getRecordedUsageSessionIds('default')).toEqual(['session-1', 'session-2'])
  })

  it('aggregates JSON run usage by bare run id and prefix', () => {
    mockJsonGetAll.mockReturnValue({
      'session-1': {
        run_id: 'run-abc:api:1',
        source: 'hermes',
        input_tokens: 10,
        output_tokens: 4,
        cache_read_tokens: 7,
        cache_write_tokens: 0,
        reasoning_tokens: 1,
        api_calls: 1,
      },
    })
    expect(getRecordedUsageByRun('session-1', 'hermes', 'run-abc')).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      reasoningTokens: 1,
      apiCalls: 1,
    })
    expect(getRecordedUsageByRun('session-1', 'hermes', 'other')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCalls: 0,
    })
  })
})
