import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createConnection, createServer } from 'net'
import { isAbsolute, join, resolve } from 'path'
import { logger } from '../../../studio/public/logging'
import { config } from '../../../studio/public/config'
import { OPENROUTER_APP_HEADERS } from '../../../studio/public/openrouter-attribution'
import { resolveHermesInstallationEnvironment } from '../runtime/installation'
import { detectHermesHome, getHermesBin } from '../runtime/path'
import { AgentBridgeClient, DEFAULT_AGENT_BRIDGE_ENDPOINT } from './client'

const DEFAULT_AGENT_BRIDGE_STARTUP_TIMEOUT_MS = 120000
const DEFAULT_AGENT_BRIDGE_RESTART_DELAY_MS = 1000
const MAX_AGENT_BRIDGE_RESTART_DELAY_MS = 30000
const MAX_AGENT_BRIDGE_STARTUP_RESTART_ATTEMPTS = 3
const DEFAULT_AGENT_BRIDGE_RECOVERY_EXIT_TIMEOUT_MS = 5000
const DEFAULT_AGENT_BRIDGE_RECOVERY_SIGKILL_WAIT_MS = 250
const DEFAULT_AGENT_BRIDGE_SHUTDOWN_TIMEOUT_MS = 10_000
const DEFAULT_AGENT_BRIDGE_FORCE_KILL_WAIT_MS = 2_000
const FORCE_KILL_COMMAND_TIMEOUT_MS = 5_000
const OPENROUTER_WEB_UI_ATTRIBUTION_ENV = {
  HERMES_OPENROUTER_APP_REFERER: OPENROUTER_APP_HEADERS['HTTP-Referer'],
  HERMES_OPENROUTER_APP_TITLE: OPENROUTER_APP_HEADERS['X-OpenRouter-Title'],
  HERMES_OPENROUTER_APP_CATEGORIES: OPENROUTER_APP_HEADERS['X-OpenRouter-Categories'],
} as const

export interface AgentBridgeManagerOptions {
  endpoint?: string
  python?: string
  agentRoot?: string
  hermesHome?: string
  startupTimeoutMs?: number
}

export interface BridgeCommand {
  command: string
  argsPrefix: string[]
  agentRoot?: string
  hermesHome: string
}

export interface AgentBridgeManagerRuntimeState {
  endpoint: string
  running: boolean
  ready: boolean
  attached: boolean
  pid?: number
  starting: boolean
  stopping: boolean
  restartScheduled: boolean
  restartAttempts: number
}

export type AgentBridgeEndpointKind = 'ipc' | 'tcp' | 'unknown'

export type AgentBridgeReadinessStatus = 'ready' | 'starting' | 'recovering' | 'stopping' | 'restarting' | 'unreachable'

export interface AgentBridgeReadinessOptions {
  timeoutMs?: number
  connectRetryMs?: number
}

export interface AgentBridgeEnsureReadyOptions extends AgentBridgeReadinessOptions {
  recover?: boolean
}

