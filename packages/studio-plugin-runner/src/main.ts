import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { remoteMcp } from './mcp'
import { remoteProcesses } from './processes'
import { remoteModels } from './models'
import { RpcPeer, type RpcFrame } from '../../studio-plugin-sdk/src/rpc'
import {
  StudioError, serializeStudioError, STUDIO_PLUGIN_RPC_VERSION,
  type AgentTypeDefinition, type AgentRuntime, type AgentRuntimeContext, type AgentRunHandle,
  type AgentRunContext, type ExecutionContext, type ExecutionScope, type PluginIdentity,
  type JsonObject, type JsonValue, type PluginContext, type StudioPlugin, type Disposer,
  type ScopedLogger, type RuntimeCreateInput, type AgentRunInput, type AgentProviderRef, type EventEnvelope,
  type ServiceToken, type ServiceImplementation, type EventConsumerSpec, type ReliableEventHandler,
  type HookPoint, type HookOptions, type HookHandler, type HookContext,
  type CommandDefinition, type CommandHandler, type CommandInput, type CommandContext,
} from '../../studio-plugin-sdk/src'

const peer = new RpcPeer({ send: frame => new Promise((resolve, reject) => {
  if (!process.connected || !process.send) { reject(new StudioError('PLUGIN_UNAVAILABLE', 'Host disconnected')); return }
  process.send(frame, error => error ? reject(error) : resolve())
}) })
const definitions = new Map<string, AgentTypeDefinition>()
const managementCalls = new Map<string, AbortController>()
const runtimes = new Map<string, { runtime: AgentRuntime; controller: AbortController; handle: string }>()
const runs = new Map<string, { handle: AgentRunHandle; controller: AbortController }>()
const callbacks = new Map<string, { type: string; once: boolean; handler: (event: EventEnvelope, ctx: ExecutionContext) => void | Promise<void> }>()
const services = new Map<string, { token: ServiceToken; implementation: ServiceImplementation }>()
const serviceCalls = new Map<string, AbortController>()
const commands = new Map<string, { definition: CommandDefinition; handler: CommandHandler }>()
const runtimeCommands = new Map<string, Map<string, { definition: CommandDefinition; handler: CommandHandler }>>()
const commandCalls = new Map<string, AbortController>()
const consumers = new Map<string, { spec: EventConsumerSpec; handler: ReliableEventHandler }>()
const deliveries = new Map<string, AbortController>()
const contextHandles = new WeakMap<object, string>()
const hooks = new Map<string, { point: HookPoint; options: HookOptions; handler: HookHandler<HookPoint> }>()
const hookCalls = new Map<string, AbortController>()
const hookScope = new AsyncLocalStorage<boolean>()
const callbackScope = new AsyncLocalStorage<string>()
const runtimeScope = new AsyncLocalStorage<string>()
const assertContributionMutation = () => { if (hookScope.getStore()) throw new StudioError('FORBIDDEN', 'Hooks cannot mutate contributions or emit events') }
const disposers: Disposer[] = []
let identity: PluginIdentity | undefined
let active = false
let activated = false

