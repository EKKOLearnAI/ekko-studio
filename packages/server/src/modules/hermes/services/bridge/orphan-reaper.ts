import { createHash, randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Ownership records for managed agent bridges (POSIX only).
 *
 * Managed bridges are spawned detached so that a Web UI restart can attach to
 * them again. When the Web UI server dies hard (SIGSEGV, SIGKILL) and the
 * restarted server cannot attach (for example because the old broker does not
 * answer the ping in time), the new broker unlinks the IPC socket path and
 * binds a fresh one. The old broker, its profile workers and their MCP helpers
 * then keep running with no way to reach them, one complete set per crash.
 *
 * The endpoint may be the legacy global default that other installs share, so
 * we never kill by endpoint alone. Instead the server records the bridge it
 * spawned, in a directory that only this user can write. A later server only
 * reaps a bridge when all of these are true:
 * - the record was written by a server process that no longer runs (pid plus
 *   start time, so a reused pid does not count);
 * - the recorded bridge process still runs with the recorded start time;
 * - its command line still contains the recorded bridge script and endpoint.
 */

export interface ProcessIdentity {
  pid: number
  /** Start time as reported by `ps -o lstart=`; guards against pid reuse. */
  start: string
}

export interface BridgeOwnerRecord {
  version: 2
  endpoint: string
  script: string
  bridge: ProcessIdentity
  server: ProcessIdentity
  createdAt: string
}

export interface ProcessInfo {
  start: string
  zombie: boolean
  command: string
}

/** `absent`: no such process. `unknown`: the lookup itself failed, so assume nothing. */
export type ProcessLookup = ProcessInfo | 'absent' | 'unknown'

export interface OrphanReaperDeps {
  processInfo(pid: number): ProcessLookup
  /** Stop the process tree whose root is `root`; implementations re-check identities before signalling. */
  killProcessTree(root: ProcessIdentity): void
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

export function bridgeOwnerRecordDir(base = tmpdir()): string {
  return join(base, `hermes-agent-bridge-owners-${currentUid() ?? 'u'}`)
}

/** Create the private record directory, or refuse one that is not safe to trust. */
export function ensurePrivateRecordDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    const uid = currentUid()
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    if (uid !== undefined && stat.uid !== uid) return false
    return (stat.mode & 0o077) === 0
  } catch {
    return false
  }
}

export function bridgeOwnerRecordPath(endpoint: string, dir = bridgeOwnerRecordDir()): string {
  // Keep the case: IPC socket paths are case-sensitive on Linux.
  const digest = createHash('sha256').update(endpoint.trim()).digest('hex').slice(0, 16)
  return join(dir, `owner-${digest}.json`)
}

function isValidIdentity(value: unknown, minPid: number): value is ProcessIdentity {
  const identity = value as ProcessIdentity
  return Boolean(identity) &&
    Number.isSafeInteger(identity.pid) && identity.pid >= minPid &&
    typeof identity.start === 'string' && identity.start.length > 0
}

export function readBridgeOwnerRecord(path: string): BridgeOwnerRecord | null {
  try {
    const stat = lstatSync(path)
    const uid = currentUid()
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BridgeOwnerRecord>
    if (
      parsed.version !== 2 ||
      typeof parsed.endpoint !== 'string' || !parsed.endpoint ||
      typeof parsed.script !== 'string' || !parsed.script.includes('hermes_bridge') ||
      // The server may be pid 1 in a container; a bridge never is.
      !isValidIdentity(parsed.bridge, 2) ||
      !isValidIdentity(parsed.server, 1)
    ) {
      return null
    }
    return parsed as BridgeOwnerRecord
  } catch {
    return null
  }
}

