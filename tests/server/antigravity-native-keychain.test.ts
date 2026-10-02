import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkAntigravityNativeKeychain } from '../../packages/server/src/modules/coding-agents/services/antigravity/native-keychain'
import { prepareAntigravityRuntime } from '../../packages/server/src/modules/coding-agents/services/antigravity/config'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'studio-agy-keychain-'))
  roots.push(root)
  const home = join(root, 'home'), runtime = join(root, 'runtime')
  await mkdir(join(home, 'Library', 'Keychains'), { recursive: true })
  await mkdir(join(home, 'Library', 'Preferences'), { recursive: true })
  await writeFile(join(home, 'Library', 'Keychains', 'login.keychain-db'), 'native keychain fixture')
  await writeFile(join(home, 'Library', 'Preferences', 'com.apple.security.plist'), 'native search preferences')
  return { home, runtime }
}

describe('Antigravity native keychain with a per-run HOME', () => {
  it('links both the keychain and its search preferences without copying native state', async () => {
    const { home, runtime } = await fixture()
    await linkAntigravityNativeKeychain(home, runtime, 'darwin')
    for (const relative of ['Library/Keychains', 'Library/Preferences/com.apple.security.plist']) {
      expect((await lstat(join(runtime, relative))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(runtime, relative))).toBe(join(home, relative))
    }
    await writeFile(join(home, 'Library', 'Keychains', 'login.keychain-db'), 'updated native state')
    expect(await readFile(join(runtime, 'Library', 'Keychains', 'login.keychain-db'), 'utf8')).toBe('updated native state')
    expect(await readFile(join(home, 'Library', 'Preferences', 'com.apple.security.plist'), 'utf8')).toBe('native search preferences')
    await expect(linkAntigravityNativeKeychain(home, runtime, 'darwin')).resolves.toBeUndefined()
  })

  it.each(['linux', 'win32'] as const)('does not add macOS state on %s', async platform => {
    const { home, runtime } = await fixture()
    await linkAntigravityNativeKeychain(home, runtime, platform)
    await expect(lstat(join(runtime, 'Library'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows hosts without native keychain paths and preserves existing runtime files', async () => {
    const { home, runtime } = await fixture()
    await expect(linkAntigravityNativeKeychain(join(home, 'missing'), runtime, 'darwin')).resolves.toBeUndefined()
    await mkdir(join(runtime, 'Library', 'Preferences'), { recursive: true })
    const preferences = join(runtime, 'Library', 'Preferences', 'com.apple.security.plist')
    await writeFile(preferences, 'existing runtime preferences')
    await linkAntigravityNativeKeychain(home, runtime, 'darwin')
    expect(await readFile(preferences, 'utf8')).toBe('existing runtime preferences')
    expect(await readFile(join(home, 'Library', 'Preferences', 'com.apple.security.plist'), 'utf8')).toBe('native search preferences')
  })

  it.skipIf(process.platform !== 'darwin')('keeps native authentication in global mode and excludes it from external-provider mode', async () => {
    const { home, runtime } = await fixture()
    const global = await prepareAntigravityRuntime({ home, rootDir: runtime, systemPrompt: 'rules', managedMcp: {} })
    expect(global.env.HOME).toBe(runtime)
    expect((await lstat(join(runtime, 'Library', 'Keychains'))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(runtime, '.gemini', 'antigravity-cli', 'settings.json'))).isSymbolicLink()).toBe(false)
    const external = join(runtime, 'external')
    await prepareAntigravityRuntime({ home, rootDir: external, systemPrompt: 'rules', managedMcp: {}, externalModel: { baseUrl: 'http://127.0.0.1', token: 'fixture-token' } })
    await expect(lstat(join(external, 'Library'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
