import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { respondToEkkoToolApproval } from '../../packages/server/src/modules/ekko/services/approvals'
import { respondToEkkoClarification } from '../../packages/server/src/modules/ekko/services/clarifications'

const saveTaskPlanMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/repositories/task-plan-store', () => ({ saveTaskPlan: saveTaskPlanMock }))

const getSessionMock = vi.hoisted(() => vi.fn())
const createSessionMock = vi.hoisted(() => vi.fn())
const addMessageMock = vi.hoisted(() => vi.fn())
const addMessagesMock = vi.hoisted(() => vi.fn())
const updateMessageDisplayContentMock = vi.hoisted(() => vi.fn(() => true))
const updateSessionMock = vi.hoisted(() => vi.fn())
const updateSessionStatsMock = vi.hoisted(() => vi.fn())
const resolveBridgeRunModelConfigMock = vi.hoisted(() => vi.fn())
const resolveEkkoProviderRuntimeConfigMock = vi.hoisted(() => vi.fn())
const resolveModelProviderConfigsMock = vi.hoisted(() => vi.fn())
const agentRunMock = vi.hoisted(() => vi.fn())
const agentEstimateContextMock = vi.hoisted(() => vi.fn(async () => ({ contextTokens: 5_000 })))
const agentSessionWorkspaceDirectoryMock = vi.hoisted(() => (
  vi.fn((sessionId: string) => `/tmp/ekko-workspace/default/${sessionId}`)
))
const getGlobalEkkoAgentMock = vi.hoisted(() => vi.fn(() => ({
  run: agentRunMock,
  estimateContext: agentEstimateContextMock,
  sessionWorkspaceDirectory: agentSessionWorkspaceDirectoryMock,
})))
const buildCompressedHistoryMock = vi.hoisted(() => vi.fn())
const recordSessionUsageMock = vi.hoisted(() => vi.fn())
const startWorkspaceRunCheckpointMock = vi.hoisted(() => vi.fn())
const completeWorkspaceRunCheckpointMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  addMessages: addMessagesMock,
  updateMessageDisplayContent: updateMessageDisplayContentMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/services/chat-run/compression')>()
  return {
    ...actual,
    buildCompressedHistory: buildCompressedHistoryMock,
  }
})

vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  getGlobalEkkoAgent: getGlobalEkkoAgentMock,
}))

vi.mock('../../packages/server/src/modules/ekko/services/mcp', () => ({
  resolveEkkoMcpServers: vi.fn(() => undefined),
}))

vi.mock('../../packages/server/src/modules/ekko/services/provider-runtime', () => ({
  resolveEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
}))

vi.mock('../../packages/ekko-agent/src', () => ({
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS: 300_000,
  createModelClient: vi.fn(() => ({
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
  })),
  resolveModelProviderConfigs: resolveModelProviderConfigsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', async () => {
  const approvals = await import('../../packages/server/src/modules/ekko/services/approvals')
  const clarifications = await import('../../packages/server/src/modules/ekko/services/clarifications')
  const reasoning = await import('../../packages/ekko-agent/src/model/messages')
  return {
    createChatEkkoAuthorizedProviderFetch: vi.fn(() => vi.fn()),
    getChatEkkoAgent: getGlobalEkkoAgentMock,
    resolveChatEkkoMcpServers: vi.fn(() => undefined),
    resolveChatEkkoProviderRuntimeConfig: resolveEkkoProviderRuntimeConfigMock,
    createChatEkkoModelClient: vi.fn(() => ({
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
    })),
    resolveChatEkkoModelProviderConfigs: resolveModelProviderConfigsMock,
    getChatEkkoModelRequestTimeoutMs: vi.fn(() => 300_000),
    waitForChatEkkoToolApproval: approvals.waitForEkkoToolApproval,
    waitForChatEkkoClarification: clarifications.waitForEkkoClarification,
    chatEkkoAgentReasoningText: reasoning.agentReasoningText,
    normalizeChatEkkoAgentReasoning: reasoning.normalizeAgentReasoning,
    serializeChatEkkoAgentReasoningDetails: reasoning.serializeAgentReasoningDetails,
  }
})

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
}))

vi.mock('../../packages/server/src/modules/studio/public/pet-events', () => ({
  observeRunChatPetEvent: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({
  recordSessionUsage: recordSessionUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: startWorkspaceRunCheckpointMock,
  completeWorkspaceRunCheckpoint: completeWorkspaceRunCheckpointMock,
}))

function makeHarness() {
  const roomTarget = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => roomTarget),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    join: vi.fn(),
    emit: vi.fn(),
    to: vi.fn(() => roomTarget),
  }
  const state = {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
    inputTokens: 10,
    outputTokens: 5,
  }
  const sessionMap = new Map<string, any>([['session-1', state]])
  const events: Array<{ event: string; payload: any }> = []
  return { nsp, socket, sessionMap, state, events }
}

function continuationContext(subagentId = 'child-background') {
  return {
    version: 1 as const,
    subagentId,
    originRunId: 'run-parent',
    originStep: 1,
    messages: [
      { role: 'user' as const, content: 'run checks in the background' },
      { role: 'assistant' as const, content: 'Validation is running.' },
    ],
    memoryPolicy: 'disabled' as const,
  }
}

