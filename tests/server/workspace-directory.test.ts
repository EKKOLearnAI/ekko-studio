import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureDirectory,
  isWindowsDriveRoot,
  normalizeDirectoryTarget,
} from '../../packages/server/src/modules/studio/services/workspace/directory'

// Windows reports EPERM instead of EEXIST for a directory it cannot create,
// which is the whole reason this module exists. The mock lets that be replayed
// on any platform, and records every mkdir the module attempts.
const fsMock = vi.hoisted(() => ({ denied: new Set<string>(), mkdirCalls: [] as string[] }))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
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

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function usePlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('workspace directory creation', () => {
  let root: string

  beforeEach(async () => {
    fsMock.denied.clear()
    fsMock.mkdirCalls = []
    root = await mkdtemp(join(tmpdir(), 'hermes-ensure-directory-'))
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', originalPlatform)
    await rm(root, { recursive: true, force: true })
  })

  it('normalizes every spelling of a drive root to one form', () => {
    usePlatform('win32')
    expect(normalizeDirectoryTarget('D:')).toBe('D:\\')
    expect(normalizeDirectoryTarget('D:/')).toBe('D:\\')
    expect(normalizeDirectoryTarget('D:\\')).toBe('D:\\')
    expect(normalizeDirectoryTarget('  D:  ')).toBe('D:\\')
    expect(normalizeDirectoryTarget('d:')).toBe('d:\\')
    expect(isWindowsDriveRoot('D:')).toBe(true)
  })

  it('leaves ordinary and POSIX paths alone', () => {
    usePlatform('win32')
    expect(normalizeDirectoryTarget('D:\\dev\\project')).toBe('D:\\dev\\project')
    expect(normalizeDirectoryTarget('C:\\Users\\Alice')).toBe('C:\\Users\\Alice')
    expect(isWindowsDriveRoot('D:\\dev')).toBe(false)

    usePlatform('linux')
    expect(normalizeDirectoryTarget('/tmp/workspace')).toBe('/tmp/workspace')
    expect(isWindowsDriveRoot('D:')).toBe(false)
  })

  it('accepts a drive root as a workspace without asking mkdir to create it', async () => {
    usePlatform('win32')
    await expect(ensureDirectory('D:')).resolves.toBe('D:\\')
    await expect(ensureDirectory('D:\\')).resolves.toBe('D:\\')
    await expect(ensureDirectory('D:/')).resolves.toBe('D:\\')
    expect(fsMock.mkdirCalls).toEqual([])
  })

  it('creates the directories that are actually missing', async () => {
    const nested = join(root, 'a', 'b')
    await expect(ensureDirectory(nested)).resolves.toBe(nested)
    expect((await stat(nested)).isDirectory()).toBe(true)

    fsMock.mkdirCalls = []
    await expect(ensureDirectory(nested)).resolves.toBe(nested)
    expect(fsMock.mkdirCalls).toEqual([nested])
  })

  it('treats a permission error on an existing directory as success', async () => {
    fsMock.denied.add(root)
    await expect(ensureDirectory(root)).resolves.toBe(root)
  })

  it('still reports a permission error when nothing is there to accept', async () => {
    const missing = join(root, 'denied')
    fsMock.denied.add(missing)
    await expect(ensureDirectory(missing)).rejects.toMatchObject({ code: 'EPERM' })
  })
})
