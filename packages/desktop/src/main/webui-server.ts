import { ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, delimiter, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  bundledAgentBrowserHome,
  bundledGit,
  bundledNode,
  bundledPython,
  gitPathDirs,
  clearActiveWebUiDirectory,
  defaultWebuiDir,
  desktopRuntimeDir,
  webuiServerEntryFor,
  webuiDir,
  hermesBin,
  webUiHome,
  hermesHome,
  nodeBinDir,
  tokenFile,
  pythonDir,
  pythonEnvironmentDir,
  recordRuntimeSelectionResult,
  runtimePlatformKey,
  runtimeStorageRoot,
} from './paths'
import {
  resolveDesktopHermesSelection,
  withDesktopHermesSelection,
  type DesktopManagedHermesRuntime,
} from './hermes-environment-selection'
import { canBindTcpPort, releaseOccupiedWebUiPort } from './webui-port'
import { WebUiStartupDiagnostics } from './webui-startup-diagnostics'

const DEFAULT_PORT = 8748
const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_FULL_STARTUP_WAIT_MS = 0
const DEFAULT_STOP_TIMEOUT_MS = 20_000
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 18_000
const FORCE_KILL_COMMAND_TIMEOUT_MS = 5_000
const AGENT_BRIDGE_STARTED_MARKER = '[bootstrap] agent bridge started'
const AGENT_BRIDGE_FAILED_MARKER = '[bootstrap] agent bridge failed to start'
const DESKTOP_RESTART_REQUEST = 'hermes-desktop:restart-app'
const execFileAsync = promisify(execFile)

let serverProc: ChildProcess | null = null
let cachedToken: string | null = null
let currentServerPort = DEFAULT_PORT
let unexpectedExitHandler: ((details: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null
let restartRequestHandler: (() => void) | null = null

export function setWebUiUnexpectedExitHandler(
  handler: ((details: { code: number | null; signal: NodeJS.Signals | null }) => void) | null,
): void {
  unexpectedExitHandler = handler
}

export function setWebUiRestartRequestHandler(handler: (() => void) | null): void {
  restartRequestHandler = handler
}

function isDesktopRestartRequest(message: unknown): boolean {
  return Boolean(
    message
    && typeof message === 'object'
    && (message as { type?: unknown }).type === DESKTOP_RESTART_REQUEST,
  )
}

function posixDescendantPids(rootPid: number): number[] {
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], {
      encoding: 'utf-8',
      timeout: 5_000,
    })
    const children = new Map<number, number[]>()
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!match) continue
      const pid = Number(match[1])
      const parentPid = Number(match[2])
      children.set(parentPid, [...(children.get(parentPid) || []), pid])
    }
    const descendants: number[] = []
    const visit = (parentPid: number) => {
      for (const pid of children.get(parentPid) || []) {
        visit(pid)
        descendants.push(pid)
      }
    }
    visit(rootPid)
    return descendants
  } catch {
    return []
  }
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        encoding: 'utf-8',
        timeout: FORCE_KILL_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      })
      return
    } catch {
      /* fall through */
    }
  } else {
    for (const pid of posixDescendantPids(proc.pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already exited */
      }
    }
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function readyTimeoutMs(): number {
  return envPositiveInt('HERMES_DESKTOP_READY_TIMEOUT_MS') || DEFAULT_READY_TIMEOUT_MS
}

function fullStartupWaitMs(): number {
  const raw = process.env.HERMES_DESKTOP_FULL_STARTUP_WAIT_MS
  if (raw === undefined) return DEFAULT_FULL_STARTUP_WAIT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_FULL_STARTUP_WAIT_MS
}

function gracefulStopTimeoutMs(): number {
  return envPositiveInt('HERMES_DESKTOP_GRACEFUL_STOP_TIMEOUT_MS') || DEFAULT_GRACEFUL_STOP_TIMEOUT_MS
}

function timeoutAfter(ms: number, message: string): Promise<void> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
}

