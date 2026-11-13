/**
 * Browser surface gate (spec-01 of `docs/web-agent-browser/`).
 *
 * The Web/device deployment may host a *server-side* browser panel whose
 * contract matches the desktop Electron browser. It is controlled by a single
 * environment switch plus a hard resource gate:
 *
 *   HERMES_BROWSER_SURFACE = off | local      (default: local, see D3)
 *
 * Semantics:
 * - `off`   → no browser process, no `/api/browser*` routes, no Socket.IO
 *             `/browser` namespace, no broker descriptor. Nothing is registered
 *             (not "registered then rejected"), so `off` is never half-open.
 * - `local` → the full surface, still bounded by the hard gate below and by the
 *             spec-09 security items.
 *
 * Hard gate (all four must pass, otherwise the surface does not start):
 * - MemTotal            ≥ 3 GiB
 * - MemAvailable        ≥ 1.2 GiB
 * - browser executable   resolvable
 * - free disk (Web UI home volume) ≥ 1 GiB
 *
 * A missing threshold reading is treated as a failure: no silent half-enable,
 * no silent downgrade. An invalid `HERMES_BROWSER_SURFACE` value resolves to
 * `off` with an explicit warning (never to `local`).
 *
 * The decision is evaluated once at startup and then frozen; the runtime never
 * re-reads the environment, so "half-applied env change" states cannot happen.
 */

import { existsSync, readFileSync, statfsSync } from 'fs'
import { dirname } from 'path'
import os from 'os'
import { getWebUiHome } from './config'

export type BrowserSurfaceMode = 'off' | 'local'

export type BrowserSurfaceRequestSource = 'default' | 'env' | 'desktop' | 'invalid'

export type BrowserSurfaceCheckId =
  | 'mem_total'
  | 'mem_available'
  | 'free_disk'
  | 'browser_executable'

export interface BrowserSurfaceCheck {
  id: BrowserSurfaceCheckId
  ok: boolean
  /** Human-readable requirement, e.g. `>= 3.00 GiB`. */
  required: string
  /** Human-readable measured value, e.g. `3.90 GiB (4185137152 B)`. */
  actual: string
}

export interface BrowserSurfaceGateReport {
  mode: BrowserSurfaceMode
  enabled: boolean
  /** Raw configured value (`local` when the env var is unset). */
  requested: string
  requestedSource: BrowserSurfaceRequestSource
  checks: BrowserSurfaceCheck[]
  failedChecks: BrowserSurfaceCheckId[]
  /** Why the surface is off (empty when enabled). */
  reasons: string[]
  webUiHome: string
  executablePath: string | null
  /**
   * Resolved browser version. The target device reuses the apt-managed system
   * chromium (spec-02 D1), i.e. the version drifts with apt — recording it here
   * is what makes that trade-off debuggable.
   */
  executableVersion: string | null
  evaluatedAt: string
}

/**
 * Every external reading the gate depends on. Tests inject a stub; production
 * uses `defaultBrowserSurfaceProbe`. spec-02 injects the real Chrome resolver
 * from the composition root (`packages/server/src/index.ts`).
 */
export interface BrowserSurfaceProbe {
  readMemTotalBytes(): number | null
  readMemAvailableBytes(): number | null
  readFreeDiskBytes(path: string): number | null
  resolveBrowserExecutable(env: Record<string, string | undefined>): string | null
  /** Optional: version of the resolved executable, recorded in the report. */
  resolveBrowserExecutableVersion?(env: Record<string, string | undefined>): string | null
}

export interface BrowserSurfaceEvaluationOptions {
  env?: Record<string, string | undefined>
  probe?: BrowserSurfaceProbe
  webUiHome?: string
  /** Injectable clock, for deterministic `evaluatedAt` in tests. */
  now?: () => Date
}

export interface BrowserSurfaceInitOptions extends BrowserSurfaceEvaluationOptions {
  warn?: (message: string) => void
  info?: (message: string) => void
  /** Re-evaluate even when a frozen decision already exists (tests only). */
  force?: boolean
}

export const BROWSER_SURFACE_ENV = 'HERMES_BROWSER_SURFACE'
export const HERMES_DESKTOP_ENV = 'HERMES_DESKTOP'

/**
 * D3: the target device shape (RK3566 / Armbian) is the only landing zone for
 * this feature, so the default is `local`. The hard gate below is the
 * mandatory companion of that default — a low-spec host simply stays off.
 */
export const BROWSER_SURFACE_DEFAULT_MODE: BrowserSurfaceMode = 'local'

const GIB = 1024 ** 3

export const BROWSER_SURFACE_THRESHOLDS = {
  memTotalBytes: 3 * GIB,
  memAvailableBytes: Math.floor(1.2 * GIB),
  freeDiskBytes: GIB,
} as const

/**
 * Conservative fallback for the executable check. spec-02 owns the full
 * resolver (`AGENT_BROWSER_HOME`, Chrome for Testing bundles, `PATH` lookup)
 * and injects it at startup; this list only keeps the gate functional on its
 * own with apt-managed system browsers.
 */
