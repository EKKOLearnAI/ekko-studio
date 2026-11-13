/**
 * Headless browser runtime (spec-02).
 *
 * Starts one headless chromium with `--remote-debugging-pipe` (no TCP debug
 * port anywhere) and hands the CDP pipe streams to spec-03. The pipe fds must
 * come from Node's `stdio` array — `dup2`/`pass_fds` style plumbing makes the
 * child close fd 3/4 and Chrome exits 13 with
 * "Remote debugging pipe file descriptors are not open.":
 *
 *   stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
 *   child.stdio[3] → browser reads (parent writes)
 *   child.stdio[4] → browser writes (parent reads)
 *
 * This module knows nothing about the CDP protocol (spec-03) or page
 * automation (spec-04).
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { chmodSync, mkdirSync } from 'fs'
import { platform as currentPlatform } from 'os'
import { join } from 'path'
import type { Readable, Writable } from 'stream'
import { getWebUiHome } from '../../public/config'
import { isBrowserSurfaceEnabled } from '../../public/browser-surface'
import { logger } from '../../public/logging'
import { resolveBrowserExecutable } from './executable'
import type {
  BrowserCdpStreams,
  BrowserWindowSize,
  HeadlessRuntimeOptions,
  HeadlessRuntimeState,
  ResolvedBrowserExecutable,
} from './types'

export const DEFAULT_BROWSER_PROFILE_ID = 'default-session'
export const BROWSER_RUNTIME_STARTUP_TIMEOUT_MS = 15_000
export const BROWSER_RUNTIME_READY_DELAY_MS = 250
export const BROWSER_RUNTIME_STOP_TIMEOUT_MS = 5_000
export const BROWSER_RUNTIME_WINDOW_SIZE: BrowserWindowSize = { width: 1280, height: 800 }

/**
 * `web-browser/` is a sibling of the other Web UI state directories and lives
 * under `getWebUiHome()`. Frames are never written here (spec-06).
 */
export function resolveBrowserProfileDir(profileId: string = DEFAULT_BROWSER_PROFILE_ID): string {
  return join(getWebUiHome(), 'web-browser', 'profiles', profileId)
}

export function resolveBrowserRootDir(): string {
  return join(getWebUiHome(), 'web-browser')
}

export interface BrowserLaunchArgumentOptions {
  userDataDir: string
  windowSize: BrowserWindowSize
  /** Only set for a root deployment; logged as a security downgrade. */
  noSandbox: boolean
}

/** Pure, ordered — the acceptance contract for the launch arguments. */
export function buildBrowserLaunchArgs(options: BrowserLaunchArgumentOptions): string[] {
  const { width, height } = options.windowSize
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    `--window-size=${width},${height}`,
    // Required on the target device: no usable GPU and a small /dev/shm.
    // Harmless on desktop dev machines.
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ]
  if (options.noSandbox) args.push('--no-sandbox')
  return args
}

export interface BrowserRuntimeDependencies {
  spawn: typeof nodeSpawn
  resolveExecutable: (env: Record<string, string | undefined>) => ResolvedBrowserExecutable
  /** Actual runtime uid, or null when the platform has none (win32). */
  uid: () => number | null
  platform: NodeJS.Platform
  wait: (ms: number) => Promise<void>
  env: Record<string, string | undefined>
  /** Overridable for tests; defaults to the frozen surface gate. */
  surfaceEnabled: () => boolean
}

export function createBrowserRuntimeDependencies(): BrowserRuntimeDependencies {
  return {
    spawn: nodeSpawn,
    resolveExecutable: env => resolveBrowserExecutable({ env }),
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    platform: currentPlatform(),
    wait: (ms: number) => new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    }),
    env: process.env,
    surfaceEnabled: isBrowserSurfaceEnabled,
  }
}

