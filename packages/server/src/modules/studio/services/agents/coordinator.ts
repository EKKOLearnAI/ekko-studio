import {
  StudioError, type AgentRunHandle, type AgentRunInput, type AgentRunContext, type AgentRuntime, type AgentTypeDefinition,
  type ExecutionScope, type ExecutionContext, type JsonObject, type JsonValue, type ScopedLogger,
  type AgentProviderRef, type AgentInteractionResponse, type AgentInteraction, type AgentInteractionReceipt,
} from '../../contracts/plugins'
import { AgentExecutionStore, type AgentInstance, type AgentInstanceConfiguration, type AgentExecution, type AgentAdmission } from '../../repositories/agent-execution-store'
import { AgentRegistry } from './registry'
import { PluginEventBus } from '../events/plugin-events'
import { compileSchema, jsonCopy, parseAgentOutput, parseAgentSetup } from '../plugins/validation'
import { ManagedMcpScope } from '../mcp/managed'
import { ManagedProcessScope } from '../processes/managed'
import { agentStateDirectory } from './state-directory'
import { AgentManagement } from './management'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentResourceFiles, type ResourceFileOperation } from './resource-files'
import { AgentResourceSkills } from './resource-skill-files'
import { copySkillUploads, parseSkillArchive, type ResourceSkillUpload } from './resource-skill-archive'
import { parseAgentResourceLocations } from './resource-contract'
import { AgentManagementOperations } from './management-operations'
import type { AgentManagementStore } from '../../repositories/agent-management-store'
import { parseAgentLogin } from './login-contract'
import type { NativeAgentContext } from './native-context'
import type { AgentRunTarget } from '../../repositories/agent-conversation-store'
import { bindRuntimeCommandTarget } from './command-target'
import { AgentCliInstallations, type CliInstallStage } from './cli-installations'
import { parseAgentCliInstall } from './cli-install-contract'

interface ActiveRun {
  controller: AbortController; handle?: AgentRunHandle; completed: Promise<void>; resolve(): void
  started: boolean; expired: boolean; timer: ReturnType<typeof setTimeout>; launch(): void
  responses: Map<string, Promise<AgentInteraction>>
}
interface RuntimeLease {
  instanceId: string
  definition: AgentTypeDefinition
  surface: ExecutionScope['surface']
  id: string; provider: AgentProviderRef; revision: number; controller: AbortController
  runtime: Promise<AgentRuntime>; creating: boolean; idleTimer?: ReturnType<typeof setTimeout>; disposing?: Promise<void>
  processes: ManagedProcessScope
  mcp: ManagedMcpScope
  nativeContext?: NativeAgentContext
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
  private readonly frozenChats = new Set<string>()
  private readonly management: AgentManagement
  private readonly installations?: AgentCliInstallations
  readonly managementOperations?: AgentManagementOperations
  private closed = false
  constructor(private readonly options: {
    store: AgentExecutionStore; registry: AgentRegistry; events: PluginEventBus; logger: ScopedLogger
    authorize(scope: ExecutionScope): void
    context(scope: ExecutionScope, signal: AbortSignal): ExecutionContext
    stateRoot?: string
    settleRun?(runId: string): Promise<void>
    validateInput?(scope: ExecutionScope, input: AgentRunInput): void
    managementStore?: AgentManagementStore
    authorizeManagement?(scope: ExecutionScope): void
    leaseManagement?(provider: AgentProviderRef, profileId: string, cancel: () => void, completed: Promise<void>): { authorize(): void; release(): void }
    nativeContext?(instance: AgentInstance, scope: ExecutionScope, provider: AgentProviderRef, signal: AbortSignal): NativeAgentContext | undefined
    authorizeChat?(scope: ExecutionScope, instance: AgentInstance, sessionId: string): void
  }) {
    if (options.stateRoot) this.installations = new AgentCliInstallations(options.stateRoot)
    this.management = new AgentManagement((input, scope, provider) => this.installations?.load({ id: input.instanceId, ownerId: scope.principal.id, profileId: scope.profileId }, provider))
    if (options.managementStore && options.authorizeManagement && options.leaseManagement) this.managementOperations = new AgentManagementOperations(options.managementStore, options.authorizeManagement)
  }

