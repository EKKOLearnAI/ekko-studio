import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { AcpConnection, AgentEventQueue, ManagedProcessTransport, acpMcpServers } from '@ekko-studio/agent-drivers'
import { StudioError, readAgentImages, type AgentOutputEvent, type AgentRunHandle, type AgentRunResult, type JsonObject, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { scopedQwen } from './scoped'
import { management } from './management'

const schema = {
  type: 'object', required: ['cwd'], additionalProperties: false,
  properties: {
    cwd: { type: 'string', minLength: 1, maxLength: 4096 },
    command: { type: 'string', minLength: 1, maxLength: 4096 },
    args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
    env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
    model: { type: 'string', minLength: 1, maxLength: 256 },
    reasoningEffort: { type: 'string', minLength: 1, maxLength: 64 },
    systemPrompt: { type: 'string', maxLength: 65536 },
    mcpServers: { type: 'object', maxProperties: 32, additionalProperties: { type: 'object' } },
  },
} as const

const plugin: StudioPlugin = {
  apply(plugin) {
    plugin.agents.register({
      id: 'qwen', name: 'Qwen Code', configSchema: schema as unknown as JsonObject,
      management,
      capabilities: { text: true, images: true, streaming: true, reasoning: true, approvals: true, resume: true, persistentSession: true, modes: ['scoped', 'global'] },
      async create(input, runtime) {
        const config = input.config
        const cwd = String(config.cwd), scoped = input.mode === 'scoped'
        if (scoped && !runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Qwen requires host-managed storage')
        if (!isAbsolute(cwd)) throw new StudioError('INVALID_ARGUMENT', 'Qwen working directory must be absolute')
        let nativeSessionId: string | undefined
        if (input.resume !== undefined) {
          const resume = input.resume as JsonObject
          if (!resume || typeof resume !== 'object' || Array.isArray(resume) || Object.keys(resume).some(key => key !== 'nativeSessionId')
            || typeof resume.nativeSessionId !== 'string' || !resume.nativeSessionId || resume.nativeSessionId.length > 4096) {
            throw new StudioError('INVALID_ARGUMENT', 'Invalid Qwen resume checkpoint')
          }
          nativeSessionId = resume.nativeSessionId
        }
        let active: AgentRunHandle | undefined
        let ended = false
        return {
          async run(input, ctx) {
            if (ended || runtime.signal.aborted) throw new StudioError('CANCELLED', 'Qwen runtime ended')
            if (active) throw new StudioError('REVISION_CONFLICT', 'Qwen is already running')
            const events = new AgentEventQueue<AgentOutputEvent>()
            let sequence = 0, cancelled = ctx.signal.aborted, transport: ManagedProcessTransport | undefined, connection: AcpConnection | undefined
            let gateway: import('@ekko-studio/plugin-sdk').ModelGatewayHandle | undefined
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
                const images = await readAgentImages(input.content, ctx)
                const model = input.model || config.model as string | undefined
                if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', 'Scoped Qwen requires a Studio model')
                gateway = scoped ? await ctx.models.gateway({ model: model!, protocol: 'anthropic' }) : undefined
                if (gateway && images.size && gateway.images !== true) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
                const isolated = gateway ? await scopedQwen(runtime, gateway) : undefined
                if (cancelled) return { status: 'cancelled' }
                const process = await runtime.processes.spawn({ command: String(config.command || 'qwen'),
                  args: [...(config.args as string[] || []), ...(isolated?.args || []), '--acp'], cwd, env: { ...config.env as Record<string, string>, ...isolated?.env } })
                transport = new ManagedProcessTransport(process)
                if (cancelled) return { status: 'cancelled' }
                connection = new AcpConnection(transport, {
                  session(id) { nativeSessionId = id },
                  update(update) {
                    if (cancelled) return
                    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
                      emit({ type: 'message.delta', messageId: 'answer', text: update.content.text } as AgentOutputEvent)
                    } else if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
                      emit({ type: 'reasoning.delta', messageId: 'reasoning', text: update.content.text } as AgentOutputEvent)
                    } else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && typeof update.toolCallId === 'string') {
                      const id = update.toolCallId
                      if (finishedTools.has(id)) return
                      if (!tools.has(id)) {
                        if (tools.size >= 256) throw new Error('Qwen tool call limit exceeded')
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
                          prompt: String(request.toolCall.title || 'Qwen Code requests permission').slice(0, 16384),
                          choices: request.options.map(option => ({ id: option.optionId, label: option.name })) } as AgentOutputEvent)
                      } catch (error) { finish(null); reject(error) }
                    })
                  },
                })
                const text = input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
                const reason = await connection.prompt({ cwd, text: config.systemPrompt ? `${config.systemPrompt}\n\n${text}` : text,
                  images: input.content.flatMap(block => block.type === 'image' ? [images.get(block.artifactId)!] : []),
                  nativeSessionId, mcpServers: acpMcpServers(config.mcpServers as Record<string, unknown> || {}),
                  model: input.model || config.model as string | undefined, reasoningEffort: config.reasoningEffort as string | undefined })
                if (!cancelled && !['end_turn', 'max_tokens'].includes(reason)) throw new Error(`Qwen stopped: ${reason}`)
                // A result frame does not prove that the CLI drained or exited.
                let timer: ReturnType<typeof setTimeout> | undefined
                try {
                  const exit = await Promise.race([transport.exited, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Qwen did not exit after its final result')), 1500)
                  })])
                  if (!cancelled && exit.code !== 0) throw new Error('Qwen process failed after its final result')
                } finally { clearTimeout(timer) }
                return cancelled ? { status: 'cancelled' } : { status: 'completed', checkpoint: { nativeSessionId: nativeSessionId! } }
              } catch (error) {
                if (cancelled) return { status: 'cancelled' }
                events.fail(error instanceof Error ? error : new Error('Qwen execution failed'))
                throw error
              } finally {
                connection?.dispose()
                ctx.signal.removeEventListener('abort', aborted)
                try { try { await transport?.dispose() } finally { if (!ctx.signal.aborted) await gateway?.dispose() } }
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
                  throw new StudioError('INVALID_ARGUMENT', 'Qwen approval is unavailable or the choice is invalid')
                }
                entry.resolve(response.choiceId)
              },
            }
            active = handle
            return handle
          },
          async dispose(reason) { ended = true; await active?.cancel(reason) },
        }
      },
    })
  },
}
export const apply = plugin.apply
