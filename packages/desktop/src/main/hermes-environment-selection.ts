import { execFile } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const HERMES_VERSION_PROBE = "import importlib.util, hermes_cli; assert importlib.util.find_spec('hermes_cli.main'); print(hermes_cli.__version__)"

export type DesktopHermesSelectionSource = 'user-cli' | 'managed-runtime' | 'none'

export interface DesktopHermesSelection {
  source: DesktopHermesSelectionSource
  path: string
  version: string
  pythonPath?: string
  agentRoot?: string
  environmentRoot?: string
  managedRuntimeVersion?: string
  managedRuntimeFailures?: DesktopManagedHermesRuntimeFailure[]
}

export interface DesktopManagedHermesRuntimeFailure {
  directory: string
  version: string
  reason: string
}

export interface DesktopManagedHermesRuntime {
  directory: string
  path: string
  pythonPath: string
  agentRoot: string
  environmentRoot: string
  managedRuntimeVersion?: string
  probePath?: string
  validationError?: string
}

export interface DesktopHermesSelectionOptions {
  env?: NodeJS.ProcessEnv
  searchPath: string
  hermesHome: string
  managedRuntime?: DesktopManagedHermesRuntime
  managedRuntimes?: DesktopManagedHermesRuntime[]
  probeTimeoutMs?: number
}

interface HermesInstallationEnvironment {
  python?: string
  agentRoot?: string
  environmentRoot?: string
}