function createAgentBridgeStartupTracker(): {
  observe: (chunk: Buffer) => void
  wait: (timeoutMs: number) => Promise<void>
} {
  let output = ''
  let state: 'pending' | 'started' | 'failed' = 'pending'
  let resolveReady: (() => void) | null = null
  let rejectReady: ((err: Error) => void) | null = null

  const settle = (nextState: 'started' | 'failed') => {
    if (state !== 'pending') return
    state = nextState
    if (nextState === 'started') {
      resolveReady?.()
    } else {
      rejectReady?.(new Error('Agent bridge failed to start'))
    }
  }

  const observe = (chunk: Buffer) => {
    if (state !== 'pending') return
    output = (output + chunk.toString('utf-8')).slice(-4096)
    if (output.includes(AGENT_BRIDGE_STARTED_MARKER)) {
      settle('started')
    } else if (output.includes(AGENT_BRIDGE_FAILED_MARKER)) {
      settle('failed')
    }
  }

  const wait = (timeoutMs: number) => {
    if (state === 'started') return Promise.resolve()
    if (state === 'failed') return Promise.reject(new Error('Agent bridge failed to start'))

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state !== 'pending') return
        state = 'failed'
        reject(new Error(`Agent bridge did not become ready within ${timeoutMs}ms`))
      }, timeoutMs)

      resolveReady = () => {
        clearTimeout(timer)
        resolve()
      }
      rejectReady = (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  return { observe, wait }
}

function ensureToken(): string {
  if (cachedToken) return cachedToken
  const file = tokenFile()
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    cachedToken = readFileSync(file, 'utf-8').trim()
    if (cachedToken) return cachedToken
  }
  cachedToken = randomBytes(32).toString('hex')
  writeFileSync(file, cachedToken + '\n', { mode: 0o600 })
  return cachedToken
}

// node-pty ships per-platform prebuilds with a `spawn-helper` binary that
// loses its +x bit when copied across some filesystems. Restore it.
function ensureNativeModules() {
  try {
    const helper = join(
      webuiDir(),
      'node_modules',
      'node-pty',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    )
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    /* ignore */
  }
}

const COMMON_USER_BIN_DIRS = process.platform === 'win32'
  ? []
  : [
      join(homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]
const PATH_MARKER_START = '__HERMES_DESKTOP_PATH_START__'
const PATH_MARKER_END = '__HERMES_DESKTOP_PATH_END__'

function mergePathEntries(...paths: Array<string | undefined | null>): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const rawPath of paths) {
    if (!rawPath) continue
    for (const entry of rawPath.split(delimiter)) {
      const trimmed = entry.trim()
      if (!trimmed) continue
      const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(trimmed)
    }
  }
  return entries.join(delimiter)
}

type ManagedRuntimeCandidate = DesktopManagedHermesRuntime & {
  agentBrowserBin: string
  agentBrowserHome: string
  nodeBin: string
  nodePath: string
  gitBin?: string
  gitPath: string
  playwrightBrowsers: string
}

type RuntimeManifestSummary = {
  schema?: number
  platform?: string
  hermesAgentVersion?: string
  hermesSource?: {
    repository?: string
    ref?: string
    commit?: string
    installMethod?: string
  }
  asset?: { name?: string }
}

function readRuntimeManifestSummary(directory: string): RuntimeManifestSummary | null {
  try {
    return JSON.parse(readFileSync(join(directory, 'runtime-manifest.json'), 'utf8')) as RuntimeManifestSummary
  } catch {
    return null
  }
}

function runtimeVersionFromManifest(directory: string, fallback = ''): string {
  const manifest = readRuntimeManifestSummary(directory)
  if (manifest?.hermesAgentVersion?.trim()) return manifest.hermesAgentVersion.trim()
  const assetName = manifest?.asset?.name || ''
  return assetName.match(/hermes-agent-([^-]+)-/)?.[1] || fallback
}