  startLogin(scope: ExecutionScope, instanceId: string, revision: number, idempotencyKey: string) {
    return this.startManagement(scope, instanceId, revision, idempotencyKey, 'login')
  }
  startInstall(scope: ExecutionScope, instanceId: string, revision: number, idempotencyKey: string) {
    return this.startManagement(scope, instanceId, revision, idempotencyKey, 'install')
  }
  private startManagement(scope: ExecutionScope, instanceId: string, revision: number, idempotencyKey: string, action: 'login' | 'install') {
    scope = jsonCopy(scope)
    const operations = this.managementOperations
    if (!operations || this.closed) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Interactive management is unavailable')
    const previous = operations.previous(scope, instanceId, revision, idempotencyKey, action)
    if (previous) return previous
    const inspect = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
      this.options.authorizeManagement!(scope)
      const instance = this.options.store.instance(instanceId)
      if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
      if (instance.revision !== revision || this.queues.has(instanceId) || this.options.store.hasActiveRuns(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance changed or has active runs')
      return { instance, ...this.options.registry.resolve(scope.profileId, instance.agentTypeId) }
    }
    const { instance, provider, definition } = inspect(), adapter = definition.management
    if (!adapter?.[action === 'install' ? 'prepareInstall' : 'prepareLogin'] || (action === 'install' && !this.installations)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native management is unavailable')
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    let lease: { authorize(): void; release(): void } | undefined
    const authorize = () => {
      if (!isDeepStrictEqual(inspect().provider, provider)) throw new StudioError('REVISION_CONFLICT', 'Agent provider changed during management')
      lease?.authorize()
    }
    this.configuring.add(instanceId)
    try {
      return operations.start({ ownerId: scope.principal.id, profileId: scope.profileId, instanceId, revision, provider, idempotencyKey, action }, authorize, async control => {
        await this.disposeInstanceLeases(instanceId, 'Native management started')
        authorize()
        const stateDirectory = this.options.stateRoot ? await agentStateDirectory(this.options.stateRoot, instance, provider,
          this.options.store.state.stateRevision(instance.id, provider, revision)) : undefined
        const input = { instanceId, config: instance.config, configRevision: revision, mode: instance.mode }
        let stage: CliInstallStage | undefined
        const check = () => { if (control.signal.aborted) throw control.signal.reason; authorize() }
        try {
          const exit = await this.management.execute(input, scope, provider, async context => {
            const prepared = action === 'install' ? parseAgentCliInstall(await adapter.prepareInstall!(input, context)) : parseAgentLogin(await adapter.prepareLogin!(input, context))
            // Acquire only after the short RPC: worker timeout cleanup must not
            // wait for an operation that is itself waiting for that same RPC.
            authorize()
            lease = this.options.leaseManagement!(provider, scope.profileId,
              () => control.abort(new StudioError('PLUGIN_UNAVAILABLE', 'Management provider exited')), control.completed)
            if (action === 'install') stage = await this.installations!.stage(instance, provider, prepared as import('../../contracts/plugins').AgentCliInstallPlan, check)
            const launch = stage ? stage.launch : { ...prepared as import('../../contracts/plugins').ProcessSpawnInput, terminal: { cols: 80, rows: 24 } }
            check()
            const terminal = await context.processes.spawn(launch)
            const exit = await control.consume(terminal)
            if (stage && exit.code === 0) await stage.verify(context)
            return exit
          }, authorize, this.options.logger, control.signal, stateDirectory, 600_000)
          check()
          // execute() has confirmed process cleanup. An installer can no longer mutate the selected files.
          if (stage && exit.code === 0) stage.publish()
          return exit
        } finally { if (!this.management.isBlocked(instanceId)) await stage?.discard() }
      }, () => {
        if (!this.management.isBlocked(instanceId)) { lease?.release(); this.configuring.delete(instanceId) }
      })
    } catch (error) { this.configuring.delete(instanceId); throw error }
  }

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
    if (!definition.management?.inspect) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not support native inspection')
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

  async updateInstance(scope: ExecutionScope, instanceId: string, value: AgentInstanceConfiguration, commit?: (instance: AgentInstance) => void): Promise<AgentInstance> {
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
      return { instance, ...resolved }
    }
    const previous = inspect()
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    this.configuring.add(instanceId)
    try {
      await this.disposeInstanceLeases(instanceId, 'Instance configuration changed')
      const current = inspect()
      if (JSON.stringify(current.provider) !== JSON.stringify(previous.provider)) throw new StudioError('REVISION_CONFLICT', 'Agent provider changed during configuration')
      const compatible = current.definition.capabilities.resumeConfigKeys
      const keys = new Set([...Object.keys(current.instance.config), ...Object.keys(input.config)])
      const preserve = compatible !== undefined && current.instance.mode === input.mode
        && [...keys].every(key => compatible.includes(key) || isDeepStrictEqual(current.instance.config[key], input.config[key]))
      return this.options.store.configureInstance(current.instance, input, preserve ? current.provider : undefined, commit)
    } finally { this.configuring.delete(instanceId) }
  }

  async setupInstance(scope: ExecutionScope, instanceId: string, revision: number, signal?: AbortSignal) {
    scope = jsonCopy(scope)
    if (!Number.isSafeInteger(revision) || revision < 1) throw new StudioError('INVALID_ARGUMENT', 'Configuration revision is required')
    const inspect = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
      this.options.authorize(scope)
      if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent management requires an unbound scope')
      const instance = this.options.store.instance(instanceId)
      if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
      if (instance.revision !== revision || this.queues.has(instanceId) || this.options.store.hasActiveRuns(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance changed or has active runs')
      return { instance, ...this.options.registry.resolve(scope.profileId, instance.agentTypeId) }
    }
    const { instance, provider, definition } = inspect(), adapter = definition.management?.setup
    if (!adapter) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent setup guidance is unavailable')
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    this.configuring.add(instanceId)
    const authorize = () => { if (!isDeepStrictEqual(inspect().provider, provider)) throw new StudioError('REVISION_CONFLICT', 'Agent provider changed during setup') }
    try {
      const input = { instanceId, config: instance.config, configRevision: revision, mode: instance.mode }
      const result = await this.management.execute(input, scope, provider, async context => parseAgentSetup(await adapter(input, context)), authorize, this.options.logger, signal)
      authorize()
      return { instanceId, configRevision: revision, provider, ...result }
    } finally { if (!this.management.isBlocked(instanceId)) this.configuring.delete(instanceId) }
  }

  async resourceLocations(scope: ExecutionScope, instanceId: string, revision: number, signal?: AbortSignal) {
    return this.withResourceLocations(scope, instanceId, revision, async locations => locations, signal)
  }

  async resourceFiles(scope: ExecutionScope, instanceId: string, revision: number, operation: ResourceFileOperation, snapshot?: string, signal?: AbortSignal) {
    operation = jsonCopy(operation)
    return this.withResourceLocations(scope, instanceId, revision, async (locations, authorize) => {
      const files = new AgentResourceFiles(locations, authorize)
      const currentSnapshot = createHash('sha256').update(JSON.stringify([locations, files.canonicalLocations()])).digest('hex')
      if (operation.action === 'list') return { ...locations, snapshot: currentSnapshot, files: await files.list() }
      if (snapshot !== currentSnapshot) throw new StudioError('REVISION_CONFLICT', 'Resource locations changed; reload before editing')
      if (operation.action === 'read') return { file: files.read(operation) }
      if (operation.action === 'review-skill' || operation.action === 'remove-skill') {
        if (operation.kind !== 'skills') throw new StudioError('INVALID_ARGUMENT', 'Skill operations require a Skill source')
        const skills = new AgentResourceSkills(files, authorize), ref = { locationId: operation.locationId, path: operation.path }
        if (operation.action === 'review-skill') return { skill: skills.review(ref) }
        skills.validateRemoval(ref, operation.etag)
        await this.disposeInstanceLeases(instanceId, 'Native Skill removed')
        authorize()
        return skills.remove(ref, operation.etag)
      }
      if (operation.action !== 'write') throw new StudioError('INVALID_ARGUMENT', 'Invalid resource operation')
      // A retained native runtime may cache configuration. Recreate it on the next Run.
      await this.disposeInstanceLeases(instanceId, 'Native resource edited')
      authorize()
      return { file: files.write(operation, operation.content, operation.etag) }
    }, signal)
  }

  authorizeResourceUpload(scope: ExecutionScope, instanceId: string): void {
    this.options.authorize(scope)
    if (this.closed || scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('FORBIDDEN', 'Resource upload requires an interactive instance scope')
    const instance = this.options.store.instance(instanceId)
    if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
  }

  async importSkill(scope: ExecutionScope, instanceId: string, revision: number, snapshot: string, locationId: string, values: ResourceSkillUpload[], signal?: AbortSignal) {
    this.authorizeResourceUpload(scope, instanceId)
    if (signal?.aborted) throw new StudioError('CANCELLED', 'Skill upload cancelled')
    const archive = parseSkillArchive(copySkillUploads(values))
    return this.withResourceLocations(scope, instanceId, revision, async (locations, authorize) => {
      const files = new AgentResourceFiles(locations, authorize)
      const currentSnapshot = createHash('sha256').update(JSON.stringify([locations, files.canonicalLocations()])).digest('hex')
      if (snapshot !== currentSnapshot) throw new StudioError('REVISION_CONFLICT', 'Resource locations changed; reload before importing')
      const skills = new AgentResourceSkills(files, authorize)
      skills.validateImport(locationId, archive.name)
      await this.disposeInstanceLeases(instanceId, 'Native Skill imported')
      authorize()
      return skills.import(locationId, archive)
    }, signal)
  }

  private async withResourceLocations<T>(scope: ExecutionScope, instanceId: string, revision: number,
    consume: (locations: import('../../contracts/plugins').AgentResourceLocations & { instanceId: string; configRevision: number; provider: AgentProviderRef }, authorize: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    scope = jsonCopy(scope)
    if (!Number.isSafeInteger(revision) || revision < 1) throw new StudioError('INVALID_ARGUMENT', 'Configuration revision is required')
    const inspect = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
      this.options.authorize(scope)
      if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent management requires an unbound scope')
      const instance = this.options.store.instance(instanceId)
      if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
      if (instance.revision !== revision || this.queues.has(instanceId) || this.options.store.hasActiveRuns(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance changed or has active runs')
      return { instance, ...this.options.registry.resolve(scope.profileId, instance.agentTypeId) }
    }
    const { instance, provider, definition } = inspect()
    const adapter = definition.management?.locations
    if (!adapter) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not expose native resources')
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    this.configuring.add(instanceId)
    const authorize = () => {
      const current = inspect()
      if (JSON.stringify(current.provider) !== JSON.stringify(provider)) throw new StudioError('REVISION_CONFLICT', 'Agent provider changed during management')
    }
    try {
      if (signal?.aborted) throw new StudioError('CANCELLED', 'Resource operation cancelled')
      const stateDirectory = this.options.stateRoot ? await agentStateDirectory(this.options.stateRoot, instance, provider,
        this.options.store.state.stateRevision(instance.id, provider, instance.revision)) : undefined
      authorize()
      const input = { instanceId, config: instance.config, configRevision: instance.revision, mode: instance.mode }
      return await this.management.execute(input, scope, provider, async context => {
        const locations = parseAgentResourceLocations(await adapter(input, context))
        const check = () => { if (context.signal.aborted) throw context.signal.reason; authorize() }
        check()
        return consume({ instanceId, configRevision: instance.revision, provider, ...locations }, check)
      }, authorize, this.options.logger, signal, stateDirectory)
    } finally { if (!this.management.isBlocked(instanceId)) this.configuring.delete(instanceId) }
  }

  /** target is supplied only by a trusted application adapter, never by Run input. */
  inspectStart(scope: ExecutionScope, instanceId: string, input: AgentRunInput, idempotencyKey: string, target?: AgentRunTarget): { instance: AgentInstance; previous: AgentExecution | null; provider?: AgentProviderRef } {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
    this.options.authorize(scope)
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) throw new StudioError('INVALID_ARGUMENT', 'An idempotency key is required')
    const instance = this.options.store.instance(instanceId)
    if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
    this.authorizeTarget(scope, instance, target)
    input = jsonCopy(input)
    scope = jsonCopy(scope)
    const previous = this.options.store.findRequest(instance, input, idempotencyKey, target)
    if (previous) return { instance, previous }
    if (this.configuring.has(instanceId)) throw new StudioError('REVISION_CONFLICT', 'Agent instance is being managed')
    const { definition, provider } = this.options.registry.resolve(scope.profileId, instance.agentTypeId)
    const nativeMcp = instance.config.studioMcp as { enabled?: boolean } | undefined
    if (nativeMcp?.enabled === true && (!definition.capabilities.nativeMcp || !this.options.nativeContext)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native Studio MCP is unavailable in this host')
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

  start(scope: ExecutionScope, instanceId: string, input: AgentRunInput, idempotencyKey: string, admission?: AgentAdmission, target?: AgentRunTarget): AgentExecution {
    const original = this.inspectStart(scope, instanceId, admission?.originalInput ?? input, idempotencyKey, target)
    if (original.previous) return original.previous
    const { instance, provider } = admission ? this.inspectStart(scope, instanceId, input, idempotencyKey, target) : original
    if (admission && (instance.revision !== admission.expectedRevision || JSON.stringify(provider) !== JSON.stringify(admission.expectedProvider))) {
      throw new StudioError('REVISION_CONFLICT', 'Agent configuration or provider changed during hooks')
    }
    input = jsonCopy(input); scope = jsonCopy({ ...scope, ...(target ? { sessionId: target.sessionId, surface: scope.surface === 'api' ? 'chat' as const : scope.surface } : {}) })
    const queue = this.queues.get(instance.id) || { pending: [] }
    if (this.active.size + this.leases.size >= 128 || queue.pending.length >= 32) throw new StudioError('RESOURCE_EXHAUSTED', 'Agent run queue is full')
    const accepted = this.options.store.accept(instance, provider!, input, idempotencyKey, admission, target, scope.surface)
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

  private authorizeTarget(scope: ExecutionScope, instance: AgentInstance, target?: AgentRunTarget): void {
    if (!target) {
      if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Independent instance runs require an unbound scope')
      return
    }
    if (this.frozenChats.has(target.sessionId)) throw new StudioError('REVISION_CONFLICT', 'Chat history is being changed')
    if (scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run and workspace bindings require a dedicated execution adapter')
    if (target.kind !== 'chat' || Object.keys(target).some(key => !['kind', 'sessionId', 'command'].includes(key))
      || typeof target.sessionId !== 'string' || !target.sessionId.trim() || target.sessionId.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent target')
    if (scope.sessionId !== undefined && scope.sessionId !== target.sessionId) throw new StudioError('FORBIDDEN', 'Chat is outside the execution scope')
    if (!this.options.authorizeChat) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat-bound Agent runs are unavailable')
    this.options.authorizeChat(scope, instance, target.sessionId)
  }

  get(scope: ExecutionScope, id: string): AgentExecution {
    this.options.authorize(scope)
    const run = this.options.store.get(id)
    if (!run || run.ownerId !== scope.principal.id || run.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Run is unavailable')
    if (scope.runId && scope.runId !== id) throw new StudioError('FORBIDDEN', 'Run is outside the execution scope')
    if (scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Workspace-bound Run access is unavailable')
    if (scope.sessionId !== undefined && scope.sessionId !== run.sessionId) throw new StudioError('FORBIDDEN', 'Run is outside the chat scope')
    if (run.sessionId) {
      const instance = this.options.store.instance(run.instanceId)
      if (!instance || !this.options.authorizeChat) throw new StudioError('RUNTIME_UNAVAILABLE', 'Chat-bound Agent is unavailable')
      this.options.authorizeChat(scope, instance, run.sessionId)
    }
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
  async waitForCleanup(scope: ExecutionScope, id: string): Promise<AgentExecution> {
    this.get(scope, id)
    await this.wait(id)
    const run = this.get(scope, id), lease = this.leases.get(run.conversationId ?? run.instanceId)
    // A queued Run never owned a native lease. A later Run may already use a
    // different lease in the same conversation; neither may be disposed here.
    if (lease && lease.id === this.options.store.state.leaseForRun(id) && lease.disposing) await lease.disposing
    return this.get(scope, id)
  }

  /** Trusted lifecycle port. Its caller authorizes the user mutation before
   * acquiring and immediately before applying it. SDK payloads cannot invoke it. */
  async freezeChat(sessionId: string): Promise<{ reset(): void; release(): void }> {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
    if (this.frozenChats.has(sessionId)) throw new StudioError('REVISION_CONFLICT', 'Chat history is being changed')
    this.frozenChats.add(sessionId)
    const runs = this.options.store.activeForChat(sessionId)
    for (const run of runs) this.stop(run.id)
    await Promise.all(runs.map(run => this.wait(run.id)))
    const conversations = this.options.store.conversations.forSession(sessionId)
    // A failed cleanup retains the barrier: a second native runtime must not
    // begin while the old one may still be writing this conversation.
    await Promise.all(conversations.map(id => this.disposeLease(id, 'Chat history changed')))
    let released = false
    return {
      reset: () => { if (released) throw new StudioError('REVISION_CONFLICT', 'Chat history lease ended'); for (const id of conversations) this.options.store.state.forgetCheckpoint(id) },
      release: () => { if (!released) { released = true; this.frozenChats.delete(sessionId) } },
    }
  }
  async close(): Promise<void> {
    this.closed = true
    const management = this.management.close()
    for (const id of [...this.active.keys()]) this.stop(id)
    await Promise.allSettled([management, this.managementOperations?.close(), ...[...this.active.values()].map(active => active.completed)])
    await Promise.allSettled([...this.leases.keys()].map(id => this.disposeLease(id, 'Host shutdown')))
  }

  private async disposeInstanceLeases(instanceId: string, reason: string): Promise<void> {
    const results = await Promise.allSettled([...this.leases].filter(([, lease]) => lease.instanceId === instanceId).map(([key]) => this.disposeLease(key, reason)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
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
        const results = await Promise.allSettled([lease.processes.close(), lease.mcp.close(), lease.nativeContext?.close(), lease.settling])
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
    const leaseKey = run.conversationId ?? instance.id
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
      const assertBinding = () => {
        this.options.authorize(scope)
        const current = this.options.store.instance(instance.id)
        if (!current || current.ownerId !== scope.principal.id || current.profileId !== scope.profileId || current.revision !== run.configRevision) throw new StudioError('REVISION_CONFLICT', 'Agent instance changed before dispatch')
        this.authorizeTarget(scope, current, run.sessionId ? { kind: 'chat', sessionId: run.sessionId } : undefined)
        const resolved = this.options.registry.resolve(scope.profileId, instance.agentTypeId)
        if (JSON.stringify(resolved.provider) !== JSON.stringify(run.provider)) throw new StudioError('REVISION_CONFLICT', 'Agent provider changed before dispatch')
        return resolved
      }
      const assertDispatch = () => { this.options.validateInput?.(scope, input); return assertBinding() }
      const resolved = assertDispatch()
      this.options.store.transition(run.id, ['accepted', 'queued'], 'starting')
      // An instance-wide management/failed cleanup must finish before another
      // conversation may create a native runtime. Accepted Runs still get a
      // durable terminal receipt if that cleanup cannot be confirmed.
      const disposals = [...this.leases.values()].filter(lease => lease.instanceId === instance.id && lease.disposing).map(lease => lease.disposing)
      if (disposals.length) await Promise.race([Promise.all(disposals), aborted])
      let lease = this.leases.get(leaseKey)
      if (lease && (lease.disposing || lease.definition !== resolved.definition || lease.surface !== scope.surface || lease.revision !== run.configRevision || JSON.stringify(lease.provider) !== JSON.stringify(run.provider))) {
        await this.disposeLease(leaseKey, 'Provider, configuration or execution surface changed')
        lease = undefined
      }
      if (lease?.idleTimer) clearTimeout(lease.idleTimer)
      if (active.controller.signal.aborted) { this.finish(run.id, active.expired ? 'interrupted' : 'cancelled', active.expired ? 'DEADLINE_EXCEEDED' : null); return }
      assertDispatch()
      if (!lease) {
        const controller = new AbortController()
        const id = this.options.store.state.openLease(instance.id, run.provider, run.configRevision)
        const resume = resolved.definition.capabilities.resume ? this.options.store.state.checkpoint(leaseKey, run.provider, run.configRevision) : undefined
        const processes = new ManagedProcessScope(controller.signal, () => { assertBinding() })
        const mcp = new ManagedMcpScope(controller.signal, () => { assertBinding() })
        // Install the lease before invoking user code, including factories that
        // start a process and then throw synchronously.
        const creating = Promise.resolve().then(async () => {
          if (resolved.definition.capabilities.nativeMcp) pending.nativeContext = this.options.nativeContext?.(instance, scope, run.provider, controller.signal)
          const stateDirectory = this.options.stateRoot ? await agentStateDirectory(this.options.stateRoot, instance, run.provider,
            this.options.store.state.stateRevision(instance.id, run.provider, instance.revision)) : undefined
          assertDispatch()
          const runtimeContext = {
            ...(this.installations ? { nativeCli: this.installations.load(instance, run.provider) } : {}),
            ...(stateDirectory ? { stateDirectory } : {}), provider: run.provider, runtimeSessionId: id, profileId: scope.profileId, ownerId: scope.principal.id, signal: controller.signal, logger: this.options.logger, processes: processes.api, mcp: mcp.api,
          }
          if (run.sessionId && scope.surface === 'chat') bindRuntimeCommandTarget(runtimeContext, {
            ownerId: scope.principal.id, sessionId: run.sessionId, instanceId: instance.id, instanceRevision: instance.revision,
          }, () => { assertBinding() })
          return resolved.definition.create({ instanceId: instance.id, config: instance.config, configRevision: instance.revision, mode: instance.mode,
            ...(resume === undefined ? {} : { resume }) }, runtimeContext)
        })
        lease = { id, instanceId: instance.id, definition: resolved.definition, surface: scope.surface, provider: run.provider, revision: run.configRevision, controller, runtime: creating, creating: true, processes, mcp }
        this.leases.set(leaseKey, lease)
        const pending = lease
        void creating.then(() => { pending.creating = false }, () => { pending.creating = false })
      }
      this.options.store.state.bindLease(run.id, lease.id)
      const runtime = await Promise.race([lease.runtime, aborted])
      if (active.controller.signal.aborted) { this.finish(run.id, active.expired ? 'interrupted' : 'cancelled', active.expired ? 'DEADLINE_EXCEEDED' : null); return }
      assertDispatch()
      const context = this.options.context({ ...scope, runId: run.id }, active.controller.signal)
      const nativeContext = await Promise.race([lease.nativeContext?.prepare(run.id, active.controller.signal), aborted])
      assertDispatch()
      const runContext: AgentRunContext = { ...context, scope: { ...context.scope, runId: run.id, runtimeSessionId: lease.id }, ...(nativeContext ? { nativeContext } : {}) }
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
            this.get(scope, run.id)
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
        await Promise.race([lease.nativeContext?.end(), aborted])
        if (result.checkpoint !== undefined) checkpoint = jsonCopy(result.checkpoint)
        if (checkpoint === undefined && resolved.definition.capabilities.resume && runtime.checkpoint) {
          checkpoint = jsonCopy(await Promise.race([runtime.checkpoint(), aborted]))
        }
        this.get(scope, run.id)
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
      const lease = this.leases.get(leaseKey)
      try { await lease?.nativeContext?.end() } catch { retain = false }
      if (lease && !lease.disposing) lease.settling = settle()
      try { await settle() } catch { retain = false }
      const dispose = (reason: string) => this.disposeLease(leaseKey, reason)
        .catch(() => { this.options.logger.warn('Agent runtime disposal is unconfirmed', { instanceId: instance.id }) })
      if (!retain) {
        const creating = this.leases.get(leaseKey)?.creating
        const cleanup = dispose('Run ended')
        // Cancellation already waited for this factory. Keep its lease occupied,
        // but report the finished Run without waiting through a second timeout.
        if (!creating) await cleanup
      }
      else {
        const lease = this.leases.get(leaseKey)!
        lease.idleTimer = setTimeout(() => { void dispose('Idle runtime expired') }, 60_000)
        lease.idleTimer.unref()
      }
    }
  }
}