function defaultRuntimeOptions(): HeadlessRuntimeOptions {
  return {
    profileId: DEFAULT_BROWSER_PROFILE_ID,
    windowSize: BROWSER_RUNTIME_WINDOW_SIZE,
    startupTimeoutMs: BROWSER_RUNTIME_STARTUP_TIMEOUT_MS,
    readyDelayMs: BROWSER_RUNTIME_READY_DELAY_MS,
    stopTimeoutMs: BROWSER_RUNTIME_STOP_TIMEOUT_MS,
  }
}

function ensureProfileDir(dir: string, platform: NodeJS.Platform): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (platform === 'win32') return
  try {
    chmodSync(dir, 0o700)
  } catch (err) {
    logger.warn(err, '[browser] failed to restrict permissions on the browser profile dir')
  }
}

type ExitInfo = { code: number | null, signal: NodeJS.Signals | null }

export class HeadlessRuntime {
  private readonly options: HeadlessRuntimeOptions
  private readonly deps: BrowserRuntimeDependencies
  private child: ChildProcess | null = null
  private streams: BrowserCdpStreams | null = null
  private executable: ResolvedBrowserExecutable | null = null
  private state: HeadlessRuntimeState = 'idle'
  private stopping = false
  private stderrTail = ''
  private exitListeners = new Set<(info: ExitInfo) => void>()

  constructor(
    options: Partial<HeadlessRuntimeOptions> = {},
    deps: BrowserRuntimeDependencies = createBrowserRuntimeDependencies(),
  ) {
    this.options = { ...defaultRuntimeOptions(), ...options }
    this.deps = deps
  }

  getState(): HeadlessRuntimeState {
    return this.state
  }

  getPid(): number | null {
    return this.child?.pid ?? null
  }

  getExecutable(): ResolvedBrowserExecutable | null {
    return this.executable
  }

  getUserDataDir(): string {
    return this.options.userDataDir || resolveBrowserProfileDir(this.options.profileId)
  }

  isAlive(): boolean {
    const child = this.child
    if (!child) return false
    return child.exitCode === null && child.signalCode === null
  }

  cdpStreams(): BrowserCdpStreams {
    if (!this.streams || !this.isAlive()) {
      throw new Error('headless browser runtime is not running; call start() first')
    }
    return this.streams
  }

