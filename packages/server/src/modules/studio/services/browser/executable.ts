/**
 * Browser executable resolution (spec-02 D1 / acceptance 1).
 *
 * Fixed order — no shell globbing, no "fall back to the user's own Chrome":
 *
 *   1. `AGENT_BROWSER_EXECUTABLE_PATH` (install-time passthrough).
 *   2. `<AGENT_BROWSER_HOME>/browsers/chrome-*` Chrome for Testing bundle.
 *      When the bundle exists it wins over the system package because it is
 *      version-pinned. On the target device it does not exist, so the resolver
 *      lands on the apt-managed system chromium.
 *   3. System chromium packages only (`/usr/bin/chromium` and friends).
 *   4. Explicit failure listing every path tried.
 *
 * Every candidate must pass validation before it is accepted: `--version` must
 * succeed, and (unless disabled) one headless smoke run
 * (`--headless=new --dump-dom about:blank`) must exit 0. A failing candidate is
 * skipped, never silently downgraded to a browser we do not control.
 */

import { spawnSync } from 'child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { homedir, platform as currentPlatform } from 'os'
import { join, resolve as resolvePath } from 'path'
import type {
  BrowserExecutableCandidate,
  BrowserExecutableSource,
  ResolvedBrowserExecutable,
} from './types'

export const BROWSER_EXECUTABLE_PATH_ENV = 'AGENT_BROWSER_EXECUTABLE_PATH'
export const AGENT_BROWSER_HOME_ENV = 'AGENT_BROWSER_HOME'

/**
 * Only package-managed system browsers. The user's own Google Chrome / Edge
 * install is deliberately absent: sharing a profile with the human's browser is
 * both confusing and uncontrolled.
 */
export const SYSTEM_BROWSER_EXECUTABLE_CANDIDATES: readonly string[] = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/lib/chromium/chromium',
  '/snap/bin/chromium',
]

const BUNDLED_BROWSER_NAMES: Record<string, readonly string[]> = {
  win32: ['chrome.exe'],
  darwin: ['Google Chrome for Testing', 'Google Chrome', 'Chromium', 'chrome'],
  linux: ['chrome', 'chromium', 'chromium-browser'],
}

const MAX_BUNDLE_WALK_DEPTH = 6

export class BrowserRuntimeMissingError extends Error {
  readonly searchedPaths: string[]
  readonly candidates: BrowserExecutableCandidate[]

  constructor(searchedPaths: string[], candidates: BrowserExecutableCandidate[]) {
    const detail = candidates
      .filter(candidate => !candidate.ok)
      .map(candidate => `${candidate.path} (${candidate.detail})`)
      .join('; ')
    super(
      'browser runtime missing (缺少浏览器运行时): no usable chromium executable found. '
      + `Searched: ${searchedPaths.length ? searchedPaths.join(', ') : 'none'}`
      + (detail ? `. Rejected: ${detail}` : ''),
    )
    this.name = 'BrowserRuntimeMissingError'
    this.searchedPaths = searchedPaths
    this.candidates = candidates
  }
}

export interface BrowserExecutableProbe {
  /** Runs `--version`; resolves the version string when it exits 0. */
  runVersion(path: string): { ok: boolean, version: string | null, detail: string }
  /** Runs one headless dump-dom smoke test on `about:blank`. */
  runSmoke(path: string): { ok: boolean, detail: string }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find(entry => entry.trim().length > 0)
  return line ? line.trim() : ''
}

