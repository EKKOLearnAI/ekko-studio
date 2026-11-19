const listeners = new Map<number, Set<() => void>>()

export function onUserAccessChanged(userId: number, refresh: () => void) {
  const callbacks = listeners.get(userId) ?? new Set<() => void>()
  listeners.set(userId, callbacks)
  callbacks.add(refresh)
  return () => {
    callbacks.delete(refresh)
    if (!callbacks.size) listeners.delete(userId)
  }
}

export function userAccessChanged(userId: number) {
  queueMicrotask(() => { for (const refresh of listeners.get(userId) || []) refresh() })
}