/** Atomic replace: write a private temp file, then rename it over the record. */
export function writeBridgeOwnerRecord(path: string, record: BridgeOwnerRecord): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  try {
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/**
 * Remove the record, but only if it still describes `bridgePid` (when given).
 * The record is first moved aside, so a record that another server writes
 * meanwhile is never deleted; a mismatching record is put back unless a
 * newer one already took its place.
 */
export function removeBridgeOwnerRecord(path: string, bridgePid?: number): void {
  const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.del`
  try {
    renameSync(path, aside)
  } catch {
    return
  }
  try {
    const moved = readBridgeOwnerRecord(aside)
    if (bridgePid !== undefined && moved && moved.bridge.pid !== bridgePid) {
      try {
        linkSync(aside, path)
      } catch {}
    }
  } finally {
    rmSync(aside, { force: true })
  }
}

/** True, false, or 'unknown' when the process table could not be read. */
export function sameProcessRuns(identity: ProcessIdentity, deps: Pick<OrphanReaperDeps, 'processInfo'>): boolean | 'unknown' {
  const info = deps.processInfo(identity.pid)
  if (info === 'unknown') return 'unknown'
  return info !== 'absent' && !info.zombie && info.start === identity.start
}

export type ReapResult =
  | { reaped: false, reason: 'no-record' | 'endpoint-mismatch' | 'owner-is-self' | 'owner-alive' | 'bridge-gone' | 'command-mismatch' | 'lookup-failed' }
  | { reaped: true, bridgePid: number, serverPid: number }

/**
 * Signal a bridge that this user spawned for `endpoint` when its owning server
 * is gone. Call it only after attaching to the endpoint has failed. The record
 * stays in place after a kill; the caller removes it once the bridge is
 * confirmed gone, so a failed kill is retried by the next start.
 */
export function reapOrphanedOwnedBridge(
  path: string,
  endpoint: string,
  self: ProcessIdentity,
  deps: OrphanReaperDeps,
): ReapResult {
  const record = readBridgeOwnerRecord(path)
  if (!record) return { reaped: false, reason: 'no-record' }
  if (record.endpoint !== endpoint) return { reaped: false, reason: 'endpoint-mismatch' }
  if (record.server.pid === self.pid && record.server.start === self.start) {
    return { reaped: false, reason: 'owner-is-self' }
  }
  const ownerRuns = sameProcessRuns(record.server, deps)
  if (ownerRuns === 'unknown') return { reaped: false, reason: 'lookup-failed' }
  if (ownerRuns) return { reaped: false, reason: 'owner-alive' }
  const bridgeInfo = deps.processInfo(record.bridge.pid)
  if (bridgeInfo === 'unknown') return { reaped: false, reason: 'lookup-failed' }
  if (bridgeInfo === 'absent' || bridgeInfo.zombie || bridgeInfo.start !== record.bridge.start) {
    removeBridgeOwnerRecord(path, record.bridge.pid)
    return { reaped: false, reason: 'bridge-gone' }
  }
  if (!bridgeInfo.command.includes(record.script) || !bridgeInfo.command.includes(endpoint)) {
    // Not the recorded bridge any more. Never touch it.
    removeBridgeOwnerRecord(path, record.bridge.pid)
    return { reaped: false, reason: 'command-mismatch' }
  }
  deps.killProcessTree(record.bridge)
  return { reaped: true, bridgePid: record.bridge.pid, serverPid: record.server.pid }
}

/** `ps` view of one process: start time, zombie state and the full command line. */
export function posixProcessInfo(pid: number): ProcessLookup {
  let out: string
  try {
    // -ww: never truncate the command line (procps-ng cuts it to the terminal width otherwise).
    out = execFileSync('ps', ['-ww', '-o', 'stat=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC', COLUMNS: '100000' },
    }).trim()
  } catch (err) {
    // ps exits 1 with no output when the pid does not exist; anything else is a failed lookup.
    const failure = err as { status?: number | null, stdout?: string }
    return failure.status === 1 && !String(failure.stdout ?? '').trim() ? 'absent' : 'unknown'
  }
  if (!out) return 'absent'
  // stat, then lstart (five fields, for example "Sun Oct 11 18:01:53 2026"), then the command.
  const match = out.match(/^(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/s)
  if (!match) return 'unknown'
  return { zombie: match[1].startsWith('Z'), start: match[2].replace(/\s+/g, ' '), command: match[3] }
}

/**
 * Descendants of `rootPid` with their start times, read from one `ps` snapshot so
 * that pid, parent and start time belong together. Throws when `ps` fails.
 */
export function posixDescendantIdentities(rootPid: number): ProcessIdentity[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart='], {
    encoding: 'utf-8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  })
  const children = new Map<number, ProcessIdentity[]>()
  for (const line of out.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)$/)
    if (!match) continue
    const identity = { pid: Number(match[1]), start: match[3].replace(/\s+/g, ' ') }
    const siblings = children.get(Number(match[2])) || []
    siblings.push(identity)
    children.set(Number(match[2]), siblings)
  }
  const descendants: ProcessIdentity[] = []
  const visit = (parentPid: number) => {
    for (const child of children.get(parentPid) || []) {
      visit(child.pid)
      descendants.push(child)
    }
  }
  visit(rootPid)
  return descendants
}

export function currentProcessIdentity(processInfo: (pid: number) => ProcessLookup = posixProcessInfo): ProcessIdentity | null {
  const info = processInfo(process.pid)
  return typeof info === 'object' ? { pid: process.pid, start: info.start } : null
}