export const defaultBrowserExecutableProbe: BrowserExecutableProbe = {
  runVersion(path: string) {
    try {
      const result = spawnSync(path, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      })
      const output = `${result.stdout || ''}${result.stderr || ''}`
      if (result.error) {
        return { ok: false, version: null, detail: `spawn failed: ${result.error.message}` }
      }
      if (result.status !== 0) {
        return { ok: false, version: null, detail: firstLine(output) || `exit ${result.status}` }
      }
      return { ok: true, version: parseBrowserVersion(output), detail: firstLine(output) }
    } catch (err) {
      return { ok: false, version: null, detail: err instanceof Error ? err.message : String(err) }
    }
  },
  runSmoke(path: string) {
    try {
      const result = spawnSync(path, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--dump-dom',
        'about:blank',
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      })
      if (result.error) {
        return { ok: false, detail: `smoke spawn failed: ${result.error.message}` }
      }
      if (result.status !== 0) {
        return {
          ok: false,
          detail: `smoke exit ${result.status}: ${firstLine(`${result.stderr || ''}`) || 'no stderr'}`,
        }
      }
      return { ok: true, detail: 'headless smoke ok' }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  },
}

export function parseBrowserVersion(raw: string): string | null {
  const match = /\b(\d+\.\d+(?:\.\d+){0,3})\b/.exec(raw || '')
  return match ? match[1] : null
}

export function bundledBrowserExecutableNames(platform: NodeJS.Platform = currentPlatform()): readonly string[] {
  return BUNDLED_BROWSER_NAMES[platform] || BUNDLED_BROWSER_NAMES.linux
}

/** Homes that may hold `browsers/chrome-*` bundles, in priority order. */
export function browserBundleHomes(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const homes: string[] = []
  const configured = (env[AGENT_BROWSER_HOME_ENV] || '').trim()
  if (configured) homes.push(resolvePath(configured))
  // Default home used by `agent-browser install` when the env is not set.
  homes.push(join(homedir(), '.agent-browser'))
  return [...new Set(homes)]
}

function isFileExecutable(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Recursive (bounded) search for a browser binary under a bundle directory. */
export function findBrowserExecutableUnder(
  dir: string,
  names: readonly string[] = bundledBrowserExecutableNames(),
  maxDepth = MAX_BUNDLE_WALK_DEPTH,
): string | null {
  const wanted = new Set(names)
  const queue: Array<{ dir: string, depth: number }> = [{ dir, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift() as { dir: string, depth: number }
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current.dir, entry.name)
      if (entry.isFile() && wanted.has(entry.name) && isFileExecutable(path)) return path
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: path, depth: current.depth + 1 })
      }
    }
  }

  return null
}

/** Bundle executables under `<home>/browsers/<bundle>/`, newest bundle first. */
export function findBundleExecutables(
  home: string,
  platform: NodeJS.Platform = currentPlatform(),
): string[] {
  const browsersDir = join(home, 'browsers')
  if (!existsSync(browsersDir)) return []

  let bundleDirs: string[] = []
  try {
    bundleDirs = readdirSync(browsersDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(name => join(browsersDir, name))
  } catch {
    return []
  }

  const names = bundledBrowserExecutableNames(platform)
  const found: string[] = []
  for (const bundleDir of bundleDirs) {
    const executable = findBrowserExecutableUnder(bundleDir, names)
    if (executable) found.push(executable)
  }
  return found
}

/**
 * A launcher script (`/usr/bin/chromium` on Debian/Ubuntu is a `sh` wrapper).
 * Only the first two bytes are read — browser binaries are hundreds of MB.
 */
export function isLauncherScript(path: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(2)
    const read = readSync(fd, buffer, 0, 2, 0)
    return buffer.subarray(0, read).toString('utf8') === '#!'
  } catch {
    return false
  } finally {
    if (fd != null) {
      try {
        closeSync(fd)
      } catch {
        // ignore: the handle is only used for a two-byte sniff
      }
    }
  }
}

export interface BrowserExecutableResolutionOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  probe?: BrowserExecutableProbe
  /**
   * `full` (default): `--version` + headless smoke.
   * `version`: `--version` only (startup gate).
   * `none`: existence only.
   */
  validate?: 'full' | 'version' | 'none'
  /** Skip the smoke test even when `validate` is `full`. */
  smoke?: boolean
  /** Override the bundle home list (tests keep resolution deterministic). */
  bundleHomes?: string[]
}

