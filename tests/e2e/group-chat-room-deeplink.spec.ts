import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, TEST_MODEL_GROUP } from './fixtures'

type DesktopPlatform = 'darwin' | 'win32'

const baseRooms = [
  { id: 'room-alpha', name: 'Alpha Room', inviteCode: 'ALPHA1', canManage: true, workspace: '/tmp/alpha', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 123, summaryProfile: 'default', summaryProvider: 'test-provider', summaryModel: 'test-model', summaryApiMode: 'chat_completions', summaryEveryTurns: 20, allowGuestAgents: 1, maxGuestAgentsPerMember: 1, allowRemoteWorkspaceAccess: 0, agentHandoffEnabled: 1, agentHandoffMaxDepth: 4, agentHandoffUnlimited: 0, createdAt: 1_790_000_000, lastActiveAt: 1_790_000_001 },
  { id: 'room-beta', name: 'Beta Room', inviteCode: 'BETA22', canManage: true, workspace: '/tmp/beta', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 456, allowGuestAgents: 1, maxGuestAgentsPerMember: 1, allowRemoteWorkspaceAccess: 0, createdAt: 1_790_000_000, lastActiveAt: 1_790_000_100 },
  { id: 'room-readonly', name: 'Read Only Room', inviteCode: null, canManage: false, workspace: '/tmp/readonly', triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10, totalTokens: 0, createdAt: 1_789_999_999, lastActiveAt: 1_789_999_999 },
]

const groupWorkspaceDiff = {
  kind: 'workspace_diff',
  version: 1,
  room_id: 'room-alpha',
  parent_message_id: 'alpha-file',
  workspace: '/tmp/alpha',
  files_changed: 1,
  additions: 1,
  deletions: 1,
  truncated: false,
  files: [{
    id: 1,
    path: 'src/example.ts',
    change_type: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    truncated: false,
    patch: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
  }],
}

const messagesByRoom: Record<string, unknown[]> = {
  'room-alpha': [
    { id: 'alpha-msg', roomId: 'room-alpha', senderId: 'user-1', senderName: 'Alice', content: 'Alpha room message', timestamp: 1_790_000_000, role: 'user' },
    { id: 'alpha-file', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: '[package.json:2](/tmp/alpha/package.json#L2)', timestamp: 1_790_000_001, role: 'assistant' },
    { id: 'alpha-diff', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: JSON.stringify(groupWorkspaceDiff), timestamp: 1_790_000_002, role: 'tool', tool_name: 'workspace_diff', tool_call_id: 'workspace_diff:alpha' },
    { id: 'alpha-reasoning', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: 'Reasoning is available on demand.', reasoning: 'Inspecting several possible approaches.', isStreaming: true, timestamp: 1_790_000_003, role: 'assistant' },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `alpha-live-tool-${index + 1}`,
      roomId: 'room-alpha',
      senderId: 'agent-1',
      senderName: 'Worker',
      content: JSON.stringify({ result: `live-${index + 1}` }),
      timestamp: 1_790_000_010 + index,
      role: 'tool',
      run_id: 'run-live-tools',
      tool_name: `live_tool_${index + 1}`,
      tool_call_id: `live-call-${index + 1}`,
      ...(index === 11 ? { isStreaming: true } : {}),
    })),
    { id: 'alpha-live-answer', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: 'Live run remains in progress.', timestamp: 1_790_000_030, role: 'assistant', run_id: 'run-live-tools', isStreaming: true },
    { id: 'alpha-history-tool', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: '{"result":"history"}', timestamp: 1_790_000_040, role: 'tool', run_id: 'run-history-tools', tool_name: 'historical_tool', tool_call_id: 'history-call' },
    { id: 'alpha-history-answer', roomId: 'room-alpha', senderId: 'agent-1', senderName: 'Worker', content: 'Historical run finished.', timestamp: 1_790_000_041, role: 'assistant', run_id: 'run-history-tools' },
  ],
  'room-beta': [
    { id: 'beta-msg', roomId: 'room-beta', senderId: 'user-1', senderName: 'Bob', content: 'Beta room message', timestamp: 1_790_000_100, role: 'user' },
  ],
}

const agentsByRoom: Record<string, unknown[]> = {
  'room-alpha': [
    {
      id: 'agent-row-1',
      roomId: 'room-alpha',
      agentId: 'agent-1',
      agent: 'hermes',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: '',
      reasoningEffort: '',
      name: 'Worker',
      description: 'Group agent',
      avatar: '',
      invited: 1,
    },
  ],
  'room-beta': [
    {
      id: 'agent-row-runtime',
      roomId: 'room-beta',
      agentId: 'agent-runtime',
      agent: 'hermes',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: '',
      reasoningEffort: '',
      name: 'Runtime Worker',
      description: 'Runtime group agent',
      avatar: '',
      invited: 1,
    },
  ],
}

