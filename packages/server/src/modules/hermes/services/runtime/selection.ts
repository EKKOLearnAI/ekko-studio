import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import {
  discoverHermesCliInstallations,
  probeHermesCliVersion,
  type HermesCliInstallation,
} from './discovery'
import { resolveHermesInstallationEnvironment } from './installation'
import { isPathWithin } from './path'
import {
  listRuntimeVersionCandidates,
  readActiveVersionManifest,
  recordRuntimeSelectionResult,
  type InstalledRuntimeVersion,
} from './version-manager'

export interface HermesRuntimeSelection {
  source: 'user-cli' | 'managed-runtime' | 'none'
  path: string
  version: string
  managedRuntimeVersion?: string
  pythonPath?: string
  agentRoot?: string
}

function desktopSelectionLocked(env: NodeJS.ProcessEnv): boolean {
  return env.HERMES_DESKTOP?.trim().toLowerCase() === 'true'
    && env.HERMES_RUNTIME_SELECTION_LOCKED?.trim().toLowerCase() === 'true'
}

export function readLockedDesktopHermesSelection(
  env: NodeJS.ProcessEnv = process.env,
): HermesRuntimeSelection | null {
  if (!desktopSelectionLocked(env)) return null
  const source = env.HERMES_RUNTIME_SOURCE?.trim()
  if (source === 'none') return { source: 'none', path: '', version: '' }
  if (source !== 'user-cli' && source !== 'managed-runtime') return null

  const path = env.HERMES_BIN?.trim() || ''
  const version = env.HERMES_RUNTIME_VERSION?.trim() || ''
  if (!path || !version) return null
  const pythonPath = env.HERMES_AGENT_CLI_PYTHON?.trim()
    || env.HERMES_AGENT_BRIDGE_PYTHON?.trim()
    || ''
  const agentRoot = env.HERMES_AGENT_ROOT?.trim() || ''
  const managedRuntimeVersion = env.HERMES_MANAGED_RUNTIME_VERSION?.trim()
    || (source === 'managed-runtime' ? version : '')
  return {
    source,
    path,
    version,
    ...(managedRuntimeVersion ? { managedRuntimeVersion } : {}),
    ...(pythonPath ? { pythonPath } : {}),
    ...(agentRoot ? { agentRoot } : {}),
  }
}

function prependPath(env: NodeJS.ProcessEnv, entries: string[]): void {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
    || (process.platform === 'win32' ? 'Path' : 'PATH')
  const current = env[pathKey] || ''
  const seen = new Set<string>()
  const merged = [...entries, ...current.split(delimiter)]
    .map(entry => entry.trim())
    .filter(entry => {
      if (!entry) return false
      const key = process.platform === 'win32' ? entry.toLowerCase() : entry
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  env[pathKey] = merged.join(delimiter)
}

function clearManagedRuntimeEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of [
    'HERMES_BIN',
    'HERMES_AGENT_BRIDGE_PYTHON',
    'HERMES_AGENT_CLI_PYTHON',
    'HERMES_AGENT_ROOT',
    'HERMES_AGENT_NODE',
    'HERMES_AGENT_NODE_ROOT',
    'HERMES_AGENT_GIT',
    'HERMES_RUNTIME_SOURCE',
    'HERMES_RUNTIME_VERSION',
    'HERMES_MANAGED_RUNTIME_VERSION',
    'VIRTUAL_ENV',
    'UV_PROJECT_ENVIRONMENT',
    'UV_PYTHON',
    'UV_SYSTEM_PYTHON',
  ]) {
    delete env[name]
  }
}

function removeManagedRuntimePathEntries(
  env: NodeJS.ProcessEnv,
  runtimes: InstalledRuntimeVersion[],
): void {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
    || (process.platform === 'win32' ? 'Path' : 'PATH')
  env[pathKey] = (env[pathKey] || '')
    .split(delimiter)
    .filter(entry => entry && !runtimes.some(runtime => isPathWithin(entry, runtime.directory)))
    .join(delimiter)

  for (const name of ['AGENT_BROWSER_HOME', 'PLAYWRIGHT_BROWSERS_PATH'] as const) {
    const value = env[name]?.trim()
    if (value && runtimes.some(runtime => isPathWithin(value, runtime.directory))) delete env[name]
  }
}

function prepareRuntimeSelectionEnvironment(
  env: NodeJS.ProcessEnv,
  runtimes: InstalledRuntimeVersion[],
): void {
  clearManagedRuntimeEnvironment(env)
  removeManagedRuntimePathEntries(env, runtimes)
}

