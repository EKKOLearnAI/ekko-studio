import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  isBrowserSurfaceEnabled,
  initializeBrowserSurfaceGate,
  resetBrowserSurfaceGateForTests,
} from '../../packages/server/src/modules/studio/public/browser-surface'
import {
  HeadlessRuntime,
  buildBrowserLaunchArgs,
  resolveBrowserProfileDir,
  stopHeadlessBrowserRuntime,
  type BrowserRuntimeDependencies,
} from '../../packages/server/src/modules/studio/services/browser/runtime'
import type { ResolvedBrowserExecutable } from '../../packages/server/src/modules/studio/services/browser/types'

interface SpawnCall {
  command: string
  args: string[]
  options: Record<string, unknown>
}

class FakeChild extends EventEmitter {
  static instances: FakeChild[] = []

  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: string[] = []
  readonly stdio: unknown[]
  readonly stderr = new PassThrough()
  ignoreSigterm = false

  constructor() {
    super()
    FakeChild.instances.push(this)
    this.stdio = [null, null, this.stderr, new PassThrough(), new PassThrough()]
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGKILL' || !this.ignoreSigterm) this.exit(null, signal)
    return true
  }

  exit(code: number | null = null, signal: NodeJS.Signals | null = 'SIGTERM'): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-runtime-'))
  tempDirs.push(dir)
  return dir
}

function fakeExecutable(path = '/usr/bin/chromium'): ResolvedBrowserExecutable {
  return { path, source: 'system', version: '154.0.8037.92', launcher: true }
}

function createHarness(overrides: Partial<BrowserRuntimeDependencies> = {}) {
  const calls: SpawnCall[] = []
  const deps: BrowserRuntimeDependencies = {
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args: [...args], options })
      return new FakeChild() as unknown as ChildProcess
    }) as unknown as BrowserRuntimeDependencies['spawn'],
    resolveExecutable: () => fakeExecutable(),
    uid: () => 1000,
    platform: 'linux',
    wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    env: {},
    surfaceEnabled: () => true,
    ...overrides,
  }
  return { deps, calls }
}

function runtimeFor(
  deps: BrowserRuntimeDependencies,
  options: Record<string, unknown> = {},
) {
  return new HeadlessRuntime({
    userDataDir: join(tempDir(), 'profile'),
    readyDelayMs: 5,
    startupTimeoutMs: 200,
    stopTimeoutMs: 20,
    ...options,
  }, deps)
}

