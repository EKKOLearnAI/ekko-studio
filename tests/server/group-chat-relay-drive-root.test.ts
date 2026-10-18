import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  startCheckpoint: vi.fn(),
  completeCheckpoint: vi.fn(() => null),
  discardCheckpoint: vi.fn(),
}))

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: mocks.mkdir,
}))

vi.mock('../../packages/server/src/modules/studio/services/group-chat/agent-clients', () => ({
  AgentClient: class {
    connect = vi.fn(async () => {})
    joinRoom = vi.fn(async () => {})
    setStorage = vi.fn()
    disconnect = vi.fn()
  },
}))

vi.mock('../../packages/server/src/modules/studio/services/group-chat/agent-relay-store', () => ({
  subscribeGroupAgentConnectorRevocations: () => () => {},
  touchGroupAgentConnector: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: mocks.startCheckpoint,
  completeWorkspaceRunCheckpointDraft: mocks.completeCheckpoint,
  discardWorkspaceRunCheckpoint: mocks.discardCheckpoint,
}))

import { GroupAgentRelayServer } from '../../packages/server/src/modules/studio/services/group-chat/agent-relay'
import {
  authenticateRemoteWorkspaceGrant,
  resetRemoteWorkspaceGrantsForTest,
} from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-auth'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('remote group Agent shared workspace preparation', () => {
  const servers: GroupAgentRelayServer[] = []
  const directories: string[] = []

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.mkdir.mockReset()
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    mocks.mkdir.mockImplementation(fs.mkdir)
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', originalPlatform)
    for (const server of servers.splice(0)) server.shutdown()
    resetRemoteWorkspaceGrantsForTest()
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function connect(workspace: string, share = true) {
    const room = { id: 'room-1', name: 'Room', workspace, allowRemoteWorkspaceAccess: share ? 1 : 0 }
    const agent = { id: 'link-1', roomId: room.id, agentId: 'remote-1', executorType: 'remote', name: 'Worker' }
    const handlers = new Map<string, (...args: any[]) => void>()
    const requests: any[] = []
    const grantedWorkspaces: Array<string | undefined> = []
    let onConnection: (socket: any) => void = () => {}
    const namespace = {
      use: vi.fn(),
      on: vi.fn((_event, handler) => { onConnection = handler }),
    }
    const storage = {
      getRoom: () => room,
      getRoomAgent: () => agent,
      getRoomMembers: () => [],
      getRoomAgents: () => [agent],
    }
    const runtime = {
      getStorage: () => storage,
      agentClients: { registerAgentForRoom: vi.fn() },
      broadcastRoomAgents: vi.fn(),
    }
    const socket: any = {
      id: 'socket-1',
      connected: true,
      data: { connector: { id: 'connector-1', roomId: room.id, roomAgentId: agent.id, agentId: agent.agentId } },
      on: vi.fn((event, handler) => { handlers.set(event, handler) }),
      disconnect: vi.fn(),
      emit: vi.fn((event, request) => {
        if (event !== 'run.request') return
        requests.push(request)
        if (request.workspaceApi) {
          grantedWorkspaces.push(authenticateRemoteWorkspaceGrant(request.workspaceApi.token)?.workspace)
        }
        queueMicrotask(() => {
          handlers.get('run.accepted')?.({ runId: request.runId })
          handlers.get('run.completed')?.({ runId: request.runId })
        })
      }),
    }
    const server = new GroupAgentRelayServer({ of: () => namespace } as any, runtime as any)
    servers.push(server)
    onConnection(socket)
    await vi.waitFor(() => expect(socket.data.executor).toBeDefined())
    const run = () => socket.data.executor.replyToMention(room.id, {
      content: '@Worker inspect',
      senderName: 'Alice',
      senderId: 'member-1',
      timestamp: 1,
    })
    return { run, requests, grantedWorkspaces }
  }

  it.each(['D:', 'D:\\', 'D:/'])('dispatches a remote run with canonical drive-root access for %s', async workspace => {
    const relay = await connect(workspace)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.mkdir.mockRejectedValue(Object.assign(new Error('drive-root mkdir denied'), { code: 'EPERM' }))

    await relay.run()

    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(relay.requests).toHaveLength(1)
    expect(relay.grantedWorkspaces).toEqual(['D:\\'])
    expect(mocks.startCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'D:\\' }))
    expect(mocks.completeCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'D:\\' }))
    expect(mocks.discardCheckpoint).not.toHaveBeenCalled()
    expect(authenticateRemoteWorkspaceGrant(relay.requests[0].workspaceApi.token)).toBeNull()
  })

  it('creates a missing shared directory with owner-only permissions before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-workspace-'))
    directories.push(root)
    const workspace = join(root, 'shared')
    const relay = await connect(workspace)

    await relay.run()

    expect((await stat(workspace)).isDirectory()).toBe(true)
    expect(mocks.mkdir).toHaveBeenCalledWith(workspace, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') expect((await stat(workspace)).mode & 0o077).toBe(0)
    expect(relay.grantedWorkspaces).toEqual([workspace])
  })

  it('does not dispatch or grant access when workspace creation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-workspace-'))
    directories.push(root)
    const relay = await connect(join(root, 'denied'))
    mocks.mkdir.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))

    await expect(relay.run()).rejects.toMatchObject({ code: 'EACCES' })
    expect(relay.requests).toEqual([])
    expect(mocks.startCheckpoint).not.toHaveBeenCalled()
  })

  it('does not create a directory or grant access when sharing is disabled', async () => {
    const relay = await connect('D:\\', false)
    Object.defineProperty(process, 'platform', { value: 'win32' })

    await relay.run()

    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(relay.requests).toHaveLength(1)
    expect(relay.requests[0].workspaceApi).toBeUndefined()
    expect(mocks.startCheckpoint).not.toHaveBeenCalled()
  })
})
