import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { StudioError, nativeAgentLaunch, readAgentImages, mergeAgentContextConfiguration,
  type AgentContextConfiguration, type AgentOutputEvent, type AgentRunHandle, type AgentRunResult,
  type AgentRuntime, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle, type ModelGatewayInput, type RuntimeCreateInput } from '@ekko-studio/plugin-sdk'
import { AcpConnection, acpAutomaticApproval } from './connection'
import { AgentEventQueue } from '../events/queue'
import { ManagedProcessTransport } from '../process/transport'
import { acpMcpServers } from './events'

export interface AcpRuntimeOptions {
  name: string; command: string; args: string[]; protocol?: ModelGatewayInput['protocol'] | ((model: string) => ModelGatewayInput['protocol'])
  prepareScoped?(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle, config: JsonObject): Promise<{ args: string[]; env: Record<string, string> }>
  environment?(config: JsonObject, runtime: AgentRuntimeContext, signal: AbortSignal): Promise<Record<string, string>>
  /** Some native launches select a model in memory rather than through ACP's persisted model selector. */
  promptConfiguration?(requested: { model?: string; reasoningEffort?: string }): { model?: string; reasoningEffort?: string }
  commands?: { update(value: unknown): void; drain(): Promise<void> }
  /** Some ACP servers keep watchers after stdin EOF; confirm host cleanup after their final result. */
  completion?: 'exit' | 'managed-stop'
  /** A native server may require MCP at launch rather than accepting session/new declarations. */
  sessionMcp?: boolean
  prepareLaunch?(configuration: AgentContextConfiguration, runtime: AgentRuntimeContext): Promise<{ args: string[]; env?: Record<string, string>; dispose?(): Promise<void> }>
  /** The owning plugin interprets native application errors; the driver never branches on a vendor. */
  handleError?(error: unknown, emit: (event: Omit<AgentOutputEvent, 'producerSequence'>) => void): void
}

