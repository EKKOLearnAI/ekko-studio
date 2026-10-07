import { app } from 'electron'
import type { ScreenshotBitmap } from './screenshot-bitmap'
import type { ScreenshotSelection } from './screenshot-overlay'

export interface ScreenshotFrame {
  id: string
  bitmap: ScreenshotBitmap
  displayId?: string
  desktopBounds?: ScreenshotSelection
  initialSelection?: ScreenshotSelection
}

export interface ScreenshotCapabilities {
  capture: 'electron' | 'portal-screenshot' | 'unavailable'
  presentation: 'desktop-overlay' | 'image-editor'
  hideWindows: boolean
  regionSelection: 'studio' | 'system-or-studio'
}

/** A DISPLAY in a Wayland session describes Xwayland, not the whole desktop. */
export function screenshotEnvironment(platform = process.platform, env = process.env, ozone?: string): ScreenshotCapabilities {
  if (platform === 'darwin' || platform === 'win32') {
    return { capture: 'electron', presentation: 'desktop-overlay', hideWindows: true, regionSelection: 'studio' }
  }
  if (platform === 'linux') {
    ozone ??= app.commandLine.getSwitchValue('ozone-platform')
    const wayland = env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY || ozone === 'wayland'
    const x11 = !wayland && !!env.DISPLAY && (env.XDG_SESSION_TYPE === 'x11' || ozone === 'x11')
    return {
      capture: x11 ? 'electron' : 'portal-screenshot',
      presentation: x11 ? 'desktop-overlay' : 'image-editor',
      // No Linux compositor has passed the native pixel acceptance matrix yet.
      hideWindows: false,
      regionSelection: x11 ? 'studio' : 'system-or-studio',
    }
  }
  return { capture: 'unavailable', presentation: 'image-editor', hideWindows: false, regionSelection: 'studio' }
}

/** Cancellation settles locally even when a native operation never calls back. */
export function waitForScreenshot<T>(operation: Promise<T>, signal: AbortSignal, timeout = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(undefined, signal.reason || new Error('SCREENSHOT_CANCELLED'))
    const timer = setTimeout(() => finish(undefined, new Error('SCREENSHOT_TIMEOUT')), timeout)
    let settled = false
    function finish(value?: T, error?: unknown) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve(value as T)
    }
    operation.then(value => finish(value), error => finish(undefined, error))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
