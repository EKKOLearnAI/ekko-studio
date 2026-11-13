import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { logger } from '../../../studio/public/logging'
import { getActiveProfileDir } from '../profiles/profile'
import { spawnHermesWithBin } from '../runtime/process'

interface SupervisedGateway {
  pid: number
  child: ReturnType<typeof spawnHermesWithBin>
  hermesBin: string
  profileDir: string
  startedAt: number
}

/**
 * Per-profile state for our supervised gateway.
 *
 * - `current` is the most recent child we spawned for this profile. When it
 *   exits, the exit handler clears this slot.
 * - `respawnTimer` is a pending respawn that was scheduled because the
 *   previous child died and no replacement has been started yet. The next
 *   call to `startGatewayRunManaged` for the same profile clears it: a fresh
 *   start is already happening, so a respawn would race with it.
 *
 * This is what makes `/restart` safe. The flow is:
 *   1. `/restart` calls `hermes gateway stop` (CLI) which kills our child.
 *   2. That child's exit handler schedules a respawn timer (step T+0).
 *   3. `/restart` then calls `startGatewayRunManaged` for the same profile.
 *   4. That call clears the pending respawn timer (we're starting a new one
 *      anyway) and registers the fresh child.
 *
 * Net result: exactly one new gateway per `/restart`, no orphans.
 */
interface ProfileState {
  current: SupervisedGateway | null
  respawnTimer: NodeJS.Timeout | null
  respawnAttempts: number
}

const profileState = new Map<string, ProfileState>()
const stoppingGateways = new Map<number, SupervisedGateway>()
let managedGatewayShutdownStarted = false

/** Delay before respawning a gateway that exited unexpectedly. */
const RESPAWN_DELAY_MS = 2000
const RESPAWN_STABLE_RUN_MS = 30000
const MAX_RESPAWN_ATTEMPTS = 3
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000
const execFileAsync = promisify(execFile)

export interface ManagedGatewayShutdownResult {
  signaled: number
  forced: number
  errors: number
}

function getOrCreateProfileState(profileDir: string): ProfileState {
  let state = profileState.get(profileDir)
  if (!state) {
    state = { current: null, respawnTimer: null, respawnAttempts: 0 }
    profileState.set(profileDir, state)
  }
  return state
}

type KillWindowsProcessTree = (pid: number) => Promise<void>
type ForceKillWindowsProcessTree = (pid: number) => void
type ListPosixDescendantPids = (pid: number) => number[]
type KillPosixPid = (pid: number, signal: NodeJS.Signals) => void

function clearRespawnTimer(state: ProfileState, profileDir: string): void {
  if (!state.respawnTimer) return
  clearTimeout(state.respawnTimer)
  state.respawnTimer = null
  logger.info('[gateway-runner] cancelled pending respawn profileDir=%s', profileDir)
}

async function taskkillWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    timeout: 5000,
    windowsHide: true,
  })
}

function forceTaskkillWindowsProcessTree(pid: number): void {
  execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    timeout: 5000,
    windowsHide: true,
    stdio: 'ignore',
  })
}

function posixDescendantPids(rootPid: number): number[] {
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], {
      encoding: 'utf-8',
      timeout: 5000,
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

function killPosixPid(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal)
}

function forceKillKnownPosixDescendants(
  descendantPids: Iterable<number>,
  killPid: KillPosixPid,
): number {
  let killed = 0
  for (const pid of new Set(descendantPids)) {
    try {
      killPid(pid, 'SIGKILL')
      killed += 1
    } catch {
      // The gateway may have already reaped this child during graceful exit.
    }
  }
  return killed
}

