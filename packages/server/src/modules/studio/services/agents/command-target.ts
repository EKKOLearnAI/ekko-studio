import type { AgentRuntimeContext } from '../../contracts/plugins'

export interface RuntimeCommandTarget {
  ownerId: string; sessionId: string; instanceId: string; instanceRevision: number
}
interface Binding { target: RuntimeCommandTarget; authorize(): void }
const targets = new WeakMap<AgentRuntimeContext, Binding>()

/** Host-only authority: factories receive the same context, never a serializable binding. */
export function bindRuntimeCommandTarget(context: AgentRuntimeContext, target: RuntimeCommandTarget, authorize: () => void): AgentRuntimeContext {
  targets.set(context, { target: { ...target }, authorize })
  return context
}
export function runtimeCommandTarget(context: AgentRuntimeContext): Binding | undefined { return targets.get(context) }
