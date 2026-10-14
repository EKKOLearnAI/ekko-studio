import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Replays the Windows behaviour that breaks writes into a drive root: mkdir
// answers with EPERM instead of "already exists", which is what a file at
// `D:\notes.txt` asks for (its parent directory is the drive root itself).
const fsMock = vi.hoisted(() => ({ denied: new Set<string>(), mkdirCalls: [] as string[] }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async (target: any, options?: any) => {
      fsMock.mkdirCalls.push(String(target))
      if (fsMock.denied.has(String(target))) {
        throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${target}'`), { code: 'EPERM' })
      }
      return actual.mkdir(target, options)
    },
  }
})

import { WriteFileTool } from '../../packages/ekko-agent/src/index'
import { ensureDirectory, normalizeDirectoryTarget } from '../../packages/ekko-agent/src/tools/directory'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('write_file parent directory creation', () => {
  let root: string

  beforeEach(async () => {
    fsMock.denied.clear()
    fsMock.mkdirCalls = []
    root = await mkdtemp(path.join(os.tmpdir(), 'ekko-write-file-directory-'))
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', originalPlatform)
    await rm(root, { recursive: true, force: true })
  })

  it('accepts a drive root without attempting to create it', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(normalizeDirectoryTarget('D:')).toBe('D:\\')
    await expect(ensureDirectory('D:')).resolves.toBe('D:\\')
    expect(fsMock.mkdirCalls).toEqual([])
  })

  it('creates the parents a nested write needs', async () => {
    const target = path.join(root, 'notes', 'deep', 'file.txt')
    const result = await new WriteFileTool().execute({ path: target, content: 'hello' }, { workspaceRoot: root, cwd: root })

    expect(result.ok).toBe(true)
    await expect(readFile(target, 'utf8')).resolves.toBe('hello')
  })

  it('writes when the parent directory already exists but mkdir reports EPERM', async () => {
    const parent = path.join(root, 'notes')
    await ensureDirectory(parent)
    fsMock.denied.add(parent)

    const target = path.join(parent, 'file.txt')
    const result = await new WriteFileTool().execute({ path: target, content: 'hello' }, { workspaceRoot: root, cwd: root })

    expect(result.ok).toBe(true)
    await expect(readFile(target, 'utf8')).resolves.toBe('hello')
  })

  it('keeps reporting the permission error when the parent cannot be accepted', async () => {
    const parent = path.join(root, 'denied')
    fsMock.denied.add(parent)

    await expect(new WriteFileTool().execute(
      { path: path.join(parent, 'file.txt'), content: 'hello' },
      { workspaceRoot: root, cwd: root },
    )).rejects.toMatchObject({ code: 'EPERM' })
  })
})
