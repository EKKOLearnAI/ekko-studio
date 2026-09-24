import { app, dialog } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { t } from './desktop-i18n'
import { isWindowsUpdaterLockError, pendingUpdateDirectories } from './updater-helpers'

let initialized = false
let checking = false
let downloadedUpdate: UpdateDownloadedEvent | null = null
let tryingFallbackFeed = false
let recoveringPendingUpdate = false

const CLOUDFLARE_LATEST_FEED_URL = 'https://download.ekkolearnai.com/latest'
const GITHUB_LATEST_FEED_URL = 'https://github.com/EKKOLearnAI/ekko-studio/releases/latest/download'
const execFileAsync = promisify(execFile)

interface AutoUpdaterOptions {
  beforeQuitAndInstall?: () => void | Promise<void>
}

let options: AutoUpdaterOptions = {}

function configureUpdateFeed(url: string): void {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url,
  })
}

async function checkForUpdatesWithFallback(): Promise<void> {
  configureUpdateFeed(CLOUDFLARE_LATEST_FEED_URL)
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.warn(`[updater] Cloudflare update feed failed, trying GitHub: ${err instanceof Error ? err.message : String(err)}`)
    tryingFallbackFeed = true
    try {
      configureUpdateFeed(GITHUB_LATEST_FEED_URL)
      await autoUpdater.checkForUpdates()
    } finally {
      tryingFallbackFeed = false
    }
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

async function recoverFailedPendingUpdate(err: unknown): Promise<void> {
  if (recoveringPendingUpdate || process.platform !== 'win32' || !isWindowsUpdaterLockError(err)) return
  recoveringPendingUpdate = true
  try {
    await clearPendingUpdateDirectories()
    downloadedUpdate = null
  } finally {
    recoveringPendingUpdate = false
  }
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
  autoUpdater.quitAndInstall()
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
  if (response === 0) {
    await quitAndInstallDownloadedUpdate()
  }
}

async function promptDownloadAvailableUpdate(info: UpdateInfo): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: t('update.availableTitle'),
    message: t('update.availableMessage', { version: info.version }),
    detail: t('update.availableDetail'),
    buttons: [t('update.download'), t('update.later')],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    await autoUpdater.downloadUpdate()
  }
}

export function initAutoUpdater(nextOptions: AutoUpdaterOptions = {}) {
  options = { ...options, ...nextOptions }
  if (initialized) return
  initialized = true

  if (!app.isPackaged) return // dev mode: skip

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', info => {
    console.log(`[updater] update available: ${info.version}`)
    promptDownloadAvailableUpdate(info).catch(err => {
      console.error('[updater] update download failed:', err)
      showUpdateCheckFailed()
    })
  })
  autoUpdater.on('update-not-available', info => {
    console.log('[updater] up to date')
    if (checking) showUpToDate(info)
  })
  autoUpdater.on('error', err => {
    console.error('[updater] error:', err)
    recoverFailedPendingUpdate(err).catch(cleanupErr => {
      console.warn(`[updater] pending update recovery failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
    })
    if (checking && !tryingFallbackFeed) showUpdateCheckFailed()
  })
  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    console.log(`[updater] download ${Math.round(info.percent)}%`)
  })
  autoUpdater.on('update-downloaded', async (info: UpdateDownloadedEvent) => {
    downloadedUpdate = info
    await promptInstallDownloadedUpdate(info)
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
    if (manual) await promptInstallDownloadedUpdate(downloadedUpdate)
    return
  }

  if (manual) {
    await dialog.showMessageBox({
      type: 'info',
      title: t('update.checkingTitle'),
      message: t('update.checkingMessage'),
      buttons: [t('common.ok')],
    })
  }

  checking = manual
  try {
    await checkForUpdatesWithFallback()
  } catch (err) {
    if (manual) showUpdateCheckFailed()
    throw err
  } finally {
    checking = false
  }
}