export interface AgentBridgeReadiness {
  endpoint: string
  endpointKind: AgentBridgeEndpointKind
  status: AgentBridgeReadinessStatus
  reachable: boolean
  ready: boolean
  running: boolean
  attached: boolean
  starting: boolean
  stopping: boolean
  restartScheduled: boolean
  restartAttempts: number
  pid?: number
  error?: string
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function isLegacyGlobalDefaultEndpoint(endpoint: string): boolean {
  const normalized = endpoint.trim().toLowerCase()
  return normalized === 'ipc:///tmp/hermes-agent-bridge.sock' ||
    normalized === 'tcp://127.0.0.1:18765' ||
    normalized === 'tcp://localhost:18765'
}

export function buildAgentBridgeProcessEnv(endpoint: string, hermesHome: string | undefined, agentRoot: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_AGENT_BRIDGE_ENDPOINT: endpoint,
    HERMES_HOME: hermesHome,
    // Shared Hermes YAML may have been rewritten by another Studio instance.
    // Carry the owner separately so each worker can scope managed MCP launches.
    HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV: JSON.stringify({
      HERMES_WEB_UI_URL: `http://127.0.0.1:${config.port}`,
      HERMES_WEB_UI_HOME: config.appHome,
      HERMES_WEBUI_STATE_DIR: config.appHome,
      ELECTRON_RUN_AS_NODE: '1',
    }),
    HERMES_OPENROUTER_APP_REFERER: process.env.HERMES_OPENROUTER_APP_REFERER || OPENROUTER_WEB_UI_ATTRIBUTION_ENV.HERMES_OPENROUTER_APP_REFERER,
    HERMES_OPENROUTER_APP_TITLE: process.env.HERMES_OPENROUTER_APP_TITLE || OPENROUTER_WEB_UI_ATTRIBUTION_ENV.HERMES_OPENROUTER_APP_TITLE,
    HERMES_OPENROUTER_APP_CATEGORIES: process.env.HERMES_OPENROUTER_APP_CATEGORIES || OPENROUTER_WEB_UI_ATTRIBUTION_ENV.HERMES_OPENROUTER_APP_CATEGORIES,
    ...(agentRoot ? { HERMES_AGENT_ROOT: agentRoot } : {}),
  }
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

function pathCandidates(agentRoot?: string): string[] {
  if (!agentRoot) return []
  return process.platform === 'win32'
    ? [
        join(agentRoot, 'venv', 'Scripts', 'python.exe'),
        join(agentRoot, 'venv', 'Scripts', 'python3.exe'),
        join(agentRoot, '.venv', 'Scripts', 'python.exe'),
        join(agentRoot, '.venv', 'Scripts', 'python3.exe'),
      ]
    : [
        join(agentRoot, 'venv', 'bin', 'python3'),
        join(agentRoot, 'venv', 'bin', 'python'),
        join(agentRoot, '.venv', 'bin', 'python3'),
        join(agentRoot, '.venv', 'bin', 'python'),
      ]
}

function uvCandidates(agentRoot?: string): string[] {
  if (!agentRoot) {
    return [
      process.env.HERMES_AGENT_BRIDGE_UV,
      process.env.UV,
    ].filter((value): value is string => !!value && value.trim().length > 0)
  }
  return [
    process.env.HERMES_AGENT_BRIDGE_UV,
    process.env.UV,
    ...(process.platform === 'win32'
      ? [
          agentRoot ? join(agentRoot, 'venv', 'Scripts', 'uv.exe') : '',
          agentRoot ? join(agentRoot, 'venv', 'Scripts', 'uv.cmd') : '',
          agentRoot ? join(agentRoot, '.venv', 'Scripts', 'uv.exe') : '',
          agentRoot ? join(agentRoot, '.venv', 'Scripts', 'uv.cmd') : '',
        ]
      : [
          agentRoot ? join(agentRoot, 'venv', 'bin', 'uv') : '',
          agentRoot ? join(agentRoot, '.venv', 'bin', 'uv') : '',
        ]),
    'uv',
  ].filter((value): value is string => !!value && value.trim().length > 0)
}

function resolveExecutable(command: string): string | undefined {
  const trimmed = command.trim()
  if (!trimmed) return undefined
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return existsSync(trimmed) ? resolve(trimmed) : undefined
  }
  try {
    const lookup = process.platform === 'win32'
      ? execFileSync('where.exe', [trimmed], { encoding: 'utf-8', windowsHide: true })
      : execFileSync('which', [trimmed], { encoding: 'utf-8' })
    return lookup.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  } catch {
    return undefined
  }
}

function agentRootFromHermesBin(): string | undefined {
  const hermesBin = resolveExecutable(getHermesBin())
  if (!hermesBin) return undefined
  return resolveHermesInstallationEnvironment(hermesBin, detectHermesHome()).agentRoot
}

function hermesBinPython(): string | undefined {
  const hermesBin = resolveExecutable(getHermesBin())
  if (!hermesBin) return undefined
  return resolveHermesInstallationEnvironment(hermesBin, detectHermesHome()).python
}

function firstExistingExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) && !candidate.includes('/') && !candidate.includes('\\')) {
      const resolved = resolveExecutable(candidate)
      if (resolved) return resolved
      continue
    }
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return undefined
}

function resolveAgentRoot(explicit?: string, hermesHome = detectHermesHome()): string | undefined {
  const candidates = [
    explicit,
    process.env.HERMES_AGENT_ROOT,
    join(hermesHome, 'hermes-agent'),
    agentRootFromHermesBin(),
    process.cwd(),
    join(process.cwd(), 'hermes-agent'),
    '/usr/local/lib/hermes-agent',
    '/usr/local/hermes-agent',
    '/opt/hermes/hermes-agent',
    '/opt/hermes-agent',
  ].filter((value): value is string => !!value && value.trim().length > 0)
  return candidates.find(candidate => existsSync(join(candidate, 'run_agent.py')))
}

