import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ trusted: vi.fn(), media: vi.fn(), sources: vi.fn(), open: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({
  systemPreferences: { isTrustedAccessibilityClient: native.trusted, getMediaAccessStatus: native.media },
  desktopCapturer: { getSources: native.sources },
  shell: { openExternal: native.open },
  ipcMain: { handle: native.handle },
}))
import { getComputerUsePermissions, registerComputerUsePermissionsIpc, requestComputerUsePermission } from '../../packages/desktop/src/main/computer-use-permissions'

describe('desktop Computer Use permissions', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.clearAllMocks()
    native.trusted.mockReturnValue(false)
    native.media.mockReturnValue('denied')
    native.sources.mockResolvedValue([])
    native.open.mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('checks missing and granted permissions without prompting or capturing', () => {
    expect(getComputerUsePermissions()).toEqual({ supported: true, accessibility: 'denied', screenRecording: 'denied' })
    native.trusted.mockReturnValue(true)
    native.media.mockReturnValue('granted')
    expect(getComputerUsePermissions()).toEqual({ supported: true, accessibility: 'granted', screenRecording: 'granted' })
    expect(native.trusted.mock.calls).toEqual([[false], [false]])
    expect(native.sources).not.toHaveBeenCalled()
    expect(native.open).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'restricted', 'not-determined'])('preserves %s instead of claiming permission', value => {
    native.media.mockReturnValue(value)
    expect(getComputerUsePermissions()).toMatchObject({ screenRecording: value })
  })

  it.each(['win32', 'linux'] as const)('does not call macOS APIs or claim grants on %s', async platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(getComputerUsePermissions()).toEqual({ supported: false })
    await expect(requestComputerUsePermission('accessibility')).rejects.toThrow('unavailable')
    expect(native.trusted).not.toHaveBeenCalled()
    expect(native.media).not.toHaveBeenCalled()
    expect(native.open).not.toHaveBeenCalled()
  })

  it('requests Accessibility only on the explicit request path', async () => {
    await requestComputerUsePermission('accessibility')
    expect(native.trusted).toHaveBeenCalledExactlyOnceWith(true)
    expect(native.open).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    expect(native.sources).not.toHaveBeenCalled()
  })

  it.each(['denied', 'not-determined', 'unknown'])('registers screen recording without thumbnails when status is %s', async status => {
    native.media.mockReturnValue(status)
    await expect(requestComputerUsePermission('screenRecording')).resolves.toBeUndefined()
    expect(native.sources).toHaveBeenCalledExactlyOnceWith({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    expect(native.open).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    expect(native.trusted).not.toHaveBeenCalled()
  })

  it('still opens the guide when screen capture is denied, and propagates settings failures', async () => {
    native.sources.mockRejectedValue(new Error('denied'))
    await expect(requestComputerUsePermission('screenRecording')).resolves.toBeUndefined()
    native.open.mockRejectedValueOnce(new Error('settings unavailable'))
    await expect(requestComputerUsePermission('screenRecording')).rejects.toThrow('settings unavailable')
  })

  it.each(['granted', 'restricted'])('does not probe screen capture when %s', async status => {
    native.media.mockReturnValue(status)
    await requestComputerUsePermission('screenRecording')
    expect(native.sources).not.toHaveBeenCalled()
    expect(native.open).toHaveBeenCalledOnce()
  })

  it.each(['file:///tmp/test', '__proto__', 'camera', null, {}])('rejects arbitrary settings targets: %s', async input => {
    await expect(requestComputerUsePermission(input)).rejects.toThrow('Invalid')
    expect(native.open).not.toHaveBeenCalled()
    expect(native.trusted).not.toHaveBeenCalled()
    expect(native.sources).not.toHaveBeenCalled()
  })

  it('authorizes IPC senders before reading or requesting permissions', async () => {
    const authorize = vi.fn(() => { throw new Error('untrusted or remote') })
    registerComputerUsePermissionsIpc(authorize)
    const handlers = new Map(native.handle.mock.calls)
    const event = {}
    for (const handler of handlers.values()) expect(() => handler(event, 'accessibility')).toThrow('untrusted or remote')
    expect(native.trusted).not.toHaveBeenCalled()
    expect(native.media).not.toHaveBeenCalled()
    expect(native.open).not.toHaveBeenCalled()
    authorize.mockImplementation(() => {})
    expect(handlers.get('hermes-desktop:computer-use-permissions')(event)).toMatchObject({ supported: true })
    await handlers.get('hermes-desktop:computer-use-request-permission')(event, 'accessibility')
    expect(authorize).toHaveBeenLastCalledWith(event)
    expect(native.trusted).toHaveBeenLastCalledWith(true)
  })

  it('claims only one missing-permission reminder across windows and reloads', () => {
    registerComputerUsePermissionsIpc(vi.fn())
    const claim = new Map(native.handle.mock.calls).get('hermes-desktop:computer-use-claim-reminder')
    expect(claim({ sender: 'main' })).toMatchObject({ supported: true, accessibility: 'denied' })
    expect(claim({ sender: 'chat' })).toBeNull()
    expect(claim({ sender: 'reloaded-main' })).toBeNull()
    expect(native.trusted).toHaveBeenCalledExactlyOnceWith(false)
    expect(native.sources).not.toHaveBeenCalled()
    expect(native.open).not.toHaveBeenCalled()
  })

  it('does not consume the reminder for granted or unknown status; can notice later revocation', () => {
    registerComputerUsePermissionsIpc(vi.fn())
    const claim = new Map(native.handle.mock.calls).get('hermes-desktop:computer-use-claim-reminder')
    native.trusted.mockReturnValue(true)
    native.media.mockReturnValue('granted')
    expect(claim({})).toBeNull()
    native.media.mockReturnValue('unknown')
    expect(claim({})).toBeNull()
    native.media.mockReturnValue('restricted')
    expect(claim({})).toMatchObject({ screenRecording: 'restricted' })
    expect(claim({})).toBeNull()
  })

  it.each(['win32', 'linux'] as const)('never claims a Mac permission reminder on %s', platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    registerComputerUsePermissionsIpc(vi.fn())
    expect(new Map(native.handle.mock.calls).get('hermes-desktop:computer-use-claim-reminder')({})).toBeNull()
    expect(native.trusted).not.toHaveBeenCalled()
    expect(native.media).not.toHaveBeenCalled()
  })
})
