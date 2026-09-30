import { app, autoUpdater as nativeAutoUpdater, dialog } from 'electron'
import { autoUpdater, CancellationToken, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { t } from './desktop-i18n'
import { isWindowsUpdaterLockError, pendingUpdateDirectories } from './updater-helpers'
import type { DesktopUpdateState } from './updater-types'
import { bindUpdateRequestCancellation } from './updater-cancellation'
import { readDesktopUpdateSource } from './updater-source'

let initialized = false
let checking = false
let downloadedUpdate: UpdateDownloadedEvent | null = null
let pendingRecovery: Promise<void> | null = null
let checkInProgress = false
let downloadPromptOpen = false
let installPromptOpen = false
let availableUpdate: UpdateInfo | null = null
interface DownloadTask {
  token: CancellationToken
  version: string
  info: UpdateDownloadedEvent | null
  error: Error | null
  nativeReady: Promise<void>
  finishNative: () => void
}
let activeDownload: DownloadTask | null = null
let updateState: DesktopUpdateState = {
  revision: 0, status: 'idle', version: '', percent: null,
  transferred: 0, total: 0, bytesPerSecond: 0,
}

const execFileAsync = promisify(execFile)

interface AutoUpdaterOptions {
  beforeQuitAndInstall?: () => void | Promise<void>
  onInstallFailure?: () => void | Promise<void>
  onStateChange?: (state: DesktopUpdateState) => void
  onShowProgress?: () => void
}

let options: AutoUpdaterOptions = {}

export function getDesktopUpdateState(): DesktopUpdateState {
  return { ...updateState }
}

function publishUpdateState(patch: Partial<Omit<DesktopUpdateState, 'revision'>>): void {
  updateState = { ...updateState, ...patch, revision: updateState.revision + 1 }
  // Renderer delivery must never abort a download, cancellation, or installation.
  try {
    options.onStateChange?.(getDesktopUpdateState())
  } catch (err) {
    console.warn('[updater] failed to publish update state:', err)
  }
}

function reportDownloadFailure(err: unknown): void {
  console.error('[updater] update download failed:', err)
  const wasInstalling = updateState.status === 'installing'
  autoUpdater.autoInstallOnAppQuit = false
  downloadedUpdate = null
  publishUpdateState({ status: 'error', bytesPerSecond: 0 })
  const notice = dialog.showMessageBox({
    type: 'error',
    title: t(wasInstalling ? 'update.installFailedTitle' : 'desktop.downloadFailed'),
    message: t(wasInstalling ? 'update.installFailedMessage' : 'update.downloadFailedMessage'),
    buttons: [t('common.ok')],
  }).catch(() => undefined)
  if (wasInstalling) {
    // Local services may already have stopped. Restore the app instead of
    // leaving an unusable window with a retry button backed by a dead server.
    void notice.then(() => options.onInstallFailure?.()).catch(recoveryError => {
      console.error('[updater] failed to restore app after installation failure:', recoveryError)
    })
  }
}

export function downloadDesktopUpdate(): DesktopUpdateState {
  if (!app.isPackaged || !availableUpdate) throw new Error('No desktop update is available to download')
  if (activeDownload || downloadedUpdate || updateState.status === 'installing') return getDesktopUpdateState()
  if (checkInProgress && !downloadPromptOpen) throw new Error('Please wait for the update check to finish')
  let finishNative!: () => void
  const nativeReady = new Promise<void>(resolve => { finishNative = resolve })
  const task: DownloadTask = {
    token: new CancellationToken(), version: availableUpdate.version,
    info: null, error: null, nativeReady, finishNative,
  }
  activeDownload = task
  // A cached update may finish after cancellation. Only an accepted completion
  // may re-enable installation on quit.
  autoUpdater.autoInstallOnAppQuit = false
  publishUpdateState({
    status: 'downloading', version: task.version, percent: null,
    transferred: 0, total: 0, bytesPerSecond: 0,
  })
  void (async () => {
    let releaseRequests: (() => void) | undefined
    try {
      if (pendingRecovery) await pendingRecovery
      if (task.token.cancelled) return
      releaseRequests = bindUpdateRequestCancellation(autoUpdater, task.token)
      await autoUpdater.downloadUpdate(task.token)
      if (task.token.cancelled) return
      if (task.error) throw task.error
      if (!task.info) throw new Error('Update download completed without an installable update')
      // On macOS, electron-updater's event only means the ZIP is ready for
      // Squirrel. Wait for Electron's native event (including signature checks)
      // before offering a restart or shutting down Studio's local services.
      if (process.platform === 'darwin') await task.nativeReady
      if (task.error) throw task.error
      downloadedUpdate = task.info
    } catch (err) {
      if (!task.token.cancelled) {
        autoUpdater.autoInstallOnAppQuit = false
        await recoverFailedPendingUpdate(err)
        reportDownloadFailure(err)
      }
    } finally {
      releaseRequests?.()
      if (activeDownload === task) {
        activeDownload = null
        if (task.token.cancelled) publishUpdateState({ status: 'cancelled', bytesPerSecond: 0 })
      }
    }
    if (downloadedUpdate && updateState.status === 'preparing') {
      publishUpdateState({ status: 'downloaded', percent: 100, bytesPerSecond: 0 })
      installDesktopUpdate().catch(err => {
        console.error('[updater] failed to install downloaded update:', err)
      })
    }
  })()
  return getDesktopUpdateState()
}

export function cancelDesktopUpdateDownload(): DesktopUpdateState {
  if (activeDownload && updateState.status === 'downloading') {
    autoUpdater.autoInstallOnAppQuit = false
    publishUpdateState({ status: 'cancelling', bytesPerSecond: 0 })
    activeDownload.token.cancel()
  }
  return getDesktopUpdateState()
}

function configureUpdateFeed(url: string): void {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url,
  })
}

