// @vitest-environment jsdom
// The bridge forwarder decides whether the Web UI can tell a failed approval
// resolution from an older runtime that reports no outcome at all. These cases
// drive the real forwarder and feed whatever it emits to the real chat store,
// so the server payload and the client card are checked against each other
// rather than against a hand-written fixture.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  respondToolApproval: vi.fn(),
  globalPendingHandler: undefined as undefined | ((event: any) => void),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: chatApi.respondToolApproval,
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => { chatApi.globalPendingHandler = handler; return vi.fn() }),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: vi.fn(() => 42),
  createSession: vi.fn(),
  getSession: vi.fn(() => ({ id: 'session-bridge', profile: 'default', model: 'gpt-test', provider: 'openai' })),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  countTokens: vi.fn(() => 1),
  SUMMARY_PREFIX: '[Summary] ',
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', async () => {
  const actual = await vi.importActual<any>('../../packages/server/src/modules/studio/services/chat-run/compression')
  return {
    ...actual,
    buildDbHistory: vi.fn(async () => []),
    buildSnapshotAwareHistory: vi.fn(async () => []),
    buildCompressedHistory: vi.fn(),
    forceCompressBridgeHistory: vi.fn(),
  }
})

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 3, outputTokens: 2 })),
  contextTokensWithCachedOverhead: vi.fn((_state: any, tokens: number) => tokens),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 3, outputTokens: 2 })),
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  updateMessageContextTokenUsage: vi.fn((_sid: any, state: any, _emit: any, tokens: number) => {
    state.contextTokens = tokens
    return tokens
  }),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

const SESSION_ID = 'session-bridge'
const APPROVAL_ID = 'approval-bridge'