function validateManagedRuntimeCandidate(
  candidate: ManagedRuntimeCandidate,
  requireManifest: boolean,
): string {
  const requiredGroups: Array<{ label: string; paths: string[] }> = [
    { label: 'Python executable', paths: [candidate.pythonPath] },
    { label: 'Hermes executable', paths: [candidate.path] },
    { label: 'Node executable', paths: [candidate.nodePath] },
  ]
  if (process.platform === 'win32') {
    requiredGroups.push({ label: 'Git executable', paths: [candidate.gitBin || join(candidate.directory, 'git', 'cmd', 'git.exe')] })
  }
  const missing = requiredGroups.filter(group => !group.paths.some(existsSync))
  if (missing.length > 0) {
    return missing.map(group => `${group.label} is missing: ${group.paths.join(' or ')}`).join('; ')
  }
  if (!requireManifest) return ''

  const manifest = readRuntimeManifestSummary(candidate.directory)
  if (!manifest) return `Runtime manifest is missing or invalid: ${join(candidate.directory, 'runtime-manifest.json')}`
  const expectedPlatform = runtimePlatformKey()
  if (manifest.platform && manifest.platform !== expectedPlatform) {
    return `Runtime platform mismatch: expected ${expectedPlatform}, received ${manifest.platform}`
  }
  if ((manifest.schema || 0) >= 2) {
    const sourceFiles = [
      join(candidate.agentRoot, '.git', 'HEAD'),
      join(candidate.agentRoot, 'pyproject.toml'),
    ]
    const missingSourceFiles = sourceFiles.filter(file => !existsSync(file))
    if (missingSourceFiles.length > 0) {
      return `Runtime updateable source files are missing: ${missingSourceFiles.join(', ')}`
    }
    if (manifest.hermesSource?.installMethod !== 'git'
      || !manifest.hermesSource.repository
      || !manifest.hermesSource.ref
      || !/^[0-9a-f]{40}$/i.test(manifest.hermesSource.commit || '')) {
      return 'Runtime Hermes Git source metadata is invalid'
    }
  }
  return ''
}

function directManagedRuntimeCandidate(
  directory: string,
  version: string,
  userSearchPath: string,
): ManagedRuntimeCandidate {
  const agentRoot = join(directory, 'python')
  const venvRoot = join(agentRoot, 'venv')
  const environmentRoot = process.platform === 'win32'
    ? [join(venvRoot, 'Scripts', 'python.exe'), join(venvRoot, 'python.exe')].some(existsSync) ? venvRoot : agentRoot
    : existsSync(join(venvRoot, 'bin', 'python3')) ? venvRoot : agentRoot
  const pythonPath = process.platform === 'win32'
    ? existsSync(join(environmentRoot, 'Scripts', 'python.exe'))
      ? join(environmentRoot, 'Scripts', 'python.exe')
      : join(environmentRoot, 'python.exe')
    : join(environmentRoot, 'bin', 'python3')
  const commandWrapper = join(environmentRoot, 'Scripts', 'hermes.cmd')
  const executable = join(environmentRoot, 'Scripts', 'hermes.exe')
  const path = process.platform === 'win32'
    ? existsSync(commandWrapper) || !existsSync(executable) ? commandWrapper : executable
    : join(environmentRoot, 'bin', 'hermes')
  const nodeBin = process.platform === 'win32' ? join(directory, 'node') : join(directory, 'node', 'bin')
  const nodePath = process.platform === 'win32' ? join(nodeBin, 'node.exe') : join(nodeBin, 'node')
  const gitBin = process.platform === 'win32' ? join(directory, 'git', 'cmd', 'git.exe') : undefined
  const gitPath = process.platform === 'win32'
    ? [join(directory, 'git', 'cmd'), join(directory, 'git', 'mingw64', 'bin')].filter(existsSync).join(delimiter)
    : ''
  const agentBrowserHome = join(agentRoot, 'agent-browser')
  const agentBrowserBin = process.platform === 'win32'
    ? join(agentRoot, 'node')
    : join(agentRoot, 'node', 'bin')
  const candidate: ManagedRuntimeCandidate = {
    directory,
    path,
    pythonPath,
    agentRoot,
    environmentRoot,
    managedRuntimeVersion: runtimeVersionFromManifest(directory, version),
    agentBrowserBin,
    agentBrowserHome,
    nodeBin,
    nodePath,
    gitBin,
    gitPath,
    playwrightBrowsers: join(agentRoot, 'ms-playwright'),
    probePath: mergePathEntries(dirname(path), dirname(pythonPath), agentBrowserBin, nodeBin, gitPath, userSearchPath),
  }
  candidate.validationError = validateManagedRuntimeCandidate(candidate, true)
  return candidate
}

