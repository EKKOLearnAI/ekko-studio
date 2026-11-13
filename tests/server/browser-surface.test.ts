import { describe, expect, it, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  BROWSER_SURFACE_DEFAULT_MODE,
  BROWSER_SURFACE_ENV,
  BROWSER_SURFACE_THRESHOLDS,
  browserSurfaceGateReport,
  browserSurfaceMode,
  evaluateBrowserSurfaceGate,
  initializeBrowserSurfaceGate,
  isBrowserSurfaceEnabled,
  resetBrowserSurfaceGateForTests,
  type BrowserSurfaceProbe,
} from '../../packages/server/src/modules/studio/public/browser-surface'

const GIB = 1024 ** 3

type Env = Record<string, string | undefined>

function passingProbe(overrides: Partial<BrowserSurfaceProbe> = {}): BrowserSurfaceProbe {
  return {
    readMemTotalBytes: () => 4 * GIB,
    readMemAvailableBytes: () => 2 * GIB,
    readFreeDiskBytes: () => 20 * GIB,
    resolveBrowserExecutable: () => '/usr/bin/chromium',
    ...overrides,
  }
}

function evaluate(env: Env, probe: BrowserSurfaceProbe = passingProbe()) {
  return evaluateBrowserSurfaceGate({ env, probe, webUiHome: '/tmp/hermes-web-ui-home' })
}

