import type { BrowserWindow } from 'electron'

/** User-requested activation only. Never leave a normal window always-on-top. */
export function activateDeviceWindow(window: BrowserWindow, platform: NodeJS.Platform = process.platform): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  if (platform !== 'win32') { window.focus();return }
  const pinned = window.isAlwaysOnTop()
  try {
    if (!pinned) window.setAlwaysOnTop(true)
    window.moveTop()
    window.focus()
  } finally {
    if (!pinned && !window.isDestroyed()) window.setAlwaysOnTop(false)
  }
}