async function checkForUpdatesWithFallback(): Promise<void> {
  const source = readDesktopUpdateSource(app.getAppPath())
  configureUpdateFeed(source.url)
  if (source.channel === 'test') {
    console.log(`[updater] using packaged test update feed: ${source.url}`)
    await autoUpdater.checkForUpdates()
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.warn(`[updater] Cloudflare update feed failed, trying GitHub: ${err instanceof Error ? err.message : String(err)}`)
    configureUpdateFeed(source.fallbackUrl)
    await autoUpdater.checkForUpdates()
  }
}

function showUpToDate(info?: UpdateInfo) {
  const version = info?.version || app.getVersion()
  dialog.showMessageBox({
    type: 'info',
    title: t('update.upToDateTitle'),
    message: t('update.upToDateMessage'),
    detail: t('update.currentVersion', { version }),
    buttons: [t('common.ok')],
  }).catch(() => undefined)
}

function showUpdateCheckFailed() {
  dialog.showMessageBox({
    type: 'error',
    title: t('update.failedTitle'),
    message: t('update.failedMessage'),
    buttons: [t('common.ok')],
  }).catch(() => undefined)
}

async function clearPendingUpdateDirectories(): Promise<void> {
  if (process.platform !== 'win32') return
  const dirs = pendingUpdateDirectories({
    appDataPath: app.getPath('appData'),
    localAppData: process.env.LOCALAPPDATA,
    appName: app.getName(),
  })
  await Promise.all(dirs.map(async dir => {
    try {
      await rm(dir, { recursive: true, force: true })
      console.warn(`[updater] cleared pending update directory: ${dir}`)
    } catch (err) {
      console.warn(`[updater] failed to clear pending update directory ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }))
}

function recoverFailedPendingUpdate(err: unknown): Promise<void> {
  if (pendingRecovery) return pendingRecovery
  if (process.platform !== 'win32' || !isWindowsUpdaterLockError(err)) return Promise.resolve()
  pendingRecovery = clearPendingUpdateDirectories().catch(cleanupErr => {
    console.warn('[updater] pending update recovery failed:', cleanupErr)
  }).finally(() => { pendingRecovery = null })
  return pendingRecovery
}

export async function stopOtherWindowsAppInstances(execPath = process.execPath, currentPid = process.pid): Promise<void> {
  if (process.platform !== 'win32') return
  const normalizedExecPath = execPath.trim()
  if (!normalizedExecPath) return
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$target = [System.IO.Path]::GetFullPath($env:HERMES_STUDIO_UPDATE_EXE)
$current = [int]$env:HERMES_STUDIO_UPDATE_PID
function Get-HermesStudioProcess {
  Get-CimInstance Win32_Process | Where-Object {
    try {
      $_.ProcessId -ne $current -and $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target)
    } catch {
      $false
    }
  }
}
Get-HermesStudioProcess | ForEach-Object {
  try {
    $process = Get-Process -Id $_.ProcessId
    if ($process) { $process.CloseMainWindow() | Out-Null }
  } catch {}
}
Start-Sleep -Milliseconds 750
Get-HermesStudioProcess | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force } catch {}
}
`.trim()
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: {
        ...process.env,
        HERMES_STUDIO_UPDATE_EXE: normalizedExecPath,
        HERMES_STUDIO_UPDATE_PID: String(currentPid),
      },
      timeout: 30_000,
      windowsHide: true,
    })
    console.log(`[updater] stopped other ${basename(normalizedExecPath)} instances before update install`)
  } catch (err) {
    console.warn(`[updater] failed to stop other app instances before update install: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function prepareQuitAndInstall(): Promise<void> {
  try {
    await options.beforeQuitAndInstall?.()
  } catch (err) {
    console.warn(`[updater] beforeQuitAndInstall hook failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  await stopOtherWindowsAppInstances()
}

async function quitAndInstallDownloadedUpdate(): Promise<void> {
  await prepareQuitAndInstall()
  if (!downloadedUpdate || updateState.status !== 'installing') return
  autoUpdater.quitAndInstall()
}

export async function installDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!downloadedUpdate || installPromptOpen || updateState.status === 'installing') return getDesktopUpdateState()
  installPromptOpen = true
  try {
    await promptInstallDownloadedUpdate(downloadedUpdate)
  } catch (err) {
    if (getDesktopUpdateState().status === 'installing') reportDownloadFailure(err)
    else if (downloadedUpdate) publishUpdateState({ status: 'downloaded' })
    throw err
  } finally {
    installPromptOpen = false
  }
  return getDesktopUpdateState()
}

async function promptInstallDownloadedUpdate(info: UpdateInfo): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: t('update.readyTitle'),
    message: t('update.readyMessage', { version: info.version }),
    detail: t('update.readyDetail'),
    buttons: [t('update.restartNow'), t('update.later')],
    defaultId: 0,
    cancelId: 1,
  })
  // Native preparation can fail while the confirmation dialog is still open.
  if (response === 0 && downloadedUpdate === info && updateState.status === 'downloaded') {
    publishUpdateState({ status: 'installing', bytesPerSecond: 0 })
    await quitAndInstallDownloadedUpdate()
  }
}

