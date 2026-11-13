import { execFile } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'
import { normalizeWindowsCommandPath } from '../../../studio/public/windows-command'
import { resolveHermesInstallationEnvironment } from './installation'
import { isPathWithin } from './path'
import { resolveHermesBin } from './process'

const execFileAsync = promisify(execFile)
const HERMES_VERSION_PROBE = [
  'import importlib.util, hermes_cli',
  "assert importlib.util.find_spec('hermes_cli.main')",
  'try:',
  '    from hermes_cli.version_info import get_version_info',
  'except ModuleNotFoundError as exc:',
  "    if exc.name != 'hermes_cli.version_info': raise",
  '    version = hermes_cli.__version__',
  'else:',
  '    version = get_version_info().display_version',
  'print(version)',
].join('\n')

export interface HermesManagedRuntimeLocation {
  version: string
  directory: string
}

export interface HermesCliInstallation {
  path: string
  version: string
  source: 'managed-runtime' | 'user-cli'
  selected: boolean
  managedRuntimeVersion?: string
  error?: string
}

export interface HermesCliDiscoveryOptions {
  source?: 'all' | HermesCliInstallation['source']
}

function canonicalPath(path: string): string {
  const normalized = normalizeWindowsCommandPath(path)
  try {
    return realpathSync(normalized)
  } catch {
    return resolve(normalized)
  }
}

function comparablePath(path: string): string {
  const canonical = canonicalPath(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function isPathLike(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes('\\')
}

async function findHermesCommandPaths(env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    const lookupArgs = process.platform === 'win32' ? ['hermes'] : ['-a', 'hermes']
    const { stdout } = await execFileAsync(lookupCommand, lookupArgs, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env,
    })
    return String(stdout || '')
      .split(/\r?\n/)
      .map(line => normalizeWindowsCommandPath(line.trim()))
      .filter(Boolean)
  } catch {
    return []
  }
}

function normalizeVersion(raw: string): string {
  const version = raw
    .split(/\r?\n/)[0]
    ?.replace(/^Hermes(?: Agent)?\s+/i, '')
    .trim() || ''
  // An unstamped Hermes compatibility version is not a release identity.
  return /^(?:v?0\.0\.0|unknown)$/i.test(version) ? '' : version
}

function versionProbeError(error: unknown): string {
  const detail = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string | Buffer }
  const stderr = typeof detail?.stderr === 'string'
    ? detail.stderr.trim()
    : Buffer.isBuffer(detail?.stderr) ? detail.stderr.toString('utf8').trim() : ''
  if (detail?.killed || detail?.code === 'ETIMEDOUT') return 'Hermes CLI import probe timed out after 5000ms'
  const code = detail?.code !== undefined ? ` (${String(detail.code)})` : ''
  const message = error instanceof Error ? error.message.replace(/^Error:\s*/, '').trim() : String(error)
  return `Hermes CLI import probe failed${code}: ${stderr || message || 'unknown error'}`
}

function hermesHomeForEnvironment(env: NodeJS.ProcessEnv): string {
  const configured = env.HERMES_HOME?.trim()
  if (configured) return configured
  const userHome = process.platform === 'win32'
    ? env.USERPROFILE?.trim() || homedir()
    : env.HOME?.trim() || homedir()
  return join(userHome, '.hermes')
}

export async function probeHermesCliVersion(
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<{ version: string; error: string }> {
  const installation = resolveHermesInstallationEnvironment(
    path,
    hermesHomeForEnvironment(env),
    env,
  )
  if (!installation.python) {
    return { version: '', error: `Hermes Python executable could not be resolved for ${path}` }
  }

  try {
    const { stdout } = await execFileAsync(installation.python, ['-c', HERMES_VERSION_PROBE], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env,
    })
    const version = normalizeVersion(String(stdout || ''))
    return version
      ? { version, error: '' }
      : { version: '', error: 'Hermes CLI import probe returned an empty version' }
  } catch (error) {
    return { version: '', error: versionProbeError(error) }
  }
}

/**
 * Discover every Hermes CLI visible to the running Studio process.
 *
 * Paths inside a downloaded Desktop Runtime are managed by Studio. Any other
 * installation belongs to the user and is deliberately exposed as read-only.
 */
export async function discoverHermesCliInstallations(
  managedRuntimes: HermesManagedRuntimeLocation[],
  env: NodeJS.ProcessEnv = process.env,
  options: HermesCliDiscoveryOptions = {},
): Promise<HermesCliInstallation[]> {
  const configuredBin = resolveHermesBin(env.HERMES_BIN)
  const commandPaths = await findHermesCommandPaths(env)
  const candidates = [
    ...(isPathLike(configuredBin) ? [configuredBin] : []),
    ...commandPaths,
  ]
  const uniqueCandidates = [...new Map(
    candidates
      .filter(path => path && (existsSync(path) || !isPathLike(path)))
      .map(path => [comparablePath(path), normalizeWindowsCommandPath(path)]),
  ).values()]

  const configuredPath = isPathLike(configuredBin) ? comparablePath(configuredBin) : ''
  const selectedPath = configuredPath && uniqueCandidates.some(path => comparablePath(path) === configuredPath)
    ? configuredPath
    : uniqueCandidates[0] ? comparablePath(uniqueCandidates[0]) : ''

  const installations: HermesCliInstallation[] = []
  for (const path of uniqueCandidates) {
    const canonical = canonicalPath(path)
    const managedRuntime = managedRuntimes.find(runtime => {
      const runtimeDirectory = canonicalPath(runtime.directory)
      return isPathWithin(canonical, runtimeDirectory)
    })
    const source = managedRuntime ? 'managed-runtime' : 'user-cli'
    if (options.source && options.source !== 'all' && options.source !== source) continue
    const probe = await probeHermesCliVersion(path, env)
    installations.push({
      path,
      version: probe.version,
      source,
      selected: comparablePath(path) === selectedPath,
      ...(managedRuntime ? { managedRuntimeVersion: managedRuntime.version } : {}),
      ...(probe.error ? { error: probe.error } : {}),
    })
  }
  return installations
}
