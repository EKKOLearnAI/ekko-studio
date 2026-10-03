import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { config } from '../../public/config'
import { getContextManagerWorkerState, restartHermesContextManagerWorker } from '../../public/context-manager-worker'
import { safeFileStore } from '../../public/safe-file-store'
import { ContextManagerError, getContextManagerSettings, profileKey, type ContextManagerLifecycleAction, type ContextManagerName } from './settings'

export interface ContextManagerLifecycleState {
  supported: true
  installed: boolean
  version: string | null
  running: boolean
  management: 'studio' | 'external' | 'none'
  runtimeOrigin: string | null
  configFile: string
}
export interface ContextManagerLifecycleResult {
  manager: ContextManagerName
  action: ContextManagerLifecycleAction
  status: 'installed' | 'started' | 'stopped' | 'upgraded'
  lifecycle: ContextManagerLifecycleState
}
const actions = new Set(['install', 'start', 'stop', 'upgrade'])
const children = new Map<string, { child: ChildProcess; origin: string }>()
const releasePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export async function restartContextManagerWorker(profile: string, input: unknown): Promise<unknown> {
  const name = profileKey(profile)
  if (object(input).profile !== name) throw new ContextManagerError('The selected profile changed; refresh and try again', 409, 'context_manager_profile_changed')
  return writer(contextManagerPaths(name), async () => {
    const state = await getContextManagerWorkerState(name)
    if (state.profile !== name || state.status === 'unknown' || !Number.isSafeInteger(state.runningSessions) || state.runningSessions! < 0
      || !Number.isSafeInteger(state.activeSessions) || state.activeSessions! < 0) {
      throw new ContextManagerError('Cannot verify running sessions', 503, 'context_manager_worker_unavailable')
    }
    if (state.runningSessions! > 0) throw new ContextManagerError('Wait for running sessions to finish before restarting', 409, 'context_manager_sessions_running')
    if (object(input).confirm !== true) throw new ContextManagerError('Confirm that idle sessions will reconnect before restarting', 409, 'context_manager_confirmation_required')
    try { await restartHermesContextManagerWorker(name) } catch (error) {
      const code = object(error).code
      if (code === 'context_manager_sessions_running') throw new ContextManagerError('Wait for running sessions to finish before restarting', 409, code)
      if (code === 'context_manager_busy') throw new ContextManagerError('Worker restart is already in progress', 409, code)
      throw new ContextManagerError('Could not restart the Hermes worker', 503, 'context_manager_restart_failed')
    }
    const worker = await getContextManagerWorkerState(name)
    if (worker.profile !== name || worker.status !== 'running' || !worker.pids.length || worker.pids.some(pid => state.pids.includes(pid))) {
      throw new ContextManagerError('Could not verify that the Hermes worker restarted', 503, 'context_manager_restart_failed')
    }
    return { profile: name, status: 'restarted', worker }
  })
}

export function contextManagerPaths(profile: string) {
  const key = createHash('sha256').update(profileKey(profile)).digest('hex')
  const root = join(config.appHome, 'context-manager', key)
  return { root, configFile: join(root, 'config', 'billion-context', 'billion-context.json'), activeFile: join(root, 'active.json') }
}
type RuntimePaths = ReturnType<typeof contextManagerPaths>

export function contextManagerEnvironment(paths: RuntimePaths, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (/^(BILI_|ACP_|NPM_CONFIG_|npm_config_)/.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key]
  }
  return {
    ...env,
    XDG_CONFIG_HOME: join(paths.root, 'config'), XDG_DATA_HOME: join(paths.root, 'data'),
    XDG_CACHE_HOME: join(paths.root, 'cache'), XDG_STATE_HOME: join(paths.root, 'state'),
    BILI_CONFIG_FILE: paths.configFile, BILI_SESSIONS_DIR: join(paths.root, 'data', 'billion-context', 'sessions'),
    BILI_PARENT_PID: String(process.pid), ACP_AUTO_UPDATE: '0', ELECTRON_RUN_AS_NODE: '1',
  }
}
function alive(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null && !!child.pid }
function owned(paths: RuntimePaths) {
  const entry = children.get(paths.root)
  if (entry && alive(entry.child)) return entry
  children.delete(paths.root)
  return undefined
}