async function promptDownloadAvailableUpdate(info: UpdateInfo): Promise<void> {
  if (downloadPromptOpen || activeDownload || downloadedUpdate) return
  downloadPromptOpen = true
  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: t('update.availableTitle'),
      message: t('update.availableMessage', { version: info.version }),
      detail: t('update.availableDetail'),
      buttons: [t('update.download'), t('update.later')],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) downloadDesktopUpdate()
  } finally {
    downloadPromptOpen = false
  }
}

export function initAutoUpdater(nextOptions: AutoUpdaterOptions = {}) {
  options = { ...options, ...nextOptions }
  if (initialized) return
  initialized = true

  if (!app.isPackaged) return // dev mode: skip

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  if (process.platform === 'darwin') {
    nativeAutoUpdater.on('update-downloaded', () => {
      if (activeDownload?.info && !activeDownload.token.cancelled && !activeDownload.error) {
        activeDownload.finishNative()
      }
    })
  }

  autoUpdater.on('update-available', info => {
    console.log(`[updater] update available: ${info.version}`)
    availableUpdate = info
    promptDownloadAvailableUpdate(info).catch(err => {
      console.error('[updater] update download failed:', err)
      showUpdateCheckFailed()
    })
  })
  autoUpdater.on('update-not-available', info => {
    console.log('[updater] up to date')
    availableUpdate = null
    if (!activeDownload && !downloadedUpdate && updateState.status !== 'idle') {
      publishUpdateState({ status: 'idle', version: '', percent: null, transferred: 0, total: 0, bytesPerSecond: 0 })
    }
    if (checking) showUpToDate(info)
  })
  autoUpdater.on('error', err => {
    if (activeDownload?.token.cancelled) return
    console.error('[updater] error:', err)
    if (activeDownload) {
      autoUpdater.autoInstallOnAppQuit = false
      activeDownload.error = err
      activeDownload.finishNative()
      return
    }
    // Check/download promises report their final failure once, after fallback
    // or cancellation has been resolved. Native installation errors may arrive later.
    if (!checkInProgress && downloadedUpdate) {
      void recoverFailedPendingUpdate(err)
      reportDownloadFailure(err)
    }
  })
  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    if (!activeDownload || activeDownload.token.cancelled || updateState.status !== 'downloading') return
    console.log(`[updater] download ${Math.round(info.percent)}%`)
    const positive = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0
    const total = positive(info.total)
    publishUpdateState({
      percent: total > 0 && Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : null,
      transferred: positive(info.transferred), total, bytesPerSecond: positive(info.bytesPerSecond),
    })
  })
  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    if (!activeDownload || activeDownload.token.cancelled || activeDownload.error || info.version !== activeDownload.version) return
    activeDownload.info = info
    autoUpdater.autoInstallOnAppQuit = true
    publishUpdateState({ status: 'preparing', percent: 100, bytesPerSecond: 0 })
  })

  if (process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE !== 'false') {
    checkForDesktopUpdates(false).catch(err => {
      console.error('[updater] initial check failed:', err)
    })
  }
}

export async function checkForDesktopUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('update.checkingTitle'),
        message: t('update.packagedOnlyMessage'),
        buttons: [t('common.ok')],
      })
    }
    return
  }

  if (downloadedUpdate) {
    if (manual) await installDesktopUpdate()
    return
  }

  if (activeDownload) {
    if (manual) options.onShowProgress?.()
    return
  }
  if (checkInProgress || downloadPromptOpen) return

  checkInProgress = true
  try {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('update.checkingTitle'),
        message: t('update.checkingMessage'),
        buttons: [t('common.ok')],
      })
    }

    checking = manual
    await checkForUpdatesWithFallback()
  } catch (err) {
    if (manual) showUpdateCheckFailed()
    throw err
  } finally {
    checking = false
    checkInProgress = false
  }
}
