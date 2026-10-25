import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentEventQueue, ManagedJsonRpcTransport } from '@ekko-studio/agent-drivers'
import { StudioError, mergeAgentContextConfiguration, nativeAgentLaunch, readAgentImages, type AgentContextConfiguration, type AgentOutputEvent,
  type AgentRunHandle, type AgentRunResult, type AgentRuntime, type AgentRuntimeContext, type ProcessExit, type ProcessHandle, type RuntimeCreateInput } from '@ekko-studio/plugin-sdk'
import { prepareCursor, validateArguments } from './configuration'
import { record, sessionId, text, tool, usage, type CursorRecord } from './events'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
export function createCursorRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext): AgentRuntime {
  if (input.mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Cursor uses a native Cursor account and supports global mode only')
  const config = input.config, saved = mergeAgentContextConfiguration(config as AgentContextConfiguration)
  let checkpoint: { nativeSessionId: string } | undefined
  if (input.resume !== undefined) {
    const value = input.resume as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('nativeSessionId' in value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Cursor checkpoint')
    checkpoint = { nativeSessionId: sessionId(value.nativeSessionId) }
  }
  let current: AgentRunHandle | undefined, unavailable = false
  return {
    async run(turn, ctx) {
      if (current || unavailable || runtime.signal.aborted) throw new StudioError('RUNTIME_UNAVAILABLE', 'Cursor runtime is unavailable or busy')
      const queue = new AgentEventQueue<AgentOutputEvent>(), started = new Set<string>(), completed = new Set<string>()
      let sequence = 0, cancelled = ctx.signal.aborted, process: ProcessHandle | undefined, transport: ManagedJsonRpcTransport<CursorRecord> | undefined
      let prepared: Awaited<ReturnType<typeof prepareCursor>> | undefined, terminal: CursorRecord | undefined, observedSession: string | undefined, model = turn.model || config.model as string | undefined, cleanupFailure: unknown
      let resolveExit!: (exit: ProcessExit) => void, rejectExit!: (error: unknown) => void, nativeExit: ProcessExit | undefined
      const exited = new Promise<ProcessExit>((resolve, reject) => { resolveExit = resolve; rejectExit = reject }); void exited.catch(() => {})
      const emit = (event: Output) => queue.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
      const acceptSession = (value: unknown) => {
        const id = sessionId(value)
        if ((checkpoint && checkpoint.nativeSessionId !== id) || (observedSession && observedSession !== id)) throw new StudioError('INVALID_ARGUMENT', 'Cursor resumed a different native session')
        observedSession = id
      }
      const onRecord = (event: CursorRecord) => {
        if (cancelled) return
        if (terminal) {
          if (event.type !== 'result' || JSON.stringify(event) !== JSON.stringify(terminal)) throw new StudioError('INVALID_ARGUMENT', 'Cursor emitted conflicting records after its terminal result')
          return
        }
        if (event.session_id) acceptSession(event.session_id)
        if (event.type === 'system' && event.subtype === 'init') { if (typeof event.model === 'string' && event.model) model = event.model; return }
        if (event.type === 'assistant' && Object.hasOwn(event, 'timestamp_ms') && !event.model_call_id) {
          const delta = text(event)
          if (delta) emit({ type: 'message.delta', messageId: 'cursor-answer', text: delta })
        } else if (event.type === 'tool_call') {
          const entry = tool(event)
          if (!entry) return
          if (started.size + completed.size >= 2048) throw new StudioError('RESOURCE_EXHAUSTED', 'Cursor tool event limit exceeded')
          if (event.subtype === 'started' && !started.has(entry.callId)) { started.add(entry.callId); emit({ type: 'tool.started', callId: entry.callId, name: entry.name, data: entry.data }) }
          else if (event.subtype === 'completed' && !completed.has(entry.callId)) { completed.add(entry.callId); emit({ type: entry.failed ? 'tool.failed' : 'tool.completed', callId: entry.callId, name: entry.name, data: entry.output }) }
        } else if (event.type === 'result') {
          acceptSession(event.session_id)
          terminal = event
          const counters = usage(event.usage)
          if (counters && model) emit({ type: 'usage.reported', modelCallId: `cursor-${ctx.scope.runId}`, model, mode: 'final', revision: 1, ...counters })
          if (typeof event.result === 'string' && event.is_error !== true && event.subtype === 'success') emit({ type: 'message.snapshot', messageId: 'cursor-answer', text: event.result })
        }
      }
      const stop = async () => {
        cancelled = true; rejectExit(new StudioError('CANCELLED', 'Cursor run cancelled'))
        try { await process?.dispose() } catch (error) { cleanupFailure = error; unavailable = true; throw error }
      }
      const abort = () => { void stop().catch(() => {}) }
      ctx.signal.addEventListener('abort', abort, { once: true })
      const result = (async (): Promise<AgentRunResult> => {
        let next: { nativeSessionId: string } | undefined
        try {
          if (cancelled) return { status: 'cancelled' }
          const prompt = turn.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          if (/^\/compact(?:\s|$)/.test(prompt)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native /compact is not supported for Cursor')
          const images = await readAgentImages(turn.content, ctx), configuration = mergeAgentContextConfiguration(saved, ctx.nativeContext || {})
          prepared = await prepareCursor({ ...config, ...(model ? { model } : {}) }, runtime, configuration)
          const imageArgs: string[] = []
          let imageIndex = 0
          for (const image of images.values()) {
            const path = join(prepared.path, `image-${++imageIndex}.${image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType === 'image/webp' ? 'webp' : image.mediaType === 'image/gif' ? 'gif' : 'png'}`)
            await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 }); imageArgs.push('--image', path)
          }
          const launch = nativeAgentLaunch('agent', config, runtime)
          validateArguments(launch.args)
          if (cancelled) return { status: 'cancelled' }
          process = await runtime.processes.spawn({ command: launch.command, cwd: String(config.cwd), env: prepared.env,
            args: [...launch.args, '-p', '--force', '--output-format', 'stream-json', '--stream-partial-output', ...prepared.args,
              ...(checkpoint ? ['--resume', checkpoint.nativeSessionId] : []), ...imageArgs] })
          const port = { read: async () => { const batch = await process!.read(); if (batch.exit && !batch.chunks.length) nativeExit = batch.exit; return batch },
            write: (data: Uint8Array) => process!.write(data), end: () => process!.end(), dispose: () => process!.dispose() }
          transport = new ManagedJsonRpcTransport(port, record, { maxMessageBytes: 4 * 1024 * 1024 })
          transport.onmessage = onRecord
          transport.onerror = rejectExit
          transport.onclose = () => { if (nativeExit) resolveExit(nativeExit); else rejectExit(new StudioError('RUNTIME_UNAVAILABLE', 'Cursor protocol closed before confirmed exit')) }
          await transport.start()
          if (cancelled) return { status: 'cancelled' }
          const instructions = [configuration.systemPrompt, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n')
          // Print mode has no system-prompt flag; native files remain loaded by Cursor.
          const content = [instructions, prompt || (images.size ? 'Inspect the attached images.' : '')].filter(Boolean).join('\n\n')
          const bytes = Buffer.from(content)
          for (let offset = 0; offset < bytes.length; offset += 65536) { if (cancelled) break; await process.write(bytes.subarray(offset, offset + 65536)) }
          await process.end()
          const exit = await exited
          if (cancelled) return { status: 'cancelled' }
          if (exit.code !== 0 || !terminal || terminal.is_error === true || terminal.subtype !== 'success') throw new StudioError('RUNTIME_UNAVAILABLE', 'Cursor exited without a successful native result')
          next = { nativeSessionId: sessionId(terminal.session_id) }
        } catch (error) {
          if (cancelled) return { status: 'cancelled' }
          queue.fail(error instanceof Error ? error : new Error('Cursor run failed')); throw error
        } finally {
          ctx.signal.removeEventListener('abort', abort)
          try { try { await transport?.close(); if (!transport) await process?.dispose() } finally { await prepared?.dispose() } }
          catch (error) { cleanupFailure = error; unavailable = true; throw error }
          finally { queue.end(); current = undefined }
        }
        checkpoint = next
        return { status: 'completed', checkpoint: next }
      })()
      void result.catch(() => {})
      current = { events: queue, result, async cancel() { await stop(); await result.catch(() => {}); if (cleanupFailure) throw cleanupFailure } }
      return current
    },
    async dispose() { unavailable = true; await current?.cancel('Cursor runtime disposed') },
  }
}
