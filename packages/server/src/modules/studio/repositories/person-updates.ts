const listeners = new Set<(userId: number) => void>()
const queued = new Set<number>()
/** Notify after the synchronous transaction has committed; readers reload authoritative state. */
export function personUpdated(userId: number) {
  if (queued.has(userId)) return
  queued.add(userId)
  queueMicrotask(() => {
    queued.delete(userId)
    for (const listener of listeners) listener(userId)
  })
}
export function onPersonUpdated(listener: (userId: number) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
