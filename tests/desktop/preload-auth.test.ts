import { readFileSync } from 'fs'
import { resolve } from 'path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteDevicesBridge } from '../../packages/client/src/utils/desktop-bridge'

function loadPreload(argv: string[], storedToken = 'remote-session', platform = 'darwin') {
  const storage = new Map(storedToken ? [['hermes_api_key', storedToken], ['AUTH_TOKEN', storedToken]] : [])
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  }
  const listeners = new Map<string, () => Promise<void>>()
  const invoke = vi.fn(async () => 'local-desktop-token')
  const expose = vi.fn()
  const authBody = JSON.stringify({ user: { requiresCredentialChange: true } })
  const fetch = vi.fn(async (_input: string) => new Response(authBody))
  class XHR {
    open(_method: string, _url: string) {}
    get responseText() { return authBody }
    get response() { return authBody }
  }
  const window = {
    fetch,
    XMLHttpRequest: XHR,
    addEventListener: (name: string, callback: () => Promise<void>) => listeners.set(name, callback),
  }
  const source = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(compiled, {
    exports: {},
    require: () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }),
    process: { argv, platform },
    window,
    localStorage,
    Response,
  })
  const bridge = expose.mock.calls[0][1] as {
    isDesktop: boolean
    remoteMode: boolean
    windowKind: string
    ensureAuth: () => Promise<boolean>
    remoteDevices?: DesktopRemoteDevicesBridge
    selectRuntimeDirectory?: (defaultPath?: string) => Promise<string | null>
    restartApp?: () => Promise<boolean>
    computerUsePermissions?: {
      claimReminder: () => Promise<unknown>
      getStatus: () => Promise<unknown>
      request: (permission: 'accessibility' | 'screenRecording') => Promise<void>
    }
    messageContextMenu: {
      show: (request: { label: string; enabled: boolean; hasSelection: boolean }) => Promise<'select-messages' | null>
      close: () => Promise<void>
    }
  }
  return { bridge, invoke, listeners, storage, window }
}

