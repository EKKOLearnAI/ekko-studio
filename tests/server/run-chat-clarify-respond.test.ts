vi.mock('../../packages/server/src/modules/studio/repositories/person-session-store', () => ({ personSessionIds: (userId: number) => userId === 1 ? ['person-main-1'] : [] }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/services/person/presence', () => ({ observePersonPresenceEvent: vi.fn() }))

const personDeliveryCurrentMock = vi.hoisted(() => vi.fn(() => true))
const finishPersonDeliveryMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/services/person/delivery', () => ({ personDeliveryCurrent: personDeliveryCurrentMock, finishPersonDelivery: finishPersonDeliveryMock, cancelPersonDelivery: vi.fn() }))
const personInteractionMock = vi.hoisted(() => vi.fn(() => undefined as any))
vi.mock('../../packages/server/src/modules/studio/services/person/chat-interactions', () => ({ personChatInteraction: personInteractionMock, answerPersonChatInteraction: vi.fn(), answerPersonTaskInteraction: vi.fn() }))
const ownedTaskSessionMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/services/person/task-chat', () => ({ ownedPersonTaskSession: ownedTaskSessionMock }))
const bridgeMock = vi.hoisted(() => ({
  clarifyRespond: vi.fn(),
  statusIfLoaded: vi.fn(),
}))
const respondToEkkoClarificationMock = vi.hoisted(() => vi.fn())
const pendingEkkoInteractionsMock = vi.hoisted(() => vi.fn(() => [] as any[]))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/modules/ekko/services/clarifications', () => ({
  respondToEkkoClarification: respondToEkkoClarificationMock,
  waitForEkkoClarification: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({ start: vi.fn(async () => {}), ensureReady: vi.fn() })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: {
    resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
    resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
    stop: vi.fn(),
  },
  handleChatCodingAgentSessionCommand: vi.fn(),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: vi.fn() })),
  respondToChatEkkoToolApproval: vi.fn(() => ({ handled: false, resolved: false })),
  respondToChatEkkoClarification: respondToEkkoClarificationMock,
  pendingChatEkkoInteractions: pendingEkkoInteractionsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const sessionStoreMock = vi.hoisted(() => ({
  getSessionNotificationPreview: vi.fn(() => null),
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default' })),
  getSessionMetadata: vi.fn(() => null),
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => sessionStoreMock)

vi.mock('../../packages/server/src/modules/studio/services/task-plans', () => ({ getSessionTaskPlans: vi.fn(() => []) }))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
  findUserById: vi.fn((id: number) => ({ id, username: `user${id}`, role: 'admin', status: 'active' })),
  listUserProfiles: vi.fn(() => [{ profile_name: 'default' }]),
}))

function createSocketHarness() {
  const handlers = new Map<string, Function>()
  const namespaceEmit = vi.fn()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => ({ emit: namespaceEmit })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = {
    of: vi.fn(() => namespace),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    data: {},
    handshake: { auth: {}, query: { profile: 'default' } },
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
    join: vi.fn(),
    emit: vi.fn(),
  }
  return { handlers, io, namespace, namespaceEmit, socket }
}

