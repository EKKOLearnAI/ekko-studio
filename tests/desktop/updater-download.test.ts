import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dialog: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn(), feed: vi.fn(),
  publish: vi.fn(), show: vi.fn(), beforeInstall: vi.fn(), restore: vi.fn(),
}))
vi.mock('electron', async () => ({
  app: { isPackaged: true, getAppPath: () => process.cwd(), getLocale: () => 'en', getVersion: () => '1.0.0' },
  autoUpdater: new (await import('node:events')).EventEmitter(),
  dialog: { showMessageBox: mocks.dialog },
}))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    autoUpdater: Object.assign(new EventEmitter(), {
      checkForUpdates: mocks.check, downloadUpdate: mocks.download,
      quitAndInstall: mocks.install, setFeedURL: mocks.feed, autoInstallOnAppQuit: true,
      httpExecutor: { createRequest: vi.fn() },
    }),
    CancellationToken: class extends EventEmitter {
      cancelled = false
      cancel() { this.cancelled = true; this.emit('cancel') }
      onCancel(listener: () => void) { this.once('cancel', listener) }
    },
  }
})

const info = { version: '1.1.0', files: [], releaseDate: '2026-09-25' }
const platform = process.platform
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('desktop update downloads', () => {
  let updater: typeof import('../../packages/desktop/src/main/updater')
  let events: EventEmitter & { autoInstallOnAppQuit: boolean }
  let nativeEvents: EventEmitter
  let resolveDownload: (value: string[]) => void
  let rejectDownload: (error: Error) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.stubEnv('HERMES_DESKTOP_ENABLE_AUTO_UPDATE', 'false')
    mocks.dialog.mockResolvedValue({ response: 1 })
    mocks.check.mockResolvedValue(null)
    mocks.download.mockImplementation(() => new Promise<string[]>((resolve, reject) => {
      resolveDownload = resolve
      rejectDownload = reject
    }))
    await initialize('linux')
  })

  async function initialize(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: platform })
    vi.resetModules()
    updater = await import('../../packages/desktop/src/main/updater')
    events = (await import('electron-updater')).autoUpdater
    nativeEvents = (await import('electron')).autoUpdater
    events.removeAllListeners()
    nativeEvents.removeAllListeners()
    updater.initAutoUpdater({ onStateChange: mocks.publish, onShowProgress: mocks.show, beforeQuitAndInstall: mocks.beforeInstall, onInstallFailure: mocks.restore })
  }

  afterEach(async () => {
    updater.cancelDesktopUpdateDownload()
    resolveDownload?.([])
    nativeEvents.emit('update-downloaded')
    await flush()
    events?.removeAllListeners()
    nativeEvents.removeAllListeners()
    vi.unstubAllEnvs()
    Object.defineProperty(process, 'platform', { value: platform })
  })

  async function start() {
    mocks.dialog.mockResolvedValueOnce({ response: 0 })
    events.emit('update-available', info)
    await flush()
  }

  it('starts with unknown progress and publishes actual bytes, speed and a monotonic revision', async () => {
    await start()
    const initial = updater.getDesktopUpdateState()
    expect(initial).toMatchObject({ status: 'downloading', version: '1.1.0', percent: null, bytesPerSecond: 0 })
    expect(mocks.download.mock.calls[0][0]).toHaveProperty('cancelled', false)
    events.emit('download-progress', { percent: 42.7, transferred: 427, total: 1000, bytesPerSecond: 3200000 })
    expect(updater.getDesktopUpdateState()).toMatchObject({ percent: 42.7, transferred: 427, total: 1000, bytesPerSecond: 3200000 })
    expect(updater.getDesktopUpdateState().revision).toBeGreaterThan(initial.revision)
    initial.version = 'bad'
    expect(updater.getDesktopUpdateState().version).toBe('1.1.0')
    events.emit('download-progress', { percent: NaN, transferred: 5, total: 0, bytesPerSecond: -1 })
    expect(updater.getDesktopUpdateState()).toMatchObject({ percent: null, bytesPerSecond: 0 })
  })

  it('does not download when the user chooses Later', async () => {
    events.emit('update-available', info)
    await flush()
    expect(mocks.download).not.toHaveBeenCalled()
    expect(updater.getDesktopUpdateState().status).toBe('idle')
  })

  it('waits for cancellation to settle before allowing a retry, ignoring late completion and progress', async () => {
    await start()
    const token = mocks.download.mock.calls[0][0]
    expect(updater.cancelDesktopUpdateDownload().status).toBe('cancelling')
    expect(token.cancelled).toBe(true)
    expect(events.autoInstallOnAppQuit).toBe(false)
    updater.downloadDesktopUpdate()
    expect(mocks.download).toHaveBeenCalledTimes(1)
    events.emit('download-progress', { percent: 100, transferred: 100, total: 100, bytesPerSecond: 10 })
    events.emit('update-downloaded', info)
    expect(updater.getDesktopUpdateState().status).toBe('cancelling')
    expect(events.autoInstallOnAppQuit).toBe(false)
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
    rejectDownload(new Error('cancelled'))
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('cancelled')
    expect(mocks.dialog).toHaveBeenCalledTimes(1)

    expect(updater.downloadDesktopUpdate().status).toBe('downloading')
    expect(mocks.download).toHaveBeenCalledTimes(2)
    expect(mocks.download.mock.calls[1][0]).not.toBe(token)
    expect(mocks.download.mock.calls[1][0].cancelled).toBe(false)
  })

  it('keeps a cancelled cached download from installing on quit even if its promise succeeds', async () => {
    await start()
    updater.cancelDesktopUpdateDownload()
    events.emit('update-downloaded', info)
    resolveDownload(['cached.zip'])
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('cancelled')
    expect(events.autoInstallOnAppQuit).toBe(false)
    await updater.installDesktopUpdate()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
  })

  it('offers installation for cached downloads and defers restart until explicitly confirmed', async () => {
    await start()
    events.emit('update-downloaded', info)
    resolveDownload(['cached.zip'])
    await flush()
    expect(updater.getDesktopUpdateState()).toMatchObject({ status: 'downloaded', percent: 100, bytesPerSecond: 0 })
    expect(events.autoInstallOnAppQuit).toBe(true)
    expect(mocks.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ buttons: ['Restart now', 'Later'] }))
    expect(mocks.install).not.toHaveBeenCalled()
    expect(updater.cancelDesktopUpdateDownload().status).toBe('downloaded')
    mocks.dialog.mockResolvedValueOnce({ response: 0 })
    await updater.installDesktopUpdate()
    expect(mocks.beforeInstall).toHaveBeenCalledTimes(1)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(updater.getDesktopUpdateState().status).toBe('installing')
  })

  it('deduplicates download requests and tray checks during the download', async () => {
    await start()
    updater.downloadDesktopUpdate()
    events.emit('update-available', info)
    await updater.checkForDesktopUpdates(true)
    await updater.checkForDesktopUpdates(false)
    expect(mocks.show).toHaveBeenCalledTimes(1)
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.download).toHaveBeenCalledTimes(1)
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
  })

  it('does not install from an outdated confirmation after native preparation fails', async () => {
    await start()
    let confirm: (answer: { response: number }) => void
    mocks.dialog.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve }))
    events.emit('update-downloaded', info)
    resolveDownload(['cached.zip'])
    await flush()
    events.emit('error', new Error('native update preparation failed'))
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('error')
    confirm!({ response: 0 })
    await flush()
    expect(mocks.beforeInstall).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(events.autoInstallOnAppQuit).toBe(false)
  })

  it('reports one failure for an error event plus rejection and allows retry', async () => {
    await start()
    const error = new Error('network timeout')
    events.emit('error', error)
    rejectDownload(error)
    await flush()
    expect(updater.getDesktopUpdateState()).toMatchObject({ status: 'error', bytesPerSecond: 0 })
    expect(mocks.dialog).toHaveBeenCalledTimes(2)
    expect(mocks.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Download failed' }))
    updater.downloadDesktopUpdate()
    expect(mocks.download).toHaveBeenCalledTimes(2)
  })

  it('does not show a failed-check dialog when the fallback feed succeeds', async () => {
    mocks.check.mockImplementationOnce(async () => {
      const error = new Error('feed offline')
      events.emit('error', error)
      throw error
    })
    await updater.checkForDesktopUpdates(true)
    expect(mocks.check).toHaveBeenCalledTimes(2)
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: 'Checking for updates...' }))
  })

  it('waits for both the download promise and macOS native readiness before offering installation', async () => {
    await initialize('darwin')
    await start()
    events.emit('update-downloaded', info)
    resolveDownload(['cached.zip'])
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('preparing')
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
    expect(updater.cancelDesktopUpdateDownload().status).toBe('preparing')
    updater.downloadDesktopUpdate()
    await updater.installDesktopUpdate()
    await updater.checkForDesktopUpdates(true)
    expect(mocks.download).toHaveBeenCalledTimes(1)
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.beforeInstall).not.toHaveBeenCalled()
    nativeEvents.emit('update-downloaded')
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('downloaded')
    expect(mocks.dialog).toHaveBeenCalledTimes(2)
  })

  it('handles macOS readiness arriving before the download promise settles', async () => {
    await initialize('darwin')
    await start()
    events.emit('update-downloaded', info)
    nativeEvents.emit('update-downloaded')
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('preparing')
    resolveDownload(['cached.zip'])
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('downloaded')
  })

  it('rejects late macOS verification errors even after the HTTP download has succeeded', async () => {
    await initialize('darwin')
    await start()
    events.emit('update-downloaded', info)
    resolveDownload(['cached.zip'])
    await flush()
    events.emit('error', new Error('Invalid code signature'))
    await flush()
    nativeEvents.emit('update-downloaded')
    expect(updater.getDesktopUpdateState().status).toBe('error')
    expect(events.autoInstallOnAppQuit).toBe(false)
    expect(mocks.dialog).not.toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Restart now', 'Later'] }))
    expect(mocks.beforeInstall).not.toHaveBeenCalled()
    updater.downloadDesktopUpdate()
    expect(mocks.download).toHaveBeenCalledTimes(2)
  })

  it('rejects errors between the completed event and download promise settlement', async () => {
    await start()
    events.emit('update-downloaded', info)
    events.emit('error', new Error('finalization failed'))
    resolveDownload(['cached.zip'])
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('error')
    expect(mocks.dialog).not.toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Restart now', 'Later'] }))
  })

  it('does not let a destroyed renderer prevent starting or cancelling a download', async () => {
    mocks.publish.mockImplementation(() => { throw new Error('Render frame disposed') })
    await start()
    expect(mocks.download).toHaveBeenCalledTimes(1)
    updater.cancelDesktopUpdateDownload()
    expect(mocks.download.mock.calls[0][0].cancelled).toBe(true)
    rejectDownload(new Error('cancelled'))
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('cancelled')
  })

  it('does not leave a successful but unusable download stuck forever', async () => {
    await start()
    resolveDownload([])
    await flush()
    expect(updater.getDesktopUpdateState().status).toBe('error')
  })

  it.each(['throw', 'event'])('restores the app after installer startup fails via %s', async kind => {
    await start()
    events.emit('update-downloaded', info)
    resolveDownload(['cached.zip'])
    await flush()
    mocks.install.mockImplementationOnce(() => {
      const error = new Error('installer could not start')
      if (kind === 'throw') throw error
      events.emit('error', error)
    })
    mocks.dialog.mockResolvedValueOnce({ response: 0 })
    await updater.installDesktopUpdate().catch(() => undefined)
    await flush()
    expect(mocks.beforeInstall).toHaveBeenCalledTimes(1)
    expect(mocks.restore).toHaveBeenCalledTimes(1)
    expect(events.autoInstallOnAppQuit).toBe(false)
    expect(updater.getDesktopUpdateState().status).toBe('error')
    expect(mocks.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Update installation failed' }))
  })

  it('does not launch an invalidated installer after asynchronous shutdown completes', async () => {
    await start()
    events.emit('update-downloaded', info)
    resolveDownload(['cached.zip'])
    await flush()
    let finishShutdown: () => void
    mocks.beforeInstall.mockImplementationOnce(() => new Promise<void>(resolve => { finishShutdown = resolve }))
    mocks.dialog.mockResolvedValueOnce({ response: 0 })
    const installing = updater.installDesktopUpdate()
    await flush()
    events.emit('error', new Error('installer file removed'))
    finishShutdown!()
    await installing
    await flush()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.restore).toHaveBeenCalledTimes(1)
  })

  it('blocks a retry while the update feed is being refreshed', async () => {
    await start()
    updater.cancelDesktopUpdateDownload()
    rejectDownload(new Error('cancelled'))
    await flush()
    let finishCheck: () => void
    mocks.check.mockImplementationOnce(() => new Promise<void>(resolve => { finishCheck = resolve }))
    const checking = updater.checkForDesktopUpdates(false)
    expect(() => updater.downloadDesktopUpdate()).toThrow('wait for the update check')
    events.emit('update-not-available', info)
    finishCheck!()
    await checking
    expect(updater.getDesktopUpdateState().status).toBe('idle')
    expect(() => updater.downloadDesktopUpdate()).toThrow('No desktop update')
  })
})
