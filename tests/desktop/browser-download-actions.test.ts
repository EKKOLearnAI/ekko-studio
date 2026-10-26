import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile, access, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const native = vi.hoisted(() => ({
  openPath: vi.fn(async () => ''), showItemInFolder: vi.fn(), trashItem: vi.fn(async () => {}),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}))
vi.mock('electron', () => ({ app: { getLocale: () => 'en' }, shell: native, dialog: native }))
import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  native.openPath.mockResolvedValue('')
  native.showMessageBox.mockResolvedValue({ response: 0 })
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'browser-download-actions-'))
  roots.push(root)
  const manager = new BrowserManager({} as BrowserWindow, join(root, 'state'))
  const internal = manager as any
  const store = internal.profileStore as BrowserProfileStore
  await store.initialize()
  const profile = store.active()
  internal.activeProfileId = profile.id
  const contents = {}
  internal.records.set('tab', { tab: { id: 'tab', profileId: profile.id }, view: { webContents: contents } })
  const destination = join(root, 'chosen')
  await mkdir(destination)
  return { root, manager, internal, store, profile, contents, destination }
}
function download() {
  let selectedPath = '', state = 'progressing'
  const item = Object.assign(new EventEmitter(), {
    getFilename: () => 'report.mp4', getURL: () => 'https://test/report.mp4',
    getTotalBytes: () => 10, getReceivedBytes: () => 10, getState: () => state,
    getSavePath: () => selectedPath,
    setSaveDialogOptions: vi.fn(), setSavePath: vi.fn((p: string) => { selectedPath = p }), cancel: vi.fn(),
  })
  return { item, select: (p: string) => { selectedPath = p }, done: (next: string) => { state = next; item.emit('done', {}, next) } }
}
async function completed() {
  const s = await setup()
  const d = download()
  s.internal.handleDownload(s.profile, d.item, s.contents)
  const path = join(s.destination, 'report.mp4')
  await writeFile(path, 'proof')
  d.select(path); d.done('completed')
  const id = s.manager.state().downloads[0].id
  return { ...s, path, id }
}