function managedRuntimeCandidates(
  primary: ManagedRuntimeCandidate,
  userSearchPath: string,
): ManagedRuntimeCandidate[] {
  if (process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()) return [primary]

  const currentPlatform = runtimePlatformKey()
  const root = join(runtimeStorageRoot(), 'hermes')
  let versionDirectories: Array<{ version: string; directory: string }> = []
  try {
    versionDirectories = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({ version: entry.name, directory: join(root, entry.name, currentPlatform) }))
      .filter(item => existsSync(item.directory))
      .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
  } catch {
    // Missing Runtime storage is a normal first-launch state.
  }

  const candidates: ManagedRuntimeCandidate[] = []
  const seen = new Set<string>()
  const validationFailures = new Map<string, string>()
  try {
    const active = JSON.parse(readFileSync(join(webUiHome(), 'desktop-runtime', 'active-version.json'), 'utf8')) as {
      runtimeDirectory?: string
      hermesRuntimeVersion?: string
      platform?: string
      runtimeValidationFailures?: Array<{ directory?: string; reason?: string }>
    }
    for (const failure of active.runtimeValidationFailures || []) {
      if (failure.directory?.trim()) {
        validationFailures.set(resolve(failure.directory), failure.reason || 'Runtime validation failed')
      }
    }
    const activeDirectory = active.runtimeDirectory?.trim()
    if (activeDirectory) {
      const activeCandidate = directManagedRuntimeCandidate(
        activeDirectory,
        active.hermesRuntimeVersion || basename(dirname(activeDirectory)),
        userSearchPath,
      )
      activeCandidate.validationError ||= validationFailures.get(resolve(activeDirectory))
      candidates.push(activeCandidate)
      seen.add(resolve(activeCandidate.directory))
    }
  } catch {
    // A missing active selection is a normal first-launch state.
  }
  if (!seen.has(resolve(primary.directory))) {
    primary.validationError ||= validationFailures.get(resolve(primary.directory))
    candidates.push(primary)
    seen.add(resolve(primary.directory))
  }
  for (const item of versionDirectories) {
    const key = resolve(item.directory)
    if (seen.has(key)) continue
    seen.add(key)
    const candidate = directManagedRuntimeCandidate(item.directory, item.version, userSearchPath)
    candidate.validationError ||= validationFailures.get(key)
    candidates.push(candidate)
  }
  return candidates
}

function extractMarkedPath(output: string): string | null {
  const start = output.lastIndexOf(PATH_MARKER_START)
  const end = output.lastIndexOf(PATH_MARKER_END)
  if (start < 0 || end <= start) return null
  const value = output.slice(start + PATH_MARKER_START.length, end).trim()
  return value || null
}

function compareNodeVersionDesc(left: string, right: string): number {
  const leftParts = left.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const rightParts = right.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (rightParts[index] || 0) - (leftParts[index] || 0)
    if (diff !== 0) return diff
  }
  return right.localeCompare(left)
}

function getNvmNodeBinPaths(): string {
  if (process.platform === 'win32') return ''

  const nvmDir = process.env.NVM_DIR?.trim() || join(homedir(), '.nvm')
  const versionsDir = join(nvmDir, 'versions', 'node')
  if (!existsSync(versionsDir)) return ''

  try {
    return readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(compareNodeVersionDesc)
      .map(version => join(versionsDir, version, 'bin'))
      .filter(binDir => existsSync(binDir))
      .join(delimiter)
  } catch {
    return ''
  }
}

