import { isAbsolute } from 'node:path'
import { AgentEventQueue, NativeRpcConnection } from '@ekko-studio/agent-drivers'
import { StudioError, nativeAgentLaunch, readAgentImages, agentContextConfigurationProperties, mergeAgentContextConfiguration, type AgentContextConfiguration, type AgentOutputEvent, type AgentRunHandle, type AgentRunResult, type JsonObject, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { codexEvents } from './events'
import { codexInteractions } from './interactions'
import { scopedCodex } from './scoped'
import { management } from './management'
import { compactCommand, isCompact } from './commands'
import { codexContextConfiguration } from './configuration'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
const schema: JsonObject = {
  type: 'object', required: ['cwd'], additionalProperties: false,
  properties: {
    cwd: { type: 'string', minLength: 1, maxLength: 4096 },
    command: { type: 'string', minLength: 1, maxLength: 4096 },
    args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
    env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
    model: { type: 'string', minLength: 1, maxLength: 256 },
    effort: { type: 'string', minLength: 1, maxLength: 64 },
    developerInstructions: { type: 'string', maxLength: 65536 },
    systemPrompt: agentContextConfigurationProperties.systemPrompt,
    mcpServers: agentContextConfigurationProperties.mcpServers,
    studioMcp: agentContextConfigurationProperties.studioMcp,
    approvalPolicy: { type: 'string', enum: ['untrusted', 'on-request', 'never'], default: 'never' },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], default: 'danger-full-access' },
  },
}

