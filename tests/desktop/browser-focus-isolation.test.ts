import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getLocale: () => 'en' }, BrowserWindow: class {}, WebContentsView: class {},
  dialog: {}, Menu: {}, session: {}, shell: {},
}))
import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'

describe('automation host focus isolation', () => {
  it.each([true, false])('does not focus native contents (visible=%s)', async visible => {
    const manager = new BrowserManager({} as BrowserWindow, '/tmp/focus-test-unused') as any
    const contents = {
      getBackgroundThrottling: () => true, setBackgroundThrottling: vi.fn(),
      isDestroyed: () => false, focus: vi.fn(),
    }
    manager.visible = visible
    manager.activeTabId = 'tab'
    manager.syncViews = vi.fn()
    const record = { tab: { id: 'tab' }, view: { webContents: contents } }
    await expect(manager.withAutomationView(record, async () => 42)).resolves.toBe(42)
    expect(contents.focus).not.toHaveBeenCalled()
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    expect(manager.automationVisibleTabs.size).toBe(0)
    await expect(manager.withAutomationView(record, async () => { throw new Error('failed') })).rejects.toThrow('failed')
    expect(contents.focus).not.toHaveBeenCalled()
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    expect(manager.automationVisibleTabs.size).toBe(0)
  })
})
