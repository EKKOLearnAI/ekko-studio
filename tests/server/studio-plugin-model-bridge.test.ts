import { expect, it, vi } from 'vitest'
import { PluginModelBridge } from '../../packages/server/src/modules/studio/services/plugins/models'
import { StudioError, type ExecutionContext, type ModelStreamHandle, type ModelStreamEvent } from '../../packages/studio-plugin-sdk/src'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
function handle(next = vi.fn(async (): Promise<IteratorResult<ModelStreamEvent>> => ({ done: true, value: undefined }))): ModelStreamHandle {
  return { id: 'model', cancel: vi.fn(async () => {}), events: { [Symbol.asyncIterator]: () => ({ next }) } }
}
function context(stream: () => Promise<ModelStreamHandle>) { return { models: { stream } } as unknown as ExecutionContext }

it('binds gateway cleanup to the issuing scope and revokes access after a grant is removed', async () => {
  let allowed = true
  const dispose = vi.fn(async () => {}), gateway = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1', token: 'ephemeral', model: 'p/m', protocol: 'responses', dispose }))
  const bridge = new PluginModelBridge((_scope, capability) => {
    expect(capability).toBe('models.gateway')
    if (!allowed) throw new StudioError('FORBIDDEN', 'revoked')
    return { models: { gateway } } as unknown as ExecutionContext
  })
  const opened = await bridge.call('one', 'models.gateway', { model: 'p/m', protocol: 'responses' }) as { handle: string }
  await expect(bridge.call('two', 'models.gateway.close', { handle: opened.handle })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(dispose).not.toHaveBeenCalled()
  allowed = false
  await vi.waitFor(() => expect(dispose).toHaveBeenCalled())
  await bridge.closeScope('one'); await bridge.close()
})

it('waits for a late gateway lease and its cleanup before releasing a callback scope', async () => {
  const opening = deferred<any>(), cleanup = deferred<void>(), dispose = vi.fn(() => cleanup.promise)
  let live = true
  const bridge = new PluginModelBridge(() => {
    if (!live) throw new StudioError('FORBIDDEN', 'ended')
    return { models: { gateway: () => opening.promise } } as unknown as ExecutionContext
  })
  const pending = bridge.call('one', 'models.gateway', { model: 'p/m', protocol: 'responses' }); void pending.catch(() => {})
  live = false
  let released = false
  const closing = bridge.closeScope('one').then(() => { released = true })
  opening.resolve({ dispose })
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  expect(released).toBe(false)
  cleanup.resolve(); await closing
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await bridge.close()
})

it('keeps opaque handles in their issuing scope and cancels them on scope release', async () => {
  const stream = handle(), bridge = new PluginModelBridge(() => context(async () => stream))
  const opened = await bridge.call('one', 'models.open', {}) as { handle: string }
  await expect(bridge.call('two', 'models.next', { handle: opened.handle })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await bridge.closeScope('one')
  expect(stream.cancel).toHaveBeenCalledOnce()
  await expect(bridge.call('one', 'models.next', { handle: opened.handle })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await bridge.close()
})

it('withholds an in-flight result when grants are revoked during the read', async () => {
  const result = deferred<IteratorResult<ModelStreamEvent>>(), stream = handle(vi.fn(() => result.promise))
  let allowed = true
  const bridge = new PluginModelBridge(() => { if (!allowed) throw new StudioError('FORBIDDEN', 'revoked'); return context(async () => stream) })
  const opened = await bridge.call('one', 'models.open', {}) as { handle: string }
  const pending = bridge.call('one', 'models.next', { handle: opened.handle })
  allowed = false
  result.resolve({ done: false, value: { sequence: 1, type: 'text.delta', text: 'private' } })
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(stream.cancel).toHaveBeenCalledOnce()
  await bridge.close()
})

it('waits for a late model open and its cancellation before scope cleanup finishes', async () => {
  const opened = deferred<ModelStreamHandle>(), stopped = deferred<void>(), stream = handle()
  stream.cancel = vi.fn(() => stopped.promise)
  let live = true
  const bridge = new PluginModelBridge(() => { if (!live) throw new StudioError('FORBIDDEN', 'ended'); return context(() => opened.promise) })
  const opening = bridge.call('one', 'models.open', {}); void opening.catch(() => {})
  live = false
  let closed = false
  const closing = bridge.closeScope('one').then(() => { closed = true })
  opened.resolve(stream)
  await vi.waitFor(() => expect(stream.cancel).toHaveBeenCalledOnce())
  expect(closed).toBe(false)
  stopped.resolve(); await closing
  await expect(opening).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await bridge.close()
})

it('does not turn failed cancellation into successful cleanup on a later close', async () => {
  const stream = handle(); stream.cancel = vi.fn(async () => { throw new StudioError('DEADLINE_EXCEEDED', 'still active') })
  const bridge = new PluginModelBridge(() => context(async () => stream))
  await bridge.call('one', 'models.open', {})
  await expect(bridge.closeScope('one')).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  await expect(bridge.close()).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  expect(stream.cancel).toHaveBeenCalledOnce()
})

it('retains one pending iterator read across bounded RPC polls', async () => {
  vi.useFakeTimers()
  const result = deferred<IteratorResult<ModelStreamEvent>>(), next = vi.fn(() => result.promise), stream = handle(next)
  const bridge = new PluginModelBridge(() => context(async () => stream))
  try {
    const opened = await bridge.call('one', 'models.open', {}) as { handle: string }
    const first = bridge.call('one', 'models.next', { handle: opened.handle })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await first).toEqual({ pending: true })
    const second = bridge.call('one', 'models.next', { handle: opened.handle })
    await expect(bridge.call('one', 'models.next', { handle: opened.handle })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    result.resolve({ done: false, value: { sequence: 0, type: 'text.delta', text: 'once' } })
    expect(await second).toEqual({ done: false, event: { sequence: 0, type: 'text.delta', text: 'once' } })
    expect(next).toHaveBeenCalledOnce()
  } finally { await bridge.close(); vi.useRealTimers() }
})
