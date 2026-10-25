import { randomUUID } from 'node:crypto'
import { readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AgentEventQueue, ManagedJsonRpcTransport, acpCommandCatalog } from '@ekko-studio/agent-drivers'
import { StudioError, mergeAgentContextConfiguration, nativeAgentLaunch, readAgentImages, type AgentContextConfiguration, type AgentOutputEvent, type AgentRunHandle, type AgentRunResult, type AgentRuntime, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle, type ProcessHandle, type RuntimeCreateInput } from '@ekko-studio/plugin-sdk'
import { grokUsageRows } from './usage'
import { directories, prepareGrok } from './configuration'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
interface Checkpoint { nativeSessionId: string }
async function sessionPath(root: string, id: string) {
  const sessions = join(root, 'sessions'), actualRoot = await realpath(sessions)
  for (const entry of await readdir(sessions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const path = await realpath(join(sessions, entry.name, id)), difference = relative(actualRoot, path)
      if (difference && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)) return path
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new StudioError('INVALID_ARGUMENT', 'Grok checkpoint history is missing')
}
function verify(value: unknown): asserts value is Checkpoint {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String((value as Checkpoint).nativeSessionId))) throw new StudioError('INVALID_ARGUMENT', 'Invalid Grok checkpoint')
}
export function createGrokRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext): AgentRuntime {
  const config = input.config, cwd = String(config.cwd), scoped = input.mode === 'scoped'
  if (!isAbsolute(cwd) || !runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Grok requires an absolute workspace and host storage')
  const commands = acpCommandCatalog(runtime, { pluginId: 'studio.agent-grok', agentTypeId: 'grok', name: 'Grok', staticIds: { compact: 'studio.agent-grok/compact' } })
  let checkpoint = input.resume as unknown as Checkpoint | undefined, current: AgentRunHandle | undefined, disposed = false, unavailable = false, pendingCleanup: (() => Promise<void>) | undefined
  if (checkpoint) verify(checkpoint)
  return { async run(input, ctx) {
    if (disposed || unavailable || runtime.signal.aborted || current) throw new StudioError('RUNTIME_UNAVAILABLE', 'Grok runtime is unavailable or busy')
    const queue = new AgentEventQueue<AgentOutputEvent>(), id = checkpoint?.nativeSessionId || randomUUID()
    let sequence = 0, cancelled = ctx.signal.aborted, process: ProcessHandle | undefined, transport: ManagedJsonRpcTransport<JsonObject> | undefined, gateway: ModelGatewayHandle | undefined, promptPath: string | undefined, failure: unknown, terminal: JsonObject | undefined, closed = false, cleanupFailure: unknown, candidate: Checkpoint | undefined
    const usage = new Map<string, any>(), emit = (event: Output) => queue.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
    let exitResolve!: (value: { code: number | null }) => void, exitReject!: (value: unknown) => void
    const exited = new Promise<{ code: number | null }>((resolve, reject) => { exitResolve = resolve; exitReject = reject }); void exited.catch(() => {})
    const cleanup = async (operation: () => Promise<void>) => {
      try { await operation() } catch (error) { unavailable = true; cleanupFailure ??= error; throw error }
    }
    const cleanupAll = async () => {
      const errors: unknown[] = []
      const attempt = async (operation: () => Promise<void>) => { try { await cleanup(operation) } catch (error) { errors.push(error) } }
      if (transport) await attempt(async () => { await transport!.close(); transport = undefined })
      // A transport failure must not prevent a direct process cleanup attempt.
      if (process) await attempt(async () => { await process!.dispose(); process = undefined; transport = undefined })
      if (gateway && !ctx.signal.aborted) await attempt(async () => { await gateway!.dispose(); gateway = undefined })
      if (promptPath) await attempt(async () => { await rm(promptPath!, { force: true }); promptPath = undefined })
      pendingCleanup = errors.length ? cleanupAll : undefined
      if (errors.length) throw errors[0]
    }
    const stop = async () => { cancelled = true; if (process) await cleanup(() => process!.dispose()) }
    const abort = () => { void stop().catch(exitReject) }; ctx.signal.addEventListener('abort', abort, { once: true })
    const result = (async (): Promise<AgentRunResult> => {
      try {
        if (cancelled) return { status: 'cancelled' }
        if (checkpoint) await sessionPath(directories(config, runtime).root!, checkpoint.nativeSessionId)
        const images = await readAgentImages(input.content, ctx), model = input.model || config.model as string | undefined
        if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', 'Scoped Grok requires a Studio model')
        gateway = scoped ? await ctx.models.gateway({ model: model!, protocol: 'responses' }) : undefined
        if (images.size && gateway && gateway.images !== true) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected model does not support images')
        const context = mergeAgentContextConfiguration(config as AgentContextConfiguration, ctx.nativeContext || {})
        const prepared = await prepareGrok({ ...context, systemPrompt: [context.systemPrompt, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n') }, config, scoped ? 'scoped' : 'global', runtime, gateway)
        const text = input.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (/^\/compact(?:\s|$)/.test(text) && !checkpoint) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Grok compact requires an existing conversation')
        // Native resume retains its old rule snapshot. Deliver current editable rules as this turn's context.
        // Slash commands keep their exact native argument string. This does not rewrite native history.
        const promptText = checkpoint && prepared.instructions && !/^\/[\p{L}\p{N}_]/u.test(text)
          ? `<system-reminder>\nCurrent Studio-managed instructions for this turn:\n${prepared.instructions}\n</system-reminder>\n\n${text}` : text
        promptPath = join(prepared.root, `turn-${randomUUID()}.${images.size ? 'json' : 'md'}`)
        await writeFile(promptPath, images.size ? JSON.stringify([{ type: 'text', text: promptText }, ...[...images.values()].map(image => ({ type: 'image', data: image.data, mimeType: image.mediaType }))]) : promptText + '\n', { mode: 0o600 })
        if (cancelled) return { status: 'cancelled' }
        const launch = nativeAgentLaunch('grok', config, runtime)
        process = await runtime.processes.spawn({ command: launch.command, args: [...launch.args, ...prepared.args, checkpoint ? '--resume' : '--session-id', id, '--output-format', 'streaming-json', '--prompt-file', promptPath], cwd, env: prepared.env })
        const ownedProcess = process
        transport = new ManagedJsonRpcTransport({ write: bytes => ownedProcess.write(bytes), dispose: () => cleanup(() => ownedProcess.dispose()), end: () => ownedProcess.end(), async read() { const batch = await ownedProcess.read(); if (batch.exit && !batch.chunks.length) { closed = true; exitResolve(batch.exit) } return batch } }, value => {
          if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as JsonObject).type !== 'string') throw new Error('Invalid Grok event')
          return value as JsonObject
        }, { maxMessageBytes: 4 * 1024 * 1024 })
        transport.onerror = error => { failure = error; exitReject(error) }
        transport.onclose = () => { if (!closed) exitReject(new StudioError('RUNTIME_UNAVAILABLE', 'Grok stream closed before native exit')) }
        transport.onmessage = event => {
          if (cancelled) return
          if (event.type === 'available_commands' && Array.isArray(event.commands)) commands.update(event.commands.filter((name): name is string => typeof name === 'string').map(name => ({ name, description: `Native Grok /${name}` })))
          else if (event.type === 'text' && typeof event.data === 'string') emit({ type: 'message.delta', messageId: 'grok-answer', text: event.data })
          else if (event.type === 'thought' && typeof event.data === 'string') emit({ type: 'reasoning.delta', messageId: 'grok-reasoning', text: event.data })
          else if (event.type === 'tool_call') emit({ type: 'tool.started', callId: String(event.toolCallId), name: String(event.toolName || event.title || 'Grok Tool'), data: event.rawInput ?? null })
          else if (event.type === 'tool_call_update' && ['completed', 'failed'].includes(String(event.status))) emit({ type: event.status === 'failed' ? 'tool.failed' : 'tool.completed', callId: String(event.toolCallId), name: 'Grok Tool', data: event.rawOutput ?? event.content ?? null })
          else if (event.type === 'usage') usage.set(String(event.messageId || `call-${usage.size}`), event.usage || (event.data as JsonObject)?.usage)
          else if (event.type === 'end') { if (terminal) throw new Error('Duplicate Grok terminal event'); terminal = event }
          else if (event.type === 'error') { failure = new StudioError('RUNTIME_UNAVAILABLE', 'Native Grok run failed'); terminal = event }
          else if (String(event.type).startsWith('auto_compact_')) emit({ type: 'diagnostic', message: `Grok ${event.type}` })
        }
        await transport.start()
        const exit = await exited
        if (cancelled) return { status: 'cancelled' }
        if (!scoped) {
          const totals: any = terminal?.usage || (terminal?.data as JsonObject)?.usage
          const modelUsage = terminal?.modelUsage || (terminal?.data as JsonObject)?.modelUsage
          for (const { id: call, model: nativeModel, ...tokens } of grokUsageRows(totals, modelUsage, usage, model)) {
            emit({ type: 'usage.reported', modelCallId: `grok-${ctx.scope.runId}-${call}`, model: nativeModel, mode: 'final', revision: 1, ...tokens })
          }
        }
        if (failure) throw failure
        if (exit.code !== 0 || !terminal || terminal.sessionId !== id || terminal.stopReason !== 'end_turn') throw new StudioError('RUNTIME_UNAVAILABLE', 'Grok did not confirm a successful native result')
        await commands.drain()
        await sessionPath(prepared.root, id)
        await cleanupAll()
        candidate = { nativeSessionId: id }
      } catch (error) { if (cancelled) return { status: 'cancelled' }; queue.fail(error instanceof Error ? error : new Error('Grok run failed')); throw error }
      finally {
        ctx.signal.removeEventListener('abort', abort)
        try { await cleanupAll() }
        finally { queue.end(); current = undefined }
      }
      if (cancelled || ctx.signal.aborted) return { status: 'cancelled' }
      checkpoint = candidate!
      return { status: 'completed', checkpoint: { nativeSessionId: checkpoint.nativeSessionId } }
    })(); void result.catch(() => {})
    current = { events: queue, result, async cancel() { await stop(); await result.catch(() => {}); if (cleanupFailure) throw cleanupFailure } }
    return current
  }, async dispose() { disposed = true; try { await current?.cancel('Grok runtime disposed') } finally { await pendingCleanup?.() } } }
}
