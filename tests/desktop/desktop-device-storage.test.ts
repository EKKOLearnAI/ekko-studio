import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ defaultSession: { name: 'local-session' }, fromPath: vi.fn() }))
vi.mock('electron', () => ({ session: native }))
import { desktopDeviceStoragePaths, desktopWindowSession } from '../../packages/desktop/src/main/desktop-device-storage'

const directories: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('desktop device storage', () => {
  it('preserves the existing local session and browser profile directory', () => {
    expect(desktopDeviceStoragePaths('/studio', null)).toEqual({ sessionPath: null, browserRoot: join('/studio', 'desktop-browser') })
    expect(desktopWindowSession('/studio', null)).toBe(native.defaultSession)
    expect(native.fromPath).not.toHaveBeenCalled()
  })

  it('isolates full addresses including ports, schemes and same-origin base paths', () => {
    const urls = ['http://host:6060', 'http://host:6061', 'https://host:6060', 'http://host:6060/a', 'http://host:6060/b']
    const paths = urls.map(url => desktopDeviceStoragePaths('/studio', url))
    expect(new Set(paths.map(item => item.sessionPath)).size).toBe(urls.length)
    expect(new Set(paths.map(item => item.browserRoot)).size).toBe(urls.length)
    expect(paths.every(item => item.browserRoot !== join('/studio', 'desktop-browser'))).toBe(true)
    expect(desktopDeviceStoragePaths('/other-studio', urls[0])).not.toEqual(paths[0])
  })

  it('reuses the same storage for normalized addresses across restarts', () => {
    const expected = desktopDeviceStoragePaths('/studio', 'https://host:443/a')
    for (const url of ['https://HOST/a/', ' https://host/a/#/hermes/chat ', 'https://host/a?route=login']) {
      expect(desktopDeviceStoragePaths('/studio', url)).toEqual(expected)
    }
  })

  it('requests a persistent cached session at the device-specific path', () => {
    const home = mkdtempSync(join(tmpdir(), 'studio-device-storage-'))
    directories.push(home)
    const active = { name: 'remote-session' }
    native.fromPath.mockReturnValue(active)
    const remoteUrl = 'https://host/a'
    expect(desktopWindowSession(home, remoteUrl)).toBe(active)
    expect(native.fromPath).toHaveBeenCalledExactlyOnceWith(desktopDeviceStoragePaths(home, remoteUrl).sessionPath, { cache: true })
  })

  it.each(['', 'file:///tmp/invalid', 'not a URL'])('rejects invalid device addresses without falling back to shared local data: %s', value => {
    expect(() => desktopDeviceStoragePaths('/studio', value)).toThrow('Invalid remote device storage URL')
    expect(() => desktopWindowSession('/studio', value)).toThrow('Invalid remote device storage URL')
    expect(native.fromPath).not.toHaveBeenCalled()
  })
})