describe('desktop preload auth', () => {
  it('exposes Runtime directory picking and app restarts only for a local backend', async () => {
    const local = loadPreload([])
    await local.bridge.selectRuntimeDirectory!('/runtime')
    expect(local.invoke).toHaveBeenCalledWith('hermes-desktop:select-runtime-directory', '/runtime')
    expect(loadPreload(['--hermes-remote-mode']).bridge.selectRuntimeDirectory).toBeUndefined()
    await local.bridge.restartApp!()
    expect(local.invoke).toHaveBeenLastCalledWith('hermes-desktop:restart-app')
    expect(loadPreload(['--hermes-remote-mode']).bridge.restartApp).toBeUndefined()
  })
  it.each([false, true])('exposes remote device management only in the main window (remote=%s)', async remote => {
    const args = remote ? ['--hermes-remote-mode'] : []
    const { bridge, invoke } = loadPreload(args)
    const devices = bridge.remoteDevices!
    await devices.list()
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:remote-devices-list')
    const input = { name: 'Home', serverUrl: 'http://home:6060' }
    await devices.add(input)
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:remote-devices-add', input)
    await devices.remove('home')
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:remote-devices-remove', 'home')
    await devices.switchTo(null)
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:remote-devices-switch', null)
    await devices.returnLocal()
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:remote-devices-return-local')
    for (const kind of ['pet', 'chat']) expect(loadPreload([...args, `--hermes-window-kind=${kind}`]).bridge.remoteDevices).toBeUndefined()
  })

  it('exposes permission checks and explicit authorization only on a local Mac', async () => {
    const { bridge, invoke } = loadPreload([])
    expect(invoke).not.toHaveBeenCalled()
    await bridge.computerUsePermissions!.claimReminder()
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:computer-use-claim-reminder')
    await bridge.computerUsePermissions!.getStatus()
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:computer-use-permissions')
    await bridge.computerUsePermissions!.request('screenRecording')
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:computer-use-request-permission', 'screenRecording')
    expect(loadPreload(['--hermes-remote-mode']).bridge.computerUsePermissions).toBeUndefined()
    for (const platform of ['win32', 'linux']) expect(loadPreload([], '', platform).bridge.computerUsePermissions).toBeUndefined()
  })
  it.each(['main', 'chat'])('exposes the message menu bridge in the %s window', async kind => {
    const { bridge, invoke } = loadPreload(['--hermes-remote-mode', `--hermes-window-kind=${kind}`])
    const request = { label: '多选消息', enabled: true, hasSelection: true }
    invoke.mockResolvedValueOnce('select-messages')
    expect(await bridge.messageContextMenu.show(request)).toBe('select-messages')
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:message-context-menu-show', request)
    await bridge.messageContextMenu.close()
    expect(invoke).toHaveBeenLastCalledWith('hermes-desktop:message-context-menu-close')
  })

  it.each(['main', 'pet', 'chat'])('preserves remote auth and password policy in the %s window', async kind => {
    const preload = loadPreload(['--hermes-remote-mode', `--hermes-window-kind=${kind}`])

    expect(preload.bridge).toMatchObject({ isDesktop: true, remoteMode: true, windowKind: kind })
    expect(await preload.bridge.ensureAuth()).toBe(true)
    await preload.listeners.get('DOMContentLoaded')!()
    expect(preload.invoke).not.toHaveBeenCalled()
    expect(preload.storage.get('AUTH_TOKEN')).toBe('remote-session')
    const response = await preload.window.fetch('/api/auth/me')
    expect((await response.json()).user.requiresCredentialChange).toBe(true)
    const xhr = new preload.window.XMLHttpRequest()
    xhr.open('GET', '/api/auth/me')
    expect(JSON.parse(xhr.responseText).user.requiresCredentialChange).toBe(true)
    expect(JSON.parse(xhr.response).user.requiresCredentialChange).toBe(true)
  })

  it('leaves an unauthenticated remote window logged out', async () => {
    const preload = loadPreload(['--hermes-remote-mode'], '')

    expect(await preload.bridge.ensureAuth()).toBe(false)
    await preload.listeners.get('DOMContentLoaded')!()
    expect(preload.invoke).not.toHaveBeenCalled()
    expect(preload.storage.size).toBe(0)
  })

  it('retains token injection and password-policy suppression for local mode', async () => {
    const preload = loadPreload([])

    expect(preload.bridge.remoteMode).toBe(false)
    await preload.bridge.ensureAuth()
    await preload.listeners.get('DOMContentLoaded')!()
    expect(preload.invoke).toHaveBeenCalledWith('hermes-desktop:get-token')
    expect(preload.storage.get('AUTH_TOKEN')).toBe('local-desktop-token')
    const response = await preload.window.fetch('/api/auth/me')
    expect((await response.json()).user.requiresCredentialChange).toBe(false)
    const xhr = new preload.window.XMLHttpRequest()
    xhr.open('GET', '/api/auth/me')
    expect(JSON.parse(xhr.responseText).user.requiresCredentialChange).toBe(false)
    expect(JSON.parse(xhr.response).user.requiresCredentialChange).toBe(false)
  })

  it('does not auto-login with default credentials', () => {
    const source = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')

    expect(source).not.toContain('/api/auth/login')
    expect(source).not.toContain('DEFAULT_PASSWORD')
    expect(source).not.toContain('DEFAULT_USERNAME')
    expect(source).not.toContain('autoLogin')
  })

  it('exposes the native Runtime directory picker through a dedicated IPC channel', () => {
    const preloadSource = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(preloadSource).toContain("ipcRenderer.invoke('hermes-desktop:select-runtime-directory'")
    expect(mainSource).toContain("ipcMain.handle('hermes-desktop:select-runtime-directory'")
    expect(mainSource).toContain("properties: ['openDirectory']")
  })

  it('exposes browser profile root selection through a dedicated IPC channel', () => {
    const preloadSource = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(preloadSource).toContain("ipcRenderer.invoke('hermes-desktop:browser-choose-profile-root-directory'")
    expect(mainSource).toContain("ipcMain.handle('hermes-desktop:browser-choose-profile-root-directory'")
    expect(mainSource).not.toContain("ipcMain.handle('hermes-desktop:browser-choose-directory'")
  })

  it('exposes cancellation for active browser downloads', () => {
    const preloadSource = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(preloadSource).toContain("ipcRenderer.invoke('hermes-desktop:browser-cancel-download'")
    expect(mainSource).toContain("ipcMain.handle('hermes-desktop:browser-cancel-download'")
  })

  it('exposes the validated system-browser URL bridge', () => {
    const preloadSource = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(preloadSource).toContain("ipcRenderer.invoke('hermes-desktop:open-external-url'")
    expect(mainSource).toContain("ipcMain.handle('hermes-desktop:open-external-url'")
    expect(mainSource).toContain('normalizeExternalHttpUrl')
  })
})
