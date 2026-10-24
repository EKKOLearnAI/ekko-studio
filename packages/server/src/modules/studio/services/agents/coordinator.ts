import {
  StudioError, type AgentRunHandle, type AgentRunInput, type AgentRunContext, type AgentRuntime,
  type ExecutionScope, type ExecutionContext, type JsonObject, type JsonValue, type ScopedLogger,
  type AgentProviderRef, type AgentInteractionResponse, type AgentInteraction, type AgentInteractionReceipt,
} from '../../contracts/plugins'
import { AgentExecutionStore, type AgentInstance, type AgentInstanceConfiguration, type AgentExecution, type AgentAdmission } from '../../repositories/agent-execution-store'
import { AgentRegistry } from './registry'
import { PluginEventBus } from '../events/plugin-events'
import { compileSchema, jsonCopy, parseAgentOutput } from '../plugins/validation'
import { ManagedMcpScope } from '../mcp/managed'
import { ManagedProcessScope } from '../processes/managed'
import { agentStateDirectory } from './state-directory'
import { AgentManagement } from './management'

interface ActiveRun {
  controller: AbortController; handle?: AgentRunHandle; completed: Promise<void>; resolve(): void
  started: boolean; expired: boolean; timer: ReturnType<typeof setTimeout>; launch(): void
  responses: Map<string, Promise<AgentInteraction>>
}
interface RuntimeLease {
  id: string; provider: AgentProviderRef; revision: number; controller: AbortController
  runtime: Promise<AgentRuntime>; creating: boolean; idleTimer?: ReturnType<typeof setTimeout>; disposing?: Promise<void>
  processes: ManagedProcessScope
  mcp: ManagedMcpScope
  settling?: Promise<void>
}
interface InstanceQueue { current?: string; pending: string[] }

export function parseInteractionResponse(value: unknown): AgentInteractionResponse {
  const input = jsonCopy(value) as AgentInteractionResponse
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['interactionId', 'idempotencyKey', 'choiceId', 'text'].includes(key))
    || typeof input.interactionId !== 'string' || !input.interactionId.trim() || input.interactionId.length > 256
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
    || (input.choiceId !== undefined && (typeof input.choiceId !== 'string' || !input.choiceId || input.choiceId.length > 256))
    || (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 16384))) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid interaction response')
  }
  return input
}

export class AgentCoordinator {
  private readonly active = new Map<string, ActiveRun>()
  private readonly queues = new Map<string, InstanceQueue>()
  private readonly leases = new Map<string, RuntimeLease>()
  private readonly configuring = new Set<string>()
  private readonly management = new AgentManagement()
  private closed = false
  constructor(private readonly options: {
    store: AgentExecutionStore; registry: AgentRegistry; events: PluginEventBus; logger: ScopedLogger
    authorize(scope: ExecutionScope): void
    context(scope: ExecutionScope, signal: AbortSignal): ExecutionContext
    stateRoot?: string
    settleRun?(runId: string): Promise<void>
    validateInput?(scope: ExecutionScope, input: AgentRunInput): void
  }) {}