export function resolveAgentBridgeCommand(options: AgentBridgeManagerOptions = {}): BridgeCommand {
  const hermesHome = options.hermesHome || detectHermesHome()
  const agentRoot = resolveAgentRoot(options.agentRoot, hermesHome)
  const explicitPython = options.python || process.env.HERMES_AGENT_BRIDGE_PYTHON
  if (explicitPython) {
    return { command: explicitPython, argsPrefix: [], agentRoot, hermesHome }
  }

  const venvPython = firstExistingExecutable(pathCandidates(agentRoot))
  if (venvPython) {
    return { command: venvPython, argsPrefix: [], agentRoot, hermesHome }
  }

  const shebangPython = hermesBinPython()
  if (shebangPython && existsSync(shebangPython)) {
    return { command: shebangPython, argsPrefix: [], agentRoot, hermesHome }
  }

  const uv = firstExistingExecutable(uvCandidates(agentRoot))
  if (uv) {
    const prefix = ['run']
    if (agentRoot) prefix.push('--project', agentRoot)
    prefix.push('python')
    return { command: uv, argsPrefix: prefix, agentRoot, hermesHome }
  }

  const fallback = firstExistingExecutable([
    process.env.PYTHON || '',
    ...(process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']),
  ]) || (process.platform === 'win32' ? 'python' : 'python3')
  return { command: fallback, argsPrefix: [], agentRoot, hermesHome }
}

function bridgeScriptPath(): string {
  const candidates = [
    // Built server: dist/server/index.js -> dist/server/agent-bridge/python/hermes_bridge.py
    resolve(__dirname, 'agent-bridge', 'python', 'hermes_bridge.py'),
    // ts-node/dev source tree.
    resolve(__dirname, 'python', 'hermes_bridge.py'),
    resolve(__dirname, 'modules/hermes/services/bridge/python/hermes_bridge.py'),
    resolve(process.cwd(), 'packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py'),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) {
    throw new Error(`agent bridge Python script not found. Tried: ${candidates.join(', ')}`)
  }
  return found
}

function isTcpEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('tcp://')
}

function classifyEndpointKind(endpoint: string): AgentBridgeEndpointKind {
  if (endpoint.startsWith('ipc://')) return 'ipc'
  if (endpoint.startsWith('tcp://')) return 'tcp'
  return 'unknown'
}

function normalizeReadinessError(endpoint: string, err: unknown): string {
  if (!endpoint.trim()) return 'agent bridge endpoint is not configured'
  const message = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : undefined
  const normalized = message?.replace(/^Error:\s*/, '').trim()
  return normalized || 'agent bridge is unreachable'
}

function mergeStartFailureReadinessError(readiness: AgentBridgeReadiness, err: unknown): string | undefined {
  if (readiness.reachable) {
    return undefined
  }

  const readinessError = readiness.error?.trim()
  const startError = normalizeReadinessError(readiness.endpoint, err)
  if (readinessError && readinessError !== startError) {
    return `${readinessError}; start failed: ${startError}`
  }

  return readinessError || startError
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function shouldKillStaleIpcBridgeProcesses(): boolean {
  const raw = String(process.env.HERMES_AGENT_BRIDGE_KILL_STALE_IPC || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(raw)
}

async function canListenTcpEndpoint(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint)
  const host = url.hostname || '127.0.0.1'
  const port = Number(url.port)
  if (!Number.isFinite(port) || port <= 0) return false

  return await new Promise<boolean>((resolveAvailable) => {
    const probe = createServer()
    const done = (available: boolean) => {
      probe.removeAllListeners()
      resolveAvailable(available)
    }
    probe.once('error', () => done(false))
    probe.listen(port, host, () => {
      probe.close(() => done(true))
    })
  })
}

async function canConnectTcpEndpoint(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint)
  const host = url.hostname || '127.0.0.1'
  const port = Number(url.port)
  if (!Number.isFinite(port) || port <= 0) return false

  return await new Promise<boolean>((resolveConnected) => {
    const socket = createConnection({ port, host })
    const done = (connected: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolveConnected(connected)
    }
    socket.setTimeout(250)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function tcpEndpointPort(endpoint: string): number | undefined {
  if (!isTcpEndpoint(endpoint)) return undefined
  const url = new URL(endpoint)
  const port = Number(url.port)
  return Number.isFinite(port) && port > 0 ? port : undefined
}

function windowsListeningPidsOnPort(port: number): number[] {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true }).toString('utf8')
    const pids = new Set<number>()
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      const [proto, localAddress, , state, pidRaw] = parts
      if (proto.toUpperCase() !== 'TCP' || state.toUpperCase() !== 'LISTENING') continue
      if (!localAddress.endsWith(`:${port}`)) continue
      const pid = Number(pidRaw)
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
    }
    return [...pids]
  } catch {
    return []
  }
}

async function waitForTcpEndpoint(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canListenTcpEndpoint(endpoint)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return canListenTcpEndpoint(endpoint)
}

async function killWindowsEndpointOccupants(endpoint: string): Promise<void> {
  const port = tcpEndpointPort(endpoint)
  if (!port) return
  const pids = windowsListeningPidsOnPort(port)
  if (!pids.length) return
  for (const pid of pids) {
    try {
      logger.warn('[agent-bridge] killing stale process tree pid=%d on bridge port %d', pid, port)
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf-8', windowsHide: true })
    } catch (err) {
      logger.warn(err, '[agent-bridge] failed to kill stale bridge process pid=%d', pid)
    }
  }
  await waitForTcpEndpoint(endpoint, 3000)
}

