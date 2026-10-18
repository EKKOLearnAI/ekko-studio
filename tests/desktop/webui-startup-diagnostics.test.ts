import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebUiStartupDiagnostics } from '../../packages/desktop/src/main/webui-startup-diagnostics'
import { startWebUiServer } from '../../packages/desktop/src/main/webui-server'

vi.mock('../../packages/desktop/src/main/hermes-environment-selection', async importOriginal => {
  const original = await importOriginal<typeof import('../../packages/desktop/src/main/hermes-environment-selection')>()
  return {
    ...original,
    resolveDesktopHermesSelection: async () => ({ source: 'none', version: '', path: '' }),
  }
})

const tempDirectories: string[] = []

function tempDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'studio-startup-diagnostics-'))
  tempDirectories.push(root)
  return root
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of tempDirectories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop Web UI startup diagnostics', () => {
  it.each([
    ["require('__ekko_startup_missing_dependency__')", "Cannot find module '__ekko_startup_missing_dependency__'"],
    ["console.log('initializing stores'); throw new Error('SQLITE_BUSY: database is locked')", 'SQLITE_BUSY: database is locked'],
  ])('captures the actual startup failure from a child process: %s', async (source, expected) => {
    const root = tempDirectory()
    const webUiRoot = join(root, 'webui')
    const entryDirectory = join(webUiRoot, 'dist', 'server')
    const home = join(root, 'state')
    mkdirSync(entryDirectory, { recursive: true })
    writeFileSync(join(entryDirectory, 'index.js'), source)
    vi.stubEnv('HERMES_WEB_UI_DIR', webUiRoot)
    vi.stubEnv('HERMES_WEB_UI_HOME', home)
    vi.stubEnv('HERMES_HOME', join(root, 'hermes'))
    vi.stubEnv('HERMES_DESKTOP_RUNTIME_DIR', join(root, 'runtime'))
    vi.stubEnv('HERMES_DESKTOP_READY_TIMEOUT_MS', '1500')
    vi.stubEnv('SHELL', '/usr/bin/false')

    await expect(startWebUiServer(0)).rejects.toThrow(expected)

    const log = readFileSync(join(home, 'logs', 'desktop-startup.log'), 'utf8')
    expect(log).toContain('code=1 signal=null')
    expect(log).toContain(expected)
    expect(log).toContain(join(entryDirectory, 'index.js'))
    expect(log).toContain(`Node ${process.versions.node}`)
  })

  it('preserves a traceback split across UTF-8 chunks and the original error', () => {
    const logFile = join(tempDirectory(), 'startup.log')
    const diagnostics = new WebUiStartupDiagnostics(logFile, 'test runtime')
    const bytes = Buffer.from('Error: 数据库无法打开\n    at bootstrap (index.js:1:1)')
    const split = bytes.indexOf(Buffer.from('数')) + 1
    diagnostics.observeStderr(bytes.subarray(0, split))
    diagnostics.observeStderr(bytes.subarray(split))
    const original = new Error('exited code=1')

    const error = diagnostics.failure(original)

    expect(error.message).toContain(bytes.toString('utf8'))
    expect(error.message).toContain(logFile)
    expect(error.cause).toBe(original)
    expect(readFileSync(logFile, 'utf8')).toContain(bytes.toString('utf8'))
  })

  it('keeps stderr when stdout is noisy and bounds output and log history', () => {
    const logFile = join(tempDirectory(), 'startup.log')
    writeFileSync(logFile, 'old history'.repeat(10_000))
    const diagnostics = new WebUiStartupDiagnostics(logFile, 'current runtime')
    diagnostics.observeStderr(Buffer.from('Error: failed to load native module'))
    diagnostics.observeStdout(Buffer.from('x'.repeat(100_000) + '\nlast startup message'))

    const error = diagnostics.failure('exited code=1')

    expect(error.message).toContain('failed to load native module')
    expect(error.message).toContain('last startup message')
    expect(error.message.length).toBeLessThan(17_000)
    expect(readFileSync(logFile, 'utf8').length).toBeLessThanOrEqual(65_536)
  })

  it('preserves both active and bundled Web UI failures in the log', () => {
    const logFile = join(tempDirectory(), 'startup.log')
    const active = new WebUiStartupDiagnostics(logFile, 'active Web UI')
    active.observeStderr(Buffer.from('active dependency missing'))
    active.failure('active exited')
    const bundled = new WebUiStartupDiagnostics(logFile, 'bundled Web UI')
    bundled.observeStderr(Buffer.from('bundled database locked'))
    bundled.failure('bundled exited')

    const log = readFileSync(logFile, 'utf8')
    expect(log).toContain('active dependency missing')
    expect(log).toContain('bundled database locked')
  })

  it('reports the server error even when the startup log cannot be written', () => {
    const blockedDirectory = join(tempDirectory(), 'not-a-directory')
    writeFileSync(blockedDirectory, '')
    const diagnostics = new WebUiStartupDiagnostics(join(blockedDirectory, 'startup.log'), 'test runtime')
    diagnostics.observeStderr(Buffer.from('Error: startup failed'))

    expect(diagnostics.failure('exited code=1').message).toContain('Error: startup failed')
  })
})
