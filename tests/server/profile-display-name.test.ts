import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProfiles, readProfileDisplayName } from '../../packages/server/src/modules/hermes/services/runtime/cli'

describe('readProfileDisplayName', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let home = ''

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
  })

  it('reads display_name from profile.yaml under named profile dir', async () => {
    home = join(tmpdir(), `studio-display-name-${Date.now()}`)
    process.env.HERMES_HOME = home
    const profileDir = join(home, 'profiles', 'wazj')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')
    await writeFile(
      join(profileDir, 'profile.yaml'),
      'display_name: 网安专家数字人\n',
      'utf-8',
    )

    expect(readProfileDisplayName('wazj')).toBe('网安专家数字人')
  })

  it('listProfiles attaches displayName from disk metadata', async () => {
    home = join(tmpdir(), `studio-list-display-${Date.now()}`)
    process.env.HERMES_HOME = home
    const profileDir = join(home, 'profiles', 'wazj')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')
    await writeFile(
      join(profileDir, 'profile.yaml'),
      'display_name: 网安专家数字人\n',
      'utf-8',
    )

    const profiles = await listProfiles()
    const row = profiles.find(p => p.name === 'wazj')
    expect(row?.displayName).toBe('网安专家数字人')
  })
})
