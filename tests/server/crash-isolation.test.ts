import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Studio crash isolation wiring', () => {
  it('uses guarded URL parsing in every raw WebSocket upgrade handler', () => {
    const files = [
      'packages/server/src/bootstrap/http.ts',
      'packages/server/src/modules/hermes/sockets/terminal.ts',
      'packages/server/src/modules/hermes/sockets/kanban-events.ts',
    ]

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toContain('parseUpgradeRequestUrl(req)')
      expect(source, file).not.toContain("new URL(req.url || '', `http://${req.headers.host}`)")
    }
  })

  it('reports the HTTP shell ready without waiting for late bootstrap services', () => {
    const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')
    const listen = bootstrap.indexOf('await listenWithFallback(')
    const ready = bootstrap.indexOf('bootstrapReady = true', listen)
    const recovery = bootstrap.indexOf('recoverActiveRuns()', ready)
    const versionCheck = bootstrap.indexOf('startVersionCheck()', recovery)

    expect(listen).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(listen)
    expect(recovery).toBeGreaterThan(ready)
    expect(versionCheck).toBeGreaterThan(recovery)
  })

  it('reuses the Desktop-locked Hermes status during bootstrap', () => {
    const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')

    expect(bootstrap).toContain('readLockedDesktopHermesSelection()')
    expect(bootstrap).toContain('recordLockedHermesSelection(hermesSelection)')
    expect(bootstrap).toContain('...(!lockedDesktopSelection ? [getRuntimeVersionStatus({ includeRemote: false })] : [])')
  })

  it('makes Desktop poll readiness and recover one unexpected server exit', () => {
    const server = readFileSync('packages/desktop/src/main/webui-server.ts', 'utf8')
    const desktop = readFileSync('packages/desktop/src/main/index.ts', 'utf8')

    expect(server).toContain('/health/ready')
    expect(server).toContain('setWebUiUnexpectedExitHandler')
    expect(desktop).toContain('recoverUnexpectedWebUiExit')
    expect(desktop).toContain('unexpectedWebUiExitCount > 1')
  })

  it('keeps logger initialization and client mounting on explicit fallback paths', () => {
    const logging = readFileSync('packages/server/src/modules/studio/public/logging.ts', 'utf8')
    const client = readFileSync('packages/client/src/main.ts', 'utf8')

    expect(logging).toContain('falling back to stderr')
    expect(logging).toContain("pino.destination({ dest: 2, sync: true })")
    expect(client).toContain('app.config.errorHandler')
    expect(client).toContain('mountApp().catch')

    const runtimeErrorHandler = client.slice(
      client.indexOf('app.config.errorHandler'),
      client.indexOf('app.use(createPinia())'),
    )
    const mountFailureHandler = client.slice(client.indexOf('mountApp().catch'))
    expect(runtimeErrorHandler).not.toContain('renderFatalError')
    expect(mountFailureHandler).toContain('renderFatalError(error)')
  })
})