it('remembers the confirmed directory across restart without changing another profile/device', async () => {
  const s = await setup()
  const d = download()
  s.internal.handleDownload(s.profile, d.item, s.contents)
  const selected = join(s.destination, 'report.mp4')
  d.select(selected); d.done('completed')
  // Flush the same serialized persistence queue that writes the directory preference.
  await s.store.setTabs(s.profile.id, [])
  const restarted = new BrowserProfileStore(s.store.root)
  await restarted.initialize()
  expect(restarted.active().lastDownloadDirectory).toBe(s.destination)
  const next = download()
  s.internal.handleDownload(s.profile, next.item, s.contents)
  expect(next.item.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: selected })
  const otherRoot = join(s.root, 'other-profile')
  await mkdir(otherRoot)
  const other = await s.store.create({ name: 'Other', rootDirectory: otherRoot })
  expect(other.lastDownloadDirectory).toBeUndefined()
  const otherDevice = new BrowserProfileStore(join(s.root, 'device-two'))
  await otherDevice.initialize()
  expect(otherDevice.active().lastDownloadDirectory).toBeUndefined()
})
it('does not remember cancelled dialogs and falls back from an unavailable destination', async () => {
  const s = await setup(), d = download()
  s.internal.handleDownload(s.profile, d.item, s.contents)
  d.select(join(s.destination, 'cancelled.mp4')); d.done('cancelled')
  await s.store.setTabs(s.profile.id, [])
  expect(s.profile.lastDownloadDirectory).toBeUndefined()
  await s.store.rememberDownloadDirectory(s.profile.id, join(s.root, 'unmounted'))
  const next = download(); s.internal.handleDownload(s.profile, next.item, s.contents)
  expect(next.item.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: join(s.profile.downloadPath, 'report.mp4') })
})
it('remembers the updated confirmed destination before completion and uniquifies collisions', async () => {
  const s = await setup(), d = download()
  s.internal.handleDownload(s.profile, d.item, s.contents)
  const selected = join(s.destination, 'report.mp4')
  await writeFile(selected, 'existing')
  d.select(selected); d.item.emit('updated', {}, 'progressing')
  await s.store.setTabs(s.profile.id, [])
  const next = download(); s.internal.handleDownload(s.profile, next.item, s.contents)
  expect(next.item.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: join(s.destination, 'report (1).mp4') })
})
it('opens and reveals only the Desktop-recorded path, and removal leaves the file intact', async () => {
  const s = await completed()
  await s.manager.downloadAction(s.id, 'open')
  expect(native.openPath).toHaveBeenCalledWith(s.path)
  await s.manager.downloadAction(s.id, 'reveal')
  expect(native.showItemInFolder).toHaveBeenCalledWith(s.path)
  expect((await s.manager.downloadAction(s.id, 'remove')).downloads).toHaveLength(0)
  await expect(access(s.path)).resolves.toBeUndefined()
  expect(native.trashItem).not.toHaveBeenCalled()
  await expect(s.manager.downloadAction(s.path, 'open')).rejects.toThrow('NOT_FOUND')
})
it('requires a cancel-default native confirmation before trash, and preserves the record on cancellation', async () => {
  const s = await completed()
  expect((await s.manager.downloadAction(s.id, 'trash')).downloads).toHaveLength(1)
  expect(native.trashItem).not.toHaveBeenCalled()
  expect(native.showMessageBox.mock.calls[0]?.[1]).toMatchObject({ defaultId: 0, cancelId: 0 })
  native.showMessageBox.mockResolvedValueOnce({ response: 1 })
  expect((await s.manager.downloadAction(s.id, 'trash')).downloads).toHaveLength(0)
  expect(native.trashItem).toHaveBeenCalledWith(s.path)
})
it('preserves the record when shell open/trash fails and rejects missing files', async () => {
  const s = await completed()
  native.openPath.mockResolvedValueOnce('OS refused')
  await expect(s.manager.downloadAction(s.id, 'open')).rejects.toThrow('OPEN_FAILED')
  native.showMessageBox.mockResolvedValueOnce({ response: 1 })
  native.trashItem.mockRejectedValueOnce(new Error('trash failed'))
  await expect(s.manager.downloadAction(s.id, 'trash')).rejects.toThrow('trash failed')
  expect(s.manager.state().downloads).toHaveLength(1)
  await rm(s.path)
  await expect(s.manager.downloadAction(s.id, 'reveal')).rejects.toThrow('FILE_UNAVAILABLE')
  expect((await s.manager.downloadAction(s.id, 'remove')).downloads).toHaveLength(0)
})
it('rejects directories, symbolic links and active downloads', async () => {
  const s = await completed()
  await rm(s.path); await mkdir(s.path)
  await expect(s.manager.downloadAction(s.id, 'trash')).rejects.toThrow('FILE_UNAVAILABLE')
  await rm(s.path, { recursive: true })
  await symlink(s.destination, s.path, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(s.manager.downloadAction(s.id, 'open')).rejects.toThrow('FILE_UNAVAILABLE')
  const d = download(); s.internal.handleDownload(s.profile, d.item, s.contents)
  const active = s.manager.state().downloads[0]
  for (const action of ['open', 'reveal', 'remove', 'trash'] as const) {
    await expect(s.manager.downloadAction(active.id, action)).rejects.toThrow('ACTIVE')
  }
})
it('rechecks the path after confirmation rather than trashing a substituted directory', async () => {
  const s = await completed()
  native.showMessageBox.mockImplementationOnce(async () => {
    await rm(s.path); await mkdir(s.path)
    return { response: 1 }
  })
  await expect(s.manager.downloadAction(s.id, 'trash')).rejects.toThrow('FILE_UNAVAILABLE')
  expect(native.trashItem).not.toHaveBeenCalled()
  expect(s.manager.state().downloads).toHaveLength(1)
})

it('does not open or trash a different file that replaced the recorded download', async () => {
  const s = await completed()
  await rm(s.path)
  await writeFile(s.path, 'replacement-that-is-not-the-download')
  await expect(s.manager.downloadAction(s.id, 'open')).rejects.toThrow('FILE_UNAVAILABLE')
  await expect(s.manager.downloadAction(s.id, 'trash')).rejects.toThrow('FILE_UNAVAILABLE')
  expect(native.trashItem).not.toHaveBeenCalled()
  expect((await s.manager.downloadAction(s.id, 'remove')).downloads).toHaveLength(0)
})
it('serializes actions on the same record while native confirmation is pending', async () => {
  const s = await completed()
  let answer!: (value: { response: number }) => void
  native.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const pending = s.manager.downloadAction(s.id, 'trash')
  await expect(s.manager.downloadAction(s.id, 'remove')).rejects.toThrow('ACTIVE')
  answer({ response: 0 })
  await pending
  expect((await s.manager.downloadAction(s.id, 'remove')).downloads).toHaveLength(0)
})

it('refreshes file availability without deleting the file or history, including replacements', async () => {
  const s = await completed()
  expect(s.manager.refreshDownloads().downloads[0].fileAvailable).toBe(true)
  await rm(s.path)
  expect(s.manager.refreshDownloads().downloads[0].fileAvailable).toBe(false)
  expect(s.manager.state().downloads).toHaveLength(1)
  await writeFile(s.path, 'replacement contents')
  expect(s.manager.refreshDownloads().downloads[0].fileAvailable).toBe(false)
  await expect(access(s.path)).resolves.toBeUndefined()
  expect(native.trashItem).not.toHaveBeenCalled()
})

it('restores completed history and removal across a manager restart, refusing replaced files', async () => {
  const s = await completed()
  async function restart() {
    const manager = new BrowserManager({} as BrowserWindow, s.store.root)
    ;(manager as any).restoreTabs = async () => {}
    await manager.initialize()
    return manager
  }
  const restored = await restart()
  expect(restored.refreshDownloads().downloads[0]).toMatchObject({ id: s.id, state: 'completed', fileAvailable: true })
  await writeFile(s.path, 'changed after restart')
  expect(restored.refreshDownloads().downloads[0].fileAvailable).toBe(false)
  await expect(restored.downloadAction(s.id, 'open')).rejects.toThrow('FILE_UNAVAILABLE')
  await restored.downloadAction(s.id, 'remove')
  expect((await restart()).state().downloads).toEqual([])
  await expect(access(s.path)).resolves.toBeUndefined()
})

it('restores cancelled and in-flight download records without resuming transfers', async () => {
  const s = await setup(), first = download(), second = download()
  s.internal.handleDownload(s.profile, first.item, s.contents)
  const cancelledId = s.manager.state().downloads[0].id
  s.manager.cancelDownload(cancelledId)
  s.internal.handleDownload(s.profile, second.item, s.contents)
  const restarted = new BrowserManager({} as BrowserWindow, s.store.root)
  ;(restarted as any).restoreTabs = async () => {}
  await restarted.initialize()
  expect(restarted.state().downloads.map(d => d.state)).toEqual(['interrupted', 'cancelled'])
  expect((restarted as any).downloadItems.size).toBe(0)
  await restarted.downloadAction(cancelledId, 'remove')
  expect(restarted.state().downloads).toHaveLength(1)
})
