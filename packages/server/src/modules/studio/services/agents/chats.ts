import { StudioError, type AgentRunInput, type AgentOutputEvent, type AgentInteractionResponse, type ExecutionScope } from '../../contracts/plugins'
import type { AgentChatProjection } from '../../repositories/agent-chat-projection'
import type { AgentChatCreationInput, AgentChatStore } from '../../repositories/agent-chat-store'
import type { AgentExecutionStore, AgentInstance } from '../../repositories/agent-execution-store'
import type { AgentCoordinator } from './coordinator'
import type { AgentRunAdmission } from './admission'
import type { AgentRegistry } from './registry'
import { jsonCopy } from '../plugins/validation'
import type { NativeAgentTurnBinding } from './native-context'
import type { AgentRunCommandOrigin } from '../../repositories/agent-run-command-origin'

export interface AgentChatSessionCreation {
  id: string; profile: string; source: string; agent: string; agent_mode: 'scoped' | 'global'
  user_id: string; studio_user_id: string; workspace?: string; model?: string
  provider?: string; reasoning_effort?: string; agent_preset?: string; category_id?: number | null; push_enabled?: boolean
}
export interface AgentChatInteractionLease {
  contextId: string; instructions: string
  finish(state: 'ended' | 'interrupted' | 'failed'): void
}

/** Owned chat application service over canonical Agent Runs. No HTTP/Socket
 * objects, native-provider branches, input replay or second transcript writer. */
export class AgentChats {
  private closed = false
  private readonly turns = new Map<string, { binding: NativeAgentTurnBinding; finish(state: 'ended' | 'interrupted' | 'failed'): void }>()
  constructor(private readonly deps: {
    store: AgentChatStore; projection: AgentChatProjection; executions: AgentExecutionStore
    coordinator: AgentCoordinator; admission: AgentRunAdmission; registry: AgentRegistry
    authorize(scope: ExecutionScope): void
    createSession(input: AgentChatSessionCreation): void
    prepareRuntime?(scope: ExecutionScope, instance: AgentInstance): Promise<void>
    interactions?: { begin(sessionId: string, profileId: string, runId: string, isActive: () => boolean, interactive: boolean, ownerId: string): AgentChatInteractionLease }
    interactionError?(runId: string): void
  }) {}

  isBound(sessionId: string): boolean { return !!this.deps.projection.binding(sessionId) }

