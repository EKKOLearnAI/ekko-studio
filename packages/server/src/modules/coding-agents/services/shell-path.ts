import type { Dirent } from 'node:fs'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Shell PATH discovery for the desktop build.
 *
 * GUI-launched processes do not inherit the interactive shell environment, and
 * a plain login shell (`$SHELL -lc`) never sources `~/.zshrc`/`~/.bashrc`, so
 * tools that only add themselves there (fnm, volta, pnpm, opencode, ...) stay
 * invisible. The resolver below mirrors what VS Code's resolveShellEnv does on
 * macOS: run an interactive login shell, wrap `$PATH` in sentinel markers, and
 * fall back to the plain login shell when that yields nothing usable.
 */

export const SHELL_PATH_MARKER_START = '__EKKO_SHELL_PATH_START__'
export const SHELL_PATH_MARKER_END = '__EKKO_SHELL_PATH_END__'

export interface NodeVersionScanDeps {
  existsSync: (path: string) => boolean
  readdirSync: (path: string, options: { withFileTypes: true }) => Dirent[]
}

const defaultScanDeps: NodeVersionScanDeps = { existsSync, readdirSync }

function compareNodeVersionDesc(left: string, right: string): number {
  const leftParts = left.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const rightParts = right.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (rightParts[index] || 0) - (leftParts[index] || 0)
    if (diff !== 0) return diff
  }
  return right.localeCompare(left)
}

/** Lists version-manager bin dirs under `versionsDir`, newest version first.
 * `binLayout` maps a version directory to its bin path — nvm keeps binaries in
 * `<v>/bin`, fnm in `<v>/installation/bin`. */
export function scanNodeVersionBins(
  versionsDir: string,
  binLayout: (versionDir: string) => string,
  deps: NodeVersionScanDeps = defaultScanDeps,
): string[] {
  if (!deps.existsSync(versionsDir)) return []
  try {
    return deps.readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(compareNodeVersionDesc)
      .map(version => binLayout(join(versionsDir, version)))
      .filter(binDir => deps.existsSync(binDir))
  } catch {
    return []
  }
}

export const INTERACTIVE_SHELL_TIMEOUT_MS = 8000
export const LOGIN_SHELL_TIMEOUT_MS = 3000

const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-B]|[@-_])/g

export type ShellPathExec = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string }>

export interface ShellPathProbeOptions {
  execFileAsync: ShellPathExec
  shell: string
  interactive: boolean
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

export function stripAnsiCodes(output: string): string {
  return output.replace(ANSI_PATTERN, '')
}

/** Extracts the marked `$PATH` value; when markers appear multiple times the
 * last occurrence wins, so rc files echoing the markers cannot shadow it. */
export function extractMarkedPath(output: string): string | null {
  const start = output.lastIndexOf(SHELL_PATH_MARKER_START)
  const end = output.lastIndexOf(SHELL_PATH_MARKER_END)
  if (start < 0 || end <= start) return null
  return output.slice(start + SHELL_PATH_MARKER_START.length, end).trim() || null
}

function looksLikePathList(value: string, pathDelimiter: string): boolean {
  if (!value) return false
  return value.split(pathDelimiter).every(entry => entry.length === 0 || entry.includes('/'))
}

export async function probeShellPath(options: ShellPathProbeOptions): Promise<string | null> {
  const { execFileAsync, shell, interactive } = options
  const flags = interactive ? ['-ilc'] : ['-lc']
  const command = `printf '\\n${SHELL_PATH_MARKER_START}%s${SHELL_PATH_MARKER_END}\\n' "$PATH"`
  try {
    const { stdout } = await execFileAsync(shell, [...flags, command], {
      encoding: 'utf-8',
      // Interactive rc init can be slow; a hanging rc is bounded by this timeout.
      timeout: options.timeoutMs ?? (interactive ? INTERACTIVE_SHELL_TIMEOUT_MS : LOGIN_SHELL_TIMEOUT_MS),
      windowsHide: true,
      env: options.env,
    })
    const marked = extractMarkedPath(stripAnsiCodes(stdout))
    if (!marked) return null
    // The delimiter is unknown at module scope; validate with both candidates
    // so a polluted extraction never becomes a bogus PATH.
    return looksLikePathList(marked, ':') || looksLikePathList(marked, ';') ? marked : null
  } catch {
    return null
  }
}

export interface LoginShellPathResolverOptions {
  execFileAsync: ShellPathExec
  getLoginShell: () => string | null
  isDesktop: boolean
  platform: NodeJS.Platform
  env?: Record<string, string | undefined>
}

export interface LoginShellPathResolver {
  getPath(): Promise<string | null>
}

export function createLoginShellPathResolver(options: LoginShellPathResolverOptions): LoginShellPathResolver {
  let cached: Promise<string | null> | undefined

  function resolve(): Promise<string | null> {
    if (!options.isDesktop || options.platform === 'win32') return Promise.resolve(null)
    const shell = options.getLoginShell()
    if (!shell) return Promise.resolve(null)
    return probeShellPath({ execFileAsync: options.execFileAsync, shell, interactive: true, env: options.env })
      .then(interactivePath => interactivePath
        || probeShellPath({ execFileAsync: options.execFileAsync, shell, interactive: false, env: options.env }))
      .catch(() => null)
  }

  return {
    // Promise-level memoization: concurrent callers (the agent status fan-out)
    // share one shell probe instead of racing past a value cache.
    getPath() {
      if (!cached) cached = resolve()
      return cached
    },
  }
}
