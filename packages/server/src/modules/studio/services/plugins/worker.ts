import { fork, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { RpcPeer, type RpcFrame } from '../../../../../../studio-plugin-sdk/src/rpc'
import {
  StudioError, STUDIO_ERROR_CODES, STUDIO_PLUGIN_RPC_VERSION, type StudioErrorCode, type AgentTypeDefinition, type AgentRuntime, type AgentRuntimeContext,
  type AgentRunContext, type AgentRunHandle, type AgentOutputEvent, type AgentRunResult,
  type AgentManagementInput, type CommandDefinition, type CommandInput, type CommandContext, type CommandResult,
  type ExecutionContext, type JsonValue, type JsonObject, type PluginIdentity, type ScopedLogger, type ServiceToken, type EventConsumerSpec, type EventEnvelope, type AgentTypeSummary,
} from '../../contracts/plugins'
import type { ServiceAuthority } from './services'
import { jsonCopy, toJson, parseAgentOutput, parseAgentInspection, parseAgentSetup } from './validation'
import { AsyncChannel } from './channel'
import { authorizeHookOperation, type HookRegistration } from '../events/plugin-hooks'
import { PluginProcessBridge } from './processes'
import { managedProcessEnvironment } from '../processes/managed'
import { PluginMcpBridge } from './mcp'
import { PluginModelBridge } from './models'
import { parseAgentResourceLocations } from '../agents/resource-contract'
import { parseAgentCliInstall } from '../agents/cli-install-contract'
import { parseAgentLogin } from '../agents/login-contract'
import { runtimeCommandTarget } from '../agents/command-target'
import type { PluginCommandRegistry } from './commands'

export interface WorkerActivation {
  agents: Array<Omit<AgentTypeSummary, 'provider'>>
  subscriptions: Array<{ id: string; type: string; once: boolean }>
  services: ServiceToken[]
  commands: CommandDefinition[]
  consumers: Array<{ name: string; spec: EventConsumerSpec }>
  hooks: HookRegistration[]
}
interface RemoteRun {
  channel: AsyncChannel<AgentOutputEvent>
  resolve(result: AgentRunResult): void
  reject(error: unknown): void
  release(): Promise<void>
  sequence: number
}

export function workerEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...managedProcessEnvironment(parent), NODE_ENV: 'production' }
}

export class PluginWorker {
  readonly peer: RpcPeer
  private readonly child: ChildProcess
  private readonly scopes = new Map<string, ExecutionContext>()
  private readonly authorities = new Map<string, ServiceAuthority>()
  private readonly commandCalls = new Map<string, (value: unknown) => Promise<void>>()
  private serviceCalls = 0
  private consumerCalls = 0
  private hookCalls = 0
  private managementCalls = 0
  private readonly managementLeases = new Map<object, { cancel(): void; completed: Promise<void> }>()
  callService?: (context: ExecutionContext, args: JsonObject, authority: ServiceAuthority) => Promise<JsonValue>
  private readonly runs = new Map<string, RemoteRun>()
  private readonly runtimes = new Set<string>()
  private readonly runtimeCommands = new Map<string, { context: AgentRuntimeContext; replace(values: CommandDefinition[]): void; dispose(): void }>()
  private closed = false
  private closing?: Promise<void>
  private readonly exit: Promise<void>
  private readonly processes: PluginProcessBridge
  private readonly mcp: PluginMcpBridge
  private readonly models: PluginModelBridge