describe('ekko-agent context usage events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentEstimateContextMock.mockResolvedValue({ contextTokens: 5_000 })
    buildCompressedHistoryMock.mockImplementation(async (
      sessionId: string,
      _profile: string,
      _upstream: string,
      _apiKey: string | undefined,
      _emit: unknown,
      sessionMap: Map<string, any>,
      _modelContext: unknown,
      _contextEstimator: unknown,
      _currentInputTokens: number,
      excludeLastUser: boolean,
    ) => {
      const messages = (sessionMap.get(sessionId)?.messages || [])
        .filter((message: any) => ['user', 'assistant', 'tool'].includes(message.role))
      if (!excludeLastUser) return messages
      const latestUserIndex = messages.findLastIndex((message: any) => message.role === 'user')
      return latestUserIndex < 0 ? messages : messages.slice(0, latestUserIndex)
    })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'ekko-agent',
      model: 'ekko-test-model',
      provider: 'test-provider',
      workspace: '/tmp/workspace',
    })
    addMessageMock.mockReturnValue(1)
    addMessagesMock.mockImplementation((messages: unknown[]) => messages.map((_, index) => 100 + index))
    resolveBridgeRunModelConfigMock.mockResolvedValue({
      model: 'ekko-test-model',
      provider: 'test-provider',
    })
    resolveEkkoProviderRuntimeConfigMock.mockResolvedValue({
      provider: 'test-provider',
      apiMode: 'chat_completions',
    })
    resolveModelProviderConfigsMock.mockReturnValue({
      providerConfig: {
        provider: 'test',
        model: 'ekko-test-model',
        apiMode: 'chat_completions',
      },
    })
    completeWorkspaceRunCheckpointMock.mockReturnValue(null)
  })

  it('persists plan snapshots before broadcasting and records update_plan calls in chat history', async () => {
    const plan = {
      runId: 'run-plan', planId: 'run-plan', revision: 1, executionState: 'running',
      createdAt: 100, updatedAt: 100,
      plan: [{ id: 'a', step: 'Inspect', status: 'in_progress' }],
    }
    const toolCall = { id: 'call-plan', name: 'update_plan', arguments: { plan: plan.plan } }
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-plan', maxSteps: 3 })
      input.onEvent({ type: 'model.message', runId: 'run-plan', step: 1, message: { role: 'assistant', content: '', toolCalls: [toolCall] } })
      input.onPlanUpdate(plan)
      input.onEvent({ type: 'plan.updated', runId: 'run-plan', plan })
      input.onEvent({ type: 'tool.completed', runId: 'run-plan', step: 1, toolCallId: 'call-plan', toolName: 'update_plan',
        result: { ok: true, content: JSON.stringify(plan), data: plan }, durationMs: 1 })
      return { runId: 'run-plan', output: { role: 'assistant', content: 'Working' }, steps: [], messages: [], events: [] }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()
    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1', input: 'Plan work', coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => {
        if (event === 'plan.updated') expect(saveTaskPlanMock).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'session-1', revision: 1 }))
        events.push({ event, payload })
      },
    }, 'default', sessionMap, vi.fn(() => false))
    expect(events).toContainEqual({ event: 'plan.updated', payload: expect.objectContaining({ plan_id: 'run-plan', execution_state: 'running', plan: plan.plan }) })
    const rows = addMessagesMock.mock.calls.flatMap(call => call[0])
    expect(rows).toContainEqual(expect.objectContaining({ role: 'tool', tool_name: 'update_plan', content: JSON.stringify(plan) }))
    expect(rows).toContainEqual(expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ function: expect.objectContaining({ name: 'update_plan' }) })] }))
  })

  it('bridges Ekko tool approval requests through the existing chat events', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-approval', maxSteps: 3 })
      const choicePromise = input.toolContext.requestToolApproval({
        approvalId: 'ekko-approval-1',
        toolName: 'terminal_exec',
        key: 'terminal:delete',
        command: 'rm -rf build',
        description: 'deletes files or directories',
        choices: ['once', 'session', 'always', 'deny'],
        allowPermanent: true,
        timeoutMs: 300_000,
      })
      expect(respondToEkkoToolApproval('session-1', 'ekko-approval-1', 'session')).toMatchObject({
        handled: true,
        resolved: true,
      })
      await expect(choicePromise).resolves.toBe('session')
      return {
        runId: 'run-approval',
        output: { role: 'assistant', content: 'done' },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 5_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'remove the build directory',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(events).toContainEqual({
      event: 'approval.requested',
      payload: expect.objectContaining({
        event: 'approval.requested',
        run_id: 'run-approval',
        approval_id: 'ekko-approval-1',
        command: 'rm -rf build',
        choices: ['once', 'session', 'always', 'deny'],
        allow_permanent: true,
        timeout_ms: 300_000,
        remaining_timeout_ms: 300_000,
        requested_at: expect.any(Number),
        permission_key: 'terminal:delete',
        session_id: 'session-1',
      }),
    })
    expect(events).toContainEqual({
      event: 'approval.resolved',
      payload: expect.objectContaining({
        event: 'approval.resolved',
        run_id: 'run-approval',
        approval_id: 'ekko-approval-1',
        choice: 'session',
        session_id: 'session-1',
      }),
    })
  })

  it('bridges Ekko clarification requests through the existing chat events', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-clarify', maxSteps: 3 })
      const responsePromise = input.toolContext.requestUserClarification({
        clarifyId: 'ekko-clarify-1',
        question: 'Which option should I use?',
        choices: ['A', 'B'],
        timeoutMs: 300_000,
      })
      expect(respondToEkkoClarification('session-1', 'ekko-clarify-1', 'B')).toEqual({
        handled: true,
        resolved: true,
      })
      await expect(responsePromise).resolves.toBe('B')
      return {
        runId: 'run-clarify',
        output: { role: 'assistant', content: 'Using option B.' },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 5_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(events).toContainEqual({
      event: 'clarify.requested',
      payload: expect.objectContaining({
        event: 'clarify.requested',
        run_id: 'run-clarify',
        clarify_id: 'ekko-clarify-1',
        question: 'Which option should I use?',
        choices: ['A', 'B'],
        timeout_ms: 300_000,
        remaining_timeout_ms: 300_000,
        requested_at: expect.any(Number),
        session_id: 'session-1',
      }),
    })
    expect(events).toContainEqual({
      event: 'clarify.resolved',
      payload: expect.objectContaining({
        event: 'clarify.resolved',
        run_id: 'run-clarify',
        clarify_id: 'ekko-clarify-1',
        resolved: true,
        reason: 'response',
        session_id: 'session-1',
      }),
    })
  })

  it('attaches a completed workspace diff to the persisted Ekko assistant message', async () => {
    const change = {
      change_id: 'change-1',
      session_id: 'session-1',
      run_id: 'run-1',
      assistant_message_id: '202',
      files_changed: 1,
      additions: 2,
      deletions: 0,
      files: [],
    }
    addMessageMock
      .mockReturnValueOnce(101)
      .mockReturnValueOnce(202)
    completeWorkspaceRunCheckpointMock.mockReturnValueOnce(change)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-1', maxSteps: 3 })
      return {
        runId: 'run-1',
        output: { role: 'assistant', content: 'done' },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 5_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'edit the file',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(startWorkspaceRunCheckpointMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: '/tmp/workspace',
    })
    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: '/tmp/workspace',
      assistantMessageId: '202',
    })
    expect(events).toContainEqual({
      event: 'workspace.diff.completed',
      payload: expect.objectContaining({
        event: 'workspace.diff.completed',
        run_id: 'run-1',
        change_id: 'change-1',
        change,
      }),
    })
    expect(events).toContainEqual({
      event: 'run.completed',
      payload: expect.objectContaining({
        run_id: 'run-1',
        workspace_run_change: change,
      }),
    })
    expect(events.findIndex(item => item.event === 'workspace.diff.completed'))
      .toBeLessThan(events.findIndex(item => item.event === 'run.completed'))
  }, 15_000)

  it('treats an Ekko boundary interrupt as completion instead of an empty provider response', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-boundary-interrupt', maxSteps: 3 })
      return {
        runId: 'run-boundary-interrupt',
        output: {
          role: 'assistant',
          content: '',
          finishReason: 'boundary_interrupt',
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 5_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'stop at the next safe boundary',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(events).toContainEqual({
      event: 'run.completed',
      payload: expect.objectContaining({
        run_id: 'run-boundary-interrupt',
        output: '',
      }),
    })
    expect(events.some(item => item.event === 'run.failed')).toBe(false)
  }, 15_000)

  it('still reports a genuine Ekko empty model response as a run failure', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-empty-response', maxSteps: 3 })
      return {
        runId: 'run-empty-response',
        output: {
          role: 'assistant',
          content: '',
          finishReason: 'stop',
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 5_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'return a response',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(events).toContainEqual({
      event: 'run.failed',
      payload: expect.objectContaining({
        run_id: 'run-empty-response',
        error: 'Model provider returned an empty response after streaming and non-streaming attempts.',
      }),
    })
    expect(events.some(item => item.event === 'run.completed')).toBe(false)
  }, 15_000)

  it('completes an Ekko workspace diff on run failure without inventing an assistant id', async () => {
    const change = {
      change_id: 'change-failed',
      session_id: 'session-1',
      run_id: 'run-failed',
      assistant_message_id: '',
      files_changed: 1,
      additions: 1,
      deletions: 0,
      files: [],
    }
    completeWorkspaceRunCheckpointMock.mockReturnValueOnce(change)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-failed', maxSteps: 3 })
      throw new Error('provider failed')
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'edit then fail',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      runId: 'run-failed',
      assistantMessageId: null,
    }))
    expect(events).toContainEqual({
      event: 'run.failed',
      payload: expect.objectContaining({
        run_id: 'run-failed',
        workspace_run_change: change,
      }),
    })
  }, 15_000)

  it('completes and publishes an Ekko workspace diff when the run is aborted', async () => {
    const change = {
      change_id: 'change-aborted',
      session_id: 'session-1',
      run_id: 'run-aborted',
      assistant_message_id: '',
      files_changed: 1,
      additions: 1,
      deletions: 0,
      files: [],
    }
    completeWorkspaceRunCheckpointMock.mockReturnValueOnce(change)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-aborted', maxSteps: 3 })
      const error = new Error('Run aborted.')
      error.name = 'AbortError'
      throw error
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'edit until stopped',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({
      event: 'workspace.diff.completed',
      payload: expect.objectContaining({
        run_id: 'run-aborted',
        change,
      }),
    })
    expect(events.some(item => item.event === 'run.completed' || item.event === 'run.failed')).toBe(false)
  }, 15_000)

  it('forwards the selected reasoning effort and requests an automatic summary', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'think carefully',
      coding_agent_id: 'ekko-agent',
      reasoning_effort: 'high',
      background_delegation_enabled: false,
      instructions: 'Keep the spoken response short and use plain text.',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      backgroundDelegationEnabled: false,
      modelDefaults: expect.objectContaining({
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      }),
      messages: expect.arrayContaining([{
        role: 'system',
        content: 'Keep the spoken response short and use plain text.',
      }]),
    }))
  })

  it('forwards trusted group-chat memory evidence separately from the model envelope', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-group-memory',
      output: { role: 'assistant', content: '好的。' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'Group chat system: reply now.\n<group_chat_summary>Agent roster</group_chat_summary>\nCurrent message: 请记住叫我老爷',
      memory_input: '请记住叫我老爷',
      memory_write_policy: 'explicit-only',
      source: 'group_chat',
      session_source: 'group_chat',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      memoryInput: expect.objectContaining({
        messages: [{ role: 'user', content: '请记住叫我老爷' }],
        writePolicy: 'explicit-only',
        origin: {
          host: 'hermes-studio',
          namespace: 'group-chat',
          contextId: 'session-1',
        },
        recallScopes: [
          { type: 'profile' },
          { type: 'context', namespace: 'studio.group-chat', id: 'session-1' },
          { type: 'session', id: 'session-1' },
        ],
      }),
      messages: expect.arrayContaining([expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('<group_chat_summary>'),
      })]),
    }))
  })

  it('uses the Hermes Responses default reasoning effort when none is selected', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'think carefully',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      modelDefaults: expect.objectContaining({
        reasoningEffort: 'medium',
        reasoningSummary: 'auto',
      }),
    }))
  })

  it('preserves an explicit request to disable reasoning', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done' },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'answer directly',
      coding_agent_id: 'ekko-agent',
      reasoning_effort: 'none',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'none',
      reasoningSummary: 'auto',
    }))
  })

  it('does not publish step context estimates as formal usage updates', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-1', maxSteps: 3 })
      input.onEvent({
        type: 'context.estimated',
        runId: 'run-1',
        step: 1,
        estimate: {
          contextTokens: 10_000,
          systemPromptTokens: 1_000,
          messageTokens: 2_000,
          toolTokens: 7_000,
          modelContextTokens: 0,
          messageCount: 2,
          toolCount: 5,
        },
      })
      input.onEvent({
        type: 'context.estimated',
        runId: 'run-1',
        step: 2,
        estimate: {
          contextTokens: 30_000,
          systemPromptTokens: 1_000,
          messageTokens: 22_000,
          toolTokens: 7_000,
          modelContextTokens: 0,
          messageCount: 4,
          toolCount: 5,
        },
      })
      input.onEvent({
        type: 'model.usage',
        runId: 'run-1',
        step: 2,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 1,
          reasoningTokens: 1,
        },
      })
      input.onEvent({
        type: 'skill.review.started',
        runId: 'run-1',
        reviewId: 'review-1',
      })
      input.onEvent({
        type: 'skill.review.completed',
        runId: 'run-1',
        reviewId: 'review-1',
        mutations: 1,
      })
      return {
        runId: 'run-1',
        output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 30_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(events.filter(item => item.event === 'context.estimated').map(item => item.payload.contextTokens)).toEqual([
      10_000,
      30_000,
    ])
    const usageEvents = events.filter(item => item.event === 'usage.updated')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].payload).toEqual(expect.objectContaining({
      input_tokens: 13,
      output_tokens: 7,
      total_tokens: 20,
      contextTokens: 30_000,
    }))
    expect(state.contextTokens).toBe(30_000)
    expect(events).toEqual(expect.arrayContaining([
      {
        event: 'skill.review.started',
        payload: {
          event: 'skill.review.started',
          run_id: 'run-1',
          review_id: 'review-1',
          session_id: 'session-1',
        },
      },
      {
        event: 'skill.review.completed',
        payload: {
          event: 'skill.review.completed',
          run_id: 'run-1',
          review_id: 'review-1',
          mutations: 1,
          session_id: 'session-1',
        },
      },
    ]))
    const runInput = agentRunMock.mock.calls[0][0]
    expect(getGlobalEkkoAgentMock).toHaveBeenCalledWith('default')
    expect(recordSessionUsageMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1:step:2:call:1',
      source: 'ekko_agent',
      agent: 'ekko_agent',
      usageScope: 'model_call',
      apiCalls: 1,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 1,
        reasoningTokens: 1,
      },
      profile: 'default',
      model: 'ekko-test-model',
      provider: 'test-provider',
      isEstimated: false,
    })
    runInput.onSkillReviewUsage({
      purpose: 'ekko-skill-review',
      usage: { inputTokens: 34, outputTokens: 6, cacheReadTokens: 8 },
      model: 'ekko-review-model',
      callIndex: 1,
    })
    expect(recordSessionUsageMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: expect.stringMatching(/^skill-review:.+:call:1$/),
      source: 'ekko_agent',
      agent: 'ekko_agent',
      usageScope: 'model_call',
      purpose: 'ekko-skill-review',
      apiCalls: 1,
      usage: { inputTokens: 34, outputTokens: 6, cacheReadTokens: 8 },
      profile: 'default',
      model: 'ekko-review-model',
      provider: 'test-provider',
      isEstimated: false,
    })
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: null,
      end_reason: null,
      last_active: expect.any(Number),
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: expect.any(Number),
      end_reason: 'complete',
    }))
  })

  it('keeps Ekko background subtask state and accounts for late child usage', async () => {
    let runtimeEvent: ((event: any) => void) | undefined
    const dequeueNextQueuedRun = vi.fn(() => false)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      runtimeEvent = input.onEvent
      input.onEvent({ type: 'run.started', runId: 'run-parent', maxSteps: 3 })
      input.onEvent({
        type: 'subagent.start',
        runId: 'run-parent',
        subagentId: 'child-background',
        goal: 'Run validation',
        background: true,
        model: 'ekko-test-model',
        startedAt: 1_000,
      })
      return {
        runId: 'run-parent',
        output: {
          role: 'assistant',
          content: 'Validation is running.',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'run checks in the background',
      coding_agent_id: 'ekko-agent',
      instructions: 'Keep the spoken response short and use plain text.',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, dequeueNextQueuedRun)

    expect(state.backgroundTasks['child-background']).toEqual(expect.objectContaining({
      runtime: 'ekko',
      subagent_id: 'child-background',
      goal: 'Run validation',
      status: 'running',
      last_event: 'subagent.start',
    }))
    expect(state.inputTokens).toBe(13)
    expect(state.outputTokens).toBe(7)
    expect(events).toContainEqual(expect.objectContaining({
      event: 'run.completed',
      payload: expect.objectContaining({
        run_id: 'run-parent',
        background_pending: 1,
      }),
    }))

    runtimeEvent?.({
      type: 'subagent.text',
      runId: 'run-parent',
      childRunId: 'run-child',
      subagentId: 'child-background',
      goal: 'Run validation',
      background: true,
      text: 'All checks\n\n',
    })
    runtimeEvent?.({
      type: 'subagent.text',
      runId: 'run-parent',
      childRunId: 'run-child',
      subagentId: 'child-background',
      goal: 'Run validation',
      background: true,
      text: 'passed.',
    })
    state.messages.push({
      id: 77,
      session_id: 'session-1',
      role: 'tool',
      content: JSON.stringify({
        runtime: 'ekko',
        mode: 'background',
        subagent_id: 'child-background',
        status: 'running',
      }),
      tool_call_id: 'delegate-call',
      tool_name: 'delegate_task',
      timestamp: 1,
    })
    runtimeEvent?.({
      type: 'subagent.complete',
      runId: 'run-parent',
      childRunId: 'run-child',
      subagentId: 'child-background',
      goal: 'Run validation',
      background: true,
      status: 'completed',
      summary: 'All checks passed.',
      output: 'All checks\n\npassed.',
      outputTail: 'All checks\n\npassed.',
      durationMs: 2_500,
      toolCount: 2,
      apiCalls: 2,
      inputTokens: 11,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      continuationContext: continuationContext(),
    })

    expect(state.backgroundTasks['child-background']).toEqual(expect.objectContaining({
      runtime: 'ekko',
      status: 'completed',
      last_event: 'subagent.complete',
      summary: 'All checks passed.',
      api_calls: 2,
      input_tokens: 11,
      output_tokens: 4,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
      reasoning_tokens: 1,
    }))
    expect(state.inputTokens).toBe(24)
    expect(state.outputTokens).toBe(11)
    expect(updateMessageDisplayContentMock).toHaveBeenCalledWith(
      'session-1',
      77,
      expect.stringContaining('"status":"completed"'),
    )
    expect(state.messages.find(message => message.id === 77)?.display_content)
      .toContain('"runtime":"ekko"')
    expect(dequeueNextQueuedRun).toHaveBeenCalledOnce()
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1', 'default')
    expect(state.queue).toHaveLength(1)
    expect(state.queue[0]).toEqual(expect.objectContaining({
      queue_id: 'ekko_subagent_child-background',
      displayInput: null,
      codingAgentId: 'ekko-agent',
      instructions: 'Keep the spoken response short and use plain text.',
      autonomous: true,
      backgroundDelegationId: 'child-background',
    }))
    expect(state.queue[0].input).toContain('All checks\n\npassed.')
    expect(recordSessionUsageMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-parent:subagent:child-background',
      source: 'ekko_agent',
      agent: 'ekko_agent',
      usageScope: 'model_call',
      purpose: 'ekko-background-subtask',
      apiCalls: 2,
      usage: {
        inputTokens: 11,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
      },
      profile: 'default',
      model: 'ekko-test-model',
      provider: 'test-provider',
      isEstimated: false,
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'subagent.start',
        payload: expect.objectContaining({
          subagent_id: 'child-background',
          background: true,
        }),
      }),
      expect.objectContaining({
        event: 'subagent.complete',
        payload: expect.objectContaining({
          parent_run_id: 'run-parent',
          child_run_id: 'run-child',
          subagent_id: 'child-background',
          status: 'completed',
          summary: 'All checks\n\npassed.',
        }),
      }),
      expect.objectContaining({
        event: 'usage.updated',
        payload: expect.objectContaining({
          input_tokens: 24,
          output_tokens: 11,
          total_tokens: 35,
        }),
      }),
    ]))
  })

  it('queues a completed background result without starting it while the parent run is busy', async () => {
    const dequeueNextQueuedRun = vi.fn(() => false)
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-parent', maxSteps: 3 })
      input.onEvent({
        type: 'subagent.start',
        runId: 'run-parent',
        subagentId: 'child-background',
        goal: 'Run validation',
        background: true,
        startedAt: 1_000,
      })
      input.onEvent({
        type: 'subagent.complete',
        runId: 'run-parent',
        childRunId: 'run-child',
        subagentId: 'child-background',
        goal: 'Run validation',
        background: true,
        status: 'completed',
        summary: 'Validation passed.',
        output: 'Validation passed.',
        outputTail: 'Validation passed.',
        durationMs: 500,
        toolCount: 0,
        apiCalls: 1,
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        continuationContext: continuationContext(),
      })
      expect(dequeueNextQueuedRun).not.toHaveBeenCalled()
      return {
        runId: 'run-parent',
        output: {
          role: 'assistant',
          content: 'The background task is running.',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'run checks in the background',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, dequeueNextQueuedRun)

    expect(state.queue).toHaveLength(1)
    expect(dequeueNextQueuedRun).toHaveBeenCalledOnce()
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1', 'default')
  })

  it('marks the parent continuation as an autonomous run for the completed child', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-autonomous', maxSteps: 3 })
      return {
        runId: 'run-autonomous',
        output: {
          role: 'assistant',
          content: 'Validation passed.',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state, events } = makeHarness()
    state.messages.push({
      id: 99,
      session_id: 'session-1',
      role: 'user',
      content: 'This message was sent after the background task started.',
      timestamp: 2,
    })

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'Background subtask result: Validation passed.',
      display_input: null,
      coding_agent_id: 'ekko-agent',
      queue_id: 'ekko_subagent_child-background',
      autonomous: true,
      background_delegation_id: 'child-background',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false), true, {
      runtime: 'ekko',
      ...continuationContext(),
    })

    expect(buildCompressedHistoryMock).not.toHaveBeenCalled()
    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      contextKey: 'session-1:background-callback:child-background',
      memoryEnabled: false,
      ephemeralContext: true,
      skillReviewEnabled: false,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'run checks in the background' }),
        expect.objectContaining({ role: 'user', content: 'Background subtask result: Validation passed.' }),
      ]),
    }))
    const callbackMessages = agentRunMock.mock.calls[0][0].messages
    expect(callbackMessages).not.toContainEqual(expect.objectContaining({
      content: 'This message was sent after the background task started.',
    }))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.started',
        payload: expect.objectContaining({
          run_id: 'run-autonomous',
          autonomous: true,
          delegation_id: 'child-background',
        }),
      }),
      expect.objectContaining({
        event: 'run.completed',
        payload: expect.objectContaining({
          run_id: 'run-autonomous',
          autonomous: true,
          delegation_id: 'child-background',
          background_pending: 0,
        }),
      }),
    ]))
  })

  it('publishes the workspace when a new Ekko session is persisted', async () => {
    getSessionMock.mockReturnValueOnce(null)
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'create a file',
      coding_agent_id: 'ekko-agent',
      workspace: '/tmp/new-workspace',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentSessionWorkspaceDirectoryMock).not.toHaveBeenCalled()
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      agent: 'ekko-agent',
      api_mode: 'chat_completions',
      workspace: '/tmp/new-workspace',
    }))
    expect(events).toContainEqual({
      event: 'session.workspace.updated',
      payload: {
        event: 'session.workspace.updated',
        session_id: 'session-1',
        workspace: '/tmp/new-workspace',
      },
    })
  })

  it('keeps MCU Ekko sessions classified as global agent sessions', async () => {
    getSessionMock.mockReturnValueOnce(null)
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'hello from MCU',
      source: 'coding_agent',
      session_source: 'global_agent',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      source: 'global_agent',
      agent: 'ekko-agent',
      agent_mode: 'scoped',
    }))
  })

  it('migrates an existing Hermes MCU session to Ekko metadata', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'global_agent',
      agent: 'hermes',
      agent_mode: '',
      agent_session_id: '',
      agent_native_session_id: '',
      model: 'ekko-test-model',
      provider: 'test-provider',
      workspace: '/tmp/existing-mcu-workspace',
    })
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'continue on Ekko',
      source: 'coding_agent',
      session_source: 'global_agent',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(createSessionMock).not.toHaveBeenCalled()
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', {
      source: 'global_agent',
      agent: 'ekko-agent',
      agent_mode: 'scoped',
      agent_session_id: '',
      agent_native_session_id: '',
    })
    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      toolContext: expect.objectContaining({
        cwd: '/tmp/existing-mcu-workspace',
        workspaceRoot: '/tmp/existing-mcu-workspace',
      }),
    }))
  })

  it('uses the profile-scoped Ekko session workspace by default', async () => {
    getSessionMock.mockReturnValueOnce(null)
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'create a file',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    const workspace = '/tmp/ekko-workspace/default/session-1'
    expect(agentSessionWorkspaceDirectoryMock).toHaveBeenCalledWith('session-1')
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      agent: 'ekko-agent',
      workspace,
    }))
    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      toolContext: expect.objectContaining({
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    }))
    expect(events).toContainEqual({
      event: 'session.workspace.updated',
      payload: {
        event: 'session.workspace.updated',
        session_id: 'session-1',
        workspace,
      },
    })
  })

  it('loads and persists the configured API mode when the session and request omit it', async () => {
    getSessionMock.mockReturnValueOnce({
      id: 'session-1',
      profile: 'default',
      source: 'coding_agent',
      agent: 'ekko-agent',
      model: 'ekko-test-model',
      provider: 'custom:fun-codex',
      api_mode: '',
      workspace: '/tmp/workspace',
    })
    resolveBridgeRunModelConfigMock.mockResolvedValueOnce({
      model: 'ekko-test-model',
      provider: 'custom:fun-codex',
    })
    resolveEkkoProviderRuntimeConfigMock.mockResolvedValueOnce({
      provider: 'custom:fun-codex',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
    })
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'use the configured protocol',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(resolveEkkoProviderRuntimeConfigMock).toHaveBeenCalledWith({
      profile: 'default',
      provider: 'custom:fun-codex',
      model: 'ekko-test-model',
      baseUrl: undefined,
      apiKey: undefined,
      apiMode: undefined,
    })
    expect(resolveModelProviderConfigsMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom:fun-codex',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', {
      api_mode: 'codex_responses',
    })
  })

  it('persists Ekko annotation display content separately from model storage content', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [], messages: [], events: [], contextEstimate: { contextTokens: 5_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state } = makeHarness()
    const storageText = '<response_annotations>model context</response_annotations>'
    const displayText = '{"__hermes_studio_response_annotations__":1,"body":"","annotations":[]}'

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1', input: storageText, storage_message: storageText,
      display_input: displayText, coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user', content: storageText, display_content: displayText,
    }))
    expect(state.messages[0]).toEqual(expect.objectContaining({
      role: 'user', content: storageText, display_content: displayText,
    }))
    const peerEmit = (socket.to as any).mock.results[0]?.value.emit
    expect(peerEmit).toHaveBeenCalledWith('run.peer_user_message', expect.objectContaining({
      message: expect.objectContaining({ content: displayText }),
    }))
  })

  it('acknowledges durable user-message persistence before Ekko startup resolves', async () => {
    addMessageMock.mockReturnValueOnce(88)
    let resolveRun!: (value: any) => void
    agentRunMock.mockImplementationOnce(() => new Promise(resolve => { resolveRun = resolve }))
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, events } = makeHarness()
    const running = handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1', input: 'annotated', storage_message: 'annotated',
      display_input: '{"display":"annotation"}', coding_agent_id: 'ekko-agent',
      queue_id: 'annotation-message-2',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    await vi.waitFor(() => expect(events).toContainEqual({
      event: 'run.accepted',
      payload: expect.objectContaining({
        session_id: 'session-1', queue_id: 'annotation-message-2', message_id: 88,
      }),
    }))
    resolveRun({
      runId: 'run-accepted',
      output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [], messages: [], events: [], contextEstimate: { contextTokens: 5_000 },
    })
    await running
  })

  it('loads frontend image blocks into ephemeral model content parts without storing base64', async () => {
    const imagePath = join(process.cwd(), 'packages/client/public/coding-agents/ekko-agent.png')
    const expectedBase64 = (await readFile(imagePath)).toString('base64')
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'image understood', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image', name: 'ekko-agent.png', path: imagePath, media_type: 'image/png' },
      ],
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    const runInput = agentRunMock.mock.calls[0][0]
    expect(runInput.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Describe this image.'),
        contentParts: [{
          type: 'image',
          mimeType: 'image/png',
          data: expectedBase64,
        }],
      }),
    ])
    const storedUserMessage = addMessageMock.mock.calls.find(call => call[0]?.role === 'user')?.[0]
    expect(storedUserMessage?.content).toContain(imagePath)
    expect(storedUserMessage?.content).not.toContain(expectedBase64)
  })

  it('uses externally compressed history and Ekko fixed-context estimates', async () => {
    buildCompressedHistoryMock.mockImplementationOnce(async (
      _sessionId: string,
      _profile: string,
      _upstream: string,
      _apiKey: string | undefined,
      _emit: unknown,
      _sessionMap: Map<string, any>,
      _modelContext: unknown,
      contextEstimator: (_messages: unknown[], messageTokens: number) => Promise<number>,
    ) => {
      expect(await contextEstimator([], 123)).toBe(5_123)
      return [{
        role: 'user',
        content: '[CONTEXT COMPACTION — REFERENCE ONLY]\n\nsummary',
      }]
    })
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'continued', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 6_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'continue from the checkpoint',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentEstimateContextMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: [],
      memoryEnabled: false,
      model: 'ekko-test-model',
    }))
    expect(agentRunMock.mock.calls[0][0].messages).toEqual([
      {
        role: 'user',
        content: '[CONTEXT COMPACTION — REFERENCE ONLY]\n\nsummary',
      },
      {
        role: 'user',
        content: 'continue from the checkpoint',
      },
    ])
    expect(agentRunMock.mock.calls[0][0].memoryInput).toEqual({
      messages: [{ role: 'user', content: 'continue from the checkpoint' }],
      writePolicy: 'automatic',
      origin: {
        host: 'hermes-studio',
        namespace: 'single-chat',
        contextId: 'session-1',
      },
      recallScopes: [
        { type: 'profile' },
        { type: 'context', namespace: 'studio.single-chat', id: 'session-1' },
        { type: 'session', id: 'session-1' },
      ],
      writeScopes: [
        { type: 'profile' },
        { type: 'context', namespace: 'studio.single-chat', id: 'session-1' },
        { type: 'session', id: 'session-1' },
      ],
      defaultWriteScope: { type: 'profile' },
    })
    expect(buildCompressedHistoryMock).toHaveBeenCalledWith(
      'session-1',
      'default',
      '',
      undefined,
      expect.any(Function),
      sessionMap,
      {
        model: 'ekko-test-model',
        provider: 'test-provider',
        allowHermesFallback: false,
      },
      expect.any(Function),
      expect.any(Number),
      true,
    )
  })

  it('passes only log correlation context into the internally logged runtime', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-log', maxSteps: 3 })
      input.onEvent({ type: 'model.started', runId: 'run-log', step: 1 })
      input.onEvent({
        type: 'model.retry',
        runId: 'run-log',
        step: 1,
        retry: 1,
        maxRetries: 3,
        error: 'provider timeout',
      })
      input.onEvent({
        type: 'model.message',
        runId: 'run-log',
        step: 1,
        message: { role: 'assistant', content: 'done' },
      })
      input.onEvent({
        type: 'tool.started',
        runId: 'run-log',
        step: 1,
        toolCallId: 'call-1',
        toolName: 'terminal_exec',
        arguments: { command: '/bin/sh', timeoutMs: 650_000 },
      })
      input.onEvent({
        type: 'tool.failed',
        runId: 'run-log',
        step: 1,
        toolCallId: 'call-1',
        toolName: 'terminal_exec',
        result: { ok: false, content: 'timed out', error: 'timed out' },
        durationMs: 120_000,
      })
      input.onEvent({ type: 'model.delta', runId: 'run-log', step: 1, text: 'done' })
      input.onEvent({
        type: 'run.completed',
        runId: 'run-log',
        output: { role: 'assistant', content: 'done' },
        steps: 1,
      })
      return {
        runId: 'run-log',
        output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
        steps: [],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'run a tool',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(agentRunMock).toHaveBeenCalledWith(expect.objectContaining({
      logContext: {
        profile: 'default',
        sessionId: 'session-1',
        turnId: expect.any(String),
      },
    }))
  })

  it('incrementally persists a completed tool group before an aborted run exits', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-abort', maxSteps: 3 })
      input.onEvent({
        type: 'model.message',
        runId: 'run-abort',
        step: 1,
        message: {
          role: 'assistant',
          content: '',
          reasoning: {
            text: 'I need to find the image skill.',
            estimatedTokens: 29,
            native: {
              format: 'openai-reasoning-details',
              data: [{
                type: 'reasoning.text',
                text: 'I need to find the image skill.',
                signature: 'provider-signature',
              }],
            },
          },
          toolCalls: [{
            id: 'call-search',
            name: 'skill_list',
            arguments: { query: 'apikey-image-gen' },
          }],
        },
      })
      input.onEvent({
        type: 'tool.completed',
        runId: 'run-abort',
        step: 1,
        toolCallId: 'call-search',
        toolName: 'skill_list',
        result: { ok: true, content: '{"skills":["apikey-image-gen"]}' },
        durationMs: 5,
      })
      expect(addMessagesMock).toHaveBeenCalledTimes(1)
      const abortError = new Error('Run aborted.')
      abortError.name = 'AbortError'
      throw abortError
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state, events } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'generate an image',
      coding_agent_id: 'ekko-agent',
      onEvent: (event: string, payload: any) => events.push({ event, payload }),
    }, 'default', sessionMap, vi.fn(() => false))

    expect(addMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        role: 'assistant',
        run_marker: 'run-abort',
        tool_calls: [{
          id: 'call-search',
          type: 'function',
          function: {
            name: 'skill_list',
            arguments: '{"query":"apikey-image-gen"}',
          },
        }],
        finish_reason: 'tool_calls',
        reasoning: 'I need to find the image skill.',
        reasoning_content: 'I need to find the image skill.',
        reasoning_details: JSON.stringify({
          version: 1,
          native: {
            format: 'openai-reasoning-details',
            data: [{
              type: 'reasoning.text',
              text: 'I need to find the image skill.',
              signature: 'provider-signature',
            }],
          },
          estimatedTokens: 29,
        }),
      }),
      expect.objectContaining({
        role: 'tool',
        run_marker: 'run-abort',
        content: '{"skills":["apikey-image-gen"]}',
        tool_call_id: 'call-search',
        tool_name: 'skill_list',
      }),
    ])
    expect(state.messages.slice(-2).map((message: any) => ({
      role: message.role,
      runMarker: message.runMarker,
    }))).toEqual([
      { role: 'assistant', runMarker: 'run-abort' },
      { role: 'tool', runMarker: 'run-abort' },
    ])
    expect(events.some(item => item.event === 'run.failed')).toBe(false)
  })

  it('waits for every result before atomically persisting a multi-tool group', async () => {
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-multi', maxSteps: 3 })
      input.onEvent({
        type: 'model.message',
        runId: 'run-multi',
        step: 1,
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-one', name: 'skill_list', arguments: { query: 'image' } },
            { id: 'call-two', name: 'skill_view', arguments: { name: 'apikey-image-gen' } },
          ],
        },
      })
      input.onEvent({
        type: 'tool.completed',
        runId: 'run-multi',
        step: 1,
        toolCallId: 'call-one',
        toolName: 'skill_list',
        result: { ok: true, content: 'found' },
        durationMs: 2,
      })
      expect(addMessagesMock).not.toHaveBeenCalled()
      input.onEvent({
        type: 'tool.failed',
        runId: 'run-multi',
        step: 1,
        toolCallId: 'call-two',
        toolName: 'skill_view',
        result: { ok: false, content: 'read failed', error: 'read failed' },
        durationMs: 3,
      })
      expect(addMessagesMock).toHaveBeenCalledTimes(1)
      const abortError = new Error('Run aborted.')
      abortError.name = 'AbortError'
      throw abortError
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'use both tools',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    const rows = addMessagesMock.mock.calls[0][0]
    expect(rows.map((row: any) => row.role)).toEqual(['assistant', 'tool', 'tool'])
    expect(rows.map((row: any) => row.run_marker)).toEqual(['run-multi', 'run-multi', 'run-multi'])
    expect(rows[2]).toEqual(expect.objectContaining({
      tool_call_id: 'call-two',
      finish_reason: 'error',
    }))
  })

  it('does not duplicate incrementally persisted tool messages after a successful run', async () => {
    const modelStep = {
      type: 'model',
      step: 1,
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call-once',
          name: 'skill_list',
          arguments: { query: 'image' },
        }],
      },
    }
    const toolStep = {
      type: 'tool',
      step: 1,
      toolCallId: 'call-once',
      toolName: 'skill_list',
      result: { ok: true, content: 'found' },
    }
    agentRunMock.mockImplementationOnce(async (input: any) => {
      input.onEvent({ type: 'run.started', runId: 'run-success', maxSteps: 3 })
      input.onEvent({
        type: 'model.message',
        runId: 'run-success',
        step: 1,
        message: modelStep.message,
      })
      input.onEvent({
        type: 'tool.completed',
        runId: 'run-success',
        step: 1,
        toolCallId: 'call-once',
        toolName: 'skill_list',
        result: toolStep.result,
        durationMs: 2,
      })
      return {
        runId: 'run-success',
        output: { role: 'assistant', content: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
        steps: [modelStep, toolStep],
        messages: [],
        events: [],
        contextEstimate: { contextTokens: 6_000 },
      }
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap } = makeHarness()

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'find the skill',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    expect(addMessagesMock).toHaveBeenCalledTimes(1)
    expect(addMessageMock.mock.calls.filter(call => call[0]?.tool_calls?.length)).toHaveLength(0)
    expect(addMessageMock.mock.calls.filter(call => call[0]?.role === 'tool')).toHaveLength(0)
  })

  it('includes paired non-empty and empty tool results in Ekko history for follow-up turns', async () => {
    agentRunMock.mockResolvedValueOnce({
      runId: 'run-1',
      output: { role: 'assistant', content: 'follow-up done', usage: { inputTokens: 3, outputTokens: 2 } },
      steps: [],
      messages: [],
      events: [],
      contextEstimate: { contextTokens: 12_000 },
    })
    const { handleEkkoAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
    const { nsp, socket, sessionMap, state } = makeHarness()
    state.messages = [
      {
        id: 1,
        session_id: 'session-1',
        role: 'user',
        content: 'check weather',
        timestamp: 1000,
      },
      {
        id: 2,
        session_id: 'session-1',
        role: 'assistant',
        content: '',
        reasoning_content: 'I need to inspect both tool results.',
        reasoning_details: JSON.stringify({
          version: 1,
          estimatedTokens: 17,
          native: {
            format: 'openai-reasoning-details',
            data: [{
              type: 'reasoning.text',
              text: 'I need to inspect both tool results.',
              signature: 'provider-signature',
            }],
          },
        }),
        tool_calls: [{
          id: 'call_weather',
          type: 'function',
          function: {
            name: 'browser_navigate',
            arguments: '{"url":"https://weather.example"}',
          },
        }, {
          id: 'call_empty',
          type: 'function',
          function: {
            name: 'terminal_exec',
            arguments: '{"command":"mdfind example"}',
          },
        }],
        timestamp: 1001,
      },
      {
        id: 3,
        session_id: 'session-1',
        role: 'tool',
        content: '{"forecast":"sunny"}',
        tool_call_id: 'call_weather',
        tool_name: 'browser_navigate',
        timestamp: 1002,
      },
      {
        id: 4,
        session_id: 'session-1',
        role: 'tool',
        content: '',
        tool_call_id: 'call_empty',
        tool_name: 'terminal_exec',
        timestamp: 1003,
      },
      {
        id: 5,
        session_id: 'session-1',
        role: 'tool',
        content: 'orphan result',
        tool_call_id: 'call_orphan',
        tool_name: 'browser_navigate',
        timestamp: 1004,
      },
    ]

    await handleEkkoAgentRun(nsp as any, socket as any, {
      session_id: 'session-1',
      input: 'thanks',
      coding_agent_id: 'ekko-agent',
    }, 'default', sessionMap, vi.fn(() => false))

    const runInput = agentRunMock.mock.calls[0][0]
    expect(runInput.messages).toMatchObject([
      { role: 'user', content: 'check weather' },
      {
        role: 'assistant',
        content: '',
        reasoning: {
          text: 'I need to inspect both tool results.',
          estimatedTokens: 17,
          native: {
            format: 'openai-reasoning-details',
            data: [{
              type: 'reasoning.text',
              text: 'I need to inspect both tool results.',
              signature: 'provider-signature',
            }],
          },
        },
        toolCalls: [{
          id: 'call_weather',
          name: 'browser_navigate',
          arguments: { url: 'https://weather.example' },
          rawArguments: '{"url":"https://weather.example"}',
        }, {
          id: 'call_empty',
          name: 'terminal_exec',
          arguments: { command: 'mdfind example' },
          rawArguments: '{"command":"mdfind example"}',
        }],
      },
      {
        role: 'tool',
        content: '{"forecast":"sunny"}',
        toolCallId: 'call_weather',
        name: 'browser_navigate',
      },
      {
        role: 'tool',
        content: '(no output)',
        toolCallId: 'call_empty',
        name: 'terminal_exec',
      },
      { role: 'user', content: 'thanks' },
    ])
    expect(runInput.messages.some((message: any) => message.content === 'orphan result')).toBe(false)
  })
})