afterEach(() => {
  FakeChild.instances.length = 0
  resetBrowserSurfaceGateForTests()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('headless browser launch arguments', () => {
  it('uses the pipe transport and the required hardening flags', () => {
    const args = buildBrowserLaunchArgs({
      userDataDir: '/state/web-browser/profiles/default-session',
      windowSize: { width: 1280, height: 800 },
      noSandbox: false,
    })

    expect(args[0]).toBe('--headless=new')
    expect(args[1]).toBe('--remote-debugging-pipe')
    expect(args).toContain('--user-data-dir=/state/web-browser/profiles/default-session')
    expect(args).toContain('--window-size=1280,800')
    expect(args).toContain('--disable-dev-shm-usage')
    expect(args).toContain('--disable-gpu')
    expect(args).toContain('--disable-features=Translate,MediaRouter')
    expect(args).not.toContain('--no-sandbox')
    // No TCP debug port, ever.
    expect(args.some(arg => arg.startsWith('--remote-debugging-port'))).toBe(false)
  })

  it('adds --no-sandbox only for a root deployment', () => {
    const args = buildBrowserLaunchArgs({
      userDataDir: '/tmp/profile',
      windowSize: { width: 320, height: 200 },
      noSandbox: true,
    })

    expect(args).toContain('--no-sandbox')
  })
})

describe('headless browser runtime', () => {
  it('starts with a stdio pipe array and hands out the CDP streams', async () => {
    const { deps, calls } = createHarness()
    const runtime = runtimeFor(deps)

    const streams = await runtime.start()

    expect(calls).toHaveLength(1)
    expect(calls[0].options.stdio).toEqual(['ignore', 'ignore', 'pipe', 'pipe', 'pipe'])
    expect(streams.write).toBe((FakeChild.instances[0].stdio as unknown[])[3])
    expect(streams.read).toBe((FakeChild.instances[0].stdio as unknown[])[4])
    expect(runtime.isAlive()).toBe(true)
    expect(runtime.getState()).toBe('ready')

    await runtime.stop()
  })

  it('creates the profile directory under the Web UI home with owner-only permissions', async () => {
    const { deps } = createHarness()
    const dir = join(tempDir(), 'nested', 'profile')
    const runtime = runtimeFor(deps, { userDataDir: dir })

    await runtime.start()

    expect(existsSync(dir)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }

    await runtime.stop()
  })

  it('resolves the default profile directory under getWebUiHome()', () => {
    const dir = resolveBrowserProfileDir('default-session')

    expect(dir.endsWith(join('web-browser', 'profiles', 'default-session'))).toBe(true)
  })

  it('does not spawn anything or create directories when the surface gate is off', async () => {
    const { deps, calls } = createHarness({ surfaceEnabled: () => false })
    const dir = join(tempDir(), 'off-profile')
    const runtime = runtimeFor(deps, { userDataDir: dir })

    await expect(runtime.start()).rejects.toThrow(/surface is off/)

    expect(calls).toHaveLength(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('honours the real frozen gate, not just the injected seam', async () => {
    initializeBrowserSurfaceGate({
      env: { HERMES_BROWSER_SURFACE: 'off' },
      webUiHome: tempDir(),
      warn: vi.fn(),
      info: vi.fn(),
    })
    const { deps, calls } = createHarness({ surfaceEnabled: isBrowserSurfaceEnabled })
    const dir = join(tempDir(), 'gated-profile')
    const runtime = runtimeFor(deps, { userDataDir: dir })

    await expect(runtime.start()).rejects.toThrow(/surface is off/)

    expect(calls).toHaveLength(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('fails the start when the process exits during the readiness window', async () => {
    const { deps } = createHarness({
      spawn: (() => {
        const child = new FakeChild()
        setTimeout(() => child.exit(13, null), 1)
        return child as unknown as ChildProcess
      }) as unknown as BrowserRuntimeDependencies['spawn'],
    })
    const runtime = runtimeFor(deps, { readyDelayMs: 30 })

    await expect(runtime.start()).rejects.toThrow(/failed to start/)
    expect(runtime.isAlive()).toBe(false)
    expect(runtime.getState()).toBe('failed')
  })

  it('kills the process and throws when startup times out', async () => {
    const { deps } = createHarness()
    const runtime = runtimeFor(deps, { readyDelayMs: 5_000, startupTimeoutMs: 20 })

    await expect(runtime.start()).rejects.toThrow(/timed out/)

    const child = FakeChild.instances[0]
    expect(child.signals).toContain('SIGTERM')
    expect(runtime.isAlive()).toBe(false)
  })

  it('marks the runtime failed after an unexpected exit and restarts on demand', async () => {
    const { deps, calls } = createHarness()
    const runtime = runtimeFor(deps)

    await runtime.start()
    FakeChild.instances[0].exit(139, null)

    expect(runtime.isAlive()).toBe(false)
    expect(runtime.getState()).toBe('failed')

    await runtime.start()
    expect(calls).toHaveLength(2)
    expect(runtime.getState()).toBe('ready')

    await runtime.stop()
  })

  it('escalates to SIGKILL when the browser ignores SIGTERM', async () => {
    const { deps } = createHarness()
    const runtime = runtimeFor(deps, { stopTimeoutMs: 20 })

    await runtime.start()
    const child = FakeChild.instances[0]
    child.ignoreSigterm = true

    const startedAt = Date.now()
    await runtime.stop()

    expect(child.signals).toContain('SIGTERM')
    expect(child.signals).toContain('SIGKILL')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(runtime.isAlive()).toBe(false)
    expect(runtime.getState()).toBe('stopped')
  })

  it('reuses the live process instead of spawning twice', async () => {
    const { deps, calls } = createHarness()
    const runtime = runtimeFor(deps)

    const first = await runtime.start()
    const second = await runtime.start()

    expect(calls).toHaveLength(1)
    expect(second).toBe(first)

    await runtime.stop()
  })

  it('logs a --no-sandbox warning when running as root', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, calls } = createHarness({ uid: () => 0 })
    const runtime = runtimeFor(deps)

    try {
      await runtime.start()
      expect(calls[0].args).toContain('--no-sandbox')
      expect(warn.mock.calls.flat().join('\n')).toContain('--no-sandbox')
    } finally {
      warn.mockRestore()
      await runtime.stop()
    }
  })

  it('propagates an unresolvable runtime instead of starting a partial one', async () => {
    const { deps, calls } = createHarness({
      resolveExecutable: () => {
        throw new Error('browser runtime missing (缺少浏览器运行时)')
      },
    })
    const runtime = runtimeFor(deps)

    await expect(runtime.start()).rejects.toThrow('缺少浏览器运行时')
    expect(calls).toHaveLength(0)
  })

  it('shutdown is a no-op when the runtime never started', async () => {
    await expect(stopHeadlessBrowserRuntime()).resolves.toBeUndefined()
  })
})
