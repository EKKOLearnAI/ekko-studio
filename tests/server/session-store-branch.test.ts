import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const updateParentRun = vi.fn()
  const insertSessionRun = vi.fn()
  const insertMessageRun = vi.fn(() => ({ lastInsertRowid: 42 }))
  const updateForkPointRun = vi.fn()
  const selectSessionGet = vi.fn()
  const prepare = vi.fn((sql: string) => {
    if (sql.includes("FROM sqlite_master WHERE type='table' AND name='studio_agent_chat_bindings'")) return { get: () => undefined }
    if (sql.includes('UPDATE sessions SET ended_at')) return { run: updateParentRun }
    if (sql.includes('UPDATE sessions SET fork_point_message_id')) return { run: updateForkPointRun }
    if (sql.includes('INSERT INTO sessions')) return { run: insertSessionRun }
    if (sql.includes('INSERT INTO messages')) return { run: insertMessageRun }
    if (sql.includes('SELECT * FROM sessions WHERE id = ?')) return { get: selectSessionGet }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const exec = vi.fn()
  const db = { prepare, exec }
  return {
    updateParentRun,
    insertSessionRun,
    insertMessageRun,
    updateForkPointRun,
    selectSessionGet,
    prepare,
    exec,
    db,
    copyCompressionSnapshot: vi.fn(),
  }
})

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  isSqliteAvailable: vi.fn(() => true),
  getDb: vi.fn(() => mocks.db),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  copyCompressionSnapshot: mocks.copyCompressionSnapshot,
}))

describe('createBranchedSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectSessionGet.mockReturnValue({
      id: 'child-session',
      profile: 'default',
      source: 'cli',
      agent: 'hermes',
      agent_mode: '',
      agent_session_id: '',
      agent_native_session_id: '',
      user_id: null,
      model: 'openai/gpt-5.4',
      provider: 'openai-codex',
      api_mode: 'chat_completions',
      title: 'Forked child',
      parent_session_id: 'parent-session',
      fork_point_message_id: '42',
      started_at: 123,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: '',
      last_active: 123,
      workspace: '/repo',
    })
  })

  it('copies the parent compression snapshot inside the fork transaction', async () => {
    const { createBranchedSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')

    const result = createBranchedSession({
      parent_session_id: 'parent-session',
      id: 'child-session',
      profile: 'default',
      source: 'cli',
      agent: 'hermes',
      model: 'openai/gpt-5.4',
      provider: 'openai-codex',
      api_mode: 'chat_completions',
      title: 'Forked child',
      workspace: '/repo',
      ended_at: 123,
      last_active: 123,
      messages: [
        { role: 'user', content: 'hello', timestamp: 100 },
      ],
    })

    expect(result?.id).toBe('child-session')
    expect(mocks.exec).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(mocks.copyCompressionSnapshot).toHaveBeenCalledWith('parent-session', 'child-session')
    expect(mocks.updateForkPointRun).toHaveBeenCalledWith('42', 'child-session')
    expect(mocks.exec).toHaveBeenLastCalledWith('COMMIT')
    expect(mocks.insertMessageRun).toHaveBeenCalledWith(
      'child-session',
      'user',
      'hello',
      null,
      null,
      null,
      null,
      null,
      null,
      100,
      null,
      null,
      null,
      null,
      null,
    )
  })
})