async function mockGroupChatApi(page: Page, offlinePresence = false) {
  const rooms = baseRooms.map(room => ({ ...room }))
  let roomMessages = structuredClone(messagesByRoom)
  const roomDetailRequests: Array<{ roomId: string, offset: number, limit: number, before: string, history: boolean }> = []
  const roomDetailFailures = new Map<string, number>()
  const roomDetailDelays = new Map<string, number>()
  const inviteCodeUpdates: Array<{ roomId: string, body: unknown }> = []
  const guestAgentPolicyUpdates: Array<{ roomId: string, body: any }> = []
  const roomConfigUpdates: Array<{ roomId: string, body: any }> = []
  const addedAgents: Array<{ roomId: string, body: any }> = []
  const createdRooms: any[] = []
  const presetOperations: Array<{ method: string, id?: string, body?: any }> = []
  let agentPresets = [{
    id: 'preset-reviewer',
    agent: 'codex',
    profile: 'default',
    provider: 'test-provider',
    model: 'test-model',
    apiMode: 'codex_responses',
    reasoningEffort: 'high',
    name: 'Preset Reviewer',
    description: 'Reviews changes',
    avatar: '',
    available: true,
    validationError: '',
    createdAt: 1,
    updatedAt: 1,
  }, {
    id: 'preset-unavailable',
    agent: 'codex',
    profile: 'missing-profile',
    provider: 'missing-provider',
    model: 'missing-model',
    apiMode: 'codex_responses',
    reasoningEffort: '',
    name: 'Unavailable Reviewer',
    description: 'Unavailable configuration',
    avatar: '',
    available: false,
    validationError: 'Profile "missing-profile" is unavailable',
    createdAt: 1,
    updatedAt: 1,
  }]
  const handoffChains = [{
    chainId: 'handoff:alpha-msg',
    roomId: 'room-alpha',
    sourceMessageId: 'alpha-msg',
    currentDepth: 4,
    maxDepth: 4,
    unlimited: 0,
    targetAgentId: 'agent-1',
    status: 'stopped',
    stopReason: 'max_depth',
    continueUsed: 0,
    createdAt: 1_790_000_002,
    updatedAt: 1_790_000_002,
  }]

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/'))) {
      await route.fallback()
      return
    }

    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (pathname === '/health') return json({ status: 'ok' })
    if (pathname === '/api/auth/status') return json({ hasPasswordLogin: false, username: null })
    if (pathname === '/api/hermes/runtime-versions/jobs' && request.method() === 'GET') return json({ jobs: [] })
    if (pathname === '/api/agents/status' && request.method() === 'GET') {
      return json({
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        agents: [
          { id: 'hermes', name: 'Hermes', provider: 'Nous Research', kind: 'hermes', installed: true, version: '0.19.1', source: 'user-cli', path: '/usr/local/bin/hermes', error: '', installations: [] },
          { id: 'ekko-agent', name: 'Ekko', provider: 'Ekko Studio', kind: 'built-in', installed: true, version: '0.7.0', source: 'built-in', path: '', error: '', installations: [] },
          { id: 'claude-code', name: 'Claude', provider: 'Anthropic', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/claude', error: '', installations: [] },
          { id: 'codex', name: 'Codex', provider: 'OpenAI', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/codex', error: '', installations: [] },
          { id: 'pi', name: 'Pi', provider: 'Pi', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/pi', error: '', installations: [] },
          { id: 'grok', name: 'Grok', provider: 'xAI', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/grok', error: '', installations: [] },
          { id: 'dsh', name: 'DeepSeek Harness', provider: 'DeepSeek', kind: 'coding-agent', installed: true, version: '0.1.5-rc.1', source: 'user-cli', path: '/usr/local/bin/dsh', error: '', installations: [] },
        ],
      })
    }
    if (pathname === '/api/coding-agents/dsh/session-presets') return json({ presets: [
      { id: 'standard', name: 'Standard mode', isDefault: true },
      { id: 'minimal', name: 'Minimal mode', description: 'Minimal tools for this Agent.', isDefault: false },
    ] })
    if (pathname === '/api/hermes/profiles') return json({ profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test' }] })
    if (pathname === '/api/hermes/available-models') {
      return json({
        default: 'test-model',
        default_provider: 'test-provider',
        groups: [TEST_MODEL_GROUP],
        allProviders: [TEST_MODEL_GROUP],
        profiles: [{
          profile: 'default',
          default: 'test-model',
          default_provider: 'test-provider',
          groups: [TEST_MODEL_GROUP],
        }],
        model_aliases: {},
        model_visibility: {},
      })
    }
    if (pathname === '/api/studio/group-chat/agent-presets' && request.method() === 'GET') {
      return json({ presets: agentPresets })
    }
    if (pathname === '/api/studio/group-chat/agent-presets' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      presetOperations.push({ method: 'POST', body })
      const preset = { ...body, id: `preset-${agentPresets.length + 1}`, available: true, validationError: '', createdAt: 2, updatedAt: 2 }
      agentPresets = [preset, ...agentPresets]
      return json({ preset }, 201)
    }
    const presetMatch = pathname.match(/^\/api\/studio\/group-chat\/agent-presets\/([^/]+)$/)
    if (presetMatch && request.method() === 'PUT') {
      const body = JSON.parse(request.postData() || '{}')
      presetOperations.push({ method: 'PUT', id: presetMatch[1], body })
      const index = agentPresets.findIndex(item => item.id === presetMatch[1])
      const preset = { ...agentPresets[index], ...body, updatedAt: 3 }
      agentPresets[index] = preset
      return json({ preset })
    }
    if (presetMatch && request.method() === 'DELETE') {
      presetOperations.push({ method: 'DELETE', id: presetMatch[1] })
      agentPresets = agentPresets.filter(item => item.id !== presetMatch[1])
      return json({ success: true })
    }
    if (pathname === '/api/studio/group-chat/rooms' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      createdRooms.push(body)
      const room = { ...baseRooms[0], id: 'room-created', name: body.name, inviteCode: body.inviteCode }
      return json({ room, agents: [], agentResults: [] })
    }
    if (pathname === '/api/studio/group-chat/rooms') {
      return json({
        rooms: rooms.map(room => ({
          ...room,
          agents: (agentsByRoom[room.id] || []).map((agent: any) => ({
            id: agent.id,
            roomId: agent.roomId,
            agentId: agent.agentId,
            agent: agent.agent,
            name: agent.name,
            avatar: agent.avatar,
          })),
        })),
      })
    }

    const addAgentMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/agents$/)
    if (addAgentMatch && request.method() === 'POST') {
      const roomId = decodeURIComponent(addAgentMatch[1])
      const body = JSON.parse(request.postData() || '{}')
      addedAgents.push({ roomId, body })
      return json({ agent: { ...body, id: 'agent-from-preset', roomId, agentId: 'runtime-from-preset', invited: 0 } })
    }

    const handoffContinueMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/handoffs\/([^/]+)\/continue$/)
    if (handoffContinueMatch && request.method() === 'POST') {
      const chain = handoffChains.find(item => item.roomId === decodeURIComponent(handoffContinueMatch[1])
        && item.chainId === decodeURIComponent(handoffContinueMatch[2]))
      if (!chain) return json({ error: 'Handoff chain not found' }, 404)
      Object.assign(chain, {
        status: 'claimed',
        attemptId: 'attempt-1',
        updatedAt: chain.updatedAt + 1,
      })
      return json({ success: true, attemptId: chain.attemptId, status: 'continuing', chain }, 202)
    }

    const handoffListMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/handoffs$/)
    if (handoffListMatch && request.method() === 'GET') {
      const roomId = decodeURIComponent(handoffListMatch[1])
      const room = rooms.find(item => item.id === roomId)
      return json({
        chains: handoffChains.filter(item => item.roomId === roomId
          && item.status === 'stopped'
          && !item.continueUsed
          && Number(room?.agentHandoffEnabled ?? 1) === 1
          && Number(room?.agentHandoffUnlimited ?? 0) === 0
          && item.maxDepth === Number(room?.agentHandoffMaxDepth ?? 4)),
      })
    }

    const configMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/config$/)
    if (configMatch && request.method() === 'PUT') {
      const roomId = decodeURIComponent(configMatch[1])
      const body = JSON.parse(request.postData() || '{}')
      const room = rooms.find(r => r.id === roomId)
      if (!room || !room.canManage) return json({ error: 'Forbidden' }, 403)
      roomConfigUpdates.push({ roomId, body })
      Object.assign(room, {
        ...(typeof body.agentHandoffEnabled === 'boolean' ? { agentHandoffEnabled: body.agentHandoffEnabled ? 1 : 0 } : {}),
        ...(body.agentHandoffMaxDepth !== undefined ? { agentHandoffMaxDepth: body.agentHandoffMaxDepth } : {}),
        ...(typeof body.agentHandoffUnlimited === 'boolean' ? { agentHandoffUnlimited: body.agentHandoffUnlimited ? 1 : 0 } : {}),
      })
      return json({ room })
    }

    const inviteCodeMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/invite-code$/)
    if (inviteCodeMatch && request.method() === 'PUT') {
      const roomId = decodeURIComponent(inviteCodeMatch[1])
      const body = JSON.parse(request.postData() || '{}')
      inviteCodeUpdates.push({ roomId, body })
      const room = rooms.find(r => r.id === roomId)
      if (!room || !room.canManage) return json({ error: 'Forbidden' }, 403)
      if (body.inviteCode === 'FAILCODE') return json({ error: 'duplicate invite code' }, 409)
      room.inviteCode = body.inviteCode
      return json({ success: true })
    }

    const guestAgentPolicyMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/guest-agent-policy$/)
    if (guestAgentPolicyMatch && request.method() === 'PUT') {
      const roomId = decodeURIComponent(guestAgentPolicyMatch[1])
      const body = JSON.parse(request.postData() || '{}')
      guestAgentPolicyUpdates.push({ roomId, body })
      const room = rooms.find(r => r.id === roomId)
      if (!room || !room.canManage) return json({ error: 'Forbidden' }, 403)
      const policy = {
        allowGuestAgents: body.allowGuestAgents ? 1 : 0,
        guestAgentApproval: 'owner',
        maxGuestAgentsPerMember: body.maxGuestAgentsPerMember,
        allowRemoteWorkspaceAccess: body.allowGuestAgents && body.allowRemoteWorkspaceAccess ? 1 : 0,
      }
      Object.assign(room, policy)
      return json({ policy })
    }

    const workspaceListMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/workspace-files\/list$/)
    if (workspaceListMatch) {
      return json({
        entries: [{ name: 'package.json', path: 'package.json', absolutePath: '/tmp/alpha/package.json', isDir: false, size: 25, modTime: '2026-07-17T00:00:00.000Z' }],
        path: '',
        absolutePath: '/tmp/alpha',
      })
    }

    const contentMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)\/workspace-file\/content$/)
    if (contentMatch) {
      return route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: '{\n  "name": "group-preview"\n}\n',
      })
    }

    const detailMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)$/)
    if (detailMatch) {
      const roomId = decodeURIComponent(detailMatch[1])
      const room = rooms.find(r => r.id === roomId)
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      const limit = Math.min(150, Math.max(1, Number(url.searchParams.get('limit')) || 150))
      const before = url.searchParams.get('before') || ''
      const history = url.searchParams.get('history') === '1'
      roomDetailRequests.push({ roomId, offset, limit, before, history })
      const failureKey = `${roomId}:${before || offset}`
      const delay = roomDetailDelays.get(failureKey) || 0
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      const remainingFailures = roomDetailFailures.get(failureKey) || 0
      if (remainingFailures > 0) {
        roomDetailFailures.set(failureKey, remainingFailures - 1)
        return json({ error: 'Temporary history failure' }, 500)
      }
      const agents = (agentsByRoom[roomId] || []).map(agent => (
        offlinePresence ? { ...(agent as object), connectionStatus: 'offline' } : agent
      ))
      const members = offlinePresence
        ? [{ id: 'member-offline', userId: 'user-offline', name: 'Offline Member', description: '', joinedAt: 1_790_000_000, connectionStatus: 'offline' }]
        : [{ id: 'member-1', userId: 'user-1', name: 'User One', description: '', joinedAt: 1_790_000_000 }]
      const allMessages = roomMessages[roomId] || []
      const cursorIndex = before
        ? allMessages.findIndex(message => (message as { id?: string }).id === before)
        : allMessages.length
      const end = Math.max(0, before ? cursorIndex : allMessages.length - offset)
      const start = Math.max(0, end - limit)
      const messages = allMessages.slice(start, end)
      const total = allMessages.length
      return room
        ? json({
            room,
            messages,
            agents,
            members,
            handoffChains: handoffChains.filter(item => item.roomId === roomId),
            total,
            offset,
            limit,
            hasMore: history ? start > 0 : offset + messages.length < total,
            historyTruncated: allMessages.length > 500,
          })
        : json({ error: 'Room not found' }, 404)
    }

    return json({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404)
  })

  return {
    inviteCodeUpdates,
    guestAgentPolicyUpdates,
    roomConfigUpdates,
    roomDetailRequests,
    addedAgents,
    createdRooms,
    presetOperations,
    failRoomDetail(roomId: string, offset: number, times = 1) {
      roomDetailFailures.set(`${roomId}:${offset}`, times)
    },
    failRoomHistoryBefore(roomId: string, before: string, times = 1) {
      roomDetailFailures.set(`${roomId}:${before}`, times)
    },
    delayRoomHistoryBefore(roomId: string, before: string, delayMs: number) {
      roomDetailDelays.set(`${roomId}:${before}`, delayMs)
    },
    setRoomMessages(messages: Record<string, unknown[]>) {
      roomMessages = structuredClone(messages)
    },
  }
}