interface Turn {
  id?: string
  cancelled: boolean
  completed: boolean
  notification(method: string, params: Record<string, any>): void
  request(method: string, params: Record<string, any>, signal: AbortSignal, id: string | number): Promise<unknown>
  handle: AgentRunHandle
}

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.commands.register(compactCommand.definition, compactCommand.handler)
  plugin.agents.register({
    id: 'codex', name: 'Codex', configSchema: schema,
    management,
    capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: true, clarifications: true, resume: true,
      resumeConfigKeys: ['model', 'effort', 'developerInstructions', 'systemPrompt', 'mcpServers', 'studioMcp', 'approvalPolicy', 'sandbox'], nativeMcp: true, persistentSession: true, modes: ['scoped', 'global'] },
    async create(input, runtime) {
      const config = input.config, cwd = String(config.cwd), scoped = input.mode === 'scoped'
      const contextConfiguration = mergeAgentContextConfiguration(config as AgentContextConfiguration,
        { systemPrompt: config.developerInstructions as string | undefined })
      codexContextConfiguration(contextConfiguration) // Validate saved overrides before opening the native process.
      if (scoped && !runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Codex requires host-managed storage')
      if (!isAbsolute(cwd)) throw new StudioError('INVALID_ARGUMENT', 'Codex working directory must be absolute')
      let threadId: string | undefined, resumed = false
      if (input.resume !== undefined) {
        const resume = input.resume as JsonObject
        if (!resume || typeof resume !== 'object' || Array.isArray(resume) || Object.keys(resume).some(key => key !== 'threadId')
          || typeof resume.threadId !== 'string' || !resume.threadId || resume.threadId.length > 4096) throw new StudioError('INVALID_ARGUMENT', 'Invalid Codex checkpoint')
        threadId = resume.threadId
      }
      let current: Turn | undefined, ended = false, rpc: NativeRpcConnection
      const open = async (env = config.env as Record<string, string> | undefined) => {
        const process = await runtime.processes.spawn({ command: nativeAgentLaunch('codex', config, runtime).command,
          args: [...nativeAgentLaunch('codex', config, runtime).args, 'app-server', '--listen', 'stdio://'], cwd, env })
        rpc = new NativeRpcConnection(process, {
          notification(method, params) { current?.notification(method, params) },
          async request(method, params, signal, id) {
            if (!current) throw new Error('No active Codex turn')
            return current.request(method, params, signal, id)
          },
        })
        try {
          await rpc.start()
          if (runtime.signal.aborted) throw new StudioError('CANCELLED', 'Codex runtime ended')
          await rpc.request('initialize', { clientInfo: { name: 'ekko_studio', title: 'Ekko Studio', version: '0.1.0' } })
          await rpc.notify('initialized')
        } catch (error) { await rpc.close(); throw error }
      }
      const aborted = () => { void rpc?.close().catch(() => {}) }
      runtime.signal.addEventListener('abort', aborted, { once: true })
      try { if (!scoped) await open() }
      catch (error) { runtime.signal.removeEventListener('abort', aborted); throw error }
      return {
        async run(input, ctx) {
          if (ended || current) throw new StudioError('RUNTIME_UNAVAILABLE', 'Codex runtime is unavailable or busy')
          const compact = isCompact(input)
          const events = new AgentEventQueue<AgentOutputEvent>()
          let sequence = 0, ready!: () => void, complete!: (status: string) => void
          const started = new Promise<void>(resolve => { ready = resolve })
          const terminal = new Promise<string>(resolve => { complete = resolve })
          const requests = new Set<string | number>()
          const emit = (event: Output) => events.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
          const project = codexEvents(emit)
          const interactions = codexInteractions(emit, config.approvalPolicy !== undefined && config.approvalPolicy !== 'never')
          const buffered: Array<[string, Record<string, any>]> = []
          let gateway: import('@ekko-studio/plugin-sdk').ModelGatewayHandle | undefined
          let bufferedBytes = 0, cancelTask: Promise<void> | undefined, closing: Promise<void> | undefined
          const turn: Turn = { cancelled: ctx.signal.aborted, completed: false, handle: undefined!,
            notification(method, params) {
              if (!threadId || params.threadId !== threadId) return
              if (method === 'serverRequest/resolved') {
                // Resolution can arrive in the same read batch, before the
                // async request callback has published any Studio questions.
                rpc.withdrawRequest(params.requestId)
                return
              }
              if (!turn.id) {
                if (compact && method === 'turn/started') {
                  const id = params.turn?.id
                  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid Codex compaction turn identity')
                  turn.id = id; ready()
                  for (const [method, params] of buffered.splice(0)) turn.notification(method, params)
                  return
                }
                bufferedBytes += Buffer.byteLength(JSON.stringify(params))
                if (buffered.length >= 128 || bufferedBytes > 4 * 1024 * 1024) throw new Error('Codex startup event limit exceeded')
                buffered.push([method, params]); return
              }
              if ((params.turnId || params.turn?.id) !== turn.id) return
              if (method === 'turn/completed') {
                turn.completed = true
                for (const id of requests) rpc.withdrawRequest(id)
                complete(String(params.turn?.status))
              }
              else if (!turn.cancelled) project(method, params)
            },
            async request(method, params, signal, id) {
              await Promise.race([started, rpc.closed])
              if (turn.completed) { rpc.withdrawRequest(id); return null }
              if (current !== turn || params.threadId !== threadId || params.turnId !== turn.id || turn.cancelled || signal.aborted) throw new Error('Codex request is outside the current turn')
              requests.add(id)
              try { return await interactions.request(method, params, signal) }
              finally { requests.delete(id) }
            },
          }
          current = turn
          const onAbort = () => { void turn.handle.cancel('Cancelled').catch(() => {}) }
          const result = (async (): Promise<AgentRunResult> => {
            try {
              // Install the handle and cancellation listener before admission.
              await Promise.resolve()
              if (turn.cancelled) return { status: 'cancelled' }
              const images = await readAgentImages(input.content, ctx)
              if (scoped) {
                const model = input.model || config.model as string | undefined
                if (!model) throw new StudioError('INVALID_ARGUMENT', 'Scoped Codex requires a Studio model')
                gateway = await ctx.models.gateway({ model, protocol: 'responses' })
                if (gateway && images.size && gateway.images !== true) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
                const env = await scopedCodex(runtime, gateway)
                if (turn.cancelled) return { status: 'cancelled' }
                await open({ ...config.env as Record<string, string>, ...env })
                resumed = false
                if (turn.cancelled) return { status: 'cancelled' }
              }
              if (!resumed) {
                const effectiveContext = mergeAgentContextConfiguration(contextConfiguration, ctx.nativeContext || {})
                const nativeConfiguration = codexContextConfiguration(effectiveContext)
                const overrides = { ...nativeConfiguration, ...(gateway?.transport === 'translated' ? { web_search: 'disabled' } : {}) }
                const parameters = { approvalPolicy: 'never', sandbox: 'danger-full-access', ...Object.fromEntries(['model', 'approvalPolicy', 'sandbox'].filter(key => config[key] !== undefined).map(key => [key, config[key]])),
                  ...(effectiveContext.systemPrompt ? { developerInstructions: effectiveContext.systemPrompt } : {}),
                  ...(Object.keys(overrides).length ? { config: overrides } : {}) }
                const response = await rpc.request(threadId ? 'thread/resume' : 'thread/start', { ...parameters, ...(gateway ? { model: gateway.model } : {}), cwd, ...(threadId ? { threadId } : {}) })
                if (typeof response?.thread?.id !== 'string' || !response.thread.id || response.thread.id.length > 4096
                  || (threadId && response.thread.id !== threadId)) throw new Error('Invalid Codex thread identity')
                threadId = response.thread.id; resumed = true
              }
              if (turn.cancelled) return { status: 'cancelled' }
              if (compact) {
                await rpc.request('thread/compact/start', { threadId })
              } else {
                const response = await rpc.request('turn/start', { threadId, input: input.content.map(block => {
                if (block.type === 'text') return block
                const image = images.get(block.artifactId)!
                return { type: 'image', url: `data:${image.mediaType};base64,${image.data}` }
              }).concat(ctx.nativeContext?.turnInstructions ? [{ type: 'text' as const, text: ctx.nativeContext.turnInstructions }] : []),
                ...(input.model || config.model ? { model: input.model || config.model } : {}), ...(config.effort ? { effort: config.effort } : {}) })
              if (typeof response?.turn?.id !== 'string' || !response.turn.id || response.turn.id.length > 256) throw new Error('Invalid Codex turn identity')
                turn.id = response.turn.id; ready()
                for (const [method, params] of buffered.splice(0)) turn.notification(method, params)
              }
              const status = await Promise.race([terminal, rpc.closed])
              if (status === 'interrupted') turn.cancelled = true
              if (turn.cancelled) return { status: 'cancelled' }
              if (status !== 'completed') throw new StudioError('RUNTIME_UNAVAILABLE', 'Codex turn failed')
              return { status: 'completed', checkpoint: { threadId: threadId! } }
            } catch (error) {
              if (turn.cancelled) return { status: 'cancelled' }
              events.fail(error instanceof Error ? error : new Error('Codex execution failed'))
              throw error
            } finally {
              ready(); ctx.signal.removeEventListener('abort', onAbort)
              interactions.close()
              try {
                try { if (turn.cancelled || scoped) await (closing ??= rpc?.close()) }
                finally { if (!ctx.signal.aborted) await gateway?.dispose() }
              }
              finally { events.end(); current = undefined }
            }
          })()
          void result.catch(() => {})
          const handle: AgentRunHandle = { events, result,
            cancel() {
              if (cancelTask) return cancelTask
              turn.cancelled = true
              closing = (async () => {
                // Scoped readers are bound to this Run. Close immediately when it ends;
                // waiting for an interrupt notification would read from an expired scope.
                if (turn.id && !scoped) {
                  let timer: ReturnType<typeof setTimeout> | undefined
                  try { await Promise.race([rpc.request('turn/interrupt', { threadId, turnId: turn.id }, 2000).then(() => terminal),
                    new Promise(resolve => { timer = setTimeout(resolve, 2000) })]) } catch {} finally { clearTimeout(timer) }
                }
                await rpc?.close()
              })()
              cancelTask = closing.then(async () => { await result.catch(() => {}) })
              return cancelTask
            },
            async respond(response) {
              return interactions.respond(response)
            },
          }
          turn.handle = handle
          ctx.signal.addEventListener('abort', onAbort, { once: true })
          if (ctx.signal.aborted) onAbort()
          return handle
        },
        async dispose(reason) {
          ended = true; runtime.signal.removeEventListener('abort', aborted)
          try { await current?.handle.cancel(reason) } finally { await rpc?.close() }
        },
      }
    },
  })
}
