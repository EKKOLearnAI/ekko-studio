import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { createServer, type Server as HttpServer } from 'http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupChatPublicRoutes, groupChatRoutes, setGroupChatServer } from '../../packages/server/src/modules/studio/routes/group-chat'
import {
  issueRemoteWorkspaceGrant,
  resetRemoteWorkspaceGrantsForTest,
  revokeRemoteWorkspaceGrantsForRun,
} from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-auth'
import {
  resetAgentStatusRegistryForTests,
  updateAgentStatus,
} from '../../packages/server/src/modules/studio/public/agent-status-registry'

function listen(server: HttpServer): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing address')
    resolve(`http://127.0.0.1:${addr.port}`)
  }))
}

describe('group chat REST route baseline', () => {
  let httpServer: HttpServer
  let baseUrl: string
  let storage: any
  let agentClients: any
  let clearRoomRuntimeState: ReturnType<typeof vi.fn>
  let updateRoomName: ReturnType<typeof vi.fn>
  let broadcastRoomMetadata: ReturnType<typeof vi.fn>
  let broadcastRoomAgents: ReturnType<typeof vi.fn>
  let removeLiveRoomMember: ReturnType<typeof vi.fn>
  let publishAgentAttachmentMessage: ReturnType<typeof vi.fn>
  let roomSummaryService: any
  const temporaryDirectories: string[] = []

  beforeEach(async () => {
    resetAgentStatusRegistryForTests()
    updateAgentStatus('hermes', {
      installed: true,
      source: 'user-cli',
      path: '/usr/local/bin/hermes',
    })
    for (const id of ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor'] as const) {
      updateAgentStatus(id, { installed: true, source: 'user-cli', path: `/usr/local/bin/${id}` })
    }
    storage = {
      rooms: new Map<string, any>(),
      agents: new Map<string, any[]>(),
      messages: new Map<string, any[]>(),
      members: new Map<string, any[]>(),
      saveRoom: vi.fn((id, name, inviteCode, config) => storage.rooms.set(id, { id, name, inviteCode, totalTokens: 0, sessionSeed: '0', ...config })),
      getRoom: vi.fn((id) => storage.rooms.get(id)),
      getAllRooms: vi.fn(() => [...storage.rooms.values()]),
      getRoomsForProfiles: vi.fn(() => [...storage.rooms.values()]),
      getRoomsForAuthUser: vi.fn(() => []),
      getOwnedRoomsForAuthUser: vi.fn(() => []),
      getRecentMessagesForUI: vi.fn((roomId, limit = 150, offset = 0) => (storage.messages.get(roomId) || []).slice(offset, offset + limit)),
      getHistoryPageForUI: vi.fn((roomId, limit = 150, beforeMessageId?: string) => {
        const rows = storage.messages.get(roomId) || []
        const beforeIndex = beforeMessageId ? rows.findIndex((message: any) => message.id === beforeMessageId) : rows.length
        if (beforeMessageId && beforeIndex < 0) {
          return { messages: [], hasMore: false, cursorFound: false }
        }
        const start = Math.max(0, beforeIndex - limit)
        return {
          messages: rows.slice(start, beforeIndex),
          hasMore: start > 0,
          cursorFound: true,
        }
      }),
      getMessageCount: vi.fn((roomId) => (storage.messages.get(roomId) || []).length),
      getMessage: vi.fn((messageId) => [...storage.messages.values()].flat().find((message: any) => message.id === messageId) || null),
      getRoomAgents: vi.fn((roomId) => storage.agents.get(roomId) || []),
      getRoomMembers: vi.fn((roomId) => storage.members.get(roomId) || []),
      getMemberByUserId: vi.fn((roomId, userId) => (storage.members.get(roomId) || []).find((member: any) => member.userId === userId) || null),
      removeRoomMember: vi.fn((roomId, userId) => storage.members.set(
        roomId,
        (storage.members.get(roomId) || []).filter((member: any) => member.userId !== userId),
      )),
      getRoomByInviteCode: vi.fn((code) => [...storage.rooms.values()].find((r: any) => r.inviteCode === code)),
      addRoomAgent: vi.fn((roomId, agentId, profile, name, description, invited, metadata = {}) => {
        const row = { id: `row-${agentId}`, roomId, agentId, profile, name, description, invited, ...metadata }
        storage.agents.set(roomId, [...(storage.agents.get(roomId) || []), row])
        return row
      }),
      getRoomAgent: vi.fn((roomId, ref) => (storage.agents.get(roomId) || []).find((a: any) => a.id === ref || a.agentId === ref) || null),
      updateRoomAgent: vi.fn((roomId, ref, profile, name, description, metadata = {}) => {
        const rows = storage.agents.get(roomId) || []
        const row = rows.find((agent: any) => agent.id === ref || agent.agentId === ref)
        if (!row) return null
        Object.assign(row, { profile, name, description, ...metadata })
        return row
      }),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn((roomId, ref) => storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((a: any) => a.id !== ref && a.agentId !== ref))),
      clearRoomContext: vi.fn((roomId) => { const room = storage.rooms.get(roomId); if (room) Object.assign(room, { totalTokens: 0, sessionSeed: 'rotated' }) }),
      updateRoomConfig: vi.fn((roomId, config) => {
        const room = storage.rooms.get(roomId)
        if (room) Object.assign(room, config)
        return room
      }),
      updateRoomInviteCode: vi.fn((roomId, inviteCode) => {
        const room = storage.rooms.get(roomId)
        if (room) room.inviteCode = inviteCode
      }),
      updateRoomGuestAgentPolicy: vi.fn((roomId, policy) => {
        const room = storage.rooms.get(roomId)
        if (room) {
          Object.assign(room, {
            allowGuestAgents: policy.allowGuestAgents ? 1 : 0,
            guestAgentApproval: 'owner',
            maxGuestAgentsPerMember: policy.maxGuestAgentsPerMember,
            allowRemoteWorkspaceAccess: policy.allowGuestAgents && policy.allowRemoteWorkspaceAccess ? 1 : 0,
          })
        }
        return room || null
      }),
      deleteRoom: vi.fn((roomId) => storage.rooms.delete(roomId)),
      getStoppedHandoffChains: vi.fn(() => []),
    }
    agentClients = {
      createAgent: vi.fn(async (cfg: any) => {
        if (cfg.profile === 'bad-profile') throw new Error('agent runtime unavailable')
        return { ...cfg, joinRoom: vi.fn(async () => ({})), disconnect: vi.fn() }
      }),
      addAgentToRoom: vi.fn(async () => ({})),
      removeAgentFromRoom: vi.fn(),
      disconnectRoom: vi.fn(),
    }
    clearRoomRuntimeState = vi.fn()
    updateRoomName = vi.fn((roomId: string, name: string) => {
      const room = storage.rooms.get(roomId)
      if (room) room.name = name
      return room || null
    })
    broadcastRoomMetadata = vi.fn((roomId: string) => storage.getRoom(roomId) || null)
    broadcastRoomAgents = vi.fn((roomId: string) => storage.getRoomAgents(roomId))
    removeLiveRoomMember = vi.fn((roomId: string, userId: string) => {
      storage.removeRoomMember(roomId, userId)
      return storage.getRoomMembers(roomId)
    })
    publishAgentAttachmentMessage = vi.fn(() => ({ id: 'agent-attachment-message-1' }))
    roomSummaryService = {
      runExclusive: vi.fn(async (_roomId: string, task: () => unknown) => task()),
      getState: vi.fn((roomId: string) => ({
        roomId,
        summary: '',
        summaryThroughMessageId: '',
        summaryThroughMessageTimestamp: 0,
        summarizedTurnCount: 0,
        status: 'idle',
        version: 0,
        updatedAt: 0,
        lastError: null,
      })),
      updateSummaryText: vi.fn(async (roomId: string, summary: string) => ({
        roomId,
        summary,
        summaryThroughMessageId: '',
        summaryThroughMessageTimestamp: 0,
        summarizedTurnCount: 0,
        status: 'success',
        version: 1,
        updatedAt: 10,
        lastError: null,
      })),
    }
    setGroupChatServer({
      getStorage: () => storage,
      getRoomSummaryService: () => roomSummaryService,
      agentClients,
      clearRoomRuntimeState,
      deleteRoomRuntimeState: vi.fn(async () => {}),
      updateRoomName,
      broadcastRoomMetadata,
      broadcastRoomAgents,
      broadcastGuestAgentPolicy: vi.fn(),
      removeRoomMember: removeLiveRoomMember,
      publishAgentAttachmentMessage,
      getRoomAgentViews: (roomId: string) => storage.getRoomAgents(roomId),
      ensureDefaultRoomWorkspace: (roomId: string, profile: string) => `/managed/group-chat/${profile}/${roomId}`,
    } as any)
    const app = new Koa()
    app.use(bodyParser())
    app.use(async (ctx, next) => {
      const userId = Number(ctx.get('x-test-user-id') || 0)
      if (userId > 0) ctx.state.user = { id: userId, role: 'user', profiles: [] }
      if (ctx.get('x-test-user') === 'member') {
        ctx.state.user = { id: 7, username: 'member', role: 'user', profiles: ['default'] }
      }
      await next()
    })
    app.use(groupChatPublicRoutes.routes())
    app.use(groupChatRoutes.routes())
    httpServer = createServer(app.callback())
    baseUrl = await listen(httpServer)
  })

  afterEach(async () => {
    httpServer.close()
    setGroupChatServer(null as any)
    resetRemoteWorkspaceGrantsForTest()
    resetAgentStatusRegistryForTests()
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('requires name and inviteCode when creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Room' }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'name and inviteCode are required' })
  })

  it('resolves invite-only room metadata without exposing management fields', async () => {
    storage.rooms.set('room-1', {
      id: 'room-1',
      name: 'Shared Room',
      inviteCode: 'ROOM1',
      workspace: '/private/workspace',
      summaryProfile: 'default',
    })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/join/ROOM1`)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      room: {
        id: 'room-1',
        name: 'Shared Room',
        inviteCode: null,
        canManage: false,
        canMentionAll: false,
        ownerMemberId: '',
        summaryProfile: '',
        summaryProvider: '',
        summaryModel: '',
        summaryApiMode: '',
        summaryEveryTurns: 0,
        totalTokens: 0,
        workspace: '',
        allowGuestAgents: 0,
        guestAgentApproval: 'owner',
        maxGuestAgentsPerMember: 1,
      },
    })
  })

  it('updates guest Agent policy without returning internal room ownership fields', async () => {
    storage.rooms.set('room-1', {
      id: 'room-1',
      name: 'Owner Room',
      ownerAuthUserId: 7,
      inviteCode: 'SECRET',
      workspace: '/private/workspace',
      allowGuestAgents: 0,
      guestAgentApproval: 'owner',
      maxGuestAgentsPerMember: 1,
    })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/guest-agent-policy`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': '7',
      },
      body: JSON.stringify({
        allowGuestAgents: true,
        maxGuestAgentsPerMember: 2,
        allowRemoteWorkspaceAccess: true,
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      policy: {
        allowGuestAgents: 1,
        guestAgentApproval: 'owner',
        maxGuestAgentsPerMember: 2,
        allowRemoteWorkspaceAccess: 1,
      },
    })
  })

  it('rotates the invite code without removing existing remote Agents', async () => {
    const remoteAgent = {
      id: 'remote-row',
      roomId: 'room-1',
      agentId: 'remote-agent',
      name: 'Remote Agent',
      executorType: 'remote',
      connectorId: 'connector-1',
    }
    storage.rooms.set('room-1', {
      id: 'room-1',
      name: 'Owner Room',
      ownerAuthUserId: 7,
      inviteCode: 'OLD-CODE',
    })
    storage.agents.set('room-1', [remoteAgent])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/invite-code`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': '7',
      },
      body: JSON.stringify({ inviteCode: 'NEW-CODE' }),
    })

    expect(res.status).toBe(200)
    expect(storage.updateRoomInviteCode).toHaveBeenCalledWith('room-1', 'NEW-CODE')
    expect(broadcastRoomMetadata).toHaveBeenCalledWith('room-1')
    expect(storage.getRoomAgents('room-1')).toEqual([remoteAgent])
    expect(storage.removeRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.removeAgentFromRoom).not.toHaveBeenCalled()
  })

  it('generates a fresh invite code when cloning a room', async () => {
    storage.rooms.set('room-source', {
      id: 'room-source',
      name: 'Source Room',
      inviteCode: 'SOURCE-CODE',
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'summary-model',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 20,
      workspace: '',
    })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-source/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cloned Room' }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.room).toMatchObject({ name: 'Cloned Room' })
    expect(body.room.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)
    expect(body.room.inviteCode).not.toBe('SOURCE-CODE')
  })

  it('serves the remote workspace API only with an active run-bound grant', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'group-chat-remote-route-'))
    temporaryDirectories.push(workspace)
    await writeFile(join(workspace, 'shared.txt'), 'shared content')
    storage.rooms.set('room-remote', {
      id: 'room-remote',
      name: 'Remote Room',
      workspace,
      allowRemoteWorkspaceAccess: 1,
    })
    const { token } = issueRemoteWorkspaceGrant({
      runId: 'run-route',
      roomId: 'room-remote',
      agentId: 'agent-route',
      workspace,
    })
    const endpoint = `${baseUrl}/api/studio/group-chat/remote-workspace/v1`

    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', path: 'shared.txt' }),
    })
    expect(unauthorized.status).toBe(401)

    const authorized = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'read', path: 'shared.txt' }),
    })
    expect(authorized.status).toBe(200)
    await expect(authorized.json()).resolves.toMatchObject({
      ok: true,
      path: 'shared.txt',
      content: 'shared content',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    const binary = Buffer.from([0x00, 0xff, 0x10, 0x20])
    const upload = await fetch(`${endpoint}/file?path=${encodeURIComponent('artifacts/data.bin')}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: binary,
    })
    expect(upload.status).toBe(200)
    const uploaded = await upload.json() as { sha256: string; messageId: string }
    expect(uploaded.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(uploaded.messageId).toBe('agent-attachment-message-1')
    expect(publishAgentAttachmentMessage).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-remote',
      agentId: 'agent-route',
      runId: 'run-route',
      workspacePath: 'artifacts/data.bin',
    }))

    const download = await fetch(`${endpoint}/file?path=${encodeURIComponent('artifacts/data.bin')}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get('x-content-sha256')).toBe(uploaded.sha256)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(binary)

    const overwriteWithoutHash = await fetch(
      `${endpoint}/file?path=${encodeURIComponent('artifacts/data.bin')}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('replacement'),
      },
    )
    expect(overwriteWithoutHash.status).toBe(409)
    await expect(overwriteWithoutHash.json()).resolves.toMatchObject({ code: 'workspace_conflict' })

    const replacement = Buffer.from([0x11, 0x22])
    const overwrite = await fetch(`${endpoint}/file?path=${encodeURIComponent('artifacts/data.bin')}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'X-Expected-SHA256': uploaded.sha256,
      },
      body: replacement,
    })
    expect(overwrite.status).toBe(200)
    expect(await readFile(join(workspace, 'artifacts/data.bin'))).toEqual(replacement)

    revokeRemoteWorkspaceGrantsForRun('run-route')
    const revoked = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'list', path: '' }),
    })
    expect(revoked.status).toBe(401)
  })

  it('returns public lastActiveAt and keeps the aggregated authenticated room list ordered by activity instead of room id', async () => {
    storage.getRoomsForProfiles.mockReturnValue([
      { id: 'room-old-active', name: 'Old but active', inviteCode: 'Z', createdAt: 100, lastActiveAt: 300 },
    ])
    storage.getRoomsForAuthUser.mockReturnValue([
      { id: 'room-new-created', name: 'New but inactive', inviteCode: 'A', createdAt: 200, lastActiveAt: 200 },
    ])
    storage.getOwnedRoomsForAuthUser.mockReturnValue([])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms`, {
      headers: { 'x-test-user': 'member' },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      rooms: [
        { id: 'room-old-active', lastActiveAt: 300 },
        { id: 'room-new-created', lastActiveAt: 200 },
      ],
    })
  })

  it('projects each visible room persistent Agent roster without runtime-only connection fields', async () => {
    storage.getRoomsForProfiles.mockReturnValue([
      { id: 'room-agents', name: 'Agent room', inviteCode: 'AGENTS', lastActiveAt: 300 },
    ])
    storage.agents.set('room-agents', [{
      id: 'row-agent',
      roomId: 'room-agents',
      agentId: 'agent-1',
      agent: 'codex',
      profile: 'private-profile',
      provider: 'private-provider',
      model: 'private-model',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Builder',
      description: 'Private description',
      avatar: '{"type":"generated","seed":"builder"}',
      invited: 0,
      connectorId: 'secret-connector',
      remoteOrigin: 'private-origin',
      ownerMemberId: 'auth:7',
    }])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms`, {
      headers: { 'x-test-user': 'member' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.rooms[0].agents).toEqual([{
      id: 'row-agent',
      roomId: 'room-agents',
      agentId: 'agent-1',
      agent: 'codex',
      name: 'Builder',
      avatar: '{"type":"generated","seed":"builder"}',
    }])
  })

  it('paginates the authorized room list without changing activity order', async () => {
    storage.getRoomsForProfiles.mockReturnValue([
      { id: 'room-3', name: 'Third', inviteCode: 'C', lastActiveAt: 100 },
      { id: 'room-1', name: 'First', inviteCode: 'A', lastActiveAt: 300 },
      { id: 'room-2', name: 'Second', inviteCode: 'B', lastActiveAt: 200 },
    ])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms?limit=1&offset=1`, {
      headers: { 'x-test-user': 'member' },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      rooms: [{ id: 'room-2', lastActiveAt: 200 }],
      total: 3,
      offset: 1,
      limit: 1,
      hasMore: true,
    })
  })

  it('reports authoritative truncation and serves complete history by stable message id', async () => {
    storage.rooms.set('room-history', {
      id: 'room-history',
      name: 'History Room',
      inviteCode: 'HISTORY',
      lastActiveAt: 501,
    })
    storage.getRoomsForProfiles.mockReturnValue([storage.rooms.get('room-history')])
    const retainedMessages = Array.from({ length: 500 }, (_, index) => ({
      id: `message-${String(index + 1).padStart(4, '0')}`,
      roomId: 'room-history',
      senderId: 'member',
      senderName: 'Member',
      content: `Message ${index + 1}`,
      timestamp: index + 1,
      role: 'user',
    }))
    storage.messages.set('room-history', retainedMessages)

    const exactWindow = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-history?limit=150`, {
      headers: { 'x-test-user': 'member' },
    })
    expect(exactWindow.status).toBe(200)
    await expect(exactWindow.json()).resolves.toMatchObject({
      total: 500,
      historyTruncated: false,
    })

    retainedMessages.push({
      id: 'message-0501',
      roomId: 'room-history',
      senderId: 'member',
      senderName: 'Member',
      content: 'Message 501',
      timestamp: 501,
      role: 'user',
    })

    const recent = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-history?limit=150`, {
      headers: { 'x-test-user': 'member' },
    })
    expect(recent.status).toBe(200)
    await expect(recent.json()).resolves.toMatchObject({
      total: 501,
      historyTruncated: true,
    })

    const history = await fetch(
      `${baseUrl}/api/studio/group-chat/rooms/room-history?history=1&before=message-0352&limit=150`,
      { headers: { 'x-test-user': 'member' } },
    )
    expect(history.status).toBe(200)
    const historyBody = await history.json() as any
    expect(historyBody.messages[0]?.id).toBe('message-0202')
    expect(historyBody.messages.at(-1)?.id).toBe('message-0351')
    expect(historyBody.total).toBe(501)
    expect(historyBody.hasMore).toBe(true)
  })

  it('rejects reserved @all agent names when creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Room', inviteCode: 'ROOM1', agents: [{ profile: 'default', name: 'all' }] }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: '`all` is reserved for @all mentions' })
  })

  it('creates a room, persists successful agents, and reports agent connection failures', async () => {
    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Room',
        inviteCode: 'ROOM1',
        agents: [
          { profile: 'default', name: 'Worker' },
          { profile: 'bad-profile', name: 'Broken' },
        ],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.room).toMatchObject({ name: 'Room', inviteCode: 'ROOM1' })
    expect(body.agents).toHaveLength(1)
    expect(body.agentResults).toEqual([
      expect.objectContaining({ profile: 'default', ok: true }),
      expect.objectContaining({ profile: 'bad-profile', ok: false, code: 'PROFILE_AGENT_CONNECT_FAILED' }),
    ])
    expect(storage.saveRoom).toHaveBeenCalled()
  })

  it('persists the selected rolling-summary runtime when creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Summary Room',
        inviteCode: 'SUM123',
        summary: {
          profile: 'research',
          provider: 'openai',
          model: 'gpt-summary',
          apiMode: 'codex_responses',
          everyTurns: 12,
        },
        agents: [],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.saveRoom).toHaveBeenCalledWith(
      expect.any(String),
      'Summary Room',
      'SUM123',
      expect.objectContaining({
        summaryProfile: 'research',
        summaryProvider: 'openai',
        summaryModel: 'gpt-summary',
        summaryApiMode: 'codex_responses',
        summaryEveryTurns: 12,
      }),
    )
    expect(body.room).toMatchObject({
      summaryProfile: 'research',
      summaryProvider: 'openai',
      summaryModel: 'gpt-summary',
      summaryApiMode: 'codex_responses',
      summaryEveryTurns: 12,
    })
  })

  it('updates summary config, reads its anchor, and manually edits its text', async () => {
    storage.rooms.set('room-1', {
      id: 'room-1',
      name: 'Room',
      inviteCode: 'ROOM1',
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'old-model',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 20,
    })
    storage.messages.set('room-1', [{
      id: 'anchor-1',
      timestamp: 5,
      senderName: 'Agent',
      role: 'assistant',
      content: 'Anchor content',
    }])
    roomSummaryService.getState.mockReturnValue({
      roomId: 'room-1',
      summary: 'Current summary',
      summaryThroughMessageId: 'anchor-1',
      summaryThroughMessageTimestamp: 5,
      summarizedTurnCount: 10,
      status: 'success',
      version: 2,
      updatedAt: 6,
      lastError: null,
    })

    const configRes = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed Room',
        summaryProfile: 'research',
        summaryProvider: 'anthropic',
        summaryModel: 'claude-test',
        summaryApiMode: 'anthropic_messages',
        summaryEveryTurns: 8,
      }),
    })
    expect(configRes.status).toBe(200)
    expect(updateRoomName).toHaveBeenCalledWith('room-1', 'Renamed Room')
    expect(storage.updateRoomConfig).toHaveBeenCalledWith('room-1', {
      summaryProfile: 'research',
      summaryProvider: 'anthropic',
      summaryModel: 'claude-test',
      summaryApiMode: 'anthropic_messages',
      summaryEveryTurns: 8,
    })
    await expect(configRes.json()).resolves.toMatchObject({
      room: { id: 'room-1', name: 'Renamed Room' },
    })

    const getRes = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/summary`)
    await expect(getRes.json()).resolves.toMatchObject({
      summary: {
        summary: 'Current summary',
        summaryThroughMessageId: 'anchor-1',
      },
      anchor: {
        id: 'anchor-1',
        content: 'Anchor content',
      },
    })

    const editRes = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/summary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Manually corrected summary' }),
    })
    expect(editRes.status).toBe(200)
    expect(roomSummaryService.updateSummaryText).toHaveBeenCalledWith('room-1', 'Manually corrected summary')
  })

  it('renames a legacy room without requiring summary runtime fields', async () => {
    storage.rooms.set('room-legacy', {
      id: 'room-legacy',
      name: 'Legacy Room',
      inviteCode: 'LEGACY',
      summaryProvider: '',
      summaryModel: '',
    })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-legacy/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Legacy Room' }),
    })

    expect(res.status).toBe(200)
    expect(updateRoomName).toHaveBeenCalledWith('room-legacy', 'Renamed Legacy Room')
    expect(storage.updateRoomConfig).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toMatchObject({
      room: { id: 'room-legacy', name: 'Renamed Legacy Room' },
    })
  })

  it('returns room detail with paging metadata, agents, and members', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.messages.set('room-1', [{ id: 'msg-1' }, { id: 'msg-2' }])
    storage.agents.set('room-1', [{ id: 'row-agent', agentId: 'agent-1', profile: 'default', name: 'Agent' }])
    storage.members.set('room-1', [{ userId: 'user-1', name: 'Alice' }])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1?limit=1&offset=1`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      room: { id: 'room-1', name: 'Room' },
      messages: [{ id: 'msg-2' }],
      agents: [{ agentId: 'agent-1' }],
      members: [{ userId: 'user-1' }],
      handoffChains: [],
      total: 2,
      offset: 1,
      limit: 1,
      hasMore: false,
    })
  })

  it('continues REST pagination beyond the Agent context window', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.getMessageCount.mockReturnValueOnce(580)
    storage.getRecentMessagesForUI.mockReturnValueOnce([])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1?limit=100&offset=500`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      messages: [],
      total: 580,
      offset: 500,
      limit: 100,
      hasMore: true,
      historyTruncated: true,
    })
  })

  it('clones the room Agent handoff policy without copying stopped chains', async () => {
    storage.rooms.set('room-source', {
      id: 'room-source',
      name: 'Source',
      inviteCode: 'SOURCE',
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'summary-model',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 20,
      workspace: '',
      agentHandoffEnabled: 0,
      agentHandoffMaxDepth: 6,
      agentHandoffUnlimited: 0,
    })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-source/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clone' }),
    })

    expect(res.status).toBe(200)
    expect(storage.saveRoom).toHaveBeenCalledWith(
      expect.any(String),
      'Clone',
      expect.any(String),
      expect.objectContaining({
        agentHandoffEnabled: false,
        agentHandoffMaxDepth: 6,
        agentHandoffUnlimited: false,
      }),
    )
  })

  it('allows multiple room agents backed by the same profile', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{ id: 'row-agent', agentId: 'agent-1', profile: 'default', name: 'Agent' }])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Second Agent' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      agent: {
        profile: 'default',
        name: 'Second Agent',
      },
    })
    expect(storage.getRoomAgents('room-1')).toHaveLength(2)
  })

  it('allows only the room owner to remove a member and removes that member remote Agents', async () => {
    storage.rooms.set('room-1', {
      id: 'room-1',
      name: 'Room',
      inviteCode: 'ROOM1',
      ownerAuthUserId: 1,
    })
    storage.members.set('room-1', [
      { id: 'owner-row', userId: 'auth:1', name: 'Owner' },
      { id: 'guest-row', userId: 'guest-1', name: 'Guest' },
    ])
    storage.agents.set('room-1', [{
      id: 'remote-row',
      agentId: 'remote-agent',
      profile: 'default',
      name: 'Remote Agent',
      executorType: 'remote',
      ownerMemberId: 'guest-1',
      connectorId: '',
    }])

    const denied = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/members/guest-1`, {
      method: 'DELETE',
      headers: { 'x-test-user-id': '2' },
    })
    expect(denied.status).toBe(403)

    const removed = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/members/guest-1`, {
      method: 'DELETE',
      headers: { 'x-test-user-id': '1' },
    })
    expect(removed.status).toBe(200)
    await expect(removed.json()).resolves.toMatchObject({
      success: true,
      members: [{ userId: 'auth:1' }],
      agents: [],
    })
    expect(removeLiveRoomMember).toHaveBeenCalledWith('room-1', 'guest-1')
    expect(storage.removeRoomAgent).toHaveBeenCalledWith('room-1', 'remote-row')
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'remote-agent')
  })

  it('persists the selected provider, model, api mode, and reasoning effort for a room agent', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        name: 'Researcher',
        description: 'Finds evidence',
        avatar: JSON.stringify({ type: 'generated', seed: 'researcher-avatar' }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Researcher',
      description: 'Finds evidence',
    }))
    expect(storage.addRoomAgent).toHaveBeenCalledWith(
      'room-1',
      expect.any(String),
      'research',
      'Researcher',
      'Finds evidence',
      0,
      {
        agent: 'codex',
        agentMode: 'scoped',
        priorAgentMode: '',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        avatar: JSON.stringify({ type: 'generated', seed: 'researcher-avatar' }),
      },
    )
    expect(body.agent).toMatchObject({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      avatar: JSON.stringify({ type: 'generated', seed: 'researcher-avatar' }),
    })
    expect(broadcastRoomAgents).toHaveBeenCalledWith('room-1')
  })

  it('rejects adding a room agent that is not installed', async () => {
    updateAgentStatus('codex', {
      installed: false,
      source: 'not-installed',
      path: '',
      version: '',
    })
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
      }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      code: 'AGENT_NOT_INSTALLED',
      error: 'Codex is not installed',
      agent: 'codex',
    })
    expect(agentClients.createAgent).not.toHaveBeenCalled()
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
  })

  it('creates, adds, and updates Pi room agents through the local API', async () => {
    const createRoom = await fetch(`${baseUrl}/api/studio/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Pi Room',
        inviteCode: 'PIROOM',
        agents: [{
          agent: 'pi',
          profile: 'default',
          provider: 'openai',
          model: 'pi-create-model',
          apiMode: 'codex_responses',
          name: 'Pi Creator',
        }],
      }),
    })
    expect(createRoom.status).toBe(200)
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'pi',
      model: 'pi-create-model',
      apiMode: 'codex_responses',
    }))

    storage.rooms.set('room-pi', { id: 'room-pi', name: 'Pi Room', inviteCode: 'PIROOM2' })
    const addAgent = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-pi/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'pi',
        profile: 'research',
        provider: 'openai',
        model: 'pi-add-model',
        apiMode: 'codex_responses',
        reasoningEffort: 'medium',
        name: 'Pi Worker',
      }),
    })
    expect(addAgent.status).toBe(200)
    const added = await addAgent.json()
    expect(added.agent).toMatchObject({
      agent: 'pi',
      profile: 'research',
      model: 'pi-add-model',
      apiMode: 'codex_responses',
    })

    const updateAgent = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-pi/agents/${added.agent.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'pi',
        profile: 'research',
        provider: 'openai',
        model: 'pi-updated-model',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        name: 'Pi Reviewer',
      }),
    })
    expect(updateAgent.status).toBe(200)
    await expect(updateAgent.json()).resolves.toMatchObject({
      agent: expect.objectContaining({
        agent: 'pi',
        model: 'pi-updated-model',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
      }),
    })
  })

  it('rejects incomplete or invalid room agent runtime configuration', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const missingModel = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'research', provider: 'openai' }),
    })
    expect(missingModel.status).toBe(400)

    const invalidReasoning = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        reasoningEffort: 'extreme',
      }),
    })
    expect(invalidReasoning.status).toBe(400)

    const missingApiMode = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
      }),
    })
    expect(missingApiMode.status).toBe(400)

    const invalidApiMode = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'ekko',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'unsupported',
      }),
    })
    expect(invalidApiMode.status).toBe(400)

    const invalidAgent = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'unknown',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
      }),
    })
    expect(invalidAgent.status).toBe(400)

    const invalidAvatar = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        avatar: JSON.stringify({ type: 'image', dataUrl: 'javascript:alert(1)' }),
      }),
    })
    expect(invalidAvatar.status).toBe(400)
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('ignores apiMode for Hermes room agents', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'hermes',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'anthropic_messages',
      }),
    })

    expect(res.status).toBe(200)
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'hermes',
      apiMode: '',
    }))
    expect(storage.addRoomAgent.mock.calls.at(-1)?.[6]).toMatchObject({
      agent: 'hermes',
      apiMode: '',
    })
  })

  it('updates a room agent while preserving its identity and replacing its group runtime', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{
      id: 'row-agent',
      roomId: 'room-1',
      agentId: 'agent-1',
      agent: 'hermes',
      profile: 'default',
      provider: 'openai',
      model: 'old-model',
      apiMode: '',
      reasoningEffort: '',
      name: 'Worker',
      description: '',
      invited: 0,
    }])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents/row-agent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'new-model',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        name: 'Reviewer',
        description: 'Reviews changes',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      agent: 'codex',
      profile: 'research',
      model: 'new-model',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
    }))
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-1')
    expect(agentClients.addAgentToRoom).toHaveBeenCalled()
    expect(storage.updateRoomAgent).toHaveBeenCalledWith(
      'room-1',
      'row-agent',
      'research',
      'Reviewer',
      'Reviews changes',
      {
        agent: 'codex',
        agentMode: 'scoped',
        priorAgentMode: '',
        provider: 'openai',
        model: 'new-model',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
      },
    )
    expect(body.agent).toMatchObject({
      id: 'row-agent',
      agentId: 'agent-1',
      profile: 'research',
      name: 'Reviewer',
    })
    expect(broadcastRoomAgents).toHaveBeenCalledWith('room-1')
  })

  it('keeps the stashed launch mode when saving a Cursor room agent', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'cursor',
        agentMode: 'global',
        priorAgentMode: 'global',
        profile: 'research',
        name: 'Cursor',
      }),
    })

    expect(res.status).toBe(200)
    const created = await res.json()
    expect(created).toMatchObject({
      agent: expect.objectContaining({
        agent: 'cursor',
        agentMode: 'global',
        priorAgentMode: 'global',
      }),
    })
    expect(storage.addRoomAgent.mock.calls.at(-1)?.[6]).toMatchObject({
      agent: 'cursor',
      agentMode: 'global',
      priorAgentMode: 'global',
    })

    const updated = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents/${created.agent.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        agentMode: 'global',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        name: 'Codex',
      }),
    })

    expect(updated.status).toBe(200)
    expect(storage.updateRoomAgent.mock.calls.at(-1)?.[5]).toMatchObject({
      agent: 'codex',
      agentMode: 'global',
      priorAgentMode: '',
    })
  })

  it.each(['codex', 'dsh'] as const)('uses global CLI configuration for %s without persisting scoped overrides', async agent => {
    storage.rooms.set('room-global', { id: 'room-global', name: 'Global Room', inviteCode: 'GLOBAL1' })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-global/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent,
        agentMode: 'global',
        profile: 'research',
        provider: 'must-not-persist',
        model: 'must-not-persist',
        apiMode: 'chat_completions',
        reasoningEffort: 'high',
        name: 'Global Codex',
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      agent: expect.objectContaining({
        agent,
        agentMode: 'global',
        provider: '',
        model: '',
        apiMode: '',
        reasoningEffort: '',
      }),
    })
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent,
      agentMode: 'global',
      provider: '',
      model: '',
      apiMode: '',
      reasoningEffort: '',
    }))
    expect(storage.addRoomAgent.mock.calls.at(-1)?.[6]).toMatchObject({
      agent,
      agentMode: 'global',
      provider: '',
      model: '',
      apiMode: '',
      reasoningEffort: '',
    })

    const unsupported = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-global/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'ekko',
        agentMode: 'global',
        profile: 'research',
        name: 'Global Ekko',
      }),
    })
    expect(unsupported.status).toBe(400)
    await expect(unsupported.json()).resolves.toEqual({
      error: 'Global mode is only available for Claude, Codex, Pi, and Grok',
    })
  })

  it('rejects a concurrent update for the same room agent before runtime and persistence can interleave', async () => {
    storage.rooms.set('room-lock', { id: 'room-lock', name: 'Room', inviteCode: 'LOCK' })
    storage.agents.set('room-lock', [{
      id: 'row-lock', roomId: 'room-lock', agentId: 'agent-lock', agent: 'hermes', profile: 'default',
      provider: 'openai', model: 'old', apiMode: '', reasoningEffort: '', name: 'Worker', description: '', invited: 0,
    }])
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    agentClients.createAgent.mockImplementationOnce(async (cfg: any) => {
      await blocked
      return { ...cfg, joinRoom: vi.fn(async () => ({})), disconnect: vi.fn() }
    })
    const request = (model: string) => fetch(`${baseUrl}/api/studio/group-chat/rooms/room-lock/agents/row-lock`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'hermes', profile: 'default', provider: 'openai', model, name: 'Worker' }),
    })

    const first = request('first')
    await vi.waitFor(() => expect(agentClients.createAgent).toHaveBeenCalled())
    const second = await request('second')
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'Agent configuration update is already in progress' })
    const removed = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-lock/agents/row-lock`, { method: 'DELETE' })
    expect(removed.status).toBe(409)
    expect(await removed.json()).toEqual({ error: 'Agent configuration update is already in progress' })
    expect(storage.removeRoomAgent).not.toHaveBeenCalledWith('room-lock', 'row-lock')
    const roomRemoved = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-lock`, { method: 'DELETE' })
    expect(roomRemoved.status).toBe(409)
    expect(await roomRemoved.json()).toEqual({ error: 'Agent configuration update is already in progress' })
    release()
    expect((await first).status).toBe(200)
  })

  it('rejects agent updates and removals while room deletion is already in progress', async () => {
    storage.rooms.set('room-delete-lock', { id: 'room-delete-lock', name: 'Room', inviteCode: 'DELETE' })
    storage.agents.set('room-delete-lock', [{
      id: 'row-delete-lock', roomId: 'room-delete-lock', agentId: 'agent-delete-lock', agent: 'hermes',
      profile: 'default', provider: 'openai', model: 'old', apiMode: '', reasoningEffort: '',
      name: 'Worker', description: '', invited: 0,
    }])
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    roomSummaryService.runExclusive.mockImplementationOnce(async (_roomId: string, task: () => unknown) => {
      await blocked
      return task()
    })

    const deleting = fetch(`${baseUrl}/api/studio/group-chat/rooms/room-delete-lock`, { method: 'DELETE' })
    await vi.waitFor(() => expect(roomSummaryService.runExclusive).toHaveBeenCalled())
    const update = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-delete-lock/agents/row-delete-lock`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'hermes', profile: 'default', provider: 'openai', model: 'new', name: 'Worker' }),
    })
    expect(update.status).toBe(409)
    expect(await update.json()).toEqual({ error: 'Room deletion is already in progress' })
    const remove = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-delete-lock/agents/row-delete-lock`, { method: 'DELETE' })
    expect(remove.status).toBe(409)
    expect(await remove.json()).toEqual({ error: 'Room deletion is already in progress' })
    release()
    expect((await deleting).status).toBe(200)
  })

  it('removes an agent by row id and disconnects runtime by persisted agent id', async () => {
    const agent = { id: 'row-agent', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Agent' }
    storage.agents.set('room-1', [agent])

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/agents/row-agent`, { method: 'DELETE' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.removeRoomMembersForAgent).toHaveBeenCalledWith('room-1', agent)
    expect(storage.removeRoomAgent).toHaveBeenCalledWith('room-1', 'row-agent')
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-1')
    expect(body).toMatchObject({ success: true, agents: [], members: [] })
    expect(broadcastRoomAgents).toHaveBeenCalledWith('room-1')
  })

  it('clears room context and runtime state while returning the updated room', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99, sessionSeed: 'old' })

    const res = await fetch(`${baseUrl}/api/studio/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.clearRoomContext).toHaveBeenCalledWith('room-1')
    expect(clearRoomRuntimeState).toHaveBeenCalledWith('room-1')
    expect(body).toMatchObject({ success: true, room: { id: 'room-1', totalTokens: 0, sessionSeed: 'rotated' } })
  })
})
