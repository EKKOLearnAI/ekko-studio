import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForChatRun } from '../../packages/server/src/modules/studio/services/chat-run/wait'

function harness(includeEvents = true, timeoutMs = 50) {
  let emit: (event: string, payload?: any) => void = () => {}
  let revoke = () => {}
  const dispose = vi.fn(), dropQueued = vi.fn(), unwatch = vi.fn()
  const promise = waitForChatRun({ sessionId: 'session', timeoutMs, includeEvents,
    start: onEvent => { emit = onEvent; return { dispose, dropQueued } },
    watch: invalidate => { revoke = invalidate; return unwatch },
  })
  return { promise, emit, revoke, dispose, dropQueued, unwatch }
}
afterEach(() => vi.useRealTimers())

describe('direct chat response lifecycle', () => {
  it('collects deltas once, allows final output overrides, and releases observers', async () => {
    const h = harness()
    h.emit('run.started', { run_id: 'run' })
    h.emit('message.delta', { delta: 'partial' })
    h.emit('thinking.delta', { delta: 'think ' })
    h.emit('reasoning.delta', { delta: 'more' })
    h.emit('run.completed', { output: 'final', reasoning: 'final thought' })
    h.emit('message.delta', { delta: 'late event' })
    h.revoke() // A delayed watcher callback cannot mutate an already settled response.
    const result = await h.promise
    expect(result).toMatchObject({ status: 200, body: { ok: true, status: 'completed', session_id: 'session', run_id: 'run', output: 'final', reasoning: 'final thought' } })
    expect(result.body.events).toHaveLength(5)
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.unwatch).toHaveBeenCalledOnce()
    expect(h.dropQueued).not.toHaveBeenCalled()
  })

  it.each(['approval.requested', 'clarify.requested'])('returns the existing 409 action for %s', async event => {
    const h = harness(false)
    h.emit(event, { id: 'action' })
    expect(await h.promise).toEqual({ status: 409, body: { ok: false, status: 'requires_action', event, action: { id: 'action', event }, session_id: 'session', run_id: undefined, output: '' } })
    expect(h.dispose).toHaveBeenCalledOnce()
  })

  it('preserves partial text on failure and filters unknown events', async () => {
    const h = harness()
    h.emit('message.delta', { delta: 'partial' })
    h.emit('internal.credential', { secret: 'never record' })
    h.emit('run.failed', { error: 'runtime failed' })
    expect(await h.promise).toMatchObject({ status: 500, body: { error: 'runtime failed', output: 'partial', events: [{ delta: 'partial', event: 'message.delta' }, { error: 'runtime failed', event: 'run.failed' }] } })
  })

  it('bounds recorded events without truncating the assembled output', async () => {
    const h = harness()
    for (let i = 0; i < 1100; i++) h.emit('message.delta', { delta: 'x', index: i })
    h.emit('run.completed')
    const { body } = await h.promise
    expect(body.output).toHaveLength(1100)
    expect(body.events).toHaveLength(1000)
    expect((body.events as any[])[0].index).toBe(101)
  })

  it('detaches at timeout without cancelling accepted or queued work', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.emit('message.delta', { delta: 'partial' })
    await vi.advanceTimersByTimeAsync(50)
    expect(await h.promise).toMatchObject({ status: 504, body: { status: 'timeout', output: 'partial' } })
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.dropQueued).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('revokes queued work, stops delivery, and withholds accumulated private content', async () => {
    const h = harness()
    h.emit('message.delta', { delta: 'private' })
    h.revoke()
    expect(h.dropQueued).not.toHaveBeenCalled()
    h.emit('run.completed', { output: 'late private' })
    expect(await h.promise).toMatchObject({ status: 403, body: { error: 'share_access_denied', output: '', events: [] } })
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.dropQueued).toHaveBeenCalledOnce()
  })

  it('handles synchronous invalidation before admission and releases the returned watcher', async () => {
    const start = vi.fn(), unwatch = vi.fn()
    const result = await waitForChatRun({ sessionId: 'session', timeoutMs: 50, includeEvents: false, start,
      watch: invalidate => { invalidate(); return unwatch },
    })
    expect(result.status).toBe(403)
    expect(start).not.toHaveBeenCalled()
    expect(unwatch).toHaveBeenCalledOnce()
  })

  it('cleans up a throwing start port', async () => {
    const result = await waitForChatRun({ sessionId: 'session', timeoutMs: 50, includeEvents: false,
      start: () => { throw new Error('unavailable') },
    })
    expect(result).toMatchObject({ status: 503, body: { status: 'connect_error', error: 'unavailable' } })
  })
})
