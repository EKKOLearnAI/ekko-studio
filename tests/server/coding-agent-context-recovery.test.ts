import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.hoisted(() => vi.fn())
const updateSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}))

describe('coding agent context recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it.each([
    new Error('{"error":{"code":"context_length_exceeded","message":"Your input exceeds the context window"}}'),
    new Error('maximum context length is 128000 tokens'),
    { error: '413 Payload Too Large' },
  ])('recognizes context overflow errors', async (error) => {
    const { isContextWindowExceededError } = await import('../../packages/server/src/modules/coding-agents/services/context-recovery')
    expect(isContextWindowExceededError(error)).toBe(true)
  })

  it('does not treat unrelated compact failures as context overflow', async () => {
    const { isContextWindowExceededError } = await import('../../packages/server/src/modules/coding-agents/services/context-recovery')
    expect(isContextWindowExceededError(new Error('method not found'))).toBe(false)
  })

  it('detaches only an existing Codex native thread while preserving the Studio session', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      agent: 'codex',
      agent_native_session_id: 'thread-1',
      message_count: 4172,
    })
    const { resetCodexNativeThreadAfterContextOverflow } = await import('../../packages/server/src/modules/coding-agents/services/context-recovery')

    expect(resetCodexNativeThreadAfterContextOverflow('session-1')).toEqual({
      reset: true,
      previousNativeSessionId: 'thread-1',
    })
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', { agent_native_session_id: '' })
  })

  it.each([
    null,
    { id: 'session-1', agent: 'claude', agent_native_session_id: 'native-1' },
    { id: 'session-1', agent: 'codex', agent_native_session_id: '' },
  ])('does not reset ineligible sessions', async (session) => {
    getSessionMock.mockReturnValue(session)
    const { resetCodexNativeThreadAfterContextOverflow } = await import('../../packages/server/src/modules/coding-agents/services/context-recovery')

    expect(resetCodexNativeThreadAfterContextOverflow('session-1').reset).toBe(false)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })
})