async function mockGroupChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/**/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_GROUP_SOCKET__ || (window.__PW_GROUP_SOCKET__ = { sockets: [], emitted: [] })
state.executionQueues = state.executionQueues || {}
state.nextSocketId = state.nextSocketId || 1
const roomMessages = structuredClone(${JSON.stringify(messagesByRoom)})
const roomAgents = ${JSON.stringify(agentsByRoom)}
const roomNames = ${JSON.stringify(Object.fromEntries(baseRooms.map(room => [room.id, room.name])))}
function makeSocket(url, options) {
  const listeners = new Map()
  const socket = {
    connected: true,
    url,
    options,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    emit(event, payload, ack) {
      state.emitted.push({ event, payload })
      if (event === 'join' && typeof ack === 'function') {
        const roomId = payload && payload.roomId
        const retracted = new Set(JSON.parse(window.localStorage.getItem('__pw_group_retracted__') || '[]'))
        setTimeout(() => ack({ roomId, roomName: roomNames[roomId] || roomId, members: [], messages: [...(roomMessages[roomId] || []), ...(state.liveSnapshots?.[roomId] || [])].filter(message => !retracted.has(message.id)), agents: roomAgents[roomId] || [], rooms: [], typingUsers: [], contextStatuses: [], executionQueue: state.executionQueues[roomId] || [], ...(state.joinStates?.[roomId] || {}) }), state.joinDelays?.[roomId] || 0)
      }
      if (event === 'load_room_agent_activities' && typeof ack === 'function') {
        setTimeout(() => ack({ activities: [] }), 0)
      }
      if (event === 'message' && typeof ack === 'function') {
        const error = state.nextMessageError
        state.nextMessageError = ''
        setTimeout(() => ack(error ? { error } : { id: payload && payload.id }), 0)
      }
      if (event === 'cancel_execution_queue_item' && typeof ack === 'function') {
        const roomId = payload && payload.roomId
        const queueId = payload && payload.queueId
        const items = state.executionQueues[roomId] || []
        const selected = items.find(item => item.id === queueId)
        const siblings = selected ? items.filter(item => item.messageId === selected.messageId) : []
        if (!selected || siblings.some(item => item.status !== 'queued')) {
          setTimeout(() => ack({ error: 'Queue item is no longer cancellable' }), 0)
        } else {
          state.executionQueues[roomId] = items
            .filter(item => item.messageId !== selected.messageId)
            .map((item, index) => ({ ...item, position: index + 1 }))
          roomMessages[roomId] = (roomMessages[roomId] || []).filter(message => message.id !== selected.messageId)
          const retracted = new Set(JSON.parse(window.localStorage.getItem('__pw_group_retracted__') || '[]'))
          retracted.add(selected.messageId)
          window.localStorage.setItem('__pw_group_retracted__', JSON.stringify([...retracted]))
          for (const peer of state.sockets) peer.__trigger('message_retracted', { roomId, messageId: selected.messageId, totalTokens: 0 })
          for (const peer of state.sockets) peer.__trigger('execution_queue_updated', { roomId, items: state.executionQueues[roomId] })
          setTimeout(() => ack({ ok: true, status: 'retracted', messageId: selected.messageId }), 0)
        }
      }
      return this
    },
    removeAllListeners() {
      listeners.clear()
      return this
    },
    disconnect() {
      return this
    },
    __trigger(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
    },
  }
  state.sockets.push(socket)
  if (String(url).endsWith('/group-chat')) state.latest = socket
  return socket
}
export function io(url, options) {
  return makeSocket(url, options)
}
export default { io }
`,
    })
  })
}

async function installDesktopBridge(page: Page, platform: DesktopPlatform) {
  await page.addInitScript((desktopPlatform) => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        isDesktop: true,
        platform: desktopPlatform,
        getWindowState: async () => ({ isMaximized: false }),
        windowControl: async () => ({ isMaximized: false }),
      },
    })
  }, platform)
}

async function installMockVoiceCapture(page: Page) {
  await page.addInitScript(() => {
    const state = { recorderState: 'inactive' }
    ;(window as any).__PW_FAKE_GROUP_VOICE_CAPTURE__ = state
    class FakeMediaRecorder {
      static isTypeSupported() { return true }
      state = 'inactive'
      mimeType: string
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(_stream: unknown, options: { mimeType?: string } = {}) {
        this.mimeType = options.mimeType || 'audio/webm'
      }
      start() {
        this.state = 'recording'
        state.recorderState = 'recording'
      }
      stop() {
        this.state = 'inactive'
        state.recorderState = 'inactive'
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) })
          this.onstop?.()
        }, 0)
      }
    }
    const track = { stop() {} }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => stream },
    })
    window.localStorage.setItem('hermes-stt-settings-v1', JSON.stringify({
      provider: 'openai',
      openaiModel: 'gpt-4o-transcribe',
      openaiLanguage: '',
      openaiPrompt: '',
      customBaseUrl: '',
      customModel: 'gpt-4o-transcribe',
      customLanguage: '',
      customPrompt: '',
    }))
  })
}

async function setup(page: Page, path: string, platform?: DesktopPlatform, offlinePresence = false) {
  if (platform) await installDesktopBridge(page, platform)
  await page.addInitScript(() => {
    window.localStorage.setItem('hermes.groupChat.refactorNotice.v1.acknowledged', '1')
  })
  await authenticate(page)
  await mockGroupChatSocket(page)
  const api = await mockGroupChatApi(page, offlinePresence)
  await page.goto(path)
  return api
}

async function triggerGroupSocket(page: Page, event: string, payload: unknown) {
  await page.waitForFunction(() => Boolean((window as any).__PW_GROUP_SOCKET__?.sockets?.length))
  await page.evaluate(({ event, payload }) => {
    const sockets = (window as any).__PW_GROUP_SOCKET__?.sockets || []
    if (sockets.length === 0) throw new Error('Group chat socket is not connected')
    for (const socket of sockets) socket.__trigger(event, payload)
  }, { event, payload })
}

async function connectGroupSocket(page: Page) {
  await page.waitForFunction(() => Boolean((window as any).__PW_GROUP_SOCKET__?.sockets?.length))
  await page.evaluate(() => {
    const state = (window as any).__PW_GROUP_SOCKET__
    for (const socket of state.sockets) {
      if (String(socket.url).endsWith('/group-chat') && !socket.id) {
        socket.id = `pw-group-socket-${state.nextSocketId++}`
      }
    }
  })
  await triggerGroupSocket(page, 'connect', undefined)
}

test.describe('group chat room deep links', () => {
  // This file already covers multi-tab behavior explicitly; keeping the deep-link/socket fixture serial
  // avoids local fullyParallel races where early tests see the room list before route-room selection settles.
  test.describe.configure({ mode: 'serial' })

  test('route room id opens selected room', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-beta')

    await expect(page.locator('.room-title-text', { hasText: 'Beta Room' })).toBeVisible()
    await expect(page.getByText('Beta room message')).toBeVisible()
    expect((await page.locator('.run-card').first().boundingBox())?.width).toBeGreaterThanOrEqual(259)
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
  })

  test('keeps streaming Agent reasoning collapsed until explicitly expanded', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const message = page.locator('.group-message', { hasText: 'Reasoning is available on demand.' })
    await expect(message.locator('.thinking-block')).toBeVisible()
    await expect(message.locator('.thinking-body')).toHaveCount(0)
    await message.locator('.thinking-header').click()
    await expect(message.locator('.thinking-body')).toContainText('Inspecting several possible approaches.')
  })

  test('keeps the active Agent run tool list bounded and independently scrollable', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const panel = page.locator('.run-tool-list[data-agent-id="agent-1"][data-run-id="run-live-tools"]')
    const outer = page.locator('.group-message-list .virtual-message-list')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.tool-message')).toHaveCount(12)
    const historicalRun = page.locator('.group-agent-run[data-run-id="run-history-tools"]')
    const historicalToggle = historicalRun.locator('.tool-run-header')
    const historicalPanel = page.locator('.run-tool-list[data-run-id="run-history-tools"]')
    await expect(historicalToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(historicalPanel).toHaveCount(0)
    await historicalToggle.click()
    await expect(historicalPanel).toBeVisible()
    await expect(historicalPanel.locator('.tool-name')).toHaveText('historical_tool')
    await expect(historicalRun.locator('.run-card > .run-tools + .run-transcript')).toContainText('Historical run finished.')

    const dimensions = await panel.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    expect(dimensions.clientHeight).toBeLessThan(dimensions.scrollHeight)
    expect(dimensions.clientHeight).toBeGreaterThan(180)
    expect(dimensions.clientHeight).toBeLessThanOrEqual(360)

    await panel.hover()
    await expect.poll(async () => {
      const first = await outer.evaluate(element => element.scrollTop)
      await page.waitForTimeout(100)
      const second = await outer.evaluate(element => element.scrollTop)
      return second - first
    }).toBe(0)
    const outerBefore = await outer.evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, 120)
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await outer.evaluate(element => element.scrollTop)).toBe(outerBefore)

    await panel.focus()
    await expect(panel).toBeFocused()

    const toolNames = await panel.locator('.tool-name').allTextContents()
    expect(toolNames[0]).toBe('live_tool_12')
    expect(toolNames.at(-1)).toBe('live_tool_1')
  })

  test('keeps persistent room Agent grids stable while active runs glow the complete room avatar', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const activity = (overrides: Record<string, unknown> = {}) => ({
      roomId: 'room-alpha',
      agentId: 'agent-row-1',
      runId: 'run-live-tools',
      agentName: 'Worker',
      agent: 'hermes',
      avatar: '',
      status: 'replying',
      ...overrides,
    })
    const alphaRoom = page.locator('.room-item', { hasText: 'Alpha Room' })
    const betaRoom = page.locator('.room-item', { hasText: 'Beta Room' })
    const emptyRoom = page.locator('.room-item', { hasText: 'Read Only Room' })
    const alphaGrid = alphaRoom.locator('.room-agent-grid')
    const betaGrid = betaRoom.locator('.room-agent-grid')
    const emptyGrid = emptyRoom.locator('.room-agent-grid')
    const alphaInfoX = await alphaRoom.locator('.room-info').evaluate(element => element.getBoundingClientRect().x)
    const betaInfoX = await betaRoom.locator('.room-info').evaluate(element => element.getBoundingClientRect().x)

    await expect(alphaGrid).toHaveAttribute('data-agent-count', '1')
    await expect(betaGrid).toHaveAttribute('data-agent-count', '1')
    await expect(emptyGrid).toHaveAttribute('data-agent-count', '0')
    await expect(alphaGrid).not.toHaveClass(/is-active/)
    await expect(alphaGrid.locator('.room-agent-grid-cell.is-active')).toHaveCount(0)
    await expect(emptyGrid.locator('.room-agent-grid-neutral')).toHaveCount(1)
    await expect(alphaGrid).toHaveCSS('width', '36px')
    await expect(betaGrid).toHaveCSS('width', '36px')
    await expect(emptyGrid).toHaveCSS('width', '36px')
    const evidenceDir = process.env.HERMES_VISUAL_EVIDENCE_DIR
    if (evidenceDir) await alphaRoom.screenshot({ path: `${evidenceDir}/idle-room.png` })

    await triggerGroupSocket(page, 'room_agent_activity', activity())
    await triggerGroupSocket(page, 'room_agent_activity', activity({ runId: 'run-live-tools-2' }))
    const activeAlphaAgent = alphaGrid.locator('[data-agent-id="agent-row-1"]')
    const activeRunAvatar = page.locator('.group-agent-run[data-run-id="run-live-tools"] .run-avatar')
    await expect(alphaGrid).toHaveClass(/is-active/)
    await expect(alphaGrid).toHaveAttribute('aria-busy', 'true')
    await expect(activeAlphaAgent).not.toHaveClass(/is-active/)
    await expect(alphaGrid.locator('.room-agent-grid-cell.is-active')).toHaveCount(0)
    await expect(activeRunAvatar).toHaveClass(/run-avatar-active/)
    await expect(page.locator('.group-agent-run[data-run-id="run-history-tools"] .run-avatar')).not.toHaveClass(/run-avatar-active/)
    if (evidenceDir) {
      await alphaRoom.screenshot({ path: `${evidenceDir}/active-room-rainbow.png` })
      await activeRunAvatar.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${evidenceDir}/active-message-rainbow.png` })
    }
    await expect.poll(() => alphaGrid.evaluate((element) => {
      const glow = getComputedStyle(element, '::after')
      return {
        inset: glow.top,
        animation: glow.animationName,
        radius: glow.borderRadius,
        shadow: glow.boxShadow,
      }
    })).toMatchObject({
      inset: '-4px',
      animation: expect.stringContaining('room-avatar-rainbow-glow'),
      radius: '12px',
      shadow: expect.not.stringMatching(/^none$/),
    })
    await expect.poll(() => activeRunAvatar.evaluate((element) => {
      const avatar = getComputedStyle(element)
      const glow = getComputedStyle(element, '::before')
      return {
        avatarRadius: avatar.borderRadius,
        glowInset: glow.top,
        glowRadius: glow.borderRadius,
        glowAnimation: glow.animationName,
        glowShadow: glow.boxShadow,
      }
    })).toMatchObject({
      avatarRadius: '50%',
      glowInset: '-4px',
      glowRadius: '50%',
      glowAnimation: expect.stringContaining('run-avatar-rainbow-glow'),
      glowShadow: expect.not.stringMatching(/^none$/),
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => Promise.all([
      alphaGrid.evaluate(element => getComputedStyle(element, '::after').animationName),
      activeRunAvatar.evaluate(element => getComputedStyle(element, '::before').animationName),
      activeRunAvatar.evaluate(element => getComputedStyle(element, '::before').boxShadow),
    ])).toEqual(['none', 'none', expect.stringContaining('rgb(255, 107, 107)')])
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    await triggerGroupSocket(page, 'room_agent_activity', activity({
      roomId: 'room-beta',
      agentId: 'agent-row-runtime',
      runId: 'run-beta',
      agentName: 'Runtime Worker',
    }))

    await expect(alphaRoom.locator(':scope > .room-icon')).toHaveCount(0)
    await expect(alphaRoom.locator(':scope > .room-agent-grid + .room-info')).toHaveCount(1)
    await expect(betaGrid).toHaveClass(/is-active/)
    await expect(betaGrid.locator('[data-agent-id="agent-row-runtime"]')).not.toHaveClass(/is-active/)
    await expect.poll(() => alphaRoom.locator('.room-info').evaluate(element => element.getBoundingClientRect().x)).toBe(alphaInfoX)
    await expect.poll(() => betaRoom.locator('.room-info').evaluate(element => element.getBoundingClientRect().x)).toBe(betaInfoX)

    await triggerGroupSocket(page, 'room_agent_activity', activity({ status: 'ready' }))
    await expect(alphaGrid).toHaveClass(/is-active/)
    await triggerGroupSocket(page, 'room_agent_activity', activity({ runId: 'run-live-tools-2', status: 'ready' }))
    await expect(alphaGrid).not.toHaveClass(/is-active/)

    await triggerGroupSocket(page, 'agents_updated', {
      roomId: 'room-alpha',
      agents: [
        ...(agentsByRoom['room-alpha'] as any[]),
        {
          id: 'agent-row-2',
          roomId: 'room-alpha',
          agentId: 'agent-2',
          agent: 'codex',
          profile: 'default',
          provider: 'test-provider',
          model: 'test-model',
          apiMode: 'codex_responses',
          reasoningEffort: '',
          name: 'Second Worker',
          description: '',
          avatar: '',
          invited: 1,
        },
      ],
    })
    await expect(alphaGrid).toHaveAttribute('data-agent-count', '2')
    await expect(alphaGrid.locator('[data-agent-id="agent-row-2"]')).toHaveCount(1)
    await expect.poll(() => alphaRoom.locator('.room-info').evaluate(element => element.getBoundingClientRect().x)).toBe(alphaInfoX)

    await betaRoom.click()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(alphaGrid).toHaveAttribute('data-agent-count', '2')
    await expect(betaGrid).toHaveClass(/is-active/)
    await expect(betaGrid.locator('[data-agent-id="agent-row-runtime"]')).not.toHaveClass(/is-active/)
  })

  test('removes an interrupted run approval from the room approval surface', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await triggerGroupSocket(page, 'approval.requested', {
      event: 'approval.requested',
      roomId: 'room-alpha',
      agentName: 'Worker',
      approval_id: 'approval-interrupted',
      command: 'printf harmless',
      description: 'Harmless command awaiting approval',
      choices: ['once', 'deny'],
    })
    await expect(page.locator('.approval-float-panel')).toContainText('printf harmless')

    await triggerGroupSocket(page, 'approval.resolved', {
      event: 'approval.resolved',
      roomId: 'room-alpha',
      agentName: 'Worker',
      approval_id: 'approval-interrupted',
      choice: 'deny',
      reason: 'Agent run interrupted',
    })
    await expect(page.locator('.approval-float-panel')).toHaveCount(0)
    if (process.env.HERMES_VISUAL_EVIDENCE_DIR) {
      await page.screenshot({
        path: `${process.env.HERMES_VISUAL_EVIDENCE_DIR}/approval-removed-after-interrupt.png`,
      })
    }
  })

  test('loads all group history by stable cursor beyond 600 messages with retry, de-duplication, and anchor preservation', async ({ page }) => {
    test.setTimeout(45_000)
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    api.setRoomMessages({
      ...messagesByRoom,
      'room-alpha': Array.from({ length: 725 }, (_, index) => ({
        id: `history-${index + 1}`,
        roomId: 'room-alpha',
        senderId: 'user-1',
        senderName: 'Alice',
        content: `History message ${index + 1}`,
        timestamp: 1_790_000_000 + index,
        role: 'user',
      })),
    })
    await page.reload()

    const transcript = page.locator('.group-message-list .virtual-message-list')
    await expect(page.getByText('History message 725', { exact: true })).toBeVisible()
    await expect(page.getByText('History message 576', { exact: true })).toBeVisible()
    await expect(page.getByText('History message 575', { exact: true })).toHaveCount(0)

    api.failRoomHistoryBefore('room-alpha', 'history-576')
    api.delayRoomHistoryBefore('room-alpha', 'history-576', 150)
    await transcript.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
      element.dispatchEvent(new Event('scroll'))
    })

    const retry = page.getByRole('button', { name: 'Retry loading earlier messages' })
    await expect(retry).toBeVisible()
    expect(api.roomDetailRequests.filter(request => request.before === 'history-576')).toHaveLength(1)
    const retryAnchorBefore = await transcript.evaluate(element => {
      const anchor = element.querySelector('[data-group-message-id="history-576"]')
      return anchor ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top : Number.NaN
    })
    await retry.click()
    await expect(page.getByText('History message 426', { exact: true })).toBeVisible()
    await expect.poll(() => transcript.evaluate((element, expectedOffset) => {
      const anchor = element.querySelector('[data-group-message-id="history-576"]')
      const currentOffset = anchor ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top : Number.NaN
      return Math.abs(currentOffset - expectedOffset)
    }, retryAnchorBefore)).toBeLessThanOrEqual(2)

    for (const [before, oldestLoaded] of [
      ['history-426', 'History message 276'],
      ['history-276', 'History message 126'],
      ['history-126', 'History message 1'],
    ] as const) {
      await transcript.evaluate(element => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => api.roomDetailRequests.some(request => request.before === before && request.history)).toBe(true)
      await expect(page.getByText(oldestLoaded, { exact: true })).toHaveCount(1)
    }

    await expect(page.getByRole('link', { name: 'View complete group chat history' })).toHaveCount(0)
    const messageIds = await page.locator('[data-group-message-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-group-message-id')))
    expect(messageIds).toHaveLength(725)
    expect(new Set(messageIds).size).toBe(725)

    const requestCount = api.roomDetailRequests.length
    await transcript.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(100)
    expect(api.roomDetailRequests).toHaveLength(requestCount)
  })

  test('redirects legacy Group Chat history URLs to the live room', async ({ page }) => {
    await setup(page, '/#/hermes/history/group-chat/room-alpha')

    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-alpha$/)
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
    await expect(page.locator('[data-group-history-scroller]')).toHaveCount(0)

    await page.goto('/#/hermes/group-chat/history/room-beta')
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(page.locator('.room-title-text', { hasText: 'Beta Room' })).toBeVisible()
  })

  test('folds runtime Tools after completion and refresh while preserving newest-first details', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-beta')
    await expect(page.getByText('Beta room message')).toBeVisible()

    const runtimeMessage = (overrides: Record<string, unknown>) => ({
      id: 'run-runtime-tools_part_0',
      roomId: 'room-beta',
      senderId: 'agent-runtime',
      senderAgentRecordId: 'agent-row-runtime',
      senderName: 'Runtime Worker',
      content: '',
      timestamp: 1_790_000_200,
      role: 'assistant',
      run_id: 'run-runtime-tools',
      ...overrides,
    })

    await triggerGroupSocket(page, 'context_status', {
      roomId: 'room-beta',
      agentName: 'Runtime Worker',
      status: 'replying',
    })
    await triggerGroupSocket(page, 'message_stream_start', runtimeMessage({
      senderId: 'transport-socket-id',
      finish_reason: 'streaming',
    }))
    await triggerGroupSocket(page, 'message_stream_end', {
      roomId: 'room-beta',
      id: 'run-runtime-tools_part_0',
    })
    for (const [index, toolName] of ['read_file', 'terminal'].entries()) {
      const callId = `runtime-call-${index + 1}`
      await triggerGroupSocket(page, 'message', runtimeMessage({
        id: `run-runtime-tools_part_0_toolcall_${callId}`,
        timestamp: 1_790_000_201 + index * 2,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ index }) },
        }],
        finish_reason: 'tool_calls',
      }))
      await triggerGroupSocket(page, 'message', runtimeMessage({
        id: `run-runtime-tools_part_0_toolresult_${callId}`,
        timestamp: 1_790_000_202 + index * 2,
        role: 'tool',
        tool_call_id: callId,
        tool_name: toolName,
        content: `result-${index + 1}`,
      }))
    }
    await triggerGroupSocket(page, 'message_stream_start', runtimeMessage({
      id: 'run-runtime-tools_part_1',
      timestamp: 1_790_000_206,
      finish_reason: 'streaming',
    }))
    await triggerGroupSocket(page, 'message_reasoning_delta', {
      roomId: 'room-beta',
      id: 'run-runtime-tools_part_1',
      delta: 'Checking the Tool results.',
    })

    const runCard = page.locator('.group-agent-run[data-run-id="run-runtime-tools"]')
    const panel = page.locator('.run-tool-list[data-agent-id="agent-row-runtime"][data-run-id="run-runtime-tools"]')
    await expect(runCard).toHaveCount(1)
    await expect(panel).toBeVisible()
    await expect(panel.locator('.tool-name')).toHaveText(['terminal', 'read_file'])
    await expect(panel.locator('.tool-message')).toHaveCount(2)

    await triggerGroupSocket(page, 'context_status', {
      roomId: 'room-beta',
      agentName: 'Runtime Worker',
      status: 'ready',
    })

    const toggle = runCard.locator('.tool-run-header')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toHaveCount(0)
    await toggle.click()
    await expect(panel).toBeVisible()
    await expect(panel.locator('.tool-name')).toHaveText(['terminal', 'read_file'])
    await expect(runCard.locator('.tool-message')).toHaveCount(2)
    await expect(runCard.locator('.run-card > .run-tools + .run-transcript')).toBeVisible()

    api.setRoomMessages({
      ...messagesByRoom,
      'room-beta': [
        ...messagesByRoom['room-beta'],
        runtimeMessage({
          id: 'run-runtime-tools_part_0_toolresult_runtime-call-1',
          timestamp: 1_790_000_202,
          role: 'tool',
          tool_call_id: 'runtime-call-1',
          tool_name: 'read_file',
          content: 'result-1',
        }),
        runtimeMessage({
          id: 'run-runtime-tools_part_0_toolresult_runtime-call-2',
          timestamp: 1_790_000_204,
          role: 'tool',
          tool_call_id: 'runtime-call-2',
          tool_name: 'terminal',
          content: 'result-2',
        }),
        runtimeMessage({
          id: 'run-runtime-tools_part_2',
          timestamp: 1_790_000_207,
          content: 'Finished.',
        }),
      ],
    })
    await page.reload()

    const refreshedRunCard = page.locator('.group-agent-run[data-run-id="run-runtime-tools"]')
    const refreshedPanel = page.locator('.run-tool-list[data-agent-id="agent-row-runtime"][data-run-id="run-runtime-tools"]')
    await expect(refreshedRunCard).toHaveCount(1)
    const refreshedToggle = refreshedRunCard.locator('.tool-run-header')
    await expect(refreshedToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(refreshedPanel).toHaveCount(0)
    await expect(refreshedRunCard.locator('.run-card > .run-tools + .run-transcript')).toContainText('Finished.')
    await refreshedToggle.click()
    await expect(refreshedPanel).toBeVisible()
    await expect(refreshedPanel.locator('.tool-name')).toHaveText(['terminal', 'read_file'])
    await expect(refreshedRunCard.locator('.tool-message')).toHaveCount(2)
    await expect(page.locator('.group-message-list > .tool-message')).toHaveCount(0)
  })

  test('shows a selected room link when browser clipboard APIs cannot copy', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', {
        configurable: true,
        value: false,
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      })
      Object.defineProperty(Document.prototype, 'execCommand', {
        configurable: true,
        value: () => false,
      })
    })
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.room-item', { hasText: 'Alpha Room' }).click({ button: 'right' })
    await page.getByText('Copy Room Link', { exact: true }).click()

    const dialog = page.getByRole('dialog', { name: 'Copy Room Link' })
    const input = dialog.getByRole('textbox', { name: 'Copy Room Link' })
    const origin = await page.evaluate(() => window.location.origin)
    const expectedLink = `${origin}/#/share/group-chat/ALPHA1`

    await expect(dialog).toContainText('The browser could not copy automatically')
    await expect(input).toHaveValue(expectedLink)
    await expect.poll(async () => input.evaluate((element: HTMLInputElement) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
    }))).toEqual({ start: 0, end: expectedLink.length })
  })

  test('line-linked room files open at the requested line in the group workspace panel', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    const fileLink = page.locator('.markdown-file-link', { hasText: 'package.json:2' })
    await expect(fileLink).toBeVisible({ timeout: 15_000 })
    await fileLink.click()

    const panel = page.locator('.group-workspace-panel')
    await expect(panel.locator('.file-preview')).toBeVisible()
    const target = panel.locator('.preview-source-line[data-line="2"]')
    await expect(target).toContainText('group-preview')
    await expect(target).toHaveClass(/is-target-line/)
    await expect(panel.locator('.preview-filename')).toHaveText('package.json')
  })

  test('keeps the workspace drawer seam and resize direction aligned in LTR and RTL', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await page.locator('.markdown-file-link', { hasText: 'package.json:2' }).click()

    const wrapper = page.locator('.group-chat-content-wrapper')
    const panel = page.locator('.group-workspace-panel')
    const handle = page.locator('.group-workspace-resize-handle')
    await expect(panel).toBeVisible()
    await expect(panel).not.toHaveClass(/tool-panel-enter-active/)

    const geometry = async () => {
      const [wrapperBox, panelBox, handleBox] = await Promise.all([
        wrapper.boundingBox(),
        panel.boundingBox(),
        handle.boundingBox(),
      ])
      if (!wrapperBox || !panelBox || !handleBox) throw new Error('group drawer geometry unavailable')
      return {
        wrapperLeft: wrapperBox.x,
        wrapperRight: wrapperBox.x + wrapperBox.width,
        panelLeft: panelBox.x,
        panelRight: panelBox.x + panelBox.width,
        panelWidth: panelBox.width,
        handleCenter: handleBox.x + handleBox.width / 2,
        handleY: handleBox.y + handleBox.height / 2,
      }
    }

    const ltr = await geometry()
    expect(Math.abs(ltr.panelRight - ltr.wrapperRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(ltr.handleCenter - ltr.panelLeft)).toBeLessThanOrEqual(1)
    await page.mouse.move(ltr.handleCenter, ltr.handleY)
    await page.mouse.down()
    await page.mouse.move(ltr.handleCenter + 32, ltr.handleY)
    await page.mouse.up()
    await expect.poll(async () => (await geometry()).panelWidth).toBeLessThan(ltr.panelWidth)

    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'))
    await expect.poll(async () => {
      const current = await geometry()
      return Math.abs(current.panelLeft - current.wrapperLeft) <= 1
    }).toBe(true)
    const rtl = await geometry()
    expect(Math.abs(rtl.handleCenter - rtl.panelRight)).toBeLessThanOrEqual(1)
    await page.mouse.move(rtl.handleCenter, rtl.handleY)
    await page.mouse.down()
    await page.mouse.move(rtl.handleCenter - 32, rtl.handleY)
    await page.mouse.up()
    await expect.poll(async () => (await geometry()).panelWidth).toBeLessThan(rtl.panelWidth)
  })

  test('workspace control sits beside the upper-right settings control and toggles the group workspace panel', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const toolbar = page.locator('.chat-header .header-info')
    const workspaceButton = toolbar.locator('.workspace-panel-toggle')
    const settingsButton = toolbar.locator('.compression-settings-button')
    await expect(workspaceButton).toBeVisible()
    await expect(settingsButton).toBeVisible()
    expect(await workspaceButton.evaluate(element => element.nextElementSibling?.classList.contains('compression-settings-button'))).toBe(true)

    await workspaceButton.click()
    await expect(page.locator('.group-workspace-panel')).toBeVisible()
    await expect(workspaceButton).toHaveAttribute('aria-pressed', 'true')

    await workspaceButton.click()
    await expect(page.locator('.group-workspace-panel')).toHaveCount(0)
  })

  for (const platform of ['darwin', 'win32'] as const) {
    test(`opens Agent settings from the ${platform} avatar rail`, async ({ page }) => {
      await setup(page, '/#/hermes/group-chat/room/room-alpha', platform)

      const trigger = page.getByRole('button', { name: 'Worker' })
      await expect(trigger).toBeVisible()
      await expect(trigger).toHaveCSS('-webkit-app-region', 'no-drag')
      await trigger.click()

      const modal = page.locator('.n-drawer').filter({ hasText: 'Edit Worker' })
      await expect(modal).toBeVisible()
      await expect(modal.getByText('Avatar', { exact: true })).toBeVisible()
      await expect(modal.getByText('Agent Name', { exact: true })).toBeVisible()
    })
  }

  test('applies an Agent preset when adding an Agent to an existing room', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.agent-avatar-rail-add').click()
    const modal = page.locator('.n-drawer').filter({ hasText: 'Add Agent' })
    const nameInput = modal.getByPlaceholder('Custom name (leave empty to use profile name)')
    await nameInput.fill('Draft Agent')
    await modal.getByRole('button', { name: 'Choose preset' }).click()
    const presetDialog = page.locator('.agent-preset-dialog').filter({ hasText: 'Choose preset' })
    await expect(presetDialog).toBeVisible()
    await expect(presetDialog.getByText('Profile "missing-profile" is unavailable', { exact: true })).toBeVisible()
    await expect(presetDialog.getByRole('button', { name: /Unavailable Reviewer/ })).toBeDisabled()
    await presetDialog.getByPlaceholder('Search presets').fill('Reviewer')
    await presetDialog.getByRole('button', { name: /Preset Reviewer/ }).click()
    await expect(nameInput).toHaveValue('Draft Agent')
    await presetDialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(modal.getByPlaceholder('Custom name (leave empty to use profile name)')).toHaveValue('Preset Reviewer')
    await expect(modal.getByPlaceholder('Describe what this agent does...')).toHaveValue('Reviews changes')

    const response = page.waitForResponse(item =>
      item.request().method() === 'POST'
      && item.url().endsWith('/api/studio/group-chat/rooms/room-alpha/agents'))
    await modal.getByRole('button', { name: 'Add', exact: true }).click()
    await expect((await response).status()).toBe(200)
    expect(api.addedAgents).toEqual([{
      roomId: 'room-alpha',
      body: expect.objectContaining({
        presetId: 'preset-reviewer',
        name: 'Preset Reviewer',
        provider: 'test-provider',
        model: 'test-model',
      }),
    }])
  })

  for (const mobile of [false, true]) test(`adds DSH from the ${mobile ? 'mobile' : 'desktop'} Agent drawer with the selected mode`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await page.locator('.agent-avatar-rail-add').click()
    const modal = page.locator('.n-drawer').filter({ hasText: 'Add Agent' })
    await modal.locator('.n-select').first().click()
    await page.getByText('DeepSeek Harness', { exact: true }).last().click()
    await expect(modal.locator('img[src="/coding-agents/deepseek.svg"]')).toBeVisible()
    const mode = modal.getByTestId('dsh-session-preset')
    await expect(mode).toContainText('Standard mode (Default)')
    await mode.locator('.n-base-selection').click()
    await page.getByText('Minimal mode', { exact: true }).last().click()
    await modal.getByPlaceholder('Custom name (leave empty to use profile name)').fill('DSH Worker')
    const footer = modal.locator('.n-drawer-footer')
    await expect(footer.getByRole('button', { name: 'Add', exact: true })).toBeInViewport()
    await expect.poll(async () => modal.evaluate(element => ({
      right: Math.round(element.getBoundingClientRect().right),
      width: Math.round(element.getBoundingClientRect().width),
      viewport: window.innerWidth,
      fits: document.documentElement.scrollWidth <= window.innerWidth,
    }))).toEqual({ right: mobile ? 390 : 1280, width: mobile ? 390 : 520, viewport: mobile ? 390 : 1280, fits: true })
    await modal.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(() => api.addedAgents.length).toBe(1)
    expect(api.addedAgents[0]).toMatchObject({ roomId: 'room-alpha', body: {
      agent: 'dsh', agentMode: 'scoped', agentPreset: 'minimal', provider: 'test-provider', model: 'test-model', name: 'DSH Worker',
    } })
    await page.getByRole('button', { name: 'DSH Worker', exact: true }).click()
    await expect(page.locator('.n-drawer').filter({ hasText: 'Edit DSH Worker' }).getByTestId('dsh-session-preset')).toContainText('Minimal mode')
  })

  test('cancels preset selection without changing the Agent form', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.agent-avatar-rail-add').click()
    const modal = page.locator('.n-drawer').filter({ hasText: 'Add Agent' })
    const nameInput = modal.getByPlaceholder('Custom name (leave empty to use profile name)')
    await nameInput.fill('Keep this draft')
    await modal.getByRole('button', { name: 'Choose preset' }).click()
    const presetDialog = page.locator('.agent-preset-dialog').filter({ hasText: 'Choose preset' })
    await presetDialog.getByRole('button', { name: /Preset Reviewer/ }).click()
    await presetDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(presetDialog).toHaveCount(0)
    await expect(nameInput).toHaveValue('Keep this draft')
  })

  test('does not offer or apply Agent presets while creating a Room', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat')

    await page.getByRole('button', { name: 'Create Room', exact: true }).click()
    const drawer = page.locator('.n-drawer').filter({ hasText: 'Create Room' })
    await expect(drawer.getByText('Agent presets', { exact: true })).toHaveCount(0)
    await drawer.getByPlaceholder('Enter room name').fill('Plain Room')
    await drawer.getByPlaceholder('Enter your display name').fill('Owner')

    const response = page.waitForResponse(item =>
      item.request().method() === 'POST'
      && item.url().endsWith('/api/studio/group-chat/rooms'))
    await drawer.getByRole('button', { name: 'Create', exact: true }).click()
    await expect((await response).status()).toBe(200)
    expect(api.createdRooms).toEqual([
      expect.objectContaining({
        name: 'Plain Room',
        agents: [],
      }),
    ])
  })

  test('manages Agent presets only while editing an existing Room Agent', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.agent-avatar-rail-add').click()
    const addModal = page.locator('.n-drawer').filter({ hasText: 'Add Agent' })
    await expect(addModal.getByRole('button', { name: 'Manage presets' })).toHaveCount(0)
    await addModal.getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'Worker' }).click()
    const editModal = page.locator('.n-drawer').filter({ hasText: 'Edit Worker' })
    await editModal.getByRole('button', { name: 'Manage presets' }).click()
    const presetDialog = page.locator('.agent-preset-dialog').filter({ hasText: 'Manage presets' })
    await presetDialog.getByRole('button', { name: 'Save current Agent as new preset' }).click()
    await expect.poll(() => api.presetOperations).toContainEqual({
      method: 'POST',
      body: expect.objectContaining({ name: 'Worker', description: 'Group agent' }),
    })
    await presetDialog.getByPlaceholder('Search presets').fill('Reviewer')
    await presetDialog.getByRole('button', { name: /Preset Reviewer/ }).click()
    await expect(editModal.getByPlaceholder('Custom name (leave empty to use profile name)')).toHaveValue('Worker')
    await presetDialog.getByRole('button', { name: 'Update preset' }).click()
    await expect.poll(() => api.presetOperations).toContainEqual({
      method: 'PUT',
      id: 'preset-reviewer',
      body: expect.objectContaining({ name: 'Worker', description: 'Group agent' }),
    })
    await presetDialog.getByRole('button', { name: 'Delete preset' }).click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => api.presetOperations).toContainEqual({
      method: 'DELETE',
      id: 'preset-reviewer',
    })
    await expect(editModal.getByPlaceholder('Custom name (leave empty to use profile name)')).toHaveValue('Worker')
  })

  test('member count collapses the default-open scrollable avatar rail', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const rail = page.locator('.agent-avatar-rail')
    const memberToggle = page.locator('.member-count-toggle')
    await expect(rail).toBeVisible()
    await expect(memberToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(rail.locator('.agent-avatar-rail-trigger')).toHaveCSS('overflow-y', 'auto')

    await memberToggle.click()
    await expect(rail).toHaveCount(0)
    await expect(memberToggle).toHaveAttribute('aria-expanded', 'false')

    await memberToggle.click()
    await expect(rail).toBeVisible()
    await page.getByRole('button', { name: 'Your Name' }).click()
    await expect(page.locator('.n-modal').filter({ hasText: 'Your Name' })).toBeVisible()
  })

  test('renders offline people and Agents in gray', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha', undefined, true)

    const offlineMember = page.getByRole('button', { name: 'Offline Member' })
    const offlineAgent = page.getByRole('button', { name: 'Worker' })
    await expect(offlineMember).toHaveClass(/agent-avatar-rail-offline/)
    await expect(offlineAgent).toHaveClass(/agent-avatar-rail-offline/)
    await expect(offlineMember.locator('.agent-avatar')).toHaveCSS('filter', 'grayscale(1)')
    await expect(offlineAgent.locator('.agent-avatar')).toHaveCSS('opacity', '0.42')
  })

  test('room settings rotate invite codes only after the update API succeeds', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const settingsButton = page.locator('.chat-header .header-info .compression-settings-button')
    await settingsButton.click()

    const drawer = page.locator('.n-drawer').filter({ has: page.locator('.room-settings-drawer') })
    await expect(drawer.getByText('Room Settings', { exact: true })).toBeVisible()
    const inviteInput = drawer.getByPlaceholder('Enter a new invite code')
    const updateButton = drawer.getByRole('button', { name: 'Update' }).nth(1)

    await expect(inviteInput).toHaveValue('ALPHA1')
    await expect(updateButton).toBeDisabled()

    await inviteInput.fill('   ')
    await expect(updateButton).toBeDisabled()

    await inviteInput.fill(' NEW456 ')
    const successResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/studio/group-chat/rooms/room-alpha/invite-code'))
    await updateButton.click()
    await expect((await successResponse).status()).toBe(200)
    expect(api.inviteCodeUpdates.at(-1)).toEqual({ roomId: 'room-alpha', body: { inviteCode: 'NEW456' } })
    await expect(inviteInput).toHaveValue('NEW456')
    await expect(updateButton).toBeDisabled()

    await inviteInput.fill('FAILCODE')
    const failureResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/studio/group-chat/rooms/room-alpha/invite-code'))
    await updateButton.click()
    await expect((await failureResponse).status()).toBe(409)

    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await settingsButton.click()
    await expect(drawer.getByPlaceholder('Enter a new invite code')).toHaveValue('NEW456')
  })

  test('room owner can explicitly enable remote Agent workspace access', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    await page.locator('.chat-header .header-info .compression-settings-button').click()
    const drawer = page.locator('.n-drawer').filter({ has: page.locator('.room-settings-drawer') })
    const section = drawer.locator('.settings-section').filter({ hasText: 'Guest Agent connections' })
    const accessRow = section.locator('.guest-agent-policy-row').filter({
      hasText: 'Allow remote Agents to read and write the group workspace',
    })
    await expect(accessRow).toBeVisible()
    await accessRow.locator('.n-switch').click()

    const response = page.waitForResponse(item =>
      item.request().method() === 'PUT'
      && item.url().includes('/api/studio/group-chat/rooms/room-alpha/guest-agent-policy'))
    await section.getByRole('button', { name: 'Save' }).click()
    await expect((await response).status()).toBe(200)
    expect(api.guestAgentPolicyUpdates.at(-1)).toEqual({
      roomId: 'room-alpha',
      body: {
        allowGuestAgents: true,
        maxGuestAgentsPerMember: 1,
        allowRemoteWorkspaceAccess: true,
      },
    })
  })

  test('removes stale stopped chains after changing room handoff settings', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const stopCard = page.locator('[data-handoff-chain-id="handoff:alpha-msg"]')
    await expect(stopCard).toContainText('Depth: 4 / 4')
    await expect(stopCard).toContainText('Target Agent: Worker')

    await page.locator('.chat-header .header-info .compression-settings-button').click()
    const drawer = page.locator('.n-drawer').filter({ has: page.locator('.room-settings-drawer') })
    const section = drawer.locator('.settings-section').filter({ hasText: 'Agent handoff' })
    await expect(section).toContainText('Recommended depth: 4')
    await section.locator('.n-input-number input').fill('6')
    const configResponse = page.waitForResponse(response =>
      response.request().method() === 'PUT'
      && response.url().includes('/api/studio/group-chat/rooms/room-alpha/config'))
    await section.getByRole('button', { name: 'Save' }).click()
    await expect((await configResponse).status()).toBe(200)
    expect(api.roomConfigUpdates.at(-1)).toMatchObject({
      roomId: 'room-alpha',
      body: {
        agentHandoffEnabled: true,
        agentHandoffMaxDepth: 6,
        agentHandoffUnlimited: false,
      },
    })

    await expect(stopCard).toHaveCount(0)
  })

  test('continues one stopped chain without changing room handoff settings', async ({ page }) => {
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    const stopCard = page.locator('[data-handoff-chain-id="handoff:alpha-msg"]')
    await expect(stopCard).toContainText('Depth: 4 / 4')

    const continueResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
      && response.url().includes('/handoffs/handoff%3Aalpha-msg/continue'))
    await stopCard.getByRole('button', { name: 'Continue this handoff once' }).click()
    await expect((await continueResponse).status()).toBe(202)
    await expect(stopCard).toHaveCount(0)
    expect(api.roomConfigUpdates).toHaveLength(0)
  })

  test('read-only room members cannot open room settings', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-readonly')

    await expect(page.locator('.room-title-text', { hasText: 'Read Only Room' })).toBeVisible()
    await expect(page.locator('.room-item', { hasText: 'Read Only Room' }).locator('.room-code')).toHaveCount(0)
    await expect(page.locator('.chat-header .header-info .compression-settings-button')).toHaveCount(0)
  })

  test('group workspace diffs use the single-chat card and shared diff panel', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')

    const card = page.locator('.tool-change-card')
    await expect(card).toBeVisible()
    expect((await card.boundingBox())?.width).toBeLessThan(500)
    await card.locator('.tool-change-card-header').click()
    await expect(card.locator('.tool-change-file-row')).toContainText('example.ts')
    await card.locator('.tool-change-file-row').click()

    const panel = page.locator('.group-workspace-panel')
    await expect(panel.locator('.workspace-diff-preview')).toBeVisible()
    await expect(panel.locator('.diff-file-name')).toHaveText('example.ts')
    await expect(panel.locator('.diff-code')).toContainText('new')
    await expect(panel.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  })

  test('preserves every room-list Agent avatar after clearing history and switching rooms', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await connectGroupSocket(page)
    const roster = [1, 2, 3].map(index => ({
      ...(agentsByRoom['room-alpha'][0] as object), id: `clear-worker-${index}`,
      agentId: `clear-agent-${index}`, name: `Worker ${index}`,
      avatar: JSON.stringify({ type: 'generated', seed: `clear-worker-${index}` }),
    }))
    let cleared = false
    await page.route(/\/api\/studio\/group-chat\/rooms\/room-alpha(?:\?.*)?$/, route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({
        room: baseRooms[0], agents: roster, members: [],
        messages: cleared ? [] : messagesByRoom['room-alpha'], total: 0, hasMore: false,
      }),
    }))
    await page.route('**/api/studio/group-chat/rooms/room-alpha/clear-context', async route => {
      expect(route.request().method()).toBe('POST')
      cleared = true
      await page.evaluate(agents => {
        (window as any).__PW_GROUP_SOCKET__.joinStates = { 'room-alpha': { agents, messages: [] } }
      }, roster)
      // The real clear endpoint returns room metadata without an Agent roster.
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, room: { ...baseRooms[0], totalTokens: 0 } }) })
    })
    await triggerGroupSocket(page, 'agents_updated', { roomId: 'room-alpha', agents: roster })
    const alphaGrid = page.locator('.room-item', { hasText: 'Alpha Room' }).locator('.room-agent-grid')
    await expect(alphaGrid).toHaveAttribute('data-agent-count', '3')
    const avatarIds = roster.map(agent => agent.id)
    await page.getByRole('button', { name: 'Clear context', exact: true }).click()
    await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.getByText('Alpha room message', { exact: true })).toHaveCount(0)
    await expect(alphaGrid).toHaveAttribute('data-agent-count', '3')
    for (const name of ['Beta Room', 'Alpha Room', 'Beta Room']) {
      await page.locator('.room-item', { hasText: name }).click()
      await expect(page.locator('.room-title-text')).toHaveText(name)
      await expect(alphaGrid).toHaveAttribute('data-agent-count', '3')
      expect(await alphaGrid.locator('[data-agent-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-agent-id')))).toEqual(avatarIds)
      await expect(alphaGrid.locator('svg')).toHaveCount(3)
    }
    await alphaGrid.screenshot({ path: '/tmp/ekko-clear-room-avatars.png' })
  })

  test('isolates typing and summary indicators while switching rooms and clears idle summaries', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await connectGroupSocket(page)
    const member = { id: 'typing-member', userId: 'typing-user', name: 'Typing Member', joinedAt: 1 }
    const summary = { roomId: 'room-alpha', version: 1, status: 'summarizing', updatedAt: 10, summary: '' }
    await triggerGroupSocket(page, 'member_joined', { roomId: 'room-alpha', members: [member] })
    await triggerGroupSocket(page, 'typing', { roomId: 'room-alpha', userId: member.userId, userName: member.name })
    await triggerGroupSocket(page, 'room_summary_updated', summary)
    await expect(page.locator('.agent-avatar-rail-typing')).toHaveCount(1)
    await expect(page.locator('.group-summary-inline-status.is-summarizing')).toBeVisible()
    await triggerGroupSocket(page, 'room_summary_updated', { ...summary, status: 'idle', updatedAt: 20 })
    await expect(page.locator('.group-summary-inline-status')).toHaveCount(0)

    await page.evaluate(({ member, summary }) => {
      const state = (window as any).__PW_GROUP_SOCKET__
      state.joinStates = {
        'room-alpha': { members: [member], typingUsers: [{ userId: member.userId, userName: member.name }], roomSummary: { ...summary, updatedAt: 30 } },
        'room-beta': { roomSummary: { ...summary, roomId: 'room-beta', status: 'idle' } },
      }
    }, { member, summary })
    for (let round = 0; round < 2; round++) {
      await page.locator('.room-item', { hasText: 'Beta Room' }).click()
      await expect(page.locator('.room-title-text')).toHaveText('Beta Room')
      await expect(page.locator('.agent-avatar-rail-typing')).toHaveCount(0)
      await expect(page.locator('.group-summary-inline-status')).toHaveCount(0)
      await triggerGroupSocket(page, 'room_summary_updated', { ...summary, updatedAt: 30 })
      await expect(page.locator('.group-summary-inline-status')).toHaveCount(0)
      await page.locator('.room-item', { hasText: 'Alpha Room' }).click()
      await expect(page.locator('.room-title-text')).toHaveText('Alpha Room')
      await expect(page.locator('.agent-avatar-rail-typing')).toHaveCount(1)
      await expect(page.locator('.group-summary-inline-status.is-summarizing')).toBeVisible()
    }
    await triggerGroupSocket(page, 'stop_typing', { roomId: 'room-alpha', userId: member.userId })
    await triggerGroupSocket(page, 'room_summary_updated', { ...summary, status: 'idle', updatedAt: 40 })
    await expect(page.locator('.agent-avatar-rail-typing')).toHaveCount(0)
    await expect(page.locator('.group-summary-inline-status')).toHaveCount(0)
  })

  test('restores live text and reasoning after switching rooms and continues streaming', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-beta')
    await connectGroupSocket(page)
    const liveMessage = {
      id: 'switch-run_part_0', roomId: 'room-beta', senderId: 'switch-agent',
      senderName: 'Switch Worker', role: 'assistant', run_id: 'switch-run',
      content: 'Recovered stage text', reasoning: 'Recovered thinking',
      reasoning_content: 'Recovered thinking', timestamp: 1_900_000_000,
      isStreaming: true, finish_reason: 'streaming',
    }
    await page.evaluate(message => {
      (window as any).__PW_GROUP_SOCKET__.liveSnapshots = { 'room-beta': [message] }
    }, liveMessage)

    for (let round = 0; round < 2; round++) {
      await page.locator('.room-item', { hasText: 'Alpha Room' }).click()
      await expect(page.locator('.room-title-text')).toHaveText('Alpha Room')
      await page.locator('.room-item', { hasText: 'Beta Room' }).click()
      await expect(page.locator('.room-title-text')).toHaveText('Beta Room')
      const message = page.locator('.group-message', { hasText: 'Recovered stage text' })
      await expect(message).toBeVisible()
      await message.locator('.thinking-header').click()
      await expect(message.locator('.thinking-body')).toContainText('Recovered thinking')
      await triggerGroupSocket(page, 'message_stream_delta', { roomId: 'room-beta', id: liveMessage.id, delta: ' continued' })
      await triggerGroupSocket(page, 'message_reasoning_delta', { roomId: 'room-beta', id: liveMessage.id, delta: ' continued' })
      await expect(message).toContainText('Recovered stage text continued')
      await expect(message.locator('.thinking-body')).toContainText('Recovered thinking continued')
    }
    await triggerGroupSocket(page, 'message', { ...liveMessage, content: 'Switch run finished', isStreaming: false, finish_reason: 'stop' })
    await expect(page.getByText('Switch run finished', { exact: true })).toBeVisible()
  })

  test('clicking another room updates URL and reload preserves it', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await expect(page.getByText('Alpha room message')).toBeVisible()

    await page.getByText('Beta Room').click()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(page.getByText('Beta room message')).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(page.getByText('Beta room message')).toBeVisible()
  })

  test('two tabs can show different rooms', async ({ context }) => {
    const first = await context.newPage()
    const second = await context.newPage()

    await setup(first, '/#/hermes/group-chat/room/room-alpha')
    await setup(second, '/#/hermes/group-chat/room/room-beta')

    await expect(first.getByText('Alpha room message')).toBeVisible()
    await expect(first.getByText('Beta room message')).toHaveCount(0)
    await expect(second.getByText('Beta room message')).toBeVisible()
    await expect(second.getByText('Alpha room message')).toHaveCount(0)
  })

  test('atomically retracts one queued message across the live view and a reload', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('gc_user_id', 'user-1')
      window.localStorage.setItem('gc_user_name', 'User One')
    })
    const api = await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
    await connectGroupSocket(page)
    await page.waitForFunction(() => (window as any).__PW_GROUP_SOCKET__?.emitted.some(
      (item: any) => item.event === 'join' && item.payload?.roomId === 'room-alpha',
    ))
    const items = [
        {
          id: 'queue-1', roomId: 'room-alpha', messageId: 'alpha-msg',
          targetAgentId: 'agent-1', targetAgentName: 'Worker',
          requesterMemberId: 'user-1', textSummary: '@Worker first queued task',
          sequence: 10, position: 1, status: 'queued', createdAt: 10,
        },
        {
          id: 'queue-2', roomId: 'room-alpha', messageId: 'alpha-file',
          targetAgentId: 'agent-1', targetAgentName: 'Worker',
          requesterMemberId: 'someone-else', textSummary: '@Worker observer task',
          sequence: 11, position: 2, status: 'queued', createdAt: 11,
        },
      ]
    await page.evaluate((queuedItems) => {
      const state = (window as any).__PW_GROUP_SOCKET__
      state.executionQueues['room-alpha'] = queuedItems
    }, items)
    await triggerGroupSocket(page, 'execution_queue_updated', { roomId: 'room-alpha', items })

    const queue = page.getByTestId('group-execution-queue')
    await expect(queue.locator('.queue-index')).toHaveText(['1', '2'])
    await expect(queue.locator('.queue-agent')).toHaveText(['Worker', 'Worker'])
    await expect(queue.locator('.queue-text')).toHaveText([
      '@Worker first queued task',
      '@Worker observer task',
    ])
    await expect(queue.locator('.queue-remove')).toHaveCount(2)

    await queue.locator('.queue-remove').first().click()
    await expect(queue.locator('[data-queue-id="queue-1"]')).toHaveCount(0)
    await expect(queue.locator('[data-queue-id="queue-2"]')).toBeVisible()
    await expect(page.getByText('Alpha room message')).toHaveCount(0)

    api.setRoomMessages({
      ...messagesByRoom,
      'room-alpha': messagesByRoom['room-alpha'].filter(message => message.id !== 'alpha-msg'),
    })
    await page.reload()
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
    await connectGroupSocket(page)
    await expect(page.getByText('Alpha room message')).toHaveCount(0)
  })

  test('records and transcribes into the editable group composer without sending automatically', async ({ page }) => {
    await installMockVoiceCapture(page)
    let transcriptions = 0
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await page.route('**/api/studio/stt/transcribe', async (route) => {
      transcriptions += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'voice group draft', provider: 'openai' }),
      })
    })
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
    await connectGroupSocket(page)

    const toggle = page.getByTestId('voice-record-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()

    const textarea = page.locator('.chat-input-area textarea')
    await expect(textarea).toHaveValue('voice group draft')
    expect(transcriptions).toBe(1)
    expect(await page.evaluate(() => (window as any).__PW_GROUP_SOCKET__.emitted.filter(
      (item: any) => item.event === 'message',
    ).length)).toBe(0)

    await textarea.fill('edited voice group draft')
    await expect(textarea).toHaveValue('edited voice group draft')
    expect(await page.evaluate(() => (window as any).__PW_GROUP_SOCKET__.emitted.filter(
      (item: any) => item.event === 'message',
    ).length)).toBe(0)
  })

  test('persists isolated room drafts and structured mention identity across navigation and reload', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
    await connectGroupSocket(page)
    await page.waitForFunction(() => (window as any).__PW_GROUP_SOCKET__?.emitted.some(
      (item: any) => item.event === 'join' && item.payload?.roomId === 'room-alpha',
    ))

    const textarea = page.locator('.chat-input-area textarea')
    await textarea.fill('@')
    await page.locator('.mention-dropdown-item', { hasText: '@Worker' }).click()
    await textarea.pressSequentially('inspect alpha')

    await page.locator('.room-item', { hasText: 'Beta Room' }).click()
    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(textarea).toHaveValue('')
    await textarea.fill('beta draft')

    await page.locator('.room-item', { hasText: 'Alpha Room' }).click()
    await expect(textarea).toHaveValue('@Worker inspect alpha')
    await page.reload()
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
    await connectGroupSocket(page)
    await page.waitForFunction(() => (window as any).__PW_GROUP_SOCKET__?.emitted.some(
      (item: any) => item.event === 'join' && item.payload?.roomId === 'room-alpha',
    ))
    await expect(textarea).toHaveValue('@Worker inspect alpha')
    expect(await page.evaluate(() => {
      const stored = JSON.parse(window.localStorage.getItem('hermes_group_chat_room_drafts_v1') || '{"rooms":{}}')
      return {
        alpha: stored.rooms['room-alpha'],
        beta: stored.rooms['room-beta']?.text || '',
      }
    })).toMatchObject({
      alpha: {
        text: '@Worker inspect alpha',
        mentions: [{ type: 'agent', participantId: 'agent-1', displayName: 'Worker', start: 0, end: 7 }],
      },
      beta: 'beta draft',
    })
  })

  test('retains a routable mention after send failure and clears it after success', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/room-alpha')
    await expect(page.locator('.room-title-text', { hasText: 'Alpha Room' })).toBeVisible()
    await connectGroupSocket(page)
    await page.waitForFunction(() => (window as any).__PW_GROUP_SOCKET__?.emitted.some(
      (item: any) => item.event === 'join' && item.payload?.roomId === 'room-alpha',
    ))
    const textarea = page.locator('.chat-input-area textarea')
    await textarea.fill('@')
    await page.locator('.mention-dropdown-item', { hasText: '@Worker' }).click()
    await textarea.pressSequentially('inspect alpha')
    await page.evaluate(() => {
      ;(window as any).__PW_GROUP_SOCKET__.nextMessageError = 'send failed'
    })
    await page.locator('.send-button').click()
    await expect(textarea).toHaveValue('@Worker inspect alpha')
    await expect.poll(() => page.evaluate(() => (window as any).__PW_GROUP_SOCKET__.emitted.filter(
      (item: any) => item.event === 'message',
    ).length)).toBe(1)
    await expect(page.locator('.send-button')).toBeEnabled()
    expect(await page.evaluate(() => {
      const sent = (window as any).__PW_GROUP_SOCKET__.emitted.filter((item: any) => item.event === 'message')
      return sent.at(-1)?.payload?.mentions
    })).toEqual([{ type: 'agent', participantId: 'agent-1', displayName: 'Worker' }])

    await page.locator('.send-button').click()
    await expect(textarea).toHaveValue('')
    expect(await page.evaluate(() => {
      const stored = JSON.parse(window.localStorage.getItem('hermes_group_chat_room_drafts_v1') || '{"rooms":{}}')
      return {
        alpha: stored.rooms['room-alpha'] || null,
        beta: stored.rooms['room-beta']?.text || '',
      }
    })).toEqual({ alpha: null, beta: '' })
  })

  test('unknown route room id falls back to the first available room', async ({ page }) => {
    await setup(page, '/#/hermes/group-chat/room/missing-room')

    await expect(page).toHaveURL(/#\/hermes\/group-chat\/room\/room-beta$/)
    await expect(page.locator('.room-title-text', { hasText: 'Beta Room' })).toBeVisible()
  })
})
