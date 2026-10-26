import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WriteFileTool } from '../../packages/ekko-agent/src/tools/files'
import { ensureWorkspaceDirectory, resolveWorkspaceDirectory } from '../../packages/server/src/modules/studio/services/workspace/manager'
import { issueRemoteWorkspaceGrant, revokeRemoteWorkspaceGrantsForRun, resetRemoteWorkspaceGrantsForTest } from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-auth'

const room = vi.hoisted(() => ({ workspace: '', allowRemoteWorkspaceAccess: 1 }))
vi.mock('../../packages/server/src/modules/studio/services/group-chat/runtime', () => ({
  getGroupChatRuntimeServer: () => ({ getStorage: () => ({ getRoom: () => room }), publishAgentAttachmentMessage: () => ({ id: 'acceptance-message' }) }),
}))
// Only publication metadata is stubbed; controller authorization, grants, paths and filesystem I/O are real.
vi.mock('../../packages/server/src/modules/studio/services/group-chat/attachments', () => ({
  storeAgentGroupChatAttachment: async () => ({ name: 'acceptance.bin', path: 'acceptance.bin', type: 'file' }),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn() } }))
import { remoteWorkspaceAction, uploadRemoteWorkspaceFileContent, downloadRemoteWorkspaceFile } from '../../packages/server/src/modules/studio/controllers/group-chat-remote-workspace'

const files: string[] = []
afterEach(async () => {
  resetRemoteWorkspaceGrantsForTest()
  await Promise.all(files.splice(0).map(file => rm(file, { force: true })))
})
function file(root: string, ext: string) {
  const name = `ekko-pr3396-acceptance-${randomUUID()}.${ext}`
  files.push(path.join(root, name))
  return name
}
function context(token: string, name: string, body = {}) {
  return { status: 200, request: { body }, query: { path: name }, req: Readable.from([]),
    set: vi.fn(), get: (header: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }[header.toLowerCase()] || '') } as any
}
// Opt in on a Windows host with writable test drives, e.g. C:,D:.
const drives = (process.env.EKKO_TEST_WINDOWS_DRIVE_ROOTS || '').split(',').map(value => value.trim()).filter(value => /^[A-Za-z]:$/.test(value))
const spellings = drives.flatMap(drive => [drive, `${drive}/`, `${drive}\\`])
describe.skipIf(process.platform !== 'win32' || drives.length === 0)('native Windows drive-root acceptance', () => {
  it('runs on actual Windows without platform or filesystem mocks', () => { expect(process.platform).toBe('win32') })
  it.each(spellings)('resolves and writes a local root file for %s', async workspace => {
    const root = `${workspace.slice(0, 2)}\\`
    expect(await ensureWorkspaceDirectory(workspace)).toBe(root)
    expect((await resolveWorkspaceDirectory(workspace))?.fullPath).toBe(root)
    expect((await stat(root)).isDirectory()).toBe(true)
    const name = file(root, 'txt')
    const result = await new WriteFileTool().execute({ path: path.join(root, name), content: 'native-root-write' }, { cwd: root, workspaceRoot: root })
    expect(result.ok).toBe(true)
    expect(await readFile(path.join(root, name), 'utf8')).toBe('native-root-write')
  })
  it.each(spellings)('writes and reads a root file via the remote controller for %s', async workspace => {
    room.workspace = workspace; room.allowRemoteWorkspaceAccess = 1
    const root = await ensureWorkspaceDirectory(workspace)
    const { token } = issueRemoteWorkspaceGrant({ runId: randomUUID(), roomId: 'room', agentId: 'agent', workspace: root })
    const name = file(root, 'txt')
    const write = context(token, name, { action: 'write', path: name, content: 'remote-native-write' })
    await remoteWorkspaceAction(write)
    expect(write.status, JSON.stringify(write.body)).toBe(200)
    expect(await readFile(path.join(root, name), 'utf8')).toBe('remote-native-write')
    const read = context(token, name, { action: 'read', path: name })
    await remoteWorkspaceAction(read)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.content).toBe('remote-native-write')
  })
  it.each(spellings)('uploads and downloads root bytes via the remote controller for %s', async workspace => {
    room.workspace = workspace; room.allowRemoteWorkspaceAccess = 1
    const root = await ensureWorkspaceDirectory(workspace)
    const { token } = issueRemoteWorkspaceGrant({ runId: randomUUID(), roomId: 'room', agentId: 'agent', workspace: root })
    const name = file(root, 'bin')
    const bytes = Buffer.from([0, 255, 10, 13, 42])
    const upload = context(token, name); upload.req = Readable.from([bytes])
    await uploadRemoteWorkspaceFileContent(upload)
    expect(upload.status, JSON.stringify(upload.body)).toBe(200)
    expect(await readFile(path.join(root, name))).toEqual(bytes)
    const download = context(token, name)
    await downloadRemoteWorkspaceFile(download)
    expect(download.status, JSON.stringify(download.body)).toBe(200)
    const chunks: Buffer[] = []
    for await (const chunk of download.body) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(bytes)
  })
  it('denies disabled, changed and revoked workspaces on native Windows', async () => {
    room.workspace = drives[0]; room.allowRemoteWorkspaceAccess = 1
    const { token } = issueRemoteWorkspaceGrant({ runId: 'deny-run', roomId: 'room', agentId: 'agent', workspace: await ensureWorkspaceDirectory(drives[0]) })
    room.allowRemoteWorkspaceAccess = 0
    const disabled = context(token, 'unused', { action: 'read', path: 'unused' }); await remoteWorkspaceAction(disabled); expect(disabled.status).toBe(403)
    room.allowRemoteWorkspaceAccess = 1; room.workspace = `${drives[0]}\\changed-workspace`
    const changed = context(token, 'unused', { action: 'read', path: 'unused' }); await remoteWorkspaceAction(changed); expect(changed.status).toBe(403)
    room.workspace = drives[0]; revokeRemoteWorkspaceGrantsForRun('deny-run')
    const revoked = context(token, 'unused', { action: 'read', path: 'unused' }); await remoteWorkspaceAction(revoked); expect(revoked.status).toBe(401)
  })
})