describe('browser surface gate', () => {
  beforeEach(() => {
    resetBrowserSurfaceGateForTests()
    delete process.env[BROWSER_SURFACE_ENV]
    delete process.env.HERMES_DESKTOP
  })

  it('defaults to local when unset and every threshold passes', () => {
    const report = evaluate({})

    expect(BROWSER_SURFACE_DEFAULT_MODE).toBe('local')
    expect(report.mode).toBe('local')
    expect(report.enabled).toBe(true)
    expect(report.requestedSource).toBe('default')
    expect(report.failedChecks).toEqual([])
    expect(report.reasons).toEqual([])
    expect(report.executablePath).toBe('/usr/bin/chromium')
    expect(report.executableVersion).toBeNull()
  })

  it('records the resolved browser version when the probe reports one', () => {
    const report = evaluate({}, passingProbe({
      resolveBrowserExecutableVersion: () => '154.0.8037.92',
    }))

    expect(report.executableVersion).toBe('154.0.8037.92')
  })

  it.each([
    ['mem_total', { readMemTotalBytes: () => 2 * GIB }],
    ['mem_available', { readMemAvailableBytes: () => 0.5 * GIB }],
    ['free_disk', { readFreeDiskBytes: () => 512 * 1024 ** 2 }],
    ['browser_executable', { resolveBrowserExecutable: () => null }],
  ])('turns the surface off and names %s when that threshold fails', (id, override) => {
    const report = evaluate({}, passingProbe(override as Partial<BrowserSurfaceProbe>))

    expect(report.mode).toBe('off')
    expect(report.enabled).toBe(false)
    expect(report.failedChecks).toEqual([id])
    expect(report.reasons.join('\n')).toContain(id)
  })

  it('treats an unreadable threshold as a failure instead of half-enabling', () => {
    const report = evaluate({}, passingProbe({
      readMemTotalBytes: () => null,
      readFreeDiskBytes: () => null,
    }))

    expect(report.mode).toBe('off')
    expect(report.failedChecks).toEqual(['mem_total', 'free_disk'])
    expect(report.checks.find(check => check.id === 'mem_total')?.actual).toBe('unavailable')
  })

  it('keeps exact threshold boundaries enabled', () => {
    const report = evaluate({}, passingProbe({
      readMemTotalBytes: () => BROWSER_SURFACE_THRESHOLDS.memTotalBytes,
      readMemAvailableBytes: () => BROWSER_SURFACE_THRESHOLDS.memAvailableBytes,
      readFreeDiskBytes: () => BROWSER_SURFACE_THRESHOLDS.freeDiskBytes,
    }))

    expect(report.mode).toBe('local')
  })

  it.each([
    ['off', 'off'],
    ['OFF', 'off'],
    [' off ', 'off'],
    ['local', 'local'],
    ['LOCAL', 'local'],
    ['Local', 'local'],
  ])('parses %s as %s', (value, expected) => {
    expect(evaluate({ [BROWSER_SURFACE_ENV]: value }).mode).toBe(expected)
  })

  it.each(['yes', '1', 'on', '', 'auto', 'true'])(
    'refuses the invalid value %s and never downgrades to local',
    (value) => {
      const report = evaluate({ [BROWSER_SURFACE_ENV]: value })

      expect(report.mode).toBe('off')
      expect(report.requestedSource).toBe('invalid')
      expect(report.reasons.join('\n')).toContain('invalid')
    },
  )

  it('forces off under HERMES_DESKTOP even when the env asks for local', () => {
    const report = evaluate({ HERMES_DESKTOP: 'true', [BROWSER_SURFACE_ENV]: 'local' })

    expect(report.mode).toBe('off')
    expect(report.requestedSource).toBe('desktop')
    expect(report.reasons.join('\n')).toContain('HERMES_DESKTOP')
  })

  it('does not run thresholds when the request is already off', () => {
    const probe = passingProbe({
      readMemTotalBytes: () => {
        throw new Error('must not be probed')
      },
    })

    expect(evaluate({ [BROWSER_SURFACE_ENV]: 'off' }, probe).mode).toBe('off')
  })

  it('logs a warning naming the failed gate when the surface stays off', () => {
    const warn = vi.fn()

    const report = initializeBrowserSurfaceGate({
      env: { [BROWSER_SURFACE_ENV]: 'local' },
      probe: passingProbe({ readMemAvailableBytes: () => 256 * 1024 ** 2 }),
      webUiHome: '/tmp/hermes-web-ui-home',
      warn,
      info: vi.fn(),
    })

    expect(report.mode).toBe('off')
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join('\n')).toContain('mem_available')
    expect(warn.mock.calls.flat().join('\n')).toContain('MemAvailable')
  })

  it('freezes the decision: later env changes do not move it', () => {
    const first = initializeBrowserSurfaceGate({
      env: {},
      probe: passingProbe(),
      webUiHome: '/tmp/hermes-web-ui-home',
      warn: vi.fn(),
      info: vi.fn(),
    })

    expect(first.mode).toBe('local')

    process.env[BROWSER_SURFACE_ENV] = 'off'
    process.env.HERMES_DESKTOP = 'true'

    expect(browserSurfaceMode()).toBe('local')
    expect(isBrowserSurfaceEnabled()).toBe(true)
    expect(browserSurfaceGateReport()).toBe(first)
    expect(initializeBrowserSurfaceGate()).toBe(first)
  })

  it('reads the environment once at initialize time', () => {
    process.env[BROWSER_SURFACE_ENV] = 'off'

    const report = initializeBrowserSurfaceGate({
      probe: passingProbe(),
      webUiHome: '/tmp/hermes-web-ui-home',
      warn: vi.fn(),
      info: vi.fn(),
    })

    expect(report.mode).toBe('off')
    expect(report.requestedSource).toBe('env')

    process.env[BROWSER_SURFACE_ENV] = 'local'
    expect(browserSurfaceMode()).toBe('off')
  })

  it('evaluates lazily when the accessors are used before startup ran the gate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      const report = browserSurfaceGateReport()

      expect(report.evaluatedAt).toBeTruthy()
      expect(report.webUiHome).toBeTruthy()
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  it('startup evaluates the gate exactly once, before routes are registered', () => {
    const source = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')

    expect(source).toContain('initializeBrowserSurfaceGate(')
    // The gate module is the only reader of the env var in the startup path.
    expect(source).not.toContain(`process.env.${BROWSER_SURFACE_ENV}`)
    expect(source.indexOf('initializeBrowserSurfaceGate('))
      .toBeLessThan(source.indexOf('registerRoutes(app'))
  })

  it('device provisioning scripts and manifests never enable the surface', () => {
    for (const file of [
      'scripts/deploy-source-armbian.sh',
      'scripts/build-device-package.mjs',
      '.github/device-package-release.json',
    ]) {
      if (!existsSync(file)) continue
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/HERMES_BROWSER_SURFACE\s*[=:]\s*["']?local/i)
    }
  })
})
