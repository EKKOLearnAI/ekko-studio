import { randomUUID } from 'node:crypto'
import {
  StudioError, type EventEnvelope, type ExecutionContext, type JsonObject, type JsonValue,
  type ScopedLogger, type StudioEventMap, type Disposer, type ExecutionScope, type ServiceDependency, type AgentProviderRef,
} from '../../contracts/plugins'
import { SYSTEM_CODING_PLUGINS, isSystemPluginId } from '../../contracts/system-plugins'
import { PluginStore, type PluginInstallation, type PluginState } from '../../repositories/plugin-store'
import { AgentRegistry } from '../agents/registry'
import { PluginEventBus } from '../events/plugin-events'
import { inspectPluginArtifact, stagePluginArtifact } from './artifacts'
import { compileSchema, jsonCopy, parseManifest, toJson } from './validation'
import { ResourceScope } from './resources'
import { PluginWorker } from './worker'
import { pluginActivationOrder, requiredServiceDependents } from './dependencies'
import { PluginServiceRegistry } from './services'
import { PluginCommandRegistry } from './commands'
import { ReliablePluginConsumers } from '../events/reliable-consumers'
import { parseConsumerSpec } from '../../repositories/plugin-consumer-store'
import { PluginHookRegistry } from '../events/plugin-hooks'

interface ActivePlugin { worker: PluginWorker; resources: ResourceScope; generation: string; withdraw(): EventEnvelope[] }
export interface PluginHostOptions {
  store: PluginStore
  registry: AgentRegistry
  events: PluginEventBus
  consumers?: ReliablePluginConsumers
  hooks?: PluginHookRegistry
  artifactsRoot: string
  runnerPath: string
  logger: ScopedLogger
  eventContext(state: PluginState, event: EventEnvelope, signal: AbortSignal): Promise<ExecutionContext>
  context(scope: ExecutionScope, signal: AbortSignal): ExecutionContext
  acceptEvents(events: EventEnvelope[]): Promise<void>
}

const CORE_EVENTS: Array<keyof StudioEventMap> = [
  'plugin.ready', 'plugin.disabled', 'plugin.failed', 'agent.available', 'agent.unavailable',
  'service.available', 'service.unavailable',
  'run.completed', 'run.failed', 'run.cancelled', 'session.deleted',
]
const SUPPORTED_CAPABILITIES = new Set([
  'workflows.run', 'workflows.read', 'workflows.cancel',
  'commands.register', 'agents.register', 'agents.read', 'sessions.read', 'sessions.remove', 'runs.read', 'runs.start', 'runs.cancel', 'runs.respond', 'chat.start', 'chat.read', 'chat.cancel',
  ...CORE_EVENTS.map(name => `events.subscribe:${name}`),
  ...CORE_EVENTS.map(name => `events.consume:${name}`),
  'hooks.before:runs.start', 'hooks.before:sessions.remove',
  'processes.spawn', 'mcp.connect', 'mcp.studio',
  'models.read', 'models.stream', 'models.gateway', 'artifacts.read',
])

