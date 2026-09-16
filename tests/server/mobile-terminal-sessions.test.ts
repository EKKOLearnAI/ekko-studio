import { describe, expect, it, vi } from 'vitest'
import { MOBILE_TERMINAL_LIMITS, MobileTerminalSessions, type TerminalProcess, type TerminalScope } from '../../packages/server/src/modules/hermes/services/terminal/mobile-sessions'

const scope: TerminalScope = { owner: 'user:credential', userId: 1, profile: 'default', source: 'single', sourceId: 'chat-1' }
function fixture() {
  let now = 1000
  const processes: Array<TerminalProcess & { output: (data: string) => void; exit: (code: number) => void }> = []
  const spawn = vi.fn(() => {
    let onData = (_: string) => {}; let onExit = (_: { exitCode: number }) => {}
    const process = {
      pid: processes.length + 1, write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: (cb: typeof onData) => { onData = cb }, onExit: (cb: typeof onExit) => { onExit = cb },
      output: (data: string) => onData(data), exit: (code: number) => onExit({ exitCode: code }),
    }
    processes.push(process); return process
  })
  const service = new MobileTerminalSessions(spawn, () => now)
  const create = (requestId = 'request-0001', owner = scope) => service.create(owner, requestId, '/workspace', '/bin/sh', 80, 24)
  return { service, spawn, processes, create, advance: (ms: number) => { now += ms } }
}

describe('mobile terminal lifetime and protocol', () => {
  it('rejects missing idempotency keys before spawning a process', () => {
    const f = fixture()
    expect(() => f.service.create(scope, undefined as any, '/workspace', '/bin/sh', 80, 24)).toThrow('terminal_invalid_request')
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('deduplicates creation retries and isolates scope', () => {
    const f = fixture(); const first = f.create()
    expect(f.create().id).toBe(first.id); expect(f.spawn).toHaveBeenCalledTimes(1)
    for (const other of [{ ...scope, owner: 'other' }, { ...scope, sourceId: 'other' }, { ...scope, profile: 'other' }]) {
      expect(f.service.list(other)).toEqual([])
      expect(() => f.service.attach(other, first.id, 'writer')).toThrow('terminal_not_found')
      expect(() => f.service.close(other, first.id)).toThrow('terminal_not_found')
    }
  })
  it('survives disconnect and resumes output without re-executing input', () => {
    const f = fixture(); const { id } = f.create(); const a = f.service.attach(scope, id, 'a')
    f.service.input(scope, id, 'a', a.lease, 1, 'pwd\r')
    f.processes[0].output('first'); f.service.detachWriter('a'); f.advance(1000)
    f.processes[0].output('second')
    const b = f.service.attach(scope, id, 'b')
    expect(f.service.read(scope, id, 'b', b.lease, 1).chunks).toEqual([{ seq: 2, data: 'second' }])
    expect(f.processes[0].write).toHaveBeenCalledTimes(1)
    expect(f.processes[0].kill).not.toHaveBeenCalled()
  })
  it('rejects stale writers, repeated input, sequence gaps and invalid sizes', () => {
    const f = fixture(); const { id } = f.create(); const a = f.service.attach(scope, id, 'a')
    const b = f.service.attach(scope, id, 'b')
    expect(() => f.service.input(scope, id, 'a', a.lease, 1, 'x')).toThrow('terminal_taken_over')
    f.service.input(scope, id, 'b', b.lease, 1, 'x')
    expect(() => f.service.input(scope, id, 'b', b.lease, 1, 'x')).toThrow('terminal_input_sequence')
    expect(() => f.service.input(scope, id, 'b', b.lease, 3, 'x')).toThrow('terminal_input_sequence')
    expect(() => f.service.resize(scope, id, 'b', b.lease, Infinity, 24)).toThrow('terminal_invalid_size')
    expect(() => f.service.input(scope, id, 'b', b.lease, 2, 'x'.repeat(17000))).toThrow('terminal_input_too_large')
  })
  it('bounds Unicode output and reports truncation with contiguous replay', () => {
    const f = fixture(); const { id } = f.create(); const a = f.service.attach(scope, id, 'a')
    f.processes[0].output('中🙂'.repeat(400000))
    let result = f.service.read(scope, id, 'a', a.lease, 0)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.chunks.map(c => c.data).join(''))).toBeLessThanOrEqual(MOBILE_TERMINAL_LIMITS.readBytes)
    const cursor = result.cursor
    result = f.service.read(scope, id, 'a', a.lease, cursor)
    expect(result.truncated).toBe(false); expect(result.chunks[0].seq).toBe(cursor + 1)
    expect(result.chunks.map(c => c.data).join('')).not.toContain('\uFFFD')
  })
  it('expires detached sessions, enforces user quota across credentials, and cleans processes', () => {
    const f = fixture()
    for (let i = 0; i < 4; i++) f.create(`request-000${i}`, { ...scope, owner: `credential-${i}` })
    expect(() => f.create('request-new')).toThrow('terminal_limit')
    f.advance(MOBILE_TERMINAL_LIMITS.retentionMs); f.service.sweep()
    expect(f.processes.every(p => vi.mocked(p.kill).mock.calls.length === 1)).toBe(true)
    const { id } = f.create(); f.service.attach(scope, id, 'a')
    f.advance(MOBILE_TERMINAL_LIMITS.retentionMs * 2); f.service.sweep()
    expect(f.service.list(scope)).toHaveLength(1)
    f.service.shutdown(); expect(f.service.list(scope)).toHaveLength(0)
  })
  it('preserves exit output and makes explicit close idempotent', () => {
    const f = fixture(); const { id } = f.create(); const a = f.service.attach(scope, id, 'a')
    f.processes[0].output('bye'); f.processes[0].exit(0)
    expect(f.service.read(scope, id, 'a', a.lease, 0)).toMatchObject({ exitCode: 0, chunks: [{ data: 'bye', seq: 1 }] })
    f.service.close(scope, id); f.service.close(scope, id)
    expect(f.processes[0].kill).not.toHaveBeenCalled()
  })
})
