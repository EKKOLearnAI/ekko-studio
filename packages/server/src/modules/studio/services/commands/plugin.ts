import { StudioError, type ExecutionScope, type ExecutionContext, type CommandContext, type CommandInput } from '../../contracts/plugins'
import { PluginCommandStore, type CommandStart, type CommandCall, type CommandEvent } from '../../repositories/plugin-command-store'
import { PluginCommandRegistry, parseCommandResult } from '../plugins/commands'
import { jsonCopy } from '../plugins/validation'

export interface CommandTarget { agentTypeId: string; fingerprint: string; isWorking: boolean; instanceId?: string; instanceRevision?: number }
export class PluginCommands {
  private readonly active = new Map<string, { sessionId: string; controller: AbortController; done: Promise<void> }>()
  private closed = false
  constructor(private readonly deps: {
    registry: PluginCommandRegistry; store: PluginCommandStore
    authorize(scope: ExecutionScope, sessionId: string): CommandTarget
    context(scope: ExecutionScope, signal: AbortSignal, call?: CommandCall, target?: CommandTarget): ExecutionContext
    cancelRuns?(scope: ExecutionScope, callId: string): Promise<void>
    persist(sessionId: string, text: string): number | undefined
    committed?(sessionId: string, text: string, messageId: number | undefined): void
    publish(event: CommandEvent): void
  }) {}
  list(scope: ExecutionScope, sessionId: string) {
    this.checkScope(scope)
    const target = this.deps.authorize(scope, sessionId)
    return this.deps.registry.list(scope.profileId, target.agentTypeId, this.selection(scope, sessionId, target))
  }
  start(scope: ExecutionScope, value: CommandStart): CommandCall {
    this.checkScope(scope)
    const input = jsonCopy(value, 32_768)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sessionId', 'commandId', 'revision', 'text', 'idempotencyKey'].includes(key))
      || ['sessionId', 'commandId', 'revision', 'idempotencyKey'].some(key => typeof input[key as keyof CommandStart] !== 'string' || !input[key as keyof CommandStart] || input[key as keyof CommandStart].length > 256)
      || typeof input.text !== 'string' || input.text.length > 16_384) throw new StudioError('INVALID_ARGUMENT', 'Invalid command request')
    const target = this.deps.authorize(scope, input.sessionId)
    const previous = this.deps.store.find(scope, input)
    if (previous) return previous
    if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Command service is closed')
    if ([...this.active.values()].some(call => call.sessionId === input.sessionId)) throw new StudioError('REVISION_CONFLICT', 'A command is already running in this session')
    if (this.active.size >= 32) throw new StudioError('RESOURCE_EXHAUSTED', 'Command concurrency limit reached')
    const entry = this.deps.registry.resolve(scope.profileId, target.agentTypeId, input.commandId, input.revision, this.selection(scope, input.sessionId, target))
    const match = /^\s*\/([^\s]+)([\s\S]*)$/.exec(input.text)
    if (!match || ![entry.summary.name, entry.summary.qualifiedName, ...(entry.summary.aliases || [])].includes(match[1])) throw new StudioError('INVALID_ARGUMENT', 'Input does not match selected command')
    // Preserve the entire tail, including whitespace, quoting and line breaks. The plugin parses it.
    const command: CommandInput = { text: input.text, command: match[1], rawArguments: match[2] }
    const snapshot = jsonCopy({ ...scope, sessionId: input.sessionId, surface: 'chat' as const })
    const controller = new AbortController()
    const record = this.deps.store.accept(snapshot, input, () => this.deps.persist(input.sessionId, input.text))
    snapshot.scopeId = record.id
    let execution: ExecutionContext
    try { execution = this.deps.context(snapshot, controller.signal, record, target) }
    catch (error) { controller.abort(error); this.deps.store.finish(record.id, 'failed', 'RUNTIME_UNAVAILABLE'); throw error }
    this.deps.committed?.(input.sessionId, input.text, record.inputMessageId)
    const check = () => {
      if (controller.signal.aborted) throw controller.signal.reason
      const current = this.deps.authorize(snapshot, input.sessionId)
      if (current.fingerprint !== target.fingerprint) throw new StudioError('REVISION_CONFLICT', 'Command target changed')
      this.deps.registry.resolve(snapshot.profileId, current.agentTypeId, input.commandId, input.revision, this.selection(snapshot, input.sessionId, current))
      return current
    }
    const timer = setTimeout(() => controller.abort(new StudioError('DEADLINE_EXCEEDED', 'Command timed out')), 60_000)
    const watch = setInterval(() => { try { check() } catch (error) { controller.abort(error) } }, 250)
    const ctx: CommandContext = Object.assign({ ...execution }, {
      session: Object.freeze({ agentTypeId: target.agentTypeId, isWorking: target.isWorking,
        ...(target.instanceId ? { instanceId: target.instanceId, instanceRevision: target.instanceRevision } : {}) }),
      reply: async (value: unknown) => {
        const current = check(), result = parseCommandResult(value, command)
        if (current.isWorking && (result.terminal === true || result.started === true)) throw new StudioError('REVISION_CONFLICT', 'Command result conflicts with an active chat run')
        const event = this.deps.store.append(record.id, result, () => result.message ? this.deps.persist(input.sessionId, result.message) : undefined)
        this.deps.committed?.(input.sessionId, result.message, event.messageId)
        this.deps.publish(event)
      },
    })
    const done = Promise.resolve().then(async () => {
      check()
      await entry.invoke(input.commandId, command, ctx)
      check()
      this.deps.store.finish(record.id, 'completed')
    }).catch(async error => {
      let cleanupFailed = false
      try { await this.deps.cancelRuns?.(snapshot, record.id) }
      catch { cleanupFailed = true; error = new StudioError('RUNTIME_UNAVAILABLE', 'Command Run cleanup could not be confirmed') }
      this.deps.store.finish(record.id, !cleanupFailed && controller.signal.aborted && controller.signal.reason?.code === 'CANCELLED' ? 'cancelled' : 'failed', error instanceof StudioError ? error.code : 'RUNTIME_UNAVAILABLE')
    }).finally(() => { clearTimeout(timer); clearInterval(watch); controller.abort(); this.active.delete(record.id) })
    this.active.set(record.id, { sessionId: input.sessionId, controller, done })
    return record
  }
  get(scope: ExecutionScope, id: string): CommandCall {
    this.checkScope(scope)
    const record = this.deps.store.get(id)
    if (!record || record.ownerId !== scope.principal.id || record.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Command call is unavailable')
    this.deps.authorize(scope, record.sessionId)
    return record
  }
  async cancel(scope: ExecutionScope, id: string): Promise<CommandCall> {
    this.get(scope, id)
    const active = this.active.get(id)
    if (active) { active.controller.abort(new StudioError('CANCELLED', 'Command cancelled')); await active.done }
    return this.get(scope, id)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const active of this.active.values()) active.controller.abort(new StudioError('CANCELLED', 'Command service closed'))
    await Promise.allSettled([...this.active.values()].map(value => value.done))
  }
  private checkScope(scope: ExecutionScope): void {
    if (scope.runId || scope.workspaceId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Command requires a chat scope')
  }
  private selection(scope: ExecutionScope, sessionId: string, target: CommandTarget) {
    return target.instanceId && target.instanceRevision !== undefined ? {
      ownerId: scope.principal.id, sessionId, instanceId: target.instanceId, instanceRevision: target.instanceRevision,
    } : undefined
  }
}
