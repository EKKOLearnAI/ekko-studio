import { afterEach, expect, it, vi } from 'vitest'
import { NativeRpcConnection, type ManagedProcessPort } from '../../packages/studio-agent-drivers/src'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers() })
async function connection(callbacks: ConstructorParameters<typeof NativeRpcConnection>[1] = { notification() {} }) {
  let release!: (batch: Awaited<ReturnType<ManagedProcessPort['read']>>) => void
  const sent: any[] = []
  const port: ManagedProcessPort = {
    read: vi.fn(() => new Promise(resolve => { release = resolve })),
    write: vi.fn(async bytes => { sent.push(JSON.parse(Buffer.from(bytes).toString())) }),
    end: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
  }
  const rpc = new NativeRpcConnection(port, callbacks)
  await rpc.start()
  cleanups.push(() => rpc.close())
  const receive = async (value: unknown) => {
    release({ chunks: [{ stream: 'stdout', data: Buffer.from(JSON.stringify(value) + '\n') }], truncated: false, exit: null })
    await new Promise(resolve => setImmediate(resolve))
  }
  return { rpc, port, sent, receive }
}

it('keeps independent request directions and waits for a server request response', async () => {
  let answer!: (value: unknown) => void
  const request = vi.fn(() => new Promise(resolve => { answer = resolve }))
  const f = await connection({ notification() {}, request })
  const outgoing = f.rpc.request('client-request', {})
  await f.receive({ id: 1, method: 'server-request', params: {} })
  expect(request).toHaveBeenCalledOnce()
  await f.receive({ id: 1, result: { ok: true } })
  await expect(outgoing).resolves.toEqual({ ok: true })
  expect(f.sent.filter(frame => Object.hasOwn(frame, 'result'))).toHaveLength(0)
  answer({ decision: 'decline' })
  await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ id: 1, result: { decision: 'decline' } }))
})

it('aborts pending server requests and suppresses late replies after close', async () => {
  let signal!: AbortSignal, answer!: (value: unknown) => void
  const f = await connection({ notification() {}, request: (_method, _params, abort) => {
    signal = abort
    return new Promise(resolve => { answer = resolve })
  } })
  await f.receive({ id: 'server', method: 'approval', params: {} })
  const request = f.rpc.request('pending', {})
  const rejected = expect(request).rejects.toThrow('disposed')
  const barrier = f.rpc.close()
  expect(f.rpc.close()).toBe(barrier)
  await barrier; await rejected
  expect(signal.aborted).toBe(true)
  answer({ decision: 'accept' })
  await new Promise(resolve => setImmediate(resolve))
  expect(f.sent.some(frame => frame.id === 'server')).toBe(false)
  expect(f.port.dispose).toHaveBeenCalledOnce()
})

it('withdraws only the incoming request and safely accepts a reused native ID', async () => {
  const calls: Array<{ signal: AbortSignal; answer(value: unknown): void }> = []
  const f = await connection({ notification() {}, request: (_method, _params, signal) => new Promise(answer => { calls.push({ signal, answer }) }) })
  const outgoing = f.rpc.request('client', {})
  await f.receive({ id: 1, method: 'question', params: {} })
  f.rpc.withdrawRequest(1)
  expect(calls[0].signal.reason).toBe('native-resolved')
  await f.receive({ id: 1, method: 'question', params: {} })
  calls[0].answer({ stale: true })
  await new Promise(resolve => setImmediate(resolve))
  // The old callback must not remove the new request's cancellation handle.
  f.rpc.withdrawRequest(1)
  expect(calls[1].signal.aborted).toBe(true)
  calls[1].answer({ stale: true })
  await f.receive({ id: 1, result: { client: true } })
  await expect(outgoing).resolves.toEqual({ client: true })
  expect(f.sent).toHaveLength(1)
})

it.each([[], { id: 1 }, { id: 1, result: {}, error: { code: 1, message: 'bad' } }, { method: 'notice', params: [] }])('fails pending calls on malformed native frames: %j', async frame => {
  const f = await connection(), pending = f.rpc.request('waiting', {})
  const rejected = expect(pending).rejects.toThrow('Invalid JSON protocol message')
  await f.receive(frame)
  await rejected
  await f.rpc.close()
  expect(f.port.dispose).toHaveBeenCalledOnce()
})

it('bounds concurrent requests and rejects timed-out calls without replay', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = await connection()
  const pending = Array.from({ length: 128 }, () => f.rpc.request('pending', {}, 100))
  const results = Promise.allSettled(pending)
  await expect(f.rpc.request('excess', {})).rejects.toThrow('limit exceeded')
  await vi.advanceTimersByTimeAsync(100)
  expect((await results).every(result => result.status === 'rejected')).toBe(true)
  expect(f.sent).toHaveLength(128)
})
