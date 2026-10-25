import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { AgentEventQueue, ManagedProcessTransport, acpCommandCatalog, acpAutomaticApproval } from '@ekko-studio/agent-drivers'
import { StudioError, mergeAgentContextConfiguration, nativeAgentLaunch, readAgentImages, type AgentContextConfiguration,
  type AgentOutputEvent, type AgentRunHandle, type AgentRunResult, type AgentRuntime, type AgentRuntimeContext, type JsonObject,
  type ModelGatewayHandle, type RuntimeCreateInput } from '@ekko-studio/plugin-sdk'
import { DshAcpTurn } from './acp-turn'
import { dshDirectories, installationCommand } from './configuration'
import { DSH_API_KEY_ENV, DSH_MODEL_PROVIDER, prepareDshRuntime } from './runtime-config'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
export function createDshRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext): AgentRuntime {
  const config = input.config, cwd = String(config.cwd), scoped = input.mode === 'scoped', directories = dshDirectories(config, runtime)
  if (!isAbsolute(cwd) || !directories.rootDir) throw new StudioError('CAPABILITY_UNSUPPORTED', 'DSH requires an absolute workspace and host-managed storage')
  const rootDir = directories.rootDir, saved = mergeAgentContextConfiguration(config as AgentContextConfiguration)
  let nativeSessionId: string | undefined, active: AgentRunHandle | undefined, disposed = false
  if (input.resume !== undefined) {
    const resume = input.resume as JsonObject
    if (!resume || typeof resume !== 'object' || Array.isArray(resume) || Object.keys(resume).some(key => key !== 'nativeSessionId')
      || typeof resume.nativeSessionId !== 'string' || !resume.nativeSessionId || resume.nativeSessionId.length > 4096) throw new StudioError('INVALID_ARGUMENT', 'Invalid DSH checkpoint')
    nativeSessionId = resume.nativeSessionId
  }
  const commands = acpCommandCatalog(runtime, { pluginId: 'studio.agent-dsh', agentTypeId: 'dsh', name: 'DeepSeek Harness' })
  return {
    async run(input, ctx) {
      if (disposed || runtime.signal.aborted || active) throw new StudioError('RUNTIME_UNAVAILABLE', 'DSH runtime is unavailable or busy')
      const events = new AgentEventQueue<AgentOutputEvent>(), pending = new Map<string, { choices: Set<string>; resolve(choice: string | null): void }>()
      let sequence = 0, cancelled = ctx.signal.aborted, turn: DshAcpTurn | undefined, transport: ManagedProcessTransport | undefined, gateway: ModelGatewayHandle | undefined, cleanupFailure: unknown
      const tools = new Map<string, string>(), completedTools = new Set<string>(), reportedCalls = new Set<string>()
      const emit = (event: Output) => events.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
      const stop = async () => {
        cancelled = true; turn?.cancel(); for (const entry of pending.values()) entry.resolve(null); pending.clear()
        try { await transport?.dispose() } catch (error) { cleanupFailure = error; disposed = true; throw error }
      }
      const abort = () => { void stop().catch(() => {}) }
      ctx.signal.addEventListener('abort', abort, { once: true })
      const result = (async (): Promise<AgentRunResult> => {
        try {
          if (cancelled) return { status: 'cancelled' }
          const text = input.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          if (/^\/compact(?:\s|$)/.test(text)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'DSH ACP does not expose native compaction')
          const images = await readAgentImages(input.content, ctx), model = input.model || config.model as string | undefined
          if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', 'Scoped DSH requires a Studio model')
          gateway = scoped ? await ctx.models.gateway({ model: model!, protocol: 'responses' }) : undefined
          if (gateway && images.size && gateway.images !== true) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
          const effective = mergeAgentContextConfiguration(saved, ctx.nativeContext || {})
          const managedMcp: Record<string, Record<string, unknown>> = {}
          for (const [name, server] of Object.entries(effective.mcpServers || {})) {
            if (server.type === 'sse') throw new StudioError('CAPABILITY_UNSUPPORTED', 'DSH supports stdio and Streamable HTTP MCP only')
            const { disabled: _disabled, ...native } = server
            managedMcp[name] = { ...native, ...(server.disabled === true ? { enabled: false } : {}) }
          }
          const prepared = await prepareDshRuntime({ ...directories, rootDir, installationCommand: await installationCommand(config, runtime),
            systemPrompt: [effective.systemPrompt, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n'), managedMcp,
            ...(gateway ? { model: 'studio-model', baseUrl: gateway.baseUrl, imageInput: gateway.images === true,
              contextWindow: config.contextWindow as number | undefined, outputLimit: config.outputLimit as number | undefined,
              contextPolicy: { threshold: 0.8 } } : {}), reasoningEffort: config.reasoningEffort as string | undefined })
          if (cancelled) return { status: 'cancelled' }
          const launch = nativeAgentLaunch('dsh', config, runtime)
          const handle = await runtime.processes.spawn({ command: launch.command, args: [...launch.args, ...prepared.args], cwd,
            env: { ...config.env as Record<string, string>, ...prepared.env, DSH_TELEMETRY_DISABLED: '1', ...(gateway ? { [DSH_API_KEY_ENV]: gateway.token } : {}) } })
          transport = new ManagedProcessTransport(handle)
          turn = new DshAcpTurn(transport, {
            session(id) { nativeSessionId = id }, config() {}, warning(message) { runtime.logger.warn(message) },
            update(update) {
              if (cancelled) return
              if (update?.sessionUpdate === 'available_commands_update') commands.update((update.availableCommands || []).filter((command: any) => command.name !== 'compact'))
              else if (['agent_message_chunk', 'agent_thought_chunk'].includes(update?.sessionUpdate) && update.content?.type === 'text') emit({ type: update.sessionUpdate === 'agent_message_chunk' ? 'message.delta' : 'reasoning.delta', messageId: update.sessionUpdate === 'agent_message_chunk' ? 'answer' : 'reasoning', text: update.content.text })
              else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && typeof update.toolCallId === 'string') {
                const id = update.toolCallId
                if (completedTools.has(id)) return
                if (!tools.has(id)) { if (tools.size >= 256) throw new Error('DSH tool call limit exceeded'); tools.set(id, String(update.title || update.kind || 'tool')); emit({ type: 'tool.started', callId: id, name: tools.get(id)!, data: update.rawInput ?? null }) }
                if (['completed', 'failed'].includes(update.status)) { completedTools.add(id); emit({ type: update.status === 'failed' ? 'tool.failed' : 'tool.completed', callId: id, name: tools.get(id)!, data: update.rawOutput ?? update.content ?? null }) }
              }
            },
            usage(event) {
              if (scoped || !event || typeof event.requestId !== 'string' || !event.requestId || event.requestId.length > 256 || reportedCalls.has(event.requestId)) return
              if (reportedCalls.size >= 1024) throw new Error('DSH model usage limit exceeded')
              const usage = event.usage
              if (!usage || !['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
                || ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].some(key => usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0))) throw new Error('Invalid DSH model usage')
              const inputTokens = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
              if (!Number.isSafeInteger(inputTokens)) throw new Error('Invalid DSH total input usage')
              reportedCalls.add(event.requestId)
              emit({ type: 'usage.reported', modelCallId: event.requestId, model: String(event.model || model || 'unknown'), mode: 'final', revision: 1,
                inputTokens, outputTokens: usage.outputTokens, ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
                ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}), ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}) })
            },
            permission(request, signal) {
              if (signal.aborted || cancelled) return Promise.resolve(null)
              if (config.approvalRequired !== true) return Promise.resolve(acpAutomaticApproval(request))
              const requestId = randomUUID()
              return new Promise(resolve => {
                const finish = (choice: string | null) => { pending.delete(requestId); signal.removeEventListener('abort', abort); resolve(choice) }, abort = () => finish(null)
                pending.set(requestId, { choices: new Set(request.options.map(option => option.optionId)), resolve: finish }); signal.addEventListener('abort', abort, { once: true })
                emit({ type: 'interaction.requested', requestId, kind: 'approval', prompt: String(request.toolCall?.title || 'DSH permission required').slice(0, 16384), choices: request.options.map(option => ({ id: option.optionId, label: option.name })) })
              })
            },
          })
          const reason = await turn.prompt({ cwd, nativeSessionId, agentPreset: config.agentPreset as string | undefined,
            ...(gateway ? { modelValue: JSON.stringify([DSH_MODEL_PROVIDER, 'studio-model']) } : model ? { modelValue: model } : {}),
            reasoningEffort: config.reasoningEffort as string | undefined, text, images: input.content.flatMap(block => block.type === 'image' ? [images.get(block.artifactId)!] : []) })
          if (!cancelled && !['end_turn', 'max_tokens'].includes(reason)) throw new Error(`DSH stopped: ${reason}`)
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const exit = await Promise.race([transport.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DSH did not exit after closing its session')), 1500) })])
            if (!cancelled && exit.code !== 0) throw new Error('DSH process failed after its final result')
          } finally { clearTimeout(timer) }
          await commands.drain()
          return cancelled ? { status: 'cancelled' } : { status: 'completed', checkpoint: { nativeSessionId: nativeSessionId! } }
        } catch (error) { if (cancelled) return { status: 'cancelled' }; events.fail(error instanceof Error ? error : new Error('DSH execution failed')); throw error }
        finally {
          turn?.dispose(); ctx.signal.removeEventListener('abort', abort)
          try { try { await transport?.dispose() } finally { if (!ctx.signal.aborted) await gateway?.dispose() } }
          catch (error) { cleanupFailure = error; disposed = true; throw error }
          finally { events.end(); active = undefined }
        }
      })()
      void result.catch(() => {})
      const handle: AgentRunHandle = { events, result, async cancel() { await stop(); await result.catch(() => {}); if (cleanupFailure) throw cleanupFailure },
        async respond(response) { const entry = pending.get(response.requestId); if (!entry || !response.choiceId || !entry.choices.has(response.choiceId) || response.text !== undefined) throw new StudioError('INVALID_ARGUMENT', 'DSH approval choice is unavailable or invalid'); entry.resolve(response.choiceId) } }
      active = handle; return handle
    },
    async dispose(reason) { disposed = true; await active?.cancel(reason) },
  }
}