describe('ChatRunSocket clarify responses', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.resetModules()
    personInteractionMock.mockReset()
    pendingEkkoInteractionsMock.mockReset().mockReturnValue([])
    sessionStoreMock.getSession.mockReset()
    sessionStoreMock.getSession.mockReturnValue({ id: 'session-1', profile: 'default' })
    bridgeMock.clarifyRespond.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    respondToEkkoClarificationMock.mockReset()
    respondToEkkoClarificationMock.mockReturnValue({ handled: false, resolved: false })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
  })

  it.each([{ busy: true, flow: false }, { busy: false, flow: false }, { busy: true, flow: true }, { busy: false, flow: true }])('returns a Person background result through one original chat run (busy=$busy, flow=$flow)', async ({ busy, flow }) => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const sid = 'person-main-1'
    sessionStoreMock.getSession.mockReturnValue({ id: sid, profile: 'default', agent_preset: 'person', studio_user_id: '1' } as any)
    const state = { isWorking: busy, queue: [], events: [], messages: [{ role: 'user', content: 'Unrelated later turn' }] }
    ;(server as any).sessionMap.set(sid, state)
    personDeliveryCurrentMock.mockReturnValue(true)
    finishPersonDeliveryMock.mockClear()
    const handle = vi.spyOn(server as any, 'handleRun').mockImplementation(async (_socket: any, data: any) => { data.onEvent('run.completed', { output: 'Your report is ready' }) })
    const result = { user: { id: 1, username: 'user1', role: 'admin', profiles: ['default'] }, executionId: 'exec1', taskId: 'task1', title: 'Report', status: 'finished', output: '/tmp/report.txt', error: '',
      origin: { sessionId: sid, runId: 'original-run', messages: [{ role: 'user', content: 'Prepare report' }] },
      ...(flow ? { returnExpectation: '检查报告后按预设步骤移交', flow: { index: 0, total: 2, stopped: false, completed: false, next_session_id: 'person-main-design' } } : {}) }
    await server.deliverPersonResult(result as any)
    if (busy) {
      expect(handle).not.toHaveBeenCalled()
      await server.deliverPersonResult(result as any)
      expect(state.queue).toHaveLength(1)
      socket.data = { user: { id: 2 } } as any
      ;(server as any).dequeueNextQueuedRun(socket, sid)
    }
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1))
    const [ownerSocket, data, _profile, skip, context] = handle.mock.calls[0] as any[]
    expect(ownerSocket.data.user.id).toBe(1)
    expect(data).toMatchObject({ session_id: sid, display_input: null, background_delegation_id: 'person-result:exec1', autonomous: true })
    if (flow) {
      expect(data.input).toContain('检查报告后按预设步骤移交')
      expect(data.input).toContain('person-main-design')
      expect(data.input).toContain('bot_task_control advance')
      expect(context.messages).toHaveLength(2)
      expect(context.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('/tmp/report.txt') })
      expect(context.messages[1].content).not.toContain('检查报告后按预设步骤移交')
      expect(data.storage_message).toContain('检查报告后按预设步骤移交')
    } else expect(data.input).toContain('/tmp/report.txt')
    expect(skip).toBe(true)
    expect(context).toMatchObject({ originRunId: 'original-run', memoryPolicy: 'disabled' })
    expect(context.messages[0]).toEqual({ role: 'user', content: 'Prepare report' })
    expect(finishPersonDeliveryMock).toHaveBeenCalledWith(1, 'exec1', true, '')
  })

  it.each(['socket', 'group'])('round-trips MCP questions through the %s reply path and removes replay state', async surface => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket, namespaceEmit } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const state = { isWorking: true, activeRunMarker: 'mcp-turn', events: [], profile: 'default' }
    ;(server as any).sessionMap.set('session-1', state)
    ;(server as any).clarificationRuns.begin('mcp-context', 'session-1', 'default', () => state)
    ;(server as any).onConnection(socket)
    const result = server.requestClarification('mcp-context', 'default', { question: 'Which folder?', choices: ['client', 'server'] })
    const payload = namespaceEmit.mock.calls.find(call => call[0] === 'clarify.requested')![1]
    expect(state.events).toContainEqual(expect.objectContaining({ event: 'clarify.requested' }))
    if (surface === 'socket') {
      await handlers.get('clarify.respond')?.({ session_id: 'session-1', clarify_id: payload.clarify_id, response: 'custom-folder' })
    } else {
      expect(server.respondCodingAgentClarification('session-1', payload.clarify_id, 'custom-folder')).toBe(true)
    }
    await expect(result).resolves.toMatchObject({ response: 'custom-folder', reason: 'response' })
    expect(state.events).not.toContainEqual(expect.objectContaining({ event: 'clarify.requested' }))
    expect(respondToEkkoClarificationMock).not.toHaveBeenCalled()
    expect(bridgeMock.clarifyRespond).not.toHaveBeenCalled()
  })

  it('resumes and answers Person requests from the live broker after event history is trimmed', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket, handlers } = createSocketHarness()
    const server: any = new ChatRunSocket(io as any)
    const sid = 'person-main-1'
    sessionStoreMock.getSession.mockReturnValue({ id: sid, profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', studio_user_id: '1' } as any)
    socket.data = { user: { id: 1, role: 'admin' } } as any
    const state = { isWorking: true, runId: 'turn', profile: 'default', messages: [], queue: [],
      events: Array.from({length:200},()=>({event:'message.delta',data:{delta:'text'}})) }
    server.sessionMap.set(sid,state)
    vi.spyOn(server, 'backgroundPendingCount').mockReturnValue(0)
    const request = {event:'clarify.requested',data:{event:'clarify.requested',session_id:sid,clarify_id:'live',question:'Which?',timeout_ms:30000,requested_at:Date.now()}}
    pendingEkkoInteractionsMock.mockImplementation(id => id === sid ? [request] : [])
    server.onConnection(socket)
    await handlers.get('resume')!({session_id:sid})
    const resumed = socket.emit.mock.calls.find(([event])=>event==='resumed')![1]
    expect(resumed.events.filter((entry:any)=>entry.event==='clarify.requested')).toEqual([expect.objectContaining({data:expect.objectContaining({clarify_id:'live',remaining_timeout_ms:expect.any(Number)})})])
    respondToEkkoClarificationMock.mockReturnValue({handled:true,resolved:true})
    expect(await server.respondPersonInteraction(sid,'unknown','A',false)).toBe(false)
    expect(respondToEkkoClarificationMock).not.toHaveBeenCalled()
    expect(await server.respondPersonInteraction(sid,'live','A',false)).toBe(true)
    expect(respondToEkkoClarificationMock).toHaveBeenCalledWith(sid,'live','A')
  })

  it('routes Person answers through the live question and hides pending prompts from profile subscribers', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, namespace } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const id = 'person-task-private'
    const state = { isWorking: true, activeRunMarker: 'person-turn', events: [], profile: 'default' }
    ;(server as any).sessionMap.set(id, state)
    ;(server as any).clarificationRuns.begin('person-context', id, 'default', () => state)
    const events: any[] = []
    ;(server as any).runWaiters.set(id, new Set([(event: string, payload: any) => events.push({event,payload})]))
    const result = server.requestClarification('person-context', 'default', { question: 'Which result?' })
    const question = events.find(e => e.event === 'clarify.requested').payload
    expect(namespace.to.mock.calls.flat()).not.toContain('pending-interactions:default')
    expect(await server.respondPersonInteraction(id, question.clarify_id, '42', false)).toBe(true)
    await expect(result).resolves.toMatchObject({ response:'42',reason:'response' })
    expect(await server.respondPersonInteraction(id, question.clarify_id, '43', false)).toBe(false)
  })

  it('settles MCP questions when a coding run stops and rejects expired contexts', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const state = { isWorking: true, activeRunMarker: 'mcp-turn', events: [], profile: 'default' }
    ;(server as any).sessionMap.set('session-1', state)
    ;(server as any).clarificationRuns.begin('mcp-context', 'session-1', 'default', () => state)
    const result = server.requestClarification('mcp-context', 'default', { question: 'Q' })
    server.emitExternalEvent('session-1', 'abort.completed', {})
    await expect(result).resolves.toMatchObject({ reason: 'cancelled' })
    expect(() => server.requestClarification('mcp-context', 'default', { question: 'Old Q' })).toThrow('expired')
  })

  it('defers background Person decisions during the foreground turn and publishes only to owner session and notification rooms', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, namespace, namespaceEmit } = createSocketHarness()
    const sid = 'person-main-1'
    sessionStoreMock.getSession.mockReturnValue({ id: sid, studio_user_id: '1', profile: 'default' } as any)
    const pending = { event: 'clarify.requested', data: { event: 'clarify.requested', session_id: sid, clarify_id: 'person-interaction:q:0', question: 'Which report?', choices: [], durable: true } }
    personInteractionMock.mockReturnValue(pending)
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set(sid, { isWorking: true, events: [] })
    ;(server as any).syncPersonInteraction(1)
    expect(namespaceEmit.mock.calls.map(call => call[0])).toEqual(['person.updated', 'person.updated'])
    ;(server as any).sessionMap.get(sid).isWorking = false
    ;(server as any).syncPersonInteraction(1)
    expect(namespaceEmit).toHaveBeenCalledWith('clarify.requested', expect.objectContaining({ session_id: sid, durable: true }))
    expect(namespaceEmit).toHaveBeenCalledWith('person.clarification.requested', expect.objectContaining({ session_id: sid, durable: true }))
    expect(namespace.to.mock.calls.every(call => [`session:${sid}`, 'person-notifications:1'].includes(call[0]))).toBe(true)
    personInteractionMock.mockReturnValue(undefined)
    ;(server as any).syncPersonInteraction(1)
    expect(namespaceEmit).toHaveBeenCalledWith('clarify.resolved', expect.objectContaining({ clarify_id: 'person-interaction:q:0', resolved: true }))
    expect(namespaceEmit).toHaveBeenCalledWith('person.clarification.resolved', expect.objectContaining({ clarify_id: 'person-interaction:q:0', resolved: true }))
  })

  it('rejects another account reading, running or answering a hidden Person session even on the same Profile', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = createSocketHarness()
    ;(socket as any).data.user = { id: 2, role: 'super_admin', username: 'other' }
    sessionStoreMock.getSession.mockReturnValue({ id: 'person-main-1', profile: 'default', studio_user_id: '1' } as any)
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    await handlers.get('run')!({ session_id: 'person-main-1', input: 'Read private context', coding_agent_id: 'ekko-agent' })
    expect(socket.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'Session not found' }))
    await handlers.get('resume')!({ session_id: 'person-main-1' })
    expect(socket.join).not.toHaveBeenCalledWith('session:person-main-1')
    await handlers.get('clarify.respond')!({ session_id: 'person-main-1', clarify_id: 'q', response: 'Yes' })
    expect(socket.emit).toHaveBeenCalledWith('clarify.resolved', expect.objectContaining({ resolved: false, error: 'Session not found' }))
    expect(respondToEkkoClarificationMock).not.toHaveBeenCalled()
  })

  it('resumes owned task history but rejects direct run and unowned resume', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = createSocketHarness()
    ;(socket as any).data.user = { id: 1, role: 'admin', username: 'owner' }
    ownedTaskSessionMock.mockImplementation((userId, id) => {
      if (userId !== 1 || id !== 'person-task-owned') throw new Error('Session not found')
      return { session: { id, profile: 'default' } }
    })
    const server = new ChatRunSocket(io as any)
    const resume = vi.spyOn(server as any, 'resumeSession').mockResolvedValue(undefined)
    ;(server as any).onConnection(socket)
    await handlers.get('resume')!({ session_id: 'person-task-owned' })
    expect(socket.join).toHaveBeenCalledWith('session:person-task-owned')
    expect(resume).toHaveBeenCalledWith(socket, 'person-task-owned')
    await handlers.get('run')!({ session_id: 'person-task-owned', input: 'Bypass task scheduler', coding_agent_id: 'ekko-agent' })
    expect(socket.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'Session not found' }))
    await handlers.get('resume')!({ session_id: 'person-task-other' })
    expect(socket.join).not.toHaveBeenCalledWith('session:person-task-other')
  })

  it('allows the owner to answer Person on a different current Profile through the standard responder', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = createSocketHarness()
    ;(socket as any).data.user = { id: 1, role: 'admin', username: 'owner' }
    sessionStoreMock.getSession.mockReturnValue({ id: 'person-main-1', profile: 'model-resource', studio_user_id: '1' } as any)
    respondToEkkoClarificationMock.mockReturnValueOnce({ handled: true, resolved: true })
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')!({ session_id: 'person-main-1', clarify_id: 'q', response: 'Weekly' })
    expect(respondToEkkoClarificationMock).toHaveBeenCalledWith('person-main-1', 'q', 'Weekly')
  })

  it('routes Ekko clarification responses without calling the Hermes bridge', async () => {
    respondToEkkoClarificationMock.mockReturnValueOnce({ handled: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'ekko-clarify-1',
      response: 'B',
    })

    expect(respondToEkkoClarificationMock).toHaveBeenCalledWith(
      'session-1',
      'ekko-clarify-1',
      'B',
    )
    expect(bridgeMock.clarifyRespond).not.toHaveBeenCalled()
  })

  it('forwards clarify.respond events to the bridge and emits clarify.resolved', async () => {
    bridgeMock.clarifyRespond.mockResolvedValue({ ok: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, namespace, namespaceEmit, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option A',
    })

    expect(bridgeMock.clarifyRespond).toHaveBeenCalledWith('clarify-1', 'Use option A')
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
    expect(namespaceEmit).toHaveBeenCalledWith('clarify.resolved', {
      event: 'clarify.resolved',
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      resolved: true,
    })
  })

  it('does not replay answered clarify prompts when the session resumes', async () => {
    bridgeMock.clarifyRespond.mockResolvedValue({ ok: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const toolEvent = {
      event: 'tool.started',
      data: { event: 'tool.started', tool_call_id: 'tool-1' },
    }
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      events: [
        {
          event: 'clarify.requested',
          data: {
            event: 'clarify.requested',
            clarify_id: 'clarify-1',
            question: 'Pick one',
          },
        },
        toolEvent,
      ],
      queue: [],
    })

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option A',
    })
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect((server as any).sessionMap.get('session-1').events).toEqual([toolEvent])
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: true,
      events: [toolEvent],
    }))
  })

  it('emits an unresolved clarify result when the bridge rejects the response', async () => {
    bridgeMock.clarifyRespond.mockRejectedValue(new Error('unknown clarify request'))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, namespaceEmit, socket } = createSocketHarness()
    const namespace = {
      adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
      to: vi.fn(() => ({ emit: namespaceEmit })),
      use: vi.fn(),
      on: vi.fn(),
    }
    const server = new ChatRunSocket({ of: vi.fn(() => namespace) } as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option B',
    })

    expect(namespaceEmit).toHaveBeenCalledWith('clarify.resolved', {
      event: 'clarify.resolved',
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      resolved: false,
      error: 'unknown clarify request',
    })
  })
})