export interface BrowserExecutableResolution {
  executable: ResolvedBrowserExecutable
  candidates: BrowserExecutableCandidate[]
  searchedPaths: string[]
}

function candidatePlan(
  deps: Required<Pick<BrowserExecutableResolutionOptions, 'env' | 'platform'>>,
  bundleHomes: string[],
): Array<{ path: string, source: BrowserExecutableSource }> {
  const plan: Array<{ path: string, source: BrowserExecutableSource }> = []
  const seen = new Set<string>()
  const push = (path: string, source: BrowserExecutableSource) => {
    const key = resolvePath(path)
    if (seen.has(key)) return
    seen.add(key)
    plan.push({ path: key, source })
  }

  const explicit = (deps.env[BROWSER_EXECUTABLE_PATH_ENV] || '').trim()
  if (explicit) push(explicit, 'env')

  for (const home of bundleHomes) {
    for (const executable of findBundleExecutables(home, deps.platform)) {
      push(executable, 'bundle')
    }
  }

  if (deps.platform === 'linux') {
    for (const candidate of SYSTEM_BROWSER_EXECUTABLE_CANDIDATES) push(candidate, 'system')
  }

  return plan
}

/**
 * Resolve and validate a browser executable. Throws
 * `BrowserRuntimeMissingError` when nothing usable is found.
 */
export function resolveBrowserExecutableWithTrace(
  options: BrowserExecutableResolutionOptions = {},
): BrowserExecutableResolution {
  const env = options.env ?? process.env
  const platform = options.platform ?? currentPlatform()
  const probe = options.probe ?? defaultBrowserExecutableProbe
  const validate = options.validate ?? 'full'
  const smokeEnabled = validate === 'full' && options.smoke !== false

  const plan = candidatePlan(
    { env, platform },
    options.bundleHomes ?? browserBundleHomes(env),
  )
  const candidates: BrowserExecutableCandidate[] = []
  const searchedPaths: string[] = []
  let executable: ResolvedBrowserExecutable | null = null

  for (const candidate of plan) {
    searchedPaths.push(candidate.path)
    if (!existsSync(candidate.path) || !isFileExecutable(candidate.path)) {
      candidates.push({ ...candidate, exists: false, ok: false, detail: 'not found' })
      continue
    }
    if (validate === 'none') {
      candidates.push({
        ...candidate,
        exists: true,
        ok: true,
        detail: 'exists (validation skipped)',
      })
      executable = {
        path: candidate.path,
        source: candidate.source,
        version: null,
        launcher: isLauncherScript(candidate.path),
      }
      break
    }

    const version = probe.runVersion(candidate.path)
    if (!version.ok) {
      candidates.push({
        ...candidate,
        exists: true,
        ok: false,
        detail: `--version failed: ${version.detail}`,
      })
      continue
    }

    if (smokeEnabled) {
      const smoke = probe.runSmoke(candidate.path)
      if (!smoke.ok) {
        candidates.push({
          ...candidate,
          exists: true,
          ok: false,
          detail: `headless smoke failed: ${smoke.detail}`,
        })
        continue
      }
    }

    candidates.push({
      ...candidate,
      exists: true,
      ok: true,
      detail: version.version ? `version ${version.version}` : version.detail,
    })
    executable = {
      path: candidate.path,
      source: candidate.source,
      version: version.version,
      launcher: isLauncherScript(candidate.path),
    }
    break
  }

  if (!executable) throw new BrowserRuntimeMissingError(searchedPaths, candidates)

  return { executable, candidates, searchedPaths }
}

export function resolveBrowserExecutable(
  options: BrowserExecutableResolutionOptions = {},
): ResolvedBrowserExecutable {
  return resolveBrowserExecutableWithTrace(options).executable
}