const object = (value: JsonValue): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('INVALID_ARGUMENT', 'Expected object')
  return value
}
const string = (value: JsonValue | undefined): string => {
  if (typeof value !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Expected string')
  return value
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const logger: ScopedLogger = {
  info: (message, data) => console.info(JSON.stringify({ level: 'info', message, data })),
  warn: (message, data) => console.warn(JSON.stringify({ level: 'warn', message, data })),
  error: (message, data) => console.error(JSON.stringify({ level: 'error', message, data })),
}

function executionContext(scope: ExecutionScope, scopeHandle: string, signal: AbortSignal): ExecutionContext {
  const call = async (method: string, args: JsonValue) => {
    if (signal.aborted) throw new StudioError('CANCELLED', 'Scope ended')
    return peer.request('context.call', { scopeHandle, origin: callbackScope.getStore() || scopeHandle, method, args })
  }
  const context: ExecutionContext = {
    scope: Object.freeze({ ...scope, principal: Object.freeze({ ...scope.principal }) }), signal, logger,
    artifacts: { read: async (id, offset = 0) => await call('artifacts.read', { id, offset }) as unknown as Awaited<ReturnType<ExecutionContext['artifacts']['read']>> },
    models: remoteModels(call),
    workflows: {
      run: async input => await call('workflows.run', json(input)) as unknown as Awaited<ReturnType<ExecutionContext['workflows']['run']>>,
      get: async id => await call('workflows.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['workflows']['get']>>,
      cancel: async id => await call('workflows.cancel', { id }) as unknown as Awaited<ReturnType<ExecutionContext['workflows']['cancel']>>,
    },
    chat: {
      start: async input => await call('chat.start', json(input)) as unknown as Awaited<ReturnType<ExecutionContext['chat']['start']>>,
      get: async id => await call('chat.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['chat']['get']>>,
      cancel: async id => await call('chat.cancel', { id }) as unknown as Awaited<ReturnType<ExecutionContext['chat']['cancel']>>,
    },
    sessions: {
      get: async id => await call('sessions.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['sessions']['get']>>,
      remove: async id => await call('sessions.remove', { id }) as unknown as Awaited<ReturnType<ExecutionContext['sessions']['remove']>>,
    },
    agents: { list: async () => await call('agents.list', {}) as unknown as Awaited<ReturnType<ExecutionContext['agents']['list']>> },
    runs: {
      start: async input => await call('runs.start', json(input)) as unknown as Awaited<ReturnType<ExecutionContext['runs']['start']>>,
      get: async id => await call('runs.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['get']>>,
      output: async (id, after = -1) => await call('runs.output', { id, after }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['output']>>,
      cancel: async id => await call('runs.cancel', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['cancel']>>,
      interactions: async id => await call('runs.interactions', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['interactions']>>,
      respond: async (id, input) => await call('runs.respond', { id, input: json(input) }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['respond']>>,
      usage: async id => await call('runs.usage', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['usage']>>,
    },
  }
  contextHandles.set(context, scopeHandle)
  return context
}

peer.handle('activate', async value => {
  if (activated) throw new StudioError('REGISTRATION_CONFLICT', 'Worker already activated')
  activated = true
  const params = object(value)
  if (params.rpc !== STUDIO_PLUGIN_RPC_VERSION) throw new StudioError('PLUGIN_VERSION_INCOMPATIBLE', 'RPC version mismatch')
  identity = object(params.identity) as unknown as PluginIdentity
  const registerDisposer = (dispose: Disposer): Disposer => {
    assertContributionMutation()
    let result: Promise<void> | undefined
    const once = () => { assertContributionMutation(); return result ??= Promise.resolve().then(dispose) }
    disposers.push(once)
    return once
  }
  const subscribe = (type: string, handler: unknown, once: boolean): Disposer => {
    if (active || typeof handler !== 'function') throw new StudioError('INVALID_ARGUMENT', 'Subscribe during plugin activation')
    const id = randomUUID()
    callbacks.set(id, { type, handler: handler as (event: EventEnvelope, ctx: ExecutionContext) => void | Promise<void>, once })
    return registerDisposer(async () => {
      callbacks.delete(id)
      if (active) await peer.request('subscription.remove', { id })
    })
  }
  const ctx: PluginContext = {
    plugin: Object.freeze(identity), config: Object.freeze(object(params.config)), logger,
    commands: { register: (definition, handler) => {
      assertContributionMutation()
      if (active || commands.has(definition.id)) throw new StudioError('REGISTRATION_CONFLICT', 'Register commands during activation')
      if (typeof handler !== 'function' || commands.size >= 64) throw new StudioError('INVALID_ARGUMENT', 'Invalid command handler or registration limit')
      const captured = json(definition) as unknown as CommandDefinition
      commands.set(captured.id, { definition: captured, handler })
      return registerDisposer(async () => { commands.delete(captured.id); if (active) await peer.request('command.remove', { id: captured.id }) })
    } },
    services: {
      provide: (token, implementation) => {
        if (active || services.has(token.id)) throw new StudioError('REGISTRATION_CONFLICT', 'Service already registered or activation ended')
        if (Object.keys(implementation).length !== Object.keys(token.methods).length
          || Object.keys(token.methods).some(name => typeof implementation[name] !== 'function')) throw new StudioError('INVALID_ARGUMENT', 'Service methods do not match their token')
        const captured = json(token) as unknown as ServiceToken
        services.set(captured.id, { token: captured, implementation: { ...implementation } })
        return registerDisposer(async () => {
          services.delete(captured.id)
          if (active) await peer.request('service.remove', { id: captured.id })
        })
      },
      use: dependency => {
        const token = json(dependency)
        return {
          status: async () => await peer.request('service.status', { dependency: token }) as unknown as { available: boolean; version?: string },
          call: async (context, method, input) => {
            const scopeHandle = contextHandles.get(context)
            if (!scopeHandle || context.signal.aborted) throw new StudioError('FORBIDDEN', 'Service calls require a live host context')
            return peer.request('context.call', { scopeHandle, origin: callbackScope.getStore() || scopeHandle, method: 'services.call', args: { dependency: token, method, input: json(input) } })
          },
        }
      },
    },
    agents: { register: definition => {
      if (active || definitions.has(definition.id)) throw new StudioError('REGISTRATION_CONFLICT', 'Agent already registered or activation ended')
      definitions.set(definition.id, definition)
      return registerDisposer(async () => {
        definitions.delete(definition.id)
        if (active) await peer.request('agent.remove', { id: definition.id })
      })
    } },
    lifecycle: { onDispose: registerDisposer },
    events: { consume: (name, spec, handler) => {
      if (active || consumers.has(name)) throw new StudioError('REGISTRATION_CONFLICT', 'Consumer already registered or activation ended')
      if (typeof handler !== 'function' || consumers.size >= 32) throw new StudioError('INVALID_ARGUMENT', 'Invalid consumer handler or registration limit')
      consumers.set(name, { spec: json(spec) as unknown as EventConsumerSpec, handler })
      return registerDisposer(async () => {
        consumers.delete(name)
        if (active) await peer.request('consumer.remove', { name })
      })
    } },
    hooks: { before: (point, handler, options) => {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new StudioError('INVALID_ARGUMENT', 'Hook options are required')
      const key = JSON.stringify([point, options.key])
      if (active || hooks.has(key)) throw new StudioError('REGISTRATION_CONFLICT', 'Hook already registered or activation ended')
      if (typeof handler !== 'function' || hooks.size >= 32) throw new StudioError('INVALID_ARGUMENT', 'Invalid hook handler or registration limit')
      hooks.set(key, { point, options: json(options) as unknown as HookOptions, handler: handler as HookHandler<HookPoint> })
      return registerDisposer(async () => { hooks.delete(key); if (active) await peer.request('hook.remove', { key }) })
    } },
    on: (type, handler) => subscribe(type, handler, false),
    once: (type, handler) => subscribe(type, handler, true),
    emit: async (type, data) => {
      assertContributionMutation()
      const scopeHandle = callbackScope.getStore()
      return object(await peer.request('event.emit', { type, data, ...(scopeHandle ? { scopeHandle } : {}) })) as unknown as { id: string }
    },
  }
  const imported = await import(pathToFileURL(string(params.entry)).href)
  const plugin = (imported.default || imported) as StudioPlugin
  if (typeof plugin.apply !== 'function') throw new StudioError('INVALID_ARGUMENT', 'Plugin must export apply(ctx)')
  await plugin.apply(ctx)
  active = true
  return json({
    rpc: STUDIO_PLUGIN_RPC_VERSION,
    agents: [...definitions.values()].map(({ create: _create, management, ...definition }) => ({ ...definition,
      ...(management ? { management: { ...(management.inspect ? { inspect: true } : {}), ...(management.locations ? { locations: true } : {}), ...(management.setup ? { setup: true } : {}), ...(management.prepareLogin ? { prepareLogin: true } : {}), ...(management.prepareInstall ? { prepareInstall: true } : {}) } } : {}) })),
    subscriptions: [...callbacks].map(([id, { type, once }]) => ({ id, type, once })),
    services: [...services.values()].map(value => value.token),
    commands: [...commands.values()].map(value => value.definition),
    consumers: [...consumers].map(([name, { spec }]) => ({ name, spec })),
    hooks: [...hooks.values()].map(({ point, options }) => ({ point, options })),
  })
})

for (const method of ['inspect', 'locations', 'setup', 'prepareLogin', 'prepareInstall'] as const) peer.handle(`management.${method}`, async value => {
  const params = object(value), callId = string(params.callId), definition = definitions.get(string(params.agentTypeId))
  if (!active || !identity || !definition?.management?.[method]) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent management is unavailable')
  if (managementCalls.has(callId) || managementCalls.size >= 16) throw new StudioError('RESOURCE_EXHAUSTED', 'Agent inspection limit reached')
  const controller = new AbortController(), handle = string(params.runtimeHandle)
  managementCalls.set(callId, controller)
  try {
    const context: import('../../studio-plugin-sdk/src').AgentRuntimeContext = {
      ...(params.nativeCli ? { nativeCli: params.nativeCli as unknown as AgentRuntimeContext['nativeCli'] } : {}),
      ...(params.stateDirectory ? { stateDirectory: string(params.stateDirectory) } : {}),
      provider: { kind: 'plugin', pluginId: identity!.id, generation: identity!.generation, version: identity!.version },
      runtimeSessionId: callId, profileId: string(params.profileId), ownerId: string(params.ownerId), logger, signal: controller.signal,
      processes: remoteProcesses(peer, handle, controller.signal, () => callbackScope.getStore() || runtimeScope.getStore(), assertContributionMutation),
      mcp: remoteMcp(peer, handle, controller.signal, () => callbackScope.getStore() || runtimeScope.getStore(), assertContributionMutation),
    }
    const input = object(params.input) as unknown as import('../../studio-plugin-sdk/src').AgentManagementInput
    return json(await runtimeScope.run(handle, () => definition.management![method]!(input, context)))
  } finally { controller.abort(); managementCalls.delete(callId) }
})
peer.handle('management.cancel', async value => { managementCalls.get(string(object(value).callId))?.abort(); return null })

peer.handle('runtime.create', async value => {
  const params = object(value)
  const definition = definitions.get(string(params.agentTypeId))
  if (!active || !definition || !identity) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent is unavailable')
  const id = string(params.runtimeSessionId)
  if (runtimes.has(id)) throw new StudioError('REGISTRATION_CONFLICT', 'Runtime already exists')
  const controller = new AbortController()
  const provider: AgentProviderRef = { kind: 'plugin', pluginId: identity.id, generation: identity.generation, version: identity.version }
  const runtimeHandle = string(params.runtimeHandle)
  const catalog = new Map<string, { definition: CommandDefinition; handler: CommandHandler }>()
  let replacing = false
  const replace: NonNullable<AgentRuntimeContext['commands']>['replace'] = async values => {
    assertContributionMutation()
    if (controller.signal.aborted) throw new StudioError('CANCELLED', 'Command runtime ended')
    if (replacing) throw new StudioError('REVISION_CONFLICT', 'Command catalog update is in progress')
    if (!Array.isArray(values) || values.length > 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Command catalog limit exceeded')
    const next = new Map<string, { definition: CommandDefinition; handler: CommandHandler }>()
    for (const value of values) {
      if (!value || typeof value.handler !== 'function' || next.has(value.definition?.id)) throw new StudioError('INVALID_ARGUMENT', 'Invalid runtime command registration')
      const definition = json(value.definition) as unknown as CommandDefinition
      next.set(definition.id, { definition, handler: value.handler })
    }
    replacing = true
    // Host validation and publication are atomic. Callbacks are not serialized.
    const previous = new Map(catalog)
    catalog.clear(); for (const [key, command] of next) catalog.set(key, command)
    try {
      await peer.request('command.replace', { runtimeHandle, originHandle: callbackScope.getStore() || runtimeScope.getStore() || runtimeHandle,
        commands: json([...next.values()].map(value => value.definition)) })
    } catch (error) { catalog.clear(); for (const [key, command] of previous) catalog.set(key, command); throw error }
    finally { replacing = false }
  }
  if (params.commands === true) runtimeCommands.set(id, catalog)
  const ctx: AgentRuntimeContext = { ...(params.nativeCli ? { nativeCli: params.nativeCli as unknown as AgentRuntimeContext['nativeCli'] } : {}), ...(typeof params.stateDirectory === 'string' ? { stateDirectory: params.stateDirectory } : {}), provider, profileId: string(params.profileId), ownerId: string(params.ownerId), runtimeSessionId: id, logger, signal: controller.signal,
    ...(params.commands === true ? { commands: { replace } } : {}),
    processes: remoteProcesses(peer, runtimeHandle, controller.signal, () => callbackScope.getStore() || runtimeScope.getStore(), assertContributionMutation),
    mcp: remoteMcp(peer, runtimeHandle, controller.signal, () => callbackScope.getStore() || runtimeScope.getStore(), assertContributionMutation) }
  try {
    const runtime = await runtimeScope.run(runtimeHandle, () => definition.create(object(params.input) as unknown as RuntimeCreateInput, ctx))
    runtimes.set(id, { runtime, controller, handle: runtimeHandle })
  } catch (error) { controller.abort(); runtimeCommands.delete(id); throw error }
  return null
})

peer.handle('run.start', async value => {
  const params = object(value)
  const runtime = runtimes.get(string(params.runtimeSessionId))
  if (!runtime) throw new StudioError('RUNTIME_UNAVAILABLE', 'Runtime is unavailable')
  const runId = string(params.runId)
  if (runs.has(runId)) throw new StudioError('REGISTRATION_CONFLICT', 'Run already exists')
  const controller = new AbortController()
  // Preserve the exact host context registered in contextHandles for services.call.
  const ctx = Object.freeze(Object.assign(executionContext(object(params.scope) as unknown as ExecutionScope, string(params.scopeHandle), controller.signal),
    params.nativeContext ? { nativeContext: object(params.nativeContext) } : {})) as AgentRunContext
  const handle = await callbackScope.run(string(params.scopeHandle), () => runtime.runtime.run(object(params.input) as unknown as AgentRunInput, ctx))
  runs.set(runId, { handle, controller })
  void callbackScope.run(string(params.scopeHandle), async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    try {
      const expired = new Promise<never>((_, reject) => {
        void handle.result.then(() => { timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'Agent output did not drain')), 5_000) }).catch(() => {})
      })
      const [, result] = await Promise.race([Promise.all([
        (async () => { for await (const event of handle.events) { if (ended) break; await peer.request('run.event', { runId, event: json(event) }) } })(),
        handle.result,
      ]), expired])
      await peer.request('run.result', { runId, result: json(result) })
    } catch (error) {
      const safe = serializeStudioError(error, 'Agent run failed')
      await peer.request('run.error', { runId, error: json(safe) }).catch(() => {})
    } finally { ended = true; if (timer) clearTimeout(timer); runs.delete(runId); controller.abort() }
  })
  return { respond: typeof handle.respond === 'function' }
})

peer.handle('run.cancel', async value => {
  const params = object(value), run = runs.get(string(params.runId))
  if (run) { run.controller.abort(); await run.handle.cancel(string(params.reason)) }
  return null
})
peer.handle('run.respond', async value => {
  const params = object(value), run = runs.get(string(params.runId))
  if (!run || run.controller.signal.aborted) throw new StudioError('RUNTIME_UNAVAILABLE', 'Run is unavailable')
  if (!run.handle.respond) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent cannot respond to interactions')
  return json(await run.handle.respond(object(params.input) as unknown as Parameters<NonNullable<AgentRunHandle['respond']>>[0]) ?? null)
})
peer.handle('runtime.dispose', async value => {
  const params = object(value), id = string(params.runtimeSessionId), runtime = runtimes.get(id)
  if (runtime) { runtimes.delete(id); runtimeCommands.delete(id); runtime.controller.abort(); await runtimeScope.run(runtime.handle, () => runtime.runtime.dispose(string(params.reason))) }
  return null
})
peer.handle('runtime.checkpoint', async value => {
  const runtime = runtimes.get(string(object(value).runtimeSessionId))
  if (!runtime?.runtime.checkpoint) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Checkpoint is unsupported')
  return runtimeScope.run(runtime.handle, () => runtime.runtime.checkpoint!())
})
peer.handle('command.invoke', async value => {
  const params = object(value), callId = string(params.callId)
  const command = typeof params.runtimeSessionId === 'string'
    ? runtimeCommands.get(params.runtimeSessionId)?.get(string(params.id)) : commands.get(string(params.id))
  if (!active || !command) throw new StudioError('PLUGIN_UNAVAILABLE', 'Command is unavailable')
  if (commandCalls.has(callId) || commandCalls.size >= 16) throw new StudioError('RESOURCE_EXHAUSTED', 'Command concurrency limit reached')
  const controller = new AbortController(), scopeHandle = string(params.scopeHandle)
  commandCalls.set(callId, controller)
  try {
    const context: CommandContext = Object.assign(executionContext(object(params.scope) as unknown as ExecutionScope, scopeHandle, controller.signal), {
      session: Object.freeze(object(params.session)) as unknown as CommandContext['session'],
      reply: async (result: import('../../studio-plugin-sdk/src').CommandResult) => {
        if (controller.signal.aborted) throw new StudioError('CANCELLED', 'Command has ended')
        await peer.request('command.result', { callId, result: json(result) })
      },
    })
    await callbackScope.run(scopeHandle, async () => {
      const result = await command.handler(object(params.input) as unknown as CommandInput, context)
      if (result !== undefined) await context.reply(result)
    })
    return null
  } finally { controller.abort(); commandCalls.delete(callId) }
})
peer.handle('command.cancel', value => { commandCalls.get(string(object(value).callId))?.abort(); return null })

peer.handle('service.invoke', async value => {
  const params = object(value), service = services.get(string(params.id)), method = string(params.method), callId = string(params.callId)
  if (!active || !service || !Object.hasOwn(service.implementation, method)) throw new StudioError('NOT_FOUND', 'Service method is unavailable')
  if (serviceCalls.has(callId)) throw new StudioError('REVISION_CONFLICT', 'Service call already exists')
  const controller = new AbortController()
  serviceCalls.set(callId, controller)
  try {
    return json(await callbackScope.run(string(params.scopeHandle), () => service.implementation[method](params.input, executionContext(object(params.scope) as unknown as ExecutionScope, string(params.scopeHandle), controller.signal))))
  } finally { controller.abort(); serviceCalls.delete(callId) }
})
peer.handle('service.cancel', value => { serviceCalls.get(string(object(value).callId))?.abort(); return null })
peer.handle('consumer.deliver', async value => {
  const params = object(value), consumer = consumers.get(string(params.name)), id = string(params.deliveryId)
  if (!active || !consumer) throw new StudioError('PLUGIN_UNAVAILABLE', 'Consumer is unavailable')
  if (deliveries.has(id)) throw new StudioError('REGISTRATION_CONFLICT', 'Delivery is already active')
  const controller = new AbortController(); deliveries.set(id, controller)
  try { await callbackScope.run(string(params.scopeHandle), () => consumer.handler(object(params.event) as unknown as EventEnvelope,
    executionContext(object(params.scope) as unknown as ExecutionScope, string(params.scopeHandle), controller.signal))) }
  finally { controller.abort(); deliveries.delete(id) }
  return null
})
peer.handle('consumer.cancel', value => { deliveries.get(string(object(value).deliveryId))?.abort(); return null })
peer.handle('hook.invoke', async value => {
  const params = object(value), hook = hooks.get(string(params.key)), callId = string(params.callId), scopeHandle = string(params.scopeHandle)
  if (!active || !hook) throw new StudioError('PLUGIN_UNAVAILABLE', 'Hook is unavailable')
  const controller = new AbortController(); hookCalls.set(callId, controller)
  const full = executionContext(object(params.scope) as unknown as ExecutionScope, scopeHandle, controller.signal)
  const context: HookContext = Object.freeze({ scope: full.scope, signal: full.signal, logger,
    models: Object.freeze({ list: full.models.list, get: full.models.get }),
    agents: Object.freeze(full.agents), sessions: Object.freeze({ get: full.sessions.get }),
    runs: Object.freeze({ get: full.runs.get, output: full.runs.output, interactions: full.runs.interactions, usage: full.runs.usage }),
    chat: Object.freeze({ get: full.chat.get }), workflows: Object.freeze({ get: full.workflows.get }),
  })
  contextHandles.set(context, scopeHandle)
  const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }; return value }
  try { return await callbackScope.run(scopeHandle, () => hookScope.run(true, async () => {
    const result = await hook.handler(freeze(object(params.input)) as unknown as Parameters<typeof hook.handler>[0], context)
    return result === undefined ? null : json(result)
  })) }
  finally { controller.abort(); hookCalls.delete(callId) }
})
peer.handle('hook.cancel', value => { hookCalls.get(string(object(value).callId))?.abort(); return null })
peer.handle('event.deliver', async value => {
  const params = object(value), id = string(params.id), subscription = callbacks.get(id)
  if (!subscription) return null
  if (subscription.once) callbacks.delete(id)
  const controller = new AbortController()
  try {
    await callbackScope.run(string(params.scopeHandle), () => subscription.handler(object(params.event) as unknown as EventEnvelope,
      executionContext(object(params.scope) as unknown as ExecutionScope, string(params.scopeHandle), controller.signal)))
  } finally { controller.abort() }
  return null
})

async function dispose(): Promise<void> {
  active = false
  for (const controller of serviceCalls.values()) controller.abort()
  for (const controller of deliveries.values()) controller.abort()
  for (const controller of hookCalls.values()) controller.abort()
  for (const controller of managementCalls.values()) controller.abort()
  for (const { handle, controller } of runs.values()) { controller.abort(); await handle.cancel('Plugin shutdown').catch(() => {}) }
  for (const { runtime, controller, handle } of runtimes.values()) { controller.abort(); await runtimeScope.run(handle, () => runtime.dispose('Plugin shutdown')).catch(() => {}) }
  for (const dispose of disposers.reverse()) { try { await dispose() } catch { /* Host also owns process cleanup. */ } }
  runs.clear(); runtimes.clear(); definitions.clear(); callbacks.clear(); services.clear(); serviceCalls.clear()
  consumers.clear(); deliveries.clear()
  hooks.clear(); hookCalls.clear()
  managementCalls.clear()
}
peer.handle('dispose', async () => { await dispose(); return null })
process.on('message', message => { void peer.receive(message).catch(() => { peer.close(); if (process.connected) process.disconnect() }) })
process.once('disconnect', () => { peer.close(); void dispose().finally(() => process.exit(0)) })
