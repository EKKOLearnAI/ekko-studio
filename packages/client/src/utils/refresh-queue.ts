/** Publish each completed read before one coalesced follow-up; query changes cancel stale reads. */
export function createRefreshQueue<T>(options: {
  load: (key: string, signal: AbortSignal) => Promise<T>
  apply: (value: T, key: string) => void
  failed: (error: unknown) => void
  timeoutMs?: number
}) {
  type Request = { key: string; controller: AbortController; again: boolean; promise: Promise<boolean> }
  let current: Request | undefined
  let disposed = false

  function cancel() {
    const previous = current
    current = undefined
    previous?.controller.abort()
  }

  function refresh(key: string): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    if (current?.key === key) {
      current.again = true
      return current.promise
    }
    cancel()
    const controller = new AbortController()
    const request: Request = { key, controller, again: false, promise: Promise.resolve(false) }
    current = request
    request.promise = (async () => {
      let onAbort!: () => void
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      const timer = setTimeout(() => controller.abort(new DOMException('Read timed out', 'TimeoutError')), options.timeoutMs ?? 15_000)
      try {
        // Race also bounds authentication/bootstrap waits before fetch observes its signal.
        const value = await Promise.race([Promise.resolve().then(() => options.load(key, controller.signal)), aborted])
        if (current !== request || controller.signal.aborted) return false
        options.apply(value, key)
        return true
      } catch (error) {
        if (current === request) options.failed(error)
        return false
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        if (current === request) {
          current = undefined
          if (request.again && !disposed) void refresh(key)
        }
      }
    })()
    return request.promise
  }

  return { refresh, cancel, dispose: () => { disposed = true; cancel() } }
}
