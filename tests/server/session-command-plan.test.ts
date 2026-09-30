import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn()
const createSessionMock = vi.fn()
const getSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  clearSessionMessages: vi.fn(),
  createSession: createSessionMock,
  getSession: getSessionMock,
  renameSession: vi.fn(),
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildDbHistory: vi.fn(),
  estimateSnapshotAwareHistoryUsage: vi.fn(),
  forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: vi.fn((_map: Map<string, any>, sessionId: string) => _map.get(sessionId)),
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(),
  contextTokensWithCachedOverhead: vi.fn(),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({
  handleAbort: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

function makeContext(state: any, commandResult: Record<string, unknown> = {
  handled: true,
  message: '[IMPORTANT: expanded plan skill prompt]',
}) {
  const namespaceEmit = vi.fn()
  const nsp = {
    to: vi.fn(() => ({ emit: namespaceEmit })),
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    join: vi.fn(),
    emit: vi.fn(),
  }
  const sessionMap = new Map([['session-1', state]])
  const runQueuedItem = vi.fn()
  const bridge = {
    command: vi.fn(async () => commandResult),
    mcpReload: vi.fn(async () => ({ ok: true, message: 'MCP servers reloaded' })),
    reloadSkills: vi.fn(async () => ({
      ok: true,
      action: 'reload-skills',
      added: [{ name: 'demo-external-skill', description: 'Demo skill' }],
      removed: [],
      unchanged: [],
      total: 1,
      commands: 1,
    })),
    status: vi.fn(async () => ({
      exists: true,
      running: false,
      current_run_id: null,
      message_count: 0,
    })),
  }
  return { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket }
}

describe('plan session command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli' })
    readConfigYamlForProfileMock.mockResolvedValue({
      moa: {
        default_preset: 'default',
        presets: {
          default: {
            reference_models: [
              { provider: 'xai-oauth', model: 'grok-4.3' },
              { provider: 'custom:fun-codex', model: 'gpt-5.5' },
            ],
            aggregator: { provider: 'glm', model: 'glm-5.2' },
          },
        },
      },
    })
  })

  it('keeps the New Chat workspace and category when /plan is the first message (#2800)', async () => {
    getSessionMock.mockReturnValue(undefined)
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, nsp, runQueuedItem, sessionMap, socket } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/plan outline the next step')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      model: 'claude-opus-5-5',
      workspace: '/projects/ai-passport',
      categoryId: 4,
      runQueuedItem,
    })

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      workspace: '/projects/ai-passport',
      category_id: 4,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      displayInput: '/plan outline the next step',
      workspace: '/projects/ai-passport',
      categoryId: 4,
    }), 'default')
  })

  it('creates command sessions without workspace or category when the run has none', async () => {
    getSessionMock.mockReturnValue(undefined)
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, nsp, runQueuedItem, sessionMap, socket } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')

    await handleSessionCommand('session-1', parseSessionCommand('/plan x')!, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    const created = createSessionMock.mock.calls[0][0]
    expect(created).not.toHaveProperty('workspace')
    expect(created).not.toHaveProperty('category_id')
    expect(runQueuedItem.mock.calls[0][2]).not.toHaveProperty('workspace')
    expect(runQueuedItem.mock.calls[0][2]).not.toHaveProperty('categoryId')
  })

  it('queues running plan commands once without visible command echo', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/plan build the feature')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'client-queue-id',
      runQueuedItem,
    })

    expect(addMessageMock).not.toHaveBeenCalled()
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'client-queue-id',
      input: '[IMPORTANT: expanded plan skill prompt]',
      displayInput: '/plan build the feature',
      displayRole: 'command',
      storageMessage: '/plan build the feature',
    })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queue_length: 1,
      queued_messages: [expect.objectContaining({
        id: 'client-queue-id',
        role: 'command',
        content: '/plan build the feature',
        queued: true,
      })],
    }))
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.anything())
  })

  it('queues running moa commands once without persisting an extra command message', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/moa 讨论下黄金走势')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'client-queue-id',
      runQueuedItem,
    })

    expect(addMessageMock).not.toHaveBeenCalled()
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'client-queue-id',
      input: '讨论下黄金走势',
      displayInput: '/moa 讨论下黄金走势',
      displayRole: 'command',
      storageMessage: '/moa 讨论下黄金走势',
      provider: 'moa',
      oneShotModel: true,
    })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queue_length: 1,
      queued_messages: [expect.objectContaining({
        id: 'client-queue-id',
        role: 'command',
        content: '/moa 讨论下黄金走势',
        queued: true,
      })],
    }))
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.anything())
  })

  it('emits moa preset model details when starting an idle moa command', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/moa 讨论下黄金走势')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: {} as any,
      profile: 'default',
      queueId: 'client-queue-id',
      runQueuedItem,
    })

    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'client-queue-id',
      input: '讨论下黄金走势',
      displayInput: '/moa 讨论下黄金走势',
      displayRole: 'command',
      storageMessage: '/moa 讨论下黄金走势',
      provider: 'moa',
      model: 'default',
      oneShotModel: true,
    }), 'default')
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'moa',
      started: true,
      preset: 'default',
      moa: {
        preset: 'default',
        reference_models: ['xai-oauth:grok-4.3', 'custom:fun-codex:gpt-5.5'],
        aggregator: 'glm:glm-5.2',
      },
    }))
  })

  it('passes /moa through when MoA is not configured for the profile', async () => {
    readConfigYamlForProfileMock.mockResolvedValueOnce({})
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/moa 讨论下黄金走势')!

    const handled = await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: {} as any,
      profile: 'default',
      queueId: 'client-queue-id',
      runQueuedItem,
    })

    expect(handled).toBe(false)
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(addMessageMock).not.toHaveBeenCalled()
    expect(namespaceEmit).not.toHaveBeenCalled()
  })

  it('creates a new slash-command session with a command-derived title', async () => {
    getSessionMock.mockReturnValueOnce(null)
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'set',
      message: 'Goal set.',
      kickoff_prompt: 'build a todo app',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/goal build a todo app')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      profile: 'default',
      source: 'cli',
      title: '[goal] build a todo app',
    }))
  })

  it('enables session YOLO before the first agent chat creates a bridge session', async () => {
    getSessionMock.mockReturnValueOnce(null)
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'yolo',
      action: 'yolo',
      enabled: true,
      message: '⚡ YOLO mode ON for this session — all commands auto-approved. Use with caution.',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/yolo')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'work',
      runQueuedItem,
    })

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      profile: 'work',
      source: 'cli',
      title: '[yolo]',
    }))
    expect(bridge.command).toHaveBeenCalledWith('session-1', 'yolo', 'work')
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'yolo',
      action: 'yolo',
      enabled: true,
      terminal: true,
    }))
  })

  it('toggles session YOLO immediately while an agent run is active', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'yolo',
      action: 'yolo',
      enabled: false,
      message: '⚠️ YOLO mode OFF for this session — dangerous commands will require approval.',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')

    await handleSessionCommand('session-1', parseSessionCommand('/yolo')!, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', 'yolo', 'default')
    expect(state.queue).toEqual([])
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'yolo',
      enabled: false,
      terminal: false,
    }))
  })

  it('starts an idle /skill command with expanded storage and visible command display', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'skill',
      message: '[IMPORTANT: expanded skill prompt]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/skill github-pr-review check PR 123')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'work',
      queueId: 'skill-queue-id',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', '/github-pr-review check PR 123', 'work')
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/skill github-pr-review check PR 123',
    }))
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      content: '[IMPORTANT: expanded skill prompt]',
    }))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'skill',
      started: true,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'skill-queue-id',
      input: '[IMPORTANT: expanded skill prompt]',
      displayInput: '/skill github-pr-review check PR 123',
      displayRole: 'command',
      storageMessage: '[IMPORTANT: expanded skill prompt]',
      profile: 'work',
    }), 'work')
  })

  it('queues /skill commands while the bridge session is running', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'skill',
      message: '[IMPORTANT: expanded skill prompt]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/skill review follow up')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'queued-skill',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(bridge.command).toHaveBeenCalledWith('session-1', '/review follow up', 'default')
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/skill review follow up',
    }))
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'queued-skill',
      input: '[IMPORTANT: expanded skill prompt]',
      displayInput: '/skill review follow up',
      displayRole: 'command',
      storageMessage: '[IMPORTANT: expanded skill prompt]',
    })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queued_messages: [expect.objectContaining({
        id: 'queued-skill',
        role: 'command',
        content: '/skill review follow up',
      })],
    }))
  })

  it('starts an idle /bundles command with optional user instructions', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'bundle',
      message: '[IMPORTANT: expanded bundle prompt]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/bundles review-team focus on auth')!

    expect(command).toMatchObject({ name: 'bundles', args: 'review-team focus on auth' })

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'work',
      queueId: 'bundle-queue-id',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', '/review-team focus on auth', 'work')
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'bundle',
      started: true,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'bundle-queue-id',
      input: '[IMPORTANT: expanded bundle prompt]',
      displayInput: '/bundles review-team focus on auth',
      displayRole: 'command',
      storageMessage: '[IMPORTANT: expanded bundle prompt]',
      profile: 'work',
    }), 'work')
  })

  it('queues /bundles commands while the bridge session is running', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'bundle',
      message: '[IMPORTANT: expanded bundle prompt]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')

    await handleSessionCommand('session-1', parseSessionCommand('/bundles review-team')!, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'queued-bundle',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'queued-bundle',
      displayInput: '/bundles review-team',
      input: '[IMPORTANT: expanded bundle prompt]',
    })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queued_messages: [expect.objectContaining({
        id: 'queued-bundle',
        role: 'command',
        content: '/bundles review-team',
      })],
    }))
  })

  it('keeps skill and bundle command types separate', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'bundle',
      message: '[IMPORTANT: bundle prompt must not run as a skill]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')

    await handleSessionCommand('session-1', parseSessionCommand('/skill review-team')!, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      ok: false,
      action: 'error',
      message: '/review-team resolved to a Bundle. Use /bundles review-team instead.',
    }))
  })

  it('starts an idle /learn command with generated prompt input and command storage', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'learn',
      message: '[IMPORTANT: expanded learn prompt]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/learn from docs/workflow.md')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'work',
      queueId: 'learn-queue-id',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', '/learn from docs/workflow.md', 'work')
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/learn from docs/workflow.md',
    }))
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      content: '[IMPORTANT: expanded learn prompt]',
    }))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'learn',
      started: true,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'learn-queue-id',
      input: '[IMPORTANT: expanded learn prompt]',
      displayInput: '/learn from docs/workflow.md',
      displayRole: 'command',
      storageMessage: '/learn from docs/workflow.md',
      profile: 'work',
    }), 'work')
  })

  it('queues /learn commands while the bridge session is running', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'learn',
      message: '[IMPORTANT: expanded learn prompt]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/learn the workflow we just performed')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'queued-learn',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(bridge.command).toHaveBeenCalledWith('session-1', '/learn the workflow we just performed', 'default')
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/learn the workflow we just performed',
    }))
    expect(state.queue).toEqual([expect.objectContaining({
      queue_id: 'queued-learn',
      input: '[IMPORTANT: expanded learn prompt]',
      displayInput: '/learn the workflow we just performed',
      displayRole: 'command',
      storageMessage: '/learn the workflow we just performed',
    })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queued_messages: [expect.objectContaining({
        id: 'queued-learn',
        role: 'command',
        content: '/learn the workflow we just performed',
      })],
    }))
  })

  it('accepts bare /learn and sends an empty argument to the bridge', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: true,
      type: 'learn',
      message: '[IMPORTANT: expanded bare learn prompt]',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/learn')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'bare-learn',
      runQueuedItem,
    })

    expect(command).toEqual(expect.objectContaining({ name: 'learn', rawName: 'learn', args: '' }))
    expect(bridge.command).toHaveBeenCalledWith('session-1', '/learn', 'default')
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'bare-learn',
      input: '[IMPORTANT: expanded bare learn prompt]',
      displayInput: '/learn',
      storageMessage: '/learn',
    }), 'default')
  })

  it('reports unsupported /learn without starting a run', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, {
      handled: false,
      type: 'learn',
      message: '/learn requires a newer Hermes Agent runtime with agent.learn_prompt.',
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/learn from docs')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', '/learn from docs', 'default')
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'learn',
      ok: false,
      action: 'learn',
      message: '/learn requires a newer Hermes Agent runtime with agent.learn_prompt.',
    }))
  })

  it('keeps the client known-command registry accepted by the server parser', async () => {
    const { BRIDGE_SESSION_COMMAND_NAMES, isKnownBridgeSessionCommand } = await import('../../packages/client/src/utils/hermes/bridge-session-commands')
    const { parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')

    for (const commandName of BRIDGE_SESSION_COMMAND_NAMES) {
      expect(isKnownBridgeSessionCommand(`/${commandName}`)).toBe(true)
      const parsed = parseSessionCommand(`/${commandName}`)
      expect(parsed).not.toBeNull()
      if (commandName === 'fork') {
        expect(parsed).toEqual(expect.objectContaining({ name: 'branch', rawName: 'fork' }))
      } else if (commandName === 'compact') {
        expect(parsed).toEqual(expect.objectContaining({ name: 'compress', rawName: 'compact' }))
      } else {
        expect(parsed).toEqual(expect.objectContaining({ name: commandName }))
      }
    }

    expect(isKnownBridgeSessionCommand('/reload_skills')).toBe(true)
    expect(isKnownBridgeSessionCommand('/learn something')).toBe(true)
    expect(parseSessionCommand('/learn from docs')).toEqual(expect.objectContaining({
      name: 'learn',
      rawName: 'learn',
      args: 'from docs',
    }))
    expect(parseSessionCommand('/reload_skills')).toEqual(expect.objectContaining({
      name: 'reload-skills',
      rawName: 'reload_skills',
    }))
  })

  it('returns null for unknown slash commands so bridge runs can pass them through', async () => {
    const { isSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')

    expect(parseSessionCommand('/not-a-command test')).toBeNull()
    expect(isSessionCommand('/not-a-command test')).toBe(false)
  })

  it('starts an idle goal command as a hidden kickoff run', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'set',
      message: 'Goal set.',
      kickoff_prompt: 'fix the tests',
      max_turns: 20,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/goal fix the tests')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'goal-queue-id',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', 'goal fix the tests', 'default')
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'set',
      message: 'Goal set.',
      terminal: false,
      started: true,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'goal-queue-id',
      input: 'fix the tests',
      displayInput: null,
      storageMessage: 'fix the tests',
      source: 'cli',
    }), 'default')
  })

  it('clears queued goal continuations when pausing a goal', async () => {
    const state = {
      messages: [],
      isWorking: true,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue', displayInput: null, storageMessage: 'continue', profile: 'default', goalContinuation: true },
        { queue_id: 'user-1', input: 'user message', profile: 'default' },
      ],
    }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'pause',
      message: 'Goal paused.',
      clear_goal_continuations: true,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/goal pause')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([expect.objectContaining({ queue_id: 'user-1' })])
    expect(namespaceEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queue_length: 1,
      queued_messages: [expect.objectContaining({ id: 'user-1', content: 'user message' })],
    }))
  })

  it('emits a goal-specific clear action for goal done', async () => {
    const state = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue', displayInput: null, storageMessage: 'continue', profile: 'default', goalContinuation: true },
      ],
    }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'clear',
      message: 'Goal cleared.',
      clear_goal_continuations: true,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/goal done')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', 'goal done', 'default')
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'goal_clear',
      message: 'Goal cleared.',
      terminal: true,
      started: false,
    }))
  })

  it('starts a resumed goal as a hidden continuation run', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'resume',
      message: 'Goal resumed.',
      kickoff_prompt: '[Continuing toward your standing goal]\nGoal: fix the tests',
      max_turns: 20,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/goal resume')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      queueId: 'resume-queue-id',
      runQueuedItem,
    })

    expect(bridge.command).toHaveBeenCalledWith('session-1', 'goal resume', 'default')
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'resume',
      message: 'Goal resumed.',
      terminal: false,
      started: true,
    }))
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'resume-queue-id',
      input: '[Continuing toward your standing goal]\nGoal: fix the tests',
      displayInput: null,
      storageMessage: '[Continuing toward your standing goal]\nGoal: fix the tests',
      source: 'cli',
    }), 'default')
  })

  it('includes bridge run state in goal status output', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state, {
      handled: true,
      type: 'goal',
      action: 'goal_status',
      message: 'Goal (active, 0/20 turns): build docs',
    })
    bridge.status.mockResolvedValueOnce({
      exists: true,
      running: true,
      current_run_id: 'run-123',
      message_count: 4,
    })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/goal status')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'goal_status',
      message: 'Goal (active, 0/20 turns): build docs\nCurrent turn: 1/20 running (completed turns: 0/20; count updates after the judge).\nRun: running (run-123)',
      bridgeStatus: expect.objectContaining({
        running: true,
        currentRunId: 'run-123',
      }),
    }))
  })

  it('rejects MCP reload while the session is running', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/reload-mcp github')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(bridge.mcpReload).not.toHaveBeenCalled()
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'reload-mcp',
      ok: false,
      action: 'reload-mcp',
      terminal: false,
      message: 'MCP reload can only run while the session is idle. Wait for the current run to finish or abort it first.',
    }))
  })

  it('reloads skills while idle without queuing a model run', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/reload-skills')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(bridge.reloadSkills).toHaveBeenCalledWith('default')
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'reload-skills',
      action: 'reload-skills',
      message: 'Skills reloaded successfully.\nAdded skills:\n- demo-external-skill: Demo skill\nTotal skills: 1.',
    }))
  })

  it('rejects skills reload while the session is running', async () => {
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    const { bridge, namespaceEmit, runQueuedItem, sessionMap, socket, nsp } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const command = parseSessionCommand('/reload-skills')!

    await handleSessionCommand('session-1', command, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    expect(bridge.reloadSkills).not.toHaveBeenCalled()
    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'reload-skills',
      ok: false,
      action: 'reload-skills',
      terminal: false,
      message: 'Skills reload can only run while the session is idle. Wait for the current run to finish or abort it first.',
    }))
  })
})
