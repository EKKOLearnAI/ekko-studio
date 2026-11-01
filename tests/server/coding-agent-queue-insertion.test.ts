import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

function managedRun(agentId: 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' = 'codex') {
  const runMarker = 'coding-agent-turn-1'
  return {
    id: 'agent-session-1',
    launch: {
      agentSessionId: 'agent-session-1',
      agentId,
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'session-1',
      command: agentId,
      args: [],
      shellCommand: agentId,
      workspaceDir: process.cwd(),
    },
    state: {
      messages: [{
        id: 1,
        session_id: 'session-1',
        runMarker,
        role: 'assistant',
        content: 'partial answer',
        finish_reason: null,
        timestamp: 1,
      }],
      isWorking: true,
      events: [],
      queue: [{ queue_id: 'queue-1', input: 'insert me' }],
      responseRun: { responseId: 'response-1', runMarker, insertedKeys: new Set(), toolCalls: new Map() },
    },
    runMarker,
    printResponseId: 'response-1',
    currentChild: {
      pid: 123,
      exitCode: null,
      signalCode: null,
      killed: false,
    },
    lastActiveAt: Date.now(),
    startedAt: Date.now(),
    exited: false,
    turnActive: agentId === 'pi',
  } as any
}

describe('coding-agent immediate queue insertion', () => {
  it.each(['claude-code', 'codex', 'pi', 'grok', 'opencode'] as const)(
    'terminalizes and releases an active %s one-shot run',
    async (agentId) => {
      const manager = new CodingAgentRunManager()
      const run = managedRun(agentId)
      // Claude may publish a provider message id after the turn started.
      if (agentId === 'claude-code') run.printResponseId = 'claude-message-2'
      const persistTerminalResponse = vi.fn(() => 'assistant-1')
      const completeWorkspaceRunDiff = vi.fn(() => ({ change_id: 'change-1' }))
      const cleanupRun = vi.fn((target: any) => { target.exited = true })
      const emitToChat = vi.fn()
      const markChatRunCompleted = vi.fn()
      ;(manager as any).runs.set(run.id, run)
      ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
      ;(manager as any).persistTerminalResponse = persistTerminalResponse
      ;(manager as any).completeWorkspaceRunDiff = completeWorkspaceRunDiff
      ;(manager as any).cleanupRun = cleanupRun
      ;(manager as any).emitToChat = emitToChat
      ;(manager as any).markChatRunCompleted = markChatRunCompleted

      await expect(manager.interruptForQueueInsertion('session-1', 'agent-session-1', {
        responseId: 'response-1', runMarker: 'coding-agent-turn-1',
      })).resolves.toEqual({
        status: 'interrupted',
        runId: 'agent-session-1',
        responseId: agentId === 'claude-code' ? 'claude-message-2' : 'response-1',
      })
      expect(run.state.messages[0].finish_reason).toBe('interrupted')
      expect(persistTerminalResponse).toHaveBeenCalledWith(run)
      expect(cleanupRun).toHaveBeenCalledWith(run, { kill: true, reportClosed: false })
      expect(emitToChat).toHaveBeenCalledWith('session-1', 'run.failed', expect.objectContaining({
        run_id: agentId === 'claude-code' ? 'claude-message-2' : 'response-1',
        message_id: 'assistant-1',
        interrupted: true,
        stop_reason: 'queue_insertion',
        interruption_mode: 'immediate',
        queue_remaining: 1,
        workspace_run_change: { change_id: 'change-1' },
      }))
      expect(emitToChat.mock.calls[0]?.[2]).not.toHaveProperty('boundary_guarantee')
      expect(markChatRunCompleted).toHaveBeenCalledWith('session-1', 'run.failed')
    },
  )

  it('rejects a stale run id without touching the active process', async () => {
    const manager = new CodingAgentRunManager()
    const run = managedRun()
    const cleanupRun = vi.fn()
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
    ;(manager as any).cleanupRun = cleanupRun

    await expect(manager.interruptForQueueInsertion('session-1', 'old-agent-session')).resolves.toEqual({
      status: 'run_mismatch',
    })
    expect(cleanupRun).not.toHaveBeenCalled()
  })

  it.each([
    { responseId: 'old-response', runMarker: 'coding-agent-turn-1' },
    { responseId: 'response-1', runMarker: 'old-turn' },
    { responseId: 'old-response' },
  ])('rejects a replaced turn in the same manager: %j', async expectedTurn => {
    const manager = new CodingAgentRunManager()
    const run = managedRun()
    const cleanupRun = vi.fn()
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
    ;(manager as any).cleanupRun = cleanupRun

    await expect(manager.interruptForQueueInsertion('session-1', run.id, expectedTurn))
      .resolves.toEqual({ status: 'run_mismatch' })
    expect(cleanupRun).not.toHaveBeenCalled()
    expect(run.state.messages[0].finish_reason).toBeNull()
    expect(run.exited).toBe(false)
  })

  it('waits for the interrupted child streams to close before persisting and releasing the queued run', async () => {
    const manager = new CodingAgentRunManager()
    const run = managedRun()
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null,
      signalCode: null,
      killed: false,
    })
    run.currentChild = child
    const persistTerminalResponse = vi.fn(() => 'assistant-1')
    const cleanupRun = vi.fn((target: any) => { target.exited = true })
    const markChatRunCompleted = vi.fn()
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
    ;(manager as any).persistTerminalResponse = persistTerminalResponse
    ;(manager as any).completeWorkspaceRunDiff = vi.fn(() => null)
    ;(manager as any).cleanupRun = cleanupRun
    ;(manager as any).emitToChat = vi.fn()
    ;(manager as any).markChatRunCompleted = markChatRunCompleted

    const interruption = manager.interruptForQueueInsertion('session-1', 'agent-session-1')
    await Promise.resolve()
    child.emit('exit', null)
    expect(persistTerminalResponse).not.toHaveBeenCalled()
    expect(markChatRunCompleted).not.toHaveBeenCalled()

    child.emit('close', null)
    await interruption
    expect(persistTerminalResponse).toHaveBeenCalledWith(run)
    expect(markChatRunCompleted).toHaveBeenCalledWith('session-1', 'run.failed')
  })
})
