import { randomUUID } from 'node:crypto'
import { AgentEventQueue } from '@ekko-studio/agent-drivers'
import { StudioError, mergeAgentContextConfiguration, nativeAgentLaunch, readAgentImages, type AgentContextConfiguration, type AgentOutputEvent,
  type AgentRunHandle, type AgentRunResult, type AgentRuntime, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle, type RuntimeCreateInput } from '@ekko-studio/plugin-sdk'
import { directories, prepareClaude, verifyScopedSettings } from './configuration'
import { claudeCommands } from './commands'
import { claudeEvents, usageTotals, type Output, type UsageTotals } from './events'
import { claudeInteractions } from './interactions'
import { ClaudeRpc, type ClaudeRecord } from './rpc'

interface Checkpoint { sessionId: string }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
function checkpoint(value: unknown): Checkpoint {
  const saved = value as Checkpoint
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => key !== 'sessionId')
    || !uuid(saved.sessionId)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude checkpoint')
  return structuredClone(saved)
}

export function createClaudeRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext): AgentRuntime {
  const config = input.config, cwd = String(config.cwd), mode = input.mode, scoped = mode === 'scoped'
  directories(config, input.mode, runtime)
  const saved = mergeAgentContextConfiguration(config as AgentContextConfiguration), commands = claudeCommands(runtime)
  let resume = input.resume === undefined ? undefined : checkpoint(input.resume), current: AgentRunHandle | undefined, disposed = false
  const runtimeAbort = () => { void current?.cancel('Runtime ended').catch(() => {}) }
  runtime.signal.addEventListener('abort', runtimeAbort, { once: true })
  return {
    async run(input, ctx) {
      if (disposed || runtime.signal.aborted || current) throw new StudioError('RUNTIME_UNAVAILABLE', 'Claude runtime is unavailable or busy')
      const queue = new AgentEventQueue<AgentOutputEvent>()
      let sequence = 0, cancelled = ctx.signal.aborted, disposing = false, failed = false, rpc: ClaudeRpc | undefined, cleanupFailure: unknown
      let prepared: Awaited<ReturnType<typeof prepareClaude>> | undefined, gateway: ModelGatewayHandle | undefined
      let sessionId = resume?.sessionId || randomUUID(), baseline: UsageTotals = {}, nextUsage = baseline, nativeResult: ClaudeRecord | undefined, nativeFailure: unknown
      let terminalResolve!: () => void, terminalReject!: (error: unknown) => void
      const terminal = new Promise<void>((resolve, reject) => { terminalResolve = resolve; terminalReject = reject }); void terminal.catch(() => {})
      let rejectFailure!: (error: unknown) => void
      const failedNative = new Promise<never>((_, reject) => { rejectFailure = reject }); void failedNative.catch(() => {})
      const emit = (event: Output) => queue.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
      const project = claudeEvents(emit), interactions = claudeInteractions(emit, config.permissionMode !== undefined && config.permissionMode !== 'bypassPermissions')
      const fail = (error: unknown) => { if (disposing) return; nativeFailure ??= error; terminalReject(error); rejectFailure(error) }
      const nativeEvent = (event: ClaudeRecord) => {
        if (cancelled || disposing) return
        if (event.type === 'control_request') {
          void interactions.request(event).then(async response => {
            if (!cancelled && !disposing && !interactions.isWithdrawn(event.request_id)) await rpc!.send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response } })
          }).catch(fail)
          return
        }
        if (event.type === 'control_cancel_request') { interactions.withdraw(event.request_id); return }
        if (event.type === 'system' && event.subtype === 'commands_changed') { commands.update(event.commands); return }
        if (event.type === 'conversation_reset') {
          if (!uuid(event.new_conversation_id)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude conversation reset')
          sessionId = event.new_conversation_id; baseline = {}; nextUsage = {}; return
        }
        if (event.session_id !== undefined && event.session_id !== sessionId) throw new StudioError('INVALID_ARGUMENT', 'Claude native session identity changed')
        if (event.type === 'assistant' && (event.isApiErrorMessage || event.error)) nativeFailure ??= new StudioError('RUNTIME_UNAVAILABLE', 'Claude model request failed')
        else if (project.record(event) === false) nativeFailure ??= new StudioError('RUNTIME_UNAVAILABLE', 'Claude native command failed')
        if (event.type === 'result') {
          if (nativeResult) throw new StudioError('INVALID_ARGUMENT', 'Claude produced more than one result for a single turn')
          nativeResult = event
          if (event.modelUsage !== undefined) nextUsage = usageTotals(event.modelUsage)
          if (!scoped) for (const [model, usage] of Object.entries(nextUsage)) {
            const previous = Object.hasOwn(baseline, model) ? baseline[model] : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            if (usage.input < previous.input || usage.output < previous.output || usage.cacheRead < previous.cacheRead || usage.cacheWrite < previous.cacheWrite
              || (usage.reasoning !== undefined && usage.reasoning < (previous.reasoning || 0))) throw new StudioError('INVALID_ARGUMENT', 'Claude cumulative usage moved backwards')
            if (usage.input !== previous.input || usage.output !== previous.output) emit({ type: 'usage.reported',
              modelCallId: `claude-${ctx.scope.runId}-${Object.keys(nextUsage).indexOf(model)}`, model, mode: 'final', revision: 1,
              inputTokens: usage.input - previous.input, outputTokens: usage.output - previous.output,
              cacheReadTokens: usage.cacheRead - previous.cacheRead, cacheWriteTokens: usage.cacheWrite - previous.cacheWrite,
              ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning - (previous.reasoning || 0) } : {}) })
          }
          if (event.subtype !== 'success' || event.is_error) nativeFailure ??= new StudioError('RUNTIME_UNAVAILABLE', 'Claude native turn failed')
          else project.final(event)
          terminalResolve()
        }
      }
      const stop = async () => {
        cancelled = true; terminalReject(new StudioError('CANCELLED', 'Claude run cancelled'))
        try { await rpc?.dispose() }
        catch (error) { cleanupFailure ??= error; disposed = true; throw error }
      }
      const abort = () => { void stop().catch(() => {}) }
      ctx.signal.addEventListener('abort', abort, { once: true })
      const result = (async (): Promise<AgentRunResult> => {
        let next: Checkpoint | undefined
        try {
          if (cancelled) return { status: 'cancelled' }
          const images = await readAgentImages(input.content, ctx), model = input.model || config.model as string | undefined
          if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', 'Scoped Claude Code requires a Studio model')
          gateway = scoped ? await ctx.models.gateway({ model: model!, protocol: 'anthropic' }) : undefined
          if (images.size && gateway && !gateway.images) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
          const configuration = mergeAgentContextConfiguration(saved, ctx.nativeContext || {})
          prepared = await prepareClaude({ ...config, ...(model ? { model } : {}) }, mode, runtime, configuration, gateway)
          if (cancelled) return { status: 'cancelled' }
          const launch = nativeAgentLaunch('claude', config, runtime)
          const process = await runtime.processes.spawn({ command: launch.command, cwd, args: [...launch.args, ...prepared.args,
            '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
            '--permission-prompt-tool', 'stdio', '--system-prompt-snapshot', 'off', ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])], env: prepared.env })
          rpc = new ClaudeRpc(process, nativeEvent, fail)
          void rpc.exited.then(exit => { if (!nativeResult && !cancelled) fail(new StudioError('RUNTIME_UNAVAILABLE', 'Claude exited without a native result')) })
          if (cancelled) return { status: 'cancelled' }
          await rpc.start()
          const initialized = await rpc.request('initialize', { agents: {}, systemPromptSnapshot: false,
            appendSystemPrompt: [prepared.nativePrompt, configuration.systemPrompt, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n') })
          commands.update(initialized.commands)
          // The native history may also contain a failed/cancelled prior turn.
          // Read its current cumulative baseline rather than re-counting it from
          // the last successful Studio checkpoint. skip_behaviors avoids scans.
          if (!scoped) baseline = usageTotals((await rpc.request('get_usage', { skip_behaviors: true }))?.session?.model_usage)
          else verifyScopedSettings((await rpc.request('get_settings'))?.effective, prepared.env.ANTHROPIC_BASE_URL)
          const content = input.content.map(part => part.type === 'text' ? { type: 'text', text: part.text }
            : part.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: images.get(part.artifactId)!.mediaType, data: images.get(part.artifactId)!.data } } : null).filter(Boolean)
          const userId = randomUUID()
          await rpc.send({ type: 'user', session_id: sessionId, uuid: userId, parent_tool_use_id: null, message: { role: 'user', content } })
          await terminal
          interactions.close()
          await rpc.end()
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const exit = await Promise.race([rpc.exited, failedNative, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'Claude did not exit after its final result')), 1500) })])
            if (exit.code !== 0) throw new StudioError('RUNTIME_UNAVAILABLE', 'Claude failed after its final result')
          } finally { clearTimeout(timer) }
          if (nativeFailure) throw nativeFailure
          await commands.drain()
          next = { sessionId }
        } catch (error) {
          if (cancelled) return { status: 'cancelled' }
          failed = true; queue.fail(error instanceof Error ? error : new Error('Claude run failed')); throw error
        } finally {
          try { interactions.close(!failed) } catch (error) { cleanupFailure ??= error }
          disposing = true; ctx.signal.removeEventListener('abort', abort)
          try { try { await rpc?.dispose() } finally { try { if (!ctx.signal.aborted) await gateway?.dispose() } finally { await prepared?.cleanup() } } }
          catch (error) { cleanupFailure ??= error }
          finally { if (cleanupFailure) disposed = true; queue.end(); current = undefined }
          if (cleanupFailure) throw cleanupFailure
        }
        // A native result is provisional until every owned resource has closed.
        // A failed cleanup must neither advance resume nor free a reusable lease.
        if (!next) throw new StudioError('RUNTIME_UNAVAILABLE', 'Claude completed without a checkpoint')
        resume = next
        return { status: 'completed', checkpoint: next as unknown as JsonObject }
      })()
      void result.catch(() => {})
      const handle: AgentRunHandle = { events: queue, result, async cancel() {
        try { await stop() } finally { await result.catch(() => {}) }
        if (cleanupFailure) throw cleanupFailure
      }, async respond(response) { return interactions.respond(response) } }
      current = handle
      return handle
    },
    async dispose() { disposed = true; runtime.signal.removeEventListener('abort', runtimeAbort); await current?.cancel('Runtime disposed') },
  }
}
