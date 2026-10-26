import type { Context } from 'koa'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  issueRemoteWorkspaceGrant,
  resetRemoteWorkspaceGrantsForTest,
  revokeRemoteWorkspaceGrantsForRun,
} from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-auth'
import { ensureDirectory } from '../../packages/server/src/modules/studio/services/workspace/directory'

const mocks = vi.hoisted(() => ({
  room: { workspace: 'D:', allowRemoteWorkspaceAccess: 1 } as { workspace: string; allowRemoteWorkspaceAccess: number } | null,
  action: vi.fn(async () => ({ ok: true, entries: [] })),
  download: vi.fn(),
  upload: vi.fn(async () => ({ ok: true, path: 'file.txt', size: 0 })),
}))

vi.mock('../../packages/server/src/modules/studio/services/group-chat/runtime', () => ({
  getGroupChatRuntimeServer: () => ({
    getStorage: () => ({ getRoom: () => mocks.room }),
    publishAgentAttachmentMessage: () => ({ id: 'message-1' }),
  }),
}))
vi.mock('../../packages/server/src/modules/studio/services/group-chat/remote-workspace-files', () => ({
  MAX_REMOTE_WORKSPACE_TRANSFER_BYTES: 20 * 1024 * 1024,
  performRemoteWorkspaceAction: mocks.action,
  openRemoteWorkspaceDownload: mocks.download,
  uploadRemoteWorkspaceFile: mocks.upload,
}))
vi.mock('../../packages/server/src/modules/studio/services/group-chat/workspace-files', () => ({
  resolveGroupWorkspacePath: async () => ({ fullPath: 'D:\\file.txt' }),
}))
vi.mock('../../packages/server/src/modules/studio/services/group-chat/attachments', () => ({
  storeAgentGroupChatAttachment: async () => ({ name: 'file.txt', path: 'attachment.txt', type: 'file' }),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn() },
}))

import {
  downloadRemoteWorkspaceFile,
  remoteWorkspaceAction,
  uploadRemoteWorkspaceFileContent,
} from '../../packages/server/src/modules/studio/controllers/group-chat-remote-workspace'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const endpoints = [
  { name: 'action', handler: remoteWorkspaceAction, operation: mocks.action },
  { name: 'download', handler: downloadRemoteWorkspaceFile, operation: mocks.download },
  { name: 'upload', handler: uploadRemoteWorkspaceFileContent, operation: mocks.upload },
]

async function request(workspace: string) {
  // Prepare the grant through the same directory helper used by the relay.
  const issued = issueRemoteWorkspaceGrant({
    runId: 'run-1', roomId: 'room-1', agentId: 'agent-1',
    workspace: await ensureDirectory(workspace, { mode: 0o700 }),
  })
  const headers: Record<string, string> = {
    authorization: `Bearer ${issued.token}`,
    'content-type': 'application/octet-stream',
  }
  return {
    request: { body: { action: 'list', path: '' } },
    query: { path: 'file.txt' }, req: Readable.from([]), status: 200,
    set: vi.fn(), get: (name: string) => headers[name.toLowerCase()] || '',
  } as unknown as Context
}

describe.each(endpoints)('remote workspace $name drive-root authorization', ({ handler, operation }) => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.room = { workspace: 'D:', allowRemoteWorkspaceAccess: 1 }
    mocks.download.mockImplementation(async () => ({
      path: 'file.txt', size: 0, sha256: 'a'.repeat(64), stream: Readable.from([]),
    }))
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    resetRemoteWorkspaceGrantsForTest()
  })

  it.each(['D:', 'D:/', 'D:\\'])('accepts an unchanged room stored as %s', async workspace => {
    mocks.room!.workspace = workspace
    const ctx = await request(workspace)
    await handler(ctx)
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200)
    expect(operation).toHaveBeenCalledOnce()
    expect(operation.mock.calls[0]?.[0]).toBe('D:\\')
  })

  it.each(['disabled sharing', 'changed drive', 'changed directory', 'removed room'])(
    'rejects an existing grant after %s', async change => {
      const ctx = await request('D:')
      if (change === 'disabled sharing') mocks.room!.allowRemoteWorkspaceAccess = 0
      if (change === 'changed drive') mocks.room!.workspace = 'E:'
      if (change === 'changed directory') mocks.room!.workspace = 'D:\\other'
      if (change === 'removed room') mocks.room = null
      await handler(ctx)
      expect(ctx.status).toBe(403)
      expect(ctx.body).toMatchObject({ code: 'permission_denied' })
      expect(operation).not.toHaveBeenCalled()
    },
  )

  it('rejects a revoked grant even while the room is unchanged', async () => {
    const ctx = await request('D:')
    revokeRemoteWorkspaceGrantsForRun('run-1')
    await handler(ctx)
    expect(ctx.status).toBe(401)
    expect(ctx.body).toMatchObject({ code: 'invalid_grant' })
    expect(operation).not.toHaveBeenCalled()
  })
})