/** Standard ACP turn, approval, checkpoint and cleanup lifecycle. Native configuration stays in the plugin. */
export function createAcpRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext, options: AcpRuntimeOptions): AgentRuntime {
  const config = input.config
  const contextConfiguration = mergeAgentContextConfiguration(config as AgentContextConfiguration)
  const cwd = String(config.cwd), scoped = input.mode === 'scoped'
  if (scoped && (!runtime.stateDirectory || !options.prepareScoped)) throw new StudioError('CAPABILITY_UNSUPPORTED', `Scoped ${options.name} requires host-managed storage`)
  if (!isAbsolute(cwd)) throw new StudioError('INVALID_ARGUMENT', `${options.name} working directory must be absolute`)
  let nativeSessionId: string | undefined
  if (input.resume !== undefined) {
    const resume = input.resume as JsonObject
    if (!resume || typeof resume !== 'object' || Array.isArray(resume) || Object.keys(resume).some(key => key !== 'nativeSessionId')
      || typeof resume.nativeSessionId !== 'string' || !resume.nativeSessionId || resume.nativeSessionId.length > 4096) {
      throw new StudioError('INVALID_ARGUMENT', `Invalid ${options.name} resume checkpoint`)
    }
    nativeSessionId = resume.nativeSessionId
  }
  let active: AgentRunHandle | undefined
  const commands = options.commands || { update() {}, async drain() {} }
  let ended = false
  return {
    async run(input, ctx) {
      if (ended || runtime.signal.aborted) throw new StudioError('CANCELLED', `${options.name} runtime ended`)
      if (active) throw new StudioError('REVISION_CONFLICT', `${options.name} is already running`)
      const events = new AgentEventQueue<AgentOutputEvent>()
      let sequence = 0, cancelled = ctx.signal.aborted, transport: ManagedProcessTransport | undefined, connection: AcpConnection | undefined
      let gateway: import('@ekko-studio/plugin-sdk').ModelGatewayHandle | undefined
      let prepared: Awaited<ReturnType<NonNullable<AcpRuntimeOptions['prepareLaunch']>>> | undefined
      let cleanupFailure: unknown
      const tools = new Map<string, string>()
      const finishedTools = new Set<string>()
      const pending = new Map<string, { choices: Set<string>; resolve(choice: string | null): void }>()
      const emit = (event: Omit<AgentOutputEvent, 'producerSequence'>) => events.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
      const stop = () => {
        cancelled = true
        connection?.cancel()
        for (const entry of pending.values()) entry.resolve(null)
        pending.clear()
        return transport?.dispose()
      }
      const aborted = () => { void Promise.resolve(stop()).catch(() => {}) }
      ctx.signal.addEventListener('abort', aborted, { once: true })
      const result = (async (): Promise<AgentRunResult> => {
        try {
          if (cancelled) return { status: 'cancelled' }
          const effectiveContext = mergeAgentContextConfiguration(contextConfiguration, ctx.nativeContext || {})
          const images = await readAgentImages(input.content, ctx)
          const nativeEnvironment = await options.environment?.(config, runtime, ctx.signal)
          const model = input.model || config.model as string | undefined
          if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', `Scoped ${options.name} requires a Studio model`)
          const protocol = typeof options.protocol === 'function' ? options.protocol(model || '') : options.protocol || 'anthropic'
          gateway = scoped ? await ctx.models.gateway({ model: model!, protocol }) : undefined
          if (gateway && images.size && gateway.images !== true) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
          const isolated = gateway ? await options.prepareScoped!(runtime, gateway, config) : undefined
          prepared = await options.prepareLaunch?.(effectiveContext, runtime)
          if (cancelled) return { status: 'cancelled' }
          const launch = nativeAgentLaunch(options.command, config, runtime)
          const process = await runtime.processes.spawn({ command: launch.command,
            args: [...launch.args, ...(isolated?.args || []), ...(prepared?.args || []), ...options.args], cwd, env: { ...config.env as Record<string, string>, ...nativeEnvironment, ...isolated?.env, ...prepared?.env } })
          transport = new ManagedProcessTransport(process)
          if (cancelled) return { status: 'cancelled' }
          connection = new AcpConnection(transport, {
            session(id) { nativeSessionId = id },
            update(update) {
              if (cancelled) return
              if (update?.sessionUpdate === 'available_commands_update') {
                commands.update(update.availableCommands)
              } else if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
                emit({ type: 'message.delta', messageId: 'answer', text: update.content.text } as AgentOutputEvent)
              } else if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
                emit({ type: 'reasoning.delta', messageId: 'reasoning', text: update.content.text } as AgentOutputEvent)
              } else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && typeof update.toolCallId === 'string') {
                const id = update.toolCallId
                if (finishedTools.has(id)) return
                if (!tools.has(id)) {
                  if (tools.size >= 256) throw new Error(`${options.name} tool call limit exceeded`)
                  const name = String(update.title || update.kind || 'tool')
                  tools.set(id, name)
                  emit({ type: 'tool.started', callId: id, name, data: update.rawInput ?? null } as AgentOutputEvent)
                }
                if (['completed', 'failed'].includes(update.status)) {
                  finishedTools.add(id)
                  emit({ type: update.status === 'failed' ? 'tool.failed' : 'tool.completed', callId: id, name: tools.get(id)!,
                    data: update.rawOutput ?? update.content ?? null } as AgentOutputEvent)
                }
              }
            },
            permission(request, signal) {
              if (signal.aborted || cancelled) return Promise.resolve(null)
              if (config.approvalRequired !== true) return Promise.resolve(acpAutomaticApproval(request))
              const requestId = randomUUID()
              return new Promise<string | null>((resolve, reject) => {
                const abort = () => finish(null)
                const finish = (choice: string | null) => {
                  signal.removeEventListener('abort', abort)
                  pending.delete(requestId)
                  resolve(choice)
                }
                pending.set(requestId, { choices: new Set(request.options.map(option => option.optionId)), resolve: finish })
                signal.addEventListener('abort', abort, { once: true })
                try {
                  emit({ type: 'interaction.requested', requestId, kind: 'approval',
                    prompt: String(request.toolCall.title || `${options.name} requests permission`).slice(0, 16384),
                    choices: request.options.map(option => ({ id: option.optionId, label: option.name })) } as AgentOutputEvent)
                } catch (error) { finish(null); reject(error) }
              })
            },
          })
          const rawText = input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          // The native parser owns all slash syntax, including a command
          // sent after idle disposal before its dynamic catalog is known.
          const native = /^\/[^\s]+/.test(rawText)
          const text = native ? rawText : [rawText, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n')
          const requested = { model: input.model || config.model as string | undefined, reasoningEffort: config.reasoningEffort as string | undefined }
          const selection = options.promptConfiguration?.(requested) ?? requested
          const reason = await connection.prompt({ cwd, text: !native && effectiveContext.systemPrompt ? `${effectiveContext.systemPrompt}\n\n${text}` : text,
            images: input.content.flatMap(block => block.type === 'image' ? [images.get(block.artifactId)!] : []),
            nativeSessionId, mcpServers: options.sessionMcp === false ? [] : acpMcpServers(effectiveContext.mcpServers || {}),
            ...selection })
          if (!cancelled && !['end_turn', 'max_tokens'].includes(reason)) throw new Error(`${options.name} stopped: ${reason}`)
          // A result frame does not prove that the CLI drained or exited.
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const exit = await Promise.race([transport.exited, new Promise<null>((resolve, reject) => {
              timer = setTimeout(() => options.completion === 'managed-stop' ? resolve(null) : reject(new Error(`${options.name} did not exit after its final result`)), 1500)
            })])
            if (exit === null) await transport.dispose()
            else if (!cancelled && exit.code !== 0) throw new Error(`${options.name} process failed after its final result`)
          } finally { clearTimeout(timer) }
          await commands.drain()
          return cancelled ? { status: 'cancelled' } : { status: 'completed', checkpoint: { nativeSessionId: nativeSessionId! } }
        } catch (error) {
          if (cancelled) return { status: 'cancelled' }
          options.handleError?.(error, emit)
          events.fail(error instanceof Error ? error : new Error(`${options.name} execution failed`))
          throw error
        } finally {
          connection?.dispose()
          ctx.signal.removeEventListener('abort', aborted)
          try {
            try { await transport?.dispose() }
            finally { try { if (!ctx.signal.aborted) await gateway?.dispose() } finally { await prepared?.dispose?.() } }
          }
          catch (error) { cleanupFailure = error; throw error }
          finally { events.end(); active = undefined }
        }
      })()
      void result.catch(() => {})
      const handle: AgentRunHandle = { events, result,
        async cancel() {
          await stop()
          // Execution failure is already reported by result. Disposal
          // must still fail when the actual process cleanup is unconfirmed.
          await result.catch(() => {})
          if (cleanupFailure) throw cleanupFailure
        },
        async respond(response) {
          const entry = pending.get(response.requestId)
          if (!entry || !response.choiceId || !entry.choices.has(response.choiceId) || response.text !== undefined) {
            throw new StudioError('INVALID_ARGUMENT', `${options.name} approval is unavailable or the choice is invalid`)
          }
          entry.resolve(response.choiceId)
        },
      }
      active = handle
      return handle
    },
    async dispose(reason) { ended = true; await active?.cancel(reason) },
  }
}
