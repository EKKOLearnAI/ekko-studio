import { fork, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { RpcPeer, type RpcFrame } from '../../../../../../studio-plugin-sdk/src/rpc'
import {
  StudioError, STUDIO_ERROR_CODES, STUDIO_PLUGIN_RPC_VERSION, type StudioErrorCode, type AgentTypeDefinition, type AgentRuntime, type AgentRuntimeContext,
  type AgentRunContext, type AgentRunHandle, type AgentOutputEvent, type AgentRunResult,
  type ExecutionContext, type JsonValue, type JsonObject, type PluginIdentity, type ScopedLogger, type ServiceToken, type EventConsumerSpec, type EventEnvelope, type AgentTypeSummary,
} from '../../contracts/plugins'
import type { ServiceAuthority } from './services'
import { jsonCopy, toJson, parseAgentOutput, parseAgentInspection } from './validation'
import { AsyncChannel } from './channel'
import { authorizeHookOperation, type HookRegistration } from '../events/plugin-hooks'
import { PluginProcessBridge } from './processes'
import { managedProcessEnvironment } from '../processes/managed'
import { PluginMcpBridge } from './mcp'
import { PluginModelBridge } from './models'

export interface WorkerActivation {
  agents: Array<Omit<AgentTypeSummary, 'provider'>>
  subscriptions: Array<{ id: string; type: string; once: boolean }>
  services: ServiceToken[]
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
  private serviceCalls = 0
  private consumerCalls = 0
  private hookCalls = 0
  private managementCalls = 0
  callService?: (context: ExecutionContext, args: JsonObject, authority: ServiceAuthority) => Promise<JsonValue>
  private readonly runs = new Map<string, RemoteRun>()
  private readonly runtimes = new Set<string>()
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
    if (!result || result.rpc !== STUDIO_PLUGIN_RPC_VERSION || !Array.isArray(result.agents) || !Array.isArray(result.subscriptions) || !Array.isArray(result.services) || !Array.isArray(result.consumers) || !Array.isArray(result.hooks)) {
      throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin activation response')
    }
    return result as unknown as WorkerActivation
  }

  definition(meta: Omit<AgentTypeSummary, 'provider'>): AgentTypeDefinition {
    const { management, ...metadata } = jsonCopy(meta)
    if (management !== undefined && (!management || management.inspect !== true || Object.keys(management).length !== 1)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent management declaration')
    return {
      ...metadata,
      ...(management ? { management: { inspect: async (input, context) => {
        if (context.signal.aborted) throw new StudioError('CANCELLED', 'Management scope ended')
        this.authorize('agents.register')
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
          try { this.authorize('agents.register') }
          catch (error) {
            void this.peer.request('management.cancel', { callId }, 1_000).catch(() => {})
            rejectAbort(error)
          }
        }, 250)
        context.signal.addEventListener('abort', abort, { once: true })
        const task = Promise.resolve().then(() => this.peer.request('management.inspect', toJson({ callId, agentTypeId: meta.id,
          runtimeHandle: processScope.handle, ownerId: context.ownerId, input }))).finally(() => { finished = true })
        if (context.signal.aborted) abort()
        try {
          const result = await Promise.race([task, cancelled])
          this.authorize('agents.register')
          return parseAgentInspection(result)
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
      } } } : {}),
      create: async (input, context): Promise<AgentRuntime> => {
        const id = context.runtimeSessionId
        if (context.signal.aborted) throw new StudioError('CANCELLED', 'Runtime scope ended')
        if (this.runtimes.has(id)) throw new StudioError('REGISTRATION_CONFLICT', 'Runtime is already active')
        // Creation itself owns a lease: configuration changes must not kill an in-flight factory.
        const processScope = this.processes.mount(context)
        const mcpScope = this.mcp.mount(context, processScope.handle)
        const releaseResources = async () => {
          const results = await Promise.allSettled([processScope.close(), mcpScope.close()])
          const failed = results.find(result => result.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
        }
        this.runtimes.add(id)
        try { await this.peer.request('runtime.create', toJson({ agentTypeId: meta.id, runtimeSessionId: id, runtimeHandle: processScope.handle, ownerId: context.ownerId, ...(context.stateDirectory ? { stateDirectory: context.stateDirectory } : {}), input })) }
        catch (error) {
          this.runtimes.delete(id)
          try { await releaseResources() } finally { await this.close() }
          throw error
        }
        let disposal: Promise<void> | undefined
        const dispose = (reason: string): Promise<void> => disposal ??= (async () => {
          context.signal.removeEventListener('abort', aborted)
          try { await this.peer.request('runtime.dispose', { runtimeSessionId: id, reason }, 5_000) }
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
      const response = await this.peer.request('run.start', toJson({ runId, runtimeSessionId, input, scope: ctx.scope, scopeHandle }))
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
  hasLeases(): boolean { return this.runtimes.size > 0 || this.runs.size > 0 || this.serviceCalls > 0 || this.consumerCalls > 0 || this.hookCalls > 0 || this.managementCalls > 0 }
  isAvailable(): boolean { return !this.closed }

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
      const results = await Promise.allSettled([this.processes.close(), this.mcp.close(), this.models.close()])
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
    for (const run of this.runs.values()) { run.channel.finish(error); run.reject(error); void run.release().catch(() => this.logger.error('Plugin model cleanup failed')) }
    this.runs.clear(); this.runtimes.clear(); this.scopes.clear(); this.authorities.clear()
    void this.processes.close().catch(() => this.logger.error('Plugin process cleanup failed'))
    void this.models.close().catch(() => this.logger.error('Plugin model cleanup failed'))
    void this.mcp.close().catch(() => this.logger.error('Plugin MCP cleanup failed'))
    try { this.onExit() } catch { this.logger.error('Plugin cleanup failed') }
  }
}