function forceKillManagedGateway(
  entry: SupervisedGateway,
  opts: {
    platform: NodeJS.Platform
    forceKillWindowsProcessTree: ForceKillWindowsProcessTree
    listPosixDescendantPids: ListPosixDescendantPids
    killPosixPid: KillPosixPid
  },
): void {
  if (opts.platform === 'win32') {
    try {
      opts.forceKillWindowsProcessTree(entry.pid)
      return
    } catch (err) {
      logger.warn(err, '[gateway-runner] forced taskkill failed for managed gateway pid=%s; falling back to child.kill', entry.pid)
      try { entry.child.kill('SIGKILL') } catch {}
      return
    }
  }

  forceKillKnownPosixDescendants(opts.listPosixDescendantPids(entry.pid), opts.killPosixPid)
  try {
    // Managed POSIX gateways are spawned detached, so this also catches any
    // descendants which stayed in the gateway process group.
    opts.killPosixPid(-entry.pid, 'SIGKILL')
  } catch {
    try { entry.child.kill('SIGKILL') } catch {}
  }
}

async function stopManagedGateway(
  entry: SupervisedGateway,
  opts: {
    timeoutMs: number
    platform: NodeJS.Platform
    killWindowsProcessTree: KillWindowsProcessTree
    listPosixDescendantPids: ListPosixDescendantPids
    killPosixPid: KillPosixPid
  },
): Promise<{ forced: boolean; error?: unknown }> {
  if (opts.platform === 'win32') {
    try {
      await opts.killWindowsProcessTree(entry.pid)
      return { forced: true }
    } catch (err) {
      logger.warn(err, '[gateway-runner] taskkill failed for managed gateway pid=%s; falling back to child.kill', entry.pid)
      try {
        entry.child.kill('SIGKILL')
        return { forced: true, error: err }
      } catch (killErr) {
        return { forced: true, error: killErr }
      }
    }
  }

  const ownedDescendantPids = opts.listPosixDescendantPids(entry.pid)

  return new Promise(resolve => {
    let settled = false
    let forced = false

    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      entry.child.off('exit', onExit)
      resolve({ forced, error })
    }

    const onExit = () => {
      // The gateway may exit before its MCP/watchdog descendants. Once their
      // parent is gone they are reparented and can no longer be rediscovered
      // from the gateway PID, so clean the ownership snapshot taken above.
      if (forceKillKnownPosixDescendants(ownedDescendantPids, opts.killPosixPid) > 0) {
        forced = true
      }
      finish()
    }
    const timer = setTimeout(() => {
      forced = true
      const descendants = [
        ...ownedDescendantPids,
        ...opts.listPosixDescendantPids(entry.pid),
      ]
      forceKillKnownPosixDescendants(descendants, opts.killPosixPid)
      try {
        entry.child.kill('SIGKILL')
      } catch (err) {
        finish(err)
        return
      }
      finish()
    }, opts.timeoutMs)

    entry.child.once('exit', onExit)

    try {
      const signaled = entry.child.kill('SIGTERM')
      if (!signaled) finish(new Error(`Failed to signal managed gateway pid=${entry.pid}`))
    } catch (err) {
      finish(err)
    }
  })
}

export async function shutdownManagedGateways(
  opts: {
    timeoutMs?: number
    platform?: NodeJS.Platform
    killWindowsProcessTree?: KillWindowsProcessTree
    listPosixDescendantPids?: ListPosixDescendantPids
    killPosixPid?: KillPosixPid
  } = {},
): Promise<ManagedGatewayShutdownResult> {
  // This is a process-lifecycle boundary, not a profile reconcile. Once it
  // starts, an in-flight bootstrap/autostart task must not create a new
  // detached gateway after the ownership registry has been drained.
  managedGatewayShutdownStarted = true
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const platform = opts.platform ?? process.platform
  const killWindowsProcessTree = opts.killWindowsProcessTree ?? taskkillWindowsProcessTree
  const listDescendants = opts.listPosixDescendantPids ?? posixDescendantPids
  const killPid = opts.killPosixPid ?? killPosixPid
  const stops: Promise<{ forced: boolean; error?: unknown }>[] = []
  let signaled = 0

  for (const [profileDir, state] of profileState) {
    clearRespawnTimer(state, profileDir)

    const entry = state.current
    if (!entry) {
      profileState.delete(profileDir)
      continue
    }

    state.current = null
    signaled += 1
    logger.info('[gateway-runner] stopping managed gateway profileDir=%s pid=%s', profileDir, entry.pid)
    stoppingGateways.set(entry.pid, entry)
    stops.push(stopManagedGateway(entry, {
      timeoutMs,
      platform,
      killWindowsProcessTree,
      listPosixDescendantPids: listDescendants,
      killPosixPid: killPid,
    }).finally(() => stoppingGateways.delete(entry.pid)))
    profileState.delete(profileDir)
  }

  const results = await Promise.all(stops)
  const forced = results.filter(result => result.forced).length
  const errors = results.filter(result => result.error).length

  if (signaled > 0) {
    logger.info('[gateway-runner] managed gateway shutdown complete signaled=%s forced=%s errors=%s', signaled, forced, errors)
  }

  return { signaled, forced, errors }
}

