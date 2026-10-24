import { randomUUID } from 'node:crypto'
import { StudioError, type AgentInspection, type AgentManagementInput, type AgentProviderRef, type AgentManagementAdapter, type ExecutionScope, type ScopedLogger } from '../../contracts/plugins'
import { ManagedProcessScope } from '../processes/managed'
import { ManagedMcpScope } from '../mcp/managed'
import { parseAgentInspection } from '../plugins/validation'

/** Inspection never creates a Run, checkpoint or persistent runtime lease. */
export class AgentManagement {
  private readonly active = new Map<AbortController, Promise<void>>()
  private readonly unconfirmed = new Set<string>()
  isBlocked(instanceId: string): boolean { return this.unconfirmed.has(instanceId) }

  async inspect(input: AgentManagementInput, scope: ExecutionScope, provider: AgentProviderRef, adapter: AgentManagementAdapter,
    authorize: () => void, logger: ScopedLogger, signal?: AbortSignal): Promise<AgentInspection> {
    if (this.active.size >= 16) throw new StudioError('RESOURCE_EXHAUSTED', 'Agent inspection limit reached')
    if (signal?.aborted) throw new StudioError('CANCELLED', 'Inspection cancelled')
    authorize()
    const controller = new AbortController()
    let finish!: () => void
    this.active.set(controller, new Promise(resolve => { finish = resolve }))
    let rejectAbort!: (error: unknown) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    void aborted.catch(() => {})
    const abort = () => rejectAbort(controller.signal.reason)
    controller.signal.addEventListener('abort', abort, { once: true })
    const cancel = () => controller.abort(new StudioError('CANCELLED', 'Inspection cancelled'))
    signal?.addEventListener('abort', cancel, { once: true })
    const check = () => { if (controller.signal.aborted) throw controller.signal.reason; authorize() }
    const processes = new ManagedProcessScope(controller.signal, check), mcp = new ManagedMcpScope(controller.signal, check)
    const timeout = setTimeout(() => controller.abort(new StudioError('DEADLINE_EXCEEDED', 'Agent inspection timed out')), 25_000)
    const watch = setInterval(() => { try { check() } catch (error) { controller.abort(error) } }, 250)
    let task: Promise<AgentInspection> | undefined, settled = false
    try {
      if (signal?.aborted) cancel()
      check()
      task = Promise.resolve().then(() => {
        check()
        return adapter.inspect(input, { provider, runtimeSessionId: randomUUID(), profileId: scope.profileId, ownerId: scope.principal.id,
          signal: controller.signal, logger, processes: processes.api, mcp: mcp.api })
      }).finally(() => { settled = true })
      const result = await Promise.race([task, aborted])
      check()
      return parseAgentInspection(result)
    } catch (error) {
      throw error instanceof StudioError ? error : new StudioError('RUNTIME_UNAVAILABLE', 'Agent inspection failed')
    } finally {
      clearTimeout(timeout); clearInterval(watch)
      signal?.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', abort)
      controller.abort(new StudioError('CANCELLED', 'Inspection ended'))
      try {
        // A worker that ignores cancellation may need to exit. Keep the
        // instance occupied until that barrier, so a new Run cannot be killed
        // by the previous inspection's delayed worker cleanup.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined
        const drain = task && !settled ? Promise.race([task.catch(() => {}), new Promise(resolve => {
          cleanupTimer = setTimeout(resolve, 5_000)
        })]) : Promise.resolve()
        let results: PromiseSettledResult<unknown>[]
        try { results = await Promise.allSettled([processes.close(), mcp.close(), drain]) }
        finally { clearTimeout(cleanupTimer) }
        if (results.some(result => result.status === 'rejected') || (task && !settled)) {
          this.unconfirmed.add(input.instanceId)
          throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent inspection cleanup failed')
        }
      } finally { this.active.delete(controller); finish() }
    }
  }

  async close(): Promise<void> {
    const pending = [...this.active.values()]
    for (const controller of this.active.keys()) controller.abort(new StudioError('CANCELLED', 'Host shutdown'))
    await Promise.allSettled(pending)
  }
}