/**
 * Find and kill stale bridge broker/worker processes that are still connected
 * to the given IPC socket path.  This happens after a `systemctl restart` with
 * KillMode=process where the Node parent is killed but bridge Python children
 * survive as orphans.
 */
async function killStaleIpcBridgeProcesses(endpoint: string): Promise<void> {
  const sockPath = endpoint.replace(/^ipc:\/\//, '')
  if (!sockPath) return

  const isWorkerSock = sockPath.includes('hermes-agent-bridge-workers')
  // Also derive the worker socket path so we can kill worker orphans too.
  const workerSockDir = `${sockPath.replace(/\/[^/]+$/, '')}`.replace(
    /hermes-agent-bridge-workers$/,
    'hermes-agent-bridge-workers',
  )
  const socketsToCheck = [sockPath]
  if (!isWorkerSock) {
    // broker socket — also check worker sockets under the same namespace
    const workerDir = require('path').join(require('path').dirname(sockPath), 'hermes-agent-bridge-workers')
    try {
      const fs = await import('fs')
      for (const entry of await fs.promises.readdir(workerDir)) {
        socketsToCheck.push(require('path').join(workerDir, entry))
      }
    } catch { /* dir may not exist */ }
  }

  const pidsToKill = new Set<number>()
  for (const sock of socketsToCheck) {
    try {
      // lsof finds processes with the Unix socket open (listening or connected)
      const out = execFileSync('lsof', ['-F', 'p', '-U', '--', sock], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      for (const line of out.split('\n')) {
        const pid = Number(line.replace(/^p/, ''))
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
          pidsToKill.add(pid)
        }
      }
    } catch {
      // lsof exits non-zero when nothing found — that's fine
    }
  }

  if (!pidsToKill.size) return

  for (const pid of pidsToKill) {
    try {
      logger.warn('[agent-bridge] killing stale bridge process pid=%d on IPC socket %s', pid, sockPath)
      process.kill(pid, 'SIGKILL')
    } catch (err) {
      logger.warn(err, '[agent-bridge] failed to kill stale bridge process pid=%d', pid)
    }
  }
  // Give processes time to exit
  await new Promise(resolve => setTimeout(resolve, 500))
}

function bridgePidsForEndpoint(endpoint: string): number[] {
  if (process.platform === 'win32') {
    const port = tcpEndpointPort(endpoint)
    return port ? windowsListeningPidsOnPort(port) : []
  }
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf-8',
      timeout: 5_000,
    })
    return output.split(/\r?\n/).flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match || !match[2].includes('hermes_bridge.py') || !match[2].includes(endpoint)) return []
      const pid = Number(match[1])
      return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? [pid] : []
    })
  } catch {
    return []
  }
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
      const siblings = children.get(parentPid) || []
      siblings.push(pid)
      children.set(parentPid, siblings)
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

function forceKillBridgeEndpointProcesses(endpoint: string): void {
  for (const pid of bridgePidsForEndpoint(endpoint)) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          encoding: 'utf-8',
          timeout: FORCE_KILL_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        })
      } else {
        for (const descendantPid of posixDescendantPids(pid)) {
          try {
            process.kill(descendantPid, 'SIGKILL')
          } catch {}
        }
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          process.kill(pid, 'SIGKILL')
        }
      }
    } catch (err) {
      logger.warn(err, '[agent-bridge] failed to force-kill bridge endpoint process pid=%s', pid)
    }
  }
}

export class AgentBridgeManager {
  endpoint: string
  private readonly options: AgentBridgeManagerOptions
  private readonly explicitEndpoint: boolean
  private child: ChildProcess | null = null
  private attached = false
  private starting: Promise<void> | null = null
  private recovery: Promise<AgentBridgeReadiness> | null = null
  private ready = false
  private stopping = false
  private stopGeneration = 0
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempts = 0

  constructor(options: AgentBridgeManagerOptions = {}) {
    this.options = options
    this.explicitEndpoint = Boolean(options.endpoint || process.env.HERMES_AGENT_BRIDGE_ENDPOINT)
    this.endpoint = options.endpoint || process.env.HERMES_AGENT_BRIDGE_ENDPOINT || DEFAULT_AGENT_BRIDGE_ENDPOINT
  }

  get running(): boolean {
    return this.ready && (this.attached || (!!this.child && !this.child.killed))
  }

  getRuntimeState(): AgentBridgeManagerRuntimeState {
    return {
      endpoint: this.endpoint,
      running: this.running,
      ready: this.ready,
      attached: this.attached,
      pid: this.child?.pid,
      starting: !!this.starting,
      stopping: this.stopping,
      restartScheduled: !!this.restartTimer,
      restartAttempts: this.restartAttempts,
    }
  }

