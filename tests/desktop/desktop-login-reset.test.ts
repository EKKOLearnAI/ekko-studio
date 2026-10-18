import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop login reset', () => {
  it('exposes login reset from the tray and restarts only the local Web UI service', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(source).toContain("t('tray.resetLogin')")
    expect(source).toContain('async function handleResetDefaultLogin()')
    expect(source).toContain('await stopWebUiServer()')
    expect(source).toContain('await resetDesktopDefaultLogin()')
    expect(source).toContain('await startWebUiServer(PORT)')
  })

  it('refreshes the tray menu once the Web UI server is ready', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(source).toContain('serverUrl = url\n    updateTrayMenu()')
    expect(source).toContain('enabled: !isResettingLogin && !activeRemoteServerUrl && (!isBootstrapping || !!serverUrl)')
  })

  it('keeps login reset local-only by disabling it in remote-server mode', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(source).toContain('if (isResettingLogin || activeRemoteServerUrl || (isBootstrapping && !serverUrl)) return')
  })

  it('loads the authenticated desktop route instead of the login route on startup', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(source).toContain("return webUiHashUrl('/hermes/chat')")
    expect(source).toContain('mainWindow.loadURL(mainRouteUrl() || serverUrl)')
    expect(source).toContain('if (mainWindow) await mainWindow.loadURL(mainRouteUrl() || url)')
  })

  it('resets the default credentials and clears login locks through the Web UI CLI', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/desktop-login-reset.ts'), 'utf-8')

    expect(source).toContain("runWebUiCliCommand('reset-default-login')")
    expect(source).toContain("runWebUiCliCommand('clear-login-locks')")
    expect(source).toContain("DEFAULT_USERNAME = 'admin'")
    expect(source).toContain("DEFAULT_PASSWORD = '123456'")
  })
})
