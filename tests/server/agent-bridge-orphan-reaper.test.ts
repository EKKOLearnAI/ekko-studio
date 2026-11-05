import { execFileSync, spawn } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeOwnerRecordDir,
  bridgeOwnerRecordPath,
  currentProcessIdentity,
  ensurePrivateRecordDir,
  posixProcessInfo,
  readBridgeOwnerRecord,
  reapOrphanedOwnedBridge,
  removeBridgeOwnerRecord,
  sameProcessRuns,
  writeBridgeOwnerRecord,
  type BridgeOwnerRecord,
  type OrphanReaperDeps,
  type ProcessInfo,
  type ProcessLookup,
} from '../../packages/server/src/modules/hermes/services/bridge/orphan-reaper'

const ENDPOINT = 'ipc:///tmp/hermes-agent-bridge.sock'
const SCRIPT = '/opt/studio/dist/server/agent-bridge/python/hermes_bridge.py'
const SELF = { pid: 2222, start: 'Sun Oct 11 18:00:00 2026' }
const OLD_SERVER = { pid: 1111, start: 'Sun Oct 11 17:00:00 2026' }
const BRIDGE = { pid: 4242, start: 'Sun Oct 11 17:00:05 2026' }
const BRIDGE_CMD = `python3 -I -c runpy ${SCRIPT} --endpoint ${ENDPOINT}`

function record(overrides: Partial<BridgeOwnerRecord> = {}): BridgeOwnerRecord {
  return {
    version: 2,
    endpoint: ENDPOINT,
    script: SCRIPT,
    bridge: BRIDGE,
    server: OLD_SERVER,
    createdAt: '2026-10-11T21:00:05.000Z',
    ...overrides,
  }
}

function deps(table: Record<number, ProcessLookup> = {
  [BRIDGE.pid]: { start: BRIDGE.start, zombie: false, command: BRIDGE_CMD },
}): OrphanReaperDeps & { killProcessTree: ReturnType<typeof vi.fn> } {
  return {
    processInfo: (pid: number) => table[pid] ?? 'absent',
    killProcessTree: vi.fn(),
  }
}

function info(pid: number): ProcessInfo | null {
  const lookup = posixProcessInfo(pid)
  return typeof lookup === 'object' ? lookup : null
}

/** Identity of a process that ran and has exited. The exit listener is attached before any waiting. */
async function deadServerIdentity(): Promise<{ pid: number, start: string }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' })
  const exited = new Promise(resolve => child.once('exit', resolve))
  let start = ''
  for (let i = 0; i < 25 && !start; i += 1) {
    start = info(child.pid as number)?.start ?? ''
    if (!start) await new Promise(resolve => setTimeout(resolve, 10))
  }
  await exited
  expect(start).not.toBe('')
  return { pid: child.pid as number, start }
}

