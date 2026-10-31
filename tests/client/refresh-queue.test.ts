import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRefreshQueue } from '../../packages/client/src/utils/refresh-queue'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())

describe('coalesced refresh reads', () => {
  it('publishes the first response during a burst and runs just one follow-up', async () => {
    const first = deferred<number>(), next = deferred<number>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
    const apply = vi.fn(), failed = vi.fn()
    const queue = createRefreshQueue({ load, apply, failed })
    const initial = queue.refresh('same')
    for (let i = 0; i < 20; i++) expect(queue.refresh('same')).toBe(initial)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    first.resolve(1)
    expect(await initial).toBe(true)
    expect(apply).toHaveBeenCalledWith(1, 'same')
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    next.resolve(2)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(2, 'same'))
    expect(failed).not.toHaveBeenCalled()
    queue.dispose()
  })

  it('aborts obsolete queries and never publishes their late response or error', async () => {
    const old = deferred<number>(), fresh = deferred<number>()
    const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const apply = vi.fn(), failed = vi.fn()
    const queue = createRefreshQueue({ load, apply, failed })
    const previous = queue.refresh('old'); await Promise.resolve()
    const current = queue.refresh('new'); await Promise.resolve()
    expect(load.mock.calls[0][1].aborted).toBe(true)
    old.reject(new Error('late failure')); fresh.resolve(2)
    expect(await previous).toBe(false); expect(await current).toBe(true)
    expect(apply).toHaveBeenCalledExactlyOnceWith(2, 'new')
    expect(failed).not.toHaveBeenCalled()
    queue.dispose()
  })

  it('bounds a hung read even if the loader ignores abort, and permits retry', async () => {
    vi.useFakeTimers()
    const hung = deferred<number>(), load = vi.fn().mockReturnValueOnce(hung.promise).mockResolvedValueOnce(2)
    const apply = vi.fn(), failed = vi.fn()
    const queue = createRefreshQueue({ load, apply, failed })
    const result = queue.refresh('same')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toBe(false)
    expect(failed.mock.calls[0][0].name).toBe('TimeoutError')
    expect(load.mock.calls[0][1].aborted).toBe(true)
    expect(await queue.refresh('same')).toBe(true)
    hung.resolve(99); await Promise.resolve()
    expect(apply).toHaveBeenCalledExactlyOnceWith(2, 'same')
    queue.dispose()
  })

  it('cancels the queued follow-up on close without reporting an error', async () => {
    const pending = deferred<number>(), apply = vi.fn(), failed = vi.fn()
    const queue = createRefreshQueue({ load: () => pending.promise, apply, failed })
    const result = queue.refresh('same'); queue.refresh('same')
    queue.dispose(); pending.resolve(1)
    expect(await result).toBe(false)
    expect(await queue.refresh('same')).toBe(false)
    expect(apply).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled()
  })

  it('recovers after an initial failure without poisoning the next read', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(1)
    const apply = vi.fn(), failed = vi.fn()
    const queue = createRefreshQueue({ load, apply, failed })
    expect(await queue.refresh('same')).toBe(false)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(await queue.refresh('same')).toBe(true)
    expect(apply).toHaveBeenCalledExactlyOnceWith(1, 'same')
    queue.dispose()
  })
})
