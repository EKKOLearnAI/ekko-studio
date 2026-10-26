import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const allMock = vi.fn()
const indexAllMock = vi.fn()
const titleAllMock = vi.fn()
const contentAllMock = vi.fn()
const likeAllMock = vi.fn()
const prepareMock = vi.fn((sql: string) => {
  if (sql.includes('messages_fts MATCH')) return ({ all: contentAllMock })
  if (sql.includes('JOIN messages m') && sql.includes('LIKE')) return ({ all: likeAllMock })
  if (sql.includes('base.title') && sql.includes('LIKE')) return ({ all: titleAllMock })
  // loadAllSessions: full table scan — contains parent_session_id but NOT base/CTE/WHERE
  if (sql.includes('parent_session_id AS parent_session_id') && !sql.includes('base') && !sql.includes('parent_session_id IS NULL')) return ({ all: indexAllMock })
  return ({ all: allMock })
})
const closeMock = vi.fn()
const databaseSyncMock = vi.fn(() => ({ prepare: prepareMock, close: closeMock }))
const getActiveProfileDirMock = vi.fn(() => '/tmp/hermes-profile')

vi.doMock('node:sqlite', () => ({
  DatabaseSync: databaseSyncMock,
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileDir: getActiveProfileDirMock,
}))

describe('session DB summaries', () => {
  beforeEach(() => {
    vi.resetModules()
    allMock.mockReset()
    indexAllMock.mockReset()
    indexAllMock.mockReturnValue([])
    titleAllMock.mockReset()
    contentAllMock.mockReset()
    likeAllMock.mockReset()
    prepareMock.mockClear()
    closeMock.mockClear()
    databaseSyncMock.mockClear()
    getActiveProfileDirMock.mockReset()
    getActiveProfileDirMock.mockReturnValue('/tmp/hermes-profile')
  })

  it('queries sqlite for session summaries through the session index', async () => {
    indexAllMock.mockReturnValue([
      {
        id: 's1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Named session',
        started_at: 1710000000,
        ended_at: null,
        end_reason: '',
        message_count: 3,
        tool_call_count: 1,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0.01,
        actual_cost_usd: null,
        cost_status: 'estimated',
        preview: 'hello world',
        last_active: 1710000005,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.listSessionSummaries(undefined, 50)

    expect(databaseSyncMock).toHaveBeenCalledWith(join('/tmp/hermes-profile', 'state.db'), { open: true, readOnly: true })
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("s.source != 'tool'"))
    expect(indexAllMock).toHaveBeenCalledWith()
    expect(closeMock).toHaveBeenCalled()
    expect(rows).toEqual([
      {
        id: 's1',
        source: 'cli',
        user_id: null,
        model: 'openai/gpt-5.4',
        title: 'Named session',
        started_at: 1710000000,
        ended_at: null,
        end_reason: null,
        message_count: 3,
        tool_call_count: 1,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0.01,
        actual_cost_usd: null,
        cost_status: 'estimated',
        preview: 'hello world',
        last_active: 1710000005,
      },
    ])
  })

  it('filters indexed summaries by source and falls back last_active to started_at', async () => {
    indexAllMock.mockReturnValue([
      {
        id: 's2',
        source: 'telegram',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710000100,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 4,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'preview text',
        last_active: null,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.listSessionSummaries('telegram', 2)

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining("s.source != 'tool'"))
    expect(indexAllMock).toHaveBeenCalledWith()
    expect(rows[0].last_active).toBe(1710000100)
    expect(rows[0].source).toBe('telegram')
    expect(rows[0].title).toBe('preview text')
  })

  it('searches session titles and content with deduped results', async () => {
    titleAllMock.mockReturnValue([
      {
        id: 'title-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Docker debugging',
        started_at: 1710001000,
        ended_at: null,
        end_reason: '',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'title preview',
        last_active: 1710001005,
        matched_message_id: null,
        snippet: 'Docker debugging',
        rank: 0,
      },
    ])
    contentAllMock.mockReturnValue([
      {
        id: 'title-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Docker debugging',
        started_at: 1710001000,
        ended_at: null,
        end_reason: '',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'title preview',
        last_active: 1710001005,
        matched_message_id: 42,
        snippet: '>>>docker<<< compose up',
        rank: 0.25,
      },
      {
        id: 'content-2',
        source: 'telegram',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710002000,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 3,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'content preview',
        last_active: 1710002001,
        matched_message_id: 7,
        snippet: '>>>docker<<< swarm',
        rank: 0.1,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('docker', undefined, 10)

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('messages_fts MATCH'))
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('title-1')
    expect(rows[0].matched_message_id).toBeNull()
    expect(rows[0].snippet).toBe('Docker debugging')
    expect(rows[1].id).toBe('content-2')
    expect(rows[1].matched_message_id).toBe(7)
    expect(rows[1].snippet).toContain('docker')
  })

  it('falls back to literal content search for punctuation-only queries instead of unsafe FTS', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('fts5: syntax error near "."')
    })
    likeAllMock.mockReturnValue([
      {
        id: 'dot-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710004000,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'punctuation preview',
        last_active: 1710004001,
        matched_message_id: 21,
        snippet: 'value.with.dot',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('.', undefined, 10)

    expect(contentAllMock).not.toHaveBeenCalled()
    expect(likeAllMock).toHaveBeenCalled()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('dot-1')
  })

  it('keeps safe dotted queries on the FTS path', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockReturnValue([
      {
        id: 'node-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Node.js notes',
        started_at: 1710004500,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'dotted preview',
        last_active: 1710004501,
        matched_message_id: 22,
        snippet: '>>>node.js<<< runtime',
        rank: 0.2,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('node.js', undefined, 10)

    expect(contentAllMock).toHaveBeenCalled()
    expect(likeAllMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('node-1')
  })

  it('keeps explicit wildcard dotted queries on the FTS path with valid syntax', async () => {
    titleAllMock.mockReturnValue([
      {
        id: 'node-wildcard-title-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Node.js wildcard notes',
        started_at: 1710004590,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'wildcard title preview',
        last_active: 1710004595,
        matched_message_id: null,
        snippet: 'Node.js wildcard notes',
        rank: 0,
      },
    ])
    contentAllMock.mockReturnValue([
      {
        id: 'node-wildcard-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Node.js wildcard notes',
        started_at: 1710004600,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'wildcard dotted preview',
        last_active: 1710004601,
        matched_message_id: 24,
        snippet: '>>>node.js<<< runtime',
        rank: 0.15,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('node.js*', undefined, 10)

    expect(titleAllMock).toHaveBeenCalledWith('%node.js%', 200)
    expect(contentAllMock).toHaveBeenCalledWith('"node.js"*', 200)
    expect(likeAllMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('node-wildcard-title-1')
    expect(rows[1].id).toBe('node-wildcard-1')
  })

  it('keeps quoted wildcard dotted queries on the FTS path with valid syntax', async () => {
    titleAllMock.mockReturnValue([
      {
        id: 'node-quoted-title-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Quoted Node.js wildcard notes',
        started_at: 1710004640,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'quoted title preview',
        last_active: 1710004645,
        matched_message_id: null,
        snippet: 'Quoted Node.js wildcard notes',
        rank: 0,
      },
    ])
    contentAllMock.mockReturnValue([
      {
        id: 'node-quoted-wildcard-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Quoted Node.js wildcard notes',
        started_at: 1710004650,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'quoted wildcard dotted preview',
        last_active: 1710004651,
        matched_message_id: 25,
        snippet: '>>>node.js<<< runtime',
        rank: 0.12,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('"node.js"*', undefined, 10)

    expect(titleAllMock).toHaveBeenCalledWith('%node.js%', 200)
    expect(contentAllMock).toHaveBeenCalledWith('"node.js"*', 200)
    expect(likeAllMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('node-quoted-title-1')
    expect(rows[1].id).toBe('node-quoted-wildcard-1')
  })

  it('keeps non-ASCII dotted queries on the safe quoted FTS path', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockReturnValue([
      {
        id: 'unicode-dot-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'naïve.js note',
        started_at: 1710004700,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'unicode dotted preview',
        last_active: 1710004701,
        matched_message_id: 23,
        snippet: 'naïve.js runtime',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('naïve.js', undefined, 10)

    expect(contentAllMock).toHaveBeenCalledWith('"naïve.js"', 200)
    expect(likeAllMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('unicode-dot-1')
  })

  it('escapes LIKE wildcards for literal special-character searches', async () => {
    titleAllMock.mockReturnValue([])
    likeAllMock.mockReturnValue([
      {
        id: 'percent-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '100% reproducible',
        started_at: 1710005000,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'literal percent preview',
        last_active: 1710005001,
        matched_message_id: 31,
        snippet: '100% reproducible',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('100%', undefined, 10)

    expect(titleAllMock).toHaveBeenCalledWith('%100\\%%', 200)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('percent-1')
  })

  it('uses literal search for CJK queries even when FTS returns no rows', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockReturnValue([])
    likeAllMock.mockReturnValue([
      {
        id: 'cjk-literal-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710002980,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '中文内容预览',
        last_active: 1710002985,
        matched_message_id: 10,
        snippet: '这里也有记忆断裂',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('记忆断裂', undefined, 10)

    expect(contentAllMock).not.toHaveBeenCalled()
    expect(likeAllMock).toHaveBeenCalledWith('记忆断裂', '%记忆断裂%', 200)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('cjk-literal-1')
  })

  it('falls back to LIKE search for CJK queries while preserving title matches', async () => {
    titleAllMock.mockReturnValue([
      {
        id: 'cjk-title-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '记忆断裂标题',
        started_at: 1710002990,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 2,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'title preview',
        last_active: 1710002995,
        matched_message_id: null,
        snippet: '记忆断裂标题',
        rank: 0,
      },
    ])
    contentAllMock.mockImplementation(() => {
      throw new Error('fts5 tokenizer miss')
    })
    likeAllMock.mockReturnValue([
      {
        id: 'cjk-1',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: '',
        started_at: 1710003000,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 3,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '中文预览',
        last_active: 1710003002,
        matched_message_id: 11,
        snippet: '这是一段记忆断裂的内容',
        rank: 0,
      },
    ])

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const rows = await mod.searchSessionSummaries('记忆断裂', undefined, 10)

    expect(likeAllMock).toHaveBeenCalledWith('记忆断裂', '%记忆断裂%', 200)
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('cjk-1')
    expect(rows[1].id).toBe('cjk-title-1')
    expect(rows[0].snippet).toContain('记忆断裂')
  })

  it('falls back to title results when FTS content query fails', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('database malformed')
    })

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')

    const rows = await mod.searchSessionSummaries('docker', undefined, 10)
    expect(rows).toEqual([])
    expect(likeAllMock).not.toHaveBeenCalled()
  })

  it('falls back to title results for numeric queries when FTS fails', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')

    const rows = await mod.searchSessionSummaries('123', undefined, 10)
    expect(rows).toEqual([])
    expect(likeAllMock).not.toHaveBeenCalled()
  })

  it('falls back to title results for numeric queries with source filter when FTS fails', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')

    const rows = await mod.searchSessionSummaries('123', 'telegram', 10)
    expect(rows).toEqual([])
  })

  it('returns title matches for numeric queries even when content search fails', async () => {
    titleAllMock.mockReturnValue([
      {
        id: 'title-123',
        source: 'cli',
        user_id: '',
        model: 'openai/gpt-5.4',
        title: 'Issue 123',
        started_at: 1710002900,
        ended_at: null,
        end_reason: '',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: '',
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'title numeric preview',
        last_active: 1710002910,
        matched_message_id: null,
        snippet: 'Issue 123',
        rank: 0,
      },
    ])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')

    const rows = await mod.searchSessionSummaries('123', undefined, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('title-123')
    expect(rows[0].title).toBe('Issue 123')
  })

  it('falls back to title results for non-numeric queries when FTS fails', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('no such table: messages_fts')
    })

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')

    const rows = await mod.searchSessionSummaries('docker', undefined, 10)
    expect(rows).toEqual([])
  })

  it('falls back to title results for any query when FTS has unrelated database failure', async () => {
    titleAllMock.mockReturnValue([])
    contentAllMock.mockImplementation(() => {
      throw new Error('database malformed')
    })

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')

    const rows = await mod.searchSessionSummaries('123', undefined, 10)
    expect(rows).toEqual([])
    expect(likeAllMock).not.toHaveBeenCalled()
  })
})