  create(inputScope: ExecutionScope, instanceId: string, value: AgentChatCreationInput,
    session?: { id: string; settings: Pick<AgentChatSessionCreation, 'model' | 'provider' | 'reasoning_effort' | 'agent_preset' | 'category_id' | 'push_enabled'> }) {
    const scope = jsonCopy(inputScope), input = jsonCopy(value)
    this.check(scope)
    if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat creation requires an unbound user scope')
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['revision', 'idempotencyKey'].includes(key))
      || !Number.isSafeInteger(input.revision) || input.revision < 1
      || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) throw new StudioError('INVALID_ARGUMENT', 'Invalid chat creation request')
    const instance = this.instance(scope, instanceId)
    const previous = this.deps.store.find(scope, instance, input)
    if (previous) { this.ownedBinding(scope, previous.sessionId); return previous }
    if (instance.revision !== input.revision) throw new StudioError('REVISION_CONFLICT', 'Agent configuration changed before chat creation')
    const { provider } = this.deps.registry.resolve(scope.profileId, instance.agentTypeId)
    const source = provider.kind === 'builtin' ? provider.module === 'ekko' ? 'builtin_agent' : 'cli' : 'coding_agent'
    return this.deps.store.accept(scope, instance, input, binding => {
      this.check(scope)
      if (this.instance(scope, instance.id).revision !== input.revision) throw new StudioError('REVISION_CONFLICT', 'Agent configuration changed before chat creation')
      this.deps.createSession({ id: binding.sessionId, profile: instance.profileId, source, agent: instance.agentTypeId, agent_mode: instance.mode,
        user_id: scope.principal.id, studio_user_id: scope.principal.id,
        ...(typeof instance.config.cwd === 'string' ? { workspace: instance.config.cwd } : {}),
        ...(typeof instance.config.model === 'string' ? { model: instance.config.model } : {}), ...session?.settings })
      this.deps.projection.attach(binding.sessionId, instance, source)
      this.check(scope)
    }, source, session?.id)
  }

  ownedBinding(scope: ExecutionScope, sessionId: string) {
    this.check(scope)
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid chat id')
    if (scope.sessionId !== undefined && scope.sessionId !== sessionId) throw new StudioError('FORBIDDEN', 'Chat is outside the execution scope')
    const binding = this.deps.projection.binding(sessionId)
    if (!binding || binding.ownerId !== scope.principal.id || binding.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent chat is unavailable')
    const instance = this.instance(scope, binding.instanceId)
    return { binding: this.deps.projection.assertBinding(sessionId, instance), instance }
  }

  authorizeRunTarget(scope: ExecutionScope, instance: AgentInstance, sessionId: string): void {
    const current = this.ownedBinding(scope, sessionId)
    if (current.instance.id !== instance.id) throw new StudioError('FORBIDDEN', 'Chat belongs to another Agent instance')
  }

  async start(inputScope: ExecutionScope, sessionId: string, value: AgentRunInput, idempotencyKey: string, signal: AbortSignal, command?: AgentRunCommandOrigin) {
    const scope = jsonCopy(inputScope), input = jsonCopy(value)
    const { instance } = this.ownedBinding(scope, sessionId)
    if (signal.aborted) throw new StudioError('CANCELLED', 'Run start was cancelled')
    await this.deps.prepareRuntime?.(scope, instance)
    this.ownedBinding(scope, sessionId)
    if (signal.aborted) throw new StudioError('CANCELLED', 'Run start was cancelled')
    return this.deps.admission.startInChat(scope, sessionId, { instanceId: instance.id, input, idempotencyKey }, signal, command)
  }

  async cancel(scope: ExecutionScope, sessionId: string, runId: string) {
    this.ownedBinding(scope, sessionId)
    const current = { ...scope, sessionId }
    await this.deps.coordinator.cancel(current, runId)
    await this.deps.coordinator.wait(runId)
    return this.deps.coordinator.get(current, runId)
  }

  get(scope: ExecutionScope, sessionId: string, runId: string) {
    this.ownedBinding(scope, sessionId)
    return this.deps.coordinator.get({ ...scope, sessionId }, runId)
  }

  activity(scope: ExecutionScope, sessionId: string) {
    this.ownedBinding(scope, sessionId)
    return this.deps.executions.activeForChat(sessionId).map(run => ({ run,
      queueId: this.deps.executions.requestKey(run.id)!, input: this.deps.executions.originalInput(run.id)! }))
  }
  summary(scope: ExecutionScope, sessionId: string) {
    this.ownedBinding(scope, sessionId)
    return this.deps.projection.summary(sessionId)
  }
  text(scope: ExecutionScope, sessionId: string, runId: string) {
    const run = this.get(scope, sessionId, runId)
    return { run, ...this.deps.projection.text(runId) }
  }

  output(scope: ExecutionScope, sessionId: string, runId: string, after: number) {
    this.get(scope, sessionId, runId)
    return this.deps.coordinator.output({ ...scope, sessionId }, runId, after)
  }

  rows(scope: ExecutionScope, sessionId: string, runId: string, events: AgentOutputEvent[], includeInput = false, refreshUsage = false) {
    this.get(scope, sessionId, runId)
    return this.deps.projection.rows(runId, events, includeInput, refreshUsage)
  }

  interactions(scope: ExecutionScope, sessionId: string, runId: string) {
    this.get(scope, sessionId, runId)
    return this.deps.coordinator.interactions({ ...scope, sessionId }, runId)
  }

  respond(scope: ExecutionScope, sessionId: string, runId: string, response: AgentInteractionResponse) {
    this.get(scope, sessionId, runId)
    return this.deps.coordinator.respond({ ...scope, sessionId }, runId, response)
  }

  wait(runId: string) { return this.deps.coordinator.wait(runId) }

  async prepareHistoryChange(scope: ExecutionScope, sessionId: string) {
    this.ownedBinding(scope, sessionId)
    this.assertNotExecutingTarget(scope, sessionId)
    const lease = await this.deps.coordinator.freezeChat(sessionId)
    try { this.ownedBinding(scope, sessionId); return lease }
    catch (error) { lease.release(); throw error }
  }

  authorizeRemoval(scope: ExecutionScope, sessionId: string): void {
    // The durable binding is also a tombstone. A lost-response retry must never
    // fall through to a legacy engine using the now-deleted chat id.
    this.check(scope)
    const binding = this.deps.projection.binding(sessionId)
    if (!binding || binding.ownerId !== scope.principal.id || binding.profileId !== scope.profileId
      || (scope.sessionId !== undefined && scope.sessionId !== sessionId)) throw new StudioError('NOT_FOUND', 'Agent chat is unavailable')
    this.instance(scope, binding.instanceId)
    if (this.deps.projection.hasSession(sessionId)) this.ownedBinding(scope, sessionId)
  }

  async prepareRemoval(scope: ExecutionScope, sessionId: string) {
    this.authorizeRemoval(scope, sessionId)
    this.assertNotExecutingTarget(scope, sessionId)
    const lease = await this.deps.coordinator.freezeChat(sessionId)
    try { this.authorizeRemoval(scope, sessionId); return lease }
    catch (error) { lease.release(); throw error }
  }

  private assertNotExecutingTarget(scope: ExecutionScope, sessionId: string): void {
    const run = scope.runId ? this.deps.executions.get(scope.runId) : undefined
    if (run?.sessionId === sessionId && run.ownerId === scope.principal.id && run.profileId === scope.profileId
      && !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Stop the current Run before removing or clearing its chat')
    }
  }

  beginNativeTurn(inputScope: ExecutionScope, instance: AgentInstance, runId: string, signal: AbortSignal): NativeAgentTurnBinding {
    const scope = jsonCopy(inputScope)
    if (!scope.sessionId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native interactions require a bound chat')
    this.authorizeRunTarget(scope, instance, scope.sessionId)
    const run = this.deps.coordinator.get(scope, runId)
    if (run.instanceId !== instance.id || run.sessionId !== scope.sessionId || !['starting', 'running', 'waiting_input'].includes(run.status)) throw new StudioError('RUN_FINALIZING', 'Native chat turn is unavailable')
    if (signal.aborted) throw new StudioError('CANCELLED', 'Native chat turn ended')
    const previous = this.turns.get(runId)
    if (previous) return previous.binding
    if (!this.deps.interactions) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat interactions are unavailable')
    const interactive = run.surface === 'chat'
    const lease = this.deps.interactions.begin(scope.sessionId, scope.profileId, runId, () => {
      try {
        this.authorizeRunTarget(scope, instance, scope.sessionId!)
        const current = this.deps.executions.get(runId)
        return !signal.aborted && !!current && current.sessionId === scope.sessionId && current.instanceId === instance.id
          && ['starting', 'running', 'waiting_input'].includes(current.status)
      } catch { return false }
    }, interactive, scope.principal.id)
    let finished = false
    const finish = (state: 'ended' | 'interrupted' | 'failed') => {
      if (finished) return
      finished = true; signal.removeEventListener('abort', ended)
      this.turns.delete(runId)
      try { lease.finish(state) } catch { this.deps.interactionError?.(runId) }
    }
    // Revocation stops MCP immediately; the task card settles only after the
    // canonical Run has confirmed native cleanup and committed its terminal state.
    const ended = () => { void this.deps.coordinator.wait(runId).then(() => {
      const status = this.deps.executions.get(runId)?.status
      finish(status === 'completed' ? 'ended' : status === 'failed' ? 'failed' : 'interrupted')
    }).catch(() => finish('interrupted')) }
    const binding = { contextId: lease.contextId, sessionId: scope.sessionId, instructions: lease.instructions, interactive }
    this.turns.set(runId, { binding, finish })
    signal.addEventListener('abort', ended, { once: true })
    if (signal.aborted) ended()
    return binding
  }

  close(): void {
    this.closed = true
    for (const turn of [...this.turns.values()]) turn.finish('interrupted')
  }

  private instance(scope: ExecutionScope, id: string): AgentInstance {
    if (typeof id !== 'string' || !id || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent instance id')
    const instance = this.deps.executions.instance(id)
    if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
    return instance
  }

  private check(scope: ExecutionScope): void {
    this.deps.authorize(scope)
    if (scope.principal.kind !== 'user') throw new StudioError('FORBIDDEN', 'Agent chats require a user principal')
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent chat service is closed')
  }
}
