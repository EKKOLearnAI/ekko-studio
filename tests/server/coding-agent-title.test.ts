import { beforeEach, describe, expect, it, vi } from 'vitest'

const generate = vi.hoisted(() => vi.fn(async (_options: any) => {}))
vi.mock('../../packages/server/src/modules/studio/public/session-titles', () => ({
  generateSessionAutoTitle: generate, prepareSessionAutoTitle: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({
  createSession: vi.fn(), addMessage: vi.fn(), getSession: vi.fn(), updateSession: vi.fn(), updateSessionStats: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

function harness(agentId = 'codex') {
  const manager = Object.create(CodingAgentRunManager.prototype) as any
  for (const name of ['completeWorkspaceRunDiff', 'terminalSessionUsage', 'completeUsage', 'emitToChat', 'startCodingAgentMemoryExport', 'markChatRunCompleted', 'cleanupRun']) manager[name] = vi.fn(() => ({}))
  const snapshot = { id: 's', profile: 'p', agent: agentId, source: 'coding_agent', history_revision: 0, first_user_id: 1, first_user_content: 'Question', title: '', title_origin: 'fallback' }
  const run = { id: 'run-1', launch: { agentId, sessionId: 's', profile: 'p' }, state: { queue: [], events: [], isWorking: true, isAborting: false }, titleSnapshot: snapshot, assistantMessageId: '2', turnActive: true }
  return { manager, run, snapshot }
}

beforeEach(() => vi.clearAllMocks())
describe('Studio coding-agent title completion integration', () => {
  it.each(['codex', 'claude-code', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity', 'qwen', 'kimi'])('schedules the shared title service for a successful %s turn', agentId => {
    const { manager, run, snapshot } = harness(agentId)
    manager.emitAndMarkPrintChatRunCompleted(run, 'run.completed', { output: 'Useful answer' })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ snapshot, replyId: '2', reply: 'Useful answer' }))
    expect(generate.mock.calls[0][0]).not.toHaveProperty('model')
    expect(generate.mock.calls[0][0]).not.toHaveProperty('modelClient')
    expect(run.state.isWorking).toBe(false)
    expect(run.titleSnapshot).toBeUndefined()
    generate.mock.calls[0][0].emit('session.title.updated', { title: 'New title' })
    expect(manager.emitToChat).toHaveBeenCalledWith('s', 'session.title.updated', { title: 'New title' })
  })

  it.each(['failed', 'empty', 'aborting', 'missing snapshot', 'missing reply'])('does not schedule a title for %s completion', kind => {
    const { manager, run } = harness()
    if (kind === 'aborting') run.state.isAborting = true
    if (kind === 'missing snapshot') (run as any).titleSnapshot = null
    if (kind === 'missing reply') (run as any).assistantMessageId = undefined
    manager.emitAndMarkPrintChatRunCompleted(run, kind === 'failed' ? 'run.failed' : 'run.completed', { output: kind === 'empty' ? ' ' : 'Answer' })
    expect(generate).not.toHaveBeenCalled()
  })

  it('completes the foreground run without waiting for the title task', () => {
    generate.mockImplementationOnce(() => new Promise<void>(() => {}))
    const { manager, run } = harness()
    manager.emitAndMarkPrintChatRunCompleted(run, 'run.completed', { output: 'Answer' })
    expect(run.state.isWorking).toBe(false)
    expect(manager.markChatRunCompleted).toHaveBeenCalledWith('s', 'run.completed')
  })
})