function hermesHomeForEnvironment(env: NodeJS.ProcessEnv): string {
  const configured = env.HERMES_HOME?.trim()
  if (configured) return configured
  const userHome = process.platform === 'win32'
    ? env.USERPROFILE?.trim() || homedir()
    : env.HOME?.trim() || homedir()
  return join(userHome, '.hermes')
}

function addUserHermesBinDirectory(env: NodeJS.ProcessEnv): void {
  if (process.platform === 'win32') return
  const userHome = env.HOME?.trim() || homedir()
  prependPath(env, [join(userHome, '.local', 'bin')])
}

function pythonEnvironmentRoot(runtimeDirectory: string): string {
  const sourceRoot = join(runtimeDirectory, 'python')
  const venvRoot = join(sourceRoot, 'venv')
  const candidates = process.platform === 'win32'
    ? [join(venvRoot, 'Scripts', 'python.exe'), join(venvRoot, 'python.exe')]
    : [join(venvRoot, 'bin', 'python3')]
  return candidates.some(existsSync) ? venvRoot : sourceRoot
}

function managedRuntimePaths(runtime: InstalledRuntimeVersion) {
  const runtimeDirectory = runtime.directory
  const pythonRoot = join(runtimeDirectory, 'python')
  const environmentRoot = pythonEnvironmentRoot(runtimeDirectory)
  const scriptsRoot = process.platform === 'win32'
    ? join(environmentRoot, 'Scripts')
    : join(environmentRoot, 'bin')
  const python = process.platform === 'win32'
    ? (existsSync(join(scriptsRoot, 'python.exe')) ? join(scriptsRoot, 'python.exe') : join(environmentRoot, 'python.exe'))
    : join(scriptsRoot, 'python3')
  const commandWrapper = join(scriptsRoot, 'hermes.cmd')
  const commandExecutable = join(scriptsRoot, 'hermes.exe')
  const hermes = process.platform === 'win32'
    ? (existsSync(commandWrapper) || !existsSync(commandExecutable) ? commandWrapper : commandExecutable)
    : join(scriptsRoot, 'hermes')
  const nodeRoot = join(runtimeDirectory, 'node')
  const nodeBin = process.platform === 'win32' ? nodeRoot : join(nodeRoot, 'bin')
  const node = process.platform === 'win32' ? join(nodeRoot, 'node.exe') : join(nodeBin, 'node')
  const git = process.platform === 'win32' ? join(runtimeDirectory, 'git', 'cmd', 'git.exe') : ''
  return { pythonRoot, environmentRoot, scriptsRoot, python, hermes, nodeRoot, nodeBin, node, git }
}

function applyUserCli(env: NodeJS.ProcessEnv, installation: HermesCliInstallation): HermesRuntimeSelection {
  const paths = resolveHermesInstallationEnvironment(
    installation.path,
    hermesHomeForEnvironment(env),
    env,
  )
  clearManagedRuntimeEnvironment(env)
  env.HERMES_BIN = installation.path
  env.HERMES_RUNTIME_SOURCE = 'user-cli'
  env.HERMES_RUNTIME_VERSION = installation.version
  if (paths.python) {
    env.HERMES_AGENT_BRIDGE_PYTHON = paths.python
    env.HERMES_AGENT_CLI_PYTHON = paths.python
    env.UV_PYTHON = paths.python
    if (process.platform !== 'win32') env.UV_SYSTEM_PYTHON = '1'
  }
  if (paths.agentRoot) env.HERMES_AGENT_ROOT = paths.agentRoot
  if (paths.environmentRoot) {
    env.VIRTUAL_ENV = paths.environmentRoot
    env.UV_PROJECT_ENVIRONMENT = paths.environmentRoot
  }
  prependPath(env, [dirname(installation.path), paths.python ? dirname(paths.python) : ''])
  return {
    source: 'user-cli',
    path: installation.path,
    version: installation.version,
    ...(paths.python ? { pythonPath: paths.python } : {}),
    ...(paths.agentRoot ? { agentRoot: paths.agentRoot } : {}),
  }
}