  private transientReadiness(status: AgentBridgeReadinessStatus, error?: string): AgentBridgeReadiness {
    const state = this.getRuntimeState()
    const endpoint = state.endpoint
    const readiness: AgentBridgeReadiness = {
      endpoint,
      endpointKind: classifyEndpointKind(endpoint),
      status,
      reachable: false,
      ready: false,
      running: false,
      attached: state.attached,
      starting: state.starting,
      stopping: state.stopping,
      restartScheduled: state.restartScheduled,
      restartAttempts: state.restartAttempts,
      pid: state.pid,
    }
    return error ? { ...readiness, error } : readiness
  }

  private async waitForPromiseSettlementWithin(promise: Promise<unknown>, timeoutMs?: number): Promise<boolean> {
    if (!timeoutMs || timeoutMs <= 0) {
      try {
        await promise
      } catch {}
      return true
    }

    return new Promise<boolean>((resolve) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, timeoutMs)

      promise.finally(() => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(true)
      }).catch(() => {})
    })
  }

  private async waitForReadinessWithin(
    promise: Promise<AgentBridgeReadiness>,
    timeoutMs?: number,
  ): Promise<AgentBridgeReadiness | null> {
    if (!timeoutMs || timeoutMs <= 0) {
      return promise
    }

    return new Promise<AgentBridgeReadiness | null>((resolve) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, timeoutMs)

      promise.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(value)
        },
        (err) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(this.transientReadiness('recovering', normalizeReadinessError(this.endpoint, err)))
        },
      )
    })
  }

  private async checkReadinessInternal(
    options: AgentBridgeReadinessOptions = {},
    ignoreRecovery = false,
  ): Promise<AgentBridgeReadiness> {
    const state = this.getRuntimeState()
    const endpoint = state.endpoint
    const endpointKind = classifyEndpointKind(endpoint)
    const readiness: AgentBridgeReadiness = {
      endpoint,
      endpointKind,
      status: 'unreachable',
      reachable: false,
      ready: state.ready,
      running: state.running,
      attached: state.attached,
      starting: state.starting,
      stopping: state.stopping,
      restartScheduled: state.restartScheduled,
      restartAttempts: state.restartAttempts,
      pid: state.pid,
    }

    if (state.stopping) {
      return {
        ...readiness,
        status: 'stopping',
        reachable: false,
        ready: false,
        running: false,
      }
    }

    if (!ignoreRecovery && this.recovery) {
      return {
        ...readiness,
        status: 'recovering',
        reachable: false,
        ready: false,
        running: false,
      }
    }

    if (state.starting) {
      return {
        ...readiness,
        status: 'starting',
        reachable: false,
        ready: false,
        running: false,
      }
    }

    if (state.restartScheduled) {
      return {
        ...readiness,
        status: 'restarting',
        reachable: false,
        ready: false,
        running: false,
      }
    }

    if (!endpoint.trim()) {
      return {
        ...readiness,
        ready: false,
        running: false,
        error: normalizeReadinessError(endpoint, undefined),
      }
    }

    try {
      const client = new AgentBridgeClient({
        endpoint,
        timeoutMs: options.timeoutMs ?? 1000,
        connectRetryMs: options.connectRetryMs ?? 0,
      })
      await client.ping()
      return {
        ...readiness,
        status: 'ready',
        reachable: true,
        ready: true,
        running: true,
      }
    } catch (err) {
      return {
        ...readiness,
        ready: false,
        running: false,
        error: normalizeReadinessError(endpoint, err),
      }
    }
  }

  async checkReadiness(options: AgentBridgeReadinessOptions = {}): Promise<AgentBridgeReadiness> {
    return this.checkReadinessInternal(options)
  }

  private async performManagedRecovery(
    child: ChildProcess,
    options: AgentBridgeEnsureReadyOptions,
  ): Promise<AgentBridgeReadiness> {
    const recoveryStopGeneration = this.stopGeneration
    this.ready = false

    const exited = await this.waitForManagedChildExit(child)
    if (!exited) {
      const message = `managed child pid=${child.pid} did not exit after SIGTERM/SIGKILL during recovery`
      const recoveryReadiness = await this.checkReadinessInternal({ ...options, connectRetryMs: 0 }, true)
      return {
        ...recoveryReadiness,
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        error: recoveryReadiness.error ? `${message}; ${recoveryReadiness.error}` : message,
      }
    }

    if (this.stopGeneration !== recoveryStopGeneration || this.stopping) {
      return this.checkReadinessInternal({ ...options, connectRetryMs: 0 }, true)
    }

    try {
      await this.start()
      return await this.checkReadinessInternal(options, true)
    } catch (err) {
      const recoveredReadiness = await this.checkReadinessInternal({ ...options, connectRetryMs: 0 }, true)
      const error = mergeStartFailureReadinessError(recoveredReadiness, err)
      return error
        ? { ...recoveredReadiness, error }
        : recoveredReadiness
    }
  }

  async ensureReady(options: AgentBridgeEnsureReadyOptions = {}): Promise<AgentBridgeReadiness> {
    const readiness = await this.checkReadiness(options)
    if (readiness.reachable) {
      return readiness
    }

    if (options.recover === false) {
      return readiness
    }

    if (this.recovery) {
      const recovered = await this.waitForReadinessWithin(this.recovery, options.timeoutMs)
      return recovered ?? this.transientReadiness('recovering')
    }

    if (readiness.status === 'starting' && this.starting) {
      const completed = await this.waitForPromiseSettlementWithin(this.starting, options.timeoutMs)
      return completed
        ? this.checkReadiness(options)
        : this.transientReadiness('starting')
    }

    if (readiness.status !== 'unreachable') {
      return readiness
    }

    const child = this.child
    if (!child || this.attached) {
      this.ready = false
      return readiness
    }

    if (isLegacyGlobalDefaultEndpoint(this.endpoint)) {
      this.ready = false
      const message = 'managed bridge recovery is disabled for legacy global default endpoint; merge endpoint scoping before enabling recovery'
      return {
        ...readiness,
        error: readiness.error ? `${readiness.error}; ${message}` : message,
      }
    }

    let recoveryPromise: Promise<AgentBridgeReadiness>
    recoveryPromise = this.performManagedRecovery(child, options).finally(() => {
      if (this.recovery === recoveryPromise) {
        this.recovery = null
      }
    })
    this.recovery = recoveryPromise

    const recovered = await this.waitForReadinessWithin(recoveryPromise, options.timeoutMs)
    return recovered ?? this.transientReadiness('recovering')
  }

  async start(): Promise<void> {
    if (this.running) return
    if (this.starting) return this.starting
    this.stopping = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.starting = this.startProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async waitForManagedChildExit(child: ChildProcess): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const gracefulTimeoutMs = envPositiveInt('HERMES_AGENT_BRIDGE_RECOVERY_EXIT_TIMEOUT_MS')
        ?? DEFAULT_AGENT_BRIDGE_RECOVERY_EXIT_TIMEOUT_MS
      const sigkillWaitMs = envPositiveInt('HERMES_AGENT_BRIDGE_RECOVERY_SIGKILL_WAIT_MS')
        ?? DEFAULT_AGENT_BRIDGE_RECOVERY_SIGKILL_WAIT_MS

      let settled = false
      let gracefulTimeout: NodeJS.Timeout | null = null
      let sigkillTimeout: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (gracefulTimeout) clearTimeout(gracefulTimeout)
        if (sigkillTimeout) clearTimeout(sigkillTimeout)
        child.off('exit', onExit)
      }

      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(exited)
      }

      const onExit = () => {
        if (this.child === child) {
          this.child = null
        }
        finish(true)
      }

      const sendSignal = (signal: NodeJS.Signals) => {
        try {
          // Node marks child.killed=true after a signal is successfully sent, not
          // after the process has actually exited. Recovery must still be able to
          // escalate SIGTERM -> SIGKILL while waiting for an observed exit.
          if (signal === 'SIGKILL' || !child.killed) {
            child.kill(signal)
          }
        } catch (err) {
          logger.warn(err, '[agent-bridge] failed to signal managed child pid=%s signal=%s', child.pid, signal)
        }
      }

      if (child.exitCode != null || child.signalCode != null) {
        onExit()
        return
      }

      child.once('exit', onExit)

      gracefulTimeout = setTimeout(() => {
        if (settled) return
        logger.warn(
          '[agent-bridge] managed child pid=%s did not exit after SIGTERM within %dms; sending SIGKILL',
          child.pid,
          gracefulTimeoutMs,
        )
        sendSignal('SIGKILL')
        sigkillTimeout = setTimeout(() => {
          if (settled) return
          logger.warn(
            '[agent-bridge] managed child pid=%s still has not exited %dms after SIGKILL; not starting a replacement',
            child.pid,
            sigkillWaitMs,
          )
          finish(false)
        }, sigkillWaitMs)
      }, gracefulTimeoutMs)

      sendSignal('SIGTERM')
    })
  }

  private forceKillManagedChildTree(child: ChildProcess): void {
    const pid = child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          encoding: 'utf-8',
          timeout: FORCE_KILL_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        })
        return
      } catch (err) {
        logger.warn(err, '[agent-bridge] failed to force-kill managed bridge tree pid=%s', pid)
      }
    } else {
      for (const descendantPid of posixDescendantPids(pid)) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {}
      }
      try {
        // Managed bridges are detached process-group leaders on POSIX. Killing
        // the group also covers profile workers and their MCP subprocesses.
        process.kill(-pid, 'SIGKILL')
        return
      } catch (err) {
        logger.warn(err, '[agent-bridge] failed to force-kill managed bridge process group pgid=%s', pid)
      }
    }
    try {
      child.kill('SIGKILL')
    } catch (err) {
      logger.warn(err, '[agent-bridge] failed to force-kill managed bridge pid=%s', pid)
    }
  }

  forceStop(): void {
    this.stopGeneration += 1
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    const attached = this.attached
    this.ready = false
    this.attached = false
    this.child = null
    if (child) this.forceKillManagedChildTree(child)
    else if (attached) forceKillBridgeEndpointProcesses(this.endpoint)
  }

  private async startProcess(): Promise<void> {
    if (await this.attachExistingBridge()) {
      return
    }

    const script = bridgeScriptPath()
    const command = resolveAgentBridgeCommand(this.options)
    await this.prepareEndpoint()
    const args = [...command.argsPrefix, script, '--endpoint', this.endpoint]
    const agentRoot = command.agentRoot
    const hermesHome = command.hermesHome
    if (agentRoot) args.push('--agent-root', agentRoot)
    if (hermesHome) args.push('--hermes-home', hermesHome)

    const env = buildAgentBridgeProcessEnv(this.endpoint, hermesHome, agentRoot)

    logger.info('[agent-bridge] starting: %s %s', command.command, args.join(' '))
    const child = spawn(command.command, args, {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child
    this.attached = false
    this.ready = false

    child.once('exit', (code, signal) => {
      const isCurrentChild = this.child === child
      if (!isCurrentChild) {
        logger.warn('[agent-bridge] stale managed child exit ignored code=%s signal=%s pid=%s', code, signal, child.pid)
        return
      }
      const shouldRestart = this.ready && !this.stopping && this.autoRestartEnabled()
      logger.warn('[agent-bridge] exited code=%s signal=%s', code, signal)
      this.ready = false
      this.child = null
      if (shouldRestart) this.scheduleRestart(code, signal)
    })

    await new Promise<void>((resolveReady, rejectReady) => {
      let startupSettled = false
      const startupTimeoutMs = this.options.startupTimeoutMs
        ?? envPositiveInt('HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS')
        ?? DEFAULT_AGENT_BRIDGE_STARTUP_TIMEOUT_MS
      const timeout = setTimeout(() => {
        if (startupSettled) return
        startupSettled = true
        cleanup()
        rejectReady(new Error(`agent bridge did not become ready within ${startupTimeoutMs}ms`))
      }, startupTimeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        child.off('exit', onExitBeforeReady)
        child.off('error', onError)
      }

      const markReady = () => {
        if (startupSettled) return
        this.ready = true
        this.restartAttempts = 0
        startupSettled = true
        cleanup()
        resolveReady()
      }

      const onError = (err: Error) => {
        if (startupSettled) return
        startupSettled = true
        cleanup()
        this.scheduleRestart(null, null, true)
        rejectReady(err)
      }

      const onExitBeforeReady = (code: number | null, signal: NodeJS.Signals | null) => {
        if (startupSettled) return
        startupSettled = true
        cleanup()
        this.scheduleRestart(code, signal, true)
        rejectReady(new Error(`agent bridge exited before ready code=${code} signal=${signal}`))
      }

      child.once('error', onError)
      child.once('exit', onExitBeforeReady)

      const probe = async () => {
        const client = new AgentBridgeClient({
          endpoint: this.endpoint,
          timeoutMs: 1000,
          connectRetryMs: 0,
        })
        while (!startupSettled && !child.killed) {
          try {
            await client.ping()
            markReady()
            return
          } catch {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }
      }
      probe().catch(onError)
    })

    logger.info('[agent-bridge] ready at %s', this.endpoint)
    if (process.platform !== 'win32') {
      child.unref()
    }
  }

  private async attachExistingBridge(): Promise<boolean> {
    try {
      const client = new AgentBridgeClient({
        endpoint: this.endpoint,
        timeoutMs: envPositiveInt('HERMES_AGENT_BRIDGE_ATTACH_TIMEOUT_MS') ?? 5000,
        connectRetryMs: envPositiveInt('HERMES_AGENT_BRIDGE_ATTACH_RETRY_MS') ?? 5000,
      })
      await client.ping()
      this.child = null
      this.attached = true
      this.ready = true
      this.restartAttempts = 0
      logger.info('[agent-bridge] attached to existing bridge at %s', this.endpoint)
      return true
    } catch (err) {
      logger.debug(err, '[agent-bridge] no reusable bridge at %s', this.endpoint)
      this.attached = false
      this.ready = false
      return false
    }
  }

  private async prepareEndpoint(): Promise<void> {
    if (!this.explicitEndpoint && process.platform === 'win32' && isTcpEndpoint(this.endpoint)) {
      if (!(await canListenTcpEndpoint(this.endpoint))) {
        await killWindowsEndpointOccupants(this.endpoint)
      }
    }
    // Preserve surviving bridge processes by default so Web UI restarts do not
    // terminate active conversations. Operators can opt in to cleanup for
    // known-stale sockets with HERMES_AGENT_BRIDGE_KILL_STALE_IPC=1.
    if (this.endpoint.startsWith('ipc://') && process.platform !== 'win32' && shouldKillStaleIpcBridgeProcesses()) {
      await killStaleIpcBridgeProcesses(this.endpoint)
    }
    process.env.HERMES_AGENT_BRIDGE_ENDPOINT = this.endpoint
  }

  private autoRestartEnabled(): boolean {
    const raw = String(process.env.HERMES_AGENT_BRIDGE_AUTO_RESTART || '').trim().toLowerCase()
    return !['0', 'false', 'no', 'off'].includes(raw)
  }

  private scheduleRestart(
    code: number | null,
    signal: NodeJS.Signals | null,
    startupFailure = false,
  ): void {
    if (this.restartTimer || this.stopping || !this.autoRestartEnabled()) return
    if (startupFailure && this.restartAttempts >= MAX_AGENT_BRIDGE_STARTUP_RESTART_ATTEMPTS) {
      logger.warn(
        '[agent-bridge] failed to become ready after %d restart attempts; automatic restart stopped',
        this.restartAttempts,
      )
      return
    }
    this.restartAttempts += 1
    const envDelay = envPositiveInt('HERMES_AGENT_BRIDGE_RESTART_DELAY_MS') ?? DEFAULT_AGENT_BRIDGE_RESTART_DELAY_MS
    const delayMs = Math.min(
      MAX_AGENT_BRIDGE_RESTART_DELAY_MS,
      envDelay * Math.max(1, this.restartAttempts),
    )
    logger.warn(
      '[agent-bridge] broker exited unexpectedly code=%s signal=%s; restarting in %dms (attempt %d)',
      code,
      signal,
      delayMs,
      this.restartAttempts,
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.start().catch((err) => {
        logger.warn(err, '[agent-bridge] automatic restart failed')
        if (!this.stopping) this.scheduleRestart(null, null, true)
      })
    }, delayMs)
  }

  async stop(): Promise<void> {
    this.stopGeneration += 1
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) {
      if (this.attached || this.ready) {
        let shutdownRequested = false
        try {
          const client = new AgentBridgeClient({
            endpoint: this.endpoint,
            timeoutMs: envPositiveInt('HERMES_AGENT_BRIDGE_SHUTDOWN_TIMEOUT_MS') ?? 5000,
            connectRetryMs: 0,
          })
          await client.shutdown()
          shutdownRequested = true
        } catch (err) {
          logger.warn(err, '[agent-bridge] failed to request attached bridge shutdown')
        }
        if (!shutdownRequested) forceKillBridgeEndpointProcesses(this.endpoint)
      }
      this.ready = false
      this.attached = false
      this.stopping = false
      return
    }
    this.ready = false
    this.attached = false

    const startedAt = Date.now()
    let observedExit = child.exitCode != null || child.signalCode != null
    const exited = observedExit
      ? Promise.resolve()
      : new Promise<void>(resolveExit => {
          child.once('exit', () => {
            observedExit = true
            resolveExit()
          })
        })
    const shutdownTimeoutMs = envPositiveInt('HERMES_AGENT_BRIDGE_SHUTDOWN_TIMEOUT_MS')
      ?? DEFAULT_AGENT_BRIDGE_SHUTDOWN_TIMEOUT_MS

    if (process.platform === 'win32') {
      // Node's SIGTERM emulation on Windows terminates only the broker. Ask the
      // broker to stop its workers first, then use taskkill /T as the fallback.
      const client = new AgentBridgeClient({
        endpoint: this.endpoint,
        timeoutMs: Math.min(5_000, shutdownTimeoutMs),
        connectRetryMs: 0,
      })
      await client.shutdown().catch(err => {
        logger.warn(err, '[agent-bridge] managed bridge graceful shutdown request failed')
      })
    } else if (!child.killed) {
      child.kill('SIGTERM')
    }

    const remainingMs = Math.max(0, shutdownTimeoutMs - (Date.now() - startedAt))
    const exitedGracefully = observedExit
      || (remainingMs > 0 && await this.waitForPromiseSettlementWithin(exited, remainingMs))
    if (!exitedGracefully) {
      logger.warn(
        '[agent-bridge] managed bridge tree pid=%s did not exit within %dms; force-killing descendants',
        child.pid,
        shutdownTimeoutMs,
      )
      this.forceKillManagedChildTree(child)
      await this.waitForPromiseSettlementWithin(exited, DEFAULT_AGENT_BRIDGE_FORCE_KILL_WAIT_MS)
    }
    if (this.child === child) this.child = null
    this.stopping = false
  }
}

let singleton: AgentBridgeManager | null = null

export function getAgentBridgeManager(): AgentBridgeManager {
  if (!singleton) singleton = new AgentBridgeManager()
  return singleton
}

export async function startAgentBridgeManager(): Promise<AgentBridgeManager> {
  const manager = getAgentBridgeManager()
  await manager.start()
  return manager
}
