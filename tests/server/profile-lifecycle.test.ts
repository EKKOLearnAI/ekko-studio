import { existsSync, readFileSync, statSync } from 'fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyMicroCompactDefault,
  createProfileWithoutHermes,
  deleteProfileWithoutHermes,
  ProfileLifecycleError,
  validateProfileName,
} from '../../packages/server/src/modules/hermes/services/profiles/lifecycle'
import { readAppConfig } from '../../packages/server/src/modules/studio/public/app-config'

vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: vi.fn(async () => ({ microCompactDefault: false })),
}))

describe('Studio-native profile lifecycle', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const tempHomes: string[] = []

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function makeHome(prefix: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), prefix))
    tempHomes.push(home)
    process.env.HERMES_HOME = home
    return home
  }

  it('normalizes valid names and rejects invalid, reserved, and traversal names', () => {
    expect(validateProfileName('  Project_One-2  ')).toBe('project_one-2')

    for (const name of ['', '.hidden', '../outside', 'work/name', 'work.name', 'a'.repeat(65), 'gateway', 'default']) {
      expect(() => validateProfileName(name)).toThrow(ProfileLifecycleError)
    }
  })

  it('creates the complete minimum profile skeleton with a private env file', async () => {
    const home = await makeHome('studio-profile-lifecycle-')

    const result = await createProfileWithoutHermes('Work', false, home)

    expect(result.name).toBe('work')
    for (const directory of ['cron', 'home', 'logs', 'memories', 'plans', 'sessions', 'skills', 'skins', 'workspace']) {
      expect(statSync(join(result.path, directory)).isDirectory()).toBe(true)
    }
    for (const file of ['config.yaml', '.env', 'SOUL.md']) {
      expect(statSync(join(result.path, file)).isFile()).toBe(true)
    }
    if (process.platform !== 'win32') {
      expect(statSync(join(result.path, '.env')).mode & 0o777).toBe(0o600)
    }
  })

  it('clones supported content and fills missing skeleton entries', async () => {
    const home = await makeHome('studio-profile-clone-')
    await mkdir(join(home, 'skills', 'custom'), { recursive: true })
    await mkdir(join(home, 'memories'), { recursive: true })
    await writeFile(join(home, 'active_profile'), 'default\n', 'utf-8')
    await writeFile(join(home, 'config.yaml'), 'model:\n  default: source-model\n', 'utf-8')
    await writeFile(join(home, 'skills', 'custom', 'SKILL.md'), '# Custom\n', 'utf-8')
    await writeFile(join(home, 'memories', 'USER.md'), 'source user memory\n', 'utf-8')

    const result = await createProfileWithoutHermes('clone', true, home)

    expect(result.clonedFrom).toBe('default')
    expect(readFileSync(join(result.path, 'config.yaml'), 'utf-8')).toContain('source-model')
    expect(readFileSync(join(result.path, 'skills', 'custom', 'SKILL.md'), 'utf-8')).toBe('# Custom\n')
    expect(readFileSync(join(result.path, 'memories', 'USER.md'), 'utf-8')).toBe('source user memory\n')
    expect(existsSync(join(result.path, '.env'))).toBe(true)
    expect(existsSync(join(result.path, 'SOUL.md'))).toBe(true)
    expect(existsSync(join(result.path, 'workspace'))).toBe(true)
  })

  it('does not overwrite an existing profile', async () => {
    const home = await makeHome('studio-profile-collision-')
    await mkdir(join(home, 'profiles', 'work'), { recursive: true })

    await expect(createProfileWithoutHermes('work', false, home)).rejects.toMatchObject({
      status: 409,
      code: 'profile_exists',
    })
  })

  it('removes only a symlink when a profile entry is a symlink', async () => {
    const home = await makeHome('studio-profile-symlink-')
    const external = await mkdtemp(join(tmpdir(), 'studio-profile-external-'))
    tempHomes.push(external)
    await writeFile(join(external, 'keep.txt'), 'keep', 'utf-8')
    await mkdir(join(home, 'profiles'), { recursive: true })
    await symlink(external, join(home, 'profiles', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(deleteProfileWithoutHermes('linked', home)).resolves.toBe(true)

    expect(existsSync(join(home, 'profiles', 'linked'))).toBe(false)
    expect(readFileSync(join(external, 'keep.txt'), 'utf-8')).toBe('keep')
  })

  describe('applyMicroCompactDefault', () => {
    it('writes the global default (on) into a new profile config', async () => {
      const home = await makeHome('mc-apply-on-')
      const r = await createProfileWithoutHermes('mc-test', false, home)
      vi.mocked(readAppConfig).mockResolvedValueOnce({ microCompactDefault: true })
      const ok = await applyMicroCompactDefault('mc-test')
      expect(ok).toBe(true)
      expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: true')
    })

    it('writes the global default (off) into a new profile config', async () => {
      const home = await makeHome('mc-apply-off-')
      const r = await createProfileWithoutHermes('mc-test', false, home)
      const ok = await applyMicroCompactDefault('mc-test')
      expect(ok).toBe(true)
      expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: false')
    })

    it('returns false for a profile with no config.yaml', async () => {
      const home = await makeHome('mc-apply-missing-')
      const ok = await applyMicroCompactDefault('does-not-exist')
      expect(ok).toBe(false)
    })

    it('overrides a cloned config existing micro_compact value', async () => {
      const home = await makeHome('mc-apply-clone-')
      await writeFile(join(home, 'active_profile'), 'default\n', 'utf-8')
      await writeFile(join(home, 'config.yaml'), 'compression:\n  micro_compact: false\n', 'utf-8')
      const r = await createProfileWithoutHermes('mc-clone', true, home)
      expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: false')
      vi.mocked(readAppConfig).mockResolvedValueOnce({ microCompactDefault: true })
      const ok = await applyMicroCompactDefault('mc-clone')
      expect(ok).toBe(true)
      expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: true')
    })
  })
})
