import type { Disposer, ExecutionScope } from '../../contracts/plugins'

type RemovalHook = (input: { scope?: ExecutionScope; profileId: string; sessionId: string; signal: AbortSignal }) => Promise<void>
let hook: RemovalHook | undefined

/** Optional host policy; absence keeps core deletion independent of plugin workers. */
export function configureSessionRemovalHook(value: RemovalHook): Disposer {
  hook = value
  return () => { if (hook === value) hook = undefined }
}
export async function beforeSessionRemoval(input: Parameters<RemovalHook>[0]): Promise<void> { await hook?.(input) }
