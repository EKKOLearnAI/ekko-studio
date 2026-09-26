import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  mockCopyFile,
  mockMkdir,
  mockReadFile,
  mockRename,
  mockRm,
  mockWriteFile,
} = vi.hoisted(() => ({
  mockCopyFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockReadFile: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
  mockWriteFile: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  copyFile: mockCopyFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  rename: mockRename,
  rm: mockRm,
  writeFile: mockWriteFile,
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('SafeFileStore backup fallback', () => {
  it('uses a timestamped backup when the default backup cannot be overwritten', async () => {
    mockCopyFile
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValueOnce(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockRename.mockResolvedValue(undefined)

    const { SafeFileStore } = await import('../../packages/server/src/modules/studio/public/safe-file-store')
    const store = new SafeFileStore()

    const target = resolve('/tmp/config.yaml')
    await store.writeText('/tmp/config.yaml', 'model:\n  default: new\n', { backup: true })

    expect(mockCopyFile).toHaveBeenCalledTimes(2)
    expect(mockCopyFile).toHaveBeenNthCalledWith(1, target, `${target}.bak`)
    expect(mockCopyFile.mock.calls[1][0]).toBe(target)
    expect(mockCopyFile.mock.calls[1][1]).toMatch(new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak\\.\\d+\\.`))
    expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining(`${target}.tmp.`), 'model:\n  default: new\n', 'utf-8')
    expect(mockRename).toHaveBeenCalledWith(expect.stringContaining(`${target}.tmp.`), target)
  })

  it('preserves explicit backup path failures', async () => {
    mockCopyFile.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    mockMkdir.mockResolvedValue(undefined)

    const { SafeFileStore } = await import('../../packages/server/src/modules/studio/public/safe-file-store')
    const store = new SafeFileStore()

    await expect(store.writeText('/tmp/config.yaml', 'new', { backup: true, backupPath: '/tmp/custom.bak' })).rejects.toThrow('permission denied')
    expect(mockCopyFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
