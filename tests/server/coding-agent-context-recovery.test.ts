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

  it.each([
    ['claude-code', 'claude'],
    ['codex', 'codex'],
    ['grok', 'grok'],
    ['pi', 'pi'],
  ])('detaches an existing %s native session while preserving Studio history', async (agentId, storedAgent) => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      agent: storedAgent,
      agent_native_session_id: 'native-1',
      message_count: 4172,
    })
    const { resetNativeSessionAfterContextOverflow } = await import('../../packages/server/src/modules/coding-agents/services/context-recovery')

    expect(resetNativeSessionAfterContextOverflow('session-1', agentId)).toEqual({
      reset: true,
      previousNativeSessionId: 'native-1',
    })
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', { agent_native_session_id: '' })
  })

  it('does not reset unsupported native runtimes', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'opencode', agent_native_session_id: 'native-1' })
    const { resetNativeSessionAfterContextOverflow } = await import('../../packages/server/src/modules/coding-agents/services/context-recovery')
    expect(resetNativeSessionAfterContextOverflow('session-1', 'opencode').reset).toBe(false)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { id: 'session-1', agent: 'grok', agent_native_session_id: 'native-1' },
    { id: 'session-1', agent: 'codex', agent_native_session_id: '' },
  ])('does not reset ineligible sessions', async (session) => {
    getSessionMock.mockReturnValue(session)
    const { resetNativeSessionAfterContextOverflow } = await import('../../packages/server/src/modules/coding-agents/services/context-recovery')

    expect(resetNativeSessionAfterContextOverflow('session-1', 'codex').reset).toBe(false)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })
})
