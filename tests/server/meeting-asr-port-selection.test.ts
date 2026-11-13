import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { checkPortAvailable, pickFreePort } from '../../packages/server/src/modules/studio/services/meeting-asr/index'

/**
 * Orphaned-backend port recovery.
 *
 * `spawn(..., { detached: false })` children are not killed when the Node
 * parent exits, so after a restart an old uvicorn can still hold 8000/8001.
 * The new child then fails to bind while `waitForReady` probes the port and
 * gets healthy answers from the ORPHAN — which still runs the previous code.
 * Picking a free port breaks that trap; these tests pin the behaviour.
 */

const servers: Server[] = []

async function occupy(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '0.0.0.0', resolve))
  servers.push(srv)
  return (srv.address() as AddressInfo).port
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

describe('ASR backend port selection', () => {
  it('reports an occupied port as unavailable and a free one as available', async () => {
    const taken = await occupy()
    expect(await checkPortAvailable(taken)).toBe(false)

    const free = await pickFreePort(taken + 1)
    expect(await checkPortAvailable(free)).toBe(true)
    expect(free).toBeGreaterThan(taken)
  })

  it('returns the requested port when it is free', async () => {
    const base = await occupy()
    const reserved = servers.pop()!
    await new Promise<void>(resolve => reserved.close(() => resolve()))
    const chosen = await pickFreePort(base)
    expect(chosen).toBe(base)
  })

  it('skips an occupied port instead of handing it to the child', async () => {
    const taken = await occupy()
    const chosen = await pickFreePort(taken)
    expect(chosen).not.toBe(taken)
    expect(chosen).toBeGreaterThan(taken)
  })

  it('honours the avoid set so ASR and diarize never share a port', async () => {
    const taken = await occupy()
    const asr = await pickFreePort(taken)
    const diarize = await pickFreePort(taken, new Set([asr]))
    expect(diarize).not.toBe(asr)
    expect(diarize).not.toBe(taken)
  })

  it('throws a clear error when the whole window is taken', async () => {
    const taken = await occupy()
    await expect(pickFreePort(taken, new Set(), 1)).rejects.toThrow(/no free TCP port/)
  })
})