export async function retireManagedGatewayForProfile(
  profileDir: string,
  opts: {
    timeoutMs?: number
    platform?: NodeJS.Platform
    killWindowsProcessTree?: KillWindowsProcessTree
    listPosixDescendantPids?: ListPosixDescendantPids
    killPosixPid?: KillPosixPid
  } = {},
): Promise<ManagedGatewayShutdownResult> {
  const state = profileState.get(profileDir)
  if (!state) return { signaled: 0, forced: 0, errors: 0 }

  clearRespawnTimer(state, profileDir)

  const entry = state.current
  state.current = null
  profileState.delete(profileDir)

  if (!entry) return { signaled: 0, forced: 0, errors: 0 }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const platform = opts.platform ?? process.platform
  const killWindowsProcessTree = opts.killWindowsProcessTree ?? taskkillWindowsProcessTree
  const listDescendants = opts.listPosixDescendantPids ?? posixDescendantPids
  const killPid = opts.killPosixPid ?? killPosixPid

  logger.info('[gateway-runner] retiring managed gateway profileDir=%s pid=%s', profileDir, entry.pid)
  stoppingGateways.set(entry.pid, entry)
  const result = await stopManagedGateway(entry, {
    timeoutMs,
    platform,
    killWindowsProcessTree,
    listPosixDescendantPids: listDescendants,
    killPosixPid: killPid,
  }).finally(() => stoppingGateways.delete(entry.pid))
  const forced = result.forced ? 1 : 0
  const errors = result.error ? 1 : 0

  logger.info(
    '[gateway-runner] managed gateway retire complete profileDir=%s signaled=1 forced=%s errors=%s',
    profileDir,
    forced,
    errors,
  )

  return { signaled: 1, forced, errors }
}

export function forceStopManagedGateways(
  opts: {
    platform?: NodeJS.Platform
    forceKillWindowsProcessTree?: ForceKillWindowsProcessTree
    listPosixDescendantPids?: ListPosixDescendantPids
    killPosixPid?: KillPosixPid
  } = {},
): number {
  managedGatewayShutdownStarted = true
  const platform = opts.platform ?? process.platform
  const forceKillWindowsProcessTree = opts.forceKillWindowsProcessTree ?? forceTaskkillWindowsProcessTree
  const listDescendants = opts.listPosixDescendantPids ?? posixDescendantPids
  const killPid = opts.killPosixPid ?? killPosixPid
  const entries = new Map<number, SupervisedGateway>(stoppingGateways)

  for (const [profileDir, state] of profileState) {
    clearRespawnTimer(state, profileDir)
    if (state.current) entries.set(state.current.pid, state.current)
    state.current = null
    profileState.delete(profileDir)
  }

  for (const entry of entries.values()) {
    forceKillManagedGateway(entry, {
      platform,
      forceKillWindowsProcessTree,
      listPosixDescendantPids: listDescendants,
      killPosixPid: killPid,
    })
    stoppingGateways.delete(entry.pid)
  }

  if (entries.size > 0) {
    logger.warn('[gateway-runner] force-stopped managed gateway trees count=%s', entries.size)
  }
  return entries.size
}

