import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en' },
  BrowserWindow: class {}, WebContentsView: class {},
  dialog: {}, Menu: {}, session: {}, shell: {},
}))

import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(existingRoot?: string) {
  const root = existingRoot || await mkdtemp(join(tmpdir(), 'studio-browser-tabs-'))
  if (!existingRoot) {
    roots.push(root)
    const store = new BrowserProfileStore(root)
    await store.initialize()
    await store.setTabs(store.active().id, [])
  }
  const window = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
  const manager = new BrowserManager(window as unknown as BrowserWindow, root)
  const internal = manager as any
  const built: any[] = []
  internal.buildTab = vi.fn(async (profile, url) => {
    let destroyed = false
    const record = {
      tab: { id: `tab-${built.length + 1}`, profileId: profile.id, title: url, url, agentControl: 'idle' },
      view: {
        setBounds: vi.fn(), setVisible: vi.fn(),
        webContents: {
          loadURL: vi.fn(async () => undefined),
          isDestroyed: () => destroyed,
          close: vi.fn(() => { destroyed = true }),
          debugger: { isAttached: () => true, detach: vi.fn() },
        },
      },
      console: [],
    }
    built.push(record)
    return record
  })
  await manager.initialize()
  return { manager, internal, built, window, root }
}

const urls = (count: number) => Array.from({ length: count }, (_, index) => `https://example.com/${index + 1}`)
const tabUrls = (manager: BrowserManager) => manager.state().tabs.map(tab => tab.url)

describe('desktop browser tab rotation', () => {
  it('keeps twelve tabs and evicts the oldest created tab even after it is activated', async () => {
    const { manager, internal, built, window, root } = await setup()
    for (const url of urls(12)) await manager.createTab(url)
    expect(manager.state().maxTabs).toBe(12)
    expect(manager.state().tabs).toHaveLength(12)
    expect(window.contentView.removeChildView).not.toHaveBeenCalled()

    const oldest = built[0]
    manager.activateTab(oldest.tab.id)
    internal.automation.snapshots.set(oldest.tab.id, { id: 'old', refs: new Map() })
    const newest = await manager.createTab('https://example.com/13')

    expect(tabUrls(manager)).toEqual(urls(13).slice(1))
    expect(manager.state().activeTabId).toBe(newest.id)
    expect(oldest.view.webContents.close).toHaveBeenCalledOnce()
    expect(oldest.view.webContents.debugger.detach).toHaveBeenCalledOnce()
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(oldest.view)
    expect(internal.automation.snapshots.has(oldest.tab.id)).toBe(false)
    const restarted = new BrowserProfileStore(root)
    await restarted.initialize()
    expect(restarted.active().tabs).toEqual(urls(13).slice(1))
  })

  it('serializes concurrent creation and closure without exceeding the cap or closing twice', async () => {
    const { manager, built } = await setup()
    const sizes: number[] = []
    manager.onStateChange(state => sizes.push(state.tabs.length))
    await Promise.all(urls(12).map(url => manager.createTab(url)))
    await Promise.all([
      manager.closeTab(built[0].tab.id),
      ...urls(16).slice(12).map(url => manager.createTab(url, false)),
    ])

    expect(tabUrls(manager)).toEqual(urls(16).slice(4))
    expect(Math.max(...sizes)).toBe(12)
    for (const record of built.slice(0, 4)) expect(record.view.webContents.close).toHaveBeenCalledOnce()
    expect(manager.state().activeTabId).toBe(built[11].tab.id)
  })

  it('does not evict a tab for invalid URLs or failed creation and recovers after failure', async () => {
    const { manager, internal, window } = await setup()
    await Promise.all(urls(12).map(url => manager.createTab(url)))
    await expect(manager.createTab('file:///tmp/blocked')).rejects.toThrow()
    internal.buildTab.mockRejectedValueOnce(new Error('Cannot create view'))
    await expect(manager.createTab('https://example.com/failed')).rejects.toThrow('Cannot create view')
    expect(tabUrls(manager)).toEqual(urls(12))
    expect(window.contentView.removeChildView).not.toHaveBeenCalled()
    await manager.createTab('https://example.com/13')
    expect(tabUrls(manager)).toEqual(urls(13).slice(1))
  })

  it('allows other tabs to open and close while a page is still loading', async () => {
    const { manager, internal } = await setup()
    let finishLoad!: () => void
    const loading = new Promise<void>(resolve => { finishLoad = resolve })
    const build = internal.buildTab.getMockImplementation()
    internal.buildTab.mockImplementationOnce(async (...args: unknown[]) => {
      const record = await build(...args)
      record.view.webContents.loadURL.mockReturnValue(loading)
      return record
    })
    const slow = manager.createTab('https://example.com/slow')
    try {
      const fast = await manager.createTab('https://example.com/fast')
      await manager.closeTab(fast.id)
      expect(tabUrls(manager)).toEqual(['https://example.com/slow'])
    } finally {
      finishLoad()
      await slow
    }
  })

  it('restores the newest twelve saved tabs in creation order', async () => {
    const { root } = await setup()
    const file = join(root, 'profiles.json')
    const document = JSON.parse(await readFile(file, 'utf8'))
    document.profiles[0].tabs = urls(15)
    await writeFile(file, JSON.stringify(document))
    const { manager } = await setup(root)
    expect(tabUrls(manager)).toEqual(urls(15).slice(3))
    await manager.createTab('https://example.com/16')
    expect(tabUrls(manager)).toEqual(urls(16).slice(4))
    const restarted = await setup(root)
    expect(tabUrls(restarted.manager)).toEqual(urls(16).slice(4))
  })

  it('applies the same rotation to HTML previews without persisting their content', async () => {
    const { manager, root } = await setup()
    await Promise.all(urls(12).map(url => manager.createTab(url)))
    const preview = await manager.createHtmlPreviewTab('<h1>Preview</h1>', 'Preview')
    expect(manager.state().tabs).toHaveLength(12)
    expect(tabUrls(manager).slice(0, -1)).toEqual(urls(12).slice(1))
    expect(manager.state().activeTabId).toBe(preview.id)
    const store = new BrowserProfileStore(root)
    await store.initialize()
    expect(store.active().tabs).toEqual(urls(12).slice(1))
  })
})