function makeSession(): Session {
  return {
    id: SESSION_ID,
    title: SESSION_ID,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function createNamespace() {
  const emitted: Array<{ event: string; payload: any }> = []
  return {
    emitted,
    nsp: {
      adapter: { rooms: { get: vi.fn(() => new Set(['socket-1'])) } },
      to: vi.fn(() => ({
        emit: vi.fn((event: string, payload: any) => emitted.push({ event, payload })),
      })),
    },
  }
}

// Drives the real bridge forwarder over one runtime approval.resolved event and
// returns the approval.resolved payload it broadcast to the room.
async function forwardRuntimeApproval(runtimeEvent: Record<string, unknown>) {
  const { resumeBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
  const { nsp, emitted } = createNamespace()
  const sessionMap = new Map<string, any>()
  sessionMap.set(SESSION_ID, {
    messages: [{ id: 1, session_id: SESSION_ID, role: 'user', content: 'hello', timestamp: 1 }],
    isWorking: true,
    events: [],
    queue: [],
  })

  const bridge = {
    getResult: vi.fn(async () => ({
      ok: true,
      run_id: 'run-bridge',
      session_id: SESSION_ID,
      status: 'running',
      output: '',
      deltas: [],
      events: [],
    })),
    getOutput: vi.fn(async () => ({
      ok: true,
      run_id: 'run-bridge',
      session_id: SESSION_ID,
      status: 'complete',
      delta: '',
      cursor: 0,
      output: '',
      done: true,
      result: { final_response: '' },
      error: null,
      events: [runtimeEvent],
      event_cursor: 1,
    })),
  }

  await resumeBridgeRun(
    nsp as any,
    { id: 'socket-1', connected: true, emit: vi.fn() } as any,
    {
      sessionId: SESSION_ID,
      runId: 'run-bridge',
      profile: 'default',
      instructions: 'system prompt',
      model: 'gpt-test',
      provider: 'openai',
    },
    sessionMap,
    bridge as any,
    vi.fn(),
  )

  const approvals = emitted.filter(item => item.event === 'approval.resolved')
  expect(approvals).toHaveLength(1)
  return approvals[0].payload
}

describe('bridge approval outcome reaches the approval card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatApi.globalPendingHandler = undefined
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  })

  function storeWithPendingApproval() {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session
    chatApi.globalPendingHandler?.({
      event: 'approval.requested',
      session_id: SESSION_ID,
      approval_id: APPROVAL_ID,
      command: 'write_file /tmp/gateway.txt',
      description: 'Allow write_file to create /tmp/gateway.txt',
      choices: ['once', 'deny'],
      timeout_ms: 300_000,
    })
    expect(store.pendingApprovals.has(SESSION_ID)).toBe(true)
    return store
  }

  it('keeps the approval card when a gateway resolution failed', async () => {
    const store = storeWithPendingApproval()

    const payload = await forwardRuntimeApproval({
      event: 'approval.resolved',
      run_id: 'run-bridge',
      approval_id: APPROVAL_ID,
      choice: 'once',
      resolved: false,
    })
    chatApi.globalPendingHandler?.({ ...payload, event: 'approval.resolved', session_id: SESSION_ID })

    // The card staying up is the user-visible outcome, so it is asserted first:
    // on the unfixed forwarder the card is gone by this point.
    expect(store.pendingApprovals.get(SESSION_ID)).toMatchObject({ approvalId: APPROVAL_ID })
    expect(payload.resolved).toBe(false)
  })

  it('reports the expiry when a failed gateway resolution is also stale', async () => {
    const store = storeWithPendingApproval()
    const expired = vi.fn()
    window.addEventListener('hermes:pending-interaction-expired', expired)
    expect(store.respondApprovalFor(SESSION_ID, APPROVAL_ID, 'once')).toBe('submitted')

    const payload = await forwardRuntimeApproval({
      event: 'approval.resolved',
      run_id: 'run-bridge',
      approval_id: APPROVAL_ID,
      choice: 'once',
      resolved: false,
    })
    chatApi.globalPendingHandler?.({
      ...payload,
      event: 'approval.resolved',
      session_id: SESSION_ID,
      stale: true,
      error: 'Approval is no longer pending.',
    })

    // Without the outcome the card is dropped silently: it disappears either
    // way, but only the fixed forwarder reaches the expiry notice.
    expect(expired).toHaveBeenCalledTimes(1)
    expect(store.pendingApprovals.has(SESSION_ID)).toBe(false)
    expect(payload.resolved).toBe(false)
    window.removeEventListener('hermes:pending-interaction-expired', expired)
  })

  it('publishes a successful gateway resolution and dismisses the approval card', async () => {
    const store = storeWithPendingApproval()

    const payload = await forwardRuntimeApproval({
      event: 'approval.resolved',
      run_id: 'run-bridge',
      approval_id: APPROVAL_ID,
      choice: 'once',
      resolved: true,
    })
    chatApi.globalPendingHandler?.({ ...payload, event: 'approval.resolved', session_id: SESSION_ID })

    // The card is dismissed with or without the fix here; the forwarded true is
    // what discriminates, so it is asserted first.
    expect(payload.resolved).toBe(true)
    expect(store.pendingApprovals.has(SESSION_ID)).toBe(false)
  })

  it('dismisses the approval card for an older runtime that reports no outcome (control)', async () => {
    const store = storeWithPendingApproval()

    const payload = await forwardRuntimeApproval({
      event: 'approval.resolved',
      run_id: 'run-bridge',
      approval_id: APPROVAL_ID,
      choice: 'once',
    })
    chatApi.globalPendingHandler?.({ ...payload, event: 'approval.resolved', session_id: SESSION_ID })

    expect('resolved' in payload).toBe(false)
    expect(store.pendingApprovals.has(SESSION_ID)).toBe(false)
  })

  // The chat view answers an approval through respondApproval(), which dismisses
  // the card locally as soon as the choice is sent. The failed resolution then
  // arrives with nothing pending for the session, so clearPendingApproval takes
  // its `!current` early return — a branch that only notifies when the event
  // says resolved === false, which is precisely what the forwarder now sends.
  it('reports the expiry after the view already dismissed the card on submit', async () => {
    const store = storeWithPendingApproval()
    const expired = vi.fn()
    window.addEventListener('hermes:pending-interaction-expired', expired)

    expect(store.respondApproval('once')).toBe('submitted')
    expect(store.pendingApprovals.has(SESSION_ID)).toBe(false)

    const payload = await forwardRuntimeApproval({
      event: 'approval.resolved',
      run_id: 'run-bridge',
      approval_id: APPROVAL_ID,
      choice: 'once',
      resolved: false,
    })
    chatApi.globalPendingHandler?.({
      ...payload,
      event: 'approval.resolved',
      session_id: SESSION_ID,
      stale: true,
      error: 'Approval is no longer pending.',
    })

    // On the unfixed forwarder the payload carries no outcome, the early return
    // notifies nobody, and the user is left believing the command was allowed.
    expect(expired).toHaveBeenCalledTimes(1)
    expect(payload.resolved).toBe(false)
    window.removeEventListener('hermes:pending-interaction-expired', expired)
  })

  // Same early-return branch, successful resolution: there is nothing pending
  // and nothing to tell the user, with or without the fix.
  it('stays silent after a submit-dismissed card resolves successfully (control)', async () => {
    const store = storeWithPendingApproval()
    const expired = vi.fn()
    window.addEventListener('hermes:pending-interaction-expired', expired)

    expect(store.respondApproval('once')).toBe('submitted')

    const payload = await forwardRuntimeApproval({
      event: 'approval.resolved',
      run_id: 'run-bridge',
      approval_id: APPROVAL_ID,
      choice: 'once',
      resolved: true,
    })
    chatApi.globalPendingHandler?.({
      ...payload,
      event: 'approval.resolved',
      session_id: SESSION_ID,
      stale: true,
      error: 'Approval is no longer pending.',
    })

    expect(expired).not.toHaveBeenCalled()
    expect(store.pendingApprovals.has(SESSION_ID)).toBe(false)
    window.removeEventListener('hermes:pending-interaction-expired', expired)
  })
})