async function getLoginShellPath(): Promise<string | null> {
  if (process.platform === 'win32') return null

  const shell = process.env.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  if (!existsSync(shell)) return null

  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-c', `printf '\\n${PATH_MARKER_START}%s${PATH_MARKER_END}\\n' "$PATH"`], {
      encoding: 'utf-8',
      timeout: 1500,
      windowsHide: true,
      env: process.env,
    })
    return extractMarkedPath(stdout) || stdout.trim() || null
  } catch {
    return null
  }
}

export function getToken(): string {
  return ensureToken()
}

export function getServerUrl(port = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}`
}

async function getFreeTcpPort(): Promise<number> {
  return await new Promise((resolveFreePort, rejectFreePort) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectFreePort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolveFreePort(address.port)
        } else {
          rejectFreePort(new Error('Unable to allocate local TCP port'))
        }
      })
    })
  })
}

async function getFreeTcpPortInRange(min: number, max: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = min + (randomBytes(2).readUInt16BE(0) % (max - min + 1))
    // Bridge workers use tcp://127.0.0.1, so keep the probe on the same
    // loopback address instead of reserving an IPv4 wildcard port.
    if (await canBindTcpPort(port, '127.0.0.1')) return port
  }
  return getFreeTcpPort()
}

export async function startWebUiServer(port = DEFAULT_PORT): Promise<string> {
  ensureNativeModules()
  const token = ensureToken()
  currentServerPort = port
  const primaryWebUiDir = webuiDir()
  const primaryEntry = webuiServerEntryFor(primaryWebUiDir)
  if (!existsSync(primaryEntry)) {
    throw new Error(`Web UI server entry not found at ${primaryEntry}. Run: npm run build:webui`)
  }

  const home = webUiHome()
  const agentHome = hermesHome()
  mkdirSync(home, { recursive: true })
  mkdirSync(agentHome, { recursive: true })

  const isWin = process.platform === 'win32'
  const bridgePort = await getFreeTcpPort()
  const workerPortBase = await getFreeTcpPortInRange(20000, 59000)
  const loginShellPath = await getLoginShellPath()
  const nvmNodeBinPaths = getNvmNodeBinPaths()
  const userSearchPath = mergePathEntries(
    loginShellPath,
    nvmNodeBinPaths,
    process.env.PATH,
    process.env.Path,
    COMMON_USER_BIN_DIRS.join(delimiter),
  )
  const primaryRuntimeDirectory = desktopRuntimeDir()
  const primaryPythonRoot = pythonDir()
  const primaryPythonEnvironment = pythonEnvironmentDir()
  const primaryPythonPath = bundledPython()
  const primaryHermesPath = hermesBin()
  const bundledNodeBin = nodeBinDir()
  const primaryNodePath = bundledNode()
  const primaryGitBin = bundledGit()
  const primaryGitPath = gitPathDirs().join(delimiter)
  const primaryAgentBrowserHome = bundledAgentBrowserHome()
  const primaryAgentBrowserBin = isWin
    ? join(primaryPythonRoot, 'node')
    : join(primaryPythonRoot, 'node', 'bin')
  const primaryRuntime: ManagedRuntimeCandidate = {
    directory: primaryRuntimeDirectory,
    path: primaryHermesPath,
    pythonPath: primaryPythonPath,
    agentRoot: primaryPythonRoot,
    environmentRoot: primaryPythonEnvironment,
    managedRuntimeVersion: runtimeVersionFromManifest(
      primaryRuntimeDirectory,
      basename(dirname(primaryRuntimeDirectory)),
    ),
    agentBrowserBin: primaryAgentBrowserBin,
    agentBrowserHome: primaryAgentBrowserHome,
    nodeBin: bundledNodeBin,
    nodePath: primaryNodePath,
    gitBin: primaryGitBin,
    gitPath: primaryGitPath,
    playwrightBrowsers: join(primaryPythonRoot, 'ms-playwright'),
    probePath: mergePathEntries(
      dirname(primaryHermesPath),
      dirname(primaryPythonPath),
      primaryAgentBrowserBin,
      bundledNodeBin,
      primaryGitPath,
      userSearchPath,
    ),
  }
  primaryRuntime.validationError = validateManagedRuntimeCandidate(
    primaryRuntime,
    app.isPackaged || Boolean(process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()),
  )
  const runtimeCandidates = managedRuntimeCandidates(primaryRuntime, userSearchPath)
  const hermesSelection = await resolveDesktopHermesSelection({
    env: process.env,
    searchPath: userSearchPath,
    hermesHome: agentHome,
    managedRuntimes: runtimeCandidates,
  })
  const selectedManagedRuntime = hermesSelection.source === 'managed-runtime'
    ? runtimeCandidates.find(candidate => resolve(candidate.path) === resolve(hermesSelection.path))
    : undefined
  const runtimeSupport = hermesSelection.source === 'none'
    ? undefined
    : selectedManagedRuntime || runtimeCandidates.find(candidate => !candidate.validationError)
  const runtimeFailures = hermesSelection.managedRuntimeFailures || []
  if (runtimeFailures.length > 0) {
    for (const failure of runtimeFailures) {
      console.warn(`[runtime] rejected Runtime "${failure.directory}": ${failure.reason}`)
    }
    recordRuntimeSelectionResult(runtimeFailures, selectedManagedRuntime
      ? {
          directory: selectedManagedRuntime.directory,
          version: selectedManagedRuntime.managedRuntimeVersion || hermesSelection.version,
        }
      : undefined)
  }
  const runtimePath = mergePathEntries(
    hermesSelection.path ? dirname(hermesSelection.path) : '',
    hermesSelection.pythonPath ? dirname(hermesSelection.pythonPath) : '',
    runtimeSupport?.agentBrowserBin,
    runtimeSupport?.nodeBin,
    runtimeSupport?.gitPath,
    userSearchPath,
  )
  const browserExecutableOverride = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim()
  console.log(
    `[desktop] Hermes source=${hermesSelection.source} `
    + `version=${hermesSelection.version || '-'} path=${hermesSelection.path || '-'}`,
  )

  // Run via Electron's "run as Node" mode — Electron binary doubles as Node.
  const env = withDesktopHermesSelection({
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HERMES_DESKTOP: 'true',
    ...(runtimeSupport && existsSync(runtimeSupport.nodePath) ? {
      HERMES_AGENT_NODE: runtimeSupport.nodePath,
      HERMES_AGENT_NODE_ROOT: isWin ? runtimeSupport.nodeBin : dirname(runtimeSupport.nodeBin),
    } : {}),
    ...(process.env.AGENT_BROWSER_HOME?.trim()
      ? { AGENT_BROWSER_HOME: process.env.AGENT_BROWSER_HOME.trim() }
      : runtimeSupport && existsSync(runtimeSupport.agentBrowserHome)
        ? { AGENT_BROWSER_HOME: runtimeSupport.agentBrowserHome }
        : {}),
    ...(browserExecutableOverride ? { AGENT_BROWSER_EXECUTABLE_PATH: browserExecutableOverride } : {}),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : runtimeSupport && existsSync(runtimeSupport.playwrightBrowsers)
        ? { PLAYWRIGHT_BROWSERS_PATH: runtimeSupport.playwrightBrowsers }
        : {}),
    ...(runtimeSupport?.gitBin && existsSync(runtimeSupport.gitBin) ? { HERMES_AGENT_GIT: runtimeSupport.gitBin } : {}),
    // Force TCP loopback for the agent bridge. The default `ipc:///tmp/...`
    // unix socket is rejected on macOS in some EDR/sandbox setups (silent
    // SIGKILL of the bridge child within ~150ms). TCP on 127.0.0.1 works
    // identically and avoids the issue cross-platform.
    HERMES_AGENT_BRIDGE_ENDPOINT: `tcp://127.0.0.1:${bridgePort}`,
    // Desktop opens the UI as soon as the Web UI HTTP server is ready, while
    // the Python bridge starts in the background. Let the first chat/context
    // request wait for broker readiness instead of failing during cold start.
    HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS: process.env.HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS ?? '120000',
    // Force TCP for worker endpoints too (upstream #1106). Same EDR/sandbox
    // reason as above — default ipc:// unix sockets in /tmp get killed.
    HERMES_AGENT_BRIDGE_WORKER_TRANSPORT: 'tcp',
    HERMES_AGENT_BRIDGE_WORKER_PORT_BASE: String(workerPortBase),
    // And for preview-mode bridges spawned by the in-app update controller.
    HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT: 'tcp',
    // Suppress the npm-registry update prompt (upstream #1105). hermes-web-ui
    // is bundled here; users can't `npm i -g` to upgrade, they have to wait
    // for the wrapper app to ship a new release.
    HERMES_WEB_UI_DISABLE_UPDATE_CHECK: 'true',
    // Single-user desktop install: open the gateway's user allowlist by
    // default. Otherwise the gateway silently drops every inbound platform
    // message (DingTalk/Slack/Telegram) with a startup warning. Users can
    // still override by setting GATEWAY_ALLOW_ALL_USERS=false in their
    // HERMES_HOME/.env or by configuring per-platform allowlists.
    GATEWAY_ALLOW_ALL_USERS: process.env.GATEWAY_ALLOW_ALL_USERS ?? 'true',
    // Keep the bundled Hermes Agent, bridge, gateway, and Web UI path helpers
    // on the same ~/.hermes data directory on every platform.
    HERMES_HOME: agentHome,
    HERMES_WEB_UI_HOME: home,
    HERMES_WEBUI_STATE_DIR: home,
    AUTH_TOKEN: token,
    PORT: String(port),
    // The selected Hermes/Python pair is first. Bundled auxiliary tools remain
    // available after selection without influencing which Hermes wins.
    PATH: runtimePath,
  }, hermesSelection)

  const released = await releaseOccupiedWebUiPort(port, token)
  if (released) {
    console.warn(`[webui] released an orphaned Desktop Web UI on port ${port}`)
  }

  const fallbackWebUiDir = defaultWebuiDir()
  try {
    return await launchWebUiServer(primaryWebUiDir, primaryEntry, env, port)
  } catch (err) {
    if (resolve(primaryWebUiDir) === resolve(fallbackWebUiDir)) throw err

    const fallbackEntry = webuiServerEntryFor(fallbackWebUiDir)
    if (!existsSync(fallbackEntry)) throw err

    console.warn(`[webui] startup failed for active Web UI at ${primaryWebUiDir}; retrying bundled Web UI at ${fallbackWebUiDir}: ${err instanceof Error ? err.message : String(err)}`)
    clearActiveWebUiDirectory(primaryWebUiDir)
    return await launchWebUiServer(fallbackWebUiDir, fallbackEntry, env, port)
  }
}

