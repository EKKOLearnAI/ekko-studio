// Dependency-free: API credentials and authenticated runtimes must not import each other.
const listeners = new Set<() => void>()

export function onAuthInvalidated(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function invalidateAuth(): void {
  for (const listener of [...listeners]) listener()
}