export class PluginHost {
  readonly commands = new PluginCommandRegistry()
  private readonly active = new Map<string, ActivePlugin>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly services = new PluginServiceRegistry()
  private readonly cleanups = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly options: PluginHostOptions) {}

  list(): PluginInstallation[] { return this.options.store.list() }

  authorizeNativeMcp(provider: AgentProviderRef, _profileId: string): void {
    if (provider.kind === 'builtin') return
    const active = this.active.get(provider.pluginId)
    if (this.closed || !active || active.generation !== provider.generation) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin activation is unavailable')
    active.worker.authorizeNativeMcp()
  }

  leaseManagement(provider: AgentProviderRef, _profileId: string, cancel: () => void, completed: Promise<void>) {
    if (provider.kind === 'builtin') return { authorize() {}, release() {} }
    const active = this.active.get(provider.pluginId)
    if (this.closed || !active || active.generation !== provider.generation) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin activation is unavailable')
    return active.worker.leaseManagement(cancel, completed)
  }

  diagnostic(pluginId: string, _legacyProfileId?: string) {
    const installation = this.requireInstallation(pluginId), profile = this.options.store.state(pluginId)
    const saved = this.options.store.diagnostic(pluginId), active = this.active.get(pluginId)
    const current = saved?.configurationRevision === (profile?.revision || 0) ? saved : null
    const state = !profile?.enabled ? current?.state === 'blocked' ? 'blocked' : 'disabled' : active ? 'ready' : current?.state === 'ready' ? 'inactive' : current?.state || 'inactive'
    return { pluginId, generation: installation.generation, configurationRevision: profile?.revision || 0,
      state, errorCode: state === 'blocked' || state === 'failed' ? current?.errorCode || null : null,
      updatedAt: current?.updatedAt || null, hasActiveLeases: !!active?.worker.hasLeases() }
  }

  install(source: string): Promise<PluginInstallation> {
    return this.serial('install', async () => {
      const inspected = await inspectPluginArtifact(source)
      if (isSystemPluginId(inspected.manifest.id)) throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'Cannot replace a system plugin')
      this.validateDeclarations(inspected.manifest)
      if (this.options.store.get(inspected.manifest.id)) throw new StudioError('REVISION_CONFLICT', 'Plugin is already installed')
      const staged = await stagePluginArtifact(source, this.options.artifactsRoot)
      this.validateDeclarations(staged.manifest)
      if (staged.manifest.id !== inspected.manifest.id) throw new StudioError('INVALID_ARGUMENT', 'Plugin identity changed during installation')
      return this.options.store.installUser({ id: staged.manifest.id, ...staged })
    })
  }

  async registerSystemArtifact(source: string, expectedId?: string, authorize?: () => void): Promise<PluginInstallation> {
    if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin host is shutting down')
    const inspected = await inspectPluginArtifact(source)
    this.validateDeclarations(inspected.manifest)
    if (!isSystemPluginId(inspected.manifest.id)) throw new StudioError('INVALID_ARGUMENT', 'Not a system plugin')
    if (expectedId !== undefined && inspected.manifest.id !== expectedId) throw new StudioError('PLUGIN_UNAVAILABLE', 'Bundled Agent artifact identity does not match')
    authorize?.()
    if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin host is shutting down')
    return this.options.store.registerSystem({ id: inspected.manifest.id, manifest: inspected.manifest,
      generation: `${inspected.manifest.version}-${inspected.digest}`, artifactPath: source })
  }

  configure(input: Omit<PluginState, 'revision'> & { profileId?: string; ownerId?: string }, expectedRevision: number, authorize?: () => void): Promise<PluginState> {
    return this.serial(input.pluginId, async () => {
      const installation = this.requireInstallation(input.pluginId)
      compileSchema(installation.manifest.configSchema ?? { type: 'object', additionalProperties: false })(input.config)
      if (input.grants.some(grant => !installation.manifest.requires.capabilities.includes(grant))) throw new StudioError('INVALID_ARGUMENT', 'Grant was not declared by plugin')
      const active = this.active.get(input.pluginId)
      if (active?.worker.hasLeases()) throw new StudioError('REVISION_CONFLICT', 'Drain Agent sessions before changing plugin configuration')
      if (active && requiredServiceDependents(this.options.store, input.pluginId).some(state => this.active.has(state.pluginId))) {
        throw new StudioError('REVISION_CONFLICT', 'Disable dependent plugins before changing their service provider')
      }
      // Compare and persist before stopping any healthy activation.
      authorize?.()
      const wasEnabled = this.options.store.state(input.pluginId)?.enabled
      const state = this.options.store.saveState(jsonCopy(input), expectedRevision)
      await this.stop(input.pluginId, wasEnabled && !state.enabled ? 'disabled' : undefined)
      if (state.enabled) await this.activateState(installation, state)
      return state
    })
  }

  activate(pluginId: string, _legacyProfileId?: string): Promise<void> {
    return this.serial(pluginId, async () => {
      const state = this.options.store.state(pluginId)
      if (!state?.enabled) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin is not enabled')
      if (this.active.has(pluginId)) return
      await this.activateState(this.requireInstallation(pluginId), state)
    })
  }

  uninstall(pluginId: string): Promise<void> {
    // Check protection before scheduling or touching workers, profiles or files.
    this.options.store.assertRemovable(pluginId)
    return this.serial(pluginId, async () => {
      this.options.store.assertRemovable(pluginId)
      if (requiredServiceDependents(this.options.store, pluginId).length) throw new StudioError('REVISION_CONFLICT', 'Plugin is required by enabled service consumers')
      const active = this.active.get(pluginId)
      if (active?.worker.hasLeases()) throw new StudioError('REVISION_CONFLICT', 'Plugin still has active runtime leases')
      await this.stop(pluginId, 'disabled')
      this.options.store.remove(pluginId)
    })
  }

  async restore(): Promise<void> {
    for (const state of this.options.store.enabled()) {
      if (!this.options.store.get(state.pluginId)) continue
      try { await this.activate(state.pluginId) }
      catch { this.options.logger.warn('Plugin activation failed', { pluginId: state.pluginId }) }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.operations.values()])
    const active = [...this.active.values()]
    for (const state of this.options.store.enabled()) {
      if (this.active.has(state.pluginId)) this.options.store.recordDiagnostic(state.pluginId, 'inactive')
    }
    this.active.clear()
    // Shutdown withdraws the process-local directory, without announcing a profile disable.
    for (const entry of active) entry.withdraw()
    await Promise.all(active.map(entry => entry.resources.close()))
    await Promise.allSettled([...this.cleanups])
  }

  private async activateState(installation: PluginInstallation, state: PluginState): Promise<void> {
    this.options.store.recordDiagnostic(installation.id, 'activating')
    try {
      const order = pluginActivationOrder(this.options.store, installation.id)
      for (const id of order) if (id !== installation.id) await this.activate(id)
      await this.activateWorker(installation, state)
    } catch (error) {
      const code = error instanceof StudioError ? error.code : 'INTERNAL'
      this.options.store.recordDiagnostic(installation.id,
        ['FORBIDDEN', 'PLUGIN_UNAVAILABLE', 'PLUGIN_VERSION_INCOMPATIBLE', 'REGISTRATION_CONFLICT'].includes(code) ? 'blocked' : 'failed', code)
      await this.notifyFailure(installation)
      throw error
    }
  }

  private async activateWorker(installation: PluginInstallation, state: PluginState): Promise<void> {
    const manifest = parseManifest(installation.manifest)
    this.validateDeclarations(manifest)
    if (manifest.requires.capabilities.some(capability => !state.grants.includes(capability))) throw new StudioError('FORBIDDEN', 'Plugin capabilities have not been granted')
    compileSchema(manifest.configSchema ?? { type: 'object', additionalProperties: false })(state.config)
    const artifact = await inspectPluginArtifact(installation.artifactPath)
    if (`${artifact.manifest.version}-${artifact.digest}` !== installation.generation || artifact.manifest.id !== installation.id) {
      throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin artifact integrity check failed')
    }
    const key = installation.id
    const resources = new ResourceScope(() => this.options.logger.warn('Plugin resource cleanup failed', { pluginId: installation.id }))
    const provider = { kind: 'plugin' as const, pluginId: installation.id, version: manifest.version, generation: installation.generation }
    const registration = this.options.registry.stage('*', provider, manifest.contributes.agents)
    const authorize = (capability: string): void => {
      if (resources.signal.aborted) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin activation ended')
      const latest = this.options.store.state(installation.id)
      if (!latest?.enabled || !latest.grants.includes(capability) || !manifest.requires.capabilities.includes(capability)) throw new StudioError('FORBIDDEN', 'Plugin capability is not granted')
    }
    let worker: PluginWorker
    worker = new PluginWorker(this.options.runnerPath, this.options.logger, () => {
      const active = this.active.get(key)
      if (active?.worker === worker) {
        this.active.delete(key)
        this.options.store.recordDiagnostic(installation.id, 'failed', 'PLUGIN_UNAVAILABLE')
        const withdrawn = active.withdraw()
        this.trackCleanup(resources.close())
        this.trackCleanup(this.invalidateDependents(installation.id))
        this.trackCleanup(this.options.acceptEvents([...withdrawn, this.lifecycleEvent('plugin.failed', installation)]))
        return
      }
      this.trackCleanup(resources.close())
    }, authorize)
    resources.add(() => worker.close())
    resources.add(() => registration.dispose())
    const commandRegistration = this.commands.stage('*', provider, manifest.contributes.commands || [], manifest.contributes.agents,
      async (id, input, ctx) => {
        authorize('commands.register')
        await worker.invokeCommand(id, input, { ...this.options.context(ctx.scope, AbortSignal.any([ctx.signal, resources.signal])), session: ctx.session, reply: ctx.reply })
        authorize('commands.register')
      }, () => authorize('commands.register'))
    resources.add(() => commandRegistration.dispose())
    worker.peer.handle('command.remove', value => {
      if (worker.isExecutingHook()) throw new StudioError('FORBIDDEN', 'Hook cannot alter contributions')
      const params = value as JsonObject
      authorize('commands.register')
      if (!params || Object.keys(params).some(key => key !== 'id') || typeof params.id !== 'string' || !manifest.contributes.commands?.includes(params.id)) throw new StudioError('FORBIDDEN', 'Undeclared command')
      commandRegistration.remove(params.id); return null
    })
    const serviceRegistration = this.services.stage('*', manifest.contributes.services || [], async (id, ctx, method, input, authority) => {
      authorize(`services.provide:${id}`)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new StudioError('DEADLINE_EXCEEDED', 'Service deadline exceeded')), 5_000)
      const forwarded = this.options.context(ctx.scope, AbortSignal.any([ctx.signal, resources.signal, controller.signal]))
      try { return await worker.invokeService(id, method, input, forwarded, authority) }
      finally { clearTimeout(timer); controller.abort() }
    }, () => {
      const current = this.options.store.state(installation.id)
      return !this.closed && this.active.get(key)?.worker === worker && !!current?.enabled && manifest.requires.capabilities.every(capability => current.grants.includes(capability))
    })
    resources.add(() => serviceRegistration.dispose())
    const dependency = (value: JsonValue): ServiceDependency => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'version', 'optional'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid service dependency')
      const declared = manifest.requires.services?.find(item => item.id === value.id && item.version === value.version)
      if (!declared) throw new StudioError('FORBIDDEN', 'Service dependency was not declared')
      authorize(`services.use:${declared.id}`)
      return declared
    }
    worker.peer.handle('service.status', value => {
      const params = value as JsonObject
      if (!params || Object.keys(params).some(key => key !== 'dependency')) throw new StudioError('INVALID_ARGUMENT', 'Invalid service status request')
      return toJson(this.services.status('*', dependency(params.dependency)))
    })
    worker.callService = async (ctx, args, authority) => {
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.method !== 'string'
        || Object.keys(args).some(key => !['dependency', 'method', 'input'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid service call')
      const target = dependency(args.dependency)
      authority(`services.use:${target.id}`)
      return this.services.call(ctx, target, args.method, args.input, authority)
    }
    const providedServices = new Map<string, { id: string; version: string }>()
    const serviceEvent = (type: 'service.available' | 'service.unavailable', service: { id: string; version: string }) =>
      this.event(type, { pluginId: manifest.id }, { serviceId: service.id, version: service.version })
    worker.peer.handle('service.remove', async value => {
      if (worker.isExecutingHook()) throw new StudioError('FORBIDDEN', 'Hook cannot alter contributions')
      const id = String((value as JsonObject).id)
      if (!manifest.contributes.services?.some(token => token.id === id)) throw new StudioError('FORBIDDEN', 'Service was not provided by this plugin')
      serviceRegistration.remove(id)
      const service = providedServices.get(id)
      providedServices.delete(id)
      if (service) {
        this.trackCleanup(this.invalidateDependents(installation.id))
        await this.options.acceptEvents([serviceEvent('service.unavailable', service)])
      }
      return null
    })
    const removers = new Map<string, Disposer>()
    const subscriptions = new Map<string, Disposer>()
    const consumers = new Map<string, Disposer>()
    const hooks = new Map<string, Disposer>()
    const pendingEvents: EventEnvelope[] = []
    let committed = false
    const agentEvent = (type: 'agent.available' | 'agent.unavailable', agentTypeId: string) =>
      this.event(type, { pluginId: manifest.id, agentTypeId }, { agentTypeId })
    const withdraw = (): EventEnvelope[] => {
      const events = [...removers.keys()].map(id => agentEvent('agent.unavailable', id))
      events.push(...[...providedServices.values()].map(service => serviceEvent('service.unavailable', service)))
      removers.clear(); providedServices.clear()
      registration.dispose(); serviceRegistration.dispose(); commandRegistration.dispose()
      return events
    }
    worker.peer.handle('agent.remove', async value => {
      if (worker.isExecutingHook()) throw new StudioError('FORBIDDEN', 'Hook cannot alter contributions')
      const id = String((value as JsonObject).id), dispose = removers.get(id)
      if (dispose) {
        removers.delete(id)
        await dispose()
        if (committed) await this.options.acceptEvents([agentEvent('agent.unavailable', id)])
      }
      return null
    })
    worker.peer.handle('subscription.remove', value => { if (worker.isExecutingHook()) throw new StudioError('FORBIDDEN', 'Hook cannot alter contributions'); const dispose = subscriptions.get(String((value as JsonObject).id)); if (dispose) void dispose(); return null })
    worker.peer.handle('consumer.remove', async value => { if (worker.isExecutingHook()) throw new StudioError('FORBIDDEN', 'Hook cannot alter contributions'); await consumers.get(String((value as JsonObject).name))?.(); return null })
    worker.peer.handle('hook.remove', async value => { if (worker.isExecutingHook()) throw new StudioError('FORBIDDEN', 'Hook cannot alter contributions'); await hooks.get(String((value as JsonObject).key))?.(); return null })
    worker.peer.handle('event.emit', async value => {
      const { type, data, scopeHandle } = value as JsonObject
      if (typeof type !== 'string' || !Object.hasOwn(manifest.contributes.events || {}, type)) throw new StudioError('FORBIDDEN', 'Undeclared plugin event')
      worker.authorizeEmission(scopeHandle, type)
      authorize(`events.emit:${type}`)
      compileSchema(manifest.contributes.events![type])(data)
      const event = this.event(type, { pluginId: manifest.id }, data as JsonObject)
      if (!committed) {
        if (pendingEvents.length >= 128) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many activation events')
        pendingEvents.push(event)
      } else await this.options.acceptEvents([event])
      return { id: event.id }
    })
    try {
      const activated = await worker.activate(artifact.entry, { id: manifest.id, version: manifest.version, generation: installation.generation }, state.config)
      for (const service of activated.services) authorize(`services.provide:${service.id}`)
      serviceRegistration.validate(activated.services)
      if (activated.commands.length) authorize('commands.register')
      commandRegistration.validate(activated.commands)
      if (activated.agents.length) authorize('agents.register')
      for (const meta of activated.agents) removers.set(meta.id, registration.register(worker.definition(meta,
        manifest.contributes.runtimeCommands?.includes(meta.id) ? this.commands : undefined)))
      const stagedSubscriptions: Array<() => void> = []
      for (const subscription of activated.subscriptions) {
        if (typeof subscription.id !== 'string' || !CORE_EVENTS.includes(subscription.type as keyof StudioEventMap) || typeof subscription.once !== 'boolean') throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin subscription')
        const capability = `events.subscribe:${subscription.type}`
        authorize(capability)
        stagedSubscriptions.push(() => {
          const dispose = this.options.events.subscribe(subscription.type as keyof StudioEventMap, {
            context: async (event, signal) => {
              authorize(capability)
              return this.options.eventContext(state, event, signal)
            },
          }, async (event, ctx) => worker.withContext(ctx, async scopeHandle => {
            await worker.peer.request('event.deliver', toJson({ id: subscription.id, event, scope: ctx.scope, scopeHandle }))
          }), subscription.once)
          subscriptions.set(subscription.id, resources.add(dispose))
        })
      }
      if (!Array.isArray(activated.consumers) || activated.consumers.length > 32) throw new StudioError('INVALID_ARGUMENT', 'Invalid consumer registrations')
      if (activated.consumers.length && !this.options.consumers) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Reliable consumers are unavailable')
      const names = new Set<string>()
      const stagedConsumers = activated.consumers.map(({ name, spec: input }) => {
        if (typeof name !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(name) || names.has(name)) throw new StudioError('INVALID_ARGUMENT', 'Invalid or duplicate consumer name')
        names.add(name)
        const spec = parseConsumerSpec(input)
        for (const type of spec.types) {
          if (!CORE_EVENTS.includes(type as keyof StudioEventMap)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported reliable event type')
          authorize(`events.consume:${type}`)
        }
        return { identity: { pluginId: manifest.id, name }, spec }
      })
      if (activated.hooks.length && !this.options.hooks) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Hooks are unavailable')
      const stagedHooks = this.options.hooks?.validate('*', manifest.id, activated.hooks) || []
      for (const hook of stagedHooks) authorize(`hooks.before:${hook.point}`)
      if (resources.signal.aborted) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin exited during activation')
      for (const required of manifest.requires.services || []) {
        if (!required.optional && !this.services.status('*', required).available) throw new StudioError('PLUGIN_UNAVAILABLE', 'Required service disappeared during activation')
      }
      registration.validate()
      const registeredConsumers = this.options.consumers?.store.registerMany(stagedConsumers) || []
      registration.commit()
      serviceRegistration.commit()
      commandRegistration.commit()
      for (const service of activated.services) providedServices.set(service.id, service)
      stagedSubscriptions.forEach(subscribe => subscribe())
      for (const consumer of registeredConsumers) {
        const dispose = this.options.consumers!.mount(consumer, {
          context: async (event, signal) => {
            authorize(`events.consume:${event.type}`)
            return this.options.eventContext(state, event, signal)
          },
          deliver: (event, ctx) => worker.deliverConsumer(consumer.name, event, ctx),
          deadline: () => worker.close(),
          available: () => worker.isAvailable(),
        })
        consumers.set(consumer.name, resources.add(dispose))
      }
      for (const hook of stagedHooks) {
        const dispose = this.options.hooks!.register('*', manifest.id, installation.generation, hook, async (input, ctx) => {
          authorize(`hooks.before:${hook.point}`)
          const result = await worker.invokeHook(hook, input, this.options.context(ctx.scope, AbortSignal.any([ctx.signal, resources.signal])))
          authorize(`hooks.before:${hook.point}`)
          return result
        })
        hooks.set(JSON.stringify([hook.point, hook.options.key]), resources.add(dispose))
      }
      this.active.set(key, { worker, resources, generation: installation.generation, withdraw })
      this.options.store.recordDiagnostic(installation.id, 'ready')
      committed = true
      await this.options.acceptEvents([...pendingEvents, this.lifecycleEvent('plugin.ready', installation),
        ...[...removers.keys()].map(id => agentEvent('agent.available', id)),
        ...[...providedServices.values()].map(service => serviceEvent('service.available', service))])
    } catch (error) {
      if (this.active.get(key)?.worker === worker) this.active.delete(key)
      const withdrawn = withdraw()
      await resources.close()
      if (committed) await this.options.acceptEvents(withdrawn).catch(() => this.options.logger.warn('Plugin withdrawal notification failed'))
      throw error
    }
  }

  private lifecycleEvent(type: 'plugin.ready' | 'plugin.disabled' | 'plugin.failed', installation: PluginInstallation): EventEnvelope {
    return this.event(type, { pluginId: installation.id }, { pluginId: installation.id, generation: installation.generation })
  }

  private async notifyFailure(installation: PluginInstallation): Promise<void> {
    try { await this.options.acceptEvents([this.lifecycleEvent('plugin.failed', installation)]) }
    catch { this.options.logger.warn('Plugin failure notification failed', { pluginId: installation.id }) }
  }

  private event(type: string, subject: EventEnvelope['subject'], data: JsonObject): EventEnvelope {
    const id = randomUUID()
    return { schemaVersion: 1, id, type, occurredAt: Date.now(), partitionKey: `plugin:${subject.pluginId}`, sequence: 0, subject, data, correlationId: id }
  }

  private validateDeclarations(manifest: PluginInstallation['manifest']): void {
    const system = SYSTEM_CODING_PLUGINS.find(plugin => plugin.pluginId === manifest.id)
    if (system && (manifest.contributes.agents.length !== 1 || manifest.contributes.agents[0] !== system.agentTypeId)) throw new StudioError('INVALID_ARGUMENT', 'System plugin must provide its distributed Agent type')
    for (const id of manifest.contributes.agents) {
      if (system ? id !== system.agentTypeId : !id.startsWith(`${manifest.id}/`)) throw new StudioError('FORBIDDEN', 'Agent type is outside the plugin namespace')
    }
    for (const capability of manifest.requires.capabilities) {
      if (SUPPORTED_CAPABILITIES.has(capability)) continue
      if (capability.startsWith('events.emit:') && Object.hasOwn(manifest.contributes.events || {}, capability.slice('events.emit:'.length))) continue
      if (capability.startsWith('services.provide:') && manifest.contributes.services?.some(service => capability === `services.provide:${service.id}`)) continue
      if (capability.startsWith('services.use:') && manifest.requires.services?.some(service => capability === `services.use:${service.id}`)) continue
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Plugin requests an unsupported capability')
    }
  }

  private requireInstallation(id: string): PluginInstallation {
    const installation = this.options.store.get(id)
    if (!installation) throw new StudioError('NOT_FOUND', 'Plugin is not installed')
    return installation
  }

  private async invalidateDependents(pluginId: string): Promise<void> {
    await Promise.all(requiredServiceDependents(this.options.store, pluginId).map(async dependent => {
      if (!this.active.has(dependent.pluginId)) return
      const requirements = this.options.store.get(dependent.pluginId)?.manifest.requires.services || []
      if (requirements.every(service => service.optional || this.services.status('*', service).available)) return
      const stopped = this.stop(dependent.pluginId, 'dependency')
      await Promise.all([stopped, this.invalidateDependents(dependent.pluginId)])
    }))
  }

  private trackCleanup(pending: Promise<void>): void {
    this.cleanups.add(pending)
    void pending.catch(() => this.options.logger.warn('Plugin dependency cleanup failed'))
      .finally(() => this.cleanups.delete(pending))
  }

  private async stop(pluginId: string, reason?: 'disabled' | 'dependency'): Promise<void> {
    const key = pluginId, active = this.active.get(key)
    this.options.store.recordDiagnostic(pluginId, reason === 'dependency' ? 'blocked' : reason === 'disabled' ? 'disabled'
      : this.options.store.state(pluginId)?.enabled ? 'inactive' : 'disabled', reason === 'dependency' ? 'PLUGIN_UNAVAILABLE' : undefined)
    this.active.delete(key)
    const withdrawn = active?.withdraw() || []
    const closing = active?.resources.close()
    if (reason) withdrawn.push(this.lifecycleEvent(reason === 'disabled' ? 'plugin.disabled' : 'plugin.failed', this.requireInstallation(pluginId)))
    try { if (withdrawn.length) await this.options.acceptEvents(withdrawn) }
    finally { await closing }
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StudioError('PLUGIN_UNAVAILABLE', 'Plugin host is closed'))
    const previous = this.operations.get(key) || Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    this.operations.set(key, pending)
    void pending.finally(() => { if (this.operations.get(key) === pending) this.operations.delete(key) }).catch(() => {})
    return pending
  }
}
