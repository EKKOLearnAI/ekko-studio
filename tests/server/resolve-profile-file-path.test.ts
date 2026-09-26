import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve as resolvePath } from 'path'

const HOME = '/tmp/hermes-resolve-home'

/**
 * resolveProfileFilePath decides which paths the file APIs will touch. These pin
 * down the difference between a `..` segment, which is traversal, and a name
 * that merely begins with dots, which is a file.
 */
describe('resolveProfileFilePath', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileDir: () => HOME,
      getProfileDir: (profile: string) => join(HOME, 'profiles', profile),
    }))
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/modules/studio/public/profile-config')
    vi.resetModules()
  })

  async function resolveProfileFilePath() {
    return (await import('../../packages/server/src/modules/studio/services/files/file-provider')).resolveProfileFilePath
  }

  it('resolves an ordinary relative path under the profile home', async () => {
    const resolve = await resolveProfileFilePath()
    expect(resolve('skills/notes.md')).toBe(resolvePath(HOME, 'skills/notes.md'))
  })

  it('resolves under the requested profile rather than the active one', async () => {
    const resolve = await resolveProfileFilePath()
    expect(resolve('config.yaml', 'work')).toBe(resolvePath(HOME, 'profiles/work/config.yaml'))
  })

  it('accepts names that begin with dots but are not traversal', async () => {
    const resolve = await resolveProfileFilePath()
    expect(resolve('..hidden')).toBe(resolvePath(HOME, '..hidden'))
    expect(resolve('...')).toBe(resolvePath(HOME, '...'))
    expect(resolve('notes/..archive.md')).toBe(resolvePath(HOME, 'notes/..archive.md'))
  })

  it('rejects a parent-directory segment wherever it appears', async () => {
    const resolve = await resolveProfileFilePath()
    expect(() => resolve('..')).toThrow('Invalid file path')
    expect(() => resolve('../etc/passwd')).toThrow('Invalid file path')
    expect(() => resolve('skills/../../etc/passwd')).toThrow('Invalid file path')
  })

  it('still refuses an absolute path', async () => {
    const resolve = await resolveProfileFilePath()
    expect(() => resolve('/etc/passwd')).toThrow('Invalid file path')
    expect(() => resolve(join(HOME, 'skills'))).toThrow('Invalid file path')
  })

  it('returns the home directory for the empty, dot and root forms', async () => {
    const resolve = await resolveProfileFilePath()
    expect(resolve('')).toBe(HOME)
    expect(resolve('.')).toBe(HOME)
    expect(resolve('/')).toBe(HOME)
  })
})