export const BROWSER_SURFACE_EXECUTABLE_CANDIDATES: readonly string[] = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'unavailable'
  return `${(bytes / GIB).toFixed(2)} GiB (${bytes} B)`
}

function parseMeminfoValue(source: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(source)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1024 : null
}

function readProcMeminfo(): string | null {
  try {
    return readFileSync('/proc/meminfo', 'utf8')
  } catch {
    return null
  }
}

function readNearestStatfsBytes(target: string): number | null {
  let candidate = target
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const stats = statfsSync(candidate)
      const bytes = stats.bavail * stats.bsize
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
    } catch {
      const parent = dirname(candidate)
      if (!parent || parent === candidate) return null
      candidate = parent
    }
  }
  return null
}

export const defaultBrowserSurfaceProbe: BrowserSurfaceProbe = {
  readMemTotalBytes() {
    const meminfo = readProcMeminfo()
    if (meminfo) {
      const parsed = parseMeminfoValue(meminfo, 'MemTotal')
      if (parsed != null) return parsed
    }
    const total = os.totalmem()
    return Number.isFinite(total) && total > 0 ? total : null
  },
  readMemAvailableBytes() {
    const meminfo = readProcMeminfo()
    if (meminfo) {
      const parsed = parseMeminfoValue(meminfo, 'MemAvailable')
      if (parsed != null) return parsed
    }
    const free = os.freemem()
    return Number.isFinite(free) && free > 0 ? free : null
  },
  readFreeDiskBytes(path: string) {
    return readNearestStatfsBytes(path)
  },
  resolveBrowserExecutable(env: Record<string, string | undefined>) {
    const explicit = (env.AGENT_BROWSER_EXECUTABLE_PATH || '').trim()
    if (explicit && existsSync(explicit)) return explicit
    for (const candidate of BROWSER_SURFACE_EXECUTABLE_CANDIDATES) {
      if (existsSync(candidate)) return candidate
    }
    return null
  },
}

/**
 * `HERMES_DESKTOP === 'true'`. Single definition, shared with spec-05's broker
 * descriptor (`services/browser/broker-descriptor.ts`): in desktop mode
 * Electron owns `desktop-browser/broker.json`, so neither the surface nor the
 * descriptor writer may act. Keep exactly one implementation so the two
 * surfaces can never disagree about desktop mode.
 */
export function isDesktopSurfaceHost(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return String(env[HERMES_DESKTOP_ENV] || '').trim().toLowerCase() === 'true'
}

export interface BrowserSurfaceRequest {
  requested: string
  source: BrowserSurfaceRequestSource
  mode: BrowserSurfaceMode
  invalid: boolean
}

/**
 * Resolve the requested mode. Desktop always wins: the desktop app hosts its
 * own native browser panel, and two writers on the same descriptor path would
 * fight (spec-05), so `HERMES_BROWSER_SURFACE` is ignored there.
 */
export function parseBrowserSurfaceRequest(
  env: Record<string, string | undefined> = process.env,
): BrowserSurfaceRequest {
  const configured = env[BROWSER_SURFACE_ENV]
  const raw = configured === undefined ? '' : String(configured).trim()

  if (isDesktopSurfaceHost(env)) {
    return { requested: raw, source: 'desktop', mode: 'off', invalid: false }
  }

  if (configured === undefined) {
    return {
      requested: BROWSER_SURFACE_DEFAULT_MODE,
      source: 'default',
      mode: BROWSER_SURFACE_DEFAULT_MODE,
      invalid: false,
    }
  }

  const normalized = raw.toLowerCase()
  if (normalized === 'off') return { requested: raw, source: 'env', mode: 'off', invalid: false }
  if (normalized === 'local') return { requested: raw, source: 'env', mode: 'local', invalid: false }

  // Set but unusable (including the empty string): off + explicit warning.
  return { requested: raw, source: 'invalid', mode: 'off', invalid: true }
}

function buildReport(
  request: BrowserSurfaceRequest,
  mode: BrowserSurfaceMode,
  reasons: string[],
  checks: BrowserSurfaceCheck[],
  webUiHome: string,
  executablePath: string | null,
  executableVersion: string | null,
  now: () => Date,
): BrowserSurfaceGateReport {
  return {
    mode,
    enabled: mode === 'local',
    requested: request.requested,
    requestedSource: request.source,
    checks,
    failedChecks: checks.filter(check => !check.ok).map(check => check.id),
    reasons,
    webUiHome,
    executablePath,
    executableVersion,
    evaluatedAt: now().toISOString(),
  }
}

