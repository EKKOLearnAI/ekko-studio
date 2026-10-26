import { desktopCapturer, ipcMain, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'

export type ComputerUsePermission = 'accessibility' | 'screenRecording'
export type ComputerUsePermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
export type ComputerUsePermissions = { supported: false } | {
  supported: true
  accessibility: ComputerUsePermissionStatus
  screenRecording: ComputerUsePermissionStatus
}

export function getComputerUsePermissions(): ComputerUsePermissions {
  if (process.platform !== 'darwin') return { supported: false }
  return {
    supported: true,
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
    screenRecording: systemPreferences.getMediaAccessStatus('screen'),
  }
}

export async function requestComputerUsePermission(permission: unknown): Promise<void> {
  if (permission !== 'accessibility' && permission !== 'screenRecording') throw new Error('Invalid Computer Use permission')
  if (process.platform !== 'darwin') throw new Error('macOS permission settings are unavailable on this platform')

  if (permission === 'accessibility') {
    // Only an explicit user action may register/request permission for this app.
    systemPreferences.isTrustedAccessibilityClient(true)
  } else if (!['granted', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
    // Registration can wait on a native consent dialog indefinitely. Start it
    // without awaiting it so the explicit authorization action opens Settings now.
    // Never collect thumbnails or return source metadata to the renderer.
    try {
      void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).catch(() => {})
    } catch { /* Registration failure must not block opening the permission pane. */ }
  }
  const pane = permission === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
}

export function registerComputerUsePermissionsIpc(authorize: (event: IpcMainInvokeEvent) => void): void {
  // Shared by all Studio windows and renderer reloads; resets on app restart.
  let reminderClaimed = false
  ipcMain.handle('hermes-desktop:computer-use-claim-reminder', event => {
    authorize(event)
    if (reminderClaimed) return null
    const status = getComputerUsePermissions()
    if (!status.supported || ![status.accessibility, status.screenRecording].some(value =>
      ['denied', 'not-determined', 'restricted'].includes(value),
    )) return null
    reminderClaimed = true
    return status
  })
  ipcMain.handle('hermes-desktop:computer-use-permissions', event => {
    authorize(event)
    return getComputerUsePermissions()
  })
  ipcMain.handle('hermes-desktop:computer-use-request-permission', (event, permission: unknown) => {
    authorize(event)
    return requestComputerUsePermission(permission)
  })
}