  constructor(runnerPath: string, private readonly logger: ScopedLogger, private readonly onExit: () => void, private readonly authorize: (capability: string) => void, timeoutMs = 30_000) {
    this.child = fork(runnerPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', env: workerEnvironment(process.env),
      execArgv: [], detached: process.platform !== 'win32',
    })
    this.peer = new RpcPeer({ send: frame => new Promise((resolve, reject) => {
      if (!this.child.connected) { reject(new StudioError('PLUGIN_UNAVAILABLE', 'Plugin worker disconnected')); return }
      this.child.send(frame, error => error ? reject(error) : resolve())
    }) }, timeoutMs)
    this.exit = new Promise(resolve => this.child.once('close', () => { this.fail(); resolve() }))
    this.child.on('error', () => this.fail())
    this.child.on('disconnect', () => this.fail())
    this.child.on('message', value => {
      try {
        const frame = jsonCopy(value) as RpcFrame
        if (!frame || typeof frame !== 'object' || !Number.isSafeInteger(frame.id) || !['request', 'response', 'error'].includes(frame.kind)) throw new Error('Malformed frame')
        void this.peer.receive(frame).catch(() => { this.fail(); void this.close() })
      } catch { this.fail(); void this.close() }
    })
    this.child.stdout?.on('data', (chunk: Buffer) => logger.info('Plugin stdout', { text: chunk.toString('utf8').slice(0, 4096) }))
    this.child.stderr?.on('data', (chunk: Buffer) => logger.warn('Plugin stderr', { text: chunk.toString('utf8').slice(0, 4096) }))
    this.peer.handle('context.call', value => this.contextCall(value))
    this.peer.handle('command.result', async value => {
      const params = value as JsonObject, reply = this.commandCalls.get(String(params.callId))
      if (!reply) throw new StudioError('NOT_FOUND', 'Command call has ended')
      await reply(params.result); return null
    })
    this.models = new PluginModelBridge((handle, capability) => {
      const ctx = this.scopes.get(handle)
      if (!ctx || ctx.signal.aborted) throw new StudioError('FORBIDDEN', 'Model caller scope is unavailable')
      this.authorize(capability); this.authorities.get(handle)?.(capability)
      return ctx
    })
    const resourceOrigin = (capability: string) => (origin: JsonValue | undefined, runtimeHandle: string, runtime: AgentRuntimeContext) => {
      if (origin === runtimeHandle) {
        // A live factory/background runtime capability remains valid while an
        // unrelated hook runs. Hook-origin calls take the authority path below.
        return
      }
      if (typeof origin !== 'string' || !this.scopes.has(origin) || this.scopes.get(origin)!.signal.aborted) throw new StudioError('FORBIDDEN', 'Runtime caller scope is unavailable')
      const scope = this.scopes.get(origin)!.scope as AgentRunContext['scope']
      if (scope.profileId !== runtime.profileId || scope.principal.id !== runtime.ownerId
        || (scope.runId && scope.runtimeSessionId !== runtime.runtimeSessionId)) throw new StudioError('FORBIDDEN', 'Resource is outside the caller runtime scope')
      this.authorities.get(origin)?.(capability)
    }
    this.processes = new PluginProcessBridge(() => this.authorize('processes.spawn'), resourceOrigin('processes.spawn'))
    this.mcp = new PluginMcpBridge(() => this.authorize('mcp.connect'), resourceOrigin('mcp.connect'))
    this.peer.handle('mcp.call', value => this.mcp.call(value))
    this.peer.handle('process.call', value => this.processes.call(value))
    this.peer.handle('command.replace', value => {
      const params = value as JsonObject
      if (!params || typeof params.runtimeHandle !== 'string' || !Array.isArray(params.commands)
        || Object.keys(params).some(key => !['runtimeHandle', 'originHandle', 'commands'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid runtime command catalog')
      const registration = this.runtimeCommands.get(params.runtimeHandle)
      if (!registration) throw new StudioError('FORBIDDEN', 'Runtime command scope is unavailable')
      resourceOrigin('commands.register')(params.originHandle, params.runtimeHandle, registration.context)
      this.authorize('commands.register')
      registration.replace(params.commands as unknown as CommandDefinition[])
      return null
    })
    this.peer.handle('run.event', async value => {
      const params = value as JsonObject, run = this.runs.get(String(params.runId))
      if (!run) throw new StudioError('NOT_FOUND', 'Run is not active')
      const event = parseAgentOutput(params.event)
      if (!event || !Number.isSafeInteger(event.producerSequence) || event.producerSequence <= run.sequence) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent event sequence')
      run.sequence = event.producerSequence
      await run.channel.push(event)
      return null
    })
    this.peer.handle('run.result', async value => {
      const params = value as JsonObject, run = this.runs.get(String(params.runId))
      if (!run) throw new StudioError('NOT_FOUND', 'Run is not active')
      const result = params.result as unknown as AgentRunResult
      if (!result || !['completed', 'cancelled'].includes(result.status)) throw new StudioError('INVALID_ARGUMENT', 'Invalid run result')
      try { await run.release(); run.channel.finish(); run.resolve(jsonCopy(result)) }
      catch (error) { run.channel.finish(error); run.reject(error) }
      this.runs.delete(String(params.runId))
      return null
    })
    this.peer.handle('run.error', async value => {
      const id = String((value as JsonObject).runId), run = this.runs.get(id)
      if (run) {
        const detail = (value as JsonObject).error as JsonObject | undefined
        const code = typeof detail?.code === 'string' && (STUDIO_ERROR_CODES as readonly string[]).includes(detail.code) ? detail.code as StudioErrorCode : 'RUNTIME_UNAVAILABLE'
        const error = new StudioError(code, 'Plugin Agent run failed')
        try { await run.release() } finally { run.channel.finish(error); run.reject(error); this.runs.delete(id) }
      }
      return null
    })
  }

  async activate(entry: string, identity: PluginIdentity, config: JsonObject): Promise<WorkerActivation> {
    const result = await this.peer.request('activate', toJson({ entry, identity, config, rpc: STUDIO_PLUGIN_RPC_VERSION })) as JsonObject
    if (!result || result.rpc !== STUDIO_PLUGIN_RPC_VERSION || !Array.isArray(result.agents) || !Array.isArray(result.subscriptions) || !Array.isArray(result.services) || !Array.isArray(result.consumers) || !Array.isArray(result.hooks) || !Array.isArray(result.commands)) {
      throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin activation response')
    }
    return result as unknown as WorkerActivation
  }

  definition(meta: Omit<AgentTypeSummary, 'provider'>, commands?: PluginCommandRegistry): AgentTypeDefinition {
    const { management, ...metadata } = jsonCopy(meta)
    if (management !== undefined && (!management || !Object.keys(management).length
      || Object.entries(management).some(([key, value]) => !['inspect', 'locations', 'setup', 'prepareLogin', 'prepareInstall'].includes(key) || value !== true))) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent management declaration')
    const manage = async (input: AgentManagementInput, context: AgentRuntimeContext, method: 'inspect' | 'locations' | 'setup' | 'prepareLogin' | 'prepareInstall') => {
        if (context.signal.aborted) throw new StudioError('CANCELLED', 'Management scope ended')
        const check = () => {
          if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin worker exited')
          this.authorize('agents.register')
          if ((method === 'prepareLogin' || method === 'prepareInstall')) this.authorize('processes.spawn')
        }
        check()
        const processScope = this.processes.mount(context), mcpScope = this.mcp.mount(context, processScope.handle)
        this.managementCalls++
        const callId = context.runtimeSessionId
        let finished = false, rejectAbort!: (error: unknown) => void
        const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject })
        const abort = () => {
          void this.peer.request('management.cancel', { callId }, 1_000).catch(() => {})
          rejectAbort(new StudioError('CANCELLED', 'Management scope ended'))
        }
        const watch = setInterval(() => {
          try { check() }
          catch (error) {
            void this.peer.request('management.cancel', { callId }, 1_000).catch(() => {})
            rejectAbort(error)
          }
        }, 250)
        context.signal.addEventListener('abort', abort, { once: true })
        const task = Promise.resolve().then(() => this.peer.request(`management.${method}`, toJson({ callId, agentTypeId: meta.id,
          runtimeHandle: processScope.handle, ownerId: context.ownerId, profileId: context.profileId, ...(context.nativeCli ? { nativeCli: context.nativeCli } : {}), ...(context.stateDirectory ? { stateDirectory: context.stateDirectory } : {}),
          input }))).finally(() => { finished = true })
        if (context.signal.aborted) abort()
        try {
          const result = await Promise.race([task, cancelled])
          check()
          return result
        }
        catch (error) {
          if (error instanceof StudioError && error.code === 'DEADLINE_EXCEEDED') await this.close()
          throw error
        }
        finally {
          clearInterval(watch)
          context.signal.removeEventListener('abort', abort)
          try {
            if (!finished) {
              let timer: ReturnType<typeof setTimeout> | undefined
              try { await Promise.race([task.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1_000) })]) }
              finally { clearTimeout(timer) }
              if (!finished) await this.close()
            }
          } finally {
            const results = await Promise.allSettled([processScope.close(), mcpScope.close()])
            this.managementCalls--
            const failed = results.find(result => result.status === 'rejected')
            if (failed?.status === 'rejected') throw failed.reason
          }
        }
    }
    return {
      ...metadata,
      ...(management ? { management: {
        ...(management.inspect ? { inspect: async (input, context) => parseAgentInspection(await manage(input, context, 'inspect')) } : {}),
        ...(management.locations ? { locations: async (input, context) => parseAgentResourceLocations(await manage(input, context, 'locations')) } : {}),
        ...(management.setup ? { setup: async (input, context) => parseAgentSetup(await manage(input, context, 'setup')) } : {}),
        ...(management.prepareInstall ? { prepareInstall: async (input, context) => parseAgentCliInstall(await manage(input, context, 'prepareInstall')) } : {}),
        ...(management.prepareLogin ? { prepareLogin: async (input, context) => parseAgentLogin(await manage(input, context, 'prepareLogin')) } : {}),
      } } : {}),
      create: async (input, context): Promise<AgentRuntime> => {
        const id = context.runtimeSessionId
        if (context.signal.aborted) throw new StudioError('CANCELLED', 'Runtime scope ended')
        if (this.runtimes.has(id)) throw new StudioError('REGISTRATION_CONFLICT', 'Runtime is already active')
        // Creation itself owns a lease: configuration changes must not kill an in-flight factory.
        const processScope = this.processes.mount(context)
        const mcpScope = this.mcp.mount(context, processScope.handle)
        const binding = runtimeCommandTarget(context)
        let commandScope: ReturnType<PluginCommandRegistry['runtime']> | undefined
        let commandGrant = false
        try { this.authorize('commands.register'); commandGrant = true } catch { /* Existing grants remain valid for non-command runtime capabilities. */ }
        if (commands && binding && commandGrant && context.provider.kind === 'plugin') {
          commandScope = commands.runtime(context.profileId, context.provider, meta.id, binding.target,
            (commandId, value, ctx) => this.invokeCommand(commandId, value, ctx, id),
            () => { this.authorize('commands.register'); binding.authorize() }, context.signal)
          this.runtimeCommands.set(processScope.handle, { context, ...commandScope })
        }
        const releaseResources = async () => {
          commandScope?.dispose(); this.runtimeCommands.delete(processScope.handle)
          const results = await Promise.allSettled([processScope.close(), mcpScope.close()])
          const failed = results.find(result => result.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
        }
        this.runtimes.add(id)
        try { await this.peer.request('runtime.create', toJson({ agentTypeId: meta.id, runtimeSessionId: id, runtimeHandle: processScope.handle, ownerId: context.ownerId, profileId: context.profileId,
          ...(commandScope ? { commands: true } : {}), ...(context.nativeCli ? { nativeCli: context.nativeCli } : {}), ...(context.stateDirectory ? { stateDirectory: context.stateDirectory } : {}), input })) }
        catch (error) {
          this.runtimes.delete(id)
          try { await releaseResources() } finally { await this.close() }
          throw error
        }
        let disposal: Promise<void> | undefined
        const dispose = (reason: string): Promise<void> => disposal ??= (async () => {
          commandScope?.dispose(); this.runtimeCommands.delete(processScope.handle)
          context.signal.removeEventListener('abort', aborted)
          try {
            // A replaced worker has no runtime to call. Its close barrier still
            // confirms process exit and all hosted resource cleanup.
            if (this.closed) await this.close()
            else await this.peer.request('runtime.dispose', { runtimeSessionId: id, reason }, 5_000)
          }
          catch (error) { await this.close(); throw error }
          finally { await releaseResources(); this.runtimes.delete(id) }
        })()
        const aborted = () => { void dispose('Runtime scope ended').catch(() => {}) }
        context.signal.addEventListener('abort', aborted, { once: true })
        if (context.signal.aborted) { await dispose('Runtime scope ended'); throw new StudioError('CANCELLED', 'Runtime scope ended') }
        return {
          run: (runInput, ctx) => this.startRun(id, runInput, ctx),
          checkpoint: () => this.peer.request('runtime.checkpoint', { runtimeSessionId: id }),
          dispose,
        }
      },
    }
  }

  async withContext<T>(ctx: ExecutionContext, action: (handle: string) => Promise<T>, authority?: ServiceAuthority): Promise<T> {
    const handle = randomUUID()
    this.scopes.set(handle, ctx)
    if (authority) this.authorities.set(handle, authority)
    try { return await action(handle) } finally { this.scopes.delete(handle); this.authorities.delete(handle); await this.models.closeScope(handle) }
  }

  async invokeService(id: string, method: string, input: JsonValue, ctx: ExecutionContext, authority: ServiceAuthority): Promise<JsonValue> {
    if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Service caller ended')
    const callId = randomUUID()
    this.serviceCalls++
    try {
      return await this.withContext(ctx, async scopeHandle => {
        let cancel!: () => void
        const cancelled = new Promise<never>((_, reject) => {
          cancel = () => {
            void this.peer.request('service.cancel', { callId }, 1_000).catch(() => {})
            reject(ctx.signal.reason instanceof StudioError ? ctx.signal.reason : new StudioError('CANCELLED', 'Service caller ended'))
          }
          ctx.signal.addEventListener('abort', cancel, { once: true })
        })
        try { return await Promise.race([this.peer.request('service.invoke', toJson({ callId, id, method, input, scope: ctx.scope, scopeHandle }), 5_000), cancelled]) }
        finally { ctx.signal.removeEventListener('abort', cancel) }
      }, authority)
    } finally { this.serviceCalls-- }
  }

  async invokeCommand(id: string, input: CommandInput, ctx: CommandContext, runtimeSessionId?: string): Promise<void> {
    const callId = randomUUID(), controller = new AbortController()
    const signal = AbortSignal.any([ctx.signal, controller.signal])
    const check = () => { if (signal.aborted) throw signal.reason; this.authorize('commands.register') }
    check()
    const watch = setInterval(() => { try { check() } catch (error) { controller.abort(error) } }, 250)
    this.commandCalls.set(callId, async value => { check(); await ctx.reply(value as CommandResult); check() })
    try {
      await this.withContext({ ...ctx, signal }, async scopeHandle => {
        let finished = false, abort!: () => void
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => { void this.peer.request('command.cancel', { callId }, 1_000).catch(() => {}); reject(signal.reason || new StudioError('CANCELLED', 'Command cancelled')) }
          signal.addEventListener('abort', abort, { once: true })
        })
        const task = this.peer.request('command.invoke', toJson({ id, input, callId, scope: ctx.scope, scopeHandle, session: ctx.session,
          ...(runtimeSessionId ? { runtimeSessionId } : {}) }), 65_000)
          .finally(() => { finished = true })
        if (signal.aborted) abort()
        try { await Promise.race([task, cancelled]); check() }
        catch (error) {
          if (error instanceof StudioError && error.code === 'DEADLINE_EXCEEDED') await this.close()
          throw error
        }
        finally {
          signal.removeEventListener('abort', abort)
          if (!finished) {
            let timer: ReturnType<typeof setTimeout> | undefined
            try { await Promise.race([task.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1_000) })]) }
            finally { clearTimeout(timer) }
            if (!finished) await this.close()
          }
        }
      })
    } finally { clearInterval(watch); controller.abort(); this.commandCalls.delete(callId) }
  }

  private async startRun(runtimeSessionId: string, input: Parameters<AgentRuntime['run']>[0], ctx: AgentRunContext): Promise<AgentRunHandle> {
    if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Run scope ended')
    const runId = ctx.scope.runId
    if (this.runs.has(runId)) throw new StudioError('REGISTRATION_CONFLICT', 'Run is already active')
    const scopeHandle = randomUUID()
    this.scopes.set(scopeHandle, ctx)
    const cancel = async (reason: string): Promise<void> => { await this.peer.request('run.cancel', { runId, reason }) }
    const aborted = () => { void cancel('Execution scope ended').catch(() => {}) }
    const channel = new AsyncChannel<AgentOutputEvent>(128, aborted)
    let resolve!: (value: AgentRunResult) => void, reject!: (error: unknown) => void
    const result = new Promise<AgentRunResult>((yes, no) => { resolve = yes; reject = no })
    void result.catch(() => {})
    let releasing: Promise<void> | undefined
    const release = () => releasing ??= (async () => { this.scopes.delete(scopeHandle); ctx.signal.removeEventListener('abort', aborted); await this.models.closeScope(scopeHandle) })()
    this.runs.set(runId, { channel, resolve, reject, release, sequence: -1 })
    ctx.signal.addEventListener('abort', aborted, { once: true })
    let canRespond = false
    try {
      if (ctx.nativeContext) this.authorizeNativeMcp()
      const response = await this.peer.request('run.start', toJson({ runId, runtimeSessionId, input, scope: ctx.scope, scopeHandle,
        ...(ctx.nativeContext ? { nativeContext: ctx.nativeContext } : {}) }))
      canRespond = !!(response && typeof response === 'object' && !Array.isArray(response) && response.respond === true)
    }
    catch (error) { channel.finish(error); reject(error); await release(); this.runs.delete(runId); throw error }
    return { events: channel, result, cancel,
      ...(canRespond ? { respond: async (input: Parameters<NonNullable<AgentRunHandle['respond']>>[0]) => {
        const result = await this.peer.request('run.respond', toJson({ runId, input }))
        if (result === null) return
        if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || result.status !== 'withdrawn') {
          throw new StudioError('INVALID_ARGUMENT', 'Invalid interaction dispatch receipt')
        }
        return { status: 'withdrawn' as const }
      } } : {}),
    }
  }

  async deliverConsumer(name: string, event: EventEnvelope, ctx: ExecutionContext): Promise<void> {
    if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Consumer ended')
    const deliveryId = randomUUID(); this.consumerCalls++
    try {
      await this.withContext(ctx, async scopeHandle => {
        const abort = () => { void this.peer.request('consumer.cancel', { deliveryId }, 1_000).catch(() => {}) }
        ctx.signal.addEventListener('abort', abort, { once: true })
        try { await this.peer.request('consumer.deliver', toJson({ name, event, deliveryId, scopeHandle, scope: ctx.scope }), 30_000) }
        finally { ctx.signal.removeEventListener('abort', abort) }
      })
    } finally { this.consumerCalls-- }
  }

  async invokeHook(declaration: HookRegistration, input: JsonValue, ctx: ExecutionContext): Promise<JsonValue> {
    if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Hook caller ended')
    const callId = randomUUID(), capability = `hooks.before:${declaration.point}`
    this.authorize(capability); this.hookCalls++
    try {
      return await this.withContext(ctx, async scopeHandle => {
        let abort!: () => void
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => { void this.peer.request('hook.cancel', { callId }, 1_000).catch(() => {}); reject(ctx.signal.reason instanceof StudioError ? ctx.signal.reason : new StudioError('CANCELLED', 'Hook caller ended')) }
          ctx.signal.addEventListener('abort', abort, { once: true })
        })
        try { return await Promise.race([this.peer.request('hook.invoke', toJson({ key: JSON.stringify([declaration.point, declaration.options.key]), callId, input, scopeHandle, scope: ctx.scope }), 2_000), cancelled]) }
        finally { ctx.signal.removeEventListener('abort', abort) }
      }, operation => { this.authorize(capability); authorizeHookOperation(operation) })
    } catch (error) {
      if (error instanceof StudioError && error.code === 'DEADLINE_EXCEEDED') void this.close()
      throw error
    } finally { this.hookCalls-- }
  }

  isExecutingHook(): boolean { return this.hookCalls > 0 }
  authorizeEmission(scopeHandle: JsonValue | undefined, type: string): void {
    if (scopeHandle === undefined) {
      if (this.isExecutingHook()) throw new StudioError('FORBIDDEN', 'Hook cannot emit events')
      return
    }
    if (typeof scopeHandle !== 'string' || !this.scopes.has(scopeHandle) || this.scopes.get(scopeHandle)!.signal.aborted) throw new StudioError('FORBIDDEN', 'Event caller scope is unavailable')
    this.authorities.get(scopeHandle)?.(`events.emit:${type}`)
  }
  /** A host PTY outlives its short preparation RPC, but still belongs to this activation. */
  leaseManagement(cancel: () => void, completed: Promise<void>) {
    const authorize = () => {
      if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin worker exited')
      this.authorize('agents.register'); this.authorize('processes.spawn')
    }
    authorize()
    const token = {}
    this.managementLeases.set(token, { cancel, completed })
    return { authorize, release: () => { this.managementLeases.delete(token) } }
  }

  hasLeases(): boolean { return this.managementLeases.size > 0 || this.commandCalls.size > 0 || this.runtimes.size > 0 || this.runs.size > 0 || this.serviceCalls > 0 || this.consumerCalls > 0 || this.hookCalls > 0 || this.managementCalls > 0 }
  isAvailable(): boolean { return !this.closed }

  authorizeNativeMcp(): void {
    if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin worker exited')
    this.authorize('agents.register'); this.authorize('mcp.studio')
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (!this.closed) await this.peer.request('dispose', {}, 2_000).catch(() => {})
      this.fail()
      if (this.child.pid) {
        if (process.platform === 'win32') {
          await new Promise<void>(resolve => execFile('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], () => resolve()))
        } else {
          try { process.kill(-this.child.pid, 'SIGKILL') } catch { this.child.kill('SIGKILL') }
        }
      }
      await this.exit
      const results = await Promise.allSettled([this.processes.close(), this.mcp.close(), this.models.close(), ...[...this.managementLeases.values()].map(lease => lease.completed)])
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
  }

  private async contextCall(value: JsonValue): Promise<JsonValue> {
    const params = value as JsonObject
    const ctx = this.scopes.get(String(params.scopeHandle))
    if (!ctx || ctx.signal.aborted) throw new StudioError('FORBIDDEN', 'Execution scope is unavailable')
    if (params.origin !== params.scopeHandle) throw new StudioError('FORBIDDEN', 'Context belongs to a different execution callback')
    const authority = this.authorities.get(String(params.scopeHandle))
    const authorize = (capability: string) => { this.authorize(capability); authority?.(capability) }
    if (['models.open', 'models.next', 'models.close', 'models.gateway', 'models.gateway.close'].includes(String(params.method))) return this.models.call(String(params.scopeHandle), String(params.method), params.args)
    if (params.method === 'artifacts.read') {
      authorize('artifacts.read')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => !['id', 'offset'].includes(key))
        || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))) throw new StudioError('INVALID_ARGUMENT', 'Invalid artifact read')
      const result = await ctx.artifacts.read(args.id, args.offset === undefined ? 0 : Number(args.offset))
      authorize('artifacts.read')
      if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Artifact scope ended')
      return toJson(result)
    }
    if (params.method === 'models.list') { authorize('models.read'); const result = await ctx.models.list(); authorize('models.read'); return toJson(result) }
    if (params.method === 'models.get') {
      authorize('models.read')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw new StudioError('INVALID_ARGUMENT', 'Only a model call id is accepted')
      const result = await ctx.models.get(args.id)
      authorize('models.read')
      return toJson(result)
    }
    if (params.method === 'services.call') {
      if (!this.callService) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Plugin services are unavailable')
      return this.callService(ctx, params.args as JsonObject, authorize)
    }
    if (params.method === 'workflows.run') {
      authorize('workflows.run')
      return toJson(await ctx.workflows.run(params.args as unknown as Parameters<ExecutionContext['workflows']['run']>[0]))
    }
    if (params.method === 'workflows.get' || params.method === 'workflows.cancel') {
      authorize(params.method === 'workflows.get' ? 'workflows.read' : 'workflows.cancel')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw new StudioError('INVALID_ARGUMENT', 'Only a workflow run id is accepted')
      return toJson(params.method === 'workflows.get' ? await ctx.workflows.get(args.id) : await ctx.workflows.cancel(args.id))
    }
    if (params.method === 'chat.start') {
      authorize('chat.start')
      return toJson(await ctx.chat.start(params.args as unknown as Parameters<ExecutionContext['chat']['start']>[0]))
    }
    if (params.method === 'chat.get' || params.method === 'chat.cancel') {
      authorize(params.method === 'chat.get' ? 'chat.read' : 'chat.cancel')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw new StudioError('INVALID_ARGUMENT', 'Only a chat receipt id is accepted')
      return toJson(params.method === 'chat.get' ? await ctx.chat.get(args.id) : await ctx.chat.cancel(args.id))
    }
    if (params.method === 'sessions.get' || params.method === 'sessions.remove') {
      authorize(params.method === 'sessions.get' ? 'sessions.read' : 'sessions.remove')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw new StudioError('INVALID_ARGUMENT', 'Only a session id is accepted')
      return toJson(params.method === 'sessions.get' ? await ctx.sessions.get(args.id) : await ctx.sessions.remove(args.id))
    }
    if (params.method === 'agents.list') { authorize('agents.read'); return jsonCopy(await ctx.agents.list()) as unknown as JsonValue }
    if (params.method === 'runs.start') {
      authorize('runs.start')
      return toJson(await ctx.runs.start(params.args as unknown as Parameters<ExecutionContext['runs']['start']>[0]))
    }
    if (['runs.cancel', 'runs.interactions', 'runs.respond', 'runs.usage'].includes(String(params.method))) {
      authorize(params.method === 'runs.cancel' ? 'runs.cancel' : params.method === 'runs.respond' ? 'runs.respond' : 'runs.read')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id' && !(params.method === 'runs.respond' && key === 'input'))) throw new StudioError('INVALID_ARGUMENT', 'Invalid run operation')
      if (params.method === 'runs.cancel') return toJson(await ctx.runs.cancel(args.id))
      if (params.method === 'runs.interactions') return toJson(await ctx.runs.interactions(args.id))
      if (params.method === 'runs.usage') return toJson(await ctx.runs.usage(args.id))
      return toJson(await ctx.runs.respond(args.id, args.input as unknown as Parameters<ExecutionContext['runs']['respond']>[1]))
    }
    if (params.method === 'runs.get' || params.method === 'runs.output') {
      authorize('runs.read')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Run id is required')
      return toJson(params.method === 'runs.get' ? await ctx.runs.get(args.id) : await ctx.runs.output(args.id, args.after === undefined ? -1 : Number(args.after)))
    }
    throw new StudioError('FORBIDDEN', 'Unknown context operation')
  }

  private fail(): void {
    if (this.closed) return
    this.closed = true
    this.peer.close()
    const error = new StudioError('PLUGIN_UNAVAILABLE', 'Plugin worker exited')
    for (const lease of this.managementLeases.values()) lease.cancel()
    for (const run of this.runs.values()) { run.channel.finish(error); run.reject(error); void run.release().catch(() => this.logger.error('Plugin model cleanup failed')) }
    this.runs.clear(); this.runtimes.clear(); this.scopes.clear(); this.authorities.clear()
    for (const registration of this.runtimeCommands.values()) registration.dispose()
    this.runtimeCommands.clear()
    void this.processes.close().catch(() => this.logger.error('Plugin process cleanup failed'))
    void this.models.close().catch(() => this.logger.error('Plugin model cleanup failed'))
    void this.mcp.close().catch(() => this.logger.error('Plugin MCP cleanup failed'))
    try { this.onExit() } catch { this.logger.error('Plugin cleanup failed') }
  }
}