function applyManagedRuntime(env: NodeJS.ProcessEnv, runtime: InstalledRuntimeVersion): HermesRuntimeSelection {
  const paths = managedRuntimePaths(runtime)
  clearManagedRuntimeEnvironment(env)
  env.HERMES_BIN = paths.hermes
  env.HERMES_RUNTIME_SOURCE = 'managed-runtime'
  env.HERMES_RUNTIME_VERSION = runtime.manifestHermesRuntimeVersion || runtime.version
  env.HERMES_MANAGED_RUNTIME_VERSION = runtime.version
  env.HERMES_AGENT_BRIDGE_PYTHON = paths.python
  env.HERMES_AGENT_CLI_PYTHON = paths.python
  env.HERMES_AGENT_ROOT = paths.pythonRoot
  env.VIRTUAL_ENV = paths.environmentRoot
  env.UV_PROJECT_ENVIRONMENT = paths.environmentRoot
  env.UV_PYTHON = paths.python
  if (process.platform !== 'win32') env.UV_SYSTEM_PYTHON = '1'
  env.HERMES_AGENT_NODE = paths.node
  env.HERMES_AGENT_NODE_ROOT = paths.nodeRoot
  env.AGENT_BROWSER_HOME ||= join(paths.pythonRoot, 'agent-browser')
  env.PLAYWRIGHT_BROWSERS_PATH ||= join(paths.pythonRoot, 'ms-playwright')
  if (paths.git && existsSync(paths.git)) env.HERMES_AGENT_GIT = paths.git
  prependPath(env, [paths.scriptsRoot, paths.nodeBin, paths.git ? dirname(paths.git) : ''])
  return {
    source: 'managed-runtime',
    path: paths.hermes,
    version: runtime.manifestHermesRuntimeVersion || runtime.version,
    managedRuntimeVersion: runtime.version,
    pythonPath: paths.python,
    agentRoot: paths.pythonRoot,
  }
}

/**
 * Select the Hermes executable for this server process.
 *
 * A usable user-owned CLI always wins. A visible CLI that cannot report its
 * version is not safe to run from this process environment, so fall back to
 * Studio Runtime instead.
 */
export async function configurePreferredHermesRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesRuntimeSelection> {
  const lockedDesktopSelection = readLockedDesktopHermesSelection(env)
  if (lockedDesktopSelection) return lockedDesktopSelection

  addUserHermesBinDirectory(env)
  const active = readActiveVersionManifest()
  const runtimeCandidates = listRuntimeVersionCandidates(active)
  const installations = await discoverHermesCliInstallations(runtimeCandidates, env, { source: 'user-cli' })
  const userCli = installations.find(item =>
    item.source === 'user-cli'
    && Boolean(item.path)
    && Boolean(item.version.trim()),
  )
  if (userCli) {
    prepareRuntimeSelectionEnvironment(env, runtimeCandidates)
    return applyUserCli(env, userCli)
  }

  const currentPlatform = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform}-${process.arch}`
  const managedFailures: Array<{
    directory: string
    reason: string
    version: string
    platform: string
  }> = []
  const cleanEnvironment = { ...env }
  prepareRuntimeSelectionEnvironment(cleanEnvironment, runtimeCandidates)
  for (const runtime of runtimeCandidates) {
    if (runtime.platform !== currentPlatform) {
      managedFailures.push({
        directory: runtime.directory,
        reason: `Runtime platform mismatch: expected ${currentPlatform}, received ${runtime.platform}`,
        version: runtime.version,
        platform: runtime.platform,
      })
      continue
    }
    if (runtime.validationError) {
      managedFailures.push({
        directory: runtime.directory,
        reason: runtime.validationError,
        version: runtime.version,
        platform: runtime.platform,
      })
      continue
    }

    const candidateEnv = { ...cleanEnvironment }
    const candidateSelection = applyManagedRuntime(candidateEnv, runtime)
    const probe = await probeHermesCliVersion(candidateSelection.path, candidateEnv)
    if (!probe.version) {
      managedFailures.push({
        directory: runtime.directory,
        reason: probe.error || 'Hermes CLI import probe failed',
        version: runtime.version,
        platform: runtime.platform,
      })
      continue
    }
    const missingAgentFiles = ['run_agent.py', 'cli.py']
      .map(name => join(runtime.directory, 'python', name))
      .filter(file => !existsSync(file))
    if (missingAgentFiles.length > 0) {
      managedFailures.push({
        directory: runtime.directory,
        reason: `Runtime Agent files are missing: ${missingAgentFiles.join(', ')}`,
        version: runtime.version,
        platform: runtime.platform,
      })
      continue
    }

    prepareRuntimeSelectionEnvironment(env, runtimeCandidates)
    const selected = applyManagedRuntime(env, runtime)
    selected.version = probe.version
    env.HERMES_RUNTIME_VERSION = probe.version
    recordRuntimeSelectionResult(managedFailures, runtime)
    return selected
  }

  recordRuntimeSelectionResult(managedFailures)
  prepareRuntimeSelectionEnvironment(env, runtimeCandidates)
  env.HERMES_RUNTIME_SOURCE = 'none'
  env.HERMES_RUNTIME_VERSION = ''
  return { source: 'none', path: '', version: '' }
}
