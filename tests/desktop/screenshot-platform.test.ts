import { describe, expect, it } from 'vitest'
import { screenshotEnvironment } from '../../packages/desktop/src/main/screenshot-platform'
import { portalScreenshotTarget } from '../../packages/desktop/src/main/screenshot-portal'

describe('screenshot platform capabilities', () => {
  it.each(['darwin', 'win32'] as const)('uses native overlays on %s', platform => {
    expect(screenshotEnvironment(platform, {}, '')).toEqual({ capture: 'electron', presentation: 'desktop-overlay', hideWindows: true, regionSelection: 'studio' })
  })
  it('allows ordinary native X11 screenshots, with hiding disabled until pixel acceptance', () => {
    expect(screenshotEnvironment('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, '')).toEqual({ capture: 'electron', presentation: 'desktop-overlay', hideWindows: false, regionSelection: 'studio' })
  })
  it.each([
    [{ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, 'x11'],
    [{ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'x11'],
    [{ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, 'wayland'],
    [{ DISPLAY: ':0' }, ''],
    [{}, ''],
  ])('uses conservative image editing for unconfirmed/Xwayland sessions %j', (env, ozone) => {
    expect(screenshotEnvironment('linux', env, ozone)).toEqual({ capture: 'portal-screenshot', presentation: 'image-editor', hideWindows: false, regionSelection: 'system-or-studio' })
  })
  it('negotiates Area/Screen only when advertised by Screenshot v3', () => {
    expect(portalScreenshotTarget(1)).toEqual({ version: 1 })
    expect(portalScreenshotTarget(2, 4)).toEqual({ version: 2 })
    expect(portalScreenshotTarget(3, 5)).toEqual({ version: 3, target: 4 })
    expect(portalScreenshotTarget(3, 1)).toEqual({ version: 3, target: 1 })
    expect(() => portalScreenshotTarget(3, 2)).toThrow('SCREENSHOT_PORTAL_UNAVAILABLE')
    expect(() => portalScreenshotTarget(0)).toThrow('SCREENSHOT_PORTAL_UNAVAILABLE')
  })
})
