import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopRemoteDevices } from '../../packages/desktop/src/main/remote-devices'
import { resolveRemoteServerUrl } from '../../packages/desktop/src/main/remote-server'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function setup(activeServerUrl: string | null = null, initial?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'studio-remote-devices-'))
  directories.push(home)
  const file = join(home, 'desktop-remote-server.json')
  if (initial) writeFileSync(file, JSON.stringify(initial))
  const options = { home, activeServerUrl, env: {} as NodeJS.ProcessEnv, checkReady: vi.fn(async (_url: string) => {}), restart: vi.fn(() => true) }
  return { options, file, manager: new DesktopRemoteDevices(options) }
}

describe('desktop remote device persistence', () => {
  it('adds, normalizes, persists and removes devices without selecting them', () => {
    const { manager, options } = setup()
    expect(manager.state()).toEqual({ devices: [], activeDeviceId: null, activeServerUrl: null })
    const state = manager.add({ name: ' Home ', serverUrl: 'https://studio.example/#/login' })
    expect(state.devices[0]).toMatchObject({ name: 'Home', serverUrl: 'https://studio.example' })
    expect(resolveRemoteServerUrl({}, options.home)).toBeNull()
    expect(new DesktopRemoteDevices(options).state()).toEqual(state)
    state.devices[0].name = 'modified copy'
    expect(manager.state().devices[0].name).toBe('Home')
    expect(manager.remove(state.devices[0].id).devices).toEqual([])
    expect(new DesktopRemoteDevices(options).state().devices).toEqual([])
    expect(options.checkReady).not.toHaveBeenCalled()
    expect(options.restart).not.toHaveBeenCalled()
  })

  it('imports the legacy file and environment URL, preserving both across a switch to local', async () => {
    const { manager, options } = setup('http://env-server:6060', { serverUrl: 'http://legacy-server:6060/' })
    options.env.EKKO_STUDIO_DESKTOP_SERVER_URL = 'http://env-server:6060'
    expect(manager.state().devices.map(device => device.serverUrl)).toEqual(['http://legacy-server:6060', 'http://env-server:6060'])
    expect(manager.state().activeDeviceId).toBe(manager.state().devices[1].id)
    await manager.switchTo(null)
    expect(options.env.EKKO_STUDIO_DESKTOP_SERVER_URL).toBeUndefined()
    expect(resolveRemoteServerUrl(options.env, options.home)).toBeNull()
    expect(new DesktopRemoteDevices({ ...options, activeServerUrl: null }).state().devices).toHaveLength(2)
    expect(options.restart).toHaveBeenCalledOnce()
  })

  it.each([
    [{ name: '', serverUrl: 'http://host' }, 'INVALID_NAME'],
    [{ name: 'a'.repeat(81), serverUrl: 'http://host' }, 'INVALID_NAME'],
    [{ name: 'Home', serverUrl: 'file:///tmp/test' }, 'INVALID_URL'],
    [{ name: 'Home', serverUrl: 'http://user:secret@host' }, 'INVALID_URL'],
    [{ name: 'Subpath', serverUrl: 'https://host/studio/' }, 'UNSUPPORTED_PATH'],
    [null, 'INVALID_NAME'],
  ])('rejects invalid device input without writing: %s', (input, code) => {
    const { manager } = setup()
    expect(() => manager.add(input)).toThrow(`REMOTE_DEVICE_${code}`)
    expect(manager.state().devices).toEqual([])
  })

  it('rejects duplicate normalized URLs and protects the connected device', () => {
    const { manager } = setup('http://home:6060')
    expect(() => manager.add({ name: 'Duplicate', serverUrl: 'http://home:6060/' })).toThrow('DUPLICATE')
    expect(() => manager.remove(manager.state().activeDeviceId)).toThrow('ACTIVE')
    expect(() => manager.remove('missing')).toThrow('NOT_FOUND')
  })

  it('does not overwrite a malformed settings file', () => {
    const { file, options } = setup()
    writeFileSync(file, '{broken')
    expect(() => new DesktopRemoteDevices(options)).toThrow('LOAD_FAILED')
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })

  it('reports disk failures without changing the in-memory device list', () => {
    const { manager, options } = setup()
    rmSync(options.home, { recursive: true })
    writeFileSync(options.home, 'cannot create a directory here')
    expect(() => manager.add({ name: 'Home', serverUrl: 'http://home:6060' })).toThrow('SAVE_FAILED')
    expect(manager.state().devices).toEqual([])
  })
})

describe('switching desktop devices', () => {
  it('probes before committing, selects the URL used on relaunch, and prevents concurrent changes', async () => {
    const { manager, options } = setup()
    const id = manager.add({ name: 'Home', serverUrl: 'http://home:6060' }).devices[0].id
    let ready!: () => void
    options.checkReady.mockImplementation(() => new Promise(resolve => { ready = resolve }))
    const switching = manager.switchTo(id)
    expect(options.checkReady).toHaveBeenCalledWith('http://home:6060')
    expect(resolveRemoteServerUrl({}, options.home)).toBeNull()
    await expect(manager.switchTo(null)).rejects.toThrow('BUSY')
    expect(() => manager.remove(id)).toThrow('BUSY')
    expect(() => manager.add({ name: 'New', serverUrl: 'http://new' })).toThrow('BUSY')
    ready()
    await switching
    expect(resolveRemoteServerUrl({}, options.home)).toBe('http://home:6060')
    expect(options.restart).toHaveBeenCalledOnce()
    expect(new DesktopRemoteDevices({ ...options, activeServerUrl: 'http://home:6060' }).state().activeDeviceId).toBe(id)
  })

  it('keeps the current connection on probe failure and allows retry', async () => {
    const { manager, options, file } = setup('http://current:6060', { serverUrl: 'http://current:6060' })
    const id = manager.add({ name: 'Offline', serverUrl: 'http://offline:6060' }).devices[1].id
    const before = readFileSync(file, 'utf8')
    options.checkReady.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(manager.switchTo(id)).rejects.toThrow('UNREACHABLE')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(options.restart).not.toHaveBeenCalled()
    await manager.switchTo(id)
    expect(options.restart).toHaveBeenCalledOnce()
  })

  it('restores the old file and environment override if restart cannot be scheduled', async () => {
    const { manager, options } = setup('http://current:6060', { serverUrl: 'http://current:6060' })
    const id = manager.add({ name: 'Home', serverUrl: 'http://home:6060' }).devices[1].id
    options.env.EKKO_STUDIO_DESKTOP_SERVER_URL = 'http://current:6060'
    options.restart.mockReturnValueOnce(false)
    await expect(manager.switchTo(id)).rejects.toThrow('RESTART_FAILED')
    expect(options.env.EKKO_STUDIO_DESKTOP_SERVER_URL).toBe('http://current:6060')
    expect(resolveRemoteServerUrl({}, options.home)).toBe('http://current:6060')
    await manager.switchTo(null)
    expect(resolveRemoteServerUrl(options.env, options.home)).toBeNull()
  })

  it('ignores an already active target and rejects unknown IDs', async () => {
    const { manager, options } = setup()
    await manager.switchTo(null)
    await expect(manager.switchTo('missing')).rejects.toThrow('NOT_FOUND')
    await expect(manager.switchTo(undefined)).rejects.toThrow('NOT_FOUND')
    expect(options.restart).not.toHaveBeenCalled()
  })
})
