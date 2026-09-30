import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWindowsUpdaterLockError, pendingUpdateDirectories } from '../../packages/desktop/src/main/updater-helpers'

describe('desktop updater helpers', () => {
  it('detects Squirrel locked-exe update failures', async () => {
    expect(isWindowsUpdaterLockError(new Error('Failed to uninstall old application files. Please try running the installer again.: 2'))).toBe(true)
    expect(isWindowsUpdaterLockError(new Error('Squirrel update failed with code 2'))).toBe(true)
    expect(isWindowsUpdaterLockError(new Error('network timeout'))).toBe(false)
  })

  it('includes local and roaming pending update cache directories', async () => {
    const local = 'C:\\Users\\A\\AppData\\Local'
    const roaming = 'C:\\Users\\A\\AppData\\Roaming'
    expect(pendingUpdateDirectories({
      appDataPath: roaming,
      localAppData: local,
      appName: 'Ekko Studio',
    })).toEqual(expect.arrayContaining([
      join(local, 'Ekko Studio-updater', 'pending'),
      join(local, 'ekko-studio-updater', 'pending'),
      join(local, 'Hermes Studio-updater', 'pending'),
      join(local, 'hermes-studio-updater', 'pending'),
      join(roaming, 'hermes-studio-updater', 'pending'),
    ]))
  })

  it('checks on startup and from the tray without forcing an update', () => {
    const updaterSource = readFileSync(resolve('packages/desktop/src/main/updater.ts'), 'utf-8')
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(mainSource).toContain('checkForDesktopUpdates(true)')
    expect(updaterSource).toContain('checkForDesktopUpdates(false)')
    expect(updaterSource).toContain('autoUpdater.autoDownload = false')
    expect(updaterSource).toContain('autoUpdater.autoInstallOnAppQuit = true')
    expect(updaterSource).toContain("buttons: [t('update.download'), t('update.later')]")
    expect(updaterSource).toContain('if (response === 0) downloadDesktopUpdate()')
    expect(updaterSource).not.toContain('setInterval(')
  })

  it('gracefully stops the current app before starting a downloaded update', () => {
    const updaterSource = readFileSync(resolve('packages/desktop/src/main/updater.ts'), 'utf-8')
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(mainSource).toContain('async function prepareAppShutdown(): Promise<void>')
    expect(mainSource).toContain('await stopWebUiServer().catch(() => undefined)')
    expect(mainSource).toContain('beforeQuitAndInstall: prepareAppShutdown,')
    expect(mainSource).toContain('try {\n      await prepareAppShutdown()\n    } finally {\n      appLifecycle.finalizeExit(0)')

    const prepareCurrentInstance = updaterSource.indexOf('await options.beforeQuitAndInstall?.()')
    const stopOtherInstances = updaterSource.indexOf('await stopOtherWindowsAppInstances()', prepareCurrentInstance)
    const startInstaller = updaterSource.indexOf('autoUpdater.quitAndInstall()', stopOtherInstances)
    expect(prepareCurrentInstance).toBeGreaterThan(-1)
    expect(stopOtherInstances).toBeGreaterThan(prepareCurrentInstance)
    expect(startInstaller).toBeGreaterThan(stopOtherInstances)
  })
})