describe('agent bridge orphan reaper', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'bridge-owner-test-')), 'records')
    expect(ensurePrivateRecordDir(dir)).toBe(true)
    path = bridgeOwnerRecordPath(ENDPOINT, dir)
  })

  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  it('keeps one record per exact endpoint, case included', () => {
    expect(bridgeOwnerRecordPath(` ${ENDPOINT} `, dir)).toBe(path)
    expect(bridgeOwnerRecordPath(ENDPOINT.replace('hermes', 'Hermes'), dir)).not.toBe(path)
    expect(bridgeOwnerRecordDir('/base')).toMatch(/^\/base\/hermes-agent-bridge-owners-/)
  })

  it.skipIf(process.platform === 'win32')('refuses a record directory that others can write or that is a symlink', () => {
    const open = join(dir, '..', 'open')
    mkdirSync(open, { mode: 0o777 })
    chmodSync(open, 0o777)
    expect(ensurePrivateRecordDir(open)).toBe(false)
    const link = join(dir, '..', 'link')
    symlinkSync(dir, link)
    expect(ensurePrivateRecordDir(link)).toBe(false)
  })

  it('ignores corrupt, old-format and implausible records', () => {
    writeFileSync(path, '{not json')
    expect(readBridgeOwnerRecord(path)).toBeNull()
    writeFileSync(path, JSON.stringify({ version: 1, endpoint: ENDPOINT, script: SCRIPT, bridgePid: 4242, serverPid: 1111 }))
    expect(readBridgeOwnerRecord(path)).toBeNull()
    writeFileSync(path, JSON.stringify(record({ script: '' })))
    expect(readBridgeOwnerRecord(path)).toBeNull()
    writeFileSync(path, JSON.stringify(record({ bridge: { pid: 1, start: BRIDGE.start } })))
    expect(readBridgeOwnerRecord(path)).toBeNull()
    const d = deps()
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, d)).toEqual({ reaped: false, reason: 'no-record' })
    expect(d.killProcessTree).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('ignores a record that is a symlink', () => {
    const target = join(dir, 'elsewhere.json')
    writeBridgeOwnerRecord(target, record())
    symlinkSync(target, path)
    expect(readBridgeOwnerRecord(path)).toBeNull()
  })

  it('does nothing without a record', () => {
    const d = deps()
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, d)).toEqual({ reaped: false, reason: 'no-record' })
    expect(d.killProcessTree).not.toHaveBeenCalled()
  })

  it('keeps the bridge while its owning server still runs', () => {
    writeBridgeOwnerRecord(path, record())
    const d = deps({
      [OLD_SERVER.pid]: { start: OLD_SERVER.start, zombie: false, command: 'node index.js' },
      [BRIDGE.pid]: { start: BRIDGE.start, zombie: false, command: BRIDGE_CMD },
    })
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, d)).toEqual({ reaped: false, reason: 'owner-alive' })
    expect(d.killProcessTree).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(true)
  })

  it('treats a reused server pid or a zombie server as gone', () => {
    writeBridgeOwnerRecord(path, record())
    const reused = deps({
      [OLD_SERVER.pid]: { start: 'Sun Oct 11 18:05:00 2026', zombie: false, command: 'unrelated' },
      [BRIDGE.pid]: { start: BRIDGE.start, zombie: false, command: BRIDGE_CMD },
    })
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, reused)).toMatchObject({ reaped: true })

    const zombie = deps({
      [OLD_SERVER.pid]: { start: OLD_SERVER.start, zombie: true, command: '' },
      [BRIDGE.pid]: { start: BRIDGE.start, zombie: false, command: BRIDGE_CMD },
    })
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, zombie)).toMatchObject({ reaped: true })
  })

  it('keeps a bridge that this server owns', () => {
    writeBridgeOwnerRecord(path, record({ server: SELF }))
    const d = deps()
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, d)).toEqual({ reaped: false, reason: 'owner-is-self' })
    expect(d.killProcessTree).not.toHaveBeenCalled()
  })

  it('ignores a record for a different endpoint', () => {
    writeBridgeOwnerRecord(path, record({ endpoint: 'tcp://127.0.0.1:18765' }))
    const d = deps()
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, d)).toEqual({ reaped: false, reason: 'endpoint-mismatch' })
    expect(d.killProcessTree).not.toHaveBeenCalled()
  })

  it('signals the bridge tree when its server is gone and leaves the record for the caller', () => {
    writeBridgeOwnerRecord(path, record())
    const d = deps()
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, d)).toEqual({ reaped: true, bridgePid: BRIDGE.pid, serverPid: OLD_SERVER.pid })
    expect(d.killProcessTree).toHaveBeenCalledWith(BRIDGE)
    expect(readBridgeOwnerRecord(path)?.bridge).toEqual(BRIDGE)
  })

  it('never kills a reused bridge pid', () => {
    writeBridgeOwnerRecord(path, record())
    const newer = deps({ [BRIDGE.pid]: { start: 'Sun Oct 11 18:10:00 2026', zombie: false, command: BRIDGE_CMD } })
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, newer)).toEqual({ reaped: false, reason: 'bridge-gone' })
    expect(newer.killProcessTree).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)

    writeBridgeOwnerRecord(path, record())
    const other = deps({ [BRIDGE.pid]: { start: BRIDGE.start, zombie: false, command: '/usr/bin/some-other-program' } })
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, other)).toEqual({ reaped: false, reason: 'command-mismatch' })
    expect(other.killProcessTree).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })

  it('drops the record when the bridge is already gone', () => {
    writeBridgeOwnerRecord(path, record())
    const d = deps({})
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, d)).toEqual({ reaped: false, reason: 'bridge-gone' })
    expect(d.killProcessTree).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })

  it('removes the record only for the matching bridge pid', () => {
    writeBridgeOwnerRecord(path, record({ bridge: { pid: 5555, start: BRIDGE.start } }))
    removeBridgeOwnerRecord(path, BRIDGE.pid)
    expect(readBridgeOwnerRecord(path)?.bridge.pid).toBe(5555)
    removeBridgeOwnerRecord(path, 5555)
    expect(existsSync(path)).toBe(false)
  })

  it('does nothing and keeps the record when the process table cannot be read', () => {
    writeBridgeOwnerRecord(path, record())
    const ownerUnknown = deps({ [OLD_SERVER.pid]: 'unknown', [BRIDGE.pid]: { start: BRIDGE.start, zombie: false, command: BRIDGE_CMD } })
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, ownerUnknown)).toEqual({ reaped: false, reason: 'lookup-failed' })
    const bridgeUnknown = deps({ [BRIDGE.pid]: 'unknown' })
    expect(reapOrphanedOwnedBridge(path, ENDPOINT, SELF, bridgeUnknown)).toEqual({ reaped: false, reason: 'lookup-failed' })
    expect(ownerUnknown.killProcessTree).not.toHaveBeenCalled()
    expect(bridgeUnknown.killProcessTree).not.toHaveBeenCalled()
    expect(readBridgeOwnerRecord(path)).not.toBeNull()
  })

  it('accepts a container server with pid 1 but never a bridge with pid 1', () => {
    writeBridgeOwnerRecord(path, record({ server: { pid: 1, start: OLD_SERVER.start } }))
    expect(readBridgeOwnerRecord(path)?.server.pid).toBe(1)
    writeBridgeOwnerRecord(path, record({ bridge: { pid: 1, start: BRIDGE.start } }))
    expect(readBridgeOwnerRecord(path)).toBeNull()
  })

  it('treats a matching zombie as not running', () => {
    const table: Record<number, ProcessLookup> = { [BRIDGE.pid]: { start: BRIDGE.start, zombie: true, command: '' } }
    expect(sameProcessRuns(BRIDGE, { processInfo: pid => table[pid] ?? 'absent' })).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('agent bridge orphan reaper with real processes', () => {
  const keepAlive = 'setInterval(() => {}, 1000)'
  const cleanup: number[] = []
  let base: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bridge-owner-real-'))
  })

  afterEach(() => {
    for (const pid of cleanup) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    cleanup.length = 0
    rmSync(base, { recursive: true, force: true })
  })

  /** Start a process as a real orphan (re-parented to init), like a bridge left behind by a crashed server. */
  function startOrphan(args: string[]): number {
    const quoted = args.map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')
    const pid = Number(execFileSync('sh', ['-c', `"${process.execPath}" ${quoted} >/dev/null 2>&1 & echo $!`], {
      encoding: 'utf-8',
    }).trim())
    cleanup.push(pid)
    return pid
  }

  async function deadIdentity(): Promise<{ pid: number, start: string }> {
    return deadServerIdentity()
  }

  async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return check()
  }

  it('reads start time, zombie state and command line from ps', () => {
    const self = currentProcessIdentity()
    expect(self?.pid).toBe(process.pid)
    expect(self?.start).toMatch(/\d{4}$/)
    expect(info(process.pid)?.command).toContain('node')
  })

  it('reads the full command line even when the terminal is narrow', async () => {
    const longEndpoint = `ipc://${join(base, 'x'.repeat(300), 'bridge.sock')}`
    const pid = startOrphan(['-e', keepAlive, join(base, 'hermes_bridge.py'), '--endpoint', longEndpoint])
    const previous = process.env.COLUMNS
    process.env.COLUMNS = '80'
    try {
      expect(await waitFor(() => (info(pid)?.command || '').includes(longEndpoint))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.COLUMNS
      else process.env.COLUMNS = previous
    }
  })

  it('reports a pid that does not exist as absent', async () => {
    expect(posixProcessInfo((await deadIdentity()).pid)).toBe('absent')
  })

  it('stops an orphaned bridge and leaves an unrelated process with the same script alone', async () => {
    const dir = join(base, 'records')
    expect(ensurePrivateRecordDir(dir)).toBe(true)
    const endpoint = `ipc://${join(base, 'bridge.sock')}`
    const script = join(base, 'hermes_bridge.py')
    const orphanPid = startOrphan(['-e', keepAlive, script, '--endpoint', endpoint])
    const unrelatedPid = startOrphan(['-e', keepAlive, script])
    expect(await waitFor(() => (info(orphanPid)?.command || '').includes(endpoint))).toBe(true)

    const path = bridgeOwnerRecordPath(endpoint, dir)
    const orphan = { pid: orphanPid, start: info(orphanPid)!.start }
    writeBridgeOwnerRecord(path, {
      version: 2,
      endpoint,
      script,
      bridge: orphan,
      server: await deadIdentity(),
      createdAt: new Date().toISOString(),
    })

    const result = reapOrphanedOwnedBridge(path, endpoint, currentProcessIdentity()!, {
      processInfo: posixProcessInfo,
      killProcessTree: root => process.kill(root.pid, 'SIGKILL'),
    })

    expect(result).toMatchObject({ reaped: true, bridgePid: orphanPid })
    expect(await waitFor(() => !sameProcessRuns(orphan, { processInfo: posixProcessInfo }))).toBe(true)
    expect(info(unrelatedPid)).not.toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('agent bridge manager orphan handling', () => {
  afterEach(() => {
    vi.doUnmock('child_process')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('stops an orphaned bridge from a dead server before it spawns a replacement', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bridge-owner-manager-'))
    const endpoint = `tcp://127.0.0.1:${40000 + (process.pid % 20000)}`
    const recordPath = bridgeOwnerRecordPath(endpoint)
    const orphanScript = join(base, 'hermes_bridge.py')
    // The stand-in bridge starts one "worker" child, like a real broker.
    const workerMarker = `bridge-worker-${process.pid}-${Date.now()}`
    const launcherCode = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '${workerMarker}'], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
    const orphanPid = Number(execFileSync('sh', ['-c',
      `"${process.execPath}" -e "${launcherCode}" "${orphanScript}" --endpoint "${endpoint}" >/dev/null 2>&1 & echo $!`,
    ], { encoding: 'utf-8' }).trim())
    // Call pgrep directly: through `sh -c` the shell's own command line would match too.
    const workerPids = () => {
      try {
        return execFileSync('pgrep', ['-f', workerMarker], { encoding: 'utf-8' })
          .trim().split(/\s+/).filter(Boolean).map(Number).filter(pid => pid !== orphanPid)
      } catch {
        return [] // pgrep exits 1 when nothing matches
      }
    }
    const replacement = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      const deadServer = await deadServerIdentity()
      for (let i = 0; i < 100 && !(info(orphanPid)?.command || '').includes(endpoint); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      for (let i = 0; i < 100 && workerPids().length === 0; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const workers = workerPids()
      expect(workers).toHaveLength(1)
      const orphan = { pid: orphanPid, start: info(orphanPid)!.start }
      expect(ensurePrivateRecordDir(bridgeOwnerRecordDir())).toBe(true)
      writeBridgeOwnerRecord(recordPath, {
        version: 2,
        endpoint,
        script: orphanScript,
        bridge: orphan,
        server: deadServer,
        createdAt: new Date().toISOString(),
      })

      const { EventEmitter } = await import('events')
      // A real, live process stands in for the spawned bridge, so the new record gets a start time.
      const child = Object.assign(new EventEmitter(), { pid: replacement.pid, killed: false, kill: vi.fn(() => true), unref: vi.fn() })
      let orphanRunsAtSpawn: boolean | undefined
      const spawnMock = vi.fn(() => {
        orphanRunsAtSpawn = sameProcessRuns(orphan, { processInfo: posixProcessInfo })
        return child
      })
      vi.doMock('child_process', async () => {
        const actual = await vi.importActual<typeof import('child_process')>('child_process')
        return { ...actual, spawn: spawnMock }
      })
      const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
      vi.spyOn(AgentBridgeClient.prototype, 'ping').mockRejectedValue(new Error('bridge offline'))
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 200 })

      await expect(manager.start()).rejects.toThrow()
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(orphanRunsAtSpawn).toBe(false)
      for (let i = 0; i < 100 && workerPids().some(pid => info(pid) && !info(pid)!.zombie); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(workers.every(pid => !info(pid) || info(pid)!.zombie)).toBe(true)
      expect(readBridgeOwnerRecord(recordPath)).toMatchObject({
        endpoint,
        bridge: { pid: replacement.pid },
        server: { pid: process.pid },
      })

      child.emit('exit', 0, 'SIGTERM')
      expect(existsSync(recordPath)).toBe(false)
      manager.forceStop()
    } finally {
      replacement.kill('SIGKILL')
      for (const pid of [orphanPid, ...workerPids()]) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
      removeBridgeOwnerRecord(recordPath)
      rmSync(base, { recursive: true, force: true })
    }
  })
})