/** Pure evaluation — no caching, no logging. Safe to call from tests. */
export function evaluateBrowserSurfaceGate(
  options: BrowserSurfaceEvaluationOptions = {},
): BrowserSurfaceGateReport {
  const env = options.env ?? process.env
  const probe = options.probe ?? defaultBrowserSurfaceProbe
  const now = options.now ?? (() => new Date())
  const webUiHome = options.webUiHome ?? getWebUiHome(env)
  const request = parseBrowserSurfaceRequest(env)

  if (request.source === 'desktop') {
    return buildReport(
      request,
      'off',
      [
        `${HERMES_DESKTOP_ENV}=true: the desktop app hosts its own native browser panel; `
        + `the server-hosted surface stays off so both never write the same broker descriptor`,
      ],
      [],
      webUiHome,
      null,
      null,
      now,
    )
  }

  if (request.invalid) {
    return buildReport(
      request,
      'off',
      [
        `invalid ${BROWSER_SURFACE_ENV}=${JSON.stringify(request.requested)}; `
        + `expected "off" or "local" (never downgraded to "local")`,
      ],
      [],
      webUiHome,
      null,
      null,
      now,
    )
  }

  if (request.mode === 'off') {
    return buildReport(
      request,
      'off',
      [`disabled by ${BROWSER_SURFACE_ENV}=off`],
      [],
      webUiHome,
      null,
      null,
      now,
    )
  }

  const memTotal = probe.readMemTotalBytes()
  const memAvailable = probe.readMemAvailableBytes()
  const freeDisk = probe.readFreeDiskBytes(webUiHome)
  const executablePath = probe.resolveBrowserExecutable(env)
  const executableVersion = executablePath
    ? (probe.resolveBrowserExecutableVersion?.(env) ?? null)
    : null

  const checks: BrowserSurfaceCheck[] = [
    {
      id: 'mem_total',
      ok: memTotal != null && memTotal >= BROWSER_SURFACE_THRESHOLDS.memTotalBytes,
      required: `>= ${formatBytes(BROWSER_SURFACE_THRESHOLDS.memTotalBytes)} MemTotal`,
      actual: formatBytes(memTotal),
    },
    {
      id: 'mem_available',
      ok: memAvailable != null && memAvailable >= BROWSER_SURFACE_THRESHOLDS.memAvailableBytes,
      required: `>= ${formatBytes(BROWSER_SURFACE_THRESHOLDS.memAvailableBytes)} MemAvailable`,
      actual: formatBytes(memAvailable),
    },
    {
      id: 'free_disk',
      ok: freeDisk != null && freeDisk >= BROWSER_SURFACE_THRESHOLDS.freeDiskBytes,
      required: `>= ${formatBytes(BROWSER_SURFACE_THRESHOLDS.freeDiskBytes)} free on ${webUiHome}`,
      actual: formatBytes(freeDisk),
    },
    {
      id: 'browser_executable',
      ok: Boolean(executablePath),
      required: 'a resolvable browser executable',
      actual: executablePath || 'unavailable',
    },
  ]

  const failedChecks = checks.filter(check => !check.ok).map(check => check.id)
  const mode: BrowserSurfaceMode = failedChecks.length === 0 ? 'local' : 'off'
  const reasons: string[] = []
  if (mode === 'off') {
    for (const check of checks) {
      if (!check.ok) {
        reasons.push(`hard gate failed: ${check.id} (${check.actual}, required ${check.required})`)
      }
    }
  }

  return buildReport(request, mode, reasons, checks, webUiHome, executablePath, executableVersion, now)
}

let frozenReport: BrowserSurfaceGateReport | null = null

function emitReport(report: BrowserSurfaceGateReport, options: BrowserSurfaceInitOptions): void {
  const warn = options.warn ?? (message => console.warn(message))
  const info = options.info ?? (message => console.log(message))

  if (report.enabled) {
    info(
      `[browser-surface] enabled: mode=local webUiHome=${report.webUiHome} `
      + `executable=${report.executablePath} version=${report.executableVersion || 'unknown'}`,
    )
    return
  }

  for (const reason of report.reasons) {
    warn(`[browser-surface] browser surface disabled: ${reason}`)
  }
  warn(
    `[browser-surface] disabled: mode=off source=${report.requestedSource} `
    + `requested=${JSON.stringify(report.requested)} webUiHome=${report.webUiHome} `
    + `failed=${report.failedChecks.join(',') || 'none'}`,
  )
}

/**
 * Evaluate the gate once and freeze it. Called from `bootstrap()` — the
 * runtime must never re-read `HERMES_BROWSER_SURFACE` afterwards.
 */
export function initializeBrowserSurfaceGate(
  options: BrowserSurfaceInitOptions = {},
): BrowserSurfaceGateReport {
  if (frozenReport && !options.force) return frozenReport
  const report = evaluateBrowserSurfaceGate(options)
  frozenReport = report
  emitReport(report, options)
  return report
}

/** Frozen report, evaluated on first access when startup did not run it. */
export function browserSurfaceGateReport(): BrowserSurfaceGateReport {
  return frozenReport ?? initializeBrowserSurfaceGate()
}

export function browserSurfaceMode(): BrowserSurfaceMode {
  return browserSurfaceGateReport().mode
}

export function isBrowserSurfaceEnabled(): boolean {
  return browserSurfaceGateReport().enabled
}

/** Test hook: clear the frozen decision so a fresh evaluation can run. */
export function resetBrowserSurfaceGateForTests(): void {
  frozenReport = null
}