const HERMES_ENVIRONMENT_KEYS = [
  'HERMES_BIN',
  'HERMES_AGENT_BRIDGE_PYTHON',
  'HERMES_AGENT_CLI_PYTHON',
  'HERMES_AGENT_ROOT',
  'VIRTUAL_ENV',
  'UV_PROJECT_ENVIRONMENT',
  'UV_PYTHON',
  'UV_SYSTEM_PYTHON',
  'HERMES_RUNTIME_SELECTION_LOCKED',
  'HERMES_RUNTIME_SOURCE',
  'HERMES_RUNTIME_VERSION',
  'HERMES_MANAGED_RUNTIME_VERSION',
] as const

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function comparablePath(path: string): string {
  const canonical = canonicalPath(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function isPathWithin(path: string, root: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(path))
  return rel === ''
    || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  return candidates.find(candidate => Boolean(candidate) && existsSync(candidate!))
}

function isPythonExecutable(command: string): boolean {
  return /^(?:python|pypy)(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(command))
}

function launcherContents(hermesBin: string): string[] {
  const candidates = [hermesBin]
  try {
    const real = realpathSync(hermesBin)
    if (real !== hermesBin) candidates.push(real)
  } catch {}

  const contents: string[] = []
  for (const candidate of candidates) {
    try {
      contents.push(readFileSync(candidate, 'utf8'))
    } catch {
      // Native launchers are intentionally handled by the filesystem layout.
    }
  }
  return contents
}

function resolveFromPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined
  const pathValue = env.PATH || env.Path || ''
  const extensions = process.platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(command)
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? `${command}${extension}` : command)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function pythonFromLauncher(hermesBin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const contents of launcherContents(hermesBin)) {
    const firstLine = contents.split(/\r?\n/, 1)[0] || ''
    const shebang = firstLine.match(/^#!\s*(.+)$/)?.[1]?.trim() || ''
    const shebangParts = shebang.split(/\s+/).filter(Boolean)
    const interpreter = shebangParts[0] || ''
    if (isPythonExecutable(interpreter)) {
      const resolved = resolveFromPath(interpreter, env)
      if (resolved) return resolved
    }

    if (/^env(?:\.exe)?$/i.test(basename(interpreter))) {
      const envPython = shebangParts.slice(1).find(part => !part.startsWith('-'))
      if (envPython && isPythonExecutable(envPython)) {
        const resolved = resolveFromPath(envPython, env)
        if (resolved) return resolved
      }
    }

    for (const match of contents.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const candidate = match[1]
      if (isAbsolute(candidate) && isPythonExecutable(candidate) && existsSync(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

function agentRootCandidates(hermesBin: string, hermesHome: string): string[] {
  const binCandidates = [hermesBin]
  try {
    const real = realpathSync(hermesBin)
    if (real !== hermesBin) binCandidates.push(real)
  } catch {}

  const candidates: string[] = []
  for (const candidate of binCandidates) {
    const binDir = dirname(candidate)
    candidates.push(
      resolve(binDir, '..'),
      resolve(binDir, '..', '..'),
      resolve(binDir, '..', 'hermes-agent'),
      resolve(binDir, '..', 'lib', 'hermes-agent'),
      resolve(binDir, '..', '..', 'hermes-agent'),
    )
  }
  candidates.push(join(hermesHome, 'hermes-agent'))
  if (basename(dirname(hermesHome)) === 'profiles') {
    candidates.push(join(resolve(hermesHome, '..', '..'), 'hermes-agent'))
  }
  return [...new Set(candidates)]
}

function pythonCandidates(
  agentRoot: string | undefined,
  hermesBin: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const binDir = dirname(hermesBin)
  const candidates = [
    pythonFromLauncher(hermesBin, env) || '',
    ...(process.platform === 'win32'
      ? [join(binDir, 'python.exe'), join(binDir, 'python3.exe'), join(binDir, '..', 'python.exe')]
      : [join(binDir, 'python3'), join(binDir, 'python')]),
  ]
  if (agentRoot) {
    candidates.push(...(process.platform === 'win32'
      ? [
          join(agentRoot, 'venv', 'Scripts', 'python.exe'),
          join(agentRoot, '.venv', 'Scripts', 'python.exe'),
          join(agentRoot, 'venv', 'python.exe'),
        ]
      : [
          join(agentRoot, 'venv', 'bin', 'python3'),
          join(agentRoot, 'venv', 'bin', 'python'),
          join(agentRoot, '.venv', 'bin', 'python3'),
          join(agentRoot, '.venv', 'bin', 'python'),
        ]))
  }
  return candidates
}

function environmentRootFromPython(python: string | undefined): string | undefined {
  if (!python) return undefined
  const scriptsRoot = dirname(python)
  return /^(?:bin|scripts)$/i.test(basename(scriptsRoot))
    ? dirname(scriptsRoot)
    : dirname(python)
}

export function resolveDesktopHermesInstallationEnvironment(
  hermesBin: string,
  hermesHome: string,
  env: NodeJS.ProcessEnv,
): HermesInstallationEnvironment {
  const launcherPython = firstExisting(pythonCandidates(undefined, hermesBin, env))
  const pythonEnvironmentRoot = environmentRootFromPython(launcherPython)
  const pythonRoot = pythonEnvironmentRoot && /^(?:venv|\.venv)$/i.test(basename(pythonEnvironmentRoot))
    ? dirname(pythonEnvironmentRoot)
    : undefined
  const agentRoot = [
    ...(pythonRoot ? [pythonRoot] : []),
    ...agentRootCandidates(hermesBin, hermesHome),
  ].find(candidate => existsSync(join(candidate, 'run_agent.py')))
  const python = launcherPython || firstExisting(pythonCandidates(agentRoot, hermesBin, env))
  return {
    ...(python ? { python, environmentRoot: environmentRootFromPython(python) } : {}),
    ...(agentRoot ? { agentRoot } : {}),
  }
}

function commandNames(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return ['hermes']
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
  return ['hermes', ...extensions.map(extension => `hermes${extension}`)]
}

function findHermesCommands(searchPath: string, env: NodeJS.ProcessEnv): string[] {
  const commands: string[] = []
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue
    for (const name of commandNames(env)) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) commands.push(candidate)
    }
  }
  return [...new Map(commands.map(command => [comparablePath(command), command])).values()]
}

function normalizeVersion(raw: string): string {
  return raw
    .split(/\r?\n/)[0]
    ?.replace(/^Hermes(?: Agent)?\s+/i, '')
    .trim() || ''
}

type HermesVersionProbeResult =
  | { ok: true; version: string }
  | { ok: false; error: string }

function probeFailureMessage(error: unknown, timeout: number): string {
  const detail = error as NodeJS.ErrnoException & {
    killed?: boolean
    signal?: NodeJS.Signals
    stderr?: string | Buffer
  }
  const stderr = typeof detail?.stderr === 'string'
    ? detail.stderr.trim()
    : Buffer.isBuffer(detail?.stderr)
      ? detail.stderr.toString('utf8').trim()
      : ''
  if (detail?.killed || detail?.code === 'ETIMEDOUT') {
    return `Hermes CLI import probe timed out after ${timeout}ms${stderr ? `: ${stderr}` : ''}`
  }
  const code = detail?.code !== undefined ? ` (${String(detail.code)})` : ''
  const message = error instanceof Error ? error.message.replace(/^Error:\s*/, '').trim() : String(error)
  return `Hermes CLI import probe failed${code}: ${stderr || message || 'unknown error'}`
}

async function probeHermesVersion(
  selection: Omit<DesktopHermesSelection, 'version' | 'source'>,
  env: NodeJS.ProcessEnv,
  timeout: number,
  source: Exclude<DesktopHermesSelectionSource, 'none'>,
): Promise<HermesVersionProbeResult> {
  if (!selection.pythonPath) return { ok: false, error: 'Python path is not configured' }
  if (!selection.agentRoot) return { ok: false, error: 'Agent Root is not configured' }
  if (!selection.environmentRoot) return { ok: false, error: 'Python environment root is not configured' }
  const probeEnv = withDesktopHermesSelection(env, {
    ...selection,
    source,
    version: '',
  })
  try {
    const { stdout } = await execFileAsync(selection.pythonPath, ['-c', HERMES_VERSION_PROBE], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: probeEnv,
    })
    const version = normalizeVersion(String(stdout || ''))
    return version
      ? { ok: true, version }
      : { ok: false, error: 'Hermes CLI import probe returned an empty version' }
  } catch (error) {
    return { ok: false, error: probeFailureMessage(error, timeout) }
  }
}

function managedRuntimePreflightError(runtime: DesktopManagedHermesRuntime): string {
  if (runtime.validationError) return runtime.validationError
  if (!existsSync(runtime.path)) return `Hermes executable is missing: ${runtime.path}`
  if (!existsSync(runtime.pythonPath)) return `Python executable is missing: ${runtime.pythonPath}`
  return ''
}

function missingManagedRuntimeAgentFiles(runtime: DesktopManagedHermesRuntime): string[] {
  return ['run_agent.py', 'cli.py']
    .map(name => join(runtime.agentRoot, name))
    .filter(file => !existsSync(file))
}

function completeUserCliSelection(
  path: string,
  hermesHome: string,
  env: NodeJS.ProcessEnv,
): Omit<DesktopHermesSelection, 'version' | 'source'> | null {
  const installation = resolveDesktopHermesInstallationEnvironment(path, hermesHome, env)
  if (!installation.python || !installation.agentRoot || !installation.environmentRoot) return null
  return {
    path,
    pythonPath: installation.python,
    agentRoot: installation.agentRoot,
    environmentRoot: installation.environmentRoot,
  }
}

export async function resolveDesktopHermesSelection(
  options: DesktopHermesSelectionOptions,
): Promise<DesktopHermesSelection> {
  const baseEnv = { ...(options.env || process.env) }
  const pathKey = Object.keys(baseEnv).find(key => key.toLowerCase() === 'path')
    || (process.platform === 'win32' ? 'Path' : 'PATH')
  baseEnv[pathKey] = options.searchPath
  const explicitCommand = baseEnv.HERMES_BIN?.trim()
  const managedRuntimes = options.managedRuntimes?.length
    ? options.managedRuntimes
    : options.managedRuntime ? [options.managedRuntime] : []
  const managedRoots = managedRuntimes.map(runtime => runtime.directory).filter(Boolean)
  const commands = [
    ...(explicitCommand && existsSync(explicitCommand) ? [explicitCommand] : []),
    ...findHermesCommands(options.searchPath, baseEnv),
  ]
  const userCommands = [...new Map(commands
    .filter(command => !managedRoots.some(root => isPathWithin(command, root)))
    .map(command => [comparablePath(command), command])).values()]
  const timeout = options.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS
  const userCandidates = userCommands
    .map(command => completeUserCliSelection(command, options.hermesHome, baseEnv))
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
  for (const candidate of userCandidates) {
    const probe = await probeHermesVersion(candidate, baseEnv, timeout, 'user-cli')
    if (probe.ok) {
      return {
        ...candidate,
        source: 'user-cli',
        version: probe.version,
      }
    }
  }

  const managedRuntimeFailures: DesktopManagedHermesRuntimeFailure[] = []
  for (const managed of managedRuntimes) {
    const preflightError = managedRuntimePreflightError(managed)
    if (preflightError) {
      managedRuntimeFailures.push({
        directory: managed.directory,
        version: managed.managedRuntimeVersion || '',
        reason: preflightError,
      })
      continue
    }

    const managedEnv = { ...baseEnv }
    if (managed.probePath) managedEnv[pathKey] = managed.probePath
    const probe = await probeHermesVersion(managed, managedEnv, timeout, 'managed-runtime')
    if (probe.ok) {
      const missingAgentFiles = missingManagedRuntimeAgentFiles(managed)
      if (missingAgentFiles.length > 0) {
        managedRuntimeFailures.push({
          directory: managed.directory,
          version: managed.managedRuntimeVersion || '',
          reason: `Runtime Agent files are missing: ${missingAgentFiles.join(', ')}`,
        })
        continue
      }
      return {
        ...managed,
        source: 'managed-runtime',
        version: probe.version,
        ...(managedRuntimeFailures.length > 0 ? { managedRuntimeFailures } : {}),
      }
    }
    managedRuntimeFailures.push({
      directory: managed.directory,
      version: managed.managedRuntimeVersion || '',
      reason: probe.error,
    })
  }

  return {
    source: 'none',
    path: '',
    version: '',
    ...(managedRuntimeFailures.length > 0 ? { managedRuntimeFailures } : {}),
  }
}

export function withDesktopHermesSelection(
  baseEnv: NodeJS.ProcessEnv,
  selection: DesktopHermesSelection,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv }
  for (const name of HERMES_ENVIRONMENT_KEYS) delete env[name]
  env.HERMES_RUNTIME_SELECTION_LOCKED = 'true'
  env.HERMES_RUNTIME_SOURCE = selection.source
  env.HERMES_RUNTIME_VERSION = selection.version

  if (selection.source === 'none') return env

  env.HERMES_BIN = selection.path
  if (selection.pythonPath) {
    env.HERMES_AGENT_BRIDGE_PYTHON = selection.pythonPath
    env.HERMES_AGENT_CLI_PYTHON = selection.pythonPath
    env.UV_PYTHON = selection.pythonPath
    if (process.platform !== 'win32') env.UV_SYSTEM_PYTHON = '1'
  }
  if (selection.agentRoot) env.HERMES_AGENT_ROOT = selection.agentRoot
  if (selection.environmentRoot) {
    env.VIRTUAL_ENV = selection.environmentRoot
    env.UV_PROJECT_ENVIRONMENT = selection.environmentRoot
  }
  if (selection.managedRuntimeVersion) {
    env.HERMES_MANAGED_RUNTIME_VERSION = selection.managedRuntimeVersion
  }
  return env
}