async function launchWebUiServer(webUiDirectory: string, entry: string, env: NodeJS.ProcessEnv, port: number): Promise<string> {
  const diagnostics = new WebUiStartupDiagnostics(
    join(webUiHome(), 'logs', 'desktop-startup.log'),
    `Desktop ${app.getVersion()} ${process.platform}-${process.arch}; `
    + `Electron ${process.versions.electron || '-'}; Node ${process.versions.node}\n`
    + `Executable: ${process.execPath}\nWeb UI: ${webUiDirectory}\nEntry: ${entry}`,
  )
  serverProc = spawn(process.execPath, [entry], {
    cwd: webUiDirectory,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })

  const launchedProc = serverProc
  const bridgeStartup = createAgentBridgeStartupTracker()
  let startupReady = false

  launchedProc.stdout?.on('data', (chunk: Buffer) => {
    diagnostics.observeStdout(chunk)
    bridgeStartup.observe(chunk)
    try {
      process.stdout.write(`[webui] ${chunk}`)
    } catch {
      /* EPIPE: parent stdout closed, ignore */
    }
  })
  launchedProc.stdout?.on('error', () => { /* EPIPE: ignore */ })
  launchedProc.stderr?.on('data', (chunk: Buffer) => {
    diagnostics.observeStderr(chunk)
    bridgeStartup.observe(chunk)
    try {
      process.stderr.write(`[webui] ${chunk}`)
    } catch {
      /* EPIPE: parent stderr closed, ignore */
    }
  })
  launchedProc.stderr?.on('error', () => { /* EPIPE: ignore */ })
  launchedProc.on('message', message => {
    if (serverProc !== launchedProc || !isDesktopRestartRequest(message)) return
    if (!restartRequestHandler) {
      console.warn('[desktop] Web UI requested an App restart before a handler was registered')
      return
    }
    restartRequestHandler()
  })
  launchedProc.on('exit', (code, signal) => {
    console.error(`[webui] server exited code=${code} signal=${signal}`)
    if (serverProc === launchedProc) serverProc = null
    if (startupReady && code !== 0 && app.isReady()) {
      unexpectedExitHandler?.({ code, signal })
    }
  })

  const timeoutMs = readyTimeoutMs()
  const bridgeReady = bridgeStartup.wait(timeoutMs)
  // A pre-readiness failure can return before the bridge timeout settles.
  void bridgeReady.catch(() => undefined)
  const exitBeforeReady = new Promise<never>((_, reject) => {
    launchedProc.once('error', reject)
    // close follows drained stdout/stderr; exit can arrive before the traceback.
    launchedProc.once('close', (code, signal) => {
      reject(new Error(`Web UI server exited before becoming ready code=${code} signal=${signal}`))
    })
  })
  try {
    await Promise.race([waitForReady(port, timeoutMs), exitBeforeReady])
    startupReady = true
  } catch (err) {
    await terminateLaunchedProcess(launchedProc)
    if (serverProc === launchedProc) serverProc = null
    throw diagnostics.failure(err)
  }
  const fullStartupTimeoutMs = fullStartupWaitMs()
  if (fullStartupTimeoutMs > 0) {
    await Promise.race([
      bridgeReady,
      timeoutAfter(fullStartupTimeoutMs, `Agent bridge did not become ready within ${fullStartupTimeoutMs}ms`),
    ]).catch(err => {
      console.warn(`[webui] agent bridge was not ready during startup: ${err instanceof Error ? err.message : String(err)}`)
    })
    void bridgeReady.catch(() => undefined)
  } else {
    void bridgeReady.catch(err => {
      console.warn(`[webui] agent bridge was not ready during startup: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return getServerUrl(port)
}

async function terminateLaunchedProcess(proc: ChildProcess): Promise<void> {
  if (proc.killed || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>(resolveDone => {
    const timer = setTimeout(() => resolveDone(), 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolveDone()
    })
    killProcessTree(proc)
  })
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/health/ready`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      /* not ready yet */
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Web UI shell did not become ready within ${timeoutMs}ms`)
}

async function requestGracefulShutdown(port: number, token: string): Promise<void> {
  const timeoutMs = gracefulStopTimeoutMs()
  const response = await fetch(`http://127.0.0.1:${port}/api/desktop/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok && response.status !== 202) {
    throw new Error(`desktop shutdown returned HTTP ${response.status}`)
  }
}

export async function stopWebUiServer(): Promise<void> {
  if (!serverProc) return

  const proc = serverProc
  const exited = new Promise<void>(resolve => {
    proc.once('exit', () => resolve())
  })
  const forceAfter = new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      killProcessTree(proc)
      resolve()
    }, envPositiveInt('HERMES_DESKTOP_STOP_TIMEOUT_MS') || DEFAULT_STOP_TIMEOUT_MS)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  try {
    await requestGracefulShutdown(currentServerPort, ensureToken())
  } catch (err) {
    console.warn(`[webui] graceful shutdown request failed: ${err instanceof Error ? err.message : String(err)}`)
    killProcessTree(proc)
  }

  await Promise.race([exited, forceAfter])
}