  onExit(listener: (info: ExitInfo) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /**
   * Start the browser. Resolves once the process survived the readiness window.
   * The surface gate is checked first: when it is `off` nothing is spawned and
   * no profile directory is created.
   */
  async start(): Promise<BrowserCdpStreams> {
    if (this.isAlive() && this.streams) return this.streams

    if (!this.deps.surfaceEnabled()) {
      this.state = 'failed'
      throw new Error('browser surface is off; refusing to start the headless browser runtime')
    }

    const executable = this.deps.resolveExecutable(this.deps.env)
    const uid = this.deps.uid()
    const noSandbox = uid === 0
    if (noSandbox) {
      // Root cannot run Chromium's sandbox. This is a security downgrade and it
      // must never happen silently (note: the kiosk browser being root+no-sandbox
      // does NOT make this the default here).
      logger.warn('[browser] running as root: launching with --no-sandbox (security downgrade)')
      console.warn('[browser] running as root: launching the headless browser with --no-sandbox')
    }

    const userDataDir = this.getUserDataDir()
    ensureProfileDir(userDataDir, this.deps.platform)

    const args = buildBrowserLaunchArgs({
      userDataDir,
      windowSize: this.options.windowSize,
      noSandbox,
    })

    logger.info(
      '[browser] starting headless runtime path=%s source=%s version=%s profile=%s',
      executable.path,
      executable.source,
      executable.version || 'unknown',
      userDataDir,
    )

    const child = this.deps.spawn(executable.path, args, {
      // fd 3 (parent write) and fd 4 (parent read) carry the CDP pipe.
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...this.deps.env } as NodeJS.ProcessEnv,
    })

    this.state = 'starting'
    this.stopping = false
    this.child = child
    this.executable = executable
    this.stderrTail = ''
    // Deliberately no `unref()`: the runtime owns the process and kills it on
    // shutdown. Unref'ing would let the server exit while leaving an orphan
    // chromium holding the profile lock.
    this.streams = {
      write: child.stdio[3] as unknown as Writable,
      read: child.stdio[4] as unknown as Readable,
    }

    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000)
    })
    child.once('exit', (code, signal) => {
      const info: ExitInfo = { code, signal }
      if (this.child === child) {
        const wasReady = this.state === 'ready'
        this.child = null
        this.streams = null
        if (this.stopping || this.state === 'stopped') {
          this.state = 'stopped'
        } else {
          // During startup the caller reports the failure with more context.
          this.state = 'failed'
          if (wasReady) {
            logger.warn({ code, signal }, '[browser] headless runtime exited unexpectedly')
          }
        }
      }
      for (const listener of this.exitListeners) {
        try {
          listener(info)
        } catch (err) {
          logger.warn(err, '[browser] exit listener failed')
        }
      }
    })

    const started = await this.waitForStartup(child)

    if (!started.ok) {
      await this.killChild(child)
      this.state = 'failed'
      throw new Error(
        `headless browser failed to start (${started.reason})`
        + (this.stderrTail ? `: ${this.stderrTail.trim().split(/\r?\n/).slice(-3).join(' | ')}` : ''),
      )
    }

    this.state = 'ready'
    logger.info({ pid: child.pid }, '[browser] headless runtime ready')
    return this.streams as BrowserCdpStreams
  }

  private waitForStartup(child: ChildProcess): Promise<{ ok: boolean, reason: string }> {
    return new Promise(resolve => {
      let settled = false
      const timers: NodeJS.Timeout[] = []

      const finish = (ok: boolean, reason: string) => {
        if (settled) return
        settled = true
        for (const timer of timers) clearTimeout(timer)
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
        resolve({ ok, reason })
      }

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(false, `exited during startup code=${code} signal=${signal}`)
      }
      const onError = (err: Error) => {
        finish(false, `spawn error: ${err.message}`)
      }

      child.once('exit', onExit)
      child.once('error', onError)

      const readyTimer = setTimeout(() => finish(true, 'ready'), this.options.readyDelayMs)
      const timeoutTimer = setTimeout(
        () => finish(false, `startup timed out after ${this.options.startupTimeoutMs}ms`),
        this.options.startupTimeoutMs,
      )
      timers.push(readyTimer, timeoutTimer)
    })
  }

  private async killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    await this.terminate(child)
    if (this.child === child) {
      this.child = null
      this.streams = null
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    const exitPromise = new Promise<void>(resolve => {
      child.once('exit', () => resolve())
    })

    try {
      child.kill('SIGTERM')
    } catch {
      // already gone
    }

    let exited = false
    await Promise.race([
      exitPromise.then(() => {
        exited = true
      }),
      this.deps.wait(this.options.stopTimeoutMs),
    ])

    if (!exited && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      await Promise.race([exitPromise, this.deps.wait(1_000)])
    }
  }

  /** Stop the browser. Never blocks longer than `stopTimeoutMs` + 1s. */
  async stop(): Promise<void> {
    const child = this.child
    this.stopping = true
    this.state = 'stopped'
    this.child = null
    this.streams = null
    if (!child) return
    await this.terminate(child)
  }
}

let runtimeSingleton: HeadlessRuntime | null = null

export function getHeadlessBrowserRuntime(): HeadlessRuntime {
  if (!runtimeSingleton) runtimeSingleton = new HeadlessRuntime()
  return runtimeSingleton
}

/** Stop the singleton if it was ever created (shutdown path). */
export async function stopHeadlessBrowserRuntime(): Promise<void> {
  if (!runtimeSingleton) return
  await runtimeSingleton.stop()
}

/** Test hook. */
export function resetHeadlessBrowserRuntimeForTests(): void {
  runtimeSingleton = null
}
