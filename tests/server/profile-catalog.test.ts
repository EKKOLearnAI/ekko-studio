import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('os', async importOriginal => ({
  ...await importOriginal<typeof import('os')>(),
  homedir: () => home.path,
}))

import { listProfilesFromDisk } from '../../packages/server/src/modules/hermes/services/profiles/catalog'

describe('local profile catalog', () => {
  beforeEach(async () => {
    home.path = await mkdtemp(join(tmpdir(), 'studio-profile-catalog-'))
    vi.stubEnv('HERMES_HOME', join(home.path, '.hermes'))
    await mkdir(join(home.path, '.hermes'), { recursive: true })
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home.path, { recursive: true, force: true })
  })

  it('reads both model formats and tolerates missing or invalid YAML', async () => {
    const root = join(home.path, '.hermes')
    await writeFile(join(root, 'config.yaml'), 'model: default-model\n')
    await Promise.all(['work', 'missing', 'broken'].map(name => mkdir(join(root, 'profiles', name), { recursive: true })))
    await writeFile(join(root, 'profiles', 'work', 'config.yaml'), 'model:\n  default: work-model\n')
    await writeFile(join(root, 'profiles', 'broken', 'config.yaml'), 'model: [')
    await writeFile(join(root, 'active_profile'), 'work\n')

    expect(listProfilesFromDisk()).toEqual([
      { name: 'default', active: false, model: 'default-model', alias: '' },
      { name: 'broken', active: false, model: '—', alias: '' },
      { name: 'missing', active: false, model: '—', alias: '' },
      { name: 'work', active: true, model: 'work-model', alias: '' },
    ])
  })

  it('preserves custom wrapper aliases while ignoring binary contents and long tails', async () => {
    const wrappers = join(home.path, '.local', 'bin')
    await mkdir(wrappers, { recursive: true })
    await mkdir(join(home.path, '.hermes', 'profiles', 'work'), { recursive: true })
    const suffix = process.platform === 'win32' ? '.bat' : ''
    await writeFile(join(wrappers, `work${suffix}`), '#!/bin/sh\nexec hermes -p work "$@"\n')
    await writeFile(join(wrappers, `assistant${suffix}`), '#!/bin/sh\nexec hermes -p work "$@"\n')
    await writeFile(join(wrappers, `z-binary${suffix}`), '\0hermes -p work')
    await writeFile(join(wrappers, `z-large${suffix}`), 'x'.repeat(8192) + '\nhermes -p work')

    expect(listProfilesFromDisk().find(profile => profile.name === 'work')?.alias).toBe('assistant')
  })
})
