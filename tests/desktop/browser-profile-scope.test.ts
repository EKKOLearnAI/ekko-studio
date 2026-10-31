import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  getPath: vi.fn((name: string): string => native.paths[name]),
}))
vi.mock('electron', () => ({ app: { getLocale: () => 'en', getPath: native.getPath } }))
import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'

const roots: string[] = []
const hostPlatform = process.platform
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(platform = 'darwin', isolated = false) {
  vi.stubGlobal('process', { ...process, platform })
  const root = await mkdtemp(join(tmpdir(), 'browser-profile-scope-'))
  roots.push(root)
  const userData = join(root, 'electron')
  const stateRoot = join(root, 'studio', 'desktop-browser')
  const managedProfiles = join(stateRoot, 'profiles')
  await Promise.all([userData, managedProfiles].map(path => mkdir(path, { recursive: true })))
  native.paths = { userData, sessionData: isolated ? join(root, 'studio') : userData }
  const manager = new BrowserManager({} as BrowserWindow, stateRoot) as unknown as {
    validateSessionScope(path: string): void
  }
  return { root, userData, stateRoot, managedProfiles, manager }
}

describe('browser profile session scope', () => {
  it.each(['darwin', 'win32', 'linux'])('keeps the existing managed local profiles on %s', async platform => {
    const { managedProfiles, manager } = await setup(platform)
    // The normal local browser predates device isolation and lives outside userData.
    expect(() => manager.validateSessionScope(join(managedProfiles, 'default', 'data'))).not.toThrow()
  })

  it('keeps existing profiles inside the default Electron session directory', async () => {
    const { userData, manager } = await setup()
    expect(() => manager.validateSessionScope(join(userData, 'custom', 'data'))).not.toThrow()
  })

  it('continues to reject unrelated custom directories on macOS', async () => {
    const { root, manager } = await setup()
    expect(() => manager.validateSessionScope(join(root, 'outside', 'data'))).toThrow(/inside this device storage/)
  })

  it.each(['win32', 'linux'])('does not add macOS directory restrictions on %s', async platform => {
    const { root, manager } = await setup(platform)
    expect(() => manager.validateSessionScope(join(root, 'outside', 'data'))).not.toThrow()
    expect(native.getPath).not.toHaveBeenCalled()
  })

  it('keeps isolated device profiles inside their configured session root', async () => {
    const { managedProfiles, root, manager } = await setup('darwin', true)
    expect(() => manager.validateSessionScope(join(managedProfiles, 'default', 'data'))).not.toThrow()
    expect(() => manager.validateSessionScope(join(root, 'other-device', 'data'))).toThrow(/inside this device storage/)
  })

  it('does not allow the legacy exception when an isolated session points elsewhere', async () => {
    const { root, managedProfiles, manager } = await setup('darwin', true)
    native.paths.sessionData = join(root, 'other-device')
    await mkdir(native.paths.sessionData)
    expect(() => manager.validateSessionScope(join(managedProfiles, 'default', 'data'))).toThrow(/inside this device storage/)
  })

  it('compares canonical session roots when identifying the legacy local session', async () => {
    const { userData, managedProfiles, manager } = await setup()
    native.paths.sessionData = await realpath(userData)
    expect(() => manager.validateSessionScope(join(managedProfiles, 'default', 'data'))).not.toThrow()
  })

  it('rejects sibling paths that share the managed profile directory prefix', async () => {
    const { stateRoot, manager } = await setup()
    expect(() => manager.validateSessionScope(join(stateRoot, 'profiles-other', 'data'))).toThrow(/inside this device storage/)
  })

  it('rejects a symlink escaping the managed profile directory', async () => {
    const { root, managedProfiles, manager } = await setup()
    const outside = join(root, 'outside')
    await mkdir(outside)
    const alias = join(managedProfiles, 'alias')
    await symlink(outside, alias, hostPlatform === 'win32' ? 'junction' : 'dir')
    expect(() => manager.validateSessionScope(join(alias, 'data'))).toThrow(/inside this device storage/)
  })
})