export function startGatewayRunManaged(
  hermesBin: string,
  opts: { profileDir?: string } = {},
): { pid: number | null; reused: boolean } {
  return startGatewayRunManagedInternal(hermesBin, {
    profileDir: opts.profileDir,
    preserveRespawnAttempts: false,
  })
}

function startGatewayRunManagedInternal(
  hermesBin: string,
  opts: { profileDir?: string; preserveRespawnAttempts?: boolean } = {},
): { pid: number | null; reused: boolean } {
  const profileDir = opts.profileDir || getActiveProfileDir()
  if (managedGatewayShutdownStarted) {
    logger.warn('[gateway-runner] refusing managed gateway start after shutdown began profileDir=%s', profileDir)
    return { pid: null, reused: false }
  }
  const state = getOrCreateProfileState(profileDir)

  // A new spawn for this profile cancels any pending respawn from a previous
  // unexpected exit. Without this, `/restart` (stop -> start) would race
  // against the respawn timer and end up with two gateways on the same port.
  clearRespawnTimer(state, profileDir)
  if (!opts.preserveRespawnAttempts) {
    state.respawnAttempts = 0
  }

  const child = spawnHermesWithBin(hermesBin, ['gateway', 'run', '--replace'], {
    // On Windows, detached:true uses DETACHED_PROCESS. That makes
    // CREATE_NO_WINDOW/windowsHide ineffective and exposes the venv
    // Scripts\python.exe console. The server already supervises this child,
    // so keep it attached there; POSIX still needs a detached process group.
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      HERMES_HOME: profileDir,
    },
  })
  child.once('error', (err) => {
    if (child.pid && state.current?.pid === child.pid) state.current = null
    logger.error(err, '[gateway-runner] failed to spawn Hermes gateway profileDir=%s bin=%s', profileDir, hermesBin)
  })
  child.unref()

  const pid = child.pid ?? null
  if (pid) {
    const entry: SupervisedGateway = { pid, child, hermesBin, profileDir, startedAt: Date.now() }
    state.current = entry

    child.on('exit', (code, signal) => {
      // Only act if this is still the active child for the profile. A new
      // start for the same profile replaces `state.current` and we don't
      // want the old child's exit to trigger anything.
      if (state.current?.pid !== pid) return
      state.current = null
      if (Date.now() - entry.startedAt >= RESPAWN_STABLE_RUN_MS) {
        state.respawnAttempts = 0
      }
      state.respawnAttempts += 1

      if (state.respawnAttempts > MAX_RESPAWN_ATTEMPTS) {
        logger.error(
          '[gateway-runner] gateway exited unexpectedly and reached respawn limit (profileDir=%s pid=%s code=%s signal=%s attempts=%s maxAttempts=%s)',
          profileDir, pid, code, signal, state.respawnAttempts - 1, MAX_RESPAWN_ATTEMPTS,
        )
        return
      }

      logger.warn(
        '[gateway-runner] gateway exited unexpectedly (profileDir=%s pid=%s code=%s signal=%s attempt=%s/%s), respawning in %dms',
        profileDir, pid, code, signal, state.respawnAttempts, MAX_RESPAWN_ATTEMPTS, RESPAWN_DELAY_MS,
      )

      state.respawnTimer = setTimeout(() => {
        state.respawnTimer = null
        try {
          const next = startGatewayRunManagedInternal(hermesBin, {
            profileDir,
            preserveRespawnAttempts: true,
          })
          logger.info(
            '[gateway-runner] gateway respawned (oldPid=%s newPid=%s profileDir=%s attempt=%s/%s)',
            pid, next.pid, profileDir, state.respawnAttempts, MAX_RESPAWN_ATTEMPTS,
          )
        } catch (err) {
          logger.error(err, '[gateway-runner] failed to respawn gateway after unexpected exit')
        }
      }, RESPAWN_DELAY_MS)
      // Don't keep the event loop alive just for a pending respawn.
      state.respawnTimer.unref()
    })
  }

  return { pid, reused: false }
}
