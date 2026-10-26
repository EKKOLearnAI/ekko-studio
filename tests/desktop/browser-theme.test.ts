import type { WebContentsView } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { applyBrowserColorScheme } from '../../packages/desktop/src/main/browser/browser-theme'

describe('embedded browser color scheme', () => {
  it('changes background and native media preference without forced page inversion', async () => {
    let attached = false
    const debuggerApi = { isAttached: () => attached, attach: vi.fn(() => { attached = true }), sendCommand: vi.fn(async () => {}) }
    const view = { setBackgroundColor: vi.fn(), webContents: { isDestroyed: () => false, debugger: debuggerApi } } as unknown as WebContentsView
    await applyBrowserColorScheme(view, 'dark')
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#1a1a1a')
    await applyBrowserColorScheme(view, 'light')
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff')
    expect(debuggerApi.attach).toHaveBeenCalledOnce()
    expect(debuggerApi.sendCommand.mock.calls).toEqual([
      ['Emulation.setAutoDarkModeOverride', { enabled: true }],
      ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }],
      ['Emulation.setAutoDarkModeOverride', { enabled: false }],
      ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }],
    ])
  })
  it('does not attach to a destroyed tab', async () => {
    const view = { setBackgroundColor: vi.fn(), webContents: { isDestroyed: () => true } } as unknown as WebContentsView
    await expect(applyBrowserColorScheme(view, 'dark')).resolves.toBeUndefined()
  })
})
