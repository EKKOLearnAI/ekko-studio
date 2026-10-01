import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  LOCAL_FS_TIMEOUT_MS,
  LocalFileProvider,
  withLocalFsTimeout,
} from '../../packages/server/src/modules/studio/services/files/file-provider'

/** Stands in for a filesystem call parked on a mount that never answers. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {})
}

describe('withLocalFsTimeout', () => {
  it('passes through an operation that settles in time', async () => {
    await expect(withLocalFsTimeout(Promise.resolve('ok'), 'read /tmp/note.txt', 5_000)).resolves.toBe('ok')
  })

  it('forwards the original failure when the operation fails first', async () => {
    const failure = Object.assign(new Error('no such file'), { code: 'ENOENT' })

    await expect(withLocalFsTimeout(Promise.reject(failure), 'read /tmp/missing.txt', 5_000)).rejects.toBe(failure)
  })

  it('rejects with backend_timeout instead of waiting on an unresponsive mount', async () => {
    const err = await withLocalFsTimeout(neverSettles(), 'read /mnt/stuck/notes.txt', 10).catch(error => error)

    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('backend_timeout')
    expect(err.message).toContain('/mnt/stuck/notes.txt')
  })

  it('returns the operation untouched when the bound is disabled', () => {
    const pending = neverSettles()

    expect(withLocalFsTimeout(pending, 'read /mnt/stuck/notes.txt', 0)).toBe(pending)
    expect(withLocalFsTimeout(pending, 'read /mnt/stuck/notes.txt', -1)).toBe(pending)
  })
})

describe('local filesystem bound scope', () => {
  // The uninterruptible-mount stall this bound protects against is a Linux problem, so
  // macOS and Windows keep their previous unbounded behaviour unless they opt in.
  it.runIf(!process.env.LOCAL_FS_TIMEOUT_MS)('arms the bound on Linux only', () => {
    expect(LOCAL_FS_TIMEOUT_MS).toBe(process.platform === 'linux' ? 30_000 : 0)
  })

  it('lets any platform opt in or pick its own bound', async () => {
    const previous = process.env.LOCAL_FS_TIMEOUT_MS
    process.env.LOCAL_FS_TIMEOUT_MS = '1234'

    try {
      vi.resetModules()
      const reloaded = await import('../../packages/server/src/modules/studio/services/files/file-provider')

      expect(reloaded.LOCAL_FS_TIMEOUT_MS).toBe(1234)
    } finally {
      if (previous === undefined) delete process.env.LOCAL_FS_TIMEOUT_MS
      else process.env.LOCAL_FS_TIMEOUT_MS = previous
      vi.resetModules()
    }
  })

  it('keeps every local operation working when the bound is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-local-fs-'))

    try {
      await writeFile(join(dir, 'note.txt'), 'hello')

      const provider = new LocalFileProvider(dir, { operationTimeoutMs: 0 })

      await expect(provider.listDir(dir)).resolves.toEqual([
        { name: 'note.txt', path: 'note.txt', isDir: false, size: 5, modTime: expect.any(String) },
      ])
      await expect(provider.readFile(join(dir, 'note.txt'))).resolves.toEqual(Buffer.from('hello'))
      await expect(provider.stat(join(dir, 'note.txt'))).resolves.toMatchObject({ name: 'note.txt', size: 5 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('LocalFileProvider bounded local operations', () => {
  it('lists, stats and reads through the bounded provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-local-fs-'))

    try {
      await writeFile(join(dir, 'note.txt'), 'hello')
      await mkdir(join(dir, 'sub'))

      const provider = new LocalFileProvider(dir, { operationTimeoutMs: 5_000 })

      const entries = await provider.listDir(dir)
      expect(entries.map(entry => entry.name).sort()).toEqual(['note.txt', 'sub'])
      expect(entries.find(entry => entry.name === 'sub')?.isDir).toBe(true)

      await expect(provider.readFile(join(dir, 'note.txt'))).resolves.toEqual(Buffer.from('hello'))
      await expect(provider.stat(join(dir, 'note.txt'))).resolves.toMatchObject({
        name: 'note.txt',
        size: 5,
        isDir: false,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the existing error codes for ordinary local failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-local-fs-'))

    try {
      const provider = new LocalFileProvider(dir, { operationTimeoutMs: 5_000 })

      await expect(provider.readFile(join(dir, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(provider.stat(join(dir, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(provider.readFile(dir)).rejects.toMatchObject({ code: 'not_found' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('defaults to the shared local filesystem bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-local-fs-'))

    try {
      const provider = new LocalFileProvider(dir)

      await expect(provider.listDir(dir)).resolves.toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A FIFO that nobody writes to parks `open()` in the kernel exactly like a stalled
  // network/FUSE mount, which is the case the bound exists for. The parked call stays
  // parked — the kernel will not return it — but the provider must stop waiting on it.
  it.skipIf(process.platform === 'win32')('reports a stalled local call as backend_timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-local-fs-fifo-'))
    const fifo = join(dir, 'stalled')
    execFileSync('mkfifo', [fifo])

    try {
      const provider = new LocalFileProvider(dir, { operationTimeoutMs: 250 })
      const started = Date.now()
      const err = await provider.copyFile(fifo, join(dir, 'out')).catch(error => error)

      expect(err.code).toBe('backend_timeout')
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
