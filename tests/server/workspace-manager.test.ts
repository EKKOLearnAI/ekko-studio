import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureWorkspaceDirectory,
  resolveWorkspaceDirectory,
  resolveWorkspacePath,
  selectWorkspace,
} from '../../packages/server/src/modules/studio/services/workspace/manager'

describe('Studio workspace manager', () => {
  let root: string
  let workspace: string
  let outside: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-workspace-manager-'))
    workspace = join(root, 'workspace')
    outside = join(root, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(join(outside, 'shared.txt'), 'shared')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('selects the first non-empty workspace consistently', () => {
    const unusedFallback = vi.fn(() => outside)
    expect(selectWorkspace(null, '  ', `  ${workspace}  `, unusedFallback)).toBe(workspace)
    expect(unusedFallback).not.toHaveBeenCalled()
  })

  it('accepts a Windows drive root instead of failing to create it', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await expect(ensureWorkspaceDirectory('D:')).resolves.toBe('D:\\')
      await expect(ensureWorkspaceDirectory('D:\\')).resolves.toBe('D:\\')
      await expect(ensureWorkspaceDirectory('D:/')).resolves.toBe('D:\\')
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it.runIf(process.platform === 'win32')('resolves a bare drive letter to the drive root', async () => {
    const drive = process.env.SystemDrive || 'C:'
    await expect(resolveWorkspaceDirectory(drive)).resolves.toMatchObject({ fullPath: `${drive}\\` })
  })

  it('creates a missing workspace directory', async () => {
    const missing = join(root, 'created', 'workspace')
    await expect(ensureWorkspaceDirectory(missing)).resolves.toBe(missing)
    expect((await stat(missing)).isDirectory()).toBe(true)
  })

  it('allows local administrator paths outside the selected workspace', async () => {
    await expect(resolveWorkspacePath(workspace, '../outside/shared.txt', {
      access: 'unrestricted',
    })).resolves.toEqual({
      workspace,
      relativePath: '../outside/shared.txt',
      fullPath: join(outside, 'shared.txt'),
    })
  })

  it('keeps capability-scoped remote paths contained', async () => {
    await expect(resolveWorkspacePath(workspace, '../outside/shared.txt')).rejects.toMatchObject({
      code: 'invalid_path',
      status: 400,
    })

    await symlink(join(outside, 'shared.txt'), join(workspace, 'escaped.txt'))
    await expect(resolveWorkspacePath(workspace, 'escaped.txt')).rejects.toMatchObject({
      code: 'invalid_path',
      status: 400,
    })
  })
})