export function getManagedContextManagerCaBundle(profile: string, origin: string): string | undefined {
  const paths = contextManagerPaths(profile)
  if (owned(paths)?.origin !== origin) return undefined
  return join(paths.root, 'data', 'billion-context', 'ca', 'combined-ca.pem')
}
async function installed(paths: RuntimePaths) {
  try {
    const pointer = JSON.parse(await readFile(paths.activeFile, 'utf8')) as { release?: unknown }
    if (typeof pointer.release !== 'string' || !releasePattern.test(pointer.release)) throw new Error('Invalid release pointer')
    return await inspectRelease(join(paths.root, 'releases', pointer.release))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ContextManagerError('Managed installation is invalid', 500, 'context_manager_installation_invalid')
  }
}
async function inspectRelease(directory: string) {
  const pkg = join(directory, 'node_modules', 'billion-context')
  const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')) as { name?: string; version?: string }
  if (metadata.name !== 'billion-context' || !metadata.version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(metadata.version)) throw new Error('Invalid package metadata')
  const cli = join(pkg, 'dist', 'index.js')
  await access(cli)
  return { cli, version: metadata.version }
}
function endpoint(proxyUrl: string) {
  const url = new URL(proxyUrl)
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }
}
async function occupied(proxyUrl: string): Promise<boolean> {
  const target = endpoint(proxyUrl)
  return new Promise((resolve, reject) => {
    const socket = connect(target)
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(750, () => { socket.destroy(); reject(new ContextManagerError('Cannot determine proxy port ownership', 503, 'context_manager_port_unknown')) })
    socket.once('connect', () => finish(true))
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish(false)
      else { socket.destroy(); reject(new ContextManagerError('Cannot determine proxy port ownership', 503, 'context_manager_port_unknown')) }
    })
  })
}
export async function getContextManagerLifecycleState(profile: string): Promise<ContextManagerLifecycleState> {
  const paths = contextManagerPaths(profile)
  const [installation, settings] = await Promise.all([installed(paths), getContextManagerSettings(profile)])
  const entry = owned(paths)
  const external = !entry && await occupied(settings.proxyUrl)
  return {
    supported: true, installed: !!installation, version: installation?.version ?? null,
    running: !!entry || external, management: entry ? 'studio' : external ? 'external' : 'none',
    runtimeOrigin: entry?.origin ?? (external ? settings.proxyUrl : null), configFile: paths.configFile,
  }
}
async function writer<T>(paths: RuntimePaths, action: () => Promise<T>): Promise<T> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  const lock = join(paths.root, '.writer')
  try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ContextManagerError('Context manager operation is already running', 409, 'context_manager_busy')
    throw error
  }
  // No stale-lock guessing: another Studio process may still be installing.
  try { return await action() } finally { await rm(lock, { recursive: true, force: true }) }
}
async function npmCli(): Promise<string> {
  const bin = dirname(process.execPath)
  const candidates = [
    process.env.npm_execpath,
    join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(bin), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...((process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').map(path => join(path, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))),
  ]
  for (const candidate of candidates) {
    if (!candidate || !candidate.endsWith('npm-cli.js')) continue
    try { await access(candidate); return resolve(candidate) } catch { /* Try next known npm layout. */ }
  }
  throw new ContextManagerError('Node/npm is unavailable', 503, 'context_manager_npm_unavailable')
}
async function installRelease(paths: RuntimePaths): Promise<void> {
  const release = randomUUID()
  const directory = join(paths.root, 'releases', release)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const cli = await npmCli()
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [cli, 'install', '--prefix', directory, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', 'billion-context@latest'], {
        cwd: paths.root, env: { ...contextManagerEnvironment(paths), npm_config_cache: join(paths.root, 'cache', 'npm'), npm_config_userconfig: join(paths.root, 'npmrc'), npm_config_globalconfig: join(paths.root, 'global-npmrc') },
        timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true,
      }, error => error ? reject(new ContextManagerError('Managed package installation failed', 502, 'context_manager_install_failed')) : resolve())
    })
    await inspectRelease(directory)
    await safeFileStore.updateText(paths.activeFile, () => ({ content: JSON.stringify({ release }), result: undefined }))
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
async function stopChild(paths: RuntimePaths): Promise<void> {
  const entry = owned(paths)
  if (!entry) return
  const child = entry.child
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5000)])
  if (alive(child)) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(2000)])
  }
  if (alive(child)) throw new ContextManagerError('Managed proxy did not stop', 503, 'context_manager_stop_failed')
  children.delete(paths.root)
}
async function startChild(paths: RuntimePaths, origin: string): Promise<void> {
  const current = owned(paths)
  if (current) {
    if (current.origin !== origin) throw new ContextManagerError('Stop the managed proxy before changing its origin', 409, 'context_manager_origin_changed')
    return
  }
  if (new URL(origin).protocol !== 'http:') throw new ContextManagerError('Managed bili processes require an HTTP origin', 400, 'context_manager_https_external_only')
  if (await occupied(origin)) throw externalError()
  const installation = await installed(paths)
  if (!installation) throw new ContextManagerError('Install billion-context first', 409, 'context_manager_not_installed')
  await mkdir(dirname(paths.configFile), { recursive: true, mode: 0o700 })
  try { await writeFile(paths.configFile, JSON.stringify({ providers: {}, autoUpdate: false }), { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const target = endpoint(origin)
  const child = spawn(process.execPath, [installation.cli, 'start', '--config', paths.configFile, '--host', target.host, '--port', String(target.port), '--no-auto-update'], {
    cwd: paths.root, env: contextManagerEnvironment(paths), stdio: 'ignore', windowsHide: true,
  })
  let spawnError = false
  child.on('error', () => { spawnError = true })
  children.set(paths.root, { child, origin })
  child.once('exit', () => { if (children.get(paths.root)?.child === child) children.delete(paths.root) })
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(100)
      if (spawnError || !alive(child)) break
      try {
        const response = await fetch(`${origin}/__bili/status`, { redirect: 'error', signal: AbortSignal.timeout(500) })
        if (response.ok && (await response.json() as { version?: string }).version === installation.version && alive(child)) return
      } catch { /* Allow startup to finish within the bounded readiness window. */ }
    }
    throw new ContextManagerError('Managed proxy failed to become ready', 503, 'context_manager_start_failed')
  } catch (error) { await stopChild(paths); throw error }
}
function externalError() { return new ContextManagerError('Proxy is externally managed', 409, 'context_manager_externally_managed') }

export async function runContextManagerLifecycle(profile: string, manager: ContextManagerName, action: string): Promise<ContextManagerLifecycleResult> {
  const paths = contextManagerPaths(profile)
  if ((manager !== 'hermes' && manager !== 'ekko') || !actions.has(action)) throw new ContextManagerError('Context manager lifecycle action is invalid')
  return writer(paths, async () => {
    const state = await getContextManagerLifecycleState(profile)
    if (state.management === 'external' && action !== 'install') throw externalError()
    const settings = await getContextManagerSettings(profile)
    if (action === 'install') {
      if (!state.installed) await installRelease(paths)
    } else if (action === 'start') {
      await startChild(paths, settings.proxyUrl)
    } else if (action === 'stop') {
      await stopChild(paths)
    } else {
      if (state.running) throw new ContextManagerError('Stop the managed proxy before upgrading', 409, 'context_manager_upgrade_running')
      await installRelease(paths)
    }
    return { manager, action: action as ContextManagerLifecycleAction, status: ({ install: 'installed', start: 'started', stop: 'stopped', upgrade: 'upgraded' } as const)[action as ContextManagerLifecycleAction], lifecycle: await getContextManagerLifecycleState(profile) }
  })
}