  createInstance(scope: ExecutionScope, input: { agentTypeId: string; config: JsonObject; mode: 'scoped' | 'global' }): AgentInstance {
    this.options.authorize(scope)
    const { definition } = this.options.registry.resolve(scope.profileId, input.agentTypeId)
    compileSchema(definition.configSchema)(input.config)
    if (!definition.capabilities.modes.includes(input.mode)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Agent mode')
    return this.options.store.createInstance({ ...jsonCopy(input), profileId: scope.profileId, ownerId: scope.principal.id })
  }

  listInstances(scope: ExecutionScope): AgentInstance[] {
    this.options.authorize(scope)
    return this.options.store.instances(scope.principal.id, scope.profileId)
  }

  async inspectInstance(scope: ExecutionScope, instanceId: string, signal?: AbortSignal) {
    scope = jsonCopy(scope)
    const inspect = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
      this.options.authorize(scope)
      if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent management requires an unbound scope')
      const instance = this.options.store.instance(instanceId)
      if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
      if (this.queues.has(instanceId) || this.options.store.hasActiveRuns(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance has active runs')
      return { instance, ...this.options.registry.resolve(scope.profileId, instance.agentTypeId) }
    }
    const original = inspect(), { instance, provider, definition } = original
    if (!definition.management) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not support native inspection')
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    this.configuring.add(instanceId)
    const authorize = () => {
      const current = inspect()
      if (current.instance.revision !== instance.revision || JSON.stringify(current.provider) !== JSON.stringify(provider)) throw new StudioError('REVISION_CONFLICT', 'Agent changed during inspection')
    }
    try {
      const result = await this.management.inspect({ instanceId, config: instance.config, configRevision: instance.revision, mode: instance.mode },
        scope, provider, definition.management, authorize, this.options.logger, signal)
      authorize()
      return { instanceId, configRevision: instance.revision, provider, ...result }
    } finally { if (!this.management.isBlocked(instanceId)) this.configuring.delete(instanceId) }
  }

  async updateInstance(scope: ExecutionScope, instanceId: string, value: AgentInstanceConfiguration): Promise<AgentInstance> {
    scope = jsonCopy(scope)
    const input = jsonCopy(value)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['revision', 'config', 'mode'].includes(key))
      || !Number.isSafeInteger(input.revision) || input.revision < 1 || !input.config || typeof input.config !== 'object' || Array.isArray(input.config)
      || !['scoped', 'global'].includes(input.mode)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent configuration')
    const inspect = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
      this.options.authorize(scope)
      if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Instance configuration requires an unbound scope')
      const instance = this.options.store.instance(instanceId)
      if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
      if (instance.revision !== input.revision || this.queues.has(instanceId) || this.options.store.hasActiveRuns(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance changed or has active runs')
      const resolved = this.options.registry.resolve(scope.profileId, instance.agentTypeId)
      compileSchema(resolved.definition.configSchema)(input.config)
      if (!resolved.definition.capabilities.modes.includes(input.mode)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Agent mode')
      return { instance, provider: JSON.stringify(resolved.provider) }
    }
    const previous = inspect()
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    this.configuring.add(instanceId)
    try {
      await this.disposeLease(instanceId, 'Instance configuration changed')
      const current = inspect()
      if (current.provider !== previous.provider) throw new StudioError('REVISION_CONFLICT', 'Agent provider changed during configuration')
      return this.options.store.configureInstance(current.instance, input)
    } finally { this.configuring.delete(instanceId) }
  }

  inspectStart(scope: ExecutionScope, instanceId: string, input: AgentRunInput, idempotencyKey: string): { instance: AgentInstance; previous: AgentExecution | null; provider?: AgentProviderRef } {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
    this.options.authorize(scope)
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) throw new StudioError('INVALID_ARGUMENT', 'An idempotency key is required')
    if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Independent instance runs require an unbound scope')
    const instance = this.options.store.instance(instanceId)
    if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
    input = jsonCopy(input)
    scope = jsonCopy(scope)
    const previous = this.options.store.findRequest(instance, input, idempotencyKey)
    if (previous) return { instance, previous }
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    const { definition, provider } = this.options.registry.resolve(scope.profileId, instance.agentTypeId)
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['content', 'model', 'timeoutMs'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid run input')
    if (!Array.isArray(input.content) || !input.content.length || input.content.length > 100) throw new StudioError('INVALID_ARGUMENT', 'Run content is required')
    for (const block of input.content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) throw new StudioError('INVALID_ARGUMENT', 'Invalid content block')
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || Object.keys(block).some(key => !['type', 'text'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid text content')
        if (!definition.capabilities.text) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not support text input')
      } else if (block.type === 'image') {
        if (typeof block.artifactId !== 'string' || !/^[a-f0-9-]{36}$/.test(block.artifactId)
          || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mediaType)
          || Object.keys(block).some(key => !['type', 'artifactId', 'mediaType'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid image content')
        if (!definition.capabilities.images || !this.options.validateInput) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent image input is unavailable')
      } else throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported content block')
    }
    this.options.validateInput?.(scope, input)
    if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256)) throw new StudioError('INVALID_ARGUMENT', 'Invalid model')
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 3_600_000)) throw new StudioError('INVALID_ARGUMENT', 'Invalid run deadline')
    return { instance, previous: null, provider }
  }

  start(scope: ExecutionScope, instanceId: string, input: AgentRunInput, idempotencyKey: string, admission?: AgentAdmission): AgentExecution {
    const original = this.inspectStart(scope, instanceId, admission?.originalInput ?? input, idempotencyKey)
    if (original.previous) return original.previous
    const { instance, provider } = admission ? this.inspectStart(scope, instanceId, input, idempotencyKey) : original
    if (admission && (instance.revision !== admission.expectedRevision || JSON.stringify(provider) !== JSON.stringify(admission.expectedProvider))) {
      throw new StudioError('REVISION_CONFLICT', 'Agent configuration or provider changed during hooks')
    }
    input = jsonCopy(input); scope = jsonCopy(scope)
    const queue = this.queues.get(instance.id) || { pending: [] }
    if (this.active.size + this.leases.size >= 128 || queue.pending.length >= 32) throw new StudioError('RESOURCE_EXHAUSTED', 'Agent run queue is full')
    const accepted = this.options.store.accept(instance, provider!, input, idempotencyKey, admission)
    if (!accepted.created) return accepted.run
    const id = accepted.run.id
    let resolve!: () => void
    const completed = new Promise<void>(done => { resolve = done })
    const active: ActiveRun = {
      controller: new AbortController(), completed, resolve, started: false, expired: false, responses: new Map(),
      timer: setTimeout(() => { active.expired = true; this.stop(id) }, input.timeoutMs ?? 600_000),
      launch: () => {
        active.started = true
        queue.current = id
        void this.execute(accepted.run, instance, input, scope, active).catch(() => {
          this.options.logger.error('Agent execution finalization failed', { runId: id })
        }).finally(() => {
          this.release(id, instance.id)
          if (queue.current === id) queue.current = undefined
          const next = queue.pending.shift()
          if (next) this.active.get(next)?.launch()
          else this.queues.delete(instance.id)
        })
      },
    }
    this.active.set(id, active)
    this.queues.set(instance.id, queue)
    if (queue.current) {
      this.options.store.transition(id, ['accepted'], 'queued')
      queue.pending.push(id)
    } else active.launch()
    return this.options.store.get(id)!
  }

  get(scope: ExecutionScope, id: string): AgentExecution {
    this.options.authorize(scope)
    const run = this.options.store.get(id)
    if (!run || run.ownerId !== scope.principal.id || run.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Run is unavailable')
    if (scope.runId && scope.runId !== id) throw new StudioError('FORBIDDEN', 'Run is outside the execution scope')
    if (scope.sessionId || scope.workspaceId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Instance runs have no chat or workspace binding')
    return run
  }
  output(scope: ExecutionScope, id: string, after: number) {
    this.get(scope, id)
    if (!Number.isSafeInteger(after) || after < -1) throw new StudioError('INVALID_ARGUMENT', 'Invalid output cursor')
    return this.options.store.output(id, after)
  }
  usage(scope: ExecutionScope, id: string) { this.get(scope, id); return this.options.store.state.usage(id) }
  interactions(scope: ExecutionScope, id: string) { this.get(scope, id); return this.options.store.state.interactions(id) }

  async respond(scope: ExecutionScope, id: string, value: AgentInteractionResponse): Promise<AgentInteractionReceipt> {
    const input = parseInteractionResponse(value)
    this.get(scope, id)
    const active = this.active.get(id)
    const existing = this.options.store.state.interactions(id).find(item => item.id === input.interactionId)
    if (existing?.status === 'pending' && (!active?.handle?.respond || active.controller.signal.aborted)) {
      throw new StudioError('RUNTIME_UNAVAILABLE', 'Interaction runtime is unavailable')
    }
    const claim = this.options.store.state.claimResponse(id, input)
    const receipt = (value: AgentInteraction): AgentInteractionReceipt => ({ id: value.id, runId: value.runId, status: value.status })
    if (!claim.dispatch) {
      const result = await (active?.responses.get(input.interactionId) ?? claim.interaction)
      this.get(scope, id)
      return receipt(result)
    }
    const task = (async () => {
      try {
        const dispatch = await active!.handle!.respond!({ requestId: claim.interaction.requestId,
          ...(input.choiceId === undefined ? {} : { choiceId: input.choiceId }), ...(input.text === undefined ? {} : { text: input.text }) })
        if (dispatch !== undefined && (!dispatch || typeof dispatch !== 'object' || Object.keys(dispatch).length !== 1 || dispatch.status !== 'withdrawn')) {
          throw new StudioError('INVALID_ARGUMENT', 'Invalid interaction dispatch receipt')
        }
        const result = this.options.store.state.setInteraction(claim.interaction, dispatch?.status ?? 'resolved')
        if (!this.options.store.state.interactions(id).some(item => ['pending', 'responding'].includes(item.status))) {
          this.options.store.transition(id, ['waiting_input'], 'running')
        }
        return result
      } catch (error) {
        const latest = this.options.store.state.interactions(id).find(item => item.id === input.interactionId)
        if (latest?.status === 'withdrawn') return latest
        this.options.store.state.setInteraction(claim.interaction, 'interrupted')
        this.stop(id)
        throw error instanceof StudioError ? error : new StudioError('RUNTIME_UNAVAILABLE', 'Interaction response failed')
      }
    })()
    active!.responses.set(input.interactionId, task)
    // Keep the settled promise for the completion barrier and idempotent concurrent callers.
    void task.catch(() => {})
    const result = await task
    this.get(scope, id)
    return receipt(result)
  }

  async cancel(scope: ExecutionScope, id: string): Promise<AgentExecution> {
    const run = this.get(scope, id)
    if (run.status === 'finalizing') throw new StudioError('RUN_FINALIZING', 'Run is committing its final result')
    this.stop(id)
    return this.get(scope, id)
  }
  private stop(id: string): void {
    if (!this.options.store.transition(id, ['accepted', 'queued', 'starting', 'running', 'waiting_input'], 'cancelling')) return
    const active = this.active.get(id)
    active?.controller.abort()
    if (active && !active.started) {
      const run = this.options.store.get(id)!
      this.finish(id, active.expired ? 'interrupted' : 'cancelled', active.expired ? 'DEADLINE_EXCEEDED' : null)
      this.release(id, run.instanceId)
    }
  }
  private release(id: string, instanceId: string): void {
    const active = this.active.get(id)
    if (!active) return
    clearTimeout(active.timer)
    this.active.delete(id)
    const queue = this.queues.get(instanceId)
    if (queue) queue.pending = queue.pending.filter(value => value !== id)
    active.resolve()
  }
  private finish(id: string, status: 'completed' | 'cancelled' | 'failed' | 'interrupted', error: string | null, checkpoint?: JsonValue): void {
    for (const event of this.options.store.finish(id, status, error, checkpoint)) this.options.events.publish(event)
  }

  async wait(id: string): Promise<void> { await this.active.get(id)?.completed }
  async close(): Promise<void> {
    this.closed = true
    const management = this.management.close()
    for (const id of [...this.active.keys()]) this.stop(id)
    await Promise.allSettled([management, ...[...this.active.values()].map(active => active.completed)])
    await Promise.allSettled([...this.leases.keys()].map(id => this.disposeLease(id, 'Host shutdown')))
  }

  private async disposeLease(instanceId: string, reason: string): Promise<void> {
    const lease = this.leases.get(instanceId)
    if (!lease) return
    if (lease.disposing) return lease.disposing
    if (lease.idleTimer) clearTimeout(lease.idleTimer)
    lease.controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Keep the instance occupied until disposal is confirmed, including a late
    // factory result. A timeout bounds the caller's wait; it cannot certify exit.
    const cleanup = lease.runtime.then(runtime => runtime.dispose(reason), () => {})
      .finally(async () => {
        const results = await Promise.allSettled([lease.processes.close(), lease.mcp.close(), lease.settling])
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })
      .then(() => {
        this.options.store.state.closeLease(lease.id)
        if (this.leases.get(instanceId) === lease) this.leases.delete(instanceId)
      })
    lease.disposing = Promise.race([cleanup, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StudioError('RUNTIME_UNAVAILABLE', 'Previous Agent runtime has not stopped')), 5_000)
    })]).catch(() => { throw new StudioError('RUNTIME_UNAVAILABLE', 'Previous Agent runtime has not stopped') })
      .finally(() => { if (timer) clearTimeout(timer) })
    return lease.disposing
  }

  private async execute(run: AgentExecution, instance: AgentInstance, input: AgentRunInput, scope: ExecutionScope, active: ActiveRun): Promise<void> {
    let settling: Promise<void> | undefined
    const settle = () => settling ??= Promise.resolve().then(() => this.options.settleRun?.(run.id))
    let deadline: ReturnType<typeof setTimeout> | undefined
    let finalizationDeadline: ReturnType<typeof setTimeout> | undefined
    let ended = false, retain = false
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    void aborted.catch(() => {})
    const onAbort = () => {
      void active.handle?.cancel('Execution cancelled').catch(() => {})
      deadline = setTimeout(() => rejectAbort(new StudioError('DEADLINE_EXCEEDED', 'Agent did not stop within cancellation deadline')), 5_000)
    }
    active.controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (active.controller.signal.aborted) { this.finish(run.id, 'cancelled', null); return }
      const assertDispatch = () => {
        this.options.authorize(scope)
        this.options.validateInput?.(scope, input)
        const current = this.options.store.instance(instance.id)
        if (!current || current.ownerId !== scope.principal.id || current.profileId !== scope.profileId || current.revision !== run.configRevision) throw new StudioError('REVISION_CONFLICT', 'Agent instance changed before dispatch')
        const resolved = this.options.registry.resolve(scope.profileId, instance.agentTypeId)
        if (JSON.stringify(resolved.provider) !== JSON.stringify(run.provider)) throw new StudioError('REVISION_CONFLICT', 'Agent provider changed before dispatch')
        return resolved
      }
      const resolved = assertDispatch()
      this.options.store.transition(run.id, ['accepted', 'queued'], 'starting')
      let lease = this.leases.get(instance.id)
      if (lease && (lease.disposing || lease.revision !== run.configRevision || JSON.stringify(lease.provider) !== JSON.stringify(run.provider))) {
        await this.disposeLease(instance.id, 'Provider or configuration changed')
        lease = undefined
      }
      if (lease?.idleTimer) clearTimeout(lease.idleTimer)
      if (active.controller.signal.aborted) { this.finish(run.id, active.expired ? 'interrupted' : 'cancelled', active.expired ? 'DEADLINE_EXCEEDED' : null); return }
      assertDispatch()
      if (!lease) {
        const controller = new AbortController()
        const id = this.options.store.state.openLease(instance.id, run.provider, run.configRevision)
        const resume = resolved.definition.capabilities.resume ? this.options.store.state.checkpoint(instance.id, run.provider, run.configRevision) : undefined
        const processes = new ManagedProcessScope(controller.signal, () => { assertDispatch() })
        const mcp = new ManagedMcpScope(controller.signal, () => { assertDispatch() })
        // Install the lease before invoking user code, including factories that
        // start a process and then throw synchronously.
        const creating = Promise.resolve().then(async () => {
          const stateDirectory = instance.mode === 'scoped' && this.options.stateRoot ? await agentStateDirectory(this.options.stateRoot, instance, run.provider) : undefined
          assertDispatch()
          return resolved.definition.create({ instanceId: instance.id, config: instance.config, configRevision: instance.revision, mode: instance.mode,
            ...(resume === undefined ? {} : { resume }) }, {
            ...(stateDirectory ? { stateDirectory } : {}), provider: run.provider, runtimeSessionId: id, profileId: scope.profileId, ownerId: scope.principal.id, signal: controller.signal, logger: this.options.logger, processes: processes.api, mcp: mcp.api,
          })
        })
        lease = { id, provider: run.provider, revision: run.configRevision, controller, runtime: creating, creating: true, processes, mcp }
        this.leases.set(instance.id, lease)
        const pending = lease
        void creating.then(() => { pending.creating = false }, () => { pending.creating = false })
      }
      const runtime = await Promise.race([lease.runtime, aborted])
      if (active.controller.signal.aborted) { this.finish(run.id, active.expired ? 'interrupted' : 'cancelled', active.expired ? 'DEADLINE_EXCEEDED' : null); return }
      assertDispatch()
      this.options.store.state.bindLease(run.id, lease.id)
      const context = this.options.context({ ...scope, runId: run.id }, active.controller.signal)
      const runContext: AgentRunContext = { ...context, scope: { ...context.scope, runId: run.id, runtimeSessionId: lease.id } }
      this.options.store.transition(run.id, ['starting'], 'running')
      const starting = runtime.run(input, runContext)
      void starting.then(late => { if (ended) { void late.result.catch(() => {}); void late.cancel('Run start exceeded deadline').catch(() => {}) } }).catch(() => {})
      active.handle = await Promise.race([starting, aborted])
      if (active.controller.signal.aborted) void active.handle.cancel('Execution cancelled').catch(() => {})
      let sequence = -1, checkpoint: JsonValue | undefined
      const tools = new Set<string>()
      const [result] = await Promise.race([
        Promise.all([active.handle.result.then(value => {
          finalizationDeadline = setTimeout(() => rejectAbort(new StudioError('DEADLINE_EXCEEDED', 'Agent output did not drain')), 5_000)
          return value
        }), (async () => {
          for await (const raw of active.handle!.events) {
            if (ended) break
            const event = parseAgentOutput(raw)
            if (event.producerSequence <= sequence) throw new StudioError('INVALID_ARGUMENT', 'Agent output is out of sequence')
            sequence = event.producerSequence
            if (event.type === 'interaction.requested' && (!active.handle?.respond
              || !(event.kind === 'approval' ? resolved.definition.capabilities.approvals : resolved.definition.capabilities.clarifications))) {
              throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent cannot handle this interaction')
            }
            if (event.type === 'tool.started') tools.add(event.callId)
            if (event.type === 'tool.completed' || event.type === 'tool.failed') tools.delete(event.callId)
            if (event.type === 'checkpoint.updated') checkpoint = event.value
            this.options.store.appendOutput(run.id, event)
          }
        })()]), aborted,
      ])
      await Promise.race([Promise.all(active.responses.values()), aborted])
      if (!result || !['completed', 'cancelled'].includes(result.status)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent result')
      const cancelling = this.options.store.get(run.id)?.status === 'cancelling'
      if (!cancelling && result.status === 'completed') {
        if (tools.size || this.options.store.state.interactions(run.id).some(item => !['resolved', 'withdrawn'].includes(item.status))) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent ended with unresolved work')
        if (!this.options.store.transition(run.id, ['running', 'waiting_input'], 'finalizing')) throw new StudioError('REVISION_CONFLICT', 'Run cannot finalize')
        await Promise.race([settle(), aborted])
        if (result.checkpoint !== undefined) checkpoint = jsonCopy(result.checkpoint)
        if (checkpoint === undefined && resolved.definition.capabilities.resume && runtime.checkpoint) {
          checkpoint = jsonCopy(await Promise.race([runtime.checkpoint(), aborted]))
        }
        this.finish(run.id, 'completed', null, checkpoint)
        retain = !!resolved.definition.capabilities.persistentSession && !this.closed
      } else this.finish(run.id, active.expired ? 'interrupted' : 'cancelled', active.expired ? 'DEADLINE_EXCEEDED' : null)
    } catch (error) {
      this.finish(run.id, error instanceof StudioError && ['PLUGIN_UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(error.code) ? 'interrupted' : 'failed', error instanceof StudioError ? error.code : 'INTERNAL')
    } finally {
      ended = true
      active.controller.signal.removeEventListener('abort', onAbort)
      if (deadline) clearTimeout(deadline)
      if (finalizationDeadline) clearTimeout(finalizationDeadline)
      active.controller.abort()
      const lease = this.leases.get(instance.id)
      if (lease && !lease.disposing) lease.settling = settle()
      try { await settle() } catch { retain = false }
      const dispose = (reason: string) => this.disposeLease(instance.id, reason)
        .catch(() => { this.options.logger.warn('Agent runtime disposal is unconfirmed', { instanceId: instance.id }) })
      if (!retain) {
        const creating = this.leases.get(instance.id)?.creating
        const cleanup = dispose('Run ended')
        // Cancellation already waited for this factory. Keep its lease occupied,
        // but report the finished Run without waiting through a second timeout.
        if (!creating) await cleanup
      }
      else {
        const lease = this.leases.get(instance.id)!
        lease.idleTimer = setTimeout(() => { void dispose('Idle runtime expired') }, 60_000)
        lease.idleTimer.unref()
      }
    }
  }
}
