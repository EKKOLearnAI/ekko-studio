import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const denied = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: async (target: any, options?: any) => {
    if (denied.has(String(target))) throw Object.assign(new Error('mkdir denied'), { code: 'EPERM' })
    return actual.mkdir(target, options)
  } }
})
import { performRemoteWorkspaceAction, uploadRemoteWorkspaceFile } from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-files'

describe('remote workspace directory preparation', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'remote-directory-')); denied.add(root) })
  afterEach(async () => { denied.clear(); await rm(root, { recursive: true, force: true }) })

  it('writes at an existing root when mkdir reports EPERM', async () => {
    await expect(performRemoteWorkspaceAction(root, { action: 'write', path: 'file.txt', content: 'hello' })).resolves.toMatchObject({ ok: true })
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('hello')
  })
  it('uploads at an existing root when mkdir reports EPERM', async () => {
    const bytes = Buffer.from([0, 255, 42])
    await expect(uploadRemoteWorkspaceFile(root, 'file.bin', Readable.from([bytes]))).resolves.toMatchObject({ ok: true })
    expect(await readFile(join(root, 'file.bin'))).toEqual(bytes)
  })
  it('still rejects denied creation of a missing parent', async () => {
    denied.add(join(root, 'denied'))
    await expect(performRemoteWorkspaceAction(root, { action: 'write', path: 'denied/file.txt', content: 'hello' })).rejects.toMatchObject({ code: 'EPERM' })
    await expect(uploadRemoteWorkspaceFile(root, 'denied/file.bin', Readable.from([]))).rejects.toMatchObject({ code: 'EPERM' })
  })
})